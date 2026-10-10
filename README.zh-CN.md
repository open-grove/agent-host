# Agent Host

[English](README.md)

把 OpenGrove 已有的 Agent 接入能力拆成独立开源项目。产品提供自己的上下文、工具和用户交互，接入层负责连接 Agent、驱动工作并返回过程和结果。

**当前状态：七个内核支持嵌入式接入，也可通过独立 HTTP 后台调用。** OpenGrove 和独立编辑器使用 alpha 安装包。源码公开，可从构建包安装，还未发布到 npm。`agent-host` 是项目工作名。

安装、接口和验证范围见 [使用说明](docs/api.md)。已抽出的能力包括原生会话、流式事件、产品工具、审批与提问回调、取消、运行中补充指令和压缩会话；包本身不依赖 OpenGrove。

## 两种使用方式

- **嵌入式**：产品安装代码包，在自己的后台直接调用 Agent，由产品管理启动、停止和存储。
- **独立后台**：运行 `agent-host serve --config host.json`，产品通过 HTTP 连接。后台负责保存任务和结果，转交产品操作、审批和提问。

两种方式使用同一套内核适配。独立后台不需要安装 OpenGrove。详见 [HTTP 后台接入说明](docs/http-service.md)和[浏览器编辑器示例](examples/http-editor/README.md)。

页面断开后可以重新接上仍在运行的任务。后台重启后，已完成结果仍可查询，原生会话可按内核能力继续；未完成任务明确标记为中断，不会自动重做产品操作。

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

Rivet Sandbox Agent 已完成恢复语义评估：默认在连接失效后新建原生会话，再补入历史文本，因此本次保留各内核原生接入。见 [具体依据和可复现验证](docs/rivet.md)。

详细范围见 [scope and acceptance](docs/scope.md)，版本与验证范围见 [Kernel support](docs/kernel-support.md)。

实施跟踪：[拆分与两个使用方验收](https://github.com/open-grove/agent-host/issues/1)、[内核升级与新能力接入](https://github.com/open-grove/agent-host/issues/2)、[Rivet 后端验证](https://github.com/open-grove/agent-host/issues/3)。

## 复用已有工作

独立后台和浏览器客户端移植了 [OpenGrove PR #126](https://github.com/open-grove/opengrove/pull/126) 的任务、产品工具和示例接入逻辑，并替换其 OpenGrove 运行与存储依赖。迁移及验收由 [Issue #5](https://github.com/open-grove/agent-host/issues/5) 跟踪。原 PR 和[上下文生命周期 PR #123](https://github.com/open-grove/opengrove/pull/123) 的其他内容不因此视为已合并。

## 许可证

[Apache-2.0](LICENSE)。提取代码时保留原有署名和依赖许可信息。
