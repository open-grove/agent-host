export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonObject
  | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue | undefined;
}

/** Opt-in recording only. The product owns redaction, access and retention. */
export interface RpcRecorder {
  recordLifecycle(event: string, payload?: unknown): void;
  recordStderr(chunk: string): void;
  recordMessage(
    direction: "host_to_codex" | "codex_to_host",
    message: unknown,
    meta?: { method?: string },
  ): void;
  recordParseError(bytes: number): void;
}
