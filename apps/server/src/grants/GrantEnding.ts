/**
 * Loans whose side is gone (owned-resources 10): every live loan to a removed Space ends
 * `target-gone`, every one its owner gave `lender-gone`, whatever the kind; in the removal's own
 * transaction. The caller closes ended machine loans' Sandboxes (`closeLentSandbox`).
 */
import { type GrantEndReason, SpaceId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

import * as AuditLog from "../audit/AuditLog.ts";

/** Which removal ends them; recorded as the audit's `via`. */
export type GrantEndingVia = "user.remove" | "organization.delete";

/** The side that is gone: loans to its Space, or loans it gave. */
export type GoneSide =
  | { readonly target: string }
  | { readonly lender: { readonly kind: "user" | "organization"; readonly id: string } };

/** A loan ended here: its id and the lent Sandbox it ran, if it was a machine's. */
export interface EndedGrant {
  readonly grantId: string;
  readonly lentEnvironmentId: string | null;
}

interface LiveRow {
  readonly grantId: string;
  readonly state: "offered" | "pending" | "active";
  readonly resourceKind: string;
  readonly resourceId: string;
  readonly lenderId: string;
  readonly targetId: string | null;
  readonly resourceName: string | null;
  readonly lentEnvironmentId: string | null;
}

/**
 * Ends every live loan on the side that is gone: `pending` and `active` ones end with `reason`,
 * an `offered` one (never accepted, a lending link) is cancelled. Answers each with its lent
 * Sandbox.
 */
export const endGone = Effect.fn("GrantEnding.endGone")(function* (
  sql: SqlClient.SqlClient,
  actor: AuditLog.AuditActor,
  side: GoneSide,
  via: GrantEndingVia,
) {
  const reason: GrantEndReason = "target" in side ? "target-gone" : "lender-gone";
  const where =
    "target" in side
      ? sql`g.target_kind = 'space' AND g.target_id = ${side.target}`
      : sql`g.lender_kind = ${side.lender.kind} AND g.lender_id = ${side.lender.id}`;
  const now = DateTime.formatIso(yield* DateTime.now);
  const live = yield* sql<LiveRow>`
    SELECT g.grant_id AS "grantId", g.state AS state, g.resource_kind AS "resourceKind",
      g.resource_id AS "resourceId", g.lender_id AS "lenderId", g.target_id AS "targetId",
      CASE g.resource_kind
        WHEN 'environment' THEN (SELECT name FROM environments WHERE environment_id = g.resource_id)
        WHEN 'ai-account' THEN (SELECT name FROM ai_accounts WHERE account_id = g.resource_id)
        WHEN 'vault-group' THEN (SELECT name FROM vault_groups WHERE group_id = g.resource_id)
        ELSE NULL END AS "resourceName",
      (SELECT e.environment_id FROM environments e
        WHERE e.grant_id = g.grant_id AND e.revoked_at IS NULL) AS "lentEnvironmentId"
    FROM grants g
    WHERE ${where} AND (g.state IN ('pending', 'active')
      OR (g.state = 'offered' AND (g.offer_expires_at IS NULL OR g.offer_expires_at > ${now})))
    ORDER BY g.created_at, g.grant_id
  `;
  if (live.length === 0) return [] as ReadonlyArray<EndedGrant>;
  const write = AuditLog.write(sql);
  for (const row of live) {
    const offered = row.state === "offered";
    // An offer never accepted (a lending link, with no destination yet) is cancelled.
    yield* offered
      ? sql`
          UPDATE grants SET state = 'cancelled', decided_at = ${now}, decided_by = NULL
          WHERE grant_id = ${row.grantId} AND state = 'offered'
        `
      : sql`
          UPDATE grants SET state = 'ended', end_reason = ${reason}, ended_at = ${now},
            ended_by = NULL
          WHERE grant_id = ${row.grantId} AND state = ${row.state}
        `;
    const common = {
      resourceKind: row.resourceKind,
      resourceId: row.resourceId,
      resourceName: row.resourceName,
      lenderId: row.lenderId,
      targetSpaceId: row.targetId,
      via,
    };
    const spaceId = row.targetId === null ? null : SpaceId.make(row.targetId);
    const target = {
      kind: "grant",
      id: row.grantId,
      ...(row.resourceName === null ? {} : { name: row.resourceName }),
    } as const;
    // Under the Space it was lent to, as every other end of a loan.
    yield* offered
      ? write({ actor, action: "grant.cancel", spaceId, target, detail: common })
      : write({
          actor,
          action: "grant.end",
          spaceId,
          target,
          detail: { ...common, reason, side: "system" },
        });
  }
  return live.map((row): EndedGrant => ({
    grantId: row.grantId,
    lentEnvironmentId: row.lentEnvironmentId,
  }));
});
