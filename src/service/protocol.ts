import { z } from "zod";
import type { AgentEvent, ProductToolResult } from "../agent.js";
import type { JsonValue } from "../types.js";

/** Native JSON objects may contain undefined fields; the wire format cannot. */
export function wireJson(value: JsonValue) {
  return z.json().parse(JSON.parse(JSON.stringify(value)));
}

export const idSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/);
export const toolSchema = z
  .object({
    name: z.string().min(1).max(160),
    description: z.string().max(20_000),
    inputSchema: z.json(),
    namespace: z.string().min(1).max(160).optional(),
    deferLoading: z.boolean().optional(),
    timeoutMs: z.number().int().min(50).max(3_600_000).default(120_000),
  })
  .strict();
export type ToolDefinition = z.output<typeof toolSchema>;
export const startRunSchema = z
  .object({
    sessionId: idSchema,
    runtimeId: idSchema,
    instructions: z.string().max(200_000).default(""),
    input: z.string().max(1_000_000),
    context: z.union([z.string(), z.record(z.string(), z.json())]).optional(),
    tools: z.array(toolSchema).max(100).default([]),
    mode: z.enum(["turn", "compact"]).default("turn"),
    timeoutMs: z.number().int().min(100).max(86_400_000).default(3_600_000),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      new Set(value.tools.map((tool) => `${tool.namespace ?? ""}/${tool.name}`))
        .size !== value.tools.length
    )
      ctx.addIssue({ code: "custom", message: "duplicate_tool_name" });
    if (value.mode === "turn" && !value.input.trim())
      ctx.addIssue({ code: "custom", message: "input_required" });
  });
export type StartRunInput = z.input<typeof startRunSchema>;
export type StartRun = z.output<typeof startRunSchema>;
export const outcomeSchema = z
  .object({
    status: z.enum(["completed", "cancelled", "failed"]),
    error: z.string().optional(),
    outcomeUnknown: z.boolean().optional(),
  })
  .strict();
export const runSchema = z
  .object({
    id: idSchema,
    sessionId: idSchema,
    runtimeId: idSchema,
    createdAt: z.string(),
    finishedAt: z.string().optional(),
    status: z.enum(["running", "completed", "cancelled", "failed"]),
    outcome: outcomeSchema.optional(),
    answer: z.string(),
    outputAvailable: z.boolean(),
    sequence: z.number().int().nonnegative(),
  })
  .strict();
export type RunRecord = z.infer<typeof runSchema>;
export const sessionSchema = z
  .object({
    id: idSchema,
    runtimeId: idSchema,
    instructions: z.string(),
    tools: z.array(toolSchema),
    configurationKey: z.string(),
    createdAt: z.string(),
  })
  .strict();
export type SessionRecord = z.infer<typeof sessionSchema>;
export const callSchema = z
  .object({
    id: idSchema,
    runId: idSchema,
    kind: z.enum(["tool", "interaction"]),
    name: z.string(),
    namespace: z.string().optional(),
    input: z.json(),
    nativeCallId: z.string().optional(),
    sessionId: z.string(),
    threadId: z.string(),
    turnId: z.string(),
    createdAt: z.string(),
    deadlineAt: z.string(),
    status: z.enum(["pending", "completed", "cancelled", "timed_out"]),
    result: z.json().optional(),
  })
  .strict();
export type PendingCall = z.infer<typeof callSchema>;
export const productResultSchema = z
  .object({
    success: z.boolean(),
    contentItems: z.array(
      z.discriminatedUnion("type", [
        z.object({ type: z.literal("inputText"), text: z.string() }).strict(),
        z
          .object({ type: z.literal("inputImage"), imageUrl: z.string() })
          .strict(),
      ]),
    ),
  })
  .strict() satisfies z.ZodType<ProductToolResult>;
export type ServiceEvent =
  | AgentEvent
  | { type: "native.response"; runId: string; response: JsonValue | undefined };
export interface EventPage {
  events: Array<{ sequence: number; event: ServiceEvent }>;
  cursor: number;
  hasMore: boolean;
  historyTruncated: boolean;
}
export interface RuntimeDescription {
  id: string;
  kernel: string;
  cwd: string;
  model?: string;
  controls: { steer: boolean; compact: boolean };
  available: boolean;
  reason?: string;
}
export class HostError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
