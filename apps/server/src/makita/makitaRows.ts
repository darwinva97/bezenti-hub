/**
 * Small reads and writes of Makita's tables shared by its services and by the transactions of
 * others (a permission taken back, a User removed): no service of their own, no cycle between
 * MakitaPermissions and MakitaConfigs.
 */
import { SpaceId, UserId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as SqlClient from "effect/sql/SqlClient";

import * as AuditLog from "../audit/AuditLog.ts";
import { storedAutonomyOf } from "./makitaAutonomy.ts";

/** A Thread's Makita task: what makes it a Makita Thread (ticket 05). */
export interface MakitaThreadTask {
  readonly taskId: string;
  readonly configId: string;
  readonly spaceId: SpaceId;
  readonly state: string;
  /** The configuration's creator: the Thread is theirs and runs as them. */
  readonly createdBy: UserId;
  /**
   * Why Makita may not work on this task now (ticket 06), or null while it may: Makita stopped
   * (or no account), the configuration paused or deleted, or the task no longer live.
   */
  readonly halted: "makita-paused" | "config-paused" | "task-ended" | null;
  /** What its configuration lets it do (ticket 10: only `push` sees `makita_push`). */
  readonly capability: string;
  /** Ticket 13: whether its configuration may land (only `push` sees `makita_request_merge`). */
  readonly mayLand: boolean;
  /** Ticket 24: whether its configuration lists labels Makita may set (`makita_label`). */
  readonly labels: boolean;
  /** Ticket 26: whether its configuration may close issues (`makita_close_issue`). */
  readonly mayCloseIssues: boolean;
}

/** The states in which a task still works (or waits to); anything else has ended. */
const LIVE_TASK_STATES = ["awaiting-approval", "running", "waiting-ci", "waiting-reply"];

/**
 * The Makita task whose Thread this is, if any: one indexed read. The row exists before the
 * Thread does, so every turn, tool call and gateway request of a Makita Thread finds it. Read by
 * EffectiveVaults (no Vault values), the MCP door (the tool allow-list), the Thread moves (it
 * stays where it works) and, from tickets 06–07, the gateway (pause, usage).
 */
export const makitaTaskOfThread = Effect.fn("makitaRows.makitaTaskOfThread")(function* (
  sql: SqlClient.SqlClient,
  threadId: string,
) {
  const rows = yield* sql<{
    readonly taskId: string;
    readonly configId: string;
    readonly spaceId: string;
    readonly state: string;
    readonly createdBy: string;
    readonly configPaused: number;
    readonly makitaPaused: number;
    readonly capability: string;
    readonly mayLand: number;
    readonly labels: number;
    readonly autonomyJson: string;
  }>`
    SELECT t.task_id AS "taskId", t.config_id AS "configId", t.space_id AS "spaceId",
      t.state, c.created_by AS "createdBy", c.capability, c.may_land AS "mayLand",
      (c.labels_json <> '[]') AS labels, c.autonomy_json AS "autonomyJson",
      (c.paused_at IS NOT NULL OR c.deleted_at IS NOT NULL) AS "configPaused",
      COALESCE((SELECT global_paused_at IS NOT NULL FROM makita_account
        WHERE account_id = 'makita'), 1) AS "makitaPaused"
    FROM makita_tasks t JOIN makita_configs c ON c.config_id = t.config_id
    WHERE t.thread_id = ${threadId}
  `;
  const row = rows[0];
  return row === undefined
    ? Option.none<MakitaThreadTask>()
    : Option.some<MakitaThreadTask>({
        taskId: row.taskId,
        configId: row.configId,
        spaceId: SpaceId.make(row.spaceId),
        state: row.state,
        createdBy: UserId.make(row.createdBy),
        capability: row.capability,
        mayLand: row.mayLand === 1,
        labels: row.labels === 1,
        mayCloseIssues: storedAutonomyOf(row.autonomyJson).closeIssues,
        halted: row.makitaPaused
          ? "makita-paused"
          : row.configPaused
            ? "config-paused"
            : LIVE_TASK_STATES.includes(row.state)
              ? null
              : "task-ended",
      });
});

/** Why a task stopped (its `failure`, and the audit's `reason`). */
export type MakitaTaskStopReason =
  | "manual"
  | "config-paused"
  | "config-deleted"
  | "makita-paused"
  | "permission-revoked"
  | "creator-left"
  | "creator-disabled"
  | "issue-closed"
  | "issue-locked"
  // Ticket 09: an allowed person wrote `/makita stop` on the issue.
  | "github-stop"
  // Ticket 14: Makita's pull request closed without a merge, or locked.
  | "pr-closed"
  | "pr-locked"
  // Ticket 27: its pull request closed by the Hub: idle for days, or an approver's bad-work label.
  | "pr-idle"
  | "bad-work";

/** A task just stopped: what the turn interrupt and the answers need. */
interface StoppedMakitaTask {
  readonly taskId: string;
  readonly threadId: string;
}

/**
 * Stops, inside the caller's transaction, every live task in scope (ticket 06): `stopped` with its
 * reason, a pending approval cancelled with it, each audited `makita.task.stop`. The turns are
 * interrupted outside the transaction by `MakitaStops`, which reads what this wrote.
 */
export const stopTasksWithin = Effect.fn("makitaRows.stopTasksWithin")(function* (
  sql: SqlClient.SqlClient,
  input: {
    readonly actor: AuditLog.AuditActor;
    readonly scope:
      | { readonly taskId: string }
      | { readonly configId: string }
      | { readonly creator: UserId; readonly spaceId: SpaceId | null }
      | {
          readonly issue: { readonly host: string; readonly repo: string; readonly number: number };
        }
      | { readonly all: true };
    readonly reason: MakitaTaskStopReason;
  },
) {
  const at = DateTime.formatIso(yield* DateTime.now);
  const scope = input.scope;
  const where =
    "taskId" in scope
      ? sql`task_id = ${scope.taskId}`
      : "configId" in scope
        ? sql`config_id = ${scope.configId}`
        : "creator" in scope
          ? sql`config_id IN (SELECT config_id FROM makita_configs
              WHERE created_by = ${scope.creator}
                AND (${scope.spaceId} IS NULL OR space_id = ${scope.spaceId}))`
          : "issue" in scope
            ? // Ticket 14: an issue's task, or the task whose pull request it is (one numbering).
              sql`host = ${scope.issue.host} AND repo = ${scope.issue.repo}
                AND (number = ${scope.issue.number} OR pr_number = ${scope.issue.number})`
            : sql`1 = 1`;
  const stopped = yield* sql<{
    readonly taskId: string;
    readonly threadId: string;
    readonly configId: string;
    readonly spaceId: string;
    readonly repo: string;
    readonly number: number;
  }>`
    UPDATE makita_tasks SET state = 'stopped', failure = ${input.reason},
      pending_push_json = NULL, updated_at = ${at}
    WHERE ${where} AND state NOT IN ('done', 'stopped', 'failed')
    RETURNING task_id AS "taskId", thread_id AS "threadId", config_id AS "configId",
      space_id AS "spaceId", repo, number
  `;
  const write = AuditLog.write(sql);
  for (const row of stopped) {
    yield* write({
      actor: input.actor,
      action: "makita.task.stop",
      spaceId: SpaceId.make(row.spaceId),
      target: { kind: "makita_task", id: row.taskId, name: `${row.repo}#${row.number}` },
      detail: {
        space: row.spaceId,
        repo: row.repo,
        number: row.number,
        makita: row.configId,
        reason: input.reason,
      },
    });
  }
  return stopped.map((row): StoppedMakitaTask => ({ taskId: row.taskId, threadId: row.threadId }));
});

/**
 * Makita ticket 07: configurations' names, for usage rows that already passed their reader's
 * checks (a deleted configuration keeps its name: its usage stays).
 */
export const configNames = Effect.fn("makitaRows.configNames")(function* (
  sql: SqlClient.SqlClient,
  configIds: ReadonlyArray<string>,
) {
  if (configIds.length === 0) return [] as ReadonlyArray<{ id: string; name: string }>;
  return yield* sql<{ readonly id: string; readonly name: string }>`
    SELECT config_id AS id, name FROM makita_configs WHERE ${sql.in("config_id", configIds)}
  `;
});

/** Whether a User holds «may use Makita» in a Space (whether it takes effect is the policy's). */
export const permittedIn = Effect.fn("makitaRows.permittedIn")(function* (
  sql: SqlClient.SqlClient,
  userId: UserId,
  spaceId: SpaceId,
) {
  const rows = yield* sql<{ readonly n: number }>`
    SELECT COUNT(*) AS n FROM makita_permissions
    WHERE user_id = ${userId} AND space_id = ${spaceId}
  `;
  return (rows[0]?.n ?? 0) > 0;
});

/**
 * Pauses, inside the caller's transaction, a User's live configurations that are running: of one
 * Space (their permission there taken back) or of every Space (they left the Hub). Each audited
 * with its reason; one already paused keeps its own. Their live tasks stop with the same reason.
 */
export const pauseCreatorConfigsWithin = Effect.fn("makitaRows.pauseCreatorConfigsWithin")(
  function* (
    sql: SqlClient.SqlClient,
    input: {
      readonly actor: AuditLog.AuditActor;
      readonly pausedBy: UserId | null;
      readonly creator: UserId;
      readonly spaceId: SpaceId | null;
      readonly reason: "permission-revoked" | "creator-left" | "creator-disabled";
    },
  ) {
    const at = DateTime.formatIso(yield* DateTime.now);
    const paused = yield* sql<{
      readonly configId: string;
      readonly spaceId: string;
      readonly name: string;
    }>`
      UPDATE makita_configs SET paused_at = ${at}, paused_by = ${input.pausedBy},
        paused_reason = ${input.reason}, updated_at = ${at}
      WHERE created_by = ${input.creator} AND deleted_at IS NULL AND paused_at IS NULL
        AND (${input.spaceId} IS NULL OR space_id = ${input.spaceId})
      RETURNING config_id AS "configId", space_id AS "spaceId", name
    `;
    const write = AuditLog.write(sql);
    for (const row of paused) {
      yield* write({
        actor: input.actor,
        action: "makita.config.pause",
        spaceId: SpaceId.make(row.spaceId),
        target: { kind: "makita_config", id: row.configId, name: row.name },
        detail: { space: row.spaceId, reason: input.reason },
      });
    }
    // Their running work stops with them (ticket 06); `MakitaStops` interrupts the turns.
    yield* stopTasksWithin(sql, {
      actor: input.actor,
      scope: { creator: input.creator, spaceId: input.spaceId },
      reason: input.reason,
    });
  },
);
