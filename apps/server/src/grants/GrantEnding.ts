/**
 * Loans that end by themselves (owned-resources 10, Grants ticket 11): every live loan to a removed
 * Space ends `target-gone`, every one its owner gave `lender-gone`, every one of a deleted
 * resource `resource-gone`, whatever the kind; in the removal's own transaction, as «Take back»
 * ends one. The caller closes ended machine loans' Sandboxes (`closeLentSandbox`).
 */
import { type GrantEndReason, type GrantResourceKind, SpaceId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

import * as AuditLog from "../audit/AuditLog.ts";
import * as VaultReachLoss from "../vaults/VaultReachLoss.ts";

/** Which removal ends them; recorded as the audit's `via`. */
export type GrantEndingVia =
  | "user.remove"
  | "organization.delete"
  | "ai_account.delete"
  | "vault_group.delete"
  | "space_mcp.delete"
  | "space_skill.delete"
  | "environment.remove"
  | "environment.mode.change";

/** The side that is gone: loans to its Space, loans it gave, or loans of the resource. */
export type GoneSide =
  | { readonly target: string }
  | { readonly lender: { readonly kind: "user" | "organization"; readonly id: string } }
  | {
      readonly resource: { readonly kind: GrantResourceKind; readonly id: string };
      /** `owner-changed` when the resource stays but is no longer its lender's. */
      readonly reason?: "resource-gone" | "owner-changed";
    };

/** A loan ended here: its id, its kind and the lent Sandbox it ran, if it was a machine's. */
export interface EndedGrant {
  readonly grantId: string;
  readonly resourceKind: GrantResourceKind;
  readonly lentEnvironmentId: string | null;
}

/**
 * The names a loan shows once their rows may be gone (a deleted group, a purged AI account, a
 * deleted Organization), as a SET clause of `UPDATE grants`: the live name when there is one,
 * else the one kept. Written on every change of a loan's state.
 */
export const KEEP_NAMES_SQL = `
  resource_name = COALESCE(CASE grants.resource_kind
    WHEN 'environment' THEN (SELECT name FROM environments WHERE environment_id = grants.resource_id)
    WHEN 'ai-account' THEN (SELECT name FROM ai_accounts WHERE account_id = grants.resource_id)
    WHEN 'vault-group' THEN (SELECT name FROM vault_groups WHERE group_id = grants.resource_id)
    WHEN 'space-mcp' THEN (SELECT name FROM space_mcps WHERE mcp_id = grants.resource_id)
    WHEN 'space-skill' THEN (SELECT name FROM space_skills WHERE skill_id = grants.resource_id)
    END, grants.resource_name),
  lender_name = COALESCE(CASE grants.lender_kind
    WHEN 'user' THEN (SELECT display_name FROM users WHERE user_id = grants.lender_id)
    ELSE (SELECT name FROM spaces WHERE space_id = grants.lender_id) END, grants.lender_name),
  target_name = COALESCE((SELECT name FROM spaces WHERE space_id = grants.target_id),
    grants.target_name)`;

interface LiveRow {
  readonly grantId: string;
  readonly state: "offered" | "pending" | "active";
  readonly resourceKind: GrantResourceKind;
  readonly resourceId: string;
  readonly lenderId: string;
  readonly targetId: string | null;
  readonly resourceName: string | null;
  readonly lentEnvironmentId: string | null;
}

const reasonOf = (side: GoneSide): GrantEndReason =>
  "target" in side
    ? "target-gone"
    : "lender" in side
      ? "lender-gone"
      : (side.reason ?? "resource-gone");

/**
 * Ends every live loan on the side that is gone: `pending` and `active` ones end with its reason,
 * an `offered` one (never accepted, a lending link) is cancelled. Answers each with its lent
 * Sandbox. Call it before the rows it names are deleted: their names are kept from them.
 */
export const endGone = Effect.fn("GrantEnding.endGone")(function* (
  sql: SqlClient.SqlClient,
  actor: AuditLog.AuditActor,
  side: GoneSide,
  via: GrantEndingVia,
) {
  const reason = reasonOf(side);
  const where =
    "target" in side
      ? sql`g.target_kind = 'space' AND g.target_id = ${side.target}`
      : "lender" in side
        ? sql`g.lender_kind = ${side.lender.kind} AND g.lender_id = ${side.lender.id}`
        : sql`g.resource_kind = ${side.resource.kind} AND g.resource_id = ${side.resource.id}`;
  const now = DateTime.formatIso(yield* DateTime.now);
  const live = yield* sql<LiveRow>`
    SELECT g.grant_id AS "grantId", g.state AS state, g.resource_kind AS "resourceKind",
      g.resource_id AS "resourceId", g.lender_id AS "lenderId", g.target_id AS "targetId",
      COALESCE(CASE g.resource_kind
        WHEN 'environment' THEN (SELECT name FROM environments WHERE environment_id = g.resource_id)
        WHEN 'ai-account' THEN (SELECT name FROM ai_accounts WHERE account_id = g.resource_id)
        WHEN 'vault-group' THEN (SELECT name FROM vault_groups WHERE group_id = g.resource_id)
        WHEN 'space-mcp' THEN (SELECT name FROM space_mcps WHERE mcp_id = g.resource_id)
        WHEN 'space-skill' THEN (SELECT name FROM space_skills WHERE skill_id = g.resource_id)
        ELSE NULL END, g.resource_name) AS "resourceName",
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
          UPDATE grants SET state = 'cancelled', decided_at = ${now}, decided_by = NULL,
            ${sql.literal(KEEP_NAMES_SQL)}
          WHERE grant_id = ${row.grantId} AND state = 'offered'
        `
      : sql`
          UPDATE grants SET state = 'ended', end_reason = ${reason}, ended_at = ${now},
            ended_by = NULL, ${sql.literal(KEEP_NAMES_SQL)}
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
    // A lent Vault group's default and choices in that Space go with the loan (Grants ticket 07).
    if (!offered && row.resourceKind === "vault-group" && row.targetId !== null) {
      yield* VaultReachLoss.forgetLentReach(sql, actor, {
        vaultId: row.resourceId,
        spaceId: row.targetId,
      });
    }
  }
  return live.map((row): EndedGrant => ({
    grantId: row.grantId,
    resourceKind: row.resourceKind,
    lentEnvironmentId: row.state === "offered" ? null : row.lentEnvironmentId,
  }));
});
