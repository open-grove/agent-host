import assert from "node:assert/strict";
import test from "node:test";
import { ClaudeAgent, createClaudeMcpServer } from "../dist/claude/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MemoryBindingStore } from "../dist/index.js";
import { createClaudeQueryFixture } from "./fixtures/claude-query.mjs";
const base = {
  sessionId: "document",
  cwd: process.cwd(),
  instructions: "Stable instructions",
  context: "Current contents",
  input: "hello",
};

test("Claude MCP preserves JSON Schema constraints and rejects invalid input before the product runs", async () => {
  let calls = 0;
  const schema = {
    type: "object",
    properties: { text: { type: "string", minLength: 3, pattern: "^[A-Z]" } },
    required: ["text"],
    additionalProperties: false,
  };
  const server = createClaudeMcpServer({
    name: "schema-probe",
    tools: [{ name: "edit", description: "Edit", inputSchema: schema }],
    async call() {
      calls++;
      return { content: [] };
    },
  });
  const [left, right] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "schema-consumer", version: "1" });
  await server.instance.connect(right);
  await client.connect(left);
  try {
    const listed = await client.listTools();
    assert.equal(listed.tools[0].inputSchema.properties.text.minLength, 3);
    const invalid = await client.callTool({
      name: "edit",
      arguments: { text: "x" },
    });
    assert.equal(invalid.isError, true);
    assert.equal(calls, 0);
  } finally {
    await client.close();
  }
});
function agent(t, options = {}) {
  const a = new ClaudeAgent({ query: createClaudeQueryFixture(), ...options });
  t.after(() => a.close());
  return a;
}
const run = (agent, request = {}) =>
  Array.fromAsync(agent.run({ ...base, ...request }));
function terminal(events) {
  assert.equal(
    events.filter((event) => event.type === "turn.finished").length,
    1,
  );
  return events.at(-1).outcome;
}

test("Claude keeps stable instructions separate from current context across native resume", async (t) => {
  const observed = [];
  const bindings = new MemoryBindingStore();
  const query = createClaudeQueryFixture(observed);
  const a = agent(t, { bindings, query });
  assert.equal(terminal(await run(a)).status, "completed");
  const session = await bindings.get(base.sessionId);
  await a.close();
  const events = await run(agent(t, { bindings, query }), {
    context: "Updated contents",
  });
  assert.equal(observed[1].resume, session.threadId);
  assert.equal(observed[1].systemPrompt.append, "Stable instructions");
  assert.equal(
    events.find((event) => event.type === "model.response").text,
    "Updated contents\n\nhello",
  );
  assert.equal(
    events.find((event) => event.type === "session.bound").resumed,
    true,
  );
});
test("Claude in-process MCP tool reaches the product exactly once", async (t) => {
  let calls = 0;
  const events = await run(agent(t), {
    input: "fixture tool",
    tools: [
      {
        name: "edit_document",
        description: "Edit",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
        async execute(input) {
          calls++;
          assert.equal(input.text, "Saved via Claude");
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
test("Claude native permissions and elicitation remain separate callbacks", async (t) => {
  for (const kind of ["permission", "question"]) {
    const events = await run(agent(t), {
      input: `fixture ${kind}`,
      async onRequest(request, context) {
        assert.equal(context.sessionId, base.sessionId);
        return request.method === "permission"
          ? { behavior: "deny", message: "Rejected" }
          : { action: "accept", content: { title: "Maple" } };
      },
    });
    assert.equal(terminal(events).status, "completed");
    assert.match(
      events.find((event) => event.type === "model.response").text,
      kind === "permission" ? /Rejected/ : /Maple/,
    );
  }
});
test("Claude cancellation releases a pending native interaction even if the UI never responds", async (t) => {
  const controller = new AbortController();
  const events = await run(agent(t), {
    input: "fixture permission",
    signal: controller.signal,
    async onRequest() {
      controller.abort();
      return new Promise(() => {});
    },
  });
  assert.equal(terminal(events).status, "cancelled");
  assert.equal(terminal(events).outcomeUnknown, true);
});
test("Claude activates Auto before input and explicitly falls back to Ask", async (t) => {
  const observed = [];
  const events = await run(
    agent(t, { query: createClaudeQueryFixture(observed) }),
    { native: { permissionMode: "auto" } },
  );
  assert.deepEqual(
    observed
      .filter((value) => value.activation)
      .map((value) => value.activation),
    ["auto", "default"],
  );
  assert.equal(terminal(events).status, "completed");
});
test("Claude cannot silently change a bound native configuration", async (t) => {
  const a = agent(t);
  await run(a);
  const events = await run(a, { instructions: "Different stable policy" });
  assert.equal(terminal(events).error, "session_configuration_changed");
  assert.equal(
    events.some((event) => event.type === "session.bound"),
    false,
  );
});
