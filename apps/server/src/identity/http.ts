/**
 * The issuer's public documents (ADR 0009): `/.well-known/openid-configuration` and
 * `/.well-known/jwks.json`. Public on purpose (an access proxy lets `/.well-known` through), so
 * they hold public keys only. Until workload identity is in use (question 12) nothing is
 * answered here: the route hands the request to the same handler as any unknown path.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpServerResponse } from "effect/http";

import * as IdentityIssuer from "./IdentityIssuer.ts";
import * as IdentityKeys from "./IdentityKeys.ts";
import * as IdentityTokens from "./IdentityTokens.ts";

export const IDENTITY_DISCOVERY_PATH = "/.well-known/openid-configuration";
export const IDENTITY_JWKS_PATH = "/.well-known/jwks.json";
const DISCOVERY_PATH = IDENTITY_DISCOVERY_PATH;
const JWKS_PATH = IDENTITY_JWKS_PATH;

const CACHE = { "Cache-Control": "public, max-age=300" };

/** The discovery document of `issuer`: where its keys are, and what it signs. */
const discoveryOf = (issuer: string) => ({
  issuer,
  jwks_uri: `${issuer}${JWKS_PATH}`,
  response_types_supported: ["id_token"],
  subject_types_supported: ["public"],
  id_token_signing_alg_values_supported: ["ES256"],
  claims_supported: [
    "iss",
    "sub",
    "aud",
    "iat",
    "nbf",
    "exp",
    "jti",
    "username",
    "groups",
    "installation",
    "user_id",
    "space_id",
    "space_name",
    "organization",
    "project_id",
    "thread_id",
    "root_thread_id",
    "environment_id",
    "environment_kind",
    "role",
    "scope",
  ],
});

/**
 * The answer for `url`'s path when it is one of the issuer's documents and identity is in use;
 * none otherwise, and the caller answers as for any path. The issuer is the configured one, never
 * the request's Host.
 */
export const identityResponse = Effect.fn("IdentityHttp.identityResponse")(function* (url: URL) {
  if (url.pathname !== DISCOVERY_PATH && url.pathname !== JWKS_PATH) return Option.none();
  const issuer = yield* Effect.serviceOption(IdentityIssuer.IdentityIssuer);
  const tokens = yield* Effect.serviceOption(IdentityTokens.IdentityTokens);
  const keys = yield* Effect.serviceOption(IdentityKeys.IdentityKeys);
  if (Option.isNone(issuer) || Option.isNone(tokens) || Option.isNone(keys)) return Option.none();
  const iss = issuer.value.issuer;
  if (Option.isNone(iss) || !(yield* tokens.value.inUse)) return Option.none();
  if (url.pathname === DISCOVERY_PATH) {
    return Option.some(HttpServerResponse.jsonUnsafe(discoveryOf(iss.value), { headers: CACHE }));
  }
  const published = yield* keys.value.published.pipe(Effect.option);
  if (Option.isNone(published)) {
    return Option.some(
      HttpServerResponse.text("Service Unavailable", {
        status: 503,
        headers: { "Retry-After": "60" },
      }),
    );
  }
  return Option.some(HttpServerResponse.jsonUnsafe({ keys: published.value }, { headers: CACHE }));
});
