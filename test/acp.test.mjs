import assert from "node:assert/strict";
import test from "node:test";
import { Server as NetServer } from "node:net";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AcpAgent, AcpHostToolBridgeServer } from "../dist/acp/index.js";
import { MemoryBindingStore } from "../dist/codex/index.js";
const command = fileURLToPath(
  new URL("./fixtures/acp-server.mjs", import.meta.url),
);
const base = {
  sessionId: "editor",
  cwd: process.cwd(),
  instructions: "Be helpful",
  input: "hello",
};
function agent(t, options = {}) {
  const a = new AcpAgent({
    command,
    args: [],
    cancellationGraceMs: 100,
    controlRequestTimeoutMs: 1_000,
    ...options,
  });
  t.after(() => a.close());
  return a;
}
const run = (a, request = {}) =>
  Array.fromAsync(a.run({ ...base, ...request }));
function terminal(events) {
  assert.equal(
    events.filter((event) => event.type === "turn.finished").length,
    1,
  );
  return events.at(-1).outcome;
}

test("concurrent MCP preparation shares one listener and keeps capabilities isolated", async (t) => {
  const listen = NetServer.prototype.listen;
  let listeners = 0;
  NetServer.prototype.listen = function (...args) {
    listeners++;
    return Reflect.apply(listen, this, args);
  };
  t.after(() => {
    NetServer.prototype.listen = listen;
  });
  const server = new AcpHostToolBridgeServer();
  t.after(() => server.close());
  const bridge = {
    descriptors: [],
    async call() {
      return { content: [] };
    },
  };
  const bindings = await Promise.all(
    ["one", "two"].map((scope) => server.prepare({ scope, bridge })),
  );
  const field = (binding, suffix) =>
    binding.mcpServer.env.find(
      ({ name }) => name === `AGENT_HOST_TOOL_${suffix}`,
    ).value;
  assert.equal(field(bindings[0], "ENDPOINT"), field(bindings[1], "ENDPOINT"));
  assert.notEqual(field(bindings[0], "TOKEN"), field(bindings[1], "TOKEN"));
  assert.equal(
    listeners,
    1,
    "Concurrent sessions must not leak an unowned TCP listener",
  );
});

test("ACP native binding survives a process restart without replaying old output", async (t) => {
  const bindings = new MemoryBindingStore();
  const a = agent(t, { bindings });
  assert.equal(terminal(await run(a)).status, "completed");
  const original = await bindings.get(base.sessionId);
  await a.close();
  const events = await run(agent(t, { bindings }), {
    context: "Current product state",
  });
  assert.equal(
    events.find((event) => event.type === "session.bound").resumed,
    true,
  );
  assert.equal(
    (await bindings.get(base.sessionId)).threadId,
    original.threadId,
  );
  assert.equal(
    events.find((event) => event.type === "model.response").text,
    "Be helpful\n\nCurrent product state\nhello",
  );
});
test("ACP failed resume and unsupported resume never create a replacement", async (t) => {
  for (const env of [
    { ACP_TEST_FAIL_RESUME: "1" },
    { ACP_TEST_NO_RESUME: "1" },
  ]) {
    const directory = await mkdtemp(join(tmpdir(), "agent-host-acp-"));
    const log = join(directory, "protocol.jsonl");
    const bindings = new MemoryBindingStore();
    await bindings.set(base.sessionId, {
      threadId: "existing",
      fingerprint: "stable",
    });
    const events = await run(
      agent(t, { bindings, env: { ...env, ACP_TEST_LOG: log } }),
      { bindingFingerprint: "stable" },
    );
    assert.equal(terminal(events).status, "failed");
    assert.equal(
      (await readFile(log, "utf8")).includes('"method":"session/new"'),
      false,
    );
    assert.equal((await bindings.get(base.sessionId)).threadId, "existing");
  }
});
test("ACP product tools cross the real stdio MCP bridge once", async (t) => {
  let calls = 0;
  const events = await run(agent(t), {
    input: "tool",
    tools: [
      {
        name: "edit_document",
        description: "Edit",
        inputSchema: { type: "object" },
        async execute(input) {
          assert.equal(input.text, "Saved via ACP");
          calls++;
          return {
            success: true,
            contentItems: [{ type: "inputText", text: "Saved" }],
          };
        },
      },
    ],
  });
  assert.equal(calls, 1);
  assert.equal(
    events.filter((event) => event.type === "tool.started").length,
    1,
  );
  assert.equal(
    events.filter((event) => event.type === "tool.finished").length,
    1,
  );
  assert.equal(terminal(events).status, "completed");
});
test("ACP routes native permission and form elicitation to the matching product session", async (t) => {
  const a = agent(t, { elicitation: { form: {} } });
  const results = await Promise.all(
    ["permission", "question"].map((input) =>
      run(a, {
        input,
        sessionId: input,
        async onRequest(request, context) {
          assert.equal(context.sessionId, input);
          return request.method === "elicitation/create"
            ? { action: "accept", content: { title: "New title" } }
            : { outcome: { outcome: "selected", optionId: "yes" } };
        },
      }),
    ),
  );
  assert.match(
    results[0].find((event) => event.type === "model.response").text,
    /selected/,
  );
  assert.match(
    results[1].find((event) => event.type === "model.response").text,
    /New title/,
  );
});
test("ACP cancellation ends a waiting prompt and a cancelled-before-start turn sends no prompt", async (t) => {
  const a = agent(t);
  const controller = new AbortController();
  const events = [];
  for await (const event of a.run({
    ...base,
    input: "wait",
    signal: controller.signal,
  })) {
    events.push(event);
    if (event.type === "assistant.delta") controller.abort();
  }
  assert.equal(terminal(events).status, "cancelled");
  const cancelled = await run(a, { signal: AbortSignal.abort() });
  assert.equal(
    cancelled.some((event) => event.type === "session.bound"),
    false,
  );
  assert.equal(terminal(cancelled).status, "cancelled");
});
test("ACP abandoned cancellation retires its process without killing a sibling session", async (t) => {
  const a = agent(t);
  const controller = new AbortController();
  let waiting;
  const ready = new Promise((resolve) => {
    waiting = resolve;
  });
  const abandoned = (async () => {
    const events = [];
    for await (const event of a.run({
      ...base,
      input: "wait ignore-cancel",
      signal: controller.signal,
    })) {
      events.push(event);
      if (event.type === "assistant.delta") {
        waiting();
        controller.abort();
      }
    }
    return events;
  })();
  await ready;
  let release;
  const delay = new Promise((resolve) => {
    release = resolve;
  });
  const sibling = run(a, {
    sessionId: "sibling",
    input: "permission",
    async onRequest() {
      await delay;
      return { outcome: { outcome: "cancelled" } };
    },
  });
  const ended = await abandoned;
  assert.equal(terminal(ended).outcomeUnknown, true);
  release();
  assert.equal(terminal(await sibling).status, "completed");
});
test("ACP rejects same-session concurrent work and resolves opaque model selectors", async (t) => {
  const a = agent(t);
  const controller = new AbortController();
  for await (const event of a.run({
    ...base,
    input: "wait",
    signal: controller.signal,
  })) {
    if (event.type === "assistant.delta") {
      assert.equal(terminal(await run(a)).error, "session_busy");
      controller.abort();
    }
  }
  assert.equal(
    terminal(await run(a, { model: "Selected model" })).status,
    "completed",
  );
});
