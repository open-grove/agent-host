# Agent Host

[English](README.md)

把 OpenGrove 已有的 Agent 接入能力拆成独立开源项目。产品提供自己的上下文、工具和用户交互，接入层负责连接 Agent、驱动工作并返回过程和结果。

**当前状态：第一条 Codex 链路和独立文件编辑器已实现在拆分分支上。** 可以安装构建出的 alpha 包，还未发布到 npm。其余六个内核和 Rivet 评估仍待完成。 `agent-host` 是项目工作名。

安装、接口和验证范围见 [使用说明](docs/api.md)。已抽出的能力包括原生会话、流式事件、产品工具、审批与提问回调、取消、运行中补充指令和压缩会话；包本身不依赖 OpenGrove。

## 拆什么

- 连接和管理不同 Agent。
- 创建、继续和恢复会话，发送任务，接收过程，取消执行。
- 接入产品工具，把审批和结构化提问交给产品处理。
- 保留内核特有功能，明确声明支持范围。
- 把存储、运行环境和产品权限变成可替换接口。

Agent 继续拥有自己的模型循环、原生工具、对话记录和原生权限语义。产品继续拥有界面、账号、业务权限、长期记忆策略和业务数据；接入包不要求产品实现 OpenGrove 的 Room、Employee 或业务存储。

## 用两个产品验收

1. **OpenGrove**：改用抽出的包，验证现有受支持功能。
2. **独立文件编辑器**：安装构建出的包，调用产品工具修改示例文件，验证批准、拒绝、停止、重启后续聊。不能引用 OpenGrove 内部源码。

两个使用方必须使用同一套公开接口。小产品只负责验证接入体验，不另写一套执行逻辑。

## 同时升级内核

Codex、Claude Agent、Pi、OpenCode、Kimi Code、Hermes、OpenClaw 七个现有内核都纳入范围。逐个核对最新稳定版、检查公开接口变化、实现需要接入的新能力，并记录实际验证版本。

Rivet Sandbox Agent 作为候选执行后端接受同一套测试；通过会话恢复、工具和人工交互验证后，才决定替换哪些原生实现。

详细范围见 [scope and acceptance](docs/scope.md)，版本目标见 [Kernel upgrade targets](docs/kernel-support.md)。

实施跟踪：[拆分与两个使用方验收](https://github.com/open-grove/agent-host/issues/1)、[内核升级与新能力接入](https://github.com/open-grove/agent-host/issues/2)、[Rivet 后端验证](https://github.com/open-grove/agent-host/issues/3)。

## 复用已有工作

迁移前检查 OpenGrove 的 [外部产品接入 PR #126](https://github.com/open-grove/opengrove/pull/126) 和 [原生上下文生命周期 PR #123](https://github.com/open-grove/opengrove/pull/123)。这些工作尚不能被视为本项目已合并或已重新验证的实现。

## 许可证

[Apache-2.0](LICENSE)。提取代码时保留原有署名和依赖许可信息。
