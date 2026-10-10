import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";
import { resolveCommandInvocation } from "../environment/command.js";
import type { StdioJsonRpcClient } from "../transport/stdio-json-rpc-client.js";
export interface CompactionResult {
  ok: boolean;
  compacted: boolean;
  error?: string;
  outcomeUnknown?: boolean;
  usage?: { used?: number; size?: number };
}
function readAcpContextUsage(update: Record<string, unknown>) {
  if (update.sessionUpdate !== "usage_update") return undefined;
  return {
    used: typeof update.used === "number" ? update.used : undefined,
    size: typeof update.size === "number" ? update.size : undefined,
  };
}
export async function compactOpenCode(options: {
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  sessionId: string;
  model?: string;
  signal?: AbortSignal;
}): Promise<CompactionResult> {
  const runtimeEnv = options.env;
  let server: OpenCodeServerProcess | undefined;
  try {
    server = await startOpenCodeServer({
      command: options.command,
      cwd: resolve(options.cwd ?? process.cwd()),
      env: runtimeEnv,
    });
    const model =
      openCodeSummarizeModel(options.model, runtimeEnv) ??
      (await readOpenCodeDefaultSummarizeModel(server.url, options.signal));
    if (!model) {
      return {
        ok: false,
        compacted: false,
        error: "opencode_summarize_model_unavailable",
      };
    }

    const response = await fetch(
      `${server.url}/session/${encodeURIComponent(options.sessionId)}/summarize`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(model),
        signal: options.signal,
      },
    );
    const text = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        compacted: false,
        error: `opencode_summarize_failed:${response.status}:${text.slice(0, 240)}`,
      };
    }
    const compacted = text.trim() === "true" || parseBooleanJson(text) === true;
    return compacted
      ? { ok: true, compacted: true }
      : {
          ok: false,
          compacted: false,
          error: `opencode_summarize_not_confirmed:${text.slice(0, 240)}`,
        };
  } catch (error) {
    return {
      ok: false,
      compacted: false,
      error: error instanceof Error ? error.message : String(error),
      ...(options.signal?.aborted ? { outcomeUnknown: true } : {}),
    };
  } finally {
    await server?.close();
  }
}

export async function compactKimi(options: {
  client: StdioJsonRpcClient;
  sessionId: string;
  beforeUsed?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<CompactionResult> {
  const { client, sessionId: nativeSessionId, beforeUsed, signal } = options;
  let observedUsage: { used?: number; size?: number } | undefined;
  let commandText = "";
  let resolveCompletion: () => void = () => {};
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
  });
  let completionTimer: ReturnType<typeof setTimeout> | undefined;
  const startedAt = Date.now();
  const cleanupNotifications = client.addNotificationHandler((notification) => {
    if (
      notification.method !== "session/update" &&
      notification.method !== "session/notification"
    )
      return;
    const params = asObject(notification.params);
    if (readString(params, "sessionId") !== nativeSessionId) return;
    const update = asObject(params.update);
    const usage = readAcpContextUsage(update);
    if (usage) observedUsage = usage;
    if (readString(update, "sessionUpdate") === "agent_message_chunk") {
      commandText += readString(asObject(update.content), "text") ?? "";
    }
    if (
      readKimiCompactionResult(commandText) ||
      /Compaction cancelled|Compaction is blocked|\/compact failed:/i.test(
        commandText,
      ) ||
      (beforeUsed !== undefined &&
        observedUsage?.used !== undefined &&
        observedUsage.used < beforeUsed)
    ) {
      resolveCompletion();
    }
  });
  const cancelCompact = () => {
    client.notify("session/cancel", { sessionId: nativeSessionId });
    resolveCompletion();
  };
  if (signal?.aborted) cancelCompact();
  signal?.addEventListener("abort", cancelCompact, { once: true });
  try {
    await client.request(
      "session/prompt",
      {
        sessionId: nativeSessionId,
        prompt: [{ type: "text", text: "/compact" }],
      },
      { timeoutMs: options.timeoutMs ?? 120_000, signal },
    );
    // Kimi Code 0.41 ACP acknowledges /compact before its background task finishes:
    // https://github.com/MoonshotAI/kimi-code/blob/main/packages/acp-server/src/builtin-commands.ts
    // Keep listening for the native completion receipt; an acknowledgement is not success.
    if (
      /Context compaction started|A context compaction is already running/i.test(
        commandText,
      )
    ) {
      const remainingMs = Math.max(
        0,
        (options.timeoutMs ?? 120_000) - (Date.now() - startedAt),
      );
      completionTimer = setTimeout(resolveCompletion, remainingMs);
      await completion;
      if (signal?.aborted) throw new Error("kimi_compaction_aborted");
    }
    const commandResult = readKimiCompactionResult(commandText);
    if (
      commandResult &&
      commandResult.tokensAfter < commandResult.tokensBefore
    ) {
      return {
        ok: true,
        compacted: true,
        usage: { used: commandResult.tokensAfter },
      };
    }
    if (
      beforeUsed !== undefined &&
      observedUsage?.used !== undefined &&
      observedUsage.used < beforeUsed
    ) {
      return { ok: true, compacted: true, usage: observedUsage };
    }
    const receipt = commandText.trim().replaceAll(/\s+/g, " ").slice(0, 240);
    return {
      ok: false,
      compacted: false,
      error: receipt
        ? `kimi_compaction_not_confirmed:${receipt}`
        : "kimi_compaction_not_confirmed:no_compaction_receipt",
    };
  } catch (error) {
    return {
      ok: false,
      compacted: false,
      error: error instanceof Error ? error.message : String(error),
      ...(signal?.aborted ? { outcomeUnknown: true } : {}),
    };
  } finally {
    if (completionTimer) clearTimeout(completionTimer);
    signal?.removeEventListener("abort", cancelCompact);
    cleanupNotifications();
  }
}

type OpenCodeSummarizeModel = { providerID: string; modelID: string };

type OpenCodeServerProcess = {
  url: string;
  close(): Promise<void>;
};

function openCodeSummarizeModel(
  model: string | undefined,
  runtimeEnv: NodeJS.ProcessEnv | undefined,
): OpenCodeSummarizeModel | undefined {
  const configuredModel =
    normalizeOptionalString(model) ??
    readString(parseJsonObject(runtimeEnv?.OPENCODE_CONFIG_CONTENT), "model");
  if (!configuredModel) return undefined;
  const separator = configuredModel.indexOf("/");
  if (separator <= 0 || separator >= configuredModel.length - 1)
    return undefined;
  return {
    providerID: configuredModel.slice(0, separator),
    modelID: configuredModel.slice(separator + 1),
  };
}

async function readOpenCodeDefaultSummarizeModel(
  serverUrl: string,
  signal?: AbortSignal,
): Promise<OpenCodeSummarizeModel | undefined> {
  const response = await fetch(`${serverUrl}/config/providers`, { signal });
  if (!response.ok) return undefined;
  const payload = asObject(await response.json().catch(() => undefined));
  const defaults = asObject(payload.default);
  for (const [providerID, modelID] of Object.entries(defaults)) {
    if (typeof modelID === "string" && providerID.trim() && modelID.trim()) {
      return { providerID, modelID };
    }
  }
  return undefined;
}

async function startOpenCodeServer(input: {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv | undefined;
}): Promise<OpenCodeServerProcess> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(input.env ?? {}),
    PWD: input.cwd,
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key];
  }
  const invocation = resolveCommandInvocation(input.command, [
    "serve",
    "--hostname",
    "127.0.0.1",
    "--port",
    "0",
  ]);
  const child = spawn(invocation.command, invocation.args, {
    cwd: input.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end();
  let url: string;
  try {
    url = await waitForOpenCodeServerUrl(child);
  } catch (error) {
    await closeOpenCodeServer(child);
    throw error;
  }
  return {
    url,
    close: () => closeOpenCodeServer(child),
  };
}

function waitForOpenCodeServerUrl(
  child: ChildProcessWithoutNullStreams,
): Promise<string> {
  return new Promise((resolveUrl, reject) => {
    let settled = false;
    let output = "";
    const timeout = setTimeout(
      () =>
        finish(
          undefined,
          new Error(`opencode_serve_timeout:${output.slice(0, 240)}`),
        ),
      30_000,
    );
    const onData = (chunk: Buffer | string) => {
      output += chunk.toString();
      const match =
        output.match(/http:\/\/127\.0\.0\.1:(\d+)/) ??
        output.match(/http:\/\/localhost:(\d+)/);
      if (match?.[1]) {
        finish(`http://127.0.0.1:${match[1]}`);
      }
    };
    const onError = (error: Error) => finish(undefined, error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(
        undefined,
        new Error(
          `opencode_serve_exited:${code ?? signal ?? "unknown"}:${output.slice(0, 240)}`,
        ),
      );
    };
    const finish = (url?: string, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
      if (url) resolveUrl(url);
      else reject(error ?? new Error("opencode_serve_failed"));
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", onError);
    child.on("exit", onExit);
  });
}

async function closeOpenCodeServer(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolveClose) => {
    const timeout = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      resolveClose();
    }, 1_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolveClose();
    });
  });
}

function parseBooleanJson(text: string): boolean | undefined {
  try {
    const value = JSON.parse(text);
    return typeof value === "boolean" ? value : undefined;
  } catch {
    return undefined;
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function normalizeOptionalString(
  value: string | undefined,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
function parseJsonObject(input: string | undefined): Record<string, unknown> {
  if (!input) return {};
  try {
    return asObject(JSON.parse(input));
  } catch {
    return {};
  }
}

function readKimiCompactionResult(
  text: string,
): { tokensBefore: number; tokensAfter: number } | undefined {
  if (!/Compaction completed\./i.test(text)) return undefined;
  const before = /Tokens before:\s*([\d,]+)/i.exec(text)?.[1];
  const after = /Tokens after:\s*([\d,]+)/i.exec(text)?.[1];
  if (!before || !after) return undefined;
  const tokensBefore = Number(before.replaceAll(",", ""));
  const tokensAfter = Number(after.replaceAll(",", ""));
  if (!Number.isFinite(tokensBefore) || !Number.isFinite(tokensAfter))
    return undefined;
  return { tokensBefore, tokensAfter };
}
