import assert from "node:assert/strict";
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
    "./open-grove-agent-host-0.1.0-alpha.1.tgz",
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
    `import { CodexAgent } from '@open-grove/agent-host/codex';\nimport { FileBindingStore } from '@open-grove/agent-host';\nconst agent = new CodexAgent({ bindings: new FileBindingStore('state') });\nfor await (const e of agent.run({ sessionId: 's', cwd: '.', input: 'hi', instructions: '' })) console.log(e.type);\nawait agent.close();\n`,
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
