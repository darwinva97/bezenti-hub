/**
 * A Keycloak sign-in's tokens at rest (tickets 02 and 07): its refresh token and latest ID token,
 * sealed as the TOTP secrets are (AES-256-GCM under a key from the encrypted store), each bound to
 * its sign-in and kind as associated data, so a value copied to another row or column never opens.
 * A failure carries no cause: nothing about a token or its plaintext reaches an error or a log.
 */
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as AccountCredentials from "./AccountCredentials.ts";
import type * as ServerSecretStore from "./ServerSecretStore.ts";

/** The key in the Hub's encrypted store that seals a sign-in's tokens. */
export const REFRESH_TOKEN_KEY_NAME = "identity-login-key";

/** A refresh token's associated data: a row copied to another login does not open. */
export const refreshTokenContext = (loginId: string) => `identity-login:${loginId}`;
/** An ID token's (ticket 07), apart from the refresh token's. */
const idTokenContext = (loginId: string) => `identity-login-id-token:${loginId}`;

export type TokenKind = "refresh" | "id";

const contextOf = (kind: TokenKind, loginId: string) =>
  kind === "refresh" ? refreshTokenContext(loginId) : idTokenContext(loginId);

/** Sealing or opening a sign-in's token failed: which, and nothing about any value. */
export class SealedTokenError extends Schema.TaggedError<SealedTokenError>()("SealedTokenError", {
  operation: Schema.Literals(["seal", "open"]),
  kind: Schema.Literals(["refresh", "id"]),
}) {}

/** Seals `token` for this sign-in and kind. */
export const seal = (
  secretStore: ServerSecretStore.ServerSecretStore["Service"],
  kind: TokenKind,
  loginId: string,
  token: Redacted.Redacted<string>,
) =>
  secretStore.getOrCreateRandom(REFRESH_TOKEN_KEY_NAME, 32).pipe(
    Effect.flatMap((key) =>
      AccountCredentials.seal(
        key,
        new TextEncoder().encode(Redacted.value(token)),
        contextOf(kind, loginId),
      ),
    ),
    Effect.mapError(() => new SealedTokenError({ operation: "seal", kind })),
    Effect.catchDefect(() => Effect.fail(new SealedTokenError({ operation: "seal", kind }))),
  );

/** Opens a value `seal` made for this sign-in and kind. */
export const open = (
  secretStore: ServerSecretStore.ServerSecretStore["Service"],
  kind: TokenKind,
  loginId: string,
  sealed: string,
) =>
  secretStore.getOrCreateRandom(REFRESH_TOKEN_KEY_NAME, 32).pipe(
    Effect.flatMap((key) => AccountCredentials.open(key, sealed, contextOf(kind, loginId))),
    Effect.map((plaintext) => Redacted.make(new TextDecoder().decode(plaintext))),
    Effect.mapError(() => new SealedTokenError({ operation: "open", kind })),
    Effect.catchDefect(() => Effect.fail(new SealedTokenError({ operation: "open", kind }))),
  );
