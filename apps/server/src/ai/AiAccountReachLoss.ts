/**
 * Spec 4 ticket 11: what a removal drops of the AI accounts, in the removal's own transaction: the
 * gateway keys it ends, audited. The request check (`AiGatewayKeys.authorize`) refuses them
 * anyway; this keeps the record true at once. (Allowances became Grants, Grants ticket 02; a
 * Grant to what is gone lends nothing, and its ending is Grants ticket 11.)
 */
import type { SpaceId, UserId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

import type * as AuditLog from "../audit/AuditLog.ts";
import * as AiGatewayKeys from "./AiGatewayKeys.ts";

/**
 * A User removed from the Installation (inside `InstallationUserService`'s transaction): every
 * key of theirs revoked (`user-inactive`). Their Threads' choices stay: nobody runs their turns
 * any more.
 */
export const forgetUser = Effect.fn("AiAccountReachLoss.forgetUser")(function* (
  sql: SqlClient.SqlClient,
  actor: AuditLog.AuditActor,
  userId: UserId,
) {
  yield* AiGatewayKeys.revokeWithin(sql, actor, { userId }, "user-inactive");
});

/**
 * An Organization deleted (inside `OrganizationLifecycle.delete`'s transaction, its Threads
 * already gone): the keys made for its Space revoked (`space-lost`).
 */
export const forgetSpace = Effect.fn("AiAccountReachLoss.forgetSpace")(function* (
  sql: SqlClient.SqlClient,
  actor: AuditLog.AuditActor,
  spaceId: SpaceId,
) {
  yield* AiGatewayKeys.revokeWithin(sql, actor, { spaceId }, "space-lost");
});
