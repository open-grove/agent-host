import assert from "node:assert/strict";

// Inspect the published SDK's recovery algorithm with a deterministic ACP seam.
// This is not a native daemon, sandbox, model, or provider certification.
const { SandboxAgent, InMemorySessionPersistDriver } = await import(
  process.env.AGENT_HOST_RIVET_MODULE ?? "sandbox-agent"
);
const persist = new InMemorySessionPersistDriver();
await persist.updateSession({
  id: "product",
  agent: "codex",
  agentSessionId: "native-original",
  lastConnectionId: "connection-old",
  createdAt: 1,
  sessionInit: { cwd: "/workspace", mcpServers: [] },
});
await persist.insertEvent("product", {
  id: "event-1",
  sessionId: "product",
  eventIndex: 0,
  createdAt: 1,
  sender: "client",
  payload: {
    jsonrpc: "2.0",
    id: 1,
    method: "session/prompt",
    params: {
      sessionId: "native-original",
      prompt: [{ type: "text", text: "Remember CEDAR" }],
    },
  },
});
const sdk = await SandboxAgent.connect({
  baseUrl: "http://127.0.0.1:1",
  skipHealthCheck: true,
  persist,
});
const calls = [];
let replay;
// Intentionally replace only the native connection seam, never resumeSession itself.
sdk.getLiveConnection = async () => ({
  connectionId: "connection-new",
  hasBoundSession: () => true,
  createRemoteSession: async (_id, init) => {
    calls.push({ method: "session/new", init });
    return { sessionId: "native-recreated" };
  },
  bindSession: () => {},
  queueReplay: (_id, text) => {
    replay = text;
  },
});
try {
  await sdk.resumeSession("product");
  assert.deepEqual(
    calls.map((c) => c.method),
    ["session/new"],
  );
  assert.equal(
    (await persist.getSession("product")).agentSessionId,
    "native-recreated",
  );
  assert.match(replay, /Previous session history is replayed below/);
  assert.match(replay, /CEDAR/);
  calls.length = 0;
  replay = undefined;
  await sdk.resumeSession("product");
  assert.equal(calls.length, 0);
  assert.equal(replay, undefined);
  console.log(
    "Rivet 0.5.2 SDK recovery gate: live binding reused; stale connection creates a different native session and queues history replay.",
  );
  console.log(
    "Native continuation gate: NOT SATISFIED. Retain native adapters; do not claim daemon/sandbox integration from this SDK seam test.",
  );
} finally {
  await sdk.dispose();
}
