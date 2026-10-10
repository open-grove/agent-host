import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { productToolBridge } from "../product-tool-bridge.js";
import { AsyncEventQueue } from "../async-event-queue.js";
import type { JsonObject, JsonValue } from "../types.js";
import {
  MemoryBindingStore,
  type BindingStore,
  type AgentEvent,
  type InteractionContext,
  type ProductTool,
  type TurnOutcome,
} from "../agent.js";
import {
  JsonRpcRequestFailure,
  StdioJsonRpcClient,
  type JsonRpcRequestHandler,
} from "../transport/stdio-json-rpc-client.js";
import { AcpHostToolBridgeServer } from "./tool-bridge.js";

export type AcpEvent =
  | AgentEvent
  | { type: "native.response"; runId: string; response: JsonValue | undefined };
export interface AcpRunRequest {
  sessionId: string;
  runId?: string;
  cwd: string;
  instructions: string;
  context?: string;
  input: string | JsonObject[];
  tools?: ProductTool[];
  mcpServers?: JsonObject[];
  model?: string;
  effort?: string;
  config?: JsonObject;
  additionalDirectories?: string[];
  signal?: AbortSignal;
  bindingFingerprint?: string;
  bindings?: BindingStore;
  onRequest?(
    request: Parameters<JsonRpcRequestHandler>[0],
    context: InteractionContext,
  ): Promise<JsonValue | undefined>;
  beforeTurn?(
    client: StdioJsonRpcClient,
    context: InteractionContext & { resumed: boolean; imageSupported: boolean },
  ): Promise<void>;
}
export interface AcpAgentOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  bindings?: BindingStore;
  clientInfo?: JsonObject;
  /** Only advertise modes the consuming product can handle. */
  elicitation?: { form?: JsonObject; url?: JsonObject };
  requestTimeoutMs?: number;
  controlRequestTimeoutMs?: number;
  initializationTimeoutMs?: number;
  cancellationGraceMs?: number;
  promptPayload?: "prompt" | "content-and-prompt";
  resumeSessions?: boolean;
  setModelFailure?: "ignore" | "error";
}

/** ACP process/session lifecycle extracted from OpenGrove's AcpCliRuntime. */
export class AcpAgent {
  private ready?: Promise<StdioJsonRpcClient>;
  private client?: StdioJsonRpcClient;
  private closed = false;
  private readonly bindings: BindingStore;
  private readonly sessions = new WeakMap<StdioJsonRpcClient, Set<string>>();
  private readonly capabilities = new WeakMap<StdioJsonRpcClient, JsonObject>();
  private readonly configuration = new WeakMap<
    StdioJsonRpcClient,
    Map<string, JsonObject[]>
  >();
  private readonly selectors = new WeakMap<
    StdioJsonRpcClient,
    Map<
      string,
      { configId?: string; options: Array<{ id: string; name: string }> }
    >
  >();
  private readonly leases = new Map<StdioJsonRpcClient, number>();
  private readonly retired = new Set<StdioJsonRpcClient>();
  private readonly active = new Map<string, AbortController>();
  private readonly bridge = new AcpHostToolBridgeServer();
  constructor(private readonly options: AcpAgentOptions) {
    this.bindings = options.bindings ?? new MemoryBindingStore();
  }

  async connect(): Promise<StdioJsonRpcClient> {
    if (this.closed) throw new Error("agent_closed");
    if (!this.ready) {
      const client = StdioJsonRpcClient.start({
        command: this.options.command,
        args: this.options.args ?? ["acp"],
        cwd: this.options.cwd,
        env: this.options.env,
      });
      this.client = client;
      this.sessions.set(client, new Set());
      const ready = (async () => {
        const response = object(
          await client.request(
            "initialize",
            {
              protocolVersion: 1,
              clientInfo: this.options.clientInfo ?? {
                name: "agent-host",
                version: "0.1.0",
              },
              clientCapabilities: {
                auth: { terminal: false },
                fs: { readTextFile: false, writeTextFile: false },
                terminal: false,
                ...(this.options.elicitation
                  ? { elicitation: this.options.elicitation }
                  : {}),
              },
            },
            { timeoutMs: this.options.initializationTimeoutMs ?? 30_000 },
          ),
        );
        if (response.protocolVersion !== 1)
          throw new Error("acp_protocol_version_unsupported");
        this.capabilities.set(client, object(response.agentCapabilities));
        if (this.closed) {
          client.close();
          throw new Error("agent_closed");
        }
        return client;
      })();
      this.ready = ready;
      client.addCloseHandler(() => {
        if (this.client === client) {
          this.ready = undefined;
          this.client = undefined;
        }
      });
      void ready.catch(() => {
        if (this.ready === ready) {
          this.ready = undefined;
          this.client = undefined;
        }
        client.close();
      });
    }
    return this.ready;
  }

  getCapabilities(client: StdioJsonRpcClient): JsonObject {
    return this.capabilities.get(client) ?? {};
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const controller of this.active.values()) controller.abort();
    for (const client of new Set([
      this.client,
      ...this.leases.keys(),
      ...this.retired,
    ]))
      client?.close();
    this.bridge.close();
  }
  private retire(client: StdioJsonRpcClient) {
    if (this.client === client) {
      this.client = undefined;
      this.ready = undefined;
    }
    this.retired.add(client);
    if (!this.leases.get(client)) {
      this.retired.delete(client);
      client.close();
    }
  }
  private release(client: StdioJsonRpcClient) {
    const count = (this.leases.get(client) ?? 1) - 1;
    if (count) this.leases.set(client, count);
    else {
      this.leases.delete(client);
      if (this.retired.delete(client)) client.close();
    }
  }

  async *run(request: AcpRunRequest): AsyncIterable<AcpEvent> {
    const queue = new AsyncEventQueue<AcpEvent>();
    const controller = new AbortController();
    const abort = () => controller.abort(request.signal?.reason);
    request.signal?.addEventListener("abort", abort, { once: true });
    if (request.signal?.aborted) abort();
    const task = this.execute(request, controller, queue).finally(() =>
      queue.close(),
    );
    try {
      for await (const event of queue) yield event;
    } finally {
      controller.abort();
      request.signal?.removeEventListener("abort", abort);
      await task;
    }
  }

  private async execute(
    request: AcpRunRequest,
    controller: AbortController,
    queue: AsyncEventQueue<AcpEvent>,
  ) {
    const runId = request.runId ?? randomUUID();
    const context: InteractionContext = {
      sessionId: request.sessionId,
      runId,
      threadId: "",
      turnId: "",
      signal: controller.signal,
    };
    const { signal } = context;
    queue.push({ type: "turn.started", runId });
    let outcome: TurnOutcome = {
      status: "failed",
      error: "native_terminal_missing",
      outcomeUnknown: true,
    };
    let text = "";
    let registered = false;
    let sent = false;
    let client: StdioJsonRpcClient | undefined;
    const cleanup: Array<() => void> = [];
    try {
      if (this.active.has(request.sessionId)) throw new Error("session_busy");
      this.active.set(request.sessionId, controller);
      registered = true;
      signal.throwIfAborted();
      client = await this.connect();
      this.leases.set(client, (this.leases.get(client) ?? 0) + 1);
      signal.throwIfAborted();
      const fingerprint =
        request.bindingFingerprint ??
        createHash("sha256")
          .update(
            JSON.stringify({
              cwd: resolve(request.cwd),
              instructions: request.instructions,
              tools: request.tools?.map(({ execute: _, ...spec }) => spec),
              mcpServers: request.mcpServers,
              additionalDirectories: request.additionalDirectories,
              command: this.options.command,
              args: this.options.args,
              env: this.options.env,
            }),
          )
          .digest("hex");
      const bindingStore = request.bindings ?? this.bindings;
      const binding = await bindingStore.get(request.sessionId);
      if (binding && binding.fingerprint !== fingerprint)
        throw new Error("session_configuration_changed");
      const mcpServers = [...(request.mcpServers ?? [])];
      if (request.tools?.length) {
        const bridge = productToolBridge(request.tools, context, queue);
        const binding = await this.bridge.prepare({
          scope: JSON.stringify({ sessionId: request.sessionId, fingerprint }),
          bridge,
        });
        mcpServers.push(binding.mcpServer);
        cleanup.push(() => binding.deactivate(bridge));
        binding.activate(bridge);
      }
      const opened = this.sessions.get(client)!;
      let threadId = binding?.threadId;
      if (threadId && !opened.has(threadId)) {
        if (this.options.resumeSessions === false)
          throw new Error("native_resume_disabled");
        const canResume =
          object(this.getCapabilities(client).sessionCapabilities).resume !=
          null;
        if (!canResume && this.getCapabilities(client).loadSession !== true)
          throw new Error("native_resume_unsupported");
        const loaded = object(
          await client.request(
            canResume ? "session/resume" : "session/load",
            { sessionId: threadId, cwd: request.cwd, mcpServers },
            {
              signal,
              timeoutMs: this.options.controlRequestTimeoutMs ?? 30_000,
            },
          ),
        );
        if (loaded.sessionId !== undefined && loaded.sessionId !== threadId)
          throw new Error("native_resume_session_mismatch");
        this.rememberModels(client, threadId, loaded);
      } else if (!threadId) {
        if (
          request.additionalDirectories?.length &&
          object(this.getCapabilities(client).sessionCapabilities)
            .additionalDirectories == null
        )
          throw new Error("native_additional_directories_unsupported");
        const created = object(
          await client.request(
            "session/new",
            {
              cwd: request.cwd,
              mcpServers,
              ...(request.additionalDirectories
                ? { additionalDirectories: request.additionalDirectories }
                : {}),
              ...(request.model ? { model: request.model } : {}),
            },
            {
              signal,
              timeoutMs: this.options.controlRequestTimeoutMs ?? 30_000,
            },
          ),
        );
        if (typeof created.sessionId !== "string" || !created.sessionId)
          throw new Error("acp_session_id_missing");
        threadId = created.sessionId;
        this.rememberModels(client, threadId, created);
      }
      context.threadId = threadId;
      opened.add(threadId);
      await bindingStore.set(request.sessionId, { threadId, fingerprint });
      await this.setModel(client, threadId, request.model, signal);
      const config = { ...request.config };
      if (request.effort) {
        const selector = this.configuration
          .get(client)
          ?.get(threadId)
          ?.find((item) => item.category === "thought_level");
        if (typeof selector?.id !== "string")
          throw new Error("native_effort_unsupported");
        config[selector.id] = request.effort;
      }
      for (const [configId, value] of Object.entries(config)) {
        const result = await client.request(
          "session/set_config_option",
          { sessionId: threadId, configId, value },
          { signal, timeoutMs: this.options.controlRequestTimeoutMs ?? 15_000 },
        );
        this.rememberModels(client, threadId, object(result));
      }
      queue.push({
        type: "session.bound",
        runId,
        threadId,
        resumed: !!binding,
        configuration: [...this.getSessionConfiguration(client, threadId)],
      });
      // Replayed updates from session/load are deliberately excluded from the new turn.
      cleanup.push(
        client.addNotificationHandler((notification) => {
          const params = object(notification.params);
          if (params.sessionId !== threadId) return;
          const update = object(params.update);
          if (update.sessionUpdate === "config_option_update")
            this.rememberModels(client!, threadId, update);
          queue.push({
            type: "native.notification",
            runId,
            notification,
            threadId,
            turnId: "",
          });
          if (update.sessionUpdate === "agent_message_chunk") {
            const content = object(update.content);
            if (content.type === "text" && typeof content.text === "string") {
              text += content.text;
              queue.push({
                type: "assistant.delta",
                runId,
                text: content.text,
              });
            }
          }
        }),
      );
      cleanup.push(
        client.addRequestHandler(async (rpc) => {
          const params = object(rpc.params);
          if (params.sessionId !== threadId) return undefined;
          const fallback =
            rpc.method === "elicitation/create"
              ? { action: "cancel" }
              : [
                    "session/request_permission",
                    "session/requestPermission",
                  ].includes(rpc.method)
                ? { outcome: { outcome: "cancelled" } }
                : undefined;
          if (signal.aborted) return fallback;
          return (
            (await abortable(
              request.onRequest?.(rpc, context) ?? Promise.resolve(undefined),
              signal,
            ).catch(() => undefined)) ?? fallback
          );
        }),
      );
      const imageSupported =
        object(this.getCapabilities(client).promptCapabilities).image === true;
      await request.beforeTurn?.(client, {
        ...context,
        resumed: !!binding,
        imageSupported,
      });
      signal.throwIfAborted();
      const promptController = new AbortController();
      let grace: ReturnType<typeof setTimeout> | undefined;
      const cancel = () => {
        client!.notify("session/cancel", { sessionId: threadId });
        grace ??= setTimeout(
          () => promptController.abort(),
          this.options.cancellationGraceMs ?? 15_000,
        );
      };
      signal.addEventListener("abort", cancel, { once: true });
      cleanup.push(() => {
        signal.removeEventListener("abort", cancel);
        if (grace) clearTimeout(grace);
      });
      const prefix = [request.instructions, request.context]
        .filter(Boolean)
        .join("\n\n");
      const input =
        typeof request.input === "string"
          ? [{ type: "text", text: request.input }]
          : request.input;
      if (input.some((block) => block.type === "image") && !imageSupported)
        throw new Error("native_image_input_unsupported");
      const prompt = [
        ...(prefix ? [{ type: "text", text: prefix }] : []),
        ...input,
      ];
      sent = true;
      const response = await client.request(
        "session/prompt",
        {
          sessionId: threadId,
          prompt,
          ...(this.options.promptPayload === "content-and-prompt"
            ? { content: prompt }
            : {}),
        },
        {
          signal: promptController.signal,
          timeoutMs: this.options.requestTimeoutMs,
        },
      );
      queue.push({ type: "native.response", runId, response });
      const stopReason = object(response).stopReason;
      if (stopReason === "cancelled") outcome = { status: "cancelled" };
      else if (
        ["end_turn", "max_tokens", "max_turn_requests", "refusal"].includes(
          String(stopReason),
        )
      )
        outcome = { status: "completed" };
      else
        outcome = {
          status: "failed",
          error: "acp_stop_reason_missing",
          outcomeUnknown: true,
        };
    } catch (error) {
      if (
        client &&
        (sent ||
          (error instanceof JsonRpcRequestFailure &&
            ["timeout", "aborted", "transport", "closed"].includes(error.kind)))
      )
        this.retire(client);
      outcome =
        signal.aborted && !sent
          ? { status: "cancelled" }
          : {
              status: "failed",
              error: error instanceof Error ? error.message : String(error),
              ...(sent ? { outcomeUnknown: true } : {}),
            };
    } finally {
      for (const remove of cleanup.reverse()) remove();
      controller.abort();
      if (registered) this.active.delete(request.sessionId);
      if (client) this.release(client);
      queue.push({ type: "model.response", runId, text });
      queue.push({ type: "turn.finished", runId, outcome });
    }
  }

  getSessionConfiguration(
    client: StdioJsonRpcClient,
    sessionId: string,
  ): readonly JsonObject[] {
    return this.configuration.get(client)?.get(sessionId) ?? [];
  }
  private rememberModels(
    client: StdioJsonRpcClient,
    sessionId: string,
    setup: JsonObject,
  ) {
    if (Array.isArray(setup.configOptions)) {
      const sessions = this.configuration.get(client) ?? new Map();
      sessions.set(sessionId, setup.configOptions.map(object));
      this.configuration.set(client, sessions);
    }
    const models = object(setup.models);
    if (
      !Array.isArray(setup.configOptions) &&
      !Array.isArray(models.availableModels)
    )
      return;
    const selector = (
      Array.isArray(setup.configOptions) ? setup.configOptions.map(object) : []
    ).find(
      (option) =>
        option.type === "select" &&
        (option.category === "model" || option.id === "model"),
    );
    const values = Array.isArray(selector?.options)
      ? selector.options.flatMap((value) => {
          const option = object(value);
          return Array.isArray(option.options) ? option.options : [option];
        })
      : [];
    const options = (
      selector
        ? values
        : Array.isArray(models.availableModels)
          ? models.availableModels
          : []
    ).flatMap((value) => {
      const option = object(value);
      const id = option.value ?? option.modelId;
      return typeof id === "string"
        ? [{ id, name: typeof option.name === "string" ? option.name : id }]
        : [];
    });
    const sessions = this.selectors.get(client) ?? new Map();
    sessions.set(sessionId, {
      configId: typeof selector?.id === "string" ? selector.id : undefined,
      options,
    });
    this.selectors.set(client, sessions);
  }
  private async setModel(
    client: StdioJsonRpcClient,
    sessionId: string,
    model: string | undefined,
    signal: AbortSignal,
  ) {
    if (!model) return;
    const selector = this.selectors.get(client)?.get(sessionId);
    const named =
      selector?.options.filter((option) => option.name === model) ?? [];
    const modelId =
      selector?.options.some((option) => option.id === model) ||
      named.length !== 1
        ? model
        : named[0]!.id;
    try {
      const result = await client.request(
        selector?.configId ? "session/set_config_option" : "session/set_model",
        selector?.configId
          ? { sessionId, configId: selector.configId, value: modelId }
          : { sessionId, modelId },
        { signal, timeoutMs: this.options.controlRequestTimeoutMs ?? 15_000 },
      );
      this.rememberModels(client, sessionId, object(result));
    } catch (error) {
      if (
        this.options.setModelFailure !== "ignore" ||
        signal.aborted ||
        (error instanceof JsonRpcRequestFailure && error.kind !== "remote")
      )
        throw error;
    }
  }
}
function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
