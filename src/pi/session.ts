import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  BACKGROUND_CONTEXT as background,
  withAbortSignal,
} from "@earendil-works/chord/context";
import {
  type Api,
  type Model,
  type Models,
  type ModelThinkingLevel,
  type TSchema,
  type AssistantMessage,
  type Context as ModelContext,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
  Harness,
  MemoryStorage,
  createRegistry,
  defineExtension,
  watchEvents,
  ToolTask,
  GenerationTask,
  hook,
  AssistantEntry,
  type Conversation,
  type ConversationId,
  type Registry,
  type Extension,
  type HarnessSettings,
  type Storage,
  type AgentEvent as PiEvent,
} from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import {
  MemoryBindingStore,
  type AgentEvent,
  type BindingStore,
  type ProductTool,
  type InteractionContext,
  type TurnOutcome,
} from "../agent.js";
import { FileBindingStore } from "../file-bindings.js";
import { AsyncEventQueue } from "../async-event-queue.js";
import type { JsonValue } from "../types.js";

export interface PiAgentOptions {
  cwd?: string;
  sessionRoot?: string;
  models?: Models;
  model?: Model<Api> | ((id?: string) => Model<Api>);
  streamFn?: Models["streamSimple"];
  bindings?: BindingStore;
  settings?: HarnessSettings;
  abortSettleTimeoutMs?: number;
  /** Injectable native storage and environment for non-Node hosts. */
  storage?: Storage;
  env?: Parameters<typeof Harness.open>[1]["env"];
}
export interface PiRunRequest {
  sessionId: string;
  runId?: string;
  cwd: string;
  input: string;
  instructions: string;
  context?: string;
  bindingFingerprint?: string;
  images?: Array<{ type: "image"; data: string; mimeType: string }>;
  tools?: ProductTool[];
  signal?: AbortSignal;
  model?: string;
  thinkingLevel?: ModelThinkingLevel;
  /** Extensions, such as the official CodingTools, remain native Pi features. */
  extensions?: Extension[];
  onBeforeTool?(
    call: { name: string; arguments: JsonValue },
    context: InteractionContext,
  ): Promise<{ block?: string } | undefined>;
  onModelRequest?(model: Model<Api>, context: ModelContext): void;
  onNativeEvent?(event: PiEvent): void;
  beforeTurn?(ports: {
    harness: Harness;
    conversation: Conversation;
    registry: Registry;
  }): Promise<void>;
}
/** Pi 1.1 durable conversations. No model loop or transcript replay is implemented here. */
export class PiAgent {
  private readonly registry = createRegistry();
  private readonly models: Models;
  private readonly bindings: BindingStore;
  private opening?: Promise<Harness>;
  private readonly active = new Map<string, AbortController>();
  private retired = false;
  private closing?: Promise<void>;
  constructor(private readonly options: PiAgentOptions = {}) {
    this.bindings =
      options.bindings ??
      (options.sessionRoot
        ? new FileBindingStore(join(options.sessionRoot, "bindings"))
        : new MemoryBindingStore());
    const catalog = options.models ?? builtinModels();
    this.models = new Proxy(catalog, {
      get: (target, key, receiver) => {
        if (key === "getModel")
          return (provider: string, id: string) => {
            const selected =
              typeof options.model === "function"
                ? options.model(id)
                : options.model;
            return selected?.provider === provider && selected.id === id
              ? selected
              : target.getModel(provider, id);
          };
        if (key === "streamSimple")
          return ((model, context, native) => {
            // Native beforeRequest events are exposed below; stream transforms remain provider-owned.
            return options.streamFn
              ? options.streamFn(model, context, native)
              : target.streamSimple(model, context, native);
          }) satisfies Models["streamSimple"];
        const member = Reflect.get(target, key, receiver);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
  }
  private open(): Promise<Harness> {
    if (this.retired || this.closing)
      return Promise.reject(new Error("pi_producer_retiring"));
    this.opening ??= (async () => {
      const storage =
        this.options.storage ??
        (this.options.sessionRoot
          ? await openNodeJsonlStorage(
              join(this.options.sessionRoot, "durable-v1"),
              background,
              { fsync: true },
            )
          : new MemoryStorage());
      return Harness.open(
        storage,
        {
          models: this.models,
          registry: this.registry,
          settings: this.options.settings,
          env:
            this.options.env ??
            ((target) =>
              new NodeExecutionEnv({
                cwd: target.cwd ?? this.options.cwd ?? process.cwd(),
              })),
        },
        background,
      );
    })().catch((error) => {
      this.opening = undefined;
      throw error;
    });
    return this.opening;
  }
  async close() {
    for (const controller of this.active.values()) controller.abort();
    const opening = this.opening;
    this.opening = undefined;
    if (opening) await (await opening).close(background);
  }
  async conversation(sessionId: string): Promise<Conversation | undefined> {
    const binding = await this.bindings.get(sessionId);
    return binding
      ? (await this.open()).conversation(
          parseConversationId(binding.threadId),
          background,
        )
      : undefined;
  }
  async listSessions() {
    if (!this.bindings.list) throw new Error("binding_store_list_unsupported");
    return (await this.bindings.list()).map(({ sessionId, binding }) => ({
      sessionId,
      nativeSessionId: binding.threadId,
    }));
  }
  async deleteSession(_id: string): Promise<never> {
    throw new Error("pi_durable_native_delete_unsupported");
  }
  async compact(sessionId: string, reason?: string) {
    const conversation = await this.conversation(sessionId);
    if (!conversation)
      return { ok: false, compacted: false, error: "session_not_found" };
    const harness = await this.open();
    const id = await conversation.compact(reason, background);
    const task = await harness.waitForTask(id, background);
    const outcome = task.state.outcome;
    if (outcome.status !== "completed")
      return {
        ok: false,
        compacted: false,
        error: `compaction_${outcome.status}`,
      };
    if (!outcome.result.submissionId) return { ok: true, compacted: false };
    const submission = await harness.submission(
      outcome.result.submissionId,
      background,
    );
    const receipt = await submission?.wait(background);
    return receipt?.status === "done"
      ? { ok: true, compacted: true }
      : { ok: false, compacted: false, error: "compaction_not_placed" };
  }
  async steer(sessionId: string, input: string) {
    const conversation = await this.conversation(sessionId);
    if (!conversation || !this.active.has(sessionId))
      throw new Error("run_not_found");
    await conversation.submit(
      { type: "input", content: input, whenBusy: "steer" },
      background,
    );
  }
  async forkSession(source: string, target: string) {
    if (this.active.has(source) || this.active.has(target))
      throw new Error("session_busy");
    if (await this.bindings.get(target)) return "target_exists";
    const conversation = await this.conversation(source);
    if (!conversation) return "source_not_found";
    const entries = await conversation.entries(
      { order: "descending" },
      1,
      undefined,
      background,
    );
    if (!entries.items[0]) throw new Error("empty_session_cannot_fork");
    const fork = await conversation.fork(
      entries.items[0].id,
      { ownership: { kind: "ownerless" } },
      background,
    );
    const binding = (await this.bindings.get(source))!;
    await this.bindings.set(target, { ...binding, threadId: String(fork.id) });
    return "forked";
  }
  async *run(request: PiRunRequest): AsyncIterable<AgentEvent> {
    const queue = new AsyncEventQueue<AgentEvent>();
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
    request: PiRunRequest,
    controller: AbortController,
    queue: AsyncEventQueue<AgentEvent>,
  ) {
    const runId = request.runId ?? randomUUID();
    let outcome: TurnOutcome = {
      status: "failed",
      error: "native_terminal_missing",
      outcomeUnknown: true,
    };
    let text = "";
    let nativeError = "";
    let registered = false;
    let started = false;
    let stream: Awaited<ReturnType<typeof watchEvents>> | undefined;
    let cleanupAbort: (() => void) | undefined;
    let abortTask: Promise<void> | undefined;
    let abortError: unknown;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waitController = new AbortController();
    queue.push({ type: "turn.started", runId });
    try {
      if (this.active.has(request.sessionId)) throw new Error("session_busy");
      if (this.retired || this.closing) throw new Error("pi_producer_retiring");
      this.active.set(request.sessionId, controller);
      registered = true;
      controller.signal.throwIfAborted();
      const fingerprint =
        request.bindingFingerprint ??
        createHash("sha256")
          .update(
            JSON.stringify({
              cwd: request.cwd,
              instructions: request.instructions,
              tools: request.tools?.map(({ execute: _, ...spec }) => spec),
              extensions: request.extensions?.map(
                (extension) => extension.name,
              ),
            }),
          )
          .digest("hex");
      const bound = await this.bindings.get(request.sessionId);
      if (bound && bound.fingerprint !== fingerprint)
        throw new Error("session_configuration_changed");
      const configured =
        typeof this.options.model === "function"
          ? this.options.model(request.model)
          : this.options.model;
      const model =
        !request.model ||
        (configured &&
          [configured.id, `${configured.provider}/${configured.id}`].includes(
            request.model,
          ))
          ? configured
          : this.models
              .getModels()
              .find((m) => `${m.provider}/${m.id}` === request.model);
      if (!model) throw new Error("pi_model_selection_required");
      const harness = await this.open();
      const conversation = bound
        ? await harness.conversation(
            parseConversationId(bound.threadId),
            background,
          )
        : await harness.createConversation(
            { ownership: { kind: "ownerless" } },
            background,
          );
      if (!conversation) throw new Error("native_session_not_found");
      const interaction: InteractionContext = {
        runId,
        sessionId: request.sessionId,
        threadId: String(conversation.id),
        turnId: runId,
        signal: controller.signal,
      };
      const product = defineExtension({
        name: `agent-host:${request.sessionId}`,
        tools: (request.tools ?? []).map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema as unknown as TSchema,
          replay: "unsafe" as const,
          execute: async (input, api, nativeContext) => {
            const signal = nativeContext.abortSignal
              ? AbortSignal.any([nativeContext.abortSignal, controller.signal])
              : controller.signal;
            signal.throwIfAborted();
            controller.signal.throwIfAborted();
            if (!tool.execute) throw new Error("tool_not_available");
            const result = await abortable(
              () =>
                tool.execute!(json(input), {
                  ...interaction,
                  signal,
                  callId: api.callId,
                }),
              signal,
            );
            if (!result.success)
              throw new Error(
                result.contentItems
                  .filter((item) => item.type === "inputText")
                  .map((item) => item.text)
                  .join("\n"),
              );
            return {
              content: result.contentItems.map((item) => ({
                type: "text" as const,
                text: item.type === "inputText" ? item.text : item.imageUrl,
              })),
            };
          },
        })),
        hooks: [
          hook(ToolTask, {
            beforeTool: async (call, _api, nativeContext) => {
              controller.signal.throwIfAborted();
              const signal = nativeContext.abortSignal
                ? AbortSignal.any([
                    nativeContext.abortSignal,
                    controller.signal,
                  ])
                : controller.signal;
              return await abortable(
                () =>
                  request.onBeforeTool?.(
                    { name: call.name, arguments: json(call.arguments) },
                    { ...interaction, signal },
                  ),
                signal,
              );
            },
          }),
          hook(GenerationTask, {
            beforeRequest: (native) => {
              request.onModelRequest?.(model, {
                messages: [...native.messages],
              });
              return undefined;
            },
          }),
        ],
      });
      this.registry.install(product);
      for (const extension of request.extensions ?? [])
        this.registry.install(extension);
      await conversation.configure(
        {
          model: { provider: model.provider, modelId: model.id },
          cwd: request.cwd,
          instructions: request.instructions,
          thinkingLevel: request.thinkingLevel,
          extensions: [product, ...(request.extensions ?? [])],
        },
        background,
      );
      await this.bindings.set(request.sessionId, {
        threadId: String(conversation.id),
        fingerprint,
      });
      queue.push({
        type: "session.bound",
        runId,
        threadId: String(conversation.id),
        resumed: !!bound,
      });
      await abortable(
        () =>
          request.beforeTurn?.({
            harness,
            conversation,
            registry: this.registry,
          }),
        controller.signal,
      );
      stream = await watchEvents(harness, conversation.id, background);
      stream.start(async (events) => {
        for (const event of events) {
          request.onNativeEvent?.(event);
          queue.push({
            type: "native.notification",
            runId,
            threadId: String(conversation.id),
            turnId: runId,
            notification: {
              method: `pi/${event.type}`,
              params: { event: json(event) },
            },
          });
          if (event.type === "message_update")
            for (const change of event.changes)
              if (change.type === "text_delta")
                queue.push({
                  type: "assistant.delta",
                  runId,
                  text: change.delta,
                });
          if (event.type === "message_end" && AssistantEntry.is(event.entry)) {
            const message = event.entry.model?.find(
              (message) => message.role === "assistant",
            ) as AssistantMessage | undefined;
            if (message) {
              text = message.content
                .filter((item) => item.type === "text")
                .map((item) => item.text)
                .join("");
              nativeError = message.errorMessage ?? nativeError;
            }
          }
          if (event.type === "tool_execution_start")
            queue.push({
              type: "tool.started",
              runId,
              callId: event.toolCallId,
              tool: event.toolName,
              input: json(event.args),
            });
          if (event.type === "tool_execution_end") {
            const result = event.entry?.model?.find(
              (message) => message.role === "toolResult",
            );
            queue.push({
              type: "tool.finished",
              runId,
              callId: event.toolCallId,
              tool: event.toolName,
              result: {
                success: result?.role === "toolResult" && !result.isError,
                contentItems: [
                  {
                    type: "inputText",
                    text:
                      result?.role === "toolResult"
                        ? result.content
                            .filter((item) => item.type === "text")
                            .map((item) => item.text)
                            .join("\n")
                        : "Native tool did not produce a result",
                  },
                ],
              },
            });
          }
        }
      });
      controller.signal.throwIfAborted();
      const submission = await conversation.submit(
        {
          type: "input",
          content: request.images?.length
            ? [
                {
                  type: "text",
                  text: [request.context, request.input]
                    .filter(Boolean)
                    .join("\n\n"),
                },
                ...request.images,
              ]
            : [request.context, request.input].filter(Boolean).join("\n\n"),
          requestId: runId,
          whenBusy: "reject",
        },
        background,
      );
      started = true;
      const abort = () => {
        if (abortTask) return;
        timer = setTimeout(
          () => waitController.abort(new Error("pi_abort_settlement_timeout")),
          this.options.abortSettleTimeoutMs ?? 15_000,
        );
        abortTask = conversation.abort(background).catch((error) => {
          abortError = error;
          waitController.abort(error);
        });
      };
      controller.signal.addEventListener("abort", abort, { once: true });
      cleanupAbort = () =>
        controller.signal.removeEventListener("abort", abort);
      if (controller.signal.aborted) abort();
      const receipt = await submission.wait(
        withAbortSignal(waitController.signal, background),
      );
      if (receipt.status === "done" && receipt.type === "input") {
        const answer = await conversation.commit(
          (tx) => tx.entry(AssistantEntry, receipt.answer),
          background,
        );
        const message = answer?.model?.find(
          (message) => message.role === "assistant",
        );
        if (message?.role === "assistant")
          text = message.content
            .filter((item) => item.type === "text")
            .map((item) => item.text)
            .join("");
        outcome = { status: "completed" };
      } else
        outcome = {
          status: receipt.reason === "aborted" ? "cancelled" : "failed",
          error:
            nativeError ||
            (receipt.detail ? JSON.stringify(receipt.detail) : receipt.reason),
        };
    } catch (error) {
      outcome = {
        status: controller.signal.aborted && !started ? "cancelled" : "failed",
        error: String(error),
        ...(started ? { outcomeUnknown: true } : {}),
      };
    } finally {
      cleanupAbort?.();
      if (timer) clearTimeout(timer);
      if (waitController.signal.aborted) this.retired = true;
      if (abortTask && !waitController.signal.aborted) await abortTask;
      await stream?.stop();
      if (registered) this.active.delete(request.sessionId);
      if (this.retired && this.active.size === 0 && !this.closing) {
        const opening = this.opening;
        this.closing = (async () => {
          if (opening) await (await opening).close(background);
        })().finally(() => {
          this.opening = undefined;
          this.retired = false;
          this.closing = undefined;
        });
        await this.closing.catch((error) => {
          abortError = error;
        });
      }
      if (abortError)
        outcome = {
          status: "failed",
          error: String(abortError),
          outcomeUnknown: true,
        };
    }
    queue.push({ type: "model.response", runId, text });
    queue.push({ type: "turn.finished", runId, outcome });
  }
}
function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function parseConversationId(value: string): ConversationId {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 0 || String(id) !== value)
    throw new Error("invalid_native_conversation_id");
  return id as ConversationId;
}

function abortable<T>(
  task: () => T | Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const aborted = () => {
      signal.removeEventListener("abort", aborted);
      reject(signal.reason ?? new Error("aborted"));
    };
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return task();
      })
      .then(
        (value) => {
          signal.removeEventListener("abort", aborted);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener("abort", aborted);
          reject(error);
        },
      );
  });
}
