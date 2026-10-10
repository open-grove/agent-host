import { randomUUID } from "node:crypto";
import type { JsonObject, JsonValue } from "../types.js";
export interface OpenClawGatewayConnection {
  url: string;
  token?: string;
  password?: string;
  sessionKey?: string;
}
export type GatewayEventFrame = {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
};

type GatewayResponseFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
    retryable?: boolean;
    retryAfterMs?: number;
  };
};

type PendingGatewayRequest = {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  cleanup(): void;
};

const OPENCLAW_MIN_PROTOCOL = 4;
const OPENCLAW_MAX_PROTOCOL = 4;
const OPENCLAW_OPERATOR_SCOPES = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.pairing",
];

export class OpenClawGatewayClient {
  serverVersion?: string;
  private ws?: WebSocket;
  private connected = false;
  private connectPromise?: Promise<void>;
  private nextId = 1;
  private pending = new Map<string, PendingGatewayRequest>();
  private eventListeners = new Set<(frame: GatewayEventFrame) => void>();

  constructor(
    private readonly options: Pick<
      OpenClawGatewayConnection,
      "url" | "token" | "password"
    > & {
      connectTimeoutMs?: number;
      clientVersion?: string;
      clientName?: string;
    },
  ) {}

  async ensureConnected(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN && this.connected) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.openSocket();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = undefined;
    }
  }

  async request<T = unknown>(
    method: string,
    params?: unknown,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    await this.ensureConnected();
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("openclaw gateway is not connected");
    }
    return await this.requestOnSocket<T>(this.ws, method, params, options);
  }

  addEventListener(listener: (frame: GatewayEventFrame) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  close(): void {
    this.connected = false;
    this.serverVersion = undefined;
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(new Error("openclaw gateway closed"));
    }
    this.pending.clear();
    this.ws?.close();
    this.ws = undefined;
  }

  private openSocket(): Promise<void> {
    this.close();
    const ws = new WebSocket(this.options.url);
    const connectTimeoutMs = this.options.connectTimeoutMs ?? 30_000;
    this.ws = ws;
    let connectSent = false;
    let connectNonce: string | undefined;
    let socketTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    return new Promise<void>((resolve, reject) => {
      const cleanupConnect = () => {
        if (socketTimer) {
          clearTimeout(socketTimer);
          socketTimer = undefined;
        }
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanupConnect();
        this.connected = false;
        reject(error);
      };
      const sendConnect = () => {
        if (connectSent || ws.readyState !== WebSocket.OPEN) return;
        connectSent = true;
        void this.requestOnSocket(
          ws,
          "connect",
          this.connectParams(connectNonce),
          { timeoutMs: connectTimeoutMs },
        )
          .then((hello) => {
            if (settled) return;
            // Protocol 4 hello-ok identifies the running Gateway, which may be remote
            // or differ from the locally installed CLI.
            this.serverVersion = readString(
              asObject(asObject(hello).server),
              "version",
            );
            settled = true;
            cleanupConnect();
            this.connected = true;
            resolve();
          })
          .catch(fail);
      };
      const onMessage = (event: { data: unknown }) => {
        if (this.ws !== ws) return;
        const frame = parseGatewayFrame(event.data);
        if (!frame) return;
        if (frame.type === "event" && frame.event === "connect.challenge") {
          const payload = asObject(frame.payload);
          connectNonce = readString(payload, "nonce");
          if (!connectNonce) {
            fail(
              new Error("openclaw gateway challenge did not include a nonce"),
            );
            ws.close();
            return;
          }
          sendConnect();
          return;
        }
        this.handleFrame(frame);
      };
      const onClose = () => {
        if (this.ws !== ws) return;
        cleanupConnect();
        this.connected = false;
        for (const pending of this.pending.values()) {
          pending.cleanup();
          pending.reject(new Error("openclaw gateway closed"));
        }
        this.pending.clear();
        if (!settled) {
          fail(new Error("openclaw gateway closed during connect"));
        }
      };
      const onError = () => {
        if (this.ws !== ws) return;
        this.connected = false;
        if (!settled) {
          fail(new Error("openclaw gateway socket error"));
        }
      };
      socketTimer = setTimeout(() => {
        fail(new Error("openclaw gateway connect timed out"));
        ws.close();
      }, connectTimeoutMs);
      socketTimer.unref?.();
      ws.addEventListener("message", onMessage);
      ws.addEventListener("close", onClose);
      ws.addEventListener("error", onError);
    });
  }

  private requestOnSocket<T>(
    ws: WebSocket,
    method: string,
    params?: unknown,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    if (options.signal?.aborted) {
      return Promise.reject(new Error(`${method} aborted`));
    }
    const id = `${Date.now()}-${this.nextId++}-${randomUUID()}`;
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
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        cleanup();
        reject(error);
      };
      if (options.timeoutMs && options.timeoutMs > 0) {
        timeout = setTimeout(
          () => rejectPending(new Error(`${method} timed out`)),
          options.timeoutMs,
        );
        timeout.unref?.();
      }
      if (options.signal) {
        const abortListener = () =>
          rejectPending(new Error(`${method} aborted`));
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
      try {
        ws.send(JSON.stringify({ type: "req", id, method, params }));
      } catch (error) {
        rejectPending(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    });
  }

  private connectParams(_nonce?: string): JsonObject {
    return stripUndefined({
      minProtocol: OPENCLAW_MIN_PROTOCOL,
      maxProtocol: OPENCLAW_MAX_PROTOCOL,
      client: {
        id: "gateway-client",
        version: this.options.clientVersion ?? "agent-host",
        platform: process.platform,
        mode: "backend",
        instanceId: `agent-host-${process.pid}`,
      },
      role: "operator",
      scopes: OPENCLAW_OPERATOR_SCOPES,
      caps: ["tool-events"],
      auth: stripUndefined({
        token: this.options.token,
        password: this.options.password,
      }),
      device: undefined,
      userAgent: this.options.clientName ?? "Agent Host",
      locale: "en-US",
    }) as JsonObject;
  }

  private handleFrame(frame: GatewayEventFrame | GatewayResponseFrame): void {
    if (frame.type === "event") {
      for (const listener of this.eventListeners) {
        listener(frame);
      }
      return;
    }
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);
    if (frame.ok) {
      pending.resolve(frame.payload);
      return;
    }
    const details =
      frame.error?.details === undefined
        ? ""
        : `: ${JSON.stringify(frame.error.details)}`;
    pending.reject(
      new Error(frame.error?.message || `${pending.method} failed${details}`),
    );
  }
}

function parseGatewayFrame(
  data: unknown,
): GatewayEventFrame | GatewayResponseFrame | undefined {
  const raw =
    typeof data === "string"
      ? data
      : data instanceof ArrayBuffer
        ? Buffer.from(data).toString("utf8")
        : Buffer.isBuffer(data)
          ? data.toString("utf8")
          : "";
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { type?: unknown };
    if (parsed.type === "event" || parsed.type === "res") {
      return parsed as GatewayEventFrame | GatewayResponseFrame;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function asObject(value: unknown): Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function stripUndefined(
  input: Record<string, unknown>,
): Record<string, JsonValue> {
  const output: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      output[key] = value.filter(
        (item): item is JsonValue => item !== undefined,
      ) as JsonValue;
      continue;
    }
    if (value && typeof value === "object") {
      output[key] = stripUndefined(value as Record<string, unknown>);
      continue;
    }
    output[key] = value as JsonValue;
  }
  return output;
}
