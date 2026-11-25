/**
 * A User's linked GitHub account (Makita ticket 08): proved by posting a one-time code from that
 * account, kept by its numeric id, seen only by its own User.
 */
import * as Schema from "effect/Schema";

import { UserId } from "./baseSchemas.ts";

/** The session's own link, if any, and the code it is waiting for (never the code itself). */
export const GitHubIdentityView = Schema.Struct({
  linked: Schema.NullOr(
    Schema.Struct({
      githubUserId: Schema.Number,
      login: Schema.String,
      linkedAt: Schema.String,
    }),
  ),
  /**
   * The newest code asked for and not linked: `waiting` until it expires, `expired`, or `taken`
   * when that GitHub account is linked to someone else on this Hub.
   */
  pending: Schema.NullOr(
    Schema.Struct({
      login: Schema.String,
      expiresAt: Schema.String,
      state: Schema.Literals(["waiting", "expired", "taken"]),
    }),
  ),
  /** Makita's GitHub login, to address the comment; null while Makita is not set up. */
  makitaLogin: Schema.NullOr(Schema.String),
});
export type GitHubIdentityView = typeof GitHubIdentityView.Type;

export const GitHubLinkCodeInput = Schema.Struct({
  /** The User's own GitHub login: the code links only that account. */
  login: Schema.String,
});
export type GitHubLinkCodeInput = typeof GitHubLinkCodeInput.Type;

/** A new code, shown once, and the exact line to post from that GitHub account. */
export const GitHubLinkCode = Schema.Struct({
  code: Schema.String,
  login: Schema.String,
  expiresAt: Schema.String,
  makitaLogin: Schema.String,
  comment: Schema.String,
});
export type GitHubLinkCode = typeof GitHubLinkCode.Type;

export const GitHubIdentityUnlinkInput = Schema.Struct({
  /** Another User's link: the Owner only. Without it, the session's own. */
  userId: Schema.optionalKey(UserId),
});
export type GitHubIdentityUnlinkInput = typeof GitHubIdentityUnlinkInput.Type;
