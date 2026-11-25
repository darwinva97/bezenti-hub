/**
 * Makita ticket 22: the line of issues waiting for a free slot. A queued trigger without a task
 * waits while its configuration (or the Hub) has as many tasks at work as it may. The line is the
 * `queued` rows of `makita_events`: nothing lives in memory, so a restart keeps it.
 */
import { MAKITA_HUB_DEFAULT_MAX_TASKS, type SpaceId, type UserId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

/** Tasks at work hold a slot: the activity's «Now». One waiting for a person holds none. */
const AT_WORK_STATES = ["running", "waiting-ci", "awaiting-approval"] as const;

/**
 * Queued details that never start a task: `/makita stop`, `/makita ok` (`APPROVAL_DETAIL`), a
 * merge order (`MERGE_DETAIL`) and what is said on a live task's pull request (`CONVERSATION`).
 * Spelled here so makitaRows stays free of the services; `MakitaQueue.test.ts` checks them.
 */
export const NEVER_STARTS = ["stop", "ok", "merge", "conversation"] as const;

/** A queued trigger with no task yet: the only kind of event that ever waits. */
const startsTask = (sql: SqlClient.SqlClient) =>
  sql`e.outcome = 'queued' AND e.task_id IS NULL AND e.config_id IS NOT NULL
    AND (e.detail IS NULL OR NOT (${sql.in("e.detail", [...NEVER_STARTS])}))`;

/** No live task holds its issue or pull request (a mention then wakes it, never waits). */
const noLiveTask = (sql: SqlClient.SqlClient) =>
  sql`NOT EXISTS (SELECT 1 FROM makita_tasks t
    WHERE t.host = e.host AND t.repo = e.repo
      AND (t.number = e.number OR t.pr_number = e.number)
      AND t.state NOT IN ('done', 'stopped', 'failed'))`;

interface StartingRow {
  readonly eventKey: string;
  readonly configId: string;
  readonly repo: string;
  readonly number: number;
}

/** What `startQueued` asks of each queued event, in arrival order. */
interface MakitaQueueGate {
  /** `run` it now (counted when it starts a task), or let it `wait` in line. */
  readonly admit: (eventKey: string) => "run" | "wait";
}

/**
 * The slots as they stand: each configuration's cap and tasks at work, the Hub's ceiling and
 * total. Events of a paused or deleted configuration, or with Makita stopped, are never held:
 * `startQueued` ignores them as before.
 */
export const queueGate = Effect.fn("makitaQueue.queueGate")(function* (sql: SqlClient.SqlClient) {
  const [account] = yield* sql<{ readonly maxTasks: number; readonly paused: number }>`
    SELECT max_tasks AS "maxTasks", global_paused_at IS NOT NULL AS paused
    FROM makita_account WHERE account_id = 'makita'
  `;
  const starting =
    account === undefined || account.paused === 1
      ? []
      : yield* sql<StartingRow>`
          SELECT e.event_key AS "eventKey", e.config_id AS "configId", e.repo, e.number
          FROM makita_events e JOIN makita_configs c ON c.config_id = e.config_id
          WHERE ${startsTask(sql)} AND c.paused_at IS NULL AND c.deleted_at IS NULL
            AND ${noLiveTask(sql)}
        `;
  const configs = yield* sql<{
    readonly configId: string;
    readonly maxTasks: number;
    readonly atWork: number;
  }>`
    SELECT c.config_id AS "configId", c.max_tasks AS "maxTasks",
      (SELECT COUNT(*) FROM makita_tasks t
        WHERE t.config_id = c.config_id AND ${sql.in("t.state", [...AT_WORK_STATES])}) AS "atWork"
    FROM makita_configs c WHERE c.deleted_at IS NULL
  `;
  const [hub] = yield* sql<{ readonly n: number }>`
    SELECT COUNT(*) AS n FROM makita_tasks WHERE ${sql.in("state", [...AT_WORK_STATES])}
  `;
  const byKey = new Map(starting.map((row) => [row.eventKey, row]));
  const atWork = new Map(configs.map((config) => [config.configId, config.atWork]));
  const caps = new Map(configs.map((config) => [config.configId, config.maxTasks]));
  const ceiling = account?.maxTasks ?? MAKITA_HUB_DEFAULT_MAX_TASKS;
  let total = hub?.n ?? 0;
  /** Issues given a task in this pass: a second trigger for one finds it open, never waits. */
  const taken = new Set<string>();
  return {
    admit: (eventKey) => {
      const row = byKey.get(eventKey);
      if (row === undefined) return "run";
      const issue = `${row.repo.toLowerCase()}#${row.number}`;
      if (taken.has(issue)) return "run";
      const used = atWork.get(row.configId) ?? 0;
      if (used >= (caps.get(row.configId) ?? 0) || total >= ceiling) return "wait";
      atWork.set(row.configId, used + 1);
      total += 1;
      taken.add(issue);
      return "run";
    },
  } satisfies MakitaQueueGate;
});

/** One configuration's line, oldest first, with each place in it. */
interface MakitaWaitingRow {
  readonly configId: string;
  readonly repo: string;
  readonly number: number;
  readonly kind: "issue" | "pull";
  readonly actorLogin: string | null;
  readonly since: string;
  readonly position: number;
}

/** The lines of these configurations (the activity's «Waiting»), each counted on its own. */
export const waitingOf = Effect.fn("makitaQueue.waitingOf")(function* (
  sql: SqlClient.SqlClient,
  configIds: ReadonlyArray<string>,
) {
  if (configIds.length === 0) return [] as ReadonlyArray<MakitaWaitingRow>;
  const rows = yield* sql<Omit<MakitaWaitingRow, "position">>`
    SELECT e.config_id AS "configId", e.repo, e.number, e.kind, e.actor_login AS "actorLogin",
      e.seen_at AS since
    FROM makita_events e JOIN makita_configs c ON c.config_id = e.config_id
    WHERE ${startsTask(sql)} AND ${sql.in("e.config_id", [...configIds])}
      AND c.paused_at IS NULL AND c.deleted_at IS NULL AND ${noLiveTask(sql)}
    ORDER BY e.seen_at, e.rowid LIMIT 200
  `;
  const places = new Map<string, number>();
  return rows.map((row): MakitaWaitingRow => {
    const position = (places.get(row.configId) ?? 0) + 1;
    places.set(row.configId, position);
    return { ...row, position };
  });
});

/** Where a stop reaches: the same scopes as `stopTasksWithin`. */
type MakitaQueueScope =
  | { readonly taskId: string }
  | { readonly configId: string }
  | { readonly creator: UserId; readonly spaceId: SpaceId | null }
  | {
      readonly issue: { readonly host: string; readonly repo: string; readonly number: number };
      /** Only this configuration's line (a `/makita stop` with no task yet). */
      readonly configId?: string;
    }
  | { readonly all: true };

/**
 * Inside a stop's transaction: the triggers of its scope still waiting for a task end with the
 * stop's reason, so a resumed configuration never replays them. One task stopped by id drops
 * nothing (its issue's line is its own).
 */
export const dropWaitingWithin = Effect.fn("makitaQueue.dropWaitingWithin")(function* (
  sql: SqlClient.SqlClient,
  scope: MakitaQueueScope,
  reason: string,
) {
  if ("taskId" in scope) return;
  const where =
    "issue" in scope
      ? sql`e.host = ${scope.issue.host} AND e.repo = ${scope.issue.repo}
          AND e.number = ${scope.issue.number}
          AND (${scope.configId ?? null} IS NULL OR e.config_id = ${scope.configId ?? null})`
      : "configId" in scope
        ? sql`e.config_id = ${scope.configId}`
        : "creator" in scope
          ? sql`e.config_id IN (SELECT config_id FROM makita_configs
              WHERE created_by = ${scope.creator}
                AND (${scope.spaceId} IS NULL OR space_id = ${scope.spaceId}))`
          : sql`1 = 1`;
  const outcome = "issue" in scope ? "ignored-no-config" : "ignored-paused";
  yield* sql`
    UPDATE makita_events AS e SET outcome = ${outcome}, detail = ${reason}
    WHERE ${startsTask(sql)} AND ${where}
  `;
});
