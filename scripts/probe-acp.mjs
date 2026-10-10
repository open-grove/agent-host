import assert from "node:assert/strict";
import { mkdir, mkdtemp, cp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";

import { AcpAgent } from "../dist/acp/index.js";

const kernel = process.argv[2];
if (
  !["opencode", "kimi", "claude", "pi", "hermes", "openclaw"].includes(kernel)
)
  throw new Error(
    "Usage: node scripts/probe-acp.mjs opencode|kimi|claude|pi|hermes|openclaw",
  );
const consumer = await mkdtemp(join(tmpdir(), "agent-host-native-editor-"));
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
const command =
  process.env.AGENT_HOST_COMMAND ??
  (kernel === "claude" ? undefined : resolve(`node_modules/.bin/${kernel}`));
const directory = resolve(`.local/${kernel}-probe-${Date.now()}`);
await mkdir(directory, { recursive: true });
if (!["claude", "pi", "hermes", "openclaw"].includes(kernel)) {
  const preflight = new AcpAgent({
    command,
    cwd: directory,
    elicitation: { form: {} },
  });
  try {
    const client = await preflight.connect();
    console.log(
      JSON.stringify({
        kernel,
        capabilities: preflight.getCapabilities(client),
      }),
    );
  } finally {
    await preflight.close();
  }
}
let allow = false;
let calls = 0;
let questions = 0;
const piOptions =
  kernel === "pi"
    ? {
        model: {
          id: process.env.AGENT_HOST_PI_MODEL ?? "DeepSeek-V4-Pro",
          name: "Native provider probe",
          provider: process.env.AGENT_HOST_PI_PROVIDER ?? "openai",
          api: process.env.AGENT_HOST_PI_API ?? "openai-completions",
          baseUrl:
            process.env.AGENT_HOST_PI_BASE_URL ??
            "https://ark.cn-beijing.volces.com/api/coding/v3",
          reasoning: false,
          input: ["text"],
          contextWindow: 128000,
          maxTokens: 4096,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      }
    : {};
const options = {
  directory,
  adapterOptions:
    kernel === "openclaw"
      ? {
          url: process.env.AGENT_HOST_OPENCLAW_URL,
          token: process.env.AGENT_HOST_OPENCLAW_TOKEN,
        }
      : kernel === "pi"
        ? piOptions
        : kernel === "claude" &&
            process.env.AGENT_HOST_CLAUDE_LOCAL_PROVIDER === "1"
          ? { native: { settingSources: ["local"] } }
          : {},
  kernel,
  command,
  args: process.env.AGENT_HOST_ARGS
    ? JSON.parse(process.env.AGENT_HOST_ARGS)
    : undefined,
  env:
    kernel === "hermes"
      ? { ...process.env, HERMES_HOME: process.env.AGENT_HOST_HERMES_HOME }
      : undefined,
  ask: async (items) => {
    questions++;
    return Object.fromEntries(
      items.map((question) => [question.id, { answers: ["Maple"] }]),
    );
  },
  model: process.env.AGENT_HOST_MODEL,
  approve: async (request) => {
    if (request.title === "Replace document.txt") {
      calls++;
      return allow;
    }
    return JSON.stringify(request.params?.toolCall ?? {}).includes(
      "edit_document",
    );
  },
};
let editor = await createEditor(options);
const run = async (input) => {
  const events = await Array.fromAsync(
    editor.run(input, { signal: AbortSignal.timeout(120_000) }),
  );
  const outcome = events.at(-1)?.outcome;
  assert.equal(outcome?.status, "completed", JSON.stringify(outcome));
  if (process.env.AGENT_HOST_PROBE_DEBUG === "1")
    console.log(
      events.filter((event) =>
        ["model.response", "tool.started", "tool.finished"].includes(
          event.type,
        ),
      ),
    );
  return events;
};
try {
  const before = await editor.read();
  await run(
    'Call edit_document exactly once with text "CEDAR native ACP probe". Respect the returned approval decision; do not retry a rejected edit.',
  );
  assert.equal(calls, 1, "Product tool must be invoked once");
  assert.equal(await editor.read(), before);
  allow = true;
  const approved = await run(
    'I now approve. Call edit_document exactly once with text "CEDAR native ACP probe".',
  );
  assert.equal(calls, 2);
  assert.equal(await editor.read(), "CEDAR native ACP probe");
  console.log(
    JSON.stringify({
      kernel,
      configuration: approved
        .find((event) => event.type === "session.bound")
        .configuration?.map(({ id, currentValue }) => ({ id, currentValue })),
    }),
  );
  const nativeId = approved.find(
    (event) => event.type === "session.bound",
  ).threadId;
  await editor.close();
  editor = await createEditor(options);
  const resumed = await run(
    "Without tools or editing, say whether my first edit request was approved or rejected.",
  );
  assert.equal(
    resumed.find((event) => event.type === "session.bound").threadId,
    nativeId,
  );
  assert.equal(
    resumed.find((event) => event.type === "session.bound").resumed,
    true,
  );
  assert.match(
    resumed.find((event) => event.type === "model.response").text,
    /reject|denied|拒绝/i,
  );
  if (kernel === "kimi") {
    const answered = await run(
      "Use your native AskUserQuestion tool to ask me exactly one multiple-choice question with options Maple and Cedar, then state my answer. Do not guess or edit the document.",
    );
    assert.equal(
      questions,
      1,
      "A native structured question must reach the product",
    );
    assert.match(
      answered.find((event) => event.type === "model.response").text,
      /Maple/,
    );
    console.log(
      "PASS kimi: native form elicitation returned the product answer in the same turn",
    );
  }
  console.log(
    `PASS ${kernel}: native product tool, rejected/approved edits, native restart continuation`,
  );
} finally {
  await editor.close();
}
