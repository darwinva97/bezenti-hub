/**
 * Grants ticket 08: a lent machine's host follows the Hub's answer, one Sandbox per Grant, each
 * started with a credential asked for it alone, deleted with its home once its Grant is gone, and
 * none running while the machine cannot host them or its disk is almost full.
 */
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  type EnvironmentSelfReport,
  type LentSandboxAssignment,
  type SandboxHostReport,
  SpaceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  type HomeMeasurement,
  SandboxRuntime,
  type SandboxSpec,
  type SandboxStartOptions,
} from "../sandboxes/SandboxRuntime.ts";
import type { JoinedHubState } from "./joinedHubState.ts";
import { type LentAnswer, lentSandboxIdOf, superviseLentSandboxes } from "./LentSandboxHost.ts";

const joined: JoinedHubState = {
  hubUrl: "https://hub.example.com",
  hubEnvironmentId: EnvironmentId.make("hub-1"),
  environmentId: EnvironmentId.make("env-laptop"),
  name: "Ana's VPS",
  joinedAt: "2026-01-01T00:00:00.000Z",
};

const GIB = 1024 ** 3;
const readyHost: SandboxHostReport = {
  ready: true,
  reason: null,
  limitSupport: { cpus: true, memory: true, pids: true, note: null },
  reachablePorts: [22],
  hostCpus: 2,
  hostMemoryBytes: 4 * GIB,
  hostFreeBytes: 500 * GIB,
  hostTotalBytes: 1000 * GIB,
};

const assignment = (grantId: string, spaceId: string): LentSandboxAssignment => ({
  grantId,
  environmentId: EnvironmentId.make(`lent:${grantId}`),
  spaceId: SpaceId.make(spaceId),
  name: "Ana's VPS (lent)",
  limits: { cpus: 8, memoryBytes: 16 * GIB, pids: 512, diskBytes: 10 * GIB },
});

/** A runtime recording what it was asked; each server runs until the test ends. */
const makeRuntime = (measurement: HomeMeasurement = { _tag: "unavailable" }) => {
  const created: Array<SandboxSpec> = [];
  const deleted: Array<string> = [];
  const stopped: Array<string> = [];
  const started: Array<{ readonly sandboxId: string; readonly options?: SandboxStartOptions }> = [];
  const runtime = SandboxRuntime.of({
    kind: "process",
    create: (spec) => Effect.sync(() => void created.push(spec)),
    start: (sandboxId, options) =>
      Effect.sync(() => {
        started.push({ sandboxId, ...(options === undefined ? {} : { options }) });
        return { exited: Effect.never, imageVersion: null };
      }),
    imageVersion: Effect.succeed(null),
    stop: (sandboxId) => Effect.sync(() => void stopped.push(sandboxId)),
    delete: (sandboxId) => Effect.sync(() => void deleted.push(sandboxId)),
    inspect: () => Effect.succeed({ state: { _tag: "missing" }, homePath: "/nowhere" }),
    limitSupport: Effect.succeed({ cpus: true, memory: true, pids: true, note: null }),
    resourceUse: () => Effect.succeed(null),
    measureHome: () => Effect.succeed(measurement),
    hostSpace: Effect.succeed(null),
    exits: Stream.empty,
  });
  return { runtime, created, deleted, stopped, started };
};

let issued = 0;
/**
 * A Hub lending the machine to `grants`, recording each report; a report asking credentials gets
 * a new one for each Grant it names, the others none.
 */
const makeHub = Effect.fn(function* (initial: ReadonlyArray<LentSandboxAssignment>) {
  const lent = yield* Ref.make<LentAnswer>({ _tag: "lent", sandboxes: initial });
  const reports: Array<EnvironmentSelfReport> = [];
  const askHub = (report: EnvironmentSelfReport) =>
    Effect.gen(function* () {
      reports.push(report);
      const answer = yield* Ref.get(lent);
      if (answer._tag !== "lent") return answer;
      return {
        _tag: "lent" as const,
        sandboxes: answer.sandboxes.map((sandbox) =>
          report.credentialsFor.includes(sandbox.grantId)
            ? { ...sandbox, credential: `t3env.lent-${(issued += 1)}` }
            : sandbox,
        ),
      };
    });
  return { lent, reports, askHub };
});

const run = Effect.fn(function* (input: {
  readonly runtime: ReturnType<typeof makeRuntime>;
  readonly hub: Effect.Success<ReturnType<typeof makeHub>>;
  readonly host?: Ref.Ref<SandboxHostReport>;
  readonly homes?: ReadonlyArray<string>;
}) {
  const host = input.host ?? (yield* Ref.make(readyHost));
  const rounds = yield* Queue.unbounded<void>();
  const done = yield* Queue.unbounded<void>();
  const fiber = yield* superviseLentSandboxes({
    joined,
    askHub: input.hub.askHub,
    hostReport: Ref.get(host),
    runtime: Effect.succeedSome(input.runtime.runtime),
    homesOnDisk: Effect.succeed(input.homes ?? []),
    nextRound: Queue.take(rounds),
    onRound: () => Queue.offer(done, undefined).pipe(Effect.asVoid),
  }).pipe(Effect.forkChild);
  yield* Queue.take(done);
  // Let the Sandboxes it forked ask for their credentials and start.
  yield* TestClock.adjust("1 millis");
  const round = Queue.offer(rounds, undefined).pipe(
    Effect.andThen(Queue.take(done)),
    Effect.andThen(TestClock.adjust("1 millis")),
  );
  return { fiber, round, host };
});

it.effect(
  "starts one Sandbox per Grant with a credential asked for it alone, capped to the machine",
  () =>
    Effect.gen(function* () {
      const runtime = makeRuntime();
      const hub = yield* makeHub([
        assignment("grant-acme", "org-acme"),
        assignment("grant-globex", "org-globex"),
      ]);
      yield* run({ runtime, hub });
      assert.sameMembers(
        runtime.created.map((spec) => [spec.sandboxId, spec.spaceId, spec.environmentId].join(" ")),
        [
          `${lentSandboxIdOf("grant-acme")} org-acme lent:grant-acme`,
          `${lentSandboxIdOf("grant-globex")} org-globex lent:grant-globex`,
        ],
      );
      // Each with its own credential, asked for that Grant alone; the round asked none.
      const credentials = runtime.created.map((spec) => Redacted.value(spec.credential));
      assert.equal(new Set(credentials).size, 2);
      assert.deepEqual(hub.reports[0]?.credentialsFor, []);
      assert.sameDeepMembers(
        hub.reports.slice(1).map((report) => report.credentialsFor),
        [["grant-acme"], ["grant-globex"]],
      );
      // The Grant's 8 CPUs and 16 GiB run at the machine's 2 CPUs and 4 GiB; PIDs and disk stay.
      assert.deepEqual(runtime.started[0]?.options?.limits, {
        cpus: 2,
        memoryBytes: 4 * GIB,
        pids: 512,
        diskBytes: 10 * GIB,
      });
      // The host says it is ready, with the ports its owner listed.
      assert.deepEqual(hub.reports[0]?.sandboxHost.reachablePorts, [22]);
    }),
);

it.effect("a Grant gone takes its Sandbox and home; homes of no Grant are deleted", () =>
  Effect.gen(function* () {
    const runtime = makeRuntime();
    const hub = yield* makeHub([assignment("grant-acme", "org-acme")]);
    const { round } = yield* run({
      runtime,
      hub,
      homes: [lentSandboxIdOf("grant-acme"), lentSandboxIdOf("grant-old")],
    });
    assert.deepEqual(runtime.deleted, [lentSandboxIdOf("grant-old")]);
    assert.equal(runtime.started.length, 1);
    yield* Ref.set(hub.lent, { _tag: "lent", sandboxes: [] });
    yield* round;
    assert.include(runtime.deleted, lentSandboxIdOf("grant-acme"));
    // Nothing of it is reported any more.
    yield* round;
    assert.deepEqual(hub.reports.at(-1)?.sandboxes, []);
  }),
);

it.effect("nothing runs while the machine cannot host, or its disk is almost full", () =>
  Effect.gen(function* () {
    const runtime = makeRuntime();
    const hub = yield* makeHub([assignment("grant-acme", "org-acme")]);
    const host = yield* Ref.make<SandboxHostReport>({
      ...readyHost,
      ready: false,
      reason: "its Sandbox containers could reach this machine's 0.0.0.0:8080.",
    });
    const { round } = yield* run({ runtime, hub, host });
    assert.equal(runtime.started.length, 0);
    yield* round;
    assert.include(hub.reports.at(-1)?.sandboxes[0]?.message ?? "", "0.0.0.0:8080");
    // Once it can, the Sandbox starts.
    yield* Ref.set(host, readyHost);
    yield* round;
    assert.equal(runtime.started.length, 1);
    // Its disk almost full: the lent Sandbox stops (its home stays), and it says why.
    yield* Ref.set(host, { ...readyHost, hostFreeBytes: 5 * GIB });
    yield* round;
    assert.deepEqual(runtime.stopped, [lentSandboxIdOf("grant-acme")]);
    assert.notInclude(runtime.deleted, lentSandboxIdOf("grant-acme"));
    yield* round;
    assert.include(hub.reports.at(-1)?.sandboxes[0]?.message ?? "", "almost full");
  }),
);

it.effect("reports each home's size; failed measurements count, never a smaller size", () =>
  Effect.gen(function* () {
    const runtime = makeRuntime({ _tag: "measured", bytes: 3 * GIB });
    const hub = yield* makeHub([assignment("grant-acme", "org-acme")]);
    const { round } = yield* run({ runtime, hub });
    yield* round;
    assert.deepInclude(hub.reports.at(-1)?.sandboxes[0], {
      grantId: "grant-acme",
      state: "running",
      diskUsedBytes: 3 * GIB,
      diskMeasureFailures: 0,
    });
  }),
);

it.effect("removed from the Hub, every lent Sandbox and home goes and it stops asking", () =>
  Effect.gen(function* () {
    const runtime = makeRuntime();
    const hub = yield* makeHub([assignment("grant-acme", "org-acme")]);
    const { fiber, round } = yield* run({ runtime, hub });
    yield* Ref.set(hub.lent, { _tag: "removed" });
    yield* round;
    yield* Fiber.join(fiber);
    assert.include(runtime.deleted, lentSandboxIdOf("grant-acme"));
  }),
);
