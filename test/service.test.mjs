import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createNativeRuntime,
  startAgentHostServer,
} from "../dist/service/index.js";
import { AgentHostClient } from "../dist/service/client.js";
import { model, fixture as piStream } from "./fixtures/pi-stream.mjs";
import { startOpenClawFixture } from "./fixtures/openclaw-gateway.mjs";
import { createClaudeQueryFixture } from "./fixtures/claude-query.mjs";

const token = "service-test-owner-token";
const tool = {
  name: "edit_document",
  description: "Edit",
  inputSchema: { type: "object" },
};
async function fixture(t, options = {}) {
  const { configure, ...serverOptions } = options;
  const root = await mkdtemp(join(tmpdir(), "agent-host-http-"));
  let host;
  const launch = async () =>
    (host = await startAgentHostServer({
      runtimes: configure
        ? await configure(root)
        : [
            createNativeRuntime(
              {
                id: "codex",
                kernel: "codex",
                cwd: root,
                options: {
                  command: resolve("test/fixtures/codex-server.mjs"),
                  args: [],
                  cancellationGraceMs: 100,
                  requestTimeoutMs: 1_000,
                },
              },
              root,
            ),
          ],
      stateDirectory: root,
      token,
      ...serverOptions,
    }));
  await launch();
  t.after(async () => {
    await host.close();
    await rm(root, { recursive: true, force: true });
  });
  const api = async (path, body, expected = 200, extra = {}) => {
    const response = await fetch(`${host.url}/v1${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    assert.equal(response.status, expected, JSON.stringify(result));
    return result;
  };
  return {
    root,
    api,
    host,
    client: () => new AgentHostClient({ baseUrl: host.url, token }),
    restart: async () => {
      await host.close();
      await launch();
    },
  };
}
async function until(read, predicate) {
  const end = Date.now() + 5_000;
  for (;;) {
    const value = await read();
    if (predicate(value)) return value;
    assert.ok(Date.now() < end, "condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
test("HTTP product tools remain scoped, duplicate results are idempotent, results survive restart", async (t) => {
  const { api, restart } = await fixture(t, { eventLimit: 3 });
  const input = {
    sessionId: "document",
    runtimeId: "codex",
    instructions: "Use product tools",
    tools: [tool],
    input: "duplicate-tool",
  };
  const run = await api("/runs", input, 202);
  await api("/runs", input, 409);
  const { calls } = await until(
    () => api(`/runs/${run.id}/calls`),
    (value) => value.calls.length,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "edit_document");
  const result = {
    success: true,
    contentItems: [{ type: "inputText", text: "Saved" }],
  };
  await api(`/runs/${run.id}/calls/${calls[0].id}/result`, { result });
  const done = await until(
    () => api(`/runs/${run.id}`),
    (value) => value.status !== "running",
  );
  assert.equal(done.status, "completed");
  assert.ok(done.answer);
  await api(`/runs/${run.id}/calls/${calls[0].id}/result`, { result });
  await api(
    `/runs/${run.id}/calls/${calls[0].id}/result`,
    { result: { success: false, contentItems: [] } },
    409,
  );
  assert.equal((await api(`/runs/${run.id}/events`)).historyTruncated, true);
  await restart();
  assert.deepEqual(await api(`/runs/${run.id}`), done);
  await api(`/runs/${run.id}/calls/${calls[0].id}/result`, { result });
  const next = await api("/runs", { ...input, input: "hello" }, 202);
  await until(
    () => api(`/runs/${next.id}`),
    (value) => value.status !== "running",
  );
  await api("/runs", { ...input, instructions: "Changed" }, 409);
});
test("HTTP cancellation closes pending calls and does not accept late tool results", async (t) => {
  const { api } = await fixture(t);
  const run = await api(
    "/runs",
    { sessionId: "cancel", runtimeId: "codex", input: "tool", tools: [tool] },
    202,
  );
  const { calls } = await until(
    () => api(`/runs/${run.id}/calls`),
    (value) => value.calls.length,
  );
  await api(`/runs/${run.id}/cancel`, {});
  const done = await until(
    () => api(`/runs/${run.id}`),
    (value) => value.status !== "running",
  );
  assert.equal(done.status, "cancelled");
  await api(
    `/runs/${run.id}/calls/${calls[0].id}/result`,
    { result: { success: true, contentItems: [] } },
    409,
  );
  assert.equal(
    (await api(`/runs/${run.id}/calls`)).calls[0].status,
    "cancelled",
  );
});

test("native approval and structured questions cross HTTP without losing native response shapes", async (t) => {
  const { client } = await fixture(t);
  const remote = await client().connect();
  const session = remote.session({
    sessionId: "interactions",
    runtimeId: "codex",
  });
  for (const input of ["approval", "question"]) {
    const task = await session.run(input);
    const result = await task.wait({
      pollMs: 20,
      signal: AbortSignal.timeout(5_000),
      onRequest: async (request, context) => {
        assert.ok(context.threadId);
        assert.ok(context.turnId);
        if (input === "approval") {
          assert.equal(request.method, "item/commandExecution/requestApproval");
          return { decision: "decline" };
        }
        assert.equal(request.method, "item/tool/requestUserInput");
        assert.equal(request.params.questions[0].id, "color");
        return { answers: { color: { answers: ["Blue"] } } };
      },
    });
    assert.equal(result.status, "completed");
    assert.match(result.answer, input === "approval" ? /decline/ : /Blue/);
  }
  const compact = await session.compact();
  assert.equal((await compact.wait({ pollMs: 20 })).status, "completed");
});

test("stopping observation keeps the run alive and re-observing the same task never repeats a pending handler", async (t) => {
  const { client } = await fixture(t);
  let finish,
    count = 0,
    started;
  const didStart = new Promise((resolve) => {
    started = resolve;
  });
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const task = await client()
    .session({
      sessionId: "observe",
      runtimeId: "codex",
      tools: [
        {
          ...tool,
          execute: async () => {
            count++;
            started();
            await pending;
            return { success: true, contentItems: [] };
          },
        },
      ],
    })
    .run("tool");
  const control = new AbortController();
  const first = task.wait({ signal: control.signal, pollMs: 20 });
  await didStart;
  control.abort(new Error("stop_observation"));
  await assert.rejects(first, /stop_observation/);
  assert.equal((await task.result()).status, "running");
  const second = task.wait({ signal: AbortSignal.timeout(5_000), pollMs: 20 });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(count, 1);
  finish();
  assert.equal((await second).status, "completed");
  assert.equal(count, 1);
});

test("expired product calls propagate deadlines and reject late success", async (t) => {
  const { client } = await fixture(t);
  let aborted = false;
  const task = await client()
    .session({
      sessionId: "deadline",
      runtimeId: "codex",
      tools: [
        {
          ...tool,
          timeoutMs: 100,
          execute: async (_input, { signal }) => {
            await new Promise((resolve) => {
              if (signal.aborted) resolve();
              else signal.addEventListener("abort", resolve, { once: true });
            });
            aborted = true;
            return { success: true, contentItems: [] };
          },
        },
      ],
    })
    .run("tool");
  await task.wait({ pollMs: 20, signal: AbortSignal.timeout(5_000) });
  assert.equal(aborted, true);
  const [call] = await task.client.calls(task.runId);
  assert.equal(call.status, "timed_out");
  await assert.rejects(
    task.client.resolveCall(task.runId, call.id, {
      success: true,
      contentItems: [],
    }),
    /call_not_pending/,
  );
});

test("HTTP authentication, origins, profile binding and file revision boundaries", async (t) => {
  const { api, host, client } = await fixture(t, { workspaceFiles: true });
  assert.equal((await fetch(`${host.url}/v1/health`)).status, 401);
  await api("/health", undefined, 403, { origin: "https://untrusted.example" });
  await api(
    "/runs",
    { sessionId: "s", runtimeId: "codex", input: "hello", command: "/bin/sh" },
    400,
  );
  const task = await client()
    .session({ sessionId: "files", runtimeId: "codex" })
    .run("hello");
  await task.wait({ pollMs: 20 });
  const written = await client().writeFile(
    "files",
    "notes/result.txt",
    "First",
    null,
  );
  assert.equal(
    (await client().readFile("files", "notes/result.txt")).content,
    "First",
  );
  await client().writeFile(
    "files",
    "notes/result.txt",
    "Second",
    written.revision,
  );
  await assert.rejects(
    client().writeFile("files", "notes/result.txt", "Stale", written.revision),
    /revision_conflict/,
  );
  await assert.rejects(
    client().readFile("files", "../outside"),
    /outside_root/,
  );
  assert.deepEqual(await client().listFiles("files", "notes"), [
    { path: "notes/result.txt", directory: false },
  ]);
  assert.equal((await client().inspect("codex")).available, true);
});

for (const kernel of [
  "codex",
  "claude",
  "pi",
  "opencode",
  "kimi",
  "hermes",
  "openclaw",
]) {
  test(`${kernel} HTTP consumer approves, rejects and resumes the native binding after Host restart (fixture)`, async (t) => {
    const gateway =
      kernel === "openclaw" ? await startOpenClawFixture() : undefined;
    t.after(() => gateway?.close());
    const config = (root) => {
      const base = { id: kernel, kernel, cwd: root };
      if (kernel === "codex")
        return {
          ...base,
          options: {
            command: resolve("test/fixtures/codex-server.mjs"),
            args: [],
          },
        };
      if (["kimi", "opencode"].includes(kernel))
        return {
          ...base,
          options: {
            command: resolve("test/fixtures/acp-server.mjs"),
            args: [],
          },
        };
      if (kernel === "claude")
        return { ...base, options: { query: createClaudeQueryFixture() } };
      if (kernel === "pi")
        return {
          ...base,
          options: { model, streamFn: piStream([], "edit_document") },
        };
      if (kernel === "hermes")
        return {
          ...base,
          options: {
            command: process.execPath,
            args: [resolve("test/fixtures/hermes-gateway.mjs")],
          },
        };
      return { ...base, options: { url: gateway.url, token: gateway.token } };
    };
    const { client, restart } = await fixture(t, {
      configure: (root) => [createNativeRuntime(config(root), root)],
    });
    const prompt = {
      codex: "tool",
      claude: "fixture tool",
      pi: "call edit",
      opencode: "tool",
      kimi: "tool",
      hermes: "CALL_TOOL",
      openclaw: "TOOL",
    }[kernel];
    let allows = true,
      edits = 0;
    const tools = [
      {
        ...tool,
        execute: async () => {
          if (allows) edits++;
          return {
            success: allows,
            contentItems: [
              { type: "inputText", text: allows ? "Saved" : "Rejected" },
            ],
          };
        },
      },
    ];
    const run = async () => {
      const task = await client()
        .session({ sessionId: "product", runtimeId: kernel, tools })
        .run(prompt);
      const events = [];
      const result = await task.wait({
        pollMs: 20,
        signal: AbortSignal.timeout(15_000),
        onEvent: ({ event }) => events.push(event),
      });
      assert.equal(result.status, "completed", JSON.stringify(result));
      return events;
    };
    const first = await run();
    assert.equal(edits, 1);
    const threadId = first.find(
      (event) => event.type === "session.bound",
    ).threadId;
    allows = false;
    await restart();
    const second = await run();
    assert.equal(edits, 1);
    const binding = second.find((event) => event.type === "session.bound");
    assert.equal(binding.resumed, true);
    assert.equal(binding.threadId, threadId);
    assert.equal(
      second.find((event) => event.type === "tool.finished").result.success,
      false,
    );
  });
}
