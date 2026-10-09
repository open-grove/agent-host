import { WebSocketServer } from "ws";
import plugin from "../../dist/openclaw/plugin.js";
export async function startOpenClawFixture({
  ignoreCancel = false,
  pluginEnabled = true,
  canonicalize = false,
} = {}) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  const methods = new Map(),
    sessions = new Map(),
    runs = new Map(),
    calls = [];
  let factory,
    next = 0;
  if (pluginEnabled)
    plugin.register({
      registerGatewayMethod(name, method) {
        methods.set(name, method);
      },
      registerTool(value) {
        factory = value;
      },
    });
  server.on("connection", (socket) => {
    const connId = `connection-${++next}`;
    const send = (frame) =>
      socket.readyState === 1 && socket.send(JSON.stringify(frame));
    send({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "challenge" },
    });
    socket.on("message", async (bytes) => {
      const frame = JSON.parse(bytes),
        p = frame.params ?? {};
      calls.push({ method: frame.method, params: p });
      const respond = (ok, payload, error) =>
        send({ type: "res", id: frame.id, ok, payload, error });
      try {
        if (methods.has(frame.method)) {
          methods.get(frame.method)({ params: p, client: { connId }, respond });
          return;
        }
        if (frame.method === "connect")
          return respond(true, {
            type: "hello-ok",
            protocol: 4,
            server: { version: "2026.9.9" },
          });
        if (frame.method === "sessions.resolve") {
          const key =
            canonicalize && !p.key.startsWith("agent:")
              ? "agent:main:" + p.key
              : p.key;
          return respond(true, { ok: sessions.has(key), key });
        }
        if (frame.method === "sessions.patch") {
          p.key =
            canonicalize && !p.key.startsWith("agent:")
              ? "agent:main:" + p.key
              : p.key;
          sessions.set(p.key, { model: p.model });
          const slash = p.model.indexOf("/");
          return respond(true, {
            key: p.key,
            resolved: {
              modelProvider: p.model.slice(0, slash),
              model: p.model.slice(slash + 1),
            },
          });
        }
        if (frame.method === "sessions.list")
          return respond(true, {
            sessions: [...sessions].map(([key]) => ({ key })),
          });
        if (frame.method === "sessions.compact")
          return respond(true, { compacted: true });
        if (frame.method === "chat.send" || frame.method === "agent") {
          sessions.set(p.sessionKey, sessions.get(p.sessionKey) ?? {});
          const runId = `native-${p.idempotencyKey}`;
          const run = { status: "running", sessionKey: p.sessionKey };
          runs.set(runId, run);
          send({
            type: "event",
            event: "agent",
            payload: { stream: "assistant", data: { text: "UNSCOPED" } },
          });
          send({
            type: "event",
            event: "agent",
            payload: {
              runId: "other",
              stream: "assistant",
              data: { text: "OTHER" },
            },
          });
          // Native frames may arrive before the admission acknowledgement.
          if (
            !p.message.includes("EMPTY") &&
            !p.message.includes("TOOL") &&
            !p.message.includes("HANG")
          )
            send({
              type: "event",
              event: "agent",
              payload: {
                runId,
                stream: "assistant",
                data: { text: "native reply" },
              },
            });
          respond(true, { runId });
          if (p.message.includes("HANG")) return;
          let text = "native reply";
          if (p.message.includes("TOOL")) {
            const tools = factory.create({
              sessionKey: p.sessionKey,
              assertInvocationCurrent() {
                if (run.status !== "running")
                  throw new Error("stale invocation");
              },
            });
            const tool = tools.find((t) => t.name === "agent_host_call");
            if (!tool) throw new Error("product tool absent");
            const result = await tool.execute("call-1", {
              name: tool.parameters.properties.name.enum[0],
              input: { text: "Saved via OpenClaw" },
            });
            await tool.execute("call-1", {
              name: tool.parameters.properties.name.enum[0],
              input: { text: "Saved via OpenClaw" },
            });
            text = JSON.stringify(result.content);
          }
          if (!p.message.includes("EMPTY")) {
            send({
              type: "event",
              event: "agent",
              payload: { runId, stream: "assistant", data: { text } },
            });
            send({
              type: "event",
              event: "chat",
              payload: {
                runId,
                sessionKey: p.sessionKey,
                state: "delta",
                deltaText: text,
              },
            });
            send({
              type: "event",
              event: "chat",
              payload: {
                runId,
                sessionKey: p.sessionKey,
                state: "final",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text }],
                },
              },
            });
          }
          run.status = "ok";
          return;
        }
        if (frame.method === "agent.wait") {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return respond(true, {
            status:
              runs.get(p.runId)?.status === "running"
                ? "timeout"
                : (runs.get(p.runId)?.status ?? "error"),
          });
        }
        if (frame.method === "chat.abort") {
          if (!ignoreCancel && runs.has(p.runId))
            runs.get(p.runId).status = "aborted";
          return respond(true, { ok: true });
        }
        if (frame.method === "chat.history")
          return respond(true, {
            messages: [{ role: "assistant", text: "STALE ANSWER" }],
          });
        throw new Error("Unknown method " + frame.method);
      } catch (error) {
        respond(false, undefined, { message: String(error) });
      }
    });
  });
  return {
    url: `ws://127.0.0.1:${server.address().port}`,
    calls,
    deleteSession: (key) => sessions.delete(key),
    close: async () => {
      for (const client of server.clients) client.terminate();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
