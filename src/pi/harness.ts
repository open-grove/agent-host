import {
  AgentHarness,
  BACKGROUND_CONTEXT as background,
  HarnessClosed,
  type AgentHarnessOptions,
  type AgentLane,
  type CompactionSettings,
} from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";

/** Recover unfinished native operations through Pi before admitting new input. */
export async function openPiHarness<T extends object | undefined>(
  options: AgentHarnessOptions<T>,
) {
  let harness: AgentHarness<T> | undefined;
  try {
    const created = await AgentHarness.create(options, background);
    harness = created.harness;
    const lane = await harness.lane("main", background);
    for (const operation of created.open) {
      const interrupted = await harness.lane(operation.lane, background);
      const result = await interrupted.abort(background);
      if (!result.ok) throw result.error;
    }
    return { harness, lane };
  } catch (error) {
    await (harness ?? options.session).close(background);
    throw error;
  }
}

/** Explicit admission prevents a cancel-before-start race. Native storage owns recovery. */
export async function drivePiTurn(options: {
  lane: AgentLane;
  input: string;
  images?: ImageContent[];
  signal?: AbortSignal;
  abortSettleTimeoutMs?: number;
  close(): Promise<void>;
  onAbortTimeout?(): void;
  onCleanupError?(error: unknown): void;
}): Promise<void> {
  options.signal?.throwIfAborted();
  const admitted = await options.lane.accept(
    { kind: "prompt", prompt: options.input, images: options.images },
    background,
  );
  if (!admitted.ok) throw admitted.error;
  let done = false;
  let timedOut = false;
  let abortTask: Promise<void> | undefined;
  let closeTask: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortFailure: unknown;
  const abort = () => {
    if (abortTask || done) return;
    timer = setTimeout(() => {
      if (done) return;
      timedOut = true;
      options.onAbortTimeout?.();
      closeTask = options.close().catch((error) => {
        abortFailure = error;
        options.onCleanupError?.(error);
      });
    }, options.abortSettleTimeoutMs ?? 15_000);
    abortTask = options.lane
      .abort(background)
      .then((result) => {
        if (
          !result.ok &&
          result.error._tag !== "NoActiveOperation" &&
          !(timedOut && result.error._tag === "Closed")
        )
          throw result.error;
      })
      .catch((error) => {
        if (!(timedOut && error instanceof HarnessClosed)) abortFailure = error;
      });
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  try {
    const result = await options.lane.drive(
      {
        operationId: admitted.value.operationId,
        waitForRetry: true,
        pollDeferred: true,
      },
      background,
    );
    if (!result.ok) throw result.error;
    if (result.value.kind !== "settled")
      throw new Error(`pi_operation_waiting: ${result.value.reason}`);
  } finally {
    done = true;
    options.signal?.removeEventListener("abort", abort);
    if (timer) clearTimeout(timer);
    await abortTask;
    await closeTask;
  }
  if (timedOut)
    throw new Error(
      "pi_abort_settlement_timeout: Pi provider or tool did not settle after cancellation",
    );
  if (abortFailure) throw abortFailure;
}

export async function compactPiSession<T extends object | undefined>(
  harness: AgentHarness<T>,
  lane: AgentLane,
  settings: CompactionSettings,
  reason?: string,
) {
  if ((await lane.inspectExecution(background)).current)
    return { ok: false, compacted: false, error: "pi_session_busy" };
  await harness.setCompactionSettings(settings, background);
  try {
    const result = await lane.compact(
      { customInstructions: reason },
      background,
    );
    if (!result.ok)
      return result.error._tag === "NothingToCompact"
        ? { ok: true, compacted: false }
        : { ok: false, compacted: false, error: result.error.message };
    return result.value.compaction.status === "failed"
      ? {
          ok: false,
          compacted: false,
          error:
            result.value.compaction.error?.message ?? "pi_compaction_failed",
        }
      : { ok: true, compacted: result.value.compaction.status === "completed" };
  } finally {
    await harness.setCompactionSettings(
      { ...settings, enabled: false },
      background,
    );
  }
}
