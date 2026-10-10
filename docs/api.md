# Agent Host API (alpha)

The package targets Node.js 24+ and provides native adapters for all seven Kernels in the [support matrix](kernel-support.md). No OpenGrove installation or account service is required. The common turn/tool/event boundary is alpha; optional controls remain Kernel-specific. The first example below uses Codex 0.162.0.

## Install and run the example

From a checkout of this repository:

```sh
npm ci
npm test
npm pack
cd examples/file-editor
npm install ../../open-grove-agent-host-0.1.0-alpha.2.tgz
AGENT_HOST_CODEX=../../node_modules/.bin/codex npm start
```

Codex must already be authenticated. `AGENT_HOST_CODEX` selects an executable; it does not install or replace a global CLI. The editor owns one example `document.txt`, asks before editing it, supports Ctrl-C cancellation and saves native bindings for restart. This alpha is installed from its archive; it has not been published to the npm registry.

For an independently running HTTP process and a browser client, see [Standalone HTTP service](http-service.md). Both entry points use the same native adapters.

## Product integration

```ts
import { CodexAgent } from '@open-grove/agent-host/codex';
import { FileBindingStore } from '@open-grove/agent-host';

const agent = new CodexAgent({
  command: 'codex',
  bindings: new FileBindingStore('.local/bindings'),
});
try {
  for await (const event of agent.run({
    sessionId: 'document-42',
    cwd: process.cwd(),
    instructions: 'Help the user edit their document.',
    context: 'Current document: ...',
    input: 'Suggest a shorter introduction.',
    thread: { sandbox: 'read-only', approvalPolicy: 'on-request' },
    signal: AbortSignal.timeout(120_000),
  })) {
    if (event.type === 'assistant.delta') process.stdout.write(event.text);
    if (event.type === 'turn.finished') console.log(event.outcome);
  }
} finally {
  await agent.close();
}
```

`instructions` are stable; `context` is the current product state, supplied on every turn. A product can also supply native text/image/skill/mention input items. Native `thread` and `turn` options preserve controls such as model, effort, sandbox policy, output schema and collaboration mode without inventing equivalent features for other Kernels. Passing an option does not establish that it has been verified in every environment.

## Tools and interactions

`tools` contains `name`, `description`, `inputSchema` and an `execute(input, context)` callback. Optional `namespace` uses Codex 0.162 native tool groups. Each execution receives the product session/run IDs, native thread/turn IDs, `callId` and an abort signal. Return `{ success, contentItems }`, using native `inputText` or `inputImage` content. The product validates tool arguments, checks business authorization and decides whether an operation needs approval. See the file editor's `edit_document` handler.

`onRequest(request, context)` handles native interactions without losing their specific fields:

| Native request | Expected response |
| --- | --- |
| `item/commandExecution/requestApproval`, `item/fileChange/requestApproval` | An allowed native `decision`, such as `accept`, `decline` or `cancel` |
| `item/permissions/requestApproval` | A granted `permissions` subset and optional scope |
| `item/tool/requestUserInput` | `{ answers: { questionId: { answers: ['...'] } } }` |
| `mcpServer/elicitation/request` | Native `action` and optional structured content |

Unhandled approvals are cancelled, questions receive no answers, and elicitations are declined. Cancellation signals pending handlers and releases the native request even if a UI callback never resolves. Tool handlers must obey the signal; stopping observation cannot undo an external effect already performed by a product tool.

For external token management or custom process discovery, supply `connect`, returning an initialized `CodexAppServerClient`. Its `fallbackRequest` routes connection-level requests. The default path uses Codex's own login and never copies credentials into the product workspace.

## Sessions, events and recovery

- `session.bound` distinguishes a new thread from a resumed native thread. A resume error is a failure; the adapter never starts a replacement thread or injects old messages as an imitation of native continuation.
- The default binding fingerprint covers the adapter’s session-defining configuration, such as workspace, instructions, tools and supplied provider configuration. An incompatible reuse fails with `session_scope_changed`; choose a new product session deliberately.
- `MemoryBindingStore` is the default. `FileBindingStore` persists only IDs and fingerprints, validates reads and atomically replaces each session file. Applications must enforce one writer per product session across processes. Corrupt bindings fail explicitly.
- `native.notification` preserves native events alongside final-text and product-tool events. Event projection never executes a tool. Repeated tool calls with the same call ID share one in-flight result within a turn; this is not a durable exactly-once guarantee across crashes.
- Each run emits one `turn.finished`, including errors. A completed answer is reported as `model.response`; failed or empty turns may have no answer. Terminal status is `completed`, `cancelled` or `failed`. Transport loss, request timeout or unconfirmed cancellation can set `outcomeUnknown`; do not automatically retry side effects.
- `agent.steer(sessionId, input)` targets an active native turn. `mode: 'compact'` resumes the binding and observes native compaction. These controls do not rebuild history in the Host.
- A failed connection is retired. Existing sibling turns can finish before that process is closed; new turns use a fresh connection.
- Returning early from the event iterator cancels its turn. Use `await agent.close()` during product shutdown.

## Validation

`npm test` exercises protocol fixtures: event ordering, restart bindings, explicit recovery failures, tool deduplication and errors, namespaces, permissions/questions, cancellation, compaction and sibling-turn isolation. `npm run test:package` installs an archive into a separate consumer directory and runs the editor's approve/reject/cancel and restart tests, plus a TypeScript consumer check.

Native probes use real model access and are opt-in:

```sh
npm run probe:codex
AGENT_HOST_NATIVE_PROBE=1 npm run test:package
```

On macOS arm64 with Codex 0.162.0 and an existing ChatGPT login, the native probe verifies a namespaced product tool, conversation continuation after process restart and native compaction. OpenGrove has a separate native consumer probe and its existing server smoke tests. Structured native questions, native permission UI and steering have protocol coverage only until corresponding native probes pass. Windows and Linux are not yet certified by native probes.


## Choosing an adapter

All adapters accept a product `sessionId`, user `input`, stable `instructions`, current `context`, `tools`, `signal` and a binding store. Most need `cwd`; OpenClaw uses its configured native workspace. They yield the common events used by the editor. Adapter-specific native options and callbacks remain typed at their public subpath.

| Import | Construction / native prerequisite |
| --- | --- |
| `@open-grove/agent-host/codex` → `CodexAgent` | `command: 'codex'`; authenticated app-server executable |
| `@open-grove/agent-host/acp` → `AcpAgent` | `command: 'opencode'` or `'kimi'`, default `args: ['acp']`; native credentials |
| `@open-grove/agent-host/claude` → `ClaudeAgent` | Bundled SDK engine; optional `command`, `env`, `native` SDK options |
| `@open-grove/agent-host/pi` → `PiAgent` | A Pi `model` or resolver, `cwd`, durable `sessionRoot`; native provider credentials |
| `@open-grove/agent-host/hermes` → `HermesAgent` | Python executable and Gateway launch args, isolated persistent `HERMES_HOME`, `exclusiveProfile: true` for product tools |
| `@open-grove/agent-host/openclaw` → `OpenClawAgent` | Authenticated Gateway `url` and `token` or `password`; optional product-tool plugin below |

Use `FileBindingStore` for adapter restart. A binding is a reference to native storage, not a backup of that storage. Keep the native profile/session directory too. Never treat `outcomeUnknown` as permission to replay a mutating operation. Products own argument validation and business authorization even when a Kernel validates the supplied JSON Schema.

The editor's `createEditor` accepts `kernel`, `command`, `args`, `env`, `model`, `adapterOptions`, `approve` and `ask`. Its terminal UI accepts `AGENT_HOST_KERNEL`, `AGENT_HOST_COMMAND`, `AGENT_HOST_MODEL` and an optional `AGENT_HOST_OPTIONS_FILE` JSON configuration with those same construction options. Keep credentials in native configuration or environment variables. Product context is sent on every turn; previous dialogue is left in native storage.

### ACP controls and questions

`AcpAgent.connect()` initializes the native process. `getCapabilities(client)` exposes what that process actually advertises; native initialization and session notifications retain configuration details. Form elicitation is opt-in through `elicitation: { form: {} }`; return native `{ action: 'accept', content }`, `decline` or `cancel` from `onRequest`. Permissions use native option IDs. Model, effort and config requests are checked against native options. `compactOpenCode` and `compactKimi` retain the native summarization/command paths; arbitrary ACP does not imply universal compaction support.

### Claude native SDK

`ClaudeAgent` offers the common turn interface. `ClaudeQueryHost` is also exported for products that already project the complete native SDK event stream, as OpenGrove does. It owns query cancellation and request lifetime; the product still owns event storage and domain projections. Native SDK options include hooks, effort, MCP, settings sources and budget. Permission callbacks use native `allow`/`deny`; `AskUserQuestion` requires its structured answers. The SDK's own bypass permission mode bypasses its permission callback; it does not bypass authorization inside a product tool.

### Pi durable sessions

Provide `model` and a persistent `sessionRoot`. The native 1.1 Harness owns conversations and tool/model execution. `conversation`, `listSessions`, `forkSession`, `steer` and `compact` expose supported native operations. `deleteSession` explicitly reports `pi_durable_native_delete_unsupported`. The `compat/pi085` entry is solely for existing 0.85 storage; new integrations should use `pi`.

### Hermes profile and interactions

Launch the installed 0.21.6 Python environment with Gateway args such as `['-u', '-c', "import runpy; import hermes_bootstrap; runpy.run_module('tui_gateway.entry', run_name='__main__')"]`. Install Hermes's official MCP extra through its native package manager in the same profile. A Python package version alone does not establish that its selected runtime environment has MCP enabled.

A product must own the supplied `HERMES_HOME` before setting `exclusiveProfile: true`: the adapter registers its MCP entry there. The editor defaults to a profile under its own document directory. Native login/provider configuration is still required. Do not share one profile among concurrently running adapters.

`onRequest` receives native `approval` (`choice: once/session/always/deny`), `clarify` (`answers` keyed by native `qid`), and `sudo`/`secret` (an empty `value` declines). Request cancellation aborts pending UI callbacks. `steer` and `compact` operate on a session already opened by the adapter and require native receipts.

### OpenClaw product tools

Start a local Gateway with the bundled plugin. In its native configuration, add the installed package's `plugins/openclaw` directory to `plugins.load.paths`, include `agent-host` in `plugins.allow`, and enable `plugins.entries.agent-host`. Keep the native tool policy configured to permit the plugin for the selected agent. For an isolated example, `tools.allow: ['agent-host']` offers only this plugin.

```json
{
  "plugins": {
    "allow": ["agent-host"],
    "load": { "paths": ["/absolute/path/node_modules/@open-grove/agent-host/plugins/openclaw"] },
    "entries": { "agent-host": { "enabled": true } }
  },
  "tools": { "allow": ["agent-host"] }
}
```

The plugin declares one native `agent_host_call` tool and forwards the selected product action through a scoped loopback callback. The Gateway and product must be on the same machine. Remote Gateways can run native turns without product tools; this callback transport is not a remote sandbox bridge. Missing plugin or unavailable tools fails before submitting a turn.

Pass a fully qualified `provider/model` when choosing a model. Canonical session keys returned by the Gateway are saved. `compact(nativeSessionKey)` only succeeds when the native result confirms compaction. Native shell approvals and questions are not mapped to common callbacks in this adapter.

## Probes for the other Kernels

After building, run `node scripts/probe-acp.mjs opencode|kimi|claude|pi|hermes|openclaw` with one Kernel name. Despite its historical filename, this script dispatches the native adapter for each Kernel. It packs and installs the package into a separate consumer, then checks rejection, approval and native restart continuation. It uses `AGENT_HOST_COMMAND`, `AGENT_HOST_ARGS` (JSON array), `AGENT_HOST_MODEL`, native credential environment, and for OpenClaw `AGENT_HOST_OPENCLAW_URL` / `AGENT_HOST_OPENCLAW_TOKEN`. Pi provider overrides are documented in the script as `AGENT_HOST_PI_*`; Hermes requires a prepared product-owned `HERMES_HOME`.

OpenGrove's extraction branch includes `scripts/probe-agent-host-codex.mjs`, `scripts/probe-agent-host-hermes.mjs` and `scripts/probe-agent-host-native.mjs` for its own consumer boundary. See the [support matrix](kernel-support.md) for what native tests do and do not establish.
