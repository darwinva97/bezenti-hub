/** Owned-resources 03 in tests: the Owner's `default` group (the Main vault before), and owners. */
import { type SpaceId, type UserId, VaultGroupId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

/** The Installation Owner's `default` group, made with the Owner. */
export const ownersDefault = (sql: SqlClient.SqlClient) =>
  sql<{ readonly groupId: string }>`
    SELECT g.group_id AS "groupId" FROM vault_groups g
    JOIN users u ON u.user_id = g.owner_id AND u.is_owner = 1
    WHERE g.owner_kind = 'user' AND g.is_default = 1
  `.pipe(Effect.map((rows) => VaultGroupId.make(rows[0]?.groupId ?? "no-owner-default")));

/** A group's owner: an Organization, or a User. */
export const orgOwner = (spaceId: SpaceId) => ({ kind: "organization" as const, spaceId });
export const userOwner = (userId: UserId) => ({ kind: "user" as const, userId });
