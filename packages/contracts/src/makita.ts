import * as Schema from "effect/Schema";

import { UserId } from "./baseSchemas.ts";

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

/** Why a Makita door refused, in words for the person; never a token. */
export class MakitaError extends Schema.TaggedError<MakitaError>()("MakitaError", {
  reason: Schema.Literals(["forbidden", "not-found", "invalid", "limit", "github", "storage"]),
  message: Schema.String,
}) {}
