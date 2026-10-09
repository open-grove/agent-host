import { createHash, randomUUID } from "node:crypto";
import {
  AgentHarness,
  BACKGROUND_CONTEXT as background,
  convertToLlm,
  DEFAULT_COMPACTION_SETTINGS,
  type AgentLane,
  type AgentHarnessTool,
  type StreamFn,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import {
  type Api,
  type Model,
  type Models,
  type TSchema,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
  MemoryBindingStore,
  type AgentEvent,
  type BindingStore,
  type ProductTool,
  type TurnOutcome,
} from "../agent.js";
import { AsyncEventQueue } from "../async-event-queue.js";
import type { JsonValue } from "../types.js";
import { PiSessionRepository, nativePiSessionId } from "./repository.js";
import { openPiHarness, drivePiTurn, compactPiSession } from "./harness.js";
import { bridgePiStream } from "./stream.js";

export interface PiAgentOptions {
  cwd?: string;
  sessionRoot?: string;
  models?: Models;
  model?: Model<Api>;
  streamFn?: StreamFn;
  bindings?: BindingStore;
  abortSettleTimeoutMs?: number;
  thinkingLevel?: ThinkingLevel;
}
export interface PiRunRequest {
  sessionId: string;
  runId?: string;
  cwd: string;
  input: string;
  instructions: string;
  context?: string;
  tools?: ProductTool[];
  signal?: AbortSignal;
  model?: string;
  thinkingLevel?: ThinkingLevel;
}
type Handle = {
  harness: AgentHarness<undefined>;
  lane: AgentLane;
  fingerprint: string;
};
export class PiAgent {
  private readonly repository: PiSessionRepository;
  private readonly models: Models;
  private readonly bindings: BindingStore;
  private readonly sessions = new Map<string, Handle>();
  private readonly active = new Map<string, AbortController>();
  constructor(private readonly options: PiAgentOptions = {}) {
    this.repository = new PiSessionRepository(options.sessionRoot, options.cwd);
    this.bindings = options.bindings ?? new MemoryBindingStore();
    const catalog = options.models ?? builtinModels();
    this.models = new Proxy(catalog, {
      get: (target, key, receiver) => {
        if (key === "getModel")
          return (provider: string, id: string) =>
            options.model?.provider === provider && options.model.id === id
              ? options.model
              : target.getModel(provider, id);
        if (key === "streamSimple" && options.streamFn)
          return ((model, context, native) =>
            bridgePiStream(
              options.streamFn!,
              model,
              context,
              native,
            )) satisfies Models["streamSimple"];
        const member = Reflect.get(target, key, receiver);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
  }
  async close() {
    for (const controller of this.active.values()) controller.abort();
    await Promise.all(
      [...this.sessions.keys()].map((id) => this.closeSession(id)),
    );
    await this.repository.close();
  }
  private async closeSession(id: string) {
    const handle = this.sessions.get(id);
    if (!handle) return;
    this.sessions.delete(id);
    try {
      await handle?.harness.close(background);
    } finally {
      this.repository.release(id);
    }
  }
  listSessions() {
    return this.repository.list();
  }
  async deleteSession(id: string) {
    if (this.active.has(id)) throw new Error("session_busy");
    if (!this.bindings.delete)
      throw new Error("binding_store_delete_unsupported");
    await this.closeSession(id);
    const deleted = await this.repository.delete(id);
    await this.bindings.delete(id);
    return deleted;
  }
  async forkSession(source: string, target: string) {
    if (this.active.has(source) || this.active.has(target))
      throw new Error("session_busy");
    const result = await this.repository.fork(source, target);
    if (result === "forked") {
      const binding = await this.bindings.get(source);
      if (binding)
        await this.bindings.set(target, {
          ...binding,
          threadId: nativePiSessionId(target),
        });
    }
    return result;
  }
  async compact(sessionId: string, reason?: string) {
    const handle = this.sessions.get(sessionId);
    if (!handle)
      return { ok: false, compacted: false, error: "session_not_open" };
    return compactPiSession(
      handle.harness,
      handle.lane,
      DEFAULT_COMPACTION_SETTINGS,
      reason,
    );
  }
  async steer(sessionId: string, input: string) {
    const handle = this.sessions.get(sessionId);
    if (!handle || !this.active.has(sessionId))
      throw new Error("run_not_found");
    return handle.lane.steer(input, undefined, background);
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
    const threadId = nativePiSessionId(request.sessionId);
    const context = {
      runId,
      sessionId: request.sessionId,
      threadId,
      turnId: runId,
      signal: controller.signal,
    };
    let outcome: TurnOutcome = {
      status: "failed",
      error: "native_terminal_missing",
      outcomeUnknown: true,
    };
    let text = "";
    let registered = false;
    let faulted = false;
    const unsubscribe: Array<() => void> = [];
    queue.push({ type: "turn.started", runId });
    try {
      if (this.active.has(request.sessionId)) throw new Error("session_busy");
      this.active.set(request.sessionId, controller);
      registered = true;
      controller.signal.throwIfAborted();
      if (this.options.cwd && request.cwd !== this.options.cwd)
        throw new Error("session_workspace_changed");
      const fingerprint = createHash("sha256")
        .update(
          JSON.stringify({
            cwd: request.cwd,
            instructions: request.instructions,
            tools: request.tools?.map(({ execute: _, ...spec }) => spec),
          }),
        )
        .digest("hex");
      const bound = await this.bindings.get(request.sessionId);
      if (
        bound &&
        (bound.threadId !== threadId || bound.fingerprint !== fingerprint)
      )
        throw new Error("session_configuration_changed");
      let handle = this.sessions.get(request.sessionId);
      if (handle && handle.fingerprint !== fingerprint)
        throw new Error("session_configuration_changed");
      const model = request.model
        ? this.models
            .getModels()
            .find((m) => `${m.provider}/${m.id}` === request.model)
        : this.options.model;
      if (!model) throw new Error("pi_model_selection_required");
      const tools: AgentHarnessTool<undefined>[] = (request.tools ?? []).map(
        (tool) => ({
          name: tool.name,
          label: tool.name,
          description: tool.description,
          parameters: tool.inputSchema as unknown as TSchema,
          async execute(
            callId,
            input,
            _update,
            _toolContext,
            _invocation,
            nativeContext,
          ) {
            nativeContext.abortSignal?.throwIfAborted();
            controller.signal.throwIfAborted();
            if (!tool.execute) throw new Error("tool_not_available");
            const result = await tool.execute(json(input), {
              ...context,
              signal: nativeContext.abortSignal ?? controller.signal,
              callId,
            });
            if (!result.success)
              throw new Error(
                result.contentItems
                  .filter((i) => i.type === "inputText")
                  .map((i) => i.text)
                  .join("\n"),
              );
            return {
              content: result.contentItems.map((item) => ({
                type: "text" as const,
                text: item.type === "inputText" ? item.text : item.imageUrl,
              })),
              details: result,
            };
          },
        }),
      );
      const existed = (await this.repository.list()).some(
        (session) => session.sessionId === request.sessionId,
      );
      if (bound && !existed) throw new Error("native_session_not_found");
      if (!handle) {
        const session = await this.repository.openOrCreate(request.sessionId);
        try {
          const opened = await openPiHarness<undefined>({
            session,
            models: this.models,
            model,
            tools,
            systemPrompt: request.instructions,
            compaction: DEFAULT_COMPACTION_SETTINGS,
            toProviderMessages: convertToLlm,
          });
          handle = { ...opened, fingerprint };
          this.sessions.set(request.sessionId, handle);
        } catch (error) {
          this.repository.release(request.sessionId);
          throw error;
        }
      }
      await handle.harness.setTools(tools, background);
      await handle.lane.setActiveTools(
        tools.map((t) => t.name),
        background,
      );
      await handle.lane.setModel(
        { provider: model.provider, modelId: model.id },
        background,
      );
      if (request.thinkingLevel ?? this.options.thinkingLevel)
        await handle.lane.setThinkingLevel(
          (request.thinkingLevel ?? this.options.thinkingLevel)!,
          background,
        );
      await this.bindings.set(request.sessionId, { threadId, fingerprint });
      queue.push({ type: "session.bound", runId, threadId, resumed: existed });
      for (const type of [
        "message_start",
        "message_update",
        "message_end",
        "tool_start",
        "tool_update",
        "tool_end",
        "run_end",
        "fault",
        "handler_error",
      ] as const)
        unsubscribe.push(
          handle.harness.events.on(type, (event) => {
            queue.push({
              type: "native.notification",
              runId,
              threadId,
              turnId: runId,
              notification: {
                method: `pi/${event.type}`,
                params: { event: json(event) },
              },
            });
            if (
              event.type === "message_update" &&
              event.event.type === "text_delta"
            )
              queue.push({
                type: "assistant.delta",
                runId,
                text: event.event.delta,
              });
            if (
              event.type === "message_end" &&
              event.message.role === "assistant"
            )
              text = event.message.content
                .filter((item) => item.type === "text")
                .map((item) => item.text)
                .join("");
            if (event.type === "tool_start")
              queue.push({
                type: "tool.started",
                runId,
                callId: event.toolCallId,
                tool: event.toolName,
                input: json(event.args),
              });
            if (event.type === "tool_end")
              queue.push({
                type: "tool.finished",
                runId,
                callId: event.toolCallId,
                tool: event.toolName,
                result: {
                  success: !event.isError,
                  contentItems: event.result.content.map((item) => ({
                    type: "inputText",
                    text: item.type === "text" ? item.text : "[image]",
                  })),
                },
              });
            if (event.type === "fault") faulted = true;
            if (event.type === "run_end")
              outcome =
                event.status === "failed"
                  ? { status: "failed", error: event.error.message }
                  : {
                      status:
                        event.status === "aborted" ? "cancelled" : "completed",
                    };
          }),
        );
      await drivePiTurn({
        lane: handle.lane,
        input: [request.context, request.input].filter(Boolean).join("\n\n"),
        signal: controller.signal,
        abortSettleTimeoutMs: this.options.abortSettleTimeoutMs,
        close: () => this.closeSession(request.sessionId),
      });
    } catch (error) {
      outcome = {
        status: controller.signal.aborted ? "cancelled" : "failed",
        error: String(error),
        outcomeUnknown: true,
      };
    } finally {
      unsubscribe.forEach((fn) => fn());
      if (faulted)
        await this.closeSession(request.sessionId).catch((error) => {
          outcome = {
            status: "failed",
            error: String(error),
            outcomeUnknown: true,
          };
        });
      if (registered) this.active.delete(request.sessionId);
    }
    queue.push({ type: "model.response", runId, text });
    queue.push({ type: "turn.finished", runId, outcome });
  }
}
function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
