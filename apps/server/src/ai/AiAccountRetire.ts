/**
 * An AI account deleted, in the deleting write's transaction: its moved keys go (its loans lend
 * nothing once it is deleted; ending them is Grants ticket 11),
 * its credential waits in `ai_account_retired_credentials` until the gateway no longer holds it
 * (`AiAccounts.cleanupRetired`), then the row goes. Shared by «Delete» and the removals.
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

import * as AuditLog from "../audit/AuditLog.ts";

/** One account out: the rows of «Delete», without its audit. */
export const retireWithin = Effect.fn("AiAccountRetire.retireWithin")(function* (
  sql: SqlClient.SqlClient,
  account: { readonly accountId: string; readonly credentialId: string | null },
) {
  const at = DateTime.formatIso(yield* DateTime.now);
  // Ticket 09: a key moved into it and saved again later is moved again, never lost.
  yield* sql`DELETE FROM ai_account_migrated_keys WHERE account_id = ${account.accountId}`;
  if (account.credentialId !== null) {
    yield* sql`
      INSERT INTO ai_account_retired_credentials (credential_id, account_id, retired_at)
      VALUES (${account.credentialId}, ${account.accountId}, ${at})
    `;
  }
  yield* sql`
    UPDATE ai_accounts SET deleted_at = ${at}, credential_id = NULL, status = 'removing',
      status_message = NULL, updated_at = ${at}
    WHERE account_id = ${account.accountId}
  `;
});

/**
 * Owned-resources 10: every live account of an owner that is gone (a User removed, an
 * Organization deleted), each audited `ai_account.delete` with `via`. Answers how many.
 */
export const retireOwned = Effect.fn("AiAccountRetire.retireOwned")(function* (
  sql: SqlClient.SqlClient,
  actor: AuditLog.AuditActor,
  owner: { readonly kind: "user" | "organization"; readonly id: string },
  via: "user.remove" | "organization.delete",
) {
  const accounts = yield* sql<{
    readonly accountId: string;
    readonly name: string;
    readonly provider: string;
    readonly credentialId: string | null;
  }>`
    SELECT account_id AS "accountId", name, provider, credential_id AS "credentialId"
    FROM ai_accounts
    WHERE owner_kind = ${owner.kind} AND owner_id = ${owner.id} AND deleted_at IS NULL
    ORDER BY priority, account_id
  `;
  const write = AuditLog.write(sql);
  for (const account of accounts) {
    yield* retireWithin(sql, account);
    yield* write({
      actor,
      action: "ai_account.delete",
      target: { kind: "ai_account", id: account.accountId, name: account.name },
      detail: { provider: account.provider, ownerKind: owner.kind, ownerId: owner.id, via },
    });
  }
  return accounts.length;
});
