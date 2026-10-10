import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HermesAgent } from "../dist/hermes/index.js";
import { FileBindingStore } from "../dist/index.js";
const fixture = resolve("test/fixtures/hermes-gateway.mjs");
const request = {
  sessionId: "product-session",
  cwd: process.cwd(),
  instructions: "Stable",
  input: "hello",
};
async function setup(extra = {}) {
  const home = await mkdtemp(join(tmpdir(), "hermes-host-test-"));
  const options = {
    command: process.execPath,
    args: [fixture],
    env: { ...process.env, HERMES_HOME: home },
    bindings: new FileBindingStore(join(home, "bindings")),
    exclusiveProfile: true,
    ...extra,
  };
  return { home, options, agent: new HermesAgent(options) };
}
test("Hermes uses stored IDs across restart, scopes native events and trusts compression receipts", async () => {
  const { options, agent } = await setup();
  let reopened;
  try {
    const first = await Array.fromAsync(agent.run(request));
    assert.equal(first.at(-1).outcome.status, "completed");
    assert.equal(
      first.find((e) => e.type === "model.response").text,
      "Native Hermes response",
    );
    const binding = first.find((e) => e.type === "session.bound");
    assert.match(binding.threadId, /^stored-/);
    assert.deepEqual(await agent.compact(request.sessionId, "pending"), {
      ok: false,
      compacted: false,
      error: "hermes_compression_pending",
    });
    assert.deepEqual(await agent.compact(request.sessionId, "focus"), {
      ok: true,
      compacted: true,
    });
    agent.close();
    reopened = new HermesAgent(options);
    const second = await Array.fromAsync(reopened.run(request));
    assert.deepEqual(
      second.find((e) => e.type === "session.bound"),
      { ...binding, runId: second[0].runId, resumed: true },
    );
  } finally {
    agent.close();
    reopened?.close();
  }
});
test("Hermes bridges product tools and preserves modern approval/multi-question answers", async () => {
  const { agent } = await setup();
  let calls = 0,
    allow = false;
  const tools = [
    {
      name: "edit_document",
      description: "Edit",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      execute: async () => {
        calls++;
        return {
          success: allow,
          contentItems: [
            { type: "inputText", text: allow ? "saved" : "rejected" },
          ],
        };
      },
    },
  ];
  try {
    const first = await Array.fromAsync(
      agent.run({ ...request, tools, input: "CALL_TOOL" }),
    );
    assert.match(
      first.find((e) => e.type === "model.response").text,
      /rejected/,
    );
    assert.equal(calls, 1);
    allow = true;
    const second = await Array.fromAsync(
      agent.run({ ...request, tools, input: "CALL_TOOL" }),
    );
    assert.match(second.find((e) => e.type === "model.response").text, /saved/);
    assert.equal(calls, 2);
    const third = await Array.fromAsync(
      agent.run({
        ...request,
        tools,
        input: "INTERACTION",
        onRequest: async (rpc) =>
          rpc.method === "approval"
            ? { choice: "once" }
            : { answers: { one: "blue", two: "large" } },
      }),
    );
    assert.deepEqual(
      JSON.parse(third.find((e) => e.type === "model.response").text),
      {
        permission: { choice: "once" },
        response: { answers: { one: "blue", two: "large" } },
      },
    );
  } finally {
    agent.close();
  }
});
test("Hermes pre-abort starts nothing; cancellation settles or retires the producer", async () => {
  const { agent, home } = await setup({ cancellationGraceMs: 20 });
  try {
    const aborted = await Array.fromAsync(
      agent.run({ ...request, signal: AbortSignal.abort() }),
    );
    assert.equal(aborted.at(-1).outcome.status, "cancelled");
    await assert.rejects(readFile(join(home, "methods.jsonl")), /ENOENT/);
    const controller = new AbortController();
    const events = [];
    for await (const event of agent.run({
      ...request,
      input: "HANG",
      signal: controller.signal,
    })) {
      events.push(event);
      if (event.type === "session.bound")
        setTimeout(() => controller.abort(), 40);
    }
    assert.deepEqual(events.at(-1).outcome, { status: "cancelled" });
  } finally {
    agent.close();
  }
});
test("Hermes failed native restore never creates a replacement conversation", async () => {
  const { agent, options, home } = await setup();
  await options.bindings.set(request.sessionId, {
    threadId: "missing",
    fingerprint: "known",
  });
  try {
    const events = await Array.fromAsync(
      agent.run({ ...request, bindingFingerprint: "known" }),
    );
    assert.equal(events.at(-1).outcome.status, "failed");
    assert.doesNotMatch(
      await readFile(join(home, "methods.jsonl"), "utf8"),
      /session.create|prompt.submit/,
    );
  } finally {
    agent.close();
  }
});
