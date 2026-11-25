/**
 * Interrupts the turn of each Makita task stopped by a door (Makita ticket 06), as the system, on
 * the Scheduler: the doors live below the orchestration, and a sweep survives a crash after commit.
 */
import { CommandId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import type { MakitaTaskStopReason } from "./makitaRows.ts";

/** Tasks stopped longer ago than this are left alone (a restart re-sends nothing older). */
const WINDOW_MS = 60 * 60 * 1_000;
/** A dispatch that keeps failing is given up after this many passes. */
const MAX_ATTEMPTS = 3;

/** What the Thread says about why its turn ended. */
const REASONS: Readonly<Record<MakitaTaskStopReason, string>> = {
  manual: "the task was stopped",
  "config-paused": "its configuration was paused",
  "config-deleted": "its configuration was deleted",
  "makita-paused": "all Makita work was stopped",
  "permission-revoked": "its configuration's creator may no longer use Makita here",
  "creator-left": "its configuration's creator left",
  "creator-disabled": "its configuration's creator was disabled",
  "issue-closed": "the issue was closed",
  "issue-locked": "the issue was locked",
  "github-stop": "someone asked on GitHub to stop",
  "pr-closed": "its pull request was closed",
  "pr-locked": "its pull request was locked",
};

/** The `thread.stop` reason for a task's failure. */
const stopReasonText = (failure: string | null) =>
  `Makita stopped this work: ${
    failure !== null && failure in REASONS
      ? REASONS[failure as MakitaTaskStopReason]
      : "the task was stopped"
  }.`;

/** The command that interrupts a stopped task's turn: one per task, so a repeat replays nothing. */
export const stopCommandIdOf = (taskId: string) => CommandId.make(`makita-stop:${taskId}`);

export class MakitaStops extends Context.Service<
  MakitaStops,
  {
    /** One pass: every task stopped recently and not handled yet gets its turn interrupted. */
    readonly interruptStopped: Effect.Effect<void>;
  }
>()("t3/makita/MakitaStops") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  /** Tasks handled by this process (or given up), with when they stopped; pruned past the window. */
  const handled = yield* Ref.make(new Map<string, number>());
  const attempts = yield* Ref.make(new Map<string, number>());

  const interruptStopped = Effect.gen(function* () {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const since = DateTime.formatIso(DateTime.makeUnsafe(now - WINDOW_MS));
    const rows = yield* sql<{
      readonly taskId: string;
      readonly threadId: string;
      readonly failure: string | null;
      readonly updatedAt: string;
    }>`
      SELECT task_id AS "taskId", thread_id AS "threadId", failure, updated_at AS "updatedAt"
      FROM makita_tasks WHERE state = 'stopped' AND updated_at >= ${since}
      ORDER BY updated_at, task_id
    `;
    const done = yield* Ref.get(handled);
    for (const [taskId, at] of done) if (at < now - WINDOW_MS) done.delete(taskId);
    for (const row of rows) {
      if (done.has(row.taskId)) continue;
      const result = yield* threads
        .dispatch({
          type: "thread.stop",
          commandId: stopCommandIdOf(row.taskId),
          threadId: ThreadId.make(row.threadId),
          reason: stopReasonText(row.failure),
        })
        .pipe(Effect.exit);
      if (result._tag === "Success") {
        done.set(row.taskId, now);
        continue;
      }
      const tries = ((yield* Ref.get(attempts)).get(row.taskId) ?? 0) + 1;
      yield* Ref.update(attempts, (current) => new Map(current).set(row.taskId, tries));
      if (tries >= MAX_ATTEMPTS) {
        done.set(row.taskId, now);
        yield* Effect.logWarning("Makita could not interrupt a stopped task's turn", {
          taskId: row.taskId,
          cause: Cause.pretty(result.cause),
        });
      }
    }
    yield* Ref.set(handled, done);
    yield* Ref.update(attempts, (current) => {
      const next = new Map(current);
      for (const taskId of next.keys()) if (done.has(taskId)) next.delete(taskId);
      return next;
    });
  }).pipe(
    Effect.catch((cause) => Effect.logError("Makita could not read its stopped tasks", { cause })),
    Effect.withSpan("MakitaStops.interruptStopped"),
  );

  return MakitaStops.of({ interruptStopped });
});

/** Over the Hub's SQL and its Thread commands (as the system: no actor on the Scheduler). */
export const layer = Layer.effect(MakitaStops, make);

/** On the Hub's Scheduler, apart from the intake so a slow GitHub never delays a stop. */
export const layerScheduled = Layer.effectDiscard(
  Effect.gen(function* () {
    const scheduler = yield* Scheduler.Scheduler;
    const stops = yield* MakitaStops;
    yield* scheduler.register("makita-stops", stops.interruptStopped);
  }),
);
