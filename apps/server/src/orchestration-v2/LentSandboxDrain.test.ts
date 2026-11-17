import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import { drainLentSandbox } from "./LentSandboxDrain.ts";

const DRAIN_MS = 120_000;

const drain = Effect.fn(function* (idleAfter: Ref.Ref<boolean>) {
  const steps = yield* Ref.make<ReadonlyArray<string>>([]);
  const step = (name: string) => Ref.update(steps, (all) => [...all, name]);
  const fiber = yield* drainLentSandbox({
    stopRunning: step("stop"),
    idle: Ref.get(idleAfter),
    close: step("close"),
    drainMs: DRAIN_MS,
  }).pipe(Effect.forkChild);
  yield* TestClock.adjust("1 millis");
  return { steps, fiber };
});

it.effect("stops the running turns, and closes the Sandbox as soon as they ended", () =>
  Effect.gen(function* () {
    const idle = yield* Ref.make(false);
    const { steps, fiber } = yield* drain(idle);
    assert.deepEqual(yield* Ref.get(steps), ["stop"]);
    yield* TestClock.adjust("10 seconds");
    assert.deepEqual(yield* Ref.get(steps), ["stop"]);
    // The turns stopped and their checkpoints uploaded: it closes on the next check.
    yield* Ref.set(idle, true);
    yield* TestClock.adjust("1 second");
    yield* Fiber.join(fiber);
    assert.deepEqual(yield* Ref.get(steps), ["stop", "close"]);
  }),
);

it.effect("closes the Sandbox when its time is up, whatever its turns do", () =>
  Effect.gen(function* () {
    const idle = yield* Ref.make(false);
    const { steps, fiber } = yield* drain(idle);
    yield* TestClock.adjust(`${DRAIN_MS - 2_000} millis`);
    assert.deepEqual(yield* Ref.get(steps), ["stop"]);
    yield* TestClock.adjust("2 seconds");
    yield* Fiber.join(fiber);
    assert.deepEqual(yield* Ref.get(steps), ["stop", "close"]);
  }),
);
