import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { model, fixture } from "./fixtures/pi-stream.mjs";
import { PiAgent } from "../dist/pi/index.js";
import { FileBindingStore } from "../dist/index.js";
const base = {
  sessionId: "document",
  input: "hello",
  instructions: "Stable instructions",
};
test("Pi 1.1 durable: native JSONL survives restart, tools execute through product policy, and latest context reaches the native model", async () => {
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
    const mismatch = await run({ instructions: "Changed" });
    assert.match(mismatch.at(-1).outcome.error, /configuration_changed/);
  } finally {
    await agent.close();
  }
});
test("Pi 1.1 durable: pre-aborted input never calls a provider", async () => {
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

test("Pi durable cancels a tool waiting on the product without claiming completion", {
  timeout: 2000,
}, async () => {
  const controller = new AbortController();
  const observed = [];
  const agent = new PiAgent({
    model,
    streamFn: fixture(observed),
    abortSettleTimeoutMs: 40,
  });
  const started = Date.now();
  try {
    const events = await Array.fromAsync(
      agent.run({
        ...base,
        cwd: process.cwd(),
        input: "call edit",
        signal: controller.signal,
        tools: [
          {
            name: "edit",
            description: "Wait for a product decision",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
            },
            execute: async () => {
              controller.abort();
              return new Promise(() => {});
            },
          },
        ],
      }),
    );
    assert.notEqual(events.at(-1).outcome.status, "completed");
    assert.ok(Date.now() - started < 2000);
    assert.equal(events.filter((e) => e.type === "turn.finished").length, 1);
  } finally {
    await agent.close();
  }
});
