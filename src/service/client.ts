// Observation and callback flow adapted from OpenGrove PR #126 (Apache-2.0).
// Browser-safe: no Node imports, credentials discovery, or service startup.
import type { ProductToolResult } from "../agent.js";
import type { JsonValue } from "../types.js";
import type {
  StartRunInput,
  RunRecord,
  SessionRecord,
  PendingCall,
  EventPage,
  RuntimeDescription,
} from "./protocol.js";
export type {
  StartRunInput,
  RunRecord,
  SessionRecord,
  PendingCall,
  EventPage,
  RuntimeDescription,
} from "./protocol.js";

export interface RemoteCallContext {
  runId: string;
  callId: string;
  nativeCallId?: string;
  sessionId: string;
  threadId: string;
  turnId: string;
  signal: AbortSignal;
  deadlineAt: string;
}
export type RemoteTool = NonNullable<StartRunInput["tools"]>[number] & {
  execute(
    input: JsonValue,
    context: RemoteCallContext,
  ): Promise<ProductToolResult>;
};
export interface TaskObserver {
  signal?: AbortSignal;
  pollMs?: number;
  onEvent?(item: EventPage["events"][number]): void | Promise<void>;
  onHistoryGap?(page: EventPage): void | Promise<void>;
  /** Reply in the native request's format; the client does not flatten permission semantics. */
  onRequest?(
    request: { method: string; params: JsonValue },
    context: RemoteCallContext,
  ): Promise<JsonValue>;
}
export class AgentHostHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export interface HostClientOptions {
  baseUrl: string;
  token?: string;
  headers?: HeadersInit;
  fetch?: typeof globalThis.fetch;
}
export class AgentHostClient {
  private readonly headers: Headers;
  private readonly baseUrl: string;
  constructor(private readonly options: HostClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.headers = new Headers(options.headers);
    if (options.token)
      this.headers.set("authorization", `Bearer ${options.token}`);
    this.headers.set("content-type", "application/json");
  }
  async connect(signal?: AbortSignal) {
    const health = await this.request("/health", undefined, signal);
    if (health.protocolVersion !== 1)
      throw new Error("unsupported_host_protocol");
    return this;
  }
  async runtimes(): Promise<RuntimeDescription[]> {
    const value = await this.request("/runtimes");
    if (!Array.isArray(value.runtimes))
      throw new Error("invalid_host_runtimes");
    return value.runtimes as RuntimeDescription[];
  }
  async inspect(runtimeId: string): Promise<RuntimeDescription> {
    const value = await this.request("/runtimes/inspect", { runtimeId });
    if (typeof value.available !== "boolean" || typeof value.id !== "string")
      throw new Error("invalid_host_runtime");
    return value as unknown as RuntimeDescription;
  }
  async sessions(): Promise<SessionRecord[]> {
    const value = await this.request("/sessions");
    if (!Array.isArray(value.sessions))
      throw new Error("invalid_host_sessions");
    return value.sessions as SessionRecord[];
  }
  async runs(sessionId?: string): Promise<RunRecord[]> {
    const value = await this.request(
      `/runs${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`,
    );
    if (!Array.isArray(value.runs)) throw new Error("invalid_host_runs");
    return value.runs.map(parseRun);
  }
  async start(
    input: StartRunInput,
    tools: RemoteTool[] = [],
  ): Promise<RemoteTask> {
    const run = parseRun(await this.request("/runs", input));
    return new RemoteTask(this, run.id, tools);
  }
  session(
    config: Omit<StartRunInput, "input" | "context" | "tools" | "mode"> & {
      tools?: RemoteTool[];
    },
  ) {
    const { tools = [], ...settings } = config;
    const definitions = tools.map(
      ({ execute: _execute, ...definition }) => definition,
    );
    return {
      run: (input: string, context?: StartRunInput["context"]) =>
        this.start({ ...settings, tools: definitions, input, context }, tools),
      compact: (reason = "") =>
        this.start(
          { ...settings, tools: definitions, input: reason, mode: "compact" },
          tools,
        ),
    };
  }
  task(runId: string, tools: RemoteTool[] = []) {
    return new RemoteTask(this, runId, tools);
  }
  async result(runId: string, signal?: AbortSignal) {
    return parseRun(
      await this.request(
        `/runs/${encodeURIComponent(runId)}`,
        undefined,
        signal,
      ),
    );
  }
  async events(
    runId: string,
    after = 0,
    signal?: AbortSignal,
  ): Promise<EventPage> {
    const page = await this.request(
      `/runs/${encodeURIComponent(runId)}/events?after=${after}`,
      undefined,
      signal,
    );
    if (
      !Array.isArray(page.events) ||
      typeof page.cursor !== "number" ||
      typeof page.hasMore !== "boolean" ||
      typeof page.historyTruncated !== "boolean"
    )
      throw new Error("invalid_host_events");
    return page as unknown as EventPage;
  }
  async calls(runId: string, signal?: AbortSignal): Promise<PendingCall[]> {
    const value = await this.request(
      `/runs/${encodeURIComponent(runId)}/calls`,
      undefined,
      signal,
    );
    if (!Array.isArray(value.calls)) throw new Error("invalid_host_calls");
    return value.calls.map((value: unknown) => {
      const call = object(value);
      for (const key of [
        "id",
        "runId",
        "name",
        "deadlineAt",
        "sessionId",
        "threadId",
        "turnId",
      ])
        if (typeof call[key] !== "string") throw new Error("invalid_host_call");
      if (
        !["tool", "interaction"].includes(String(call.kind)) ||
        !["pending", "completed", "cancelled", "timed_out"].includes(
          String(call.status),
        )
      )
        throw new Error("invalid_host_call");
      return call as unknown as PendingCall;
    });
  }
  resolveCall(
    runId: string,
    callId: string,
    result: JsonValue,
    signal?: AbortSignal,
  ) {
    return this.request(
      `/runs/${encodeURIComponent(runId)}/calls/${encodeURIComponent(callId)}/result`,
      { result },
      signal,
    );
  }
  cancel(runId: string) {
    return this.request(`/runs/${encodeURIComponent(runId)}/cancel`, {});
  }
  steer(runId: string, input: string) {
    return this.request(`/runs/${encodeURIComponent(runId)}/steer`, { input });
  }
  async readFile(
    sessionId: string,
    path: string,
  ): Promise<{ path: string; content: string; revision: string }> {
    return this.fileResponse(
      await this.request(
        `/sessions/${encodeURIComponent(sessionId)}/files?path=${encodeURIComponent(path)}`,
      ),
    );
  }
  async writeFile(
    sessionId: string,
    path: string,
    content: string,
    expectedRevision?: string | null,
  ) {
    return this.fileResponse(
      await this.request(`/sessions/${encodeURIComponent(sessionId)}/files`, {
        path,
        content,
        expectedRevision,
      }),
    );
  }
  async listFiles(
    sessionId: string,
    path = "",
  ): Promise<Array<{ path: string; directory: boolean }>> {
    const value = await this.request(
      `/sessions/${encodeURIComponent(sessionId)}/files?list=true&path=${encodeURIComponent(path)}`,
    );
    if (!Array.isArray(value.entries)) throw new Error("invalid_host_files");
    return value.entries as Array<{ path: string; directory: boolean }>;
  }
  private fileResponse(value: Record<string, unknown>) {
    if (
      typeof value.path !== "string" ||
      typeof value.content !== "string" ||
      typeof value.revision !== "string"
    )
      throw new Error("invalid_host_file");
    return {
      path: value.path,
      content: value.content,
      revision: value.revision,
    };
  }
  private async request(
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const response = await (this.options.fetch ?? globalThis.fetch)(
      `${this.baseUrl}/v1${path}`,
      {
        method: body === undefined ? "GET" : "POST",
        headers: this.headers,
        signal,
        redirect: "error",
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    const value = object(await response.json());
    if (!response.ok)
      throw new AgentHostHttpError(
        response.status,
        typeof value.error === "string"
          ? value.error
          : `http_${response.status}`,
      );
    return value;
  }
}

/** Disconnecting an observer does not cancel the Host's task. */
export class RemoteTask {
  private observing = false;
  private cursor = 0;
  private readonly executions = new Map<string, Promise<JsonValue>>();
  constructor(
    readonly client: AgentHostClient,
    readonly runId: string,
    private readonly tools: RemoteTool[],
  ) {}
  result() {
    return this.client.result(this.runId);
  }
  cancel() {
    return this.client.cancel(this.runId);
  }
  steer(input: string) {
    return this.client.steer(this.runId, input);
  }
  async wait(observer: TaskObserver = {}): Promise<RunRecord> {
    if (this.observing) throw new Error("task_already_observed");
    this.observing = true;
    const controller = new AbortController();
    const signal = controller.signal;
    const abort = () => controller.abort(observer.signal?.reason);
    observer.signal?.addEventListener("abort", abort, { once: true });
    if (observer.signal?.aborted) abort();
    const jobs = new Map<string, Promise<void>>();
    const callControllers = new Map<string, AbortController>();
    let failure: unknown;
    const handle = async (call: PendingCall) => {
      let execution = this.executions.get(call.id);
      if (!execution) {
        const tool = this.tools.find(
          (tool) =>
            tool.name === call.name && tool.namespace === call.namespace,
        );
        if (call.kind === "tool" && !tool) return;
        if (call.kind === "interaction" && !observer.onRequest) return;
        const control = new AbortController();
        callControllers.set(call.id, control);
        const stop = () => control.abort(signal.reason);
        signal.addEventListener("abort", stop, { once: true });
        const remaining = Date.parse(call.deadlineAt) - Date.now();
        if (!Number.isFinite(remaining) || remaining <= 0 || signal.aborted)
          control.abort(new Error("call_expired_or_cancelled"));
        const timer = setTimeout(
          () => control.abort(new Error("call_deadline_exceeded")),
          Math.max(0, remaining),
        );
        const context: RemoteCallContext = {
          ...call,
          callId: call.id,
          signal: control.signal,
        };
        execution = Promise.resolve()
          .then(async () => {
            control.signal.throwIfAborted();
            if (call.kind === "interaction")
              return observer.onRequest!(
                { method: call.name, params: call.input },
                context,
              );
            try {
              return (await tool!.execute(
                call.input,
                context,
              )) as unknown as JsonValue;
            } catch (error) {
              return {
                success: false,
                contentItems: [
                  {
                    type: "inputText",
                    text:
                      error instanceof Error ? error.message : String(error),
                  },
                ],
              };
            }
          })
          .finally(() => {
            clearTimeout(timer);
            signal.removeEventListener("abort", stop);
            callControllers.delete(call.id);
          });
        this.executions.set(call.id, execution);
      }
      const result = await execution;
      if (signal.aborted) return;
      try {
        await this.client.resolveCall(this.runId, call.id, result, signal);
      } catch (error) {
        if (
          !(error instanceof AgentHostHttpError) ||
          error.status !== 409 ||
          error.message === "call_result_conflict"
        )
          throw error;
      }
    };
    try {
      for (;;) {
        signal.throwIfAborted();
        if (failure) throw failure;
        const run = await this.client.result(this.runId, signal);
        const page = await this.client.events(this.runId, this.cursor, signal);
        if (page.historyTruncated) {
          if (!observer.onHistoryGap)
            throw new Error("task_event_history_incomplete");
          await observer.onHistoryGap(page);
        }
        for (const event of page.events) await observer.onEvent?.(event);
        this.cursor = page.cursor;
        if (run.status !== "running" && !page.hasMore) return run;
        if (this.tools.length || observer.onRequest)
          for (const call of await this.client.calls(this.runId, signal)) {
            if (call.status !== "pending") {
              callControllers
                .get(call.id)
                ?.abort(new Error(`call_${call.status}`));
              continue;
            }
            if (jobs.has(call.id)) continue;
            const job = handle(call)
              .catch((error: unknown) => {
                failure = error;
              })
              .finally(() => jobs.delete(call.id));
            jobs.set(call.id, job);
          }
        if (!page.hasMore)
          await delay(Math.max(20, observer.pollMs ?? 250), signal);
      }
    } finally {
      controller.abort();
      observer.signal?.removeEventListener("abort", abort);
      this.observing = false;
    }
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid_host_response");
  return value as Record<string, unknown>;
}
function parseRun(value: unknown): RunRecord {
  const run = object(value);
  if (
    typeof run.id !== "string" ||
    typeof run.sessionId !== "string" ||
    typeof run.runtimeId !== "string" ||
    typeof run.answer !== "string" ||
    typeof run.sequence !== "number" ||
    !["running", "completed", "cancelled", "failed"].includes(
      String(run.status),
    )
  )
    throw new Error("invalid_host_run");
  return run as unknown as RunRecord;
}
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    signal.addEventListener("abort", stop, { once: true });
  });
}
