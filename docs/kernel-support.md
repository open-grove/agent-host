# Kernel upgrade targets

These are stable upstream targets checked on **2026-10-09**, not a support claim. **Only the Codex paths listed below have native probe evidence; the remaining Kernels are pending.** Targets are refreshed before each adapter migration; releases record exact tested versions rather than an unbounded promise to support "latest".

The current integration baselines below come from OpenGrove's dependency pins and [Kernel source reference](https://github.com/open-grove/opengrove/blob/main/docs/reference/KERNEL_SOURCES.md). Its individual capability probes may have used earlier versions; these numbers do not certify every feature.

| Kernel | OpenGrove integration baseline | Stable target | Verification |
| --- | --- | --- | --- |
| Codex | 0.153.4 | [0.162.0](https://github.com/openai/codex/releases/tag/rust-v0.162.0) | macOS arm64: native tool, restart continuation and compaction passed; [limits](api.md#validation) |
| Claude Agent | SDK 0.3.263 / engine 2.1.263 | SDK [0.3.295](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk/v/0.3.295) / engine [2.1.295](https://github.com/anthropics/claude-code/releases/tag/v2.1.295) | Pending |
| Pi | pi-agent-core / pi-ai 0.85.1 | [1.1.0](https://github.com/earendil-works/pi/releases/tag/v1.1.0) | Pending |
| OpenCode | 1.18.29 | [1.18.35](https://github.com/anomalyco/opencode/releases/tag/v1.18.35) | Pending |
| Kimi Code | 0.41.0 | [2.1.1](https://github.com/MoonshotAI/kimi-code/releases/tag/%40moonshot-ai%2Fkimi-code%402.1.1) | Pending |
| Hermes | 0.21.1 | [0.21.6](https://github.com/NousResearch/hermes-agent/releases/tag/v0.21.6) | Pending |
| OpenClaw | 2026.9.2 | [2026.9.9](https://github.com/openclaw/openclaw/releases/tag/v2026.9.9) | Pending |

Related integration components: ACP SDK **1.7.0** and Rivet Sandbox Agent **0.5.2**. Neither is an additional Kernel. Adapters and transitive dependencies must be reviewed alongside the native executable or SDK.

## Initial audit priorities

- **Codex:** inspect the current app-server schema, native interaction/control requests, tool attribution and continuation behavior. Source: [official app-server documentation](https://developers.openai.com/codex/app-server).
- **Claude:** compare the actual Agent SDK types and bundled engine behavior; distinguish programmatic hooks/dialogs from terminal-only features.
- **Pi:** review all changes from 0.85.1 through 1.1.0, including native session APIs and the newly documented cancelled-run indicator on `agent_settled`. Source: [1.1.0 release](https://github.com/earendil-works/pi/releases/tag/v1.1.0).
- **ACP integrations:** check advertised initialization capabilities and stable structured elicitation; do not infer implementation from the protocol alone. Source: [ACP elicitation](https://agentclientprotocol.com/announcements/elicitation-stabilized).
- **Kimi, Hermes and OpenClaw:** review the complete version interval for their actual ACP or Gateway integration surfaces; a patch release note alone is insufficient.

This page tracks migration targets. Completed compatibility results must identify the package revision, native version, platform, relevant provider context and verification method without publishing credentials or private conversation data.
