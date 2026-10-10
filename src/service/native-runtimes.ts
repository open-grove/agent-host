import { createHash } from "node:crypto";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { CodexAgent, type CodexAgentOptions } from "../codex/session.js";
import { AcpAgent, type AcpAgentOptions } from "../acp/session.js";
import { ClaudeAgent, type ClaudeAgentOptions } from "../claude/session.js";
import { PiAgent, type PiAgentOptions } from "../pi/session.js";
import { HermesAgent, type HermesAgentOptions } from "../hermes/session.js";
import {
  OpenClawAgent,
  type OpenClawAgentOptions,
} from "../openclaw/session.js";
import { FileBindingStore } from "../file-bindings.js";
import type { JsonObject } from "../types.js";
import type { RuntimeTurn, ServiceRuntime } from "./runtime.js";
import type { ServiceEvent } from "./protocol.js";

interface BaseConfig {
  id: string;
  cwd: string;
  model?: string;
  configurationRevision?: string;
}
export type NativeRuntimeConfig = BaseConfig &
  (
    | {
        kernel: "codex";
        options?: CodexAgentOptions;
        thread?: JsonObject;
        turn?: JsonObject;
      }
    | { kernel: "claude"; options?: ClaudeAgentOptions }
    | {
        kernel: "opencode" | "kimi";
        options?: Omit<AcpAgentOptions, "command"> & { command?: string };
        effort?: string;
      }
    | { kernel: "pi"; options?: PiAgentOptions }
    | {
        kernel: "hermes";
        options: HermesAgentOptions;
        provider?: string;
        reasoningEffort?: string;
      }
    | { kernel: "openclaw"; options: OpenClawAgentOptions }
  );

/** Server-owned launch configuration. No command, environment or credential is accepted from HTTP callers. */
export function createNativeRuntime(
  config: NativeRuntimeConfig,
  stateDirectory: string,
): ServiceRuntime {
  const cwd = resolve(config.cwd);
  const root = join(
    resolve(stateDirectory),
    "runtimes",
    createHash("sha256").update(config.id).digest("hex"),
  );
  const bindings = new FileBindingStore(join(root, "bindings"));
  const configurationKey = createHash("sha256")
    .update(
      JSON.stringify({ ...config, cwd }, (_key, value: unknown) =>
        typeof value === "function" ? String(value) : value,
      ),
    )
    .digest("hex");
  let command: string | undefined;
  let env: NodeJS.ProcessEnv | undefined;
  let run: ServiceRuntime["run"];
  let close: ServiceRuntime["close"];
  let steer: ServiceRuntime["steer"];
  let compact:
    | ((
        request: RuntimeTurn,
      ) => Promise<{
        ok: boolean;
        compacted: boolean;
        error?: string;
        outcomeUnknown?: boolean;
      }>)
    | undefined;
  let nativeCompaction = false;
  switch (config.kernel) {
    case "codex": {
      command = config.options?.command ?? "codex";
      env = config.options?.env;
      const agent = new CodexAgent({ ...config.options, command, bindings });
      run = (request) =>
        agent.run({
          ...request,
          cwd,
          thread: {
            sandbox: "read-only",
            approvalPolicy: "on-request",
            ...config.thread,
            ...(config.model ? { model: config.model } : {}),
          },
          turn: config.turn,
        });
      close = () => agent.close();
      steer = (sessionId, input) => agent.steer(sessionId, input);
      nativeCompaction = true;
      break;
    }
    case "claude": {
      command = config.options?.command;
      env = config.options?.env;
      const agent = new ClaudeAgent({ ...config.options, bindings });
      run = (request) => agent.run({ ...request, cwd, model: config.model });
      close = () => agent.close();
      break;
    }
    case "opencode":
    case "kimi": {
      command = config.options?.command ?? config.kernel;
      env = config.options?.env;
      const agent = new AcpAgent({
        elicitation: { form: {} },
        ...config.options,
        command,
        cwd,
        bindings,
      });
      run = (request) =>
        agent.run({
          ...request,
          cwd,
          model: config.model,
          effort: config.effort,
        });
      close = () => agent.close();
      break;
    }
    case "pi": {
      const agent = new PiAgent({
        ...config.options,
        cwd,
        sessionRoot: config.options?.sessionRoot ?? join(root, "native"),
        bindings,
      });
      run = (request) => agent.run({ ...request, cwd, model: config.model });
      close = () => agent.close();
      steer = (sessionId, input) => agent.steer(sessionId, input);
      compact = (request) =>
        agent.compact(request.sessionId, request.input || undefined);
      break;
    }
    case "hermes": {
      command = config.options.command;
      env = {
        ...process.env,
        ...config.options.env,
        HERMES_HOME: config.options.env?.HERMES_HOME ?? join(root, "native"),
      };
      const agent = new HermesAgent({
        ...config.options,
        exclusiveProfile: true,
        command,
        cwd,
        env,
        bindings,
      });
      run = (request) =>
        agent.run({
          ...request,
          cwd,
          model: config.model,
          provider: config.provider,
          reasoningEffort: config.reasoningEffort,
        });
      close = () => agent.close();
      steer = (sessionId, input) => agent.steer(sessionId, input);
      compact = (request) =>
        agent.compact(request.sessionId, request.input || undefined);
      break;
    }
    case "openclaw": {
      const agent = new OpenClawAgent({ ...config.options, bindings });
      run = (request) => agent.run({ ...request, cwd, model: config.model });
      close = () => agent.close();
      compact = async (request) => {
        const binding = await bindings.get(request.sessionId);
        if (!binding)
          return { ok: false, compacted: false, error: "session_not_found" };
        return agent.compact(binding.threadId);
      };
      break;
    }
  }
  return {
    id: config.id,
    kernel: config.kernel,
    cwd,
    model: config.model,
    configurationKey,
    maxConcurrentRuns: config.kernel === "hermes" ? 1 : 16,
    supportsCompaction: nativeCompaction || Boolean(compact),
    steer,
    close,
    async *run(request): AsyncIterable<ServiceEvent> {
      if (request.mode !== "compact" || nativeCompaction) {
        yield* run(request);
        return;
      }
      if (!compact) throw new Error("compaction_unsupported");
      request.signal.throwIfAborted();
      yield { type: "turn.started", runId: request.runId };
      const result = await compact(request);
      yield {
        type: "turn.finished",
        runId: request.runId,
        outcome:
          result.ok && result.compacted
            ? { status: "completed" }
            : {
                status: "failed",
                error: result.error ?? "compaction_not_confirmed",
                outcomeUnknown: result.outcomeUnknown,
              },
      };
    },
    async inspect() {
      try {
        if (!statSync(cwd).isDirectory())
          return { available: false, reason: "workspace_not_directory" };
      } catch {
        return { available: false, reason: "workspace_not_found" };
      }
      if (command && !commandExists(command, env, cwd))
        return { available: false, reason: "command_not_found" };
      if (config.kernel === "pi" && !config.model && !config.options?.model)
        return { available: false, reason: "pi_model_selection_required" };
      return { available: true };
    },
  };
}

function commandExists(
  command: string,
  env: NodeJS.ProcessEnv | undefined,
  cwd: string,
) {
  const names =
    process.platform === "win32" && !/\.[^/\\]+$/.test(command)
      ? [
          command,
          ...(env?.PATHEXT ?? process.env.PATHEXT ?? ".EXE;.CMD;.BAT")
            .split(";")
            .map((extension) => command + extension),
        ]
      : [command];
  const paths =
    command.includes("/") || command.includes("\\") || isAbsolute(command)
      ? [cwd]
      : (env?.PATH ?? process.env.PATH ?? "").split(delimiter);
  return paths.some((directory) =>
    names.some((name) => {
      try {
        const path = resolve(directory, name);
        if (!statSync(path).isFile()) return false;
        accessSync(
          path,
          /\.[cm]?js$/i.test(path) || process.platform === "win32"
            ? constants.R_OK
            : constants.X_OK,
        );
        return true;
      } catch {
        return false;
      }
    }),
  );
}
