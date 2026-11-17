/**
 * Grants in tests: an AI account lent to a Space by an active Grant, written as `Grants` leaves
 * one (for tests about what a loan reaches, not about lending), and the active ones of an account.
 */
import {
  AiAccountGrantLimits,
  type AiAccountId,
  type GrantId,
  type SpaceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

const AT = "2026-11-01T00:00:00.000Z";
const NO_CAP: typeof AiAccountGrantLimits.Type = {
  kind: "ai-account",
  tokens: null,
  requests: null,
};

let lent = 0;
const encodeLimits = Schema.encodeEffect(Schema.fromJsonString(AiAccountGrantLimits));

/** An active Grant of `accountId` to `spaceId` by its owner `lender`; returns its id. */
export const lendAiAccount = Effect.fn("Grants.testkit.lendAiAccount")(function* (
  sql: SqlClient.SqlClient,
  input: {
    readonly accountId: AiAccountId | string;
    readonly lender: { readonly kind: "user" | "organization"; readonly id: string };
    readonly spaceId: SpaceId | string;
    readonly limits?: AiAccountGrantLimits;
  },
) {
  lent += 1;
  const grantId = `grant-test-${lent}-${input.accountId}` as GrantId;
  const limitsJson = yield* encodeLimits(input.limits ?? NO_CAP).pipe(Effect.orDie);
  yield* sql`
    INSERT INTO grants (grant_id, resource_kind, resource_id, lender_kind, lender_id,
      target_kind, target_id, state, limits_json, created_at, created_by, decided_at, decided_by)
    VALUES (${grantId}, 'ai-account', ${input.accountId}, ${input.lender.kind}, ${input.lender.id},
      'space', ${input.spaceId}, 'active', ${limitsJson}, ${AT},
      ${input.lender.kind === "user" ? input.lender.id : null}, ${AT}, NULL)
  `;
  return grantId;
});

/** The active Grants of an AI account, oldest first. */
export const activeAiGrants = (sql: SqlClient.SqlClient, accountId: AiAccountId | string) =>
  sql<{ readonly grantId: GrantId; readonly spaceId: SpaceId }>`
    SELECT grant_id AS "grantId", target_id AS "spaceId" FROM grants
    WHERE resource_kind = 'ai-account' AND resource_id = ${accountId} AND state = 'active'
    ORDER BY decided_at, grant_id
  `;
