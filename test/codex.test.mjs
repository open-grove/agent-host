import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CodexAgent, MemoryBindingStore } from "../dist/codex/index.js";

const command = fileURLToPath(
  new URL("./fixtures/codex-server.mjs", import.meta.url),
);
const base = {
  sessionId: "product-session",
  cwd: process.cwd(),
  instructions: "Stable instructions",
  input: "hello",
};

test("steering targets the active native turn and cancellation ends it", async (t) => {
  const agent = await agentTest(t);
  const controller = new AbortController();
  const events = [];
  for await (const event of agent.run({ ...base, input: "wait", signal: controller.signal })) {
    events.push(event);
    if (event.type === "native.notification" && event.notification.method === "turn/started") {
      await agent.steer(base.sessionId, "Focus on the introduction");
      controller.abort();
    }
  }
  assert.equal(terminal(events).status, "cancelled");
});
const response = (events) =>
  events.find((e) => e.type === "model.response").text;
function terminal(events) {
  assert.equal(events.filter((e) => e.type === "turn.started").length, 1);
  assert.equal(events.filter((e) => e.type === "model.response").length, 1);
  assert.equal(events.filter((e) => e.type === "turn.finished").length, 1);
  return events.at(-1).outcome;
}
async function agentTest(t, options = {}) {
  const agent = new CodexAgent({
    command,
    args: [],
    cancellationGraceMs: 500,
    requestTimeoutMs: 1_000,
    ...options,
  });
  t.after(() => agent.close());
  return agent;
}
test("streams only final text and handles completion before start acknowledgement", async (t) => {
  const agent = await agentTest(t);
  const events = await Array.fromAsync(agent.run(base));
  assert.equal(response(events), "hello");
  assert.deepEqual(
    events.filter((e) => e.type === "assistant.delta").map((e) => e.text),
    ["hello"],
  );
  assert.deepEqual(terminal(events), { status: "completed" });
});
test("Codex 0.162 compaction observes the native turn instead of expecting an ID in its response", async (t) => {
  const agent = await agentTest(t);
  await Array.fromAsync(agent.run(base));
  const events = await Array.fromAsync(agent.run({ ...base, mode: "compact" }));
  assert.equal(terminal(events).status, "completed");
  assert.ok(
    events.some(
      (e) =>
        e.type === "native.notification" &&
        e.notification.params.item?.type === "contextCompaction",
    ),
  );
});
test("compacting a missing session does not create one", async (t) => {
  const agent = await agentTest(t);
  const events = await Array.fromAsync(agent.run({ ...base, mode: "compact" }));
  assert.equal(terminal(events).error, "session_not_found");
  assert.equal(
    events.some((e) => e.type === "session.bound"),
    false,
  );
});
test("native continuation across process restart receives fresh product context", async (t) => {
  const bindings = new MemoryBindingStore();
  const first = await agentTest(t, { bindings });
  const one = await Array.fromAsync(first.run(base));
  await first.close();
  const second = await agentTest(t, { bindings });
  const two = await Array.fromAsync(
    second.run({ ...base, context: "Current document version 2" }),
  );
  assert.equal(one[1].threadId, two[1].threadId);
  assert.equal(two[1].resumed, true);
  assert.equal(response(two), "Current document version 2\nhello");
});
test("scope changes and failed resume are explicit failures, never recreate", async (t) => {
  const bindings = new MemoryBindingStore();
  const agent = await agentTest(t, { bindings });
  await Array.fromAsync(agent.run(base));
  const changed = await Array.fromAsync(
    agent.run({ ...base, instructions: "Different" }),
  );
  assert.match(terminal(changed).error, /session_scope_changed/);
  const existing = await bindings.get(base.sessionId);
  await bindings.set(base.sessionId, { ...existing, threadId: "missing" });
  const missing = await Array.fromAsync(agent.run(base));
  assert.match(terminal(missing).error, /session unavailable/);
  assert.equal(
    missing.some((e) => e.type === "session.bound"),
    false,
  );
});
test("duplicate native tool calls share one execution", async (t) => {
  const agent = await agentTest(t);
  let executions = 0;
  const events = await Array.fromAsync(
    agent.run({
      ...base,
      input: "duplicate-tool",
      tools: [
        {
          name: "edit_document",
          description: "Edit example",
          inputSchema: { type: "object" },
          async execute(input, { callId }) {
            executions++;
            assert.equal(callId, "call-1");
            assert.deepEqual(input, { text: "Updated by Agent" });
            await new Promise((resolve) => setTimeout(resolve, 10));
            return {
              success: true,
              contentItems: [{ type: "inputText", text: "Edited" }],
            };
          },
        },
      ],
    }),
  );
  assert.equal(executions, 1);
  assert.equal(events.filter((e) => e.type === "tool.finished").length, 1);
  assert.equal(terminal(events).status, "completed");
});
test("failed product tools produce a correlated failure result", async (t) => {
  const agent = await agentTest(t);
  const events = await Array.fromAsync(
    agent.run({
      ...base,
      input: "tool",
      tools: [
        {
          name: "edit_document",
          description: "fails",
          inputSchema: { type: "object" },
          execute: async () => {
            throw new Error("product_unavailable");
          },
        },
      ],
    }),
  );
  const result = events.find((e) => e.type === "tool.finished");
  assert.equal(result?.callId, "call-1");
  assert.equal(result?.result.success, false);
  assert.match(result?.result.contentItems[0].text, /product_unavailable/);
});
test("Codex 0.162 tool namespaces route identical function names to their own product handler", async (t) => {
  const agent = await agentTest(t);
  let called = "";
  const events = await Array.fromAsync(
    agent.run({
      ...base,
      input: "namespaced-tool",
      tools: ["documents", "images"].map((namespace) => ({
        namespace,
        name: "edit_document",
        description: "Scoped edit",
        inputSchema: { type: "object" },
        async execute() {
          called = namespace;
          return {
            success: true,
            contentItems: [{ type: "inputText", text: namespace }],
          };
        },
      })),
    }),
  );
  assert.equal(called, "documents");
  assert.equal(terminal(events).status, "completed");
});
test("native approval accept/reject and structured questions return to the same turn", async (t) => {
  const agent = await agentTest(t);
  for (const decision of ["accept", "decline"]) {
    const events = await Array.fromAsync(
      agent.run({
        ...base,
        input: "approval",
        onRequest: async (request, context) => {
          assert.equal(request.params.threadId, context.threadId);
          return { decision };
        },
      }),
    );
    assert.deepEqual(JSON.parse(response(events)), { decision });
  }
  const events = await Array.fromAsync(
    agent.run({
      ...base,
      input: "question",
      onRequest: async () => ({ answers: { color: { answers: ["Blue"] } } }),
    }),
  );
  assert.deepEqual(JSON.parse(response(events)), {
    answers: { color: { answers: ["Blue"] } },
  });
});
test("cancellation unblocks an unanswered interaction and signals the product", async (t) => {
  const agent = await agentTest(t);
  const controller = new AbortController();
  let productSignal;
  const events = await Array.fromAsync(
    agent.run({
      ...base,
      input: "approval",
      signal: controller.signal,
      onRequest: async (_request, context) => {
        productSignal = context.signal;
        controller.abort();
        return new Promise(() => {});
      },
    }),
  );
  assert.equal(productSignal.aborted, true);
  assert.equal(terminal(events).status, "cancelled");
});
test("cancellation closes a hanging product tool with one correlated result", async (t) => {
  const agent = await agentTest(t);
  const controller = new AbortController();
  const events = await Array.fromAsync(
    agent.run({
      ...base,
      input: "duplicate-tool",
      signal: controller.signal,
      tools: [
        {
          name: "edit_document",
          description: "Wait for product",
          inputSchema: { type: "object" },
          async execute() {
            queueMicrotask(() => controller.abort());
            return new Promise(() => {});
          },
        },
      ],
    }),
  );
  assert.equal(events.filter((e) => e.type === "tool.finished").length, 1);
  assert.equal(
    events.find((e) => e.type === "tool.finished").result.success,
    false,
  );
  assert.equal(terminal(events).status, "cancelled");
});
test("lost producer and unacknowledged mutations report unknown outcomes", async (t) => {
  const agent = await agentTest(t);
  for (const input of ["lose-producer", "never-acknowledge"]) {
    const events = await Array.fromAsync(
      agent.run({ ...base, sessionId: input, input }),
    );
    assert.equal(terminal(events).status, "failed");
    assert.equal(terminal(events).outcomeUnknown, true);
  }
});
test("a timed out session start retires the producer without killing a sibling turn", async (t) => {
  const agent = await agentTest(t, {
    requestTimeoutMs: 100,
    env: { AGENT_HOST_FIXTURE_DELAY: "1" },
  });
  // First thread allocation consumes ID 1; its turn allocation consumes ID 2.
  // Use a live client request to allocate the first thread without a turn.
  await (await agent.connect()).request("thread/start", {});
  const abandoned = Array.fromAsync(
    agent.run({ ...base, sessionId: "abandoned" }),
  );
  await new Promise((resolve) => setTimeout(resolve, 25));
  const sibling = Array.fromAsync(
    agent.run({ ...base, sessionId: "sibling", input: "slow" }),
  );
  assert.equal(terminal(await abandoned).outcomeUnknown, true);
  assert.equal(terminal(await sibling).status, "completed");
});
test("concurrent sessions are correlated and a busy session cannot overwrite its owner", async (t) => {
  const agent = await agentTest(t);
  const controller = new AbortController();
  let ready;
  const started = new Promise((resolve) => {
    ready = resolve;
  });
  const first = (async () => {
    const events = [];
    for await (const event of agent.run({
      ...base,
      input: "wait",
      signal: controller.signal,
    })) {
      events.push(event);
      if (event.type === "session.bound") ready();
    }
    return events;
  })();
  await started;
  const busy = await Array.fromAsync(agent.run(base));
  assert.equal(terminal(busy).error, "session_busy");
  const other = await Array.fromAsync(
    agent.run({ ...base, sessionId: "other", input: "other-answer" }),
  );
  assert.equal(response(other), "other-answer");
  controller.abort();
  assert.equal(terminal(await first).status, "cancelled");
});
