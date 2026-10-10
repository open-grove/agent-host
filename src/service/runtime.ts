import type { AgentEvent, InteractionContext, ProductTool } from "../agent.js";
import type { JsonValue } from "../types.js";
import type { RuntimeDescription, ServiceEvent } from "./protocol.js";

export interface RuntimeTurn {
  sessionId: string;
  runId: string;
  input: string;
  instructions: string;
  context?: string;
  tools: ProductTool[];
  signal: AbortSignal;
  mode: "turn" | "compact";
  onRequest(
    request: { method: string; params?: JsonValue },
    context: InteractionContext,
  ): Promise<JsonValue | undefined>;
}
/** Optional service composition over the existing adapters; it never implements a model loop. */
export interface ServiceRuntime {
  id: string;
  kernel: string;
  cwd: string;
  model?: string;
  /** Must change when native runtime configuration changes. Contains no credentials. */
  configurationKey: string;
  run(request: RuntimeTurn): AsyncIterable<ServiceEvent | AgentEvent>;
  steer?(sessionId: string, input: string): Promise<unknown>;
  supportsCompaction?: boolean;
  maxConcurrentRuns?: number;
  inspect?(): Promise<Pick<RuntimeDescription, "available" | "reason">>;
  close(): void | Promise<void>;
}
