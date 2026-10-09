import {
  query as nativeQuery,
  type Options,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { AsyncEventQueue } from "../async-event-queue.js";
import { runWithNativeSessionLock } from "../native-session-lock.js";

export type ClaudeQueryFunction = (params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}) => Query;
export interface ClaudeQueryRequest {
  /** The exact native session identity; shared across compaction and normal turns. */
  sessionId: string;
  prompt: string | AsyncIterable<SDKUserMessage>;
  options: Options;
  cancellationGraceMs?: number;
  onQuery?(query: Query): void;
  onAutoFallback?(reason: string): void;
  afterMessage?(message: SDKMessage, query: Query): Promise<void>;
  onComplete?(query: Query): Promise<void>;
}

/** SDK process, input gating and disposal extracted from OpenGrove. */
export class ClaudeQueryHost {
  private readonly queries = new Set<Query>();
  private closed = false;
  constructor(private readonly query: ClaudeQueryFunction = nativeQuery) {}
  close(): void {
    this.closed = true;
    for (const query of this.queries) query.close();
  }
  async *stream(request: ClaudeQueryRequest): AsyncIterable<SDKMessage> {
    const queue = new AsyncEventQueue<SDKMessage>();
    const controller = new AbortController();
    const sourceSignal = request.options.abortController?.signal;
    const abort = () => controller.abort(sourceSignal?.reason);
    sourceSignal?.addEventListener("abort", abort, { once: true });
    if (sourceSignal?.aborted) abort();
    const producer = runWithNativeSessionLock(
      "claude-code",
      request.sessionId,
      async () => {
        if (this.closed) throw new Error("agent_closed");
        controller.signal.throwIfAborted();
        // Auto permission activation must finish before sending the user prompt.
        const input =
          request.options.permissionMode === "auto"
            ? new AsyncEventQueue<SDKUserMessage>()
            : undefined;
        let permissionMode = request.options.permissionMode;
        const query = this.query({
          prompt: input ?? request.prompt,
          options: { ...request.options, abortController: controller },
        });
        this.queries.add(query);
        let grace: ReturnType<typeof setTimeout> | undefined;
        const cancel = () => {
          grace ??= setTimeout(
            () => query.close(),
            request.cancellationGraceMs ?? 15_000,
          );
        };
        controller.signal.addEventListener("abort", cancel, { once: true });
        const switchToAsk = async (cause: unknown) => {
          controller.signal.throwIfAborted();
          const reason = cause instanceof Error ? cause.message : String(cause);
          try {
            await query.setPermissionMode("default");
          } catch (error) {
            throw new Error(
              `runtime_access_mode_unavailable: claude_auto_review_fallback_failed: Auto: ${reason}; Ask: ${String(error)}`,
              { cause: error },
            );
          }
          controller.signal.throwIfAborted();
          permissionMode = "default";
          request.onAutoFallback?.(reason);
        };
        try {
          request.onQuery?.(query);
          if (input) {
            try {
              await query.setPermissionMode("auto");
            } catch (error) {
              await switchToAsk(error);
            }
            if (typeof request.prompt === "string")
              input.push(userMessage(request.prompt, request.sessionId));
            else
              for await (const message of request.prompt) {
                controller.signal.throwIfAborted();
                input.push(message);
              }
            input.close();
          }
          for await (const message of query) {
            if (
              message.type === "system" &&
              message.subtype === "init" &&
              permissionMode === "auto" &&
              message.permissionMode !== "auto"
            )
              await switchToAsk(
                new Error(
                  `Claude reported ${message.permissionMode} instead of Auto`,
                ),
              );
            queue.push(message);
            await request.afterMessage?.(message, query);
          }
          await request.onComplete?.(query);
        } finally {
          controller.signal.removeEventListener("abort", cancel);
          if (grace) clearTimeout(grace);
          input?.close();
          query.close();
          this.queries.delete(query);
        }
      },
    ).then(
      () => queue.close(),
      (error) => queue.fail(error),
    );
    try {
      for await (const message of queue) yield message;
    } finally {
      sourceSignal?.removeEventListener("abort", abort);
      controller.abort();
      await producer;
    }
  }
}
export function userMessage(text: string, sessionId: string): SDKUserMessage {
  return {
    type: "user",
    session_id: sessionId,
    parent_tool_use_id: null,
    message: { role: "user", content: text },
  };
}
