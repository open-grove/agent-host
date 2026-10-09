import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { BindingStore, SessionBinding } from "./agent.js";

/** Atomic per-session files. Applications must enforce one writer per session. */
export class FileBindingStore implements BindingStore {
  constructor(private readonly directory: string) {}
  private path(id: string) {
    return join(
      this.directory,
      `${createHash("sha256").update(id).digest("hex")}.json`,
    );
  }
  async delete(id: string): Promise<void> {
    await unlink(this.path(id)).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  async get(id: string): Promise<SessionBinding | undefined> {
    let source: string;
    try {
      source = await readFile(this.path(id), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const value: unknown = JSON.parse(source);
    if (
      !value ||
      typeof value !== "object" ||
      !("threadId" in value) ||
      typeof value.threadId !== "string" ||
      !value.threadId ||
      !("fingerprint" in value) ||
      typeof value.fingerprint !== "string" ||
      !value.fingerprint
    )
      throw new Error(
        "Invalid native session binding; refusing to recreate the conversation",
      );
    return { threadId: value.threadId, fingerprint: value.fingerprint };
  }
  async set(id: string, binding: SessionBinding): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = this.path(id);
    const temp = `${path}.${randomUUID()}.tmp`;
    const file = await open(temp, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(binding));
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(temp, path);
    } finally {
      await unlink(temp).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
}
