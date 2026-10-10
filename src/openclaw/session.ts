import { createHash, randomUUID } from "node:crypto";
import { AsyncEventQueue } from "../async-event-queue.js";
import { abortable } from "../abortable.js";
import {
  MemoryBindingStore,
  type AgentEvent,
  type BindingStore,
  type InteractionContext,
  type ProductTool,
  type TurnOutcome,
} from "../agent.js";
import type { JsonObject } from "../types.js";
import { productToolBridge } from "../product-tool-bridge.js";
import { AcpHostToolBridgeServer } from "../acp/tool-bridge.js";
import type { HostToolBridge } from "../acp/tools.js";
import {
  OpenClawGatewayClient,
  type GatewayEventFrame,
  type OpenClawGatewayConnection,
} from "./client.js";

export interface OpenClawAgentOptions extends OpenClawGatewayConnection {
  bindings?: BindingStore;
  client?: OpenClawGatewayClient;
  waitSliceMs?: number;
  cancellationGraceMs?: number;
}
export interface OpenClawRunRequest {
  sessionId: string;
  runId?: string;
  sessionKey?: string;
  cwd?: string;
  input: string;
  instructions: string;
  context?: string;
  model?: string;
  tools?: ProductTool[];
  toolBridge?: HostToolBridge;
  bindings?: BindingStore;
  bindingFingerprint?: string;
  signal?: AbortSignal;
  /** Native agent RPC places stable instructions in extraSystemPrompt. */
  method?: "chat.send" | "agent";
  beforeTurn?(
    client: OpenClawGatewayClient,
    context: InteractionContext & { selectedModel?: JsonObject },
  ): Promise<void>;
}

/** Protocol 4 Gateway sessions. Product tools require the optional bundled Gateway plugin. */
export class OpenClawAgent {
  readonly client: OpenClawGatewayClient;
  private readonly bindings: BindingStore;
  private readonly bridge = new AcpHostToolBridgeServer();
  private readonly active = new Map<string, AbortController>();
  private readonly unsettled = new Set<string>();
  private closed = false;
  constructor(private readonly options: OpenClawAgentOptions) {
    this.client = options.client ?? new OpenClawGatewayClient(options);
    this.bindings = options.bindings ?? new MemoryBindingStore();
  }
  close() {
    this.closed = true;
    for (const controller of this.active.values())
      controller.abort(new Error("agent_closed"));
    this.client.close();
    this.bridge.close();
  }
  async *run(request: OpenClawRunRequest): AsyncIterable<AgentEvent> {
    const queue = new AsyncEventQueue<AgentEvent>();
    const controller = new AbortController();
    const cancel = () => controller.abort(request.signal?.reason);
    if (request.signal?.aborted) cancel();
    request.signal?.addEventListener("abort", cancel, { once: true });
    const producer = this.produce(request, controller, queue).finally(() =>
      queue.close(),
    );
    try {
      yield* queue;
      await producer;
    } finally {
      controller.abort(new Error("consumer_closed"));
      request.signal?.removeEventListener("abort", cancel);
      await producer;
    }
  }
  private async produce(
    request: OpenClawRunRequest,
    controller: AbortController,
    queue: AsyncEventQueue<AgentEvent>,
  ) {
    const runId = request.runId ?? randomUUID();
    const lockKey =
      request.sessionKey ??
      this.options.sessionKey ??
      `agent:main:agent-host-${createHash("sha256").update(request.sessionId).digest("hex")}`;
    let sessionKey = lockKey;
    const context: InteractionContext = {
      sessionId: request.sessionId,
      runId,
      threadId: sessionKey,
      turnId: runId,
      signal: controller.signal,
    };
    let owns = false,
      sent = false,
      settled = false,
      text = "",
      nativeRunId = runId,
      terminalError = "";
    let outcome: TurnOutcome = {
      status: "failed",
      error: "native_terminal_missing",
      outcomeUnknown: true,
    };
    const cleanup: Array<() => void> = [];
    let toolsBound = false;
    queue.push({ type: "turn.started", runId });
    try {
      if (this.closed) throw new Error("agent_closed");
      if (this.active.has(lockKey)) throw new Error("session_busy");
      if (this.unsettled.has(lockKey))
        throw new Error("native_run_outcome_unresolved");
      this.active.set(lockKey, controller);
      owns = true;
      context.signal.throwIfAborted();
      await this.client.ensureConnected();
      context.signal.throwIfAborted();
      const fingerprint =
        request.bindingFingerprint ??
        createHash("sha256")
          .update(
            JSON.stringify({
              gateway: this.options.url,
              sessionKey,
              instructions: request.instructions,
              tools: request.tools?.map(({ execute: _, ...spec }) => spec),
              descriptors: request.toolBridge?.descriptors,
            }),
          )
          .digest("hex");
      const store = request.bindings ?? this.bindings;
      const binding = await store.get(request.sessionId);
      if (binding && binding.fingerprint !== fingerprint)
        throw new Error("session_configuration_changed");
      if (binding) {
        const restored = object(
          await this.client.request(
            "sessions.resolve",
            { key: binding.threadId, allowMissing: true },
            { timeoutMs: 15_000, signal: context.signal },
          ),
        );
        if (restored.ok !== true || typeof restored.key !== "string")
          throw new Error("native_session_missing");
        sessionKey = restored.key;
      }
      const selectedModel = request.model
        ? await selectOpenClawModel(
            this.client,
            sessionKey,
            request.model,
            context.signal,
          )
        : undefined;
      if (typeof selectedModel?.sessionKey === "string")
        sessionKey = selectedModel.sessionKey;
      context.threadId = sessionKey;
      const toolBridge =
        request.toolBridge ??
        (request.tools?.length
          ? productToolBridge(request.tools, context, queue)
          : undefined);
      if (toolBridge) {
        if (
          !["localhost", "127.0.0.1", "[::1]"].includes(
            new URL(this.options.url).hostname,
          )
        )
          throw new Error("openclaw_product_tools_require_local_gateway");
        const capabilities = object(
          await this.client.request(
            "agent-host.describe",
            {},
            { timeoutMs: 15_000, signal: context.signal },
          ),
        );
        if (capabilities.protocol !== 1 || capabilities.productTools !== true)
          throw new Error("openclaw_product_tools_plugin_required");
        const scoped = await this.bridge.prepare({
          scope: JSON.stringify({ sessionKey, runId }),
          bridge: toolBridge,
        });
        scoped.activate(toolBridge);
        cleanup.push(() => scoped.deactivate(toolBridge));
        const env = Object.fromEntries(
          scoped.mcpServer.env.map((e) => [e.name, e.value]),
        );
        const bound = object(
          await this.client.request(
            "agent-host.bind",
            {
              sessionKey,
              runId,
              endpoint: env.AGENT_HOST_TOOL_ENDPOINT,
              token: env.AGENT_HOST_TOOL_TOKEN,
              tools: toolBridge.descriptors,
            },
            { timeoutMs: 15_000, signal: context.signal },
          ),
        );
        if (bound.ok !== true)
          throw new Error("openclaw_product_tools_binding_failed");
        toolsBound = true;
        const renewal = setInterval(() => {
          void this.client
            .request(
              "agent-host.renew",
              { sessionKey, runId },
              { timeoutMs: 10_000 },
            )
            .catch((error) => controller.abort(error));
        }, 20_000);
        renewal.unref();
        cleanup.push(() => clearInterval(renewal));
      }
      await store.set(request.sessionId, { threadId: sessionKey, fingerprint });
      queue.push({
        type: "session.bound",
        runId,
        threadId: sessionKey,
        resumed: !!binding,
      });
      await abortable(
        request.beforeTurn?.(this.client, { ...context, selectedModel }) ??
          Promise.resolve(),
        context.signal,
      );
      const accepted = new Set([runId]);
      const early: GatewayEventFrame[] = [];
      let acknowledged = false;
      let streamingSource: "agent" | "chat" | undefined;
      let agentText = "",
        chatText = "",
        finalChatText: string | undefined;
      const project = (frame: GatewayEventFrame) => {
        const payload = object(frame.payload);
        if (typeof payload.runId !== "string" || !accepted.has(payload.runId))
          return;
        if (frame.event === "chat" && payload.sessionKey !== sessionKey) return;
        queue.push({
          type: "native.notification",
          runId,
          notification: { method: frame.event, params: payload },
          threadId: sessionKey,
          turnId: nativeRunId,
        });
        const data = object(payload.data);
        const source =
          frame.event === "agent" && payload.stream === "assistant"
            ? "agent"
            : frame.event === "chat"
              ? "chat"
              : undefined;
        if (source) {
          let next =
            source === "agent"
              ? extractText(data) || extractText(payload)
              : extractText(payload.message);
          if (source === "chat" && typeof payload.deltaText === "string")
            next = chatText + payload.deltaText;
          if (
            source === "agent" &&
            (next.trim() === "NO_REPLY" ||
              (next.includes('"payloads"') && next.includes('"runId"')))
          )
            next = "";
          if (next) {
            const previous = source === "agent" ? agentText : chatText;
            const delta = next.startsWith(previous)
              ? next.slice(previous.length)
              : next;
            const updated = next.startsWith(previous) ? next : previous + next;
            if (source === "agent") agentText = updated;
            else chatText = updated;
            streamingSource ??= source;
            if (streamingSource === source && delta) {
              text = updated;
              queue.push({ type: "assistant.delta", runId, text: delta });
            }
          }
          if (source === "chat" && payload.state === "final")
            finalChatText = extractText(payload.message) || chatText;
          if (source === "chat" && payload.state === "error")
            terminalError = String(
              payload.errorMessage ?? "openclaw_gateway_run_failed",
            );
        }
        if (
          frame.event === "agent" &&
          payload.stream === "lifecycle" &&
          data.phase === "error"
        )
          terminalError = String(data.error ?? "openclaw_gateway_run_failed");
      };
      cleanup.push(
        this.client.addEventListener((frame) => {
          if (!acknowledged) {
            if (early.length < 1024) early.push(frame);
          } else project(frame);
        }),
      );
      const waitController = new AbortController();
      let grace: ReturnType<typeof setTimeout> | undefined;
      let cancelFailure: unknown;
      let cancellation: Promise<boolean> | undefined;
      let cancelRunId: string | undefined;
      const abort = () => {
        if (!sent || settled) return;
        if (cancelRunId === nativeRunId) return;
        cancelRunId = nativeRunId;
        cancellation = this.client
          .request(
            "chat.abort",
            { sessionKey, runId: nativeRunId },
            { timeoutMs: 10_000 },
          )
          .then((receipt) => object(receipt).aborted === true)
          .catch((error) => {
            cancelFailure = error;
            return false;
          });
        grace ??= setTimeout(
          () =>
            waitController.abort(
              new Error(
                `openclaw_cancel_unsettled${cancelFailure ? ":" + String(cancelFailure) : ""}`,
              ),
            ),
          this.options.cancellationGraceMs ?? 15_000,
        );
      };
      context.signal.addEventListener("abort", abort, { once: true });
      cleanup.push(() => {
        context.signal.removeEventListener("abort", abort);
        if (grace) clearTimeout(grace);
      });
      context.signal.throwIfAborted();
      // Mark admission before sending. Lost acknowledgements never mean the task did not run.
      sent = true;
      const method = request.method ?? "chat.send";
      const reply = object(
        await this.client.request(
          method,
          {
            sessionKey,
            message: [
              ...(method === "agent" ? [] : [request.instructions]),
              request.context,
              request.input,
            ]
              .filter(Boolean)
              .join("\n\n"),
            deliver: false,
            idempotencyKey: runId,
            ...(method === "agent"
              ? {
                  extraSystemPrompt: request.instructions,
                  ...(request.cwd ? { cwd: request.cwd } : {}),
                }
              : {}),
          },
          { timeoutMs: 30_000 },
        ),
      );
      if (typeof reply.runId !== "string" || !reply.runId)
        throw new Error("openclaw_run_id_missing");
      nativeRunId = reply.runId;
      context.turnId = nativeRunId;
      accepted.add(nativeRunId);
      acknowledged = true;
      for (const frame of early) project(frame);
      if (context.signal.aborted) abort();
      const slice = this.options.waitSliceMs ?? 30_000;
      let status = "";
      while (true) {
        const receipt = object(
          await this.client.request(
            "agent.wait",
            { runId: nativeRunId, timeoutMs: slice },
            { timeoutMs: slice + 5_000, signal: waitController.signal },
          ),
        );
        status = String(receipt.status ?? "").toLowerCase();
        if (!["timeout", "pending", "running", "working"].includes(status))
          break;
      }
      // agent.wait may report error for an aborted run; only the correlated
      // native acknowledgement, not the caller's signal, confirms cancellation.
      const nativeCanceled =
        (await cancellation) === true ||
        ["aborted", "cancelled", "canceled", "interrupted"].includes(status);
      settled = nativeCanceled || [
        "ok",
        "complete",
        "completed",
        "success",
        "aborted",
        "cancelled",
        "canceled",
        "interrupted",
        "error",
        "failed",
      ].includes(status);
      outcome = nativeCanceled
        ? { status: "cancelled" }
        : terminalError
          ? { status: "failed", error: terminalError }
          : ["ok", "complete", "completed", "success"].includes(status)
            ? { status: "completed" }
            : {
                status: "failed",
                error: `openclaw_gateway_${status || "terminal_unknown"}`,
                ...(!settled ? { outcomeUnknown: true } : {}),
              };
      // Only this run's events can supply its answer. Old chat.history entries are not a result.
      text = finalChatText ?? text;
      if (text.trim())
        queue.push({ type: "model.response", runId, text: text.trimEnd() });
    } catch (error) {
      outcome = {
        status: controller.signal.aborted ? "cancelled" : "failed",
        error: error instanceof Error ? error.message : String(error),
        ...(sent && !settled ? { outcomeUnknown: true } : {}),
      };
    } finally {
      if (sent && !settled) this.unsettled.add(lockKey);
      controller.abort(new Error("openclaw_turn_ended"));
      if (toolsBound && !this.closed)
        try {
          await this.client.request(
            "agent-host.unbind",
            { sessionKey, runId },
            { timeoutMs: 5_000 },
          );
        } catch (error) {
          outcome = {
            ...outcome,
            error:
              outcome.error ?? `openclaw_tool_cleanup_failed:${String(error)}`,
          };
        }
      for (const stop of cleanup.reverse()) stop();
      if (owns) this.active.delete(lockKey);
      queue.push({ type: "turn.finished", runId, outcome });
    }
  }
  async compact(sessionKey: string) {
    return compactOpenClaw(this.client, sessionKey);
  }
}
export async function selectOpenClawModel(
  client: OpenClawGatewayClient,
  sessionKey: string,
  requestedModel: string,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const selected = object(
    await client.request(
      "sessions.patch",
      { key: sessionKey, model: requestedModel },
      { timeoutMs: 30_000, signal },
    ),
  );
  const route = object(selected.resolved);
  const provider = String(route.modelProvider ?? ""),
    model = String(route.model ?? "");
  const canonical =
    provider && model
      ? model.toLowerCase().startsWith(`${provider.toLowerCase()}/`)
        ? model
        : `${provider}/${model}`
      : "";
  if (
    !canonical ||
    canonical.toLowerCase() !== requestedModel.trim().toLowerCase()
  )
    throw new Error(
      `openclaw_gateway_model_mismatch:${requestedModel}:${canonical || "unknown"}`,
    );
  return {
    sessionKey: typeof selected.key === "string" ? selected.key : sessionKey,
    requestedModel,
    canonicalModel: canonical,
  };
}
export async function compactOpenClaw(
  client: OpenClawGatewayClient,
  sessionKey: string,
) {
  const result = object(
    await client.request(
      "sessions.compact",
      { key: sessionKey },
      { timeoutMs: 120_000 },
    ),
  );
  return result.compacted === true
    ? { ok: true, compacted: true }
    : {
        ok: false,
        compacted: false,
        error: String(result.reason ?? "openclaw_compaction_not_confirmed"),
      };
}
function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}
function extractText(value: unknown): string {
  const obj = object(value);
  if (typeof obj.text === "string") return obj.text;
  if (typeof obj.delta === "string") return obj.delta;
  if (typeof obj.content === "string") return obj.content;
  return Array.isArray(obj.content)
    ? obj.content
        .map((value) => object(value))
        .filter((value) => value.type === "text")
        .map((value) => String(value.text ?? ""))
        .join("")
    : "";
}
