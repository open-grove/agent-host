import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import {
  callSchema,
  runSchema,
  sessionSchema,
  type RunRecord,
  type SessionRecord,
  type PendingCall,
  type ServiceEvent,
  type EventPage,
} from "./protocol.js";

/** One process owns the state directory. SQLite releases its exclusive lock on crash. */
export class TaskStore {
  private readonly db: DatabaseSync;
  constructor(
    path: string,
    private readonly eventLimit = 2_000,
  ) {
    if (!Number.isInteger(eventLimit) || eventLimit < 1)
      throw new Error("invalid_event_limit");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    try {
      chmodSync(path, 0o600);
      this.db.exec(`PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=DELETE;
        PRAGMA synchronous=FULL; BEGIN EXCLUSIVE;
        CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events (run_id TEXT NOT NULL, sequence INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(run_id, sequence));
        CREATE INDEX IF NOT EXISTS run_sessions ON runs(session_id);
        CREATE INDEX IF NOT EXISTS call_runs ON calls(run_id);
        COMMIT;`);
      // An interrupted native operation is never restarted or replayed by the Host.
      for (const run of this.runs())
        if (run.status === "running") {
          for (const call of this.calls(run.id))
            if (call.status === "pending")
              this.saveCall({ ...call, status: "cancelled" });
          const outcome = {
            status: "failed" as const,
            error: "host_restarted",
            outcomeUnknown: true,
          };
          this.finish(run, outcome);
        }
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  close() {
    this.db.close();
  }
  session(id: string): SessionRecord | undefined {
    return this.read("sessions", id, sessionSchema);
  }
  run(id: string): RunRecord | undefined {
    return this.read("runs", id, runSchema);
  }
  call(id: string): PendingCall | undefined {
    return this.read("calls", id, callSchema);
  }
  sessions(): SessionRecord[] {
    return this.all("SELECT data FROM sessions", sessionSchema);
  }
  runs(sessionId?: string): RunRecord[] {
    return sessionId
      ? this.all(
          "SELECT data FROM runs WHERE session_id = ? ORDER BY rowid DESC",
          runSchema,
          sessionId,
        )
      : this.all("SELECT data FROM runs ORDER BY rowid DESC", runSchema);
  }
  calls(runId: string): PendingCall[] {
    return this.all(
      "SELECT data FROM calls WHERE run_id = ? ORDER BY rowid",
      callSchema,
      runId,
    );
  }
  saveSession(session: SessionRecord) {
    this.db
      .prepare(
        "INSERT INTO sessions VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(session.id, JSON.stringify(sessionSchema.parse(session)));
  }
  saveRun(run: RunRecord) {
    this.db
      .prepare(
        "INSERT INTO runs VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(run.id, run.sessionId, JSON.stringify(runSchema.parse(run)));
  }
  saveCall(call: PendingCall) {
    this.db
      .prepare(
        "INSERT INTO calls VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(call.id, call.runId, JSON.stringify(callSchema.parse(call)));
  }
  append(run: RunRecord, event: ServiceEvent) {
    this.db.exec("BEGIN");
    try {
      run.sequence++;
      this.db
        .prepare("INSERT INTO events VALUES (?, ?, ?)")
        .run(run.id, run.sequence, JSON.stringify(event));
      this.db
        .prepare("DELETE FROM events WHERE run_id = ? AND sequence <= ?")
        .run(run.id, run.sequence - this.eventLimit);
      this.saveRun(run);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  finish(run: RunRecord, outcome: NonNullable<RunRecord["outcome"]>) {
    run.status = outcome.status;
    run.outcome = outcome;
    run.finishedAt = new Date().toISOString();
    this.append(run, { type: "turn.finished", runId: run.id, outcome });
  }
  events(run: RunRecord, after: number, limit: number): EventPage {
    const first = this.db
      .prepare("SELECT MIN(sequence) AS sequence FROM events WHERE run_id = ?")
      .get(run.id)?.sequence;
    const rows = this.db
      .prepare(
        "SELECT sequence, data FROM events WHERE run_id = ? AND sequence > ? ORDER BY sequence LIMIT ?",
      )
      .all(run.id, after, limit);
    const events = rows.map((row) => ({
      sequence: Number(row.sequence),
      event: JSON.parse(String(row.data)) as ServiceEvent,
    }));
    const cursor = events.at(-1)?.sequence ?? after;
    return {
      events,
      cursor,
      hasMore: cursor < run.sequence,
      historyTruncated: typeof first === "number" && after < first - 1,
    };
  }
  private read<T>(
    table: "sessions" | "runs" | "calls",
    id: string,
    schema: z.ZodType<T>,
  ): T | undefined {
    const row = this.db
      .prepare(`SELECT data FROM ${table} WHERE id = ?`)
      .get(id);
    return row ? schema.parse(JSON.parse(String(row.data))) : undefined;
  }
  private all<T>(
    query: string,
    schema: z.ZodType<T>,
    ...params: string[]
  ): T[] {
    return this.db
      .prepare(query)
      .all(...params)
      .map((row) => schema.parse(JSON.parse(String(row.data))));
  }
}
