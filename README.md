# Agent Host

[中文](README.zh-CN.md)

Agent Host is an open-source project to extract OpenGrove's native Agent integration into a product-independent package. A product supplies its context, tools and interaction handlers; Agent Host connects to the selected Agent and reports its work.

**Status: all seven native integrations and the independent file editor are implemented on the extraction branch.** OpenGrove consumes the same alpha archive. The package is public source and installs from a built archive; it is not yet published to npm. `agent-host` is the working project name.

The adapters provide native sessions, streaming, scoped product tools, approval/question callbacks, cancellation, steering and compaction. It has no OpenGrove runtime dependency. See [installation, API and verification limits](docs/api.md).

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

The extraction reviews and reuses relevant work from [OpenGrove](https://github.com/open-grove/opengrove), especially the [external-product integration proposal](https://github.com/open-grove/opengrove/pull/126) and [native context lifecycle work](https://github.com/open-grove/opengrove/pull/123). These are dependencies to review, not claims that either proposal is merged or that its reported tests have been rerun here.

## License

[Apache-2.0](LICENSE). Preserve upstream attribution when extracting code.
