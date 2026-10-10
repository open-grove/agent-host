import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const sessions = new Map();
const requests = new Map();
const pending = new Map();
let seq = 0;
const send = (value) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...value })}\n`);
const reply = (id, result) => send({ id, result });
const request = (method, params) =>
  new Promise((resolve) => {
    const id = `native-${++seq}`;
    requests.set(id, resolve);
    send({ id, method, params });
  });
const update = (sessionId, text) =>
  send({
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    },
  });
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  void handle(message).catch((error) =>
    send({ id: message.id, error: { code: -32603, message: String(error) } }),
  );
}
async function handle({ id, method, params }) {
  if (!method) return requests.get(id)?.(arguments[0].result);
  if (process.env.ACP_TEST_LOG)
    appendFileSync(
      process.env.ACP_TEST_LOG,
      `${JSON.stringify({ method, params })}\n`,
    );
  if (method === "initialize")
    return reply(id, {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: process.env.ACP_TEST_NO_RESUME !== "1",
        promptCapabilities: { image: true },
      },
    });
  if (method === "session/new" || method === "session/load") {
    if (method === "session/load" && process.env.ACP_TEST_FAIL_RESUME)
      throw new Error("native_transcript_missing");
    const sessionId = params.sessionId ?? `session-${++seq}`;
    sessions.set(sessionId, params);
    if (method === "session/load")
      update(sessionId, "Old transcript replay must not enter new response");
    return reply(id, {
      sessionId,
      configOptions: [
        {
          id: "model",
          type: "select",
          category: "model",
          options: [{ value: "opaque-model", name: "Selected model" }],
        },
      ],
    });
  }
  if (method === "session/set_config_option") {
    if (params.value !== "opaque-model") throw new Error("wrong_model_id");
    return reply(id, {});
  }
  if (method === "session/cancel") {
    const active = pending.get(params.sessionId);
    if (active && !active.ignore) {
      pending.delete(params.sessionId);
      reply(active.id, { stopReason: "cancelled" });
    }
    return;
  }
  if (method === "session/prompt") {
    const text = params.prompt.map((item) => item.text ?? "").join("\n");
    if (text.includes("wait")) {
      pending.set(params.sessionId, {
        id,
        ignore: text.includes("ignore-cancel"),
      });
      update(params.sessionId, "waiting");
      return;
    }
    if (text.includes("permission")) {
      const result = await request("session/request_permission", {
        sessionId: params.sessionId,
        toolCall: { toolCallId: "native-write" },
        options: [{ optionId: "yes", kind: "allow_once" }],
      });
      update(params.sessionId, JSON.stringify(result));
    } else if (text.includes("question")) {
      const result = await request("elicitation/create", {
        sessionId: params.sessionId,
        mode: "form",
        message: "Title?",
        requestedSchema: {
          type: "object",
          properties: { title: { type: "string" } },
        },
      });
      update(params.sessionId, JSON.stringify(result));
    } else if (text.includes("tool")) {
      const server = sessions.get(params.sessionId).mcpServers[0];
      const client = new Client({ name: "fixture", version: "1" });
      await client.connect(
        new StdioClientTransport({
          command: server.command,
          args: server.args,
          env: {
            ...process.env,
            ...Object.fromEntries(
              server.env.map(({ name, value }) => [name, value]),
            ),
          },
        }),
      );
      try {
        const { tools } = await client.listTools();
        const result = await client.callTool({
          name: tools[0].name,
          arguments: { text: "Saved via ACP" },
        });
        update(params.sessionId, JSON.stringify(result));
      } finally {
        await client.close();
      }
    } else update(params.sessionId, text);
    return reply(id, { stopReason: "end_turn" });
  }
  throw new Error(`unknown_method:${method}`);
}
