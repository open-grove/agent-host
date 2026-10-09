import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { CodexAgent } from "../dist/codex/index.js";
import { FileBindingStore } from "../dist/index.js";

// Native, model-backed and opt-in. Uses existing Codex login; no credential copying.
await mkdir(".local", { recursive: true });
const cwd = await mkdtemp(resolve(".local/native-probe-"));
const command =
  process.env.AGENT_HOST_CODEX ?? resolve("node_modules/.bin/codex");
const bindings = new FileBindingStore(join(cwd, "bindings"));
let calls = 0;
const tools = [
  {
    namespace: "probe",
    name: "record_probe",
    description: "Record a value in the test product.",
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
    async execute(input) {
      calls++;
      return {
        success: true,
        contentItems: [{ type: "inputText", text: `Recorded ${input.value}` }],
      };
    },
  },
];
const config = {
  sessionId: "probe",
  cwd,
  tools,
  instructions:
    "Follow the request. Use only the supplied product tool, no shell or other tools.",
  thread: {
    sandbox: "read-only",
    approvalPolicy: "never",
    config: { "features.apps": false },
  },
};
let agent = new CodexAgent({ command, bindings });
const outcomes = [];
async function run(input) {
  const events = await Array.fromAsync(
    agent.run({ ...config, input, signal: AbortSignal.timeout(120_000) }),
  );
  const bound = events.find((event) => event.type === "session.bound");
  const outcome = events.at(-1).outcome;
  outcomes.push({
    input,
    resumed: bound?.resumed,
    outcome,
    toolsCalled: calls,
  });
  console.log(JSON.stringify(outcomes.at(-1)));
  assert.equal(outcome.status, "completed");
  return events;
}
try {
  const first = await run(
    "Remember the code word MAPLE. Call record_probe exactly once with value MAPLE, then say recorded.",
  );
  assert.equal(calls, 1);
  await agent.close();
  agent = new CodexAgent({ command, bindings });
  const second = await run(
    "What code word did I give you? Reply with only that word. Do not call tools.",
  );
  assert.equal(
    first.find((e) => e.type === "session.bound").threadId,
    second.find((e) => e.type === "session.bound").threadId,
  );
  assert.match(second.find((e) => e.type === "model.response").text, /MAPLE/);
  assert.equal(calls, 1);
  const compactEvents = await Array.fromAsync(
    agent.run({
      ...config,
      input: "",
      mode: "compact",
      signal: AbortSignal.timeout(120_000),
    }),
  );
  assert.equal(
    compactEvents.at(-1).outcome.status,
    "completed",
    JSON.stringify(compactEvents.at(-1)),
  );
  assert.ok(
    compactEvents.some(
      (e) =>
        e.type === "native.notification" &&
        e.notification.method === "item/completed" &&
        e.notification.params.item?.type === "contextCompaction",
    ),
  );
  console.log(
    "PASS native namespaced product tool, continuation after restart and compaction",
  );
} finally {
  await agent.close();
}
