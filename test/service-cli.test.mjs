import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentHostClient } from "../dist/service/client.js";
import {
  createNativeRuntime,
  startAgentHostServer,
} from "../dist/service/index.js";

test("CLI crash recovery preserves results, terminates pending calls as unknown, and excludes concurrent owners", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agent-host-cli-"));
  const stateDirectory = join(root, "state");
  const config = join(root, "host.json");
  await writeFile(
    config,
    JSON.stringify({
      stateDirectory,
      port: 0,
      runtimes: [
        {
          id: "codex",
          kernel: "codex",
          cwd: root,
          command: process.execPath,
          args: [resolve("test/fixtures/codex-server.mjs")],
        },
      ],
    }),
  );
  let processState;
  async function start() {
    const child = spawn(
      process.execPath,
      [resolve("dist/service/cli.js"), "serve", "--config", config],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, AGENT_HOST_TOKEN: "" },
      },
    );
    const exited = new Promise((resolve) => child.once("exit", resolve));
    processState = { child, exited };
    let output = "",
      error = "";
    child.stderr.on("data", (bytes) => {
      error += bytes;
    });
    const url = await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`CLI startup timed out: ${error}`)),
        8_000,
      );
      child.stdout.on("data", (bytes) => {
        output += bytes;
        const found = output.match(/listening at (http:\/\/\S+)/);
        if (found) {
          clearTimeout(timeout);
          resolve(found[1]);
        }
      });
      child.once("exit", () => {
        clearTimeout(timeout);
        reject(new Error(`CLI exited before listening: ${error}`));
      });
    });
    const token = (
      await readFile(join(stateDirectory, "token"), "utf8")
    ).trim();
    assert.ok(!output.includes(token));
    return new AgentHostClient({ baseUrl: url, token }).connect();
  }
  t.after(async () => {
    if (processState) {
      processState.child.kill();
      await processState.exited;
    }
    await rm(root, { recursive: true, force: true });
  });
  let client = await start();
  const complete = await client
    .session({ sessionId: "complete", runtimeId: "codex" })
    .run("hello");
  const first = await complete.wait({ pollMs: 20 });
  const task = await client
    .session({
      sessionId: "pending",
      runtimeId: "codex",
      tools: [{ name: "edit_document", description: "Edit", inputSchema: {} }],
    })
    .run("tool");
  let calls = [];
  for (let n = 0; n < 200 && !calls.length; n++) {
    calls = await client.calls(task.runId);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(calls.length, 1);
  const runtime = createNativeRuntime(
    { id: "other", kernel: "codex", cwd: root },
    stateDirectory,
  );
  await assert.rejects(
    startAgentHostServer({
      runtimes: [runtime],
      stateDirectory,
      token: "another-owner-token",
    }),
    /locked/,
  );
  await runtime.close();
  processState.child.kill("SIGKILL");
  await processState.exited;
  client = await start();
  assert.deepEqual(await client.result(complete.runId), first);
  const interrupted = await client.result(task.runId);
  assert.equal(interrupted.status, "failed");
  assert.equal(interrupted.outcome.error, "host_restarted");
  assert.equal(interrupted.outcome.outcomeUnknown, true);
  assert.equal((await client.calls(task.runId))[0].status, "cancelled");
  await assert.rejects(
    client.resolveCall(task.runId, calls[0].id, {
      success: true,
      contentItems: [],
    }),
    /call_not_pending/,
  );
  assert.equal(
    (await client.runs("pending")).length,
    1,
    "restart must not create a replacement run",
  );
});
