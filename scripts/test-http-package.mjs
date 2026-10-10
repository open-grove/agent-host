import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Tests only the installed package and copied product, never repository-relative runtime imports. */
export async function testHttpPackage(consumer, { native = false } = {}) {
  const installed = join(consumer, "node_modules/@open-grove/agent-host");
  const { AgentHostClient } = await import(
    pathToFileURL(join(installed, "dist/service/client.js"))
  );
  const example = join(consumer, "http-editor");
  await cp(join(installed, "examples/http-editor"), example, {
    recursive: true,
  });
  const { startEditor } = await import(
    pathToFileURL(join(example, "server.mjs"))
  );
  const label = native ? `native-http-${Date.now()}` : "http";
  const directory = join(consumer, `${label}-workspace`);
  const stateDirectory = join(consumer, `${label}-state`);
  await mkdir(directory, { recursive: true });
  const config = join(consumer, native ? "native-http.json" : "http.json");
  await writeFile(
    config,
    JSON.stringify({
      stateDirectory,
      port: 0,
      runtimes: [
        {
          id: "codex",
          kernel: "codex",
          cwd: directory,
          command: native
            ? (process.env.AGENT_HOST_CODEX ??
              resolve("node_modules/.bin/codex"))
            : process.execPath,
          ...(native
            ? {}
            : { args: [resolve("test/fixtures/codex-server.mjs")] }),
          thread: { sandbox: "read-only", approvalPolicy: "on-request" },
        },
      ],
    }),
  );
  let child, exited, client, token;
  async function launch() {
    child = spawn(
      process.execPath,
      [join(installed, "dist/service/cli.js"), "serve", "--config", config],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, AGENT_HOST_TOKEN: "" },
      },
    );
    exited = new Promise((resolve) => child.once("exit", resolve));
    let output = "",
      errors = "";
    child.stderr.on("data", (bytes) => {
      errors += bytes;
    });
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Host startup timeout: ${errors}`)),
        15_000,
      );
      child.stdout.on("data", (bytes) => {
        output += bytes;
        const match = output.match(/listening at (http:\/\/\S+)/);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error(`Host exited: ${errors}`));
      });
    });
    token = (await readFile(join(stateDirectory, "token"), "utf8")).trim();
    client = await new AgentHostClient({ baseUrl: url, token }).connect();
    return url;
  }
  let editor;
  try {
    let hostUrl = await launch();
    editor = await startEditor({ hostUrl, token, directory, port: 0 });
    const product = async (path, value, expected = 200) => {
      const response = await fetch(`${editor.url}/product/${path}`, {
        headers: { "x-editor-client": "1", "content-type": "application/json" },
        ...(value ? { method: "POST", body: JSON.stringify(value) } : {}),
      });
      const data = await response.json();
      assert.equal(response.status, expected, JSON.stringify(data));
      return data;
    };
    assert.equal((await fetch(`${editor.url}/product/document`)).status, 403);
    assert.equal(
      (
        await fetch(`${editor.url}/product/document`, {
          headers: {
            "x-editor-client": "1",
            origin: "https://untrusted.example",
          },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${editor.url}/host/v1/settings`, {
          headers: { "x-editor-client": "1" },
        })
      ).status,
      404,
    );
    assert.ok(
      !(await (await fetch(`${editor.url}/client.js`)).text()).includes(token),
    );
    let project = await product("document");
    let allow = false,
      count = 0,
      lastCall;
    const tools = [
      {
        name: "edit_document",
        description: "Replace the product document after user approval.",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
        async execute(input, context) {
          count++;
          if (!allow)
            return {
              success: false,
              contentItems: [
                {
                  type: "inputText",
                  text: "User rejected this attempt. Keep the document; do not retry in this turn.",
                },
              ],
            };
          lastCall = {
            runId: context.runId,
            callId: context.callId,
            text: input.text,
          };
          return product("apply", lastCall);
        },
      },
    ];
    const session = () =>
      client.session({
        sessionId: project.sessionId,
        runtimeId: "codex",
        tools,
        instructions:
          "Use edit_document for all changes. The product owns approval and data. Never use native file tools or shell to modify the document. Respect each approval decision. Do not retry in the same turn after rejection. A later explicit user request may propose a new edit and ask for approval again. Answer concisely.",
      });
    const wait = async (task) => {
      const events = [];
      const result = await task.wait({
        signal: AbortSignal.timeout(native ? 120_000 : 5_000),
        pollMs: 20,
        onEvent: ({ event }) => events.push(event),
        onRequest: async () => ({ decision: "decline" }),
      });
      assert.equal(result.status, "completed", JSON.stringify(result.outcome));
      return { result, events };
    };
    await wait(
      await session().run(
        native
          ? 'Call edit_document exactly once with text "Edited through standalone HTTP". Respect the approval result.'
          : "tool",
      ),
    );
    assert.equal(count, 1);
    assert.equal((await product("document")).text, project.text);
    allow = true;
    const approved = await wait(
      await session().run(
        native
          ? 'I now approve. Call edit_document exactly once with text "Edited through standalone HTTP".'
          : "duplicate-tool",
      ),
    );
    assert.equal(count, 2);
    project = await product("document");
    assert.equal(
      project.text,
      native ? "Edited through standalone HTTP" : "Updated by Agent",
    );
    const receipt = await product("apply", lastCall);
    assert.equal(receipt.success, true);
    await product("apply", { ...lastCall, text: "Conflicting retry" }, 400);
    const threadId = approved.events.find(
      (event) => event.type === "session.bound",
    ).threadId;
    await editor.close();
    editor = undefined;
    child.kill("SIGTERM");
    await exited;
    hostUrl = await launch();
    assert.deepEqual(await client.result(approved.result.id), approved.result);
    editor = await startEditor({ hostUrl, token, directory, port: 0 });
    assert.equal((await product("document")).text, project.text);
    const resumed = await wait(
      await session().run(
        native
          ? "Without using tools, tell me whether my first edit attempt was approved or rejected."
          : "hello",
      ),
    );
    const binding = resumed.events.find(
      (event) => event.type === "session.bound",
    );
    assert.equal(binding.threadId, threadId);
    assert.equal(binding.resumed, true);
    if (native) assert.match(resumed.result.answer, /reject|denied|拒绝/i);
    console.log(
      `PASS installed HTTP CLI + independent browser product: approve/reject, durable business receipts, Host restart and native continuation (${native ? "native Codex" : "protocol fixture"})`,
    );
  } finally {
    await editor?.close();
    if (child) {
      child.kill("SIGTERM");
      await exited;
    }
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (!process.argv[2])
    throw new Error(
      "Usage: node scripts/test-http-package.mjs <installed-consumer> [--native]",
    );
  await testHttpPackage(resolve(process.argv[2]), {
    native: process.argv.includes("--native"),
  });
}
