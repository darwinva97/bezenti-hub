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

/** A Thread's Makita task: what makes it a Makita Thread (ticket 05). */
export interface MakitaThreadTask {
  readonly taskId: string;
  readonly configId: string;
  readonly spaceId: SpaceId;
  readonly state: string;
  /** The configuration's creator: the Thread is theirs and runs as them. */
  readonly createdBy: UserId;
}

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
  }>`
    SELECT t.task_id AS "taskId", t.config_id AS "configId", t.space_id AS "spaceId",
      t.state, c.created_by AS "createdBy"
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
      });
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
 * with its reason; one already paused keeps its own.
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
  },
);
