/**
 * Owned-resources 03: every owner, a User or an Organization, has one Vault made of groups, among
 * them its `default`, made with the owner and never deleted, renamed or archived. A leaf module:
 * whoever makes an owner (an Organization, a User) makes its `default` in the same transaction.
 */
import { DEFAULT_VAULT_GROUP_NAME } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

/** Makes the owner's `default` group unless it has one. Idempotent, in the caller's transaction. */
export const ensureDefault = (
  sql: SqlClient.SqlClient,
  owner: { readonly ownerKind: "user" | "organization"; readonly ownerId: string },
) =>
  sql`
    INSERT INTO vault_groups (group_id, owner_kind, owner_id, name, is_default, created_at,
      updated_at)
    SELECT 'vault-default-' || lower(hex(randomblob(16))), ${owner.ownerKind}, ${owner.ownerId},
      ${DEFAULT_VAULT_GROUP_NAME}, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE NOT EXISTS (
      SELECT 1 FROM vault_groups
      WHERE owner_kind = ${owner.ownerKind} AND owner_id = ${owner.ownerId} AND is_default = 1
    )
  `.pipe(Effect.asVoid);
