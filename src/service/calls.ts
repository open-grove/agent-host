// Adapted from OpenGrove PR #126, src/server/client-tool-calls.ts (Apache-2.0).
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { InteractionContext, ProductTool } from "../agent.js";
import type { JsonValue } from "../types.js";
import {
  HostError,
  productResultSchema,
  wireJson,
  type PendingCall,
  type ToolDefinition,
} from "./protocol.js";
import type { TaskStore } from "./store.js";

export class CallBroker {
  private readonly pending = new Map<
    string,
    { settle(result?: JsonValue, error?: Error): void }
  >();
  private closed = false;
  constructor(
    private readonly store: TaskStore,
    private readonly runId: string,
    private readonly signal: AbortSignal,
    private readonly interactionTimeoutMs: number,
  ) {}

  tools(specs: ToolDefinition[]): ProductTool[] {
    return specs.map(({ timeoutMs, ...spec }) => ({
      ...spec,
      execute: async (input, context) => {
        try {
          return productResultSchema.parse(
            await this.request(
              "tool",
              spec.name,
              input,
              context,
              timeoutMs,
              context.callId,
              spec.namespace,
            ),
          );
        } catch (error) {
          return {
            success: false,
            contentItems: [
              {
                type: "inputText",
                text: error instanceof Error ? error.message : String(error),
              },
            ],
          };
        }
      },
    }));
  }
  interaction(
    request: { method: string; params?: JsonValue },
    context: InteractionContext,
  ): Promise<JsonValue> {
    return this.request(
      "interaction",
      request.method,
      request.params ?? null,
      context,
      this.interactionTimeoutMs,
    );
  }
  resolve(id: string, result: JsonValue) {
    const call = this.store.call(id);
    if (!call || call.runId !== this.runId)
      throw new HostError(404, "call_not_found");
    if (call.kind === "tool") productResultSchema.parse(result);
    if (call.status === "completed") {
      if (!isDeepStrictEqual(call.result, result))
        throw new HostError(409, "call_result_conflict");
      return;
    }
    if (
      call.status !== "pending" ||
      this.closed ||
      this.signal.aborted ||
      Date.now() >= Date.parse(call.deadlineAt)
    )
      throw new HostError(409, "call_not_pending");
    const pending = this.pending.get(id);
    if (!pending) throw new HostError(409, "call_not_live");
    this.store.saveCall({
      ...call,
      status: "completed",
      result: wireJson(result),
    });
    pending.settle(result);
  }
  close() {
    this.closed = true;
    for (const item of [...this.pending.values()])
      item.settle(undefined, new Error("call_outcome_unknown:run_ended"));
  }
  private request(
    kind: PendingCall["kind"],
    name: string,
    input: JsonValue,
    context: InteractionContext,
    timeoutMs: number,
    nativeCallId?: string,
    namespace?: string,
  ): Promise<JsonValue> {
    if (this.closed || this.signal.aborted || context.signal.aborted)
      return Promise.reject(new Error("call_cancelled"));
    if (this.store.calls(this.runId).length >= 1_000)
      return Promise.reject(new Error("call_limit"));
    const now = Date.now();
    const call: PendingCall = {
      id: randomUUID(),
      runId: this.runId,
      kind,
      name,
      namespace,
      input: wireJson(input),
      nativeCallId,
      sessionId: context.sessionId,
      threadId: context.threadId,
      turnId: context.turnId,
      createdAt: new Date(now).toISOString(),
      deadlineAt: new Date(now + timeoutMs).toISOString(),
      status: "pending",
    };
    this.store.saveCall(call);
    return new Promise((resolve, reject) => {
      const settle = (result?: JsonValue, error?: Error) => {
        if (!this.pending.delete(call.id)) return;
        clearTimeout(timer);
        this.signal.removeEventListener("abort", abort);
        context.signal.removeEventListener("abort", abort);
        if (error) {
          try {
            this.store.saveCall({
              ...call,
              status: error.message.includes("deadline")
                ? "timed_out"
                : "cancelled",
            });
          } catch (storageError) {
            reject(storageError);
            return;
          }
          reject(error);
        } else resolve(result ?? null);
      };
      const abort = () =>
        settle(undefined, new Error("call_outcome_unknown:cancelled"));
      const timer = setTimeout(
        () => settle(undefined, new Error("call_outcome_unknown:deadline")),
        timeoutMs,
      );
      timer.unref();
      this.pending.set(call.id, { settle });
      this.signal.addEventListener("abort", abort, { once: true });
      context.signal.addEventListener("abort", abort, { once: true });
    });
  }
}
