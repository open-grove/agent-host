import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { abortable } from "../abortable.js";
import { AsyncEventQueue } from "../async-event-queue.js";
import {
  MemoryBindingStore,
  type AgentEvent,
  type BindingStore,
  type InteractionContext,
  type ProductTool,
  type TurnOutcome,
} from "../agent.js";
import type { JsonObject, JsonValue } from "../types.js";
import {
  StdioJsonRpcClient,
  type JsonRpcRequestHandler,
  type StdioJsonRpcClientOptions,
} from "../transport/stdio-json-rpc-client.js";
import { AcpHostToolBridgeServer } from "../acp/tool-bridge.js";
import { productToolBridge } from "../product-tool-bridge.js";
import type { HostToolBridge } from "../acp/tools.js";

export interface HermesAgentOptions extends StdioJsonRpcClientOptions {
  bindings?: BindingStore;
  /** Product-owned HERMES_HOME; permits updating only its Agent Host MCP entry. */
  exclusiveProfile?: boolean;
  requestTimeoutMs?: number;
  controlTimeoutMs?: number;
  cancellationGraceMs?: number;
}
export interface HermesRunRequest {
  sessionId: string;
  runId?: string;
  cwd: string;
  instructions: string;
  context?: string;
  input: string;
  tools?: ProductTool[];
  /** Alternative product policy/execution port, sharing the same scoped MCP transport. */
  toolBridge?: HostToolBridge;
  model?: string;
  provider?: string;
  reasoningEffort?: string;
  signal?: AbortSignal;
  bindings?: BindingStore;
  bindingFingerprint?: string;
  onRequest?(
    request: Parameters<JsonRpcRequestHandler>[0],
    context: InteractionContext,
  ): Promise<JsonValue | undefined>;
  beforeTurn?(
    client: StdioJsonRpcClient,
    context: InteractionContext & { resumed: boolean; liveSessionId: string },
  ): Promise<void>;
}
export type HermesEvent =
  | AgentEvent
  | { type: "native.response"; runId: string; response: JsonObject };
interface OpenSession {
  liveId: string;
  storedId: string;
  fingerprint: string;
}

/** Hermes 0.21.6 TUI Gateway. One active turn per isolated native profile. */
export class HermesAgent {
  private client?: StdioJsonRpcClient;
  private closed = false;
  private active?: AbortController;
  private readonly opened = new Map<string, OpenSession>();
  private readonly bindings: BindingStore;
  private readonly bridge = new AcpHostToolBridgeServer();
  private configuredBridge?: string;
  constructor(private readonly options: HermesAgentOptions) {
    this.bindings = options.bindings ?? new MemoryBindingStore();
  }
  connect(): StdioJsonRpcClient {
    if (this.closed) throw new Error("agent_closed");
    if (!this.client || this.client.isClosed()) {
      this.opened.clear();
      this.configuredBridge = undefined;
      this.client = StdioJsonRpcClient.start(this.options);
    }
    return this.client;
  }
  close(): void {
    this.closed = true;
    this.active?.abort(new Error("agent_closed"));
    this.client?.close();
    this.bridge.close();
  }
  async *run(request: HermesRunRequest): AsyncIterable<HermesEvent> {
    const controller = new AbortController();
    const cancel = () => controller.abort(request.signal?.reason);
    if (request.signal?.aborted) cancel();
    request.signal?.addEventListener("abort", cancel, { once: true });
    const queue = new AsyncEventQueue<HermesEvent>();
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
    request: HermesRunRequest,
    controller: AbortController,
    queue: AsyncEventQueue<HermesEvent>,
  ) {
    const runId = request.runId ?? randomUUID();
    const pending = new AbortController();
    const signal = controller.signal;
    const context: InteractionContext = {
      sessionId: request.sessionId,
      runId,
      threadId: "",
      turnId: "",
      signal: AbortSignal.any([signal, pending.signal]),
    };
    const cleanup: Array<() => void> = [];
    let client: StdioJsonRpcClient | undefined;
    let owns = false;
    let submitted = false;
    let terminal = false;
    let outcome: TurnOutcome = {
      status: "failed",
      error: "native_terminal_missing",
      outcomeUnknown: true,
    };
    let liveId = "";
    let text = "";
    queue.push({ type: "turn.started", runId });
    try {
      if (this.active) throw new Error("hermes_profile_busy");
      this.active = controller;
      owns = true;
      signal.throwIfAborted();
      client = this.connect();
      const fingerprint =
        request.bindingFingerprint ??
        hash(
          JSON.stringify({
            cwd: resolve(request.cwd),
            instructions: request.instructions,
            tools: request.tools?.map(({ execute: _, ...spec }) => spec),
            descriptors: request.toolBridge?.descriptors,
            model: request.model,
            provider: request.provider,
            effort: request.reasoningEffort,
          }),
        );
      const store = request.bindings ?? this.bindings;
      const binding = await store.get(request.sessionId);
      if (binding && binding.fingerprint !== fingerprint)
        throw new Error("session_configuration_changed");
      const rpcOptions = {
        signal,
        timeoutMs: this.options.controlTimeoutMs ?? 30_000,
      };
      const toolBridge =
        request.toolBridge ??
        (request.tools?.length
          ? productToolBridge(request.tools, context, queue)
          : undefined);
      let changedBridge = false;
      let bridgeFingerprint: string | undefined;
      if (toolBridge) {
        if (!this.options.exclusiveProfile)
          throw new Error("hermes_product_tools_require_exclusive_profile");
        const scoped = await this.bridge.prepare({
          scope: JSON.stringify({ sessionId: request.sessionId, fingerprint }),
          bridge: toolBridge,
        });
        scoped.activate(toolBridge);
        cleanup.push(() => scoped.deactivate(toolBridge));
        if (this.configuredBridge !== scoped.fingerprint) {
          const { command, args, env } = scoped.mcpServer;
          // Upstream add rejects duplicate names; replace only our entry in the exclusive profile.
          const existing = object(
            await client.request("mcp.servers.list", {}, rpcOptions),
          );
          if (
            Array.isArray(existing.servers) &&
            existing.servers.some(
              (value) => object(value).name === "agent-host",
            )
          )
            await client.request(
              "mcp.servers.remove",
              { name: "agent-host" },
              rpcOptions,
            );
          const added = object(
            await client.request(
              "mcp.servers.add",
              {
                name: "agent-host",
                config: {
                  command,
                  args,
                  env: Object.fromEntries(
                    env.map(({ name, value }) => [name, value]),
                  ),
                },
              },
              rpcOptions,
            ),
          );
          if (added.ok !== true)
            throw new Error("hermes_product_tools_configuration_failed");
          changedBridge = true;
          bridgeFingerprint = scoped.fingerprint;
        }
      }
      const open = this.opened.get(request.sessionId);
      if (
        open &&
        (open.fingerprint !== fingerprint ||
          open.storedId !== binding?.threadId)
      )
        throw new Error("session_binding_changed");
      let snapshot: JsonObject = {};
      if (!open) {
        snapshot = object(
          await client.request(
            binding ? "session.resume" : "session.create",
            binding
              ? {
                  session_id: binding.threadId,
                  omit_messages: true,
                  inline_images: false,
                }
              : {
                  cols: 100,
                  cwd: resolve(request.cwd),
                  cwd_explicit: true,
                  source: "cli",
                  idempotency_key: hash(`${request.sessionId}:${fingerprint}`),
                  ...(request.model ? { model: request.model } : {}),
                  ...(request.provider ? { provider: request.provider } : {}),
                  ...(request.reasoningEffort
                    ? { reasoning_effort: request.reasoningEffort }
                    : {}),
                },
            rpcOptions,
          ),
        );
        liveId = requiredString(
          snapshot.session_id,
          "hermes_live_session_id_missing",
        );
        const storedId = requiredString(
          snapshot.stored_session_id ??
            (binding ? snapshot.session_key : undefined),
          "hermes_stored_session_id_missing",
        );
        // Compression may advance the stored transcript to a native lineage tip.
        await store.set(request.sessionId, { threadId: storedId, fingerprint });
        this.opened.set(request.sessionId, { liveId, storedId, fingerprint });
      } else liveId = open.liveId;
      const native = this.opened.get(request.sessionId)!;
      context.threadId = native.storedId;
      context.turnId = liveId;
      if (
        snapshot.running === true ||
        snapshot.inflight != null ||
        snapshot.queued != null ||
        snapshot.pending_approval != null ||
        (Array.isArray(snapshot.open_requests) && snapshot.open_requests.length)
      )
        throw new Error("native_session_has_pending_work");
      queue.push({
        type: "session.bound",
        runId,
        threadId: native.storedId,
        resumed: !!binding,
      });
      let resolveTerminal!: (value: JsonObject) => void;
      let rejectTerminal!: (error: Error) => void;
      const completion = new Promise<JsonObject>((resolve, reject) => {
        resolveTerminal = resolve;
        rejectTerminal = reject;
      });
      void completion.catch(() => undefined);
      const interactions = new Map<string, AbortController>();
      cleanup.push(
        client.addRequestHandler(async (rpc) => {
          if (object(rpc.params).session_id !== liveId) return undefined;
          const fallback =
            rpc.method === "approval"
              ? { choice: "deny" }
              : rpc.method === "clarify"
                ? {}
                : ["sudo", "secret", "vault.code", "vault.password"].includes(
                      rpc.method,
                    )
                  ? { value: "" }
                  : undefined;
          const interaction = new AbortController();
          const id = String(rpc.id);
          interactions.set(id, interaction);
          const interactionContext = {
            ...context,
            signal: AbortSignal.any([context.signal, interaction.signal]),
          };
          try {
            interactionContext.signal.throwIfAborted();
            return (
              (await abortable(
                request.onRequest?.(rpc, interactionContext) ??
                  Promise.resolve(undefined),
                interactionContext.signal,
              )) ?? fallback
            );
          } catch (error) {
            if (!interactionContext.signal.aborted)
              rejectTerminal(
                error instanceof Error ? error : new Error(String(error)),
              );
            return fallback;
          } finally {
            interactions.delete(id);
          }
        }),
      );
      cleanup.push(
        client.addNotificationHandler((notification) => {
          const params = object(notification.params);
          if (notification.method !== "event" || params.session_id !== liveId)
            return;
          const payload = object(params.payload);
          if (params.type === "request.cancel")
            interactions
              .get(String(payload.id))
              ?.abort(new Error("native_request_withdrawn"));
          queue.push({
            type: "native.notification",
            runId,
            notification,
            threadId: context.threadId,
            turnId: liveId,
          });
          if (
            submitted &&
            params.type === "message.delta" &&
            typeof payload.text === "string"
          ) {
            text += payload.text;
            queue.push({ type: "assistant.delta", runId, text: payload.text });
          }
          if (submitted && params.type === "message.complete") {
            terminal = true;
            resolveTerminal(payload);
          }
          if (params.type === "error")
            rejectTerminal(
              new Error(String(payload.message ?? "hermes_gateway_error")),
            );
        }),
      );
      cleanup.push(client.addCloseHandler((error) => rejectTerminal(error)));
      if (changedBridge) {
        const reloaded = object(
          await client.request(
            "reload.mcp",
            { session_id: liveId, confirm: true },
            rpcOptions,
          ),
        );
        if (reloaded.status !== "reloaded")
          throw new Error("hermes_product_tools_reload_failed");
        this.configuredBridge = bridgeFingerprint;
      }
      await abortable(
        request.beforeTurn?.(client, {
          ...context,
          resumed: !!binding,
          liveSessionId: liveId,
        }) ?? Promise.resolve(),
        signal,
      );
      signal.throwIfAborted();
      let grace: ReturnType<typeof setTimeout> | undefined;
      const abort = () => {
        if (terminal) return;
        void client!
          .request(
            "session.interrupt",
            { session_id: liveId },
            { timeoutMs: 5_000 },
          )
          .catch((error) => rejectTerminal(error));
        grace ??= setTimeout(
          () => rejectTerminal(new Error("hermes_cancel_unsettled")),
          this.options.cancellationGraceMs ?? 15_000,
        );
      };
      signal.addEventListener("abort", abort, { once: true });
      cleanup.push(() => {
        signal.removeEventListener("abort", abort);
        if (grace) clearTimeout(grace);
      });
      submitted = true;
      const accepted = object(
        await client.request(
          "prompt.submit",
          {
            session_id: liveId,
            text: [request.instructions, request.context, request.input]
              .filter(Boolean)
              .join("\n\n"),
          },
          { timeoutMs: 30_000 },
        ),
      );
      if (accepted.status !== "streaming")
        throw new Error(`hermes_prompt_not_started:${String(accepted.status)}`);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      if (this.options.requestTimeoutMs !== undefined)
        timeout = setTimeout(
          () => rejectTerminal(new Error("hermes_turn_timed_out")),
          this.options.requestTimeoutMs,
        );
      cleanup.push(() => {
        if (timeout) clearTimeout(timeout);
      });
      const result = await completion;
      queue.push({ type: "native.response", runId, response: result });
      outcome =
        result.status === "complete"
          ? { status: "completed" }
          : result.status === "interrupted"
            ? { status: "cancelled" }
            : {
                status: "failed",
                error: String(
                  result.error ??
                    result.failure_reason ??
                    result.warning ??
                    "hermes_gateway_failed",
                ),
                ...(result.status !== "error" ? { outcomeUnknown: true } : {}),
              };
      const final = typeof result.text === "string" ? result.text : text;
      if (final) queue.push({ type: "model.response", runId, text: final });
    } catch (error) {
      outcome = {
        status: signal.aborted ? "cancelled" : "failed",
        error: error instanceof Error ? error.message : String(error),
        ...(submitted && !terminal ? { outcomeUnknown: true } : {}),
      };
      // This adapter owns one active producer per profile; closing cannot kill a sibling turn.
      if (owns && client && submitted && !terminal) {
        client.close();
        this.opened.clear();
      }
    } finally {
      pending.abort(new Error("hermes_turn_ended"));
      for (const stop of cleanup.reverse()) stop();
      if (owns && this.active === controller) this.active = undefined;
      queue.push({ type: "turn.finished", runId, outcome });
    }
  }
  async steer(sessionId: string, instruction: string): Promise<JsonObject> {
    const opened = this.opened.get(sessionId);
    if (!opened || !this.active) throw new Error("run_not_found");
    const result = object(
      await this.connect().request(
        "session.steer",
        { session_id: opened.liveId, text: instruction },
        { timeoutMs: 15_000 },
      ),
    );
    if (!["queued", "redirected"].includes(String(result.status)))
      throw new Error("hermes_steer_rejected");
    return result;
  }
  async compact(sessionId: string, reason?: string) {
    const opened = this.opened.get(sessionId);
    if (!opened)
      return { ok: false, compacted: false, error: "session_not_found" };
    return compactHermes(
      this.connect(),
      opened.liveId,
      reason,
      this.options.requestTimeoutMs,
    );
  }
}
/** Native receipt, not an RPC acknowledgement, determines whether compression finished. */
export async function compactHermes(
  client: StdioJsonRpcClient,
  liveSessionId: string,
  reason?: string,
  timeoutMs = 120_000,
) {
  const result = object(
    await client.request(
      "session.compress",
      { session_id: liveSessionId, ...(reason ? { focus_topic: reason } : {}) },
      { timeoutMs },
    ),
  );
  const compacted =
    result.status === "compressed" && result.compressed !== false;
  return {
    ok: compacted,
    compacted,
    ...(!compacted
      ? {
          error: `hermes_compression_${String(result.status ?? (result.lock_held ? "busy" : "unconfirmed"))}`,
        }
      : {}),
  };
}
function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}
function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function requiredString(value: unknown, error: string): string {
  if (typeof value !== "string" || !value) throw new Error(error);
  return value;
}
