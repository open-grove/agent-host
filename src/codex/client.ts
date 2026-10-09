import crossSpawn from "cross-spawn";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import {
  createInterface,
  type Interface as ReadlineInterface,
} from "node:readline";
import type { JsonValue } from "../types.js";
import { resolveCommandInvocation } from "../environment/command.js";
import type { RpcRecorder } from "../types.js";
import type {
  CodexInitializeResponse,
  RpcMessage,
  RpcRequest,
  RpcResponse,
  ServerNotificationHandler,
  ServerRequestHandler,
} from "./types.js";
import { MIN_CODEX_APP_SERVER_VERSION } from "./types.js";
import {
  readWindowsPath,
  refreshWindowsPath,
  type WindowsEnvironmentProbe,
} from "../environment/windows-discovery.js";

export const CODEX_APP_SERVER_OPT_OUT_NOTIFICATION_METHODS: string[] = [
  "command/exec/outputDelta",
  "item/fileChange/outputDelta",
  "item/reasoning/textDelta",
];

export type CodexRequestFailureKind =
  | "aborted"
  | "timeout"
  | "remote"
  | "transport"
  | "closed";

export class CodexRequestFailure extends Error {
  constructor(
    readonly kind: CodexRequestFailureKind,
    readonly method: string,
    message: string,
  ) {
    super(message);
    this.name = "CodexRequestFailure";
  }
}

export class CodexAppServerClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lines: ReadlineInterface;
  private readonly pending = new Map<
    number | string,
    {
      method: string;
      resolve(value: unknown): void;
      reject(error: Error): void;
      cleanup(): void;
    }
  >();
  private readonly requestHandlers = new Set<ServerRequestHandler>();
  private readonly notificationHandlers = new Set<ServerNotificationHandler>();
  private readonly closeHandlers = new Set<(error: Error) => void>();
  private readonly serverRequestMethods = new Map<number | string, string>();
  private nextId = 1;
  private closed = false;
  private stderrTail = "";

  private constructor(
    child: ChildProcessWithoutNullStreams,
    private readonly rpcCapture?: RpcRecorder,
    private readonly processGroupPid?: number,
    private readonly fallbackRequest?: ServerRequestHandler,
  ) {
    this.child = child;
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", (line) => this.handleLine(line));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.rpcCapture?.recordStderr(chunk);
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-4096);
    });
    child.once("error", (error) =>
      this.closeWithError(
        error instanceof Error ? error : new Error(String(error)),
      ),
    );
    child.once("exit", (code, signal) => {
      this.closeWithError(
        new Error(
          `codex app-server exited: code=${code ?? "null"} signal=${signal ?? "null"}`,
        ),
      );
    });
    child.once("close", (code, signal) => {
      this.closeWithError(
        new Error(
          `codex app-server exited: code=${code ?? "null"} signal=${signal ?? "null"}`,
        ),
      );
    });
    child.stdin.on("error", (error) => {
      this.closeWithError(
        error instanceof Error ? error : new Error(String(error)),
      );
      this.terminateChild("SIGTERM");
    });
  }

  static async start(options: {
    command: string;
    args: string[];
    env?: NodeJS.ProcessEnv;
    rpcCapture?: RpcRecorder;
    fallbackRequest?: ServerRequestHandler;
  }): Promise<CodexAppServerClient> {
    const invocation = resolveCommandInvocation(options.command, options.args, {
      wrapWindowsScript: false,
    });
    await refreshWindowsPath({ ...process.env, ...options.env });
    const detached = process.platform !== "win32";
    const child = crossSpawn(invocation.command, invocation.args, {
      env: buildCodexAppServerEnv(invocation.command, options.env),
      stdio: ["pipe", "pipe", "pipe"],
      detached,
    });
    if (!child.stdin || !child.stdout || !child.stderr)
      throw new Error("app-server stdio pipes unavailable");
    options.rpcCapture?.recordLifecycle("app_server.spawned", {
      command: invocation.command,
      args: invocation.args,
      pid: child.pid,
    });
    return new CodexAppServerClient(
      child as ChildProcessWithoutNullStreams,
      options.rpcCapture,
      detached ? child.pid : undefined,
      options.fallbackRequest,
    );
  }

  isClosed(): boolean {
    return this.closed;
  }

  recentStderr(): string {
    return this.stderrTail;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.rpcCapture?.recordLifecycle("app_server.closed", {
      reason: "closed_by_host",
    });
    this.lines.close();
    this.terminateChild("SIGTERM");
    const killTimer = setTimeout(() => this.terminateChild("SIGKILL"), 1_500);
    killTimer.unref?.();
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(
        new CodexRequestFailure(
          "closed",
          pending.method,
          "codex app-server closed",
        ),
      );
    }
    this.pending.clear();
    this.notifyCloseHandlers(new Error("codex app-server closed by host"));
  }

  async initialize(
    clientInfo = { name: "agent_host", title: "Agent Host", version: "0.1.0" },
    timeoutMs = 60_000,
  ): Promise<void> {
    const response = await this.request<CodexInitializeResponse>(
      "initialize",
      {
        clientInfo,
        capabilities: {
          experimentalApi: true,
          optOutNotificationMethods:
            CODEX_APP_SERVER_OPT_OUT_NOTIFICATION_METHODS,
        },
      },
      { timeoutMs },
    );
    assertSupportedCodexAppServerVersion(response);
    this.notify("initialized");
  }

  request<T = JsonValue | undefined>(
    method: string,
    params?: JsonValue,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(
        new CodexRequestFailure(
          "closed",
          method,
          "codex app-server client is closed",
        ),
      );
    }
    if (options.signal?.aborted) {
      return Promise.reject(
        new CodexRequestFailure("aborted", method, `${method} aborted`),
      );
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let cleanupAbort: (() => void) | undefined;
      const cleanup = () => {
        if (timeout) {
          clearTimeout(timeout);
          timeout = undefined;
        }
        cleanupAbort?.();
        cleanupAbort = undefined;
      };
      const rejectPending = (error: Error) => {
        if (!this.pending.has(id)) {
          return;
        }
        this.pending.delete(id);
        cleanup();
        reject(error);
      };
      if (
        options.timeoutMs &&
        Number.isFinite(options.timeoutMs) &&
        options.timeoutMs > 0
      ) {
        timeout = setTimeout(
          () =>
            rejectPending(
              new CodexRequestFailure("timeout", method, `${method} timed out`),
            ),
          Math.max(100, options.timeoutMs),
        );
        timeout.unref?.();
      }
      if (options.signal) {
        const abortListener = () =>
          rejectPending(
            new CodexRequestFailure("aborted", method, `${method} aborted`),
          );
        options.signal.addEventListener("abort", abortListener, { once: true });
        cleanupAbort = () =>
          options.signal?.removeEventListener("abort", abortListener);
      }
      this.pending.set(id, {
        method,
        resolve(value) {
          cleanup();
          resolve(value as T);
        },
        reject(error) {
          cleanup();
          reject(error);
        },
        cleanup,
      });
      this.writeMessage({ id, method, params });
    });
  }

  notify(method: string, params?: JsonValue): void {
    this.writeMessage({ method, params });
  }

  addRequestHandler(handler: ServerRequestHandler): () => void {
    this.requestHandlers.add(handler);
    return () => this.requestHandlers.delete(handler);
  }

  addNotificationHandler(handler: ServerNotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  addCloseHandler(handler: (error: Error) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  private writeMessage(message: RpcRequest | RpcResponse): void {
    if (this.closed) {
      return;
    }
    this.rpcCapture?.recordMessage("host_to_codex", message, {
      method:
        "method" in message
          ? message.method
          : this.serverRequestMethods.get(message.id),
    });
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      this.rpcCapture?.recordParseError(Buffer.byteLength(trimmed, "utf8"));
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return;
    }
    const message = parsed as RpcMessage;
    this.rpcCapture?.recordMessage("codex_to_host", message, {
      method: isRpcResponse(message)
        ? this.pending.get(message.id)?.method
        : undefined,
    });
    if (isRpcResponse(message)) {
      this.handleResponse(message);
      return;
    }
    if (!("method" in message)) {
      return;
    }
    if ("id" in message && message.id !== undefined) {
      void this.handleServerRequest({
        id: message.id,
        method: message.method,
        params: message.params,
      });
      return;
    }
    this.handleNotification({
      method: message.method,
      params: message.params,
    });
  }

  private handleResponse(response: RpcResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }
    this.pending.delete(response.id);
    if (response.error) {
      pending.reject(
        new CodexRequestFailure(
          "remote",
          pending.method,
          response.error.message || `${pending.method} failed`,
        ),
      );
      return;
    }
    pending.resolve(response.result);
  }

  private async handleServerRequest(request: {
    id: number | string;
    method: string;
    params?: JsonValue;
  }): Promise<void> {
    this.serverRequestMethods.set(request.id, request.method);
    const respond = (response: RpcResponse) => {
      this.writeMessage(response);
      this.serverRequestMethods.delete(request.id);
    };
    try {
      for (const handler of this.requestHandlers) {
        const result = await handler(request);
        if (result !== undefined) {
          respond({ id: request.id, result });
          return;
        }
      }
      const fallback = await this.fallbackRequest?.(request);
      if (fallback !== undefined) respond({ id: request.id, result: fallback });
      else respond(defaultCodexServerRequestResponse(request));
    } catch (error) {
      respond({
        id: request.id,
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private handleNotification(notification: {
    method: string;
    params?: JsonValue;
  }): void {
    for (const handler of this.notificationHandlers) {
      Promise.resolve(handler(notification)).catch(() => {
        // Notification consumers should not crash the shared app-server process.
      });
    }
  }

  private closeWithError(error: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.rpcCapture?.recordLifecycle("app_server.closed", {
      error: error.message,
    });
    this.lines.close();
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(
        new CodexRequestFailure("transport", pending.method, error.message),
      );
    }
    this.pending.clear();
    this.notifyCloseHandlers(error);
  }

  private notifyCloseHandlers(error: Error): void {
    for (const handler of this.closeHandlers) handler(error);
    this.closeHandlers.clear();
  }

  private terminateChild(signal: NodeJS.Signals): void {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    if (this.processGroupPid && process.platform !== "win32") {
      try {
        process.kill(-this.processGroupPid, signal);
        return;
      } catch {
        // Fall through to the direct child when process-group signaling fails.
      }
    }
    this.child.kill(signal);
  }
}

export function buildCodexAppServerEnv(
  command: string,
  env: NodeJS.ProcessEnv | undefined,
  probe: WindowsEnvironmentProbe = {},
): NodeJS.ProcessEnv {
  const platform = probe.platform ?? process.platform;
  const merged = readWindowsPath({ ...process.env, ...env }, probe);
  merged.PATH = augmentedCodexRuntimePath(command, merged.PATH, platform);
  return merged;
}

function augmentedCodexRuntimePath(
  command: string,
  pathValue: string | undefined,
  platform: NodeJS.Platform,
): string {
  const pathDelimiter = platform === "win32" ? ";" : ":";
  const existing = (pathValue || "").split(pathDelimiter).filter(Boolean);
  const additions = defaultCodexRuntimePathAdditions(command, platform);
  return dedupePathEntries([...existing, ...additions]).join(pathDelimiter);
}

function defaultCodexRuntimePathAdditions(
  command: string,
  platform: NodeJS.Platform,
): string[] {
  const commandDirectory =
    command.includes("/") || command.includes("\\") ? dirname(command) : "";
  if (platform === "win32")
    return commandDirectory && safeDirectoryExists(commandDirectory)
      ? [commandDirectory]
      : [];
  const additions = [
    commandDirectory,
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    resolve(homedir(), ".local", "bin"),
    resolve(homedir(), ".cargo", "bin"),
    resolve(homedir(), ".bun", "bin"),
  ];
  return additions.filter((path) => path && safeDirectoryExists(path));
}

function dedupePathEntries(entries: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of entries) {
    const normalized = entry.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function safeDirectoryExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

function defaultCodexServerRequestResponse(
  request: RpcRequest & { id: string | number },
): RpcResponse {
  const { id, method } = request;
  if (method === "item/tool/call")
    return {
      id,
      result: {
        contentItems: [
          {
            type: "inputText",
            text: "No handler registered for this product tool.",
          },
        ],
        success: false,
      },
    };
  if (
    method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval"
  )
    return { id, result: { decision: "cancel" } };
  if (method === "item/permissions/requestApproval")
    return { id, result: { permissions: {}, scope: "turn" } };
  if (method === "item/tool/requestUserInput")
    return { id, result: { answers: {} } };
  if (method === "mcpServer/elicitation/request")
    return { id, result: { action: "decline" } };
  return {
    id,
    error: { code: -32601, message: `Unsupported server request: ${method}` },
  };
}

function isRpcResponse(message: RpcMessage): message is RpcResponse {
  return "id" in message && !("method" in message);
}

function assertSupportedCodexAppServerVersion(
  response: CodexInitializeResponse | undefined,
): void {
  const detectedVersion = readCodexVersionFromUserAgent(response?.userAgent);
  if (!detectedVersion) {
    throw new Error(
      `Codex app-server ${MIN_CODEX_APP_SERVER_VERSION} or newer is required, but Agent Host could not determine the running Codex version. Upgrade Codex CLI and retry.`,
    );
  }
  if (compareVersions(detectedVersion, MIN_CODEX_APP_SERVER_VERSION) < 0) {
    throw new Error(
      `Codex app-server ${MIN_CODEX_APP_SERVER_VERSION} or newer is required, but detected ${detectedVersion}. Upgrade Codex CLI and retry.`,
    );
  }
}

function readCodexVersionFromUserAgent(
  userAgent: string | undefined,
): string | undefined {
  const match = userAgent?.match(
    /^[^/]+\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?:[\s(]|$)/,
  );
  return match?.[1];
}

function compareVersions(left: string, right: string): number {
  const leftParts = numericVersionParts(left);
  const rightParts = numericVersionParts(right);
  for (
    let index = 0;
    index < Math.max(leftParts.length, rightParts.length);
    index += 1
  ) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;
    if (leftPart !== rightPart) {
      return leftPart < rightPart ? -1 : 1;
    }
  }
  return 0;
}

function numericVersionParts(version: string): number[] {
  return version
    .split(/[+-]/, 1)[0]!
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
}
