// Adapted from OpenGrove PR #126's external editor (Apache-2.0).
import { createServer } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AgentHostClient } from "@open-grove/agent-host/client";

export async function startEditor({
  hostUrl = "http://127.0.0.1:37420",
  token,
  directory = resolve("editor-project"),
  port = 37430,
} = {}) {
  if (!token)
    throw new Error(
      "Host token required by the companion, never by the browser",
    );
  const upstream = new URL(hostUrl);
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(upstream.hostname) ||
    upstream.protocol !== "http:"
  )
    throw new Error("This example connects only to a local Host");
  const client = await new AgentHostClient({
    baseUrl: hostUrl,
    token,
  }).connect();
  await mkdir(directory, { recursive: true });
  const projectFile = join(directory, "project.json");
  try {
    await writeFile(
      projectFile,
      JSON.stringify({
        sessionId: `editor-${randomUUID()}`,
        text: "An example document.\n",
        receipts: {},
      }),
      { flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const readProject = async () =>
    JSON.parse(await readFile(projectFile, "utf8"));
  let mutation = Promise.resolve();
  let origin;
  const server = createServer((request, response) => {
    const reply = (status, body) => {
      response.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify(body));
    };
    void (async () => {
      if (
        request.headers.host !== new URL(origin).host ||
        (request.headers.origin && request.headers.origin !== origin)
      )
        return reply(403, { error: "origin_not_allowed" });
      const url = new URL(request.url, origin);
      if (
        url.pathname.startsWith("/host/") ||
        url.pathname.startsWith("/product/")
      )
        if (request.headers["x-editor-client"] !== "1")
          return reply(403, { error: "editor_header_required" });
      if (url.pathname === "/product/document" && request.method === "GET") {
        const { receipts: _receipts, ...project } = await readProject();
        return reply(200, project);
      }
      if (url.pathname === "/product/apply" && request.method === "POST") {
        const { runId, callId, text } = JSON.parse(await body(request));
        if (
          typeof runId !== "string" ||
          typeof callId !== "string" ||
          typeof text !== "string" ||
          text.length > 100_000
        )
          return reply(400, { error: "invalid_edit" });
        const digest = createHash("sha256").update(text).digest("hex");
        const operation = mutation.then(async () => {
          const project = await readProject();
          const receipt = project.receipts[callId];
          if (receipt) {
            if (receipt.runId !== runId || receipt.digest !== digest)
              throw new Error("receipt_conflict");
            return receipt.result;
          }
          const run = await client.result(runId);
          if (run.status !== "running" || run.sessionId !== project.sessionId)
            throw new Error("task_not_active");
          const call = (await client.calls(runId)).find(
            (call) => call.id === callId,
          );
          if (
            !call ||
            call.status !== "pending" ||
            call.kind !== "tool" ||
            call.name !== "edit_document" ||
            call.input.text !== text ||
            Date.parse(call.deadlineAt) <= Date.now()
          )
            throw new Error("call_not_pending");
          project.text = text;
          const result = {
            success: true,
            contentItems: [
              { type: "inputText", text: "Document saved by the product." },
            ],
          };
          project.receipts[callId] = { runId, digest, result };
          const temporary = `${projectFile}.${randomUUID()}.tmp`;
          await writeFile(temporary, JSON.stringify(project, null, 2), {
            mode: 0o600,
          });
          await rename(temporary, projectFile);
          return result;
        });
        mutation = operation.catch(() => {}); // Only releases the queue; the caller receives the failure below.
        return reply(200, await operation);
      }
      if (url.pathname.startsWith("/host/v1/")) {
        const path = url.pathname.slice("/host".length);
        if (
          !/^\/v1\/(health|runtimes|sessions|runs(?:\/[^/]+(?:\/(?:events|cancel|steer|calls(?:\/[^/]+\/result)?))?)?)$/.test(
            path,
          ) ||
          !["GET", "POST"].includes(request.method)
        )
          return reply(404, { error: "route_not_found" });
        const result = await fetch(new URL(path + url.search, upstream), {
          method: request.method,
          redirect: "error",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          ...(request.method === "POST" ? { body: await body(request) } : {}),
        });
        response.writeHead(result.status, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        response.end(await result.text());
        return;
      }
      if (request.method !== "GET")
        return reply(405, { error: "method_not_allowed" });
      const assets = {
        "/": [new URL("./index.html", import.meta.url), "text/html"],
        "/app.js": [new URL("./app.js", import.meta.url), "text/javascript"],
        "/client.js": [
          new URL(import.meta.resolve("@open-grove/agent-host/client")),
          "text/javascript",
        ],
      };
      const asset = assets[url.pathname];
      if (!asset) return reply(404, { error: "not_found" });
      response.writeHead(200, {
        "content-type": asset[1],
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy":
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
      });
      response.end(await readFile(asset[0]));
    })().catch((error) => {
      if (!response.headersSent) reply(400, { error: error.message });
      else response.destroy();
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    url: origin,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
async function body(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const token =
    process.env.AGENT_HOST_TOKEN ??
    (
      await readFile(
        resolve(process.env.AGENT_HOST_TOKEN_FILE ?? ".local/host/token"),
        "utf8",
      )
    ).trim();
  const editor = await startEditor({
    token,
    hostUrl: process.env.AGENT_HOST_URL,
    directory: process.env.EDITOR_DIRECTORY,
    port: process.env.EDITOR_PORT ? Number(process.env.EDITOR_PORT) : undefined,
  });
  console.log(`Editor: ${editor.url}`);
  process.once("SIGINT", () => void editor.close());
  process.once("SIGTERM", () => void editor.close());
}
