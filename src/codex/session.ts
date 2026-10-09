import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { AsyncEventQueue } from "../async-event-queue.js";
import type { JsonObject, JsonValue } from "../types.js";
import { CodexAppServerClient, CodexRequestFailure } from "./client.js";
import type { CodexDynamicToolSpec, CodexDynamicToolCallResponse, CodexTurnInputItem, ServerRequestHandler } from "./types.js";

export interface SessionBinding {
  threadId: string;
  fingerprint: string;
}
/** One writer per product session. A store failure prevents starting the turn. */
export interface BindingStore {
  get(sessionId: string): Promise<SessionBinding | undefined>;
  set(sessionId: string, binding: SessionBinding): Promise<void>;
}
export class MemoryBindingStore implements BindingStore {
  private readonly bindings = new Map<string, SessionBinding>();
  async get(id: string) { return this.bindings.get(id); }
  async set(id: string, binding: SessionBinding) { this.bindings.set(id, { ...binding }); }
}
export interface InteractionContext {
  sessionId: string;
  runId: string;
  threadId: string;
  turnId: string;
  signal: AbortSignal;
}
export interface ProductTool extends CodexDynamicToolSpec {
  execute?(input: JsonValue, context: InteractionContext & { callId: string }): Promise<CodexDynamicToolCallResponse>;
}
export interface CodexRunRequest {
  sessionId: string;
  runId?: string;
  cwd: string;
  /** Stable instructions. Changing them requires a new product session. */
  instructions: string;
  /** Mutable product state belongs to the current turn, including on native resume. */
  context?: string;
  input: string | CodexTurnInputItem[];
  tools?: ProductTool[];
  /** Native options are preserved instead of simulating unsupported controls. */
  thread?: JsonObject;
  turn?: JsonObject;
  signal?: AbortSignal;
  mode?: "turn" | "compact";
  /** Used by an adapter to preserve an existing native binding format. */
  bindingFingerprint?: string;
  onRequest?(request: Parameters<ServerRequestHandler>[0], context: InteractionContext): Promise<JsonValue | undefined>;
  beforeTurn?(client: CodexAppServerClient, context: InteractionContext): Promise<void>;
}
export interface TurnOutcome {
  status: "completed" | "cancelled" | "failed";
  error?: string;
  outcomeUnknown?: boolean;
}
export type CodexEvent =
  | { type: "turn.started"; runId: string }
  | { type: "session.bound"; runId: string; threadId: string; resumed: boolean }
  | { type: "native.notification"; runId: string; notification: { method: string; params?: JsonValue }; threadId: string; turnId: string }
  | { type: "assistant.delta"; runId: string; text: string }
  | { type: "tool.started"; runId: string; callId: string; tool: string; input: JsonValue }
  | { type: "tool.finished"; runId: string; callId: string; tool: string; result: CodexDynamicToolCallResponse }
  | { type: "model.response"; runId: string; text: string }
  | { type: "turn.finished"; runId: string; outcome: TurnOutcome };

export interface CodexAgentOptions {
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  bindings?: BindingStore;
  requestTimeoutMs?: number;
  cancellationGraceMs?: number;
  /** Products can preserve their executable discovery, diagnostics and initialization. */
  connect?: () => Promise<CodexAppServerClient>;
}

/** Native app-server execution, extracted from OpenGrove's CodexRuntime. */
export class CodexAgent {
  private client?: Promise<CodexAppServerClient>;
  private closed = false;
  private readonly bindings: BindingStore;
  private readonly active = new Map<string, InteractionContext & { controller: AbortController }>();

  constructor(private readonly options: CodexAgentOptions = {}) {
    this.bindings = options.bindings ?? new MemoryBindingStore();
  }

  async connect(): Promise<CodexAppServerClient> {
    if (this.closed) throw new Error("Agent is closed");
    if (!this.client) {
      const ready = this.options.connect ? this.options.connect() : this.startClient();
      this.client = ready;
      void ready.then(client => {
        client.addCloseHandler(() => { if (this.client === ready) this.client = undefined; });
        if (this.closed) client.close();
      }).catch(() => { if (this.client === ready) this.client = undefined; });
    }
    return this.client;
  }

  private async startClient() {
    const client = await CodexAppServerClient.start({
      command: this.options.command ?? "codex",
      args: this.options.args ?? ["app-server", "--listen", "stdio://"],
      env: this.options.env,
    });
    try { await client.initialize(); return client; }
    catch (error) { client.close(); throw error; }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const active of this.active.values()) active.controller.abort();
    const client = await this.client?.catch(() => undefined);
    client?.close();
  }

  async steer(sessionId: string, input: string): Promise<void> {
    const active = this.active.get(sessionId);
    if (!active?.turnId) throw new Error("active_turn_not_ready");
    const response = await (await this.connect()).request<{ turnId?: string }>("turn/steer", {
      threadId: active.threadId, expectedTurnId: active.turnId,
      input: [{ type: "text", text: input, text_elements: [] }],
    }, { timeoutMs: this.options.requestTimeoutMs ?? 15_000 });
    if (response.turnId !== active.turnId) throw new Error("steered_different_turn");
  }

  async *run(request: CodexRunRequest): AsyncIterable<CodexEvent> {
    const queue = new AsyncEventQueue<CodexEvent>();
    const controller = new AbortController();
    const abort = () => controller.abort(request.signal?.reason);
    request.signal?.addEventListener("abort", abort, { once: true });
    if (request.signal?.aborted) abort();
    const task = this.execute(request, controller, queue).finally(() => queue.close());
    try { for await (const event of queue) yield event; }
    finally {
      controller.abort();
      request.signal?.removeEventListener("abort", abort);
      await task;
    }
  }

  private async execute(request: CodexRunRequest, controller: AbortController, queue: AsyncEventQueue<CodexEvent>) {
    const runId = request.runId ?? randomUUID();
    const { signal } = controller;
    const context = { sessionId: request.sessionId, runId, threadId: "", turnId: "", signal, controller };
    const emit = (event: CodexEvent) => queue.push(event);
    emit({ type: "turn.started", runId });
    let outcome: TurnOutcome = { status: "failed", error: "native_terminal_missing", outcomeUnknown: true };
    const textByItem = new Map<string, string>();
    const phases = new Map<string, string>();
    const cleanups: Array<() => void> = [];
    let nativeStarted = false;
    let activeRegistered = false;
    let client: CodexAppServerClient | undefined;
    let terminal: (() => void) | undefined;
    let grace: ReturnType<typeof setTimeout> | undefined;
    // Duplicate native requests may be delivered before the first tool result completes.
    const toolCalls = new Map<string, { signature: string; result: Promise<CodexDynamicToolCallResponse> }>();
    try {
      if (this.active.has(request.sessionId)) throw new Error("session_busy");
      this.active.set(request.sessionId, context);
      activeRegistered = true;
      signal.throwIfAborted();
      client = await this.connect();
      signal.throwIfAborted();
      const specs = (request.tools ?? []).map(({ execute: _execute, ...spec }) => spec);
      const names = specs.map(spec => spec.name);
      if (new Set(names).size !== names.length) throw new Error("duplicate_tool_name");
      const fingerprint = request.bindingFingerprint ?? fingerprintJson({
        cwd: resolve(request.cwd), instructions: request.instructions, tools: specs,
        provider: request.thread?.modelProvider, config: request.thread?.config,
      });
      const existing = await this.bindings.get(request.sessionId);
      if (existing && existing.fingerprint !== fingerprint) throw new Error("session_scope_changed: choose a new sessionId");
      const params: JsonObject = {
        ...request.thread, cwd: resolve(request.cwd), developerInstructions: request.instructions,
        ...(existing ? { threadId: existing.threadId } : { dynamicTools: specs as unknown as JsonValue }),
      };
      const started = await client.request<{ thread?: { id?: string } }>(existing ? "thread/resume" : "thread/start", params,
        { timeoutMs: this.options.requestTimeoutMs ?? 60_000 });
      const threadId = started.thread?.id;
      if (!threadId || (existing && threadId !== existing.threadId)) throw new Error("native_session_identity_mismatch");
      context.threadId = threadId;
      await this.bindings.set(request.sessionId, { threadId, fingerprint });
      emit({ type: "session.bound", runId, threadId, resumed: Boolean(existing) });
      signal.throwIfAborted();
      const done = new Promise<void>(resolveDone => { terminal = resolveDone; });
      const pending: Array<{ method: string; params?: JsonValue }> = [];
      const onNotification = (notification: { method: string; params?: JsonValue }) => {
        const p = object(notification.params);
        if (p?.threadId !== threadId) return;
        if (!context.turnId) { pending.push(notification); return; }
        const turn = object(p.turn);
        const eventTurn = p.turnId ?? turn?.id;
        if (eventTurn !== undefined && eventTurn !== context.turnId) return;
        emit({ type: "native.notification", runId, notification, threadId, turnId: context.turnId });
        const item = object(p.item);
        if (typeof item?.id === "string" && typeof item.phase === "string") phases.set(item.id, item.phase);
        if (notification.method === "item/agentMessage/delta" && typeof p.delta === "string") {
          const id = typeof p.itemId === "string" ? p.itemId : "assistant";
          const phase = p.phase ?? phases.get(id);
          if (phase !== "commentary") {
            textByItem.set(id, (textByItem.get(id) ?? "") + p.delta);
            emit({ type: "assistant.delta", runId, text: p.delta });
          }
        }
        if (notification.method === "item/completed" && item?.type === "agentMessage" && typeof item.id === "string" && typeof item.text === "string" && (item.phase ?? phases.get(item.id)) !== "commentary")
          textByItem.set(item.id, item.text);
        if (notification.method === "turn/completed") {
          const status = turn?.status;
          outcome = status === "completed" ? { status: "completed" }
            : status === "interrupted" ? { status: "cancelled" }
            : status === "failed" ? { status: "failed", error: String(object(turn?.error)?.message ?? "native_turn_failed") }
            : { status: "failed", error: `unknown_native_status:${String(status)}`, outcomeUnknown: true };
          terminal?.();
        }
      };
      cleanups.push(client.addNotificationHandler(onNotification));
      cleanups.push(client.addCloseHandler(error => {
        outcome = { status: "failed", error: error.message, outcomeUnknown: nativeStarted };
        controller.abort();
        terminal?.();
      }));
      cleanups.push(client.addRequestHandler(async nativeRequest => {
        const p = object(nativeRequest.params);
        if (p?.threadId !== context.threadId || (p.turnId !== undefined && context.turnId && p.turnId !== context.turnId)) return undefined;
        const fallback = nativeRequest.method === "item/tool/requestUserInput" ? { answers: {} }
          : nativeRequest.method === "mcpServer/elicitation/request" ? { action: "cancel" }
          : nativeRequest.method === "item/permissions/requestApproval" ? { permissions: {}, scope: "turn" }
          : { decision: "cancel" };
        if (signal.aborted) return fallback;
        if (nativeRequest.method === "item/tool/call" && typeof p.callId === "string" && typeof p.tool === "string") {
          const callId = p.callId;
          const tool = request.tools?.find(tool => tool.name === p.tool);
          const signature = fingerprintJson({ tool: p.tool, arguments: p.arguments });
          const prior = toolCalls.get(callId);
          if (prior && prior.signature !== signature) throw new Error("tool_call_identity_conflict");
          if (prior) return await prior.result as unknown as JsonValue;
          const result = (async () => {
            const input = p.arguments ?? {};
            emit({ type: "tool.started", runId, callId, tool: String(p.tool), input });
            const result = tool?.execute ? await tool.execute(input, { ...context, callId })
              : await request.onRequest?.(nativeRequest, context) as CodexDynamicToolCallResponse | undefined;
            const output = result ?? { success: false, contentItems: [{ type: "inputText" as const, text: "Unknown product tool" }] };
            emit({ type: "tool.finished", runId, callId, tool: String(p.tool), result: output });
            return output;
          })();
          toolCalls.set(callId, { signature, result });
          return await untilAborted(result, signal, { success: false, contentItems: [{ type: "inputText", text: "Tool interrupted; do not retry automatically." }] }) as unknown as JsonValue;
        }
        return untilAborted(Promise.resolve().then(() => request.onRequest?.(nativeRequest, context)), signal, fallback);
      }));
      const interrupt = () => {
        if (!context.turnId) return;
        void client!.request("turn/interrupt", { threadId, turnId: context.turnId }, { timeoutMs: this.options.cancellationGraceMs ?? 15_000 }).catch(() => undefined);
        grace ??= setTimeout(() => {
          outcome = { status: "failed", error: "cancel_outcome_unknown", outcomeUnknown: true };
          // A still-running producer must not be reused for the next turn.
          client!.close();
          terminal?.();
        }, this.options.cancellationGraceMs ?? 15_000);
      };
      signal.addEventListener("abort", interrupt, { once: true });
      cleanups.push(() => signal.removeEventListener("abort", interrupt));
      await request.beforeTurn?.(client, context);
      signal.throwIfAborted();
      const input: CodexTurnInputItem[] = typeof request.input === "string"
        ? [{ type: "text", text: request.input, text_elements: [] }] : request.input;
      const turnInput = request.context ? [{ type: "text", text: request.context, text_elements: [] }, ...input] : input;
      nativeStarted = true;
      const response = await client.request<{ turn?: { id?: string } }>(request.mode === "compact" ? "thread/compact/start" : "turn/start",
        request.mode === "compact" ? { threadId } : { ...request.turn, threadId, input: turnInput as JsonValue },
        { timeoutMs: this.options.requestTimeoutMs ?? 60_000 });
      context.turnId = response.turn?.id ?? "";
      if (!context.turnId) throw new Error("native_turn_id_missing");
      for (const notification of pending) onNotification(notification);
      if (signal.aborted) interrupt();
      await done;
    } catch (error) {
      const uncertain = nativeStarted || (error instanceof CodexRequestFailure && ["aborted", "timeout", "transport", "closed"].includes(error.kind));
      outcome = { status: signal.aborted && !uncertain ? "cancelled" : "failed", error: error instanceof Error ? error.message : String(error), ...(uncertain ? { outcomeUnknown: true } : {}) };
      if (uncertain) client?.close();
    } finally {
      if (grace) clearTimeout(grace);
      for (const cleanup of cleanups) cleanup();
      controller.abort();
      if (activeRegistered) this.active.delete(request.sessionId);
      emit({ type: "model.response", runId, text: [...textByItem.values()].join("\n\n") });
      emit({ type: "turn.finished", runId, outcome });
    }
  }
}

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}
export function fingerprintJson(value: unknown): string {
  const stable = (item: unknown): unknown => Array.isArray(item) ? item.map(stable)
    : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, stable(value)])) : item;
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}
function untilAborted<T>(task: Promise<T>, signal: AbortSignal, cancelled: T): Promise<T> {
  if (signal.aborted) return Promise.resolve(cancelled);
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); resolve(cancelled); };
    signal.addEventListener("abort", abort, { once: true });
    task.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
