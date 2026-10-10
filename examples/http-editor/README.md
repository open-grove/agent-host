# Browser editor using an independent Agent Host

This example has two separate processes: the Agent Host service and a small product companion serving the editor. The browser never receives the Host token. The product owns its document, user confirmation and durable operation receipts.

From the repository root:

```sh
npm ci
npm pack
cd examples/http-editor
npm install
mkdir -p editor-project
npx --no-install agent-host serve --config host.example.json
```

Keep the service running. In another terminal, from `examples/http-editor`:

```sh
npm start
```

Open the address printed by the product companion (normally `http://127.0.0.1:37430`). Select a runtime, request an edit and approve or reject its proposed text. Refresh while waiting to reconnect to the same task. Completed output and the document remain readable after restarting both processes.

The default profile uses an installed and authenticated `codex` with a native read-only sandbox. Set `command` in `host.example.json` if it is not on PATH. Other profiles use the same service and product tool contract; see [runtime configuration](../../docs/http-service.md#runtime-profiles). The example's native approval/question UI covers only the forms implemented in `app.js`.

For a separately installed archive, copy this example from `node_modules/@open-grove/agent-host/examples/http-editor` into your project and use your installed package. The repository example's package manifest points to the archive at the repository root.

Companion settings:

- `AGENT_HOST_URL`: service address.
- `AGENT_HOST_TOKEN` or `AGENT_HOST_TOKEN_FILE`: server-side authentication; defaults to `.local/host/token`.
- `EDITOR_DIRECTORY`: product state directory; defaults to `editor-project`.
- `EDITOR_PORT`: browser companion port; defaults to `37430`.

The companion validates origin and a custom request header, limits proxied routes, verifies each edit against its active Host call, and stores the `callId` receipt in the same atomic file replacement as the document. This protects the example against repeating a saved edit after browser refresh. The Agent's own filesystem permissions remain a separate native setting.

The product is a single-user integration example, not a multi-tenant web gateway. The service [documents its restart and delivery boundaries](../../docs/http-service.md#disconnects-restart-and-duplicate-operations).
