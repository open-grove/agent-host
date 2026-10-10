import assert from "node:assert/strict";
import { testHttpPackage } from "./test-http-package.mjs";
import { model, fixture as piStream } from "../test/fixtures/pi-stream.mjs";
import { startOpenClawFixture } from "../test/fixtures/openclaw-gateway.mjs";
import { createClaudeQueryFixture } from "../test/fixtures/claude-query.mjs";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

const root = process.cwd();
const consumer = await mkdtemp(join(tmpdir(), "agent-host-consumer-"));
await mkdir(resolve(".local"), { recursive: true });
execFileSync("npm", ["pack", "--pack-destination", consumer, "--silent"], {
  stdio: "pipe",
});
await cp("examples/file-editor", consumer, { recursive: true });
await writeFile(
  join(consumer, "package.json"),
  JSON.stringify({ private: true, type: "module" }),
);
execFileSync(
  "npm",
  [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "./open-grove-agent-host-0.1.0-alpha.3.tgz",
  ],
  { cwd: consumer, stdio: "pipe" },
);
const { createEditor } = await import(
  pathToFileURL(join(consumer, "editor.mjs"))
);
const fixture = resolve("test/fixtures/codex-server.mjs");
const directory = join(consumer, "document-workspace");
let approves = 0;
let editor = await createEditor({
  directory,
  command: fixture,
  args: [],
  approve: async () => {
    approves++;
    return true;
  },
});
try {
  const edited = await Array.fromAsync(editor.run("duplicate-tool"));
  assert.equal(edited.at(-1).outcome.status, "completed");
  assert.equal(await editor.read(), "Updated by Agent");
  assert.equal(approves, 1);
  const nativeId = edited.find((e) => e.type === "session.bound").threadId;
  await editor.close();
  editor = await createEditor({
    directory,
    command: fixture,
    args: [],
    approve: async () => false,
  });
  const rejected = await Array.fromAsync(editor.run("tool"));
  assert.equal(
    rejected.find((e) => e.type === "session.bound").threadId,
    nativeId,
  );
  assert.equal(rejected.find((e) => e.type === "session.bound").resumed, true);
  assert.equal(
    rejected.find((e) => e.type === "tool.finished").result.success,
    false,
  );
  assert.equal(await editor.read(), "Updated by Agent");
  const controller = new AbortController();
  await editor.close();
  editor = await createEditor({
    directory,
    command: fixture,
    args: [],
    approve: async (_request, signal) => {
      controller.abort();
      return new Promise((resolve) =>
        signal.addEventListener("abort", () => resolve(false), { once: true }),
      );
    },
  });
  const cancelled = await Array.fromAsync(
    editor.run("tool", { signal: controller.signal }),
  );
  assert.equal(cancelled.at(-1).outcome.status, "cancelled");
  assert.equal(await editor.read(), "Updated by Agent");
  // Check the installed declarations, not repository-relative imports.
  await writeFile(
    join(consumer, "consumer.ts"),
    `import { AcpAgent } from '@open-grove/agent-host/acp';\nimport { ClaudeAgent, ClaudeQueryHost } from '@open-grove/agent-host/claude';\nimport { PiAgent } from '@open-grove/agent-host/pi';\nimport { HermesAgent } from '@open-grove/agent-host/hermes';\nimport { OpenClawAgent } from '@open-grove/agent-host/openclaw';\nconst adapters = [AcpAgent, ClaudeAgent, ClaudeQueryHost, PiAgent, HermesAgent, OpenClawAgent];\nimport { CodexAgent } from '@open-grove/agent-host/codex';\nimport { FileBindingStore } from '@open-grove/agent-host';\nconst agent = new CodexAgent({ bindings: new FileBindingStore('state') });\nfor await (const e of agent.run({ sessionId: 's', cwd: '.', input: 'hi', instructions: '' })) console.log(e.type);\nawait agent.close();\n`,
  );
  await writeFile(
    join(consumer, "http-consumer.ts"),
    `import { createNativeRuntime, startAgentHostServer } from '@open-grove/agent-host/server';
import { AgentHostClient } from '@open-grove/agent-host/client';
const runtime = createNativeRuntime({ id: 'codex', kernel: 'codex', cwd: '.' }, 'state');
const server = await startAgentHostServer({ runtimes: [runtime], stateDirectory: 'state', token: 'example-owner-token' });
const client = await new AgentHostClient({ baseUrl: server.url, token: 'example-owner-token' }).connect();
const task = await client.session({ sessionId: 's', runtimeId: 'codex', tools: [{ name: 'edit', description: 'Edit', inputSchema: {}, async execute(input, context) { context.signal.throwIfAborted(); return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(input) }] }; } }] }).run('hi');
await task.wait({ onRequest: async () => ({ decision: 'decline' }) });
await server.close();
`,
  );
  execFileSync(
    process.execPath,
    [
      join(root, "node_modules/typescript/bin/tsc"),
      "--strict",
      "--noEmit",
      "--skipLibCheck",
      "--module",
      "NodeNext",
      "--target",
      "ES2022",
      "--typeRoots",
      join(root, "node_modules/@types"),
      "consumer.ts",
      "http-consumer.ts",
    ],
    { cwd: consumer, stdio: "pipe" },
  );
  assert.match(
    await readFile(
      join(consumer, "node_modules/@open-grove/agent-host/NOTICE"),
      "utf8",
    ),
    /OpenGrove/,
  );
  console.log(
    "PASS archive install, independent editor, approve/reject/cancel, native binding restart, TypeScript consumer",
  );
  console.log(`Consumer retained at ${consumer}`);
} finally {
  await editor.close();
}

// A second protocol uses the very same installed editor and product tool.
for (const kernel of ["opencode", "kimi"]) {
  const directory = join(consumer, `${kernel}-workspace`);
  const command = resolve("test/fixtures/acp-server.mjs");
  let editor = await createEditor({
    directory,
    kernel,
    command,
    args: [],
    approve: async () => true,
  });
  try {
    const approved = await Array.fromAsync(editor.run("tool"));
    assert.equal(approved.at(-1).outcome.status, "completed");
    assert.equal(await editor.read(), "Saved via ACP");
    const nativeId = approved.find(
      (event) => event.type === "session.bound",
    ).threadId;
    await editor.close();
    editor = await createEditor({
      directory,
      kernel,
      command,
      args: [],
      approve: async () => false,
    });
    const rejected = await Array.fromAsync(editor.run("tool"));
    assert.equal(
      rejected.find((event) => event.type === "session.bound").threadId,
      nativeId,
    );
    assert.equal(
      rejected.find((event) => event.type === "tool.finished").result.success,
      false,
    );
    assert.equal(await editor.read(), "Saved via ACP");
    const controller = new AbortController();
    let outcome;
    for await (const event of editor.run("wait", {
      signal: controller.signal,
    })) {
      if (event.type === "assistant.delta") controller.abort();
      if (event.type === "turn.finished") outcome = event.outcome;
    }
    assert.equal(outcome.status, "cancelled");
    console.log(
      `PASS installed ${kernel} editor: MCP, approve/reject, cancellation and restart (protocol fixture)`,
    );
  } finally {
    await editor.close();
  }
}

{
  const directory = join(consumer, "claude-workspace");
  const query = createClaudeQueryFixture();
  let editor = await createEditor({
    directory,
    kernel: "claude",
    adapterOptions: { query },
    approve: async () => true,
  });
  try {
    const approved = await Array.fromAsync(editor.run("fixture tool"));
    assert.equal(approved.at(-1).outcome.status, "completed");
    assert.equal(await editor.read(), "Saved via Claude");
    const threadId = approved.find(
      (event) => event.type === "session.bound",
    ).threadId;
    await editor.close();
    editor = await createEditor({
      directory,
      kernel: "claude",
      adapterOptions: { query },
      approve: async () => false,
    });
    const rejected = await Array.fromAsync(editor.run("fixture tool"));
    assert.equal(
      rejected.find((event) => event.type === "session.bound").threadId,
      threadId,
    );
    assert.equal(
      rejected.find((event) => event.type === "tool.finished").result.success,
      false,
    );
    assert.equal(await editor.read(), "Saved via Claude");
    console.log(
      "PASS installed Claude editor: SDK MCP approve/reject and native binding restart (SDK seam fixture)",
    );
  } finally {
    await editor.close();
  }
}

// Hermes uses the same product, through its native Gateway/MCP contract fixture.
{
  const directory = join(consumer, "hermes-workspace");
  const options = {
    directory,
    kernel: "hermes",
    command: process.execPath,
    args: [resolve("test/fixtures/hermes-gateway.mjs")],
    env: { ...process.env, HERMES_HOME: join(directory, "native-home") },
  };
  let editor = await createEditor({ ...options, approve: async () => true });
  try {
    const approved = await Array.fromAsync(editor.run("CALL_TOOL"));
    assert.equal(
      approved.at(-1).outcome.status,
      "completed",
      JSON.stringify(approved.at(-1)),
    );
    assert.equal(await editor.read(), "Shared Hermes editor");
    const threadId = approved.find((e) => e.type === "session.bound").threadId;
    await editor.close();
    editor = await createEditor({ ...options, approve: async () => false });
    const rejected = await Array.fromAsync(editor.run("CALL_TOOL"));
    assert.equal(
      rejected.at(-1).outcome.status,
      "completed",
      JSON.stringify(rejected.at(-1)),
    );
    assert.equal(
      rejected.find((e) => e.type === "session.bound").threadId,
      threadId,
    );
    assert.equal(
      rejected.find((e) => e.type === "tool.finished").result.success,
      false,
    );
    assert.equal(await editor.read(), "Shared Hermes editor");
    console.log(
      "PASS installed Hermes editor: product MCP approve/reject and stored native ID restart (Gateway fixture)",
    );
  } finally {
    await editor.close();
  }
}

// The current Pi loop and persistence are native; only provider output is deterministic.
for (const kernel of ["pi", "openclaw"]) {
  const gateway =
    kernel === "openclaw" ? await startOpenClawFixture() : undefined;
  const observed = [];
  const options = {
    directory: join(consumer, `${kernel}-workspace`),
    kernel,
    adapterOptions: gateway ?? {
      model,
      streamFn: piStream(observed, "edit_document"),
    },
  };
  let editor = await createEditor({ ...options, approve: async () => true });
  try {
    const first = await Array.fromAsync(
      editor.run(kernel === "pi" ? "call edit" : "TOOL"),
    );
    assert.equal(
      first.at(-1).outcome.status,
      "completed",
      JSON.stringify(first.at(-1)),
    );
    const expected = kernel === "pi" ? "CEDAR" : "Saved via OpenClaw";
    assert.equal(await editor.read(), expected);
    const thread = first.find((e) => e.type === "session.bound").threadId;
    await editor.close();
    editor = await createEditor({ ...options, approve: async () => false });
    const denied = await Array.fromAsync(
      editor.run(kernel === "pi" ? "call edit" : "TOOL"),
    );
    assert.equal(
      denied.at(-1).outcome.status,
      "completed",
      JSON.stringify(denied.at(-1)),
    );
    assert.equal(
      denied.find((e) => e.type === "session.bound").threadId,
      thread,
    );
    assert.equal(
      denied.find((e) => e.type === "tool.finished").result.success,
      false,
    );
    assert.equal(await editor.read(), expected);
    console.log(
      `PASS installed ${kernel} editor: approve/reject and native binding restart (provider/protocol fixture)`,
    );
  } finally {
    await editor.close();
    await gateway?.close();
  }
}
const installed = join(consumer, "node_modules/@open-grove/agent-host");
await testHttpPackage(consumer);
await writeFile(
  resolve(".local/last-package-consumer.json"),
  JSON.stringify({ consumer }),
);
if (process.env.AGENT_HOST_HTTP_NATIVE === "1")
  await testHttpPackage(consumer, { native: true });
assert.equal(
  JSON.parse(
    await readFile(
      join(installed, "plugins/openclaw/openclaw.plugin.json"),
      "utf8",
    ),
  ).contracts.tools[0],
  "agent_host_call",
);
assert.equal(
  (await import(pathToFileURL(join(installed, "plugins/openclaw/index.js"))))
    .default.id,
  "agent-host",
);

if (process.env.AGENT_HOST_NATIVE_PROBE === "1") {
  const command =
    process.env.AGENT_HOST_CODEX ?? join(root, "node_modules/.bin/codex");
  const directory = join(consumer, "native-editor-workspace");
  let requests = 0;
  let allow = false;
  let native = await createEditor({
    directory,
    command,
    approve: async () => {
      requests++;
      return allow;
    },
  });
  const original = await native.read();
  const run = async (input) => {
    const events = await Array.fromAsync(
      native.run(input, { signal: AbortSignal.timeout(120_000) }),
    );
    assert.equal(
      events.at(-1).outcome.status,
      "completed",
      JSON.stringify(events.at(-1)),
    );
    return events;
  };
  try {
    await run(
      'Call edit_document once with text "Edited through the standalone product". Respect the returned approval decision; do not retry a rejected edit.',
    );
    assert.equal(requests, 1);
    assert.equal(await native.read(), original);
    allow = true;
    const approved = await run(
      'I now approve. Call edit_document exactly once with text "Edited through the standalone product".',
    );
    assert.equal(requests, 2);
    assert.equal(await native.read(), "Edited through the standalone product");
    const thread = approved.find((e) => e.type === "session.bound").threadId;
    await native.close();
    native = await createEditor({
      directory,
      command,
      approve: async () => false,
    });
    const resumed = await run(
      "Without editing, tell me whether my first edit attempt was approved or rejected.",
    );
    assert.equal(
      resumed.find((e) => e.type === "session.bound").threadId,
      thread,
    );
    assert.equal(resumed.find((e) => e.type === "session.bound").resumed, true);
    assert.match(
      resumed.find((e) => e.type === "model.response").text,
      /reject|denied|拒绝/i,
    );
    console.log(
      "PASS native Codex through installed editor: rejected edit stays unchanged, approved edit saves, restart resumes",
    );
  } finally {
    await native.close();
  }
}
