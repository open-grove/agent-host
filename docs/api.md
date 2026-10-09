# Codex adapter (alpha)

The first extracted adapter targets **Codex 0.162.0** and Node.js 24+. The package starts the native app-server; Codex keeps its model loop, built-in tools and conversation history. No OpenGrove installation or account service is required. Other Kernel adapters are still pending, and a common API across those adapters is not yet frozen.

## Install and run the example

From a checkout of this repository:

```sh
npm ci
npm test
npm pack
cd examples/file-editor
npm install ../../open-grove-agent-host-0.1.0-alpha.1.tgz
AGENT_HOST_CODEX=../../node_modules/.bin/codex npm start
```

Codex must already be authenticated. `AGENT_HOST_CODEX` selects an executable; it does not install or replace a global CLI. The editor owns one example `document.txt`, asks before editing it, supports Ctrl-C cancellation and saves native bindings for restart. This alpha is installed from its archive; it has not been published to the npm registry.

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
- The binding fingerprint covers workspace, instructions, tools and supplied process/provider configuration. An incompatible reuse fails with `session_scope_changed`; choose a new product session deliberately.
- `MemoryBindingStore` is the default. `FileBindingStore` persists only IDs and fingerprints, validates reads and atomically replaces each session file. Applications must enforce one writer per product session across processes. Corrupt bindings fail explicitly.
- `native.notification` preserves native events alongside final-text and product-tool events. Event projection never executes a tool. Repeated tool calls with the same call ID share one in-flight result within a turn; this is not a durable exactly-once guarantee across crashes.
- Each run emits one `model.response` and one `turn.finished`, including errors. Terminal status is `completed`, `cancelled` or `failed`. Transport loss, request timeout or unconfirmed cancellation can set `outcomeUnknown`; do not automatically retry side effects.
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
