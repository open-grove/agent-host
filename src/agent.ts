import type { JsonObject, JsonValue } from "./types.js";
export interface ProductToolResult {
  success: boolean;
  contentItems: Array<
    | { type: "inputText"; text: string }
    | { type: "inputImage"; imageUrl: string }
  >;
}
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
  async get(id: string) {
    return this.bindings.get(id);
  }
  async set(id: string, binding: SessionBinding) {
    this.bindings.set(id, { ...binding });
  }
}
export interface InteractionContext {
  sessionId: string;
  runId: string;
  threadId: string;
  turnId: string;
  signal: AbortSignal;
}
export interface ProductTool {
  name: string;
  description: string;
  inputSchema: JsonValue;
  deferLoading?: boolean;
  /** Optional native tool namespace; currently used by the Codex adapter. */
  namespace?: string;
  execute?(
    input: JsonValue,
    context: InteractionContext & { callId: string },
  ): Promise<ProductToolResult>;
}
export interface TurnOutcome {
  status: "completed" | "cancelled" | "failed";
  error?: string;
  outcomeUnknown?: boolean;
}
export type AgentEvent =
  | { type: "turn.started"; runId: string }
  | {
      type: "session.bound";
      runId: string;
      threadId: string;
      resumed: boolean;
      configuration?: JsonObject[];
    }
  | {
      type: "native.notification";
      runId: string;
      notification: { method: string; params?: JsonValue };
      threadId: string;
      turnId: string;
    }
  | { type: "assistant.delta"; runId: string; text: string }
  | {
      type: "tool.started";
      runId: string;
      callId: string;
      tool: string;
      input: JsonValue;
    }
  | {
      type: "tool.finished";
      runId: string;
      callId: string;
      tool: string;
      result: ProductToolResult;
    }
  | { type: "model.response"; runId: string; text: string }
  | { type: "turn.finished"; runId: string; outcome: TurnOutcome };
