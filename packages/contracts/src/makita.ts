import * as Schema from "effect/Schema";

import { SpaceId, UserId } from "./baseSchemas.ts";

/**
 * Makita (spec `makita`): the GitHub bot teammate. A normal GitHub account the Owner registers
 * once; its token stays sealed in the Hub, never in an answer, a Vault, a machine or a Thread.
 * Only WS `makita.*`, for a person's own session; no agent, HTTP endpoint or MCP tool changes it.
 */

/** The only GitHub host this version speaks to (GHE is a later version; the rows keep `host`). */
export const MAKITA_GITHUB_HOST = "github.com";

/** Days before a token's expiry from which the Owner is warned. */
export const MAKITA_TOKEN_EXPIRY_WARNING_DAYS = 14;

/** A classic personal access token (`ghp_`) or a fine-grained one (`github_pat_`). */
export const MakitaTokenKind = Schema.Literals(["classic", "fine-grained"]);
export type MakitaTokenKind = typeof MakitaTokenKind.Type;

/** How the token stood at its last check with GitHub. */
export const MakitaAccountStatus = Schema.Literals([
  "ok",
  "token-invalid",
  "rate-limited",
  "unreachable",
]);
export type MakitaAccountStatus = typeof MakitaAccountStatus.Type;

/** What the Owner is warned about in Platform → Makita. */
export const MakitaAccountWarning = Schema.Literals([
  "token-invalid",
  "expires-soon",
  "expired",
  "no-repo-scope",
  "rate-limited",
  "unreachable",
]);
export type MakitaAccountWarning = typeof MakitaAccountWarning.Type;

/** Makita's account as the Owner sees it: never the token, only its last four characters. */
export const MakitaAccountView = Schema.Struct({
  host: Schema.String,
  login: Schema.String,
  githubUserId: Schema.Number,
  tokenKind: MakitaTokenKind,
  /** The token's last four characters, to tell one token from another. */
  hint: Schema.String,
  /** A classic token's scopes; null for a fine-grained token (GitHub does not list them). */
  scopes: Schema.NullOr(Schema.Array(Schema.String)),
  expiresAt: Schema.NullOr(Schema.String),
  status: MakitaAccountStatus,
  checkedAt: Schema.String,
  /** «Stop all Makita work»: when and by whom; null while Makita may work. */
  globalPausedAt: Schema.NullOr(Schema.String),
  globalPausedBy: Schema.NullOr(UserId),
  globalPausedByName: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
  warnings: Schema.Array(MakitaAccountWarning),
});
export type MakitaAccountView = typeof MakitaAccountView.Type;

export const MakitaAccountGetInput = Schema.Struct({
  /** «Check now»: ask GitHub again with the stored token before answering. */
  check: Schema.optionalKey(Schema.Boolean),
});
export type MakitaAccountGetInput = typeof MakitaAccountGetInput.Type;

export const MakitaAccountGetResult = Schema.Struct({
  /** Null until the Owner registers Makita's account. */
  account: Schema.NullOr(MakitaAccountView),
});
export type MakitaAccountGetResult = typeof MakitaAccountGetResult.Type;

/** Register or replace Makita's token: Redacted, so no log, span or error shows it. */
export const MakitaAccountSetInput = Schema.Struct({
  token: Schema.RedactedFromValue(Schema.String),
});
export type MakitaAccountSetInput = typeof MakitaAccountSetInput.Type;

/**
 * Why a «may use Makita» takes no effect now (Makita ticket 02): `ok` it does; its User left the
 * Organization or is only a Guest there, was disabled, or the Space is archived, frozen or gone.
 */
export const MakitaPermissionState = Schema.Literals([
  "ok",
  "not-a-member",
  "guest",
  "user-inactive",
  "space-archived",
  "space-frozen",
  "space-gone",
]);
export type MakitaPermissionState = typeof MakitaPermissionState.Type;

/** Where a User works in a Space, as the permission lists say it. */
export const MakitaSpaceRole = Schema.Literals(["admin", "member", "guest", "personal"]);
export type MakitaSpaceRole = typeof MakitaSpaceRole.Type;

/** One «may use Makita»: a User in a Space, given by the Owner. */
export const MakitaPermission = Schema.Struct({
  userId: UserId,
  userName: Schema.NullOr(Schema.String),
  spaceId: SpaceId,
  spaceName: Schema.NullOr(Schema.String),
  spaceKind: Schema.NullOr(Schema.Literals(["organization", "personal"])),
  /** Their Role there now; null when they are not in it any more. */
  role: Schema.NullOr(MakitaSpaceRole),
  grantedBy: UserId,
  grantedByName: Schema.NullOr(Schema.String),
  grantedAt: Schema.String,
  state: MakitaPermissionState,
});
export type MakitaPermission = typeof MakitaPermission.Type;

/** Someone the Owner may give «may use Makita», and the Spaces where it can be given. */
export const MakitaPermissionCandidate = Schema.Struct({
  userId: UserId,
  name: Schema.String,
  spaces: Schema.Array(
    Schema.Struct({
      spaceId: SpaceId,
      name: Schema.String,
      kind: Schema.Literals(["organization", "personal"]),
      role: MakitaSpaceRole,
    }),
  ),
});
export type MakitaPermissionCandidate = typeof MakitaPermissionCandidate.Type;

export const MakitaPermissionsListResult = Schema.Struct({
  permissions: Schema.Array(MakitaPermission),
  candidates: Schema.Array(MakitaPermissionCandidate),
});
export type MakitaPermissionsListResult = typeof MakitaPermissionsListResult.Type;

export const MakitaPermissionInput = Schema.Struct({ userId: UserId, spaceId: SpaceId });
export type MakitaPermissionInput = typeof MakitaPermissionInput.Type;

/** Why a Makita door refused, in words for the person; never a token. */
export class MakitaError extends Schema.TaggedError<MakitaError>()("MakitaError", {
  reason: Schema.Literals(["forbidden", "not-found", "invalid", "limit", "github", "storage"]),
  message: Schema.String,
}) {}
