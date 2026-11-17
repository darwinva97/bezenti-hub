/**
 * Grants ticket 10: a lent Sandbox whose Grant ended stops its running turns (their checkpoints
 * upload as in any stop), waits at most `drainMs` for them and their uploads, then is closed
 * whatever is left. See docs/internals/sandboxes.md#lent-machines.
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

export const drainLentSandbox = Effect.fn("LentSandboxDrain.drain")(function* (input: {
  readonly stopRunning: Effect.Effect<void>;
  /** No turn running there and no checkpoint of its Threads left to upload. */
  readonly idle: Effect.Effect<boolean>;
  readonly close: Effect.Effect<void>;
  readonly drainMs: number;
  readonly checkEveryMs?: number;
}) {
  yield* input.stopRunning;
  const deadline = (yield* Clock.currentTimeMillis) + input.drainMs;
  while (!(yield* input.idle)) {
    const now = yield* Clock.currentTimeMillis;
    if (now >= deadline) break;
    yield* Effect.sleep(Math.min(input.checkEveryMs ?? 1_000, deadline - now));
  }
  yield* input.close;
});
