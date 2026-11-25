/**
 * Whether each Thread has a turn going (a run preparing, queued, starting, running or waiting) and
 * whether it ever had one. Read for Makita (ticket 22): a task whose turn ended gives its slot back.
 */
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

/** The run states the Hub counts as a turn still going (as Sandboxes and EnvironmentRegistry). */
const LIVE_RUN_STATUSES = ["preparing", "queued", "starting", "running", "waiting"];

/** Each named Thread that ever had a turn, and whether one is still going; others are absent. */
export const threadTurnsOf = Effect.fn("threadTurns.threadTurnsOf")(function* (
  sql: SqlClient.SqlClient,
  threadIds: ReadonlyArray<string>,
) {
  if (threadIds.length === 0) return new Map<string, { readonly going: boolean }>();
  const rows = yield* sql<{ readonly threadId: string; readonly going: number }>`
    SELECT thread_id AS "threadId",
      SUM(CASE WHEN ${sql.in("status", LIVE_RUN_STATUSES)} THEN 1 ELSE 0 END) AS going
    FROM orchestration_v2_projection_runs
    WHERE ${sql.in("thread_id", [...threadIds])}
    GROUP BY thread_id
  `;
  return new Map(rows.map((row) => [row.threadId, { going: row.going > 0 }]));
});
