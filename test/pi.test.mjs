import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { PiAgent } from "../dist/pi/index.js";
import { FileBindingStore } from "../dist/index.js";
const model = {
  id: "fixture",
  name: "Fixture",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "https://example.test/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 4096,
};
function fixture(observed) {
  return (_, context) => {
    observed.push(context);
    const tool = context.messages.at(-1)?.role === "toolResult";
    const call =
      !tool && JSON.stringify(context.messages.at(-1)).includes("call edit");
    const message = {
      role: "assistant",
      content: call
        ? [
            {
              type: "toolCall",
              id: "edit-1",
              name: "edit",
              arguments: { text: "CEDAR" },
            },
          ]
        : [
            {
              type: "text",
              text: tool
                ? JSON.stringify(context.messages.at(-1).content)
                : "Native reply",
            },
          ],
      api: model.api,
      provider: model.provider,
      model: model.id,
      stopReason: call ? "toolUse" : "stop",
      timestamp: Date.now(),
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: message.stopReason, message });
      stream.end();
    });
    return stream;
  };
}
const base = {
  sessionId: "document",
  input: "hello",
  instructions: "Stable instructions",
};
test("Pi native JSONL survives restart, tools execute through product policy, and latest context reaches the native model", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-host-pi-"));
  const observed = [];
  let calls = 0;
  const options = {
    cwd,
    sessionRoot: join(cwd, "sessions"),
    model,
    streamFn: fixture(observed),
    bindings: new FileBindingStore(join(cwd, "bindings")),
  };
  const tools = [
    {
      name: "edit",
      description: "Edit",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      execute: async (input) => {
        calls++;
        assert.equal(input.text, "CEDAR");
        return {
          success: false,
          contentItems: [{ type: "inputText", text: "User rejected edit" }],
        };
      },
    },
  ];
  let agent = new PiAgent(options);
  const run = (extra = {}) =>
    Array.fromAsync(agent.run({ ...base, cwd, tools, ...extra }));
  try {
    const first = await run({ input: "call edit", context: "Version one" });
    assert.equal(
      first.at(-1).outcome.status,
      "completed",
      JSON.stringify(first),
    );
    assert.equal(calls, 1);
    assert.equal(first.filter((e) => e.type === "tool.finished").length, 1);
    assert.match(
      first.find((e) => e.type === "model.response").text,
      /rejected/,
    );
    await agent.close();
    agent = new PiAgent(options);
    const resumed = await run({ context: "Version two" });
    assert.equal(resumed.at(-1).outcome.status, "completed");
    assert.equal(resumed.find((e) => e.type === "session.bound").resumed, true);
    assert.match(JSON.stringify(observed.at(-1).messages), /Version one/);
    assert.match(
      JSON.stringify(observed.at(-1).messages.at(-1)),
      /Version two/,
    );
    assert.equal(await agent.forkSession("document", "fork"), "forked");
    assert.equal((await agent.listSessions()).length, 2);
    assert.equal(await agent.deleteSession("fork"), true);
    const mismatch = await run({ instructions: "Changed" });
    assert.match(mismatch.at(-1).outcome.error, /configuration_changed/);
  } finally {
    await agent.close();
  }
});
test("Pi pre-aborted input never calls a provider", async () => {
  let calls = 0;
  const agent = new PiAgent({
    model,
    streamFn: () => {
      calls++;
      throw Error("must not run");
    },
  });
  try {
    const events = await Array.fromAsync(
      agent.run({ ...base, cwd: process.cwd(), signal: AbortSignal.abort() }),
    );
    assert.equal(events.at(-1).outcome.status, "cancelled");
    assert.equal(calls, 0);
  } finally {
    await agent.close();
  }
});
