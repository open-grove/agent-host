# Agent Host

[中文](README.zh-CN.md)

Agent Host is an open-source project to extract OpenGrove's native Agent integration into a product-independent package. A product supplies its context, tools and interaction handlers; Agent Host connects to the selected Agent and reports its work.

**Status: all seven native integrations support embedded use and an optional standalone HTTP service.** OpenGrove and independent editor examples consume the alpha archive. The package is public source and installs from a built archive; it is not yet published to npm. `agent-host` is the working project name.

The adapters provide native sessions, streaming, scoped product tools, approval/question callbacks, cancellation, steering and compaction. It has no OpenGrove runtime dependency. See [installation, API and verification limits](docs/api.md).

Use the adapters directly in your product, or run `agent-host serve --config host.json` and connect through `@open-grove/agent-host/client`. Both modes use the same native adapters. The [standalone service guide](docs/http-service.md) covers task persistence, product callbacks, native interactions and restart behavior. Try the [browser editor](examples/http-editor/README.md) as an independent HTTP consumer.

## Responsibilities

- Connect to native Agents and manage their execution lifecycle.
- Create and continue sessions, stream progress, cancel work and report recovery outcomes.
- Bridge product tools, native permission requests and structured user questions.
- Expose optional native controls without claiming every Agent has the same capabilities.
- Provide explicit storage and environment interfaces rather than requiring OpenGrove business objects.

The native Agent keeps its reasoning loop, native tools, transcript and native permission semantics. The consuming product keeps its UI, users, business authorization, memory strategy and domain data.

## Acceptance consumers

1. **OpenGrove:** use the extracted package while preserving existing supported behavior.
2. **An independent file editor:** install the distributable package, edit an example document through a product tool, handle approval and rejection, stop work and continue the conversation after restart. It must not import OpenGrove source or create Rooms, Employees or OpenGrove stores.

Both consumers must use the same package API. The editor is a reference integration, not a second Agent runtime implementation.

## Extraction and upgrades

All seven existing Kernel integrations are in scope: Codex, Claude Agent, Pi, OpenCode, Kimi Code, Hermes and OpenClaw. Updates target stable upstream releases, with exact tested versions recorded. New upstream capabilities are reviewed against the public integration surface and exposed only with implementation and verification evidence.

Rivet Sandbox Agent was evaluated as a replaceable backend. Its default stale-connection recovery recreates a native conversation and replays history, so the native paths remain. See the [decision and reproducible SDK evaluation](docs/rivet.md).

See [scope and acceptance](docs/scope.md) and [Kernel upgrade targets](docs/kernel-support.md).

Tracked work: [extraction and two consumers](https://github.com/open-grove/agent-host/issues/1), [Kernel upgrades and new capabilities](https://github.com/open-grove/agent-host/issues/2), [Rivet backend evaluation](https://github.com/open-grove/agent-host/issues/3).

## Existing work

The HTTP service and browser client adapt the task, product-tool and example integration from [OpenGrove #126](https://github.com/open-grove/opengrove/pull/126), replacing its OpenGrove runtime/storage dependencies. This does not imply the original PR or [context lifecycle work #123](https://github.com/open-grove/opengrove/pull/123) has merged. [Issue #5](https://github.com/open-grove/agent-host/issues/5) tracks the service port and its acceptance tests.

## License

[Apache-2.0](LICENSE). Preserve upstream attribution when extracting code.
