/**
 * Grants ticket 15: a lent Vault group's use (`vault_grant_usage`, migration 150). SecretDelivery
 * counts each lent name a starting process receives; Grants reads a Grant's rows for its lender and
 * the borrowing Space's Admins. Names and counts only: no value, no Thread.
 */
import type { GrantVaultUsageRow, UserId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

/** A lent name delivered, and the Grant it came by. */
export interface Delivered {
  readonly grantId: string;
  readonly name: string;
}

/** Adds one process to each name's count for the day (UTC `YYYY-MM-DD`) and User. */
export const record = (
  sql: SqlClient.SqlClient,
  input: {
    readonly day: string;
    readonly userId: UserId | string;
    readonly delivered: ReadonlyArray<Delivered>;
  },
) => {
  // A name delivered twice in one process (it cannot be, by precedence) counts once.
  const unique = [
    ...new Map(input.delivered.map((d) => [`${d.grantId}\u0000${d.name}`, d])).values(),
  ];
  if (unique.length === 0) return Effect.void;
  return Effect.forEach(
    unique,
    (d) => sql`
      INSERT INTO vault_grant_usage (grant_id, day, user_id, name, deliveries)
      VALUES (${d.grantId}, ${input.day}, ${input.userId}, ${d.name}, 1)
      ON CONFLICT (grant_id, day, user_id, name) DO UPDATE SET deliveries = deliveries + 1
    `,
    { discard: true },
  );
};

/** A Grant's rows, newest day first, at most `limit` (and whether there were more). */
export const read = Effect.fn("VaultGrantUsage.read")(function* (
  sql: SqlClient.SqlClient,
  grantId: string,
  limit: number,
) {
  const rows = yield* sql<GrantVaultUsageRow>`
    SELECT u.day AS day, u.user_id AS "userId", p.display_name AS "userName", u.name AS name,
      u.deliveries AS deliveries
    FROM vault_grant_usage u LEFT JOIN users p ON p.user_id = u.user_id
    WHERE u.grant_id = ${grantId}
    ORDER BY u.day DESC, u.user_id, u.name
    LIMIT ${limit + 1}
  `;
  return { rows: rows.slice(0, limit), truncated: rows.length > limit };
});
