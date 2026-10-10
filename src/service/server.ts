import { randomUUID, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { TurnOutcome } from "../agent.js";
import { CallBroker } from "./calls.js";
import { TaskStore } from "./store.js";
import {
  HostError,
  idSchema,
  startRunSchema,
  type RunRecord,
  type StartRun,
  type SessionRecord,
  type RuntimeDescription,
} from "./protocol.js";
import {
  listWorkspaceFiles,
  readWorkspaceFile,
  writeWorkspaceFile,
} from "./files.js";
import type { ServiceRuntime } from "./runtime.js";

export interface HostServerOptions {
  runtimes: ServiceRuntime[];
  stateDirectory: string;
  token: string;
  host?: string;
  port?: number;
  allowedOrigins?: string[];
  eventLimit?: number;
  interactionTimeoutMs?: number;
  /** Trusted local file access is opt-in, separate from native Agent permissions. */
  workspaceFiles?: boolean;
}
interface ActiveRun {
  record: RunRecord;
  runtime: ServiceRuntime;
  controller: AbortController;
  broker: CallBroker;
  done: Promise<void>;
}

export async function startAgentHostServer(options: HostServerOptions) {
  if (!options.token || options.token.length < 16)
    throw new Error("host_token_must_be_at_least_16_characters");
  const runtimes = new Map<string, ServiceRuntime>();
  for (const runtime of options.runtimes) {
    idSchema.parse(runtime.id);
    if (!runtime.configurationKey || runtimes.has(runtime.id))
      throw new Error("invalid_runtime_configuration");
    runtimes.set(runtime.id, runtime);
  }
  const store = new TaskStore(
    join(resolve(options.stateDirectory), "tasks.sqlite"),
    options.eventLimit,
  );
  const active = new Map<string, ActiveRun>();
  let closing = false;
  let persistenceFailed = false;
  let closed: Promise<void> | undefined;
  const getRuntime = (id: string) => {
    const runtime = runtimes.get(id);
    if (!runtime) throw new HostError(404, "runtime_not_found");
    return runtime;
  };
  const getRun = (id: string) => {
    const run = store.run(id);
    if (!run) throw new HostError(404, "run_not_found");
    return run;
  };
  const describe = async (
    runtime: ServiceRuntime,
  ): Promise<RuntimeDescription> => ({
    id: runtime.id,
    kernel: runtime.kernel,
    cwd: runtime.cwd,
    model: runtime.model,
    controls: {
      steer: Boolean(runtime.steer),
      compact: Boolean(runtime.supportsCompaction),
    },
    ...((await runtime.inspect?.()) ?? { available: true }),
  });

  async function execute(task: ActiveRun, input: StartRun) {
    const { record, runtime, controller, broker } = task;
    let outcome: TurnOutcome = {
      status: "failed",
      error: "native_terminal_missing",
      outcomeUnknown: true,
    };
    const timeout = setTimeout(
      () => controller.abort(new Error("run_deadline_exceeded")),
      input.timeoutMs,
    );
    timeout.unref();
    try {
      for await (const event of runtime.run({
        sessionId: input.sessionId,
        runId: record.id,
        input: input.input,
        mode: input.mode,
        instructions: input.instructions,
        context:
          typeof input.context === "string"
            ? input.context
            : input.context
              ? JSON.stringify(input.context)
              : undefined,
        tools: broker.tools(input.tools),
        signal: controller.signal,
        onRequest: (request, context) => broker.interaction(request, context),
      })) {
        if (event.runId !== record.id)
          throw new Error("runtime_event_run_mismatch");
        if (event.type === "turn.finished") {
          outcome = event.outcome;
          continue;
        }
        if (event.type === "model.response") {
          record.answer = event.text;
          record.outputAvailable = true;
        }
        store.append(record, event);
      }
    } catch (error) {
      outcome = {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        outcomeUnknown: true,
      };
    } finally {
      clearTimeout(timeout);
      broker.close();
      try {
        store.finish(record, outcome);
      } finally {
        active.delete(record.id);
      }
    }
  }

  async function start(input: StartRun): Promise<RunRecord> {
    const runtime = getRuntime(input.runtimeId);
    const inspected = await describe(runtime);
    if (!inspected.available)
      throw new HostError(409, inspected.reason ?? "runtime_unavailable");
    if (closing) throw new HostError(503, "host_closing");
    if (persistenceFailed) throw new HostError(503, "host_storage_failed");
    if (input.mode === "compact" && !runtime.supportsCompaction)
      throw new HostError(409, "compaction_unsupported");
    if (
      [...active.values()].some(
        (item) => item.record.sessionId === input.sessionId,
      )
    )
      throw new HostError(409, "session_busy");
    if (
      [...active.values()].filter((item) => item.runtime === runtime).length >=
      (runtime.maxConcurrentRuns ?? 16)
    )
      throw new HostError(409, "runtime_busy");
    const previous = store.session(input.sessionId);
    const definition = {
      runtimeId: input.runtimeId,
      instructions: input.instructions,
      tools: input.tools,
      configurationKey: runtime.configurationKey,
    };
    if (previous) {
      const { id: _id, createdAt: _createdAt, ...existing } = previous;
      if (!isDeepStrictEqual(existing, definition))
        throw new HostError(409, "session_configuration_conflict");
    } else {
      const session: SessionRecord = {
        ...definition,
        id: input.sessionId,
        createdAt: new Date().toISOString(),
      };
      store.saveSession(session);
    }
    const record: RunRecord = {
      id: randomUUID(),
      sessionId: input.sessionId,
      runtimeId: input.runtimeId,
      createdAt: new Date().toISOString(),
      status: "running",
      answer: "",
      outputAvailable: false,
      sequence: 0,
    };
    store.saveRun(record);
    const controller = new AbortController();
    const broker = new CallBroker(
      store,
      record.id,
      controller.signal,
      options.interactionTimeoutMs ?? 120_000,
    );
    const task: ActiveRun = {
      record,
      runtime,
      controller,
      broker,
      done: Promise.resolve(),
    };
    active.set(record.id, task);
    task.done = Promise.resolve().then(() => execute(task, input));
    // A storage failure must remain visible, never an unhandled background rejection.
    void task.done.catch((error: unknown) => {
      persistenceFailed = true;
      console.error("Agent Host task persistence failed:", error);
      controller.abort(error);
      for (const running of active.values()) running.controller.abort(error);
    });
    return { ...record };
  }

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      const status =
        error instanceof HostError
          ? error.status
          : error instanceof z.ZodError || error instanceof SyntaxError
            ? 400
            : (error as NodeJS.ErrnoException)?.code === "ENOENT"
              ? 404
              : 500;
      reply(response, status, {
        error:
          error instanceof z.ZodError
            ? "invalid_request"
            : error instanceof Error
              ? error.message
              : "host_error",
      });
    });
  });
  async function handle(request: IncomingMessage, response: ServerResponse) {
    const origin = request.headers.origin;
    if (origin) {
      if (!options.allowedOrigins?.includes(origin))
        throw new HostError(403, "origin_not_allowed");
      response.setHeader("access-control-allow-origin", origin);
      response.setHeader("vary", "Origin");
      if (request.method === "OPTIONS") {
        response.setHeader(
          "access-control-allow-headers",
          "authorization, content-type",
        );
        response.setHeader(
          "access-control-allow-methods",
          "GET, POST, OPTIONS",
        );
        response.writeHead(204).end();
        return;
      }
    }
    const supplied = Buffer.from(request.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${options.token}`);
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      throw new HostError(401, "unauthorized");
    if (closing) throw new HostError(503, "host_closing");
    if (persistenceFailed) throw new HostError(503, "host_storage_failed");
    const url = new URL(request.url ?? "/", "http://agent-host.local");
    const path = url.pathname
      .split("/")
      .filter(Boolean)
      .map(decodeURIComponent);
    const method = request.method;
    if (path[0] !== "v1") throw new HostError(404, "route_not_found");
    if (method === "GET" && path.length === 2 && path[1] === "health")
      return reply(response, 200, { ok: true, protocolVersion: 1 });
    if (method === "GET" && path.length === 2 && path[1] === "runtimes")
      return reply(response, 200, {
        runtimes: await Promise.all([...runtimes.values()].map(describe)),
      });
    if (method === "POST" && path.join("/") === "v1/runtimes/inspect") {
      const input = z
        .object({ runtimeId: idSchema })
        .strict()
        .parse(await body(request));
      return reply(response, 200, await describe(getRuntime(input.runtimeId)));
    }
    if (method === "GET" && path.length === 2 && path[1] === "sessions")
      return reply(response, 200, { sessions: store.sessions() });
    if (path[1] === "runs" && path.length === 2) {
      if (method === "POST")
        return reply(
          response,
          202,
          await start(startRunSchema.parse(await body(request))),
        );
      if (method === "GET")
        return reply(response, 200, {
          runs: store.runs(url.searchParams.get("sessionId") ?? undefined),
        });
    }
    if (path[1] === "runs" && path[2]) {
      const run = getRun(idSchema.parse(path[2]));
      if (method === "GET" && path.length === 3)
        return reply(response, 200, run);
      if (path.length === 4 && path[3] === "events" && method === "GET") {
        const after = z.coerce
          .number()
          .int()
          .min(0)
          .max(run.sequence)
          .parse(url.searchParams.get("after") ?? 0);
        const limit = z.coerce
          .number()
          .int()
          .min(1)
          .max(1_000)
          .parse(url.searchParams.get("limit") ?? 200);
        return reply(response, 200, store.events(run, after, limit));
      }
      if (path.length === 4 && path[3] === "cancel" && method === "POST") {
        const task = active.get(run.id);
        task?.controller.abort(new Error("run_cancelled"));
        return reply(response, 200, { cancellationRequested: Boolean(task) });
      }
      if (path.length === 4 && path[3] === "steer" && method === "POST") {
        const { input } = z
          .object({ input: z.string().min(1).max(100_000) })
          .strict()
          .parse(await body(request));
        const task = active.get(run.id);
        if (!task) throw new HostError(409, "run_not_active");
        if (!task.runtime.steer)
          throw new HostError(409, "steering_unsupported");
        await task.runtime.steer(run.sessionId, input);
        return reply(response, 200, { ok: true });
      }
      if (path.length === 4 && path[3] === "calls" && method === "GET")
        return reply(response, 200, { calls: store.calls(run.id) });
      if (
        path.length === 6 &&
        path[3] === "calls" &&
        path[5] === "result" &&
        method === "POST"
      ) {
        const { result } = z
          .object({ result: z.json() })
          .strict()
          .parse(await body(request));
        const broker =
          active.get(run.id)?.broker ??
          new CallBroker(store, run.id, AbortSignal.abort(), 0);
        broker.resolve(idSchema.parse(path[4]), result);
        return reply(response, 200, { ok: true });
      }
    }
    if (
      options.workspaceFiles &&
      path[1] === "sessions" &&
      path[2] &&
      path[3] === "files" &&
      path.length === 4
    ) {
      const session = store.session(idSchema.parse(path[2]));
      if (!session) throw new HostError(404, "session_not_found");
      const root = getRuntime(session.runtimeId).cwd;
      if (method === "GET") {
        const file = url.searchParams.get("path") ?? "";
        return reply(
          response,
          200,
          url.searchParams.get("list") === "true"
            ? { entries: listWorkspaceFiles(root, file) }
            : readWorkspaceFile(root, file),
        );
      }
      if (method === "POST") {
        const input = z
          .object({
            path: z.string().min(1),
            content: z.string().max(1_000_000),
            expectedRevision: z.string().nullable().optional(),
          })
          .strict()
          .parse(await body(request));
        return reply(
          response,
          200,
          writeWorkspaceFile(
            root,
            input.path,
            input.content,
            input.expectedRevision,
          ),
        );
      }
    }
    throw new HostError(404, "route_not_found");
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  } catch (error) {
    store.close();
    await Promise.allSettled(
      options.runtimes.map((runtime) => runtime.close()),
    );
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("host_address_unavailable");
  const addressHost = address.address.includes(":")
    ? `[${address.address}]`
    : address.address;
  return {
    url: `http://${addressHost}:${address.port}`,
    close(): Promise<void> {
      if (closed) return closed;
      closing = true;
      closed = (async () => {
        const stopped = new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        server.closeIdleConnections();
        for (const task of active.values())
          task.controller.abort(new Error("host_shutdown"));
        const closingRuntimes = Promise.allSettled(
          options.runtimes.map((runtime) => runtime.close()),
        );
        await Promise.allSettled([...active.values()].map((task) => task.done));
        const results = await closingRuntimes;
        store.close();
        await stopped;
        const failed = results.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      })();
      return closed;
    },
  };
}

function reply(response: ServerResponse, status: number, value: unknown) {
  if (response.destroyed) return;
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
}
async function body(request: IncomingMessage): Promise<unknown> {
  if (
    !request.headers["content-type"]
      ?.toLowerCase()
      .startsWith("application/json")
  )
    throw new HostError(415, "json_required");
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    length += Buffer.byteLength(chunk);
    if (length > 2_000_000) throw new HostError(413, "request_too_large");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
