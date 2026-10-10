# Standalone HTTP service

Agent Host has two entry points over the same native adapters:

- **Embedded:** import an adapter in a product's Node backend. The product supplies its own lifecycle and storage.
- **Service:** run `agent-host serve`. Products connect over HTTP, while the service owns task records, native bindings and pending interactions. No OpenGrove installation, account or database is needed.

The service and browser client port the reusable integration from [OpenGrove PR #126](https://github.com/open-grove/opengrove/pull/126). The service does not introduce another Agent loop or replay conversations.

## Start a service

Node.js 24+ is required. From this repository, build an archive with `npm pack`, then install that archive in your consumer. The current archive is `open-grove-agent-host-0.1.0-alpha.3.tgz`; it is not published to the npm registry.

Create `host.json`:

```json
{
  "stateDirectory": "./host-state",
  "port": 37420,
  "runtimes": [
    {
      "id": "local-codex",
      "kernel": "codex",
      "cwd": "./workspace",
      "thread": { "sandbox": "read-only", "approvalPolicy": "on-request" }
    }
  ]
}
```

Create the workspace directory, authenticate the native Agent, then run:

```sh
npx --no-install agent-host serve --config host.json
```

Relative paths are resolved from the configuration file. The process listens on `127.0.0.1` by default and stays running until stopped. A service manager can supervise this process. SIGINT/SIGTERM request cancellation and close native connections.

Authentication uses `AGENT_HOST_TOKEN`, or a generated private `host-state/token` file. `--token-file` selects an existing token file. Tokens are not printed. Keep service state outside product workspaces. The CLI stores no provider credentials; Agents use native login/configuration and the server's environment.

The token identifies one trusted owner with access to every configured profile, session and task. This is not multi-tenant authorization. Products with different trust boundaries need separate instances/state directories or their own authenticated gateway. Non-loopback deployment needs an appropriately protected network/TLS endpoint. Browser access requires an explicit `allowedOrigins` list; the editor below keeps the owner token in a local companion instead of distributing it to browser code.

## Runtime profiles

HTTP callers select a configured `runtimeId`. They cannot supply executables, environment variables, provider credentials, or arbitrary workspace roots. Profiles are configured by the service owner.

| Kernel             | CLI profile configuration                                                                                                                                                                                |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codex`            | Optional `command`, `args`, `env`, `model`, native `thread` and `turn` options. Defaults to `codex` and a read-only native sandbox.                                                                      |
| `claude`           | Optional `command`, `env`, `model`; otherwise uses the bundled Claude SDK engine and native authentication.                                                                                              |
| `opencode`, `kimi` | Optional `command`, `args`, `env`, `model`, `effort`; native ACP startup and login.                                                                                                                      |
| `pi`               | Required `model` in `provider/model` form, using Pi's built-in model catalog and native provider environment. Its durable storage lives under service state.                                             |
| `hermes`           | Required Gateway `command`, with `args`, optional `env`, `model`, `provider`, `effort`. Configure/authenticate the profile's persistent `HERMES_HOME`; the profile is exclusively owned by this service. |
| `openclaw`         | Required `gatewayUrl`, optional `gatewayTokenEnv` naming a server environment variable, optional `model`. Product tools require the existing [Gateway plugin](api.md#openclaw-product-tools).            |

`GET /v1/runtimes` and `POST /v1/runtimes/inspect` expose profile availability and implemented controls. Inspection checks the configured directory/executable and required model selection. It does not prove login, model access or native execution, and does not scan or install every Agent on the machine. Native request-time failures remain visible in the task outcome.

For custom Pi providers, Claude SDK settings, native discovery, or additional runtime composition, use the server package from Node:

```ts
import {
  createNativeRuntime,
  startAgentHostServer,
} from "@open-grove/agent-host/server";

const stateDirectory = "/path/to/host-state";
const runtime = createNativeRuntime(
  {
    id: "codex",
    kernel: "codex",
    cwd: "/path/to/workspace",
    options: { command: "/path/to/codex" },
  },
  stateDirectory,
);
const server = await startAgentHostServer({
  runtimes: [runtime],
  stateDirectory,
  token: process.env.AGENT_HOST_TOKEN!,
});
console.log(server.url);
// On product/service shutdown:
await server.close();
```

Programmatic profiles accept the existing adapter options. A custom `ServiceRuntime` may wrap another implementation while honoring the same turn/tool/interaction contract. Change `configurationRevision` when a programmatic callback's captured configuration changes; serialized function text alone cannot detect changed closures.

## Connect a product

`@open-grove/agent-host/client` uses standard Fetch and has no Node runtime imports. It can run in Node or a browser bundle. It neither starts a server nor discovers local credentials.

```ts
import { AgentHostClient } from "@open-grove/agent-host/client";

const host = await new AgentHostClient({
  baseUrl: "http://127.0.0.1:37420",
  token: process.env.AGENT_HOST_TOKEN,
}).connect();

const session = host.session({
  sessionId: "my-product-document-42",
  runtimeId: "local-codex",
  instructions:
    "Help edit the current document. Use edit_document for changes.",
  tools: [
    {
      name: "edit_document",
      description: "Edit the document after product authorization.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      async execute(input, context) {
        // Validate arguments and business permissions; ask the user if required.
        // Commit the change and a durable receipt keyed by context.callId together.
        // Honor context.signal and context.deadlineAt before starting an effect.
        return {
          success: true,
          contentItems: [{ type: "inputText", text: "Saved" }],
        };
      },
    },
  ],
});
const task = await session.run("Shorten the introduction.", {
  document: "Current contents...",
});
const result = await task.wait({
  onEvent: ({ event }) => {
    if (event.type === "assistant.delta") process.stdout.write(event.text);
  },
  onHistoryGap: () => {}, // Explicitly accept truncated progress; result.answer is stored separately.
  onRequest: async (request, context) => {
    // Native permissions/questions keep their original method and JSON response format.
    // This example declines a Codex command/file approval.
    if (
      [
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
      ].includes(request.method)
    )
      return { decision: "decline" };
    throw new Error(`No product handler for ${request.method}`);
  },
});
console.log(result.status, result.answer);
```

Native question and permission replies use the formats documented in [the adapter API](api.md#tools-and-interactions). The service does not treat every interaction as a yes/no prompt. A client may instead poll calls and resolve them using its own UI. The HTTP example implements a limited set of native permission/question forms; unsupported forms are declined, and it never solicits native sudo secrets.

Session runtime, stable instructions, tool definitions and server configuration are bound on the first task. A mismatch returns `409 session_configuration_conflict`. Mutable product state goes in per-turn `context`. There is one active task per session. Hermes additionally permits one active task per profile. Native sessions and transcript storage stay with the selected adapter/Kernel.

## HTTP operations

Every operation requires `Authorization: Bearer <token>` and JSON bodies for POST.

| Operation                                       | Meaning                                                                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `GET /v1/health`                                | Service protocol version (`1`).                                                                                                |
| `GET /v1/runtimes`                              | Configured profiles and control availability.                                                                                  |
| `POST /v1/runtimes/inspect`                     | Check `{ runtimeId }` without running an Agent.                                                                                |
| `POST /v1/runs`                                 | Submit `{ sessionId, runtimeId, instructions?, input, context?, tools?, mode?, timeoutMs? }`; returns `202` with a run record. |
| `GET /v1/sessions`                              | Session configurations.                                                                                                        |
| `GET /v1/runs?sessionId=...`                    | Run records, newest first.                                                                                                     |
| `GET /v1/runs/:id`                              | Status and independently persisted final answer.                                                                               |
| `GET /v1/runs/:id/events?after=0&limit=200`     | Bounded, sequenced progress with truncation indication.                                                                        |
| `POST /v1/runs/:id/cancel`                      | Request cancellation; wait for the reported terminal outcome.                                                                  |
| `POST /v1/runs/:id/steer`                       | Send `{ input }` to an active turn when its adapter supports it.                                                               |
| `GET /v1/runs/:id/calls`                        | Product-tool and native interaction records for this run.                                                                      |
| `POST /v1/runs/:id/calls/:callId/result`        | Resolve a pending call with `{ result }`.                                                                                      |
| `GET /v1/sessions/:id/files?path=...`           | Read a bound workspace text file, when enabled.                                                                                |
| `GET /v1/sessions/:id/files?list=true&path=...` | List one directory, when enabled.                                                                                              |
| `POST /v1/sessions/:id/files`                   | Write `{ path, content, expectedRevision? }`, when enabled.                                                                    |

`session.compact()` submits `mode: 'compact'` through the same task machinery. HTTP compaction is implemented for Codex, Pi, Hermes and OpenClaw; Hermes requires a live opened session in this service process. HTTP steering is implemented for Codex, Pi and Hermes. Unsupported controls fail explicitly. Existing embedded ACP compaction helpers remain available; the HTTP service does not create a substitute conversation to invoke them. Optional controls have protocol coverage unless separately recorded as native-tested.

Workspace file access is opt-in via `workspaceFiles: true`. Paths stay under the selected profile's workspace; symlinks are rejected. `expectedRevision: null` requires a new file; a prior revision prevents overwriting a change already observed by this process. This is an optimistic check, not a transaction with unrelated filesystem writers or an OS sandbox for native tools. The client exposes `readFile`, `writeFile`, and `listFiles`.

## Disconnects, restart and duplicate operations

- Disconnecting HTTP or aborting `task.wait()` stops observation, not the native task. Call `task.cancel()` to request cancellation.
- Reattach with `host.task(runId, productTools).wait(...)`. The SDK polls at 250 ms by default and reports network errors to the caller. It does not automatically resubmit a task after a failed request.
- Progress defaults to 2,000 events per run. A history gap requires explicit acknowledgement through `onHistoryGap`; the complete final answer is stored separately.
- Call deadlines default to 120 seconds. Cancellation/deadline aborts pending handlers and rejects late replies. It cannot undo an effect already committed by a product.
- Reposting the same result for a completed call succeeds, including after restart. A different result conflicts. The same SDK task object caches executions across repeated observation; different clients/pages can execute the same pending call. The product must persist a `callId` receipt together with its business change. This is not an exactly-once side-effect guarantee.
- SQLite saves task results/events/call records independently of the product. It holds one process's exclusive state lock, released by the OS on crash. A second service cannot share this state directory concurrently.
- After a crash, unfinished runs become `failed` with `outcomeUnknown: true` and `host_restarted`; pending calls become cancelled. Nothing is replayed automatically. Completed native bindings can be continued by a new, explicitly submitted turn. Preserve both Host state and the Kernel's native storage.

## Example and verification

See the [HTTP editor](../examples/http-editor/README.md). It starts a separate product companion and browser UI, connects to the service, asks before saving, and persists business receipts atomically with its document. It does not import OpenGrove or start another Agent runtime.

```sh
npm test
npm run test:package
# Optional model-backed Codex validation of the installed HTTP service and editor:
AGENT_HOST_HTTP_NATIVE=1 npm run test:package
```

Tests distinguish deterministic Agent/provider fixtures from native model-backed probes. The HTTP fixture matrix covers all seven existing adapters, approve/reject and native binding continuation across Host restart. Additional tests cover native interaction response shapes, observation disconnects, deadlines, duplicate results, authentication, file revisions and hard-process-crash recovery. The package test installs the archive in an independent consumer, starts its CLI and exercises the copied product example. Existing embedded consumer tests remain required.

The port intentionally leaves OpenGrove Rooms, Employees, Routines, knowledge/Skills deployment administration, accounts and application distribution in OpenGrove. Those are not runtime dependencies of this service. Native Skills/MCP already configured in a Kernel remain native capabilities; #126's OpenGrove extension-management API is not part of this HTTP contract.
