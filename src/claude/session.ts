import { createHash, randomUUID } from "node:crypto";
import { type Options } from "@anthropic-ai/claude-agent-sdk";
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
import { ClaudeQueryHost, type ClaudeQueryFunction } from "./query.js";
import { createClaudeMcpServer } from "./schema.js";

export interface ClaudeRunRequest {
  sessionId: string;
  runId?: string;
  cwd: string;
  instructions: string;
  context?: string;
  input: string;
  tools?: ProductTool[];
  signal?: AbortSignal;
  model?: string;
  /** Native SDK options, including hooks, effort, MCP, budget and settings. */
  native?: Options;
  bindings?: BindingStore;
  bindingFingerprint?: string;
  onRequest?(
    request: { method: string; params: JsonObject },
    context: InteractionContext,
  ): Promise<JsonValue | undefined>;
}
export interface ClaudeAgentOptions {
  command?: string;
  env?: NodeJS.ProcessEnv;
  bindings?: BindingStore;
  query?: ClaudeQueryFunction;
  cancellationGraceMs?: number;
  native?: Options;
}

export class ClaudeAgent {
  private readonly host: ClaudeQueryHost;
  private readonly bindings: BindingStore;
  private readonly active = new Map<string, AbortController>();
  constructor(private readonly options: ClaudeAgentOptions = {}) {
    this.host = new ClaudeQueryHost(options.query);
    this.bindings = options.bindings ?? new MemoryBindingStore();
  }
  async close(): Promise<void> {
    for (const controller of this.active.values()) controller.abort();
    this.host.close();
  }
  async *run(request: ClaudeRunRequest): AsyncIterable<AgentEvent> {
    const queue = new AsyncEventQueue<AgentEvent>();
    const controller = new AbortController();
    const abort = () => controller.abort(request.signal?.reason);
    request.signal?.addEventListener("abort", abort, { once: true });
    if (request.signal?.aborted) abort();
    const producer = this.execute(request, controller, queue).finally(() =>
      queue.close(),
    );
    try {
      for await (const event of queue) yield event;
    } finally {
      controller.abort();
      request.signal?.removeEventListener("abort", abort);
      await producer;
    }
  }

  private async execute(
    request: ClaudeRunRequest,
    controller: AbortController,
    queue: AsyncEventQueue<AgentEvent>,
  ) {
    const runId = request.runId ?? randomUUID();
    const context: InteractionContext = {
      sessionId: request.sessionId,
      runId,
      threadId: "",
      turnId: "",
      signal: controller.signal,
    };
    const emit = (event: AgentEvent) => queue.push(event);
    emit({ type: "turn.started", runId });
    let text = "";
    let registered = false;
    let started = false;
    let resultSeen = false;
    let outcome: TurnOutcome = {
      status: "failed",
      error: "native_terminal_missing",
      outcomeUnknown: true,
    };
    try {
      if (this.active.has(request.sessionId)) throw new Error("session_busy");
      this.active.set(request.sessionId, controller);
      registered = true;
      context.signal.throwIfAborted();
      const native = { ...this.options.native, ...request.native };
      const fingerprint =
        request.bindingFingerprint ??
        createHash("sha256")
          .update(
            JSON.stringify({
              cwd: request.cwd,
              instructions: request.instructions,
              tools: request.tools?.map(({ execute: _, ...spec }) => spec),
              env: this.options.env,
              command: this.options.command,
              settingSources: native.settingSources,
            }),
          )
          .digest("hex");
      const store = request.bindings ?? this.bindings;
      const binding = await store.get(request.sessionId);
      if (binding && binding.fingerprint !== fingerprint)
        throw new Error("session_configuration_changed");
      const sessionId = binding?.threadId ?? randomUUID();
      context.threadId = sessionId;
      let callSequence = 0;
      const toolNames = new Set(request.tools?.map((tool) => tool.name) ?? []);
      const mcp = request.tools?.length
        ? createClaudeMcpServer({
            name: "agent_host",
            version: "0.1.0",
            tools: request.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: object(tool.inputSchema),
            })),
            call: async (name, input) => {
              const tool = request.tools!.find((tool) => tool.name === name);
              if (!tool) throw new Error("tool_not_available");
              const callId = `${runId}:tool:${++callSequence}`;
              context.signal.throwIfAborted();
              if (!tool.execute) throw new Error("tool_not_available");
              emit({
                type: "tool.started",
                runId,
                callId,
                tool: tool.name,
                input: json(input),
              });
              const result = await abortable(
                tool.execute(json(input), { ...context, callId }),
                context.signal,
              ).catch((error) => ({
                success: false,
                contentItems: [
                  { type: "inputText" as const, text: String(error) },
                ],
              }));
              emit({
                type: "tool.finished",
                runId,
                callId,
                tool: tool.name,
                result,
              });
              return {
                isError: !result.success,
                content: result.contentItems.map((item) =>
                  item.type === "inputText"
                    ? { type: "text" as const, text: item.text }
                    : {
                        type: "resource_link" as const,
                        uri: item.imageUrl,
                        name: "image",
                      },
                ),
              };
            },
          })
        : undefined;
      const nativePermission = native.canUseTool;
      const nativeElicitation = native.onElicitation;
      const options: Options = {
        ...native,
        cwd: request.cwd,
        env: { ...process.env, ...this.options.env, ...native.env },
        pathToClaudeCodeExecutable:
          this.options.command ?? native.pathToClaudeCodeExecutable,
        abortController: controller,
        includePartialMessages: true,
        includeHookEvents: true,
        supportedDialogKinds: native.supportedDialogKinds ?? [],
        settingSources: native.settingSources ?? ["user", "project", "local"],
        permissionMode: native.permissionMode ?? "default",
        model: request.model ?? native.model,
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: request.instructions,
        },
        ...(binding
          ? { resume: sessionId, sessionId: undefined }
          : { sessionId, resume: undefined }),
        mcpServers: {
          ...native.mcpServers,
          ...(mcp ? { agent_host: mcp } : {}),
        },
        canUseTool: async (name, input, options) => {
          if (
            name.startsWith("mcp__agent_host__") &&
            toolNames.has(name.slice("mcp__agent_host__".length))
          )
            return { behavior: "allow", toolUseID: options.toolUseID };
          if (nativePermission)
            return await abortable(
              nativePermission(name, input, options),
              context.signal,
            );
          const answer = object(
            await abortable(
              request.onRequest?.(
                {
                  method:
                    name === "AskUserQuestion"
                      ? "AskUserQuestion"
                      : "permission",
                  params: object(
                    json({
                      name,
                      input,
                      toolUseID: options.toolUseID,
                      mcpServer: options.mcpServer,
                      defaultToNo: options.defaultToNo,
                      suppressAlwaysAllowRule: options.suppressAlwaysAllowRule,
                    }),
                  ),
                },
                context,
              ) ?? Promise.resolve(undefined),
              context.signal,
            ),
          );
          if (answer.behavior === "allow")
            return {
              behavior: "allow",
              toolUseID: options.toolUseID,
              updatedInput: object(answer.updatedInput ?? input),
            };
          return {
            behavior: "deny",
            toolUseID: options.toolUseID,
            message:
              typeof answer.message === "string"
                ? answer.message
                : "The product declined this operation.",
          };
        },
        onElicitation: async (elicitation, options) => {
          if (nativeElicitation)
            return await abortable(
              nativeElicitation(elicitation, options),
              context.signal,
            );
          const answer = object(
            await abortable(
              request.onRequest?.(
                {
                  method: "elicitation/create",
                  params: object(json(elicitation)),
                },
                context,
              ) ?? Promise.resolve(undefined),
              context.signal,
            ),
          );
          if (answer.action !== "accept") return { action: "decline" };
          const content: Record<string, string | number | boolean | string[]> =
            {};
          for (const [key, value] of Object.entries(object(answer.content))) {
            if (
              typeof value === "string" ||
              typeof value === "number" ||
              typeof value === "boolean" ||
              (Array.isArray(value) &&
                value.every((item) => typeof item === "string"))
            )
              content[key] = value as string | number | boolean | string[];
          }
          return { action: "accept", content };
        },
      };
      const prompt = [request.context, request.input]
        .filter(Boolean)
        .join("\n\n");
      started = true;
      for await (const message of this.host.stream({
        sessionId,
        prompt,
        options,
        cancellationGraceMs: this.options.cancellationGraceMs,
      })) {
        if (message.type === "system" && message.subtype === "init") {
          if (message.session_id !== sessionId)
            throw new Error("native_session_id_mismatch");
          await store.set(request.sessionId, {
            threadId: sessionId,
            fingerprint,
          });
          emit({
            type: "session.bound",
            runId,
            threadId: sessionId,
            resumed: !!binding,
          });
        }
        emit({
          type: "native.notification",
          runId,
          threadId: sessionId,
          turnId: "",
          notification: { method: "claude.message", params: json(message) },
        });
        if (
          message.type === "stream_event" &&
          message.event.type === "content_block_delta" &&
          message.event.delta.type === "text_delta"
        ) {
          text += message.event.delta.text;
          emit({
            type: "assistant.delta",
            runId,
            text: message.event.delta.text,
          });
        }
        if (message.type === "result") {
          resultSeen = true;
          if (message.subtype === "success") text = message.result || text;
          outcome = message.is_error
            ? {
                status: "failed",
                error:
                  message.subtype === "success"
                    ? message.result
                    : message.errors.join("\n"),
              }
            : { status: "completed" };
        }
      }
    } catch (error) {
      outcome =
        context.signal.aborted && !started
          ? { status: "cancelled" }
          : {
              status: context.signal.aborted ? "cancelled" : "failed",
              error: error instanceof Error ? error.message : String(error),
              ...(started && !resultSeen ? { outcomeUnknown: true } : {}),
            };
    } finally {
      controller.abort();
      if (registered) this.active.delete(request.sessionId);
      emit({ type: "model.response", runId, text });
      emit({ type: "turn.finished", runId, outcome });
    }
  }
}
function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value));
}
function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
