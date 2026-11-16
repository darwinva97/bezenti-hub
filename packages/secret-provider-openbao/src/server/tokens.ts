// @effect-diagnostics nodeBuiltinImport:off -- a token's identity is a hash of its sign-in.
/**
 * OpenBao tokens, held in memory only, one per sign-in identity. A sign-in in flight is shared;
 * at two thirds of its lease a token is renewed (or replaced) in the background, and an expired
 * one waits for a new sign-in. Tokens never reach a log, a result, or an error.
 */
import type { SecretReadError } from "@t3tools/secret-provider-core/server/driver";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as NodeCrypto from "node:crypto";

import type { OpenBaoSecretProviderConfig } from "../shared/definition.ts";
import { readProviderFile } from "./fileRoots.ts";
import { openBaoRequest, type OpenBaoEndpoint, type OpenBaoResponse } from "./http.ts";

/** Where Kubernetes projects the ServiceAccount token by default. */
const DEFAULT_KUBERNETES_TOKEN_FILE = "/var/run/secrets/kubernetes.io/serviceaccount/token";

export interface Session {
  readonly token: string;
  readonly issuedAt: number;
  /** Milliseconds; undefined: it does not expire (a root token). */
  readonly ttl: number | undefined;
  readonly renewable: boolean;
}

export type SessionOutcome =
  | { readonly _tag: "session"; readonly session: Session }
  | { readonly _tag: "error"; readonly error: SecretReadError };

const failed = (error: SecretReadError): SessionOutcome => ({ _tag: "error", error });

const sessions = new Map<string, Session>();
const signingIn = new Map<string, Deferred.Deferred<SessionOutcome>>();
const renewing = new Set<string>();

const literal = (value: unknown) => (typeof value === "string" ? value : "");

/** The sign-in a token stands for: two scopes with the same role share it, others do not. */
const identityOf = (config: OpenBaoSecretProviderConfig) =>
  NodeCrypto.createHash("sha256")
    .update(
      [
        config.address,
        config.namespace ?? "",
        config.caCert ?? "",
        config.authMethod,
        config.authMount ?? "",
        config.authRole ?? "",
        // Not the Hub's token itself: a newer one is the same sign-in.
        config.audience ?? "",
        config.tokenFile ?? "",
        config.roleId ?? "",
        literal(config.secretId),
        literal(config.token),
        config.clientCert ?? "",
        literal(config.clientKey),
      ].join("\u0000"),
    )
    .digest("hex");

export const endpointOf = (config: OpenBaoSecretProviderConfig): OpenBaoEndpoint => ({
  address: config.address,
  namespace: config.namespace,
  caCert: config.caCert,
  ...(config.authMethod === "cert"
    ? { clientCert: config.clientCert, clientKey: literal(config.clientKey) || undefined }
    : {}),
});

/** What a failed call says: the status's class only, logged without path, body, or token. */
export const classify = Effect.fn("OpenBao.classify")(function* (
  operation: "login" | "lookup" | "renew" | "read",
  response: OpenBaoResponse,
) {
  if (response._tag === "unreachable") {
    yield* Effect.logWarning("OpenBao did not answer", { operation, why: response.why });
    return "unavailable" as SecretReadError;
  }
  yield* Effect.logWarning("OpenBao refused a call", { operation, status: response.status });
  const { status } = response;
  if (status === 401 || status === 403) return "forbidden" as SecretReadError;
  if (status === 400) return "invalid" as SecretReadError;
  if (status === 404) return (operation === "read" ? "not-found" : "invalid") as SecretReadError;
  return "unavailable" as SecretReadError;
});

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

/** A session from `auth` of a login or renewal, or `data` of a lookup; else undefined. */
const sessionFrom = (
  token: string | undefined,
  seconds: unknown,
  renewable: unknown,
  now: number,
): Session | undefined =>
  token === undefined ||
  token.length === 0 ||
  typeof seconds !== "number" ||
  !Number.isFinite(seconds) ||
  seconds < 0
    ? undefined
    : {
        token,
        issuedAt: now,
        ttl: seconds === 0 ? undefined : seconds * 1000,
        renewable: renewable === true,
      };

const loginBody = Effect.fn("OpenBao.loginBody")(function* (config: OpenBaoSecretProviderConfig) {
  switch (config.authMethod) {
    case "kubernetes":
    case "jwt": {
      const file = yield* readProviderFile(config.tokenFile ?? DEFAULT_KUBERNETES_TOKEN_FILE);
      if (file._tag === "refused") {
        yield* Effect.logWarning("OpenBao token file refused", { reason: file.reason });
        return undefined;
      }
      const jwt = file.content.trim();
      return jwt.length === 0 ? undefined : { role: config.authRole, jwt };
    }
    case "approle": {
      const secretId = literal(config.secretId);
      return secretId.length === 0 ? undefined : { role_id: config.roleId, secret_id: secretId };
    }
    case "cert":
      return literal(config.clientKey).length === 0
        ? undefined
        : config.authRole === undefined
          ? {}
          : { name: config.authRole };
    case "hub_identity": {
      // The Hub's own token, signed for this read; without an issuer there is none.
      const jwt = config.identityToken ?? "";
      return jwt.length === 0 ? undefined : { role: config.authRole, jwt };
    }
    case "token":
      return undefined;
  }
});

/** A new token: a login, or for the `token` method a lookup of the token given. */
const signIn = Effect.fn("OpenBao.signIn")(function* (config: OpenBaoSecretProviderConfig) {
  const endpoint = endpointOf(config);
  if (config.authMethod === "token") {
    const token = literal(config.token);
    if (token.length === 0) return failed("invalid");
    const response = yield* openBaoRequest(endpoint, {
      method: "GET",
      path: "auth/token/lookup-self",
      token,
    });
    if (response._tag !== "status" || response.status !== 200) {
      return failed(yield* classify("lookup", response));
    }
    const data = record(record(response.json)?.data);
    const session = sessionFrom(token, data?.ttl, data?.renewable, yield* Clock.currentTimeMillis);
    return session === undefined ? failed("unavailable") : ({ _tag: "session", session } as const);
  }
  const body = yield* loginBody(config);
  if (body === undefined) return failed("invalid");
  const mount =
    config.authMount ?? (config.authMethod === "hub_identity" ? "jwt" : config.authMethod);
  const response = yield* openBaoRequest(endpoint, {
    method: "POST",
    path: `auth/${mount}/login`,
    body,
  });
  if (response._tag !== "status" || response.status !== 200) {
    return failed(yield* classify("login", response));
  }
  const auth = record(record(response.json)?.auth);
  const token = auth?.client_token;
  const session = sessionFrom(
    typeof token === "string" ? token : undefined,
    auth?.lease_duration,
    auth?.renewable,
    yield* Clock.currentTimeMillis,
  );
  if (session === undefined) {
    yield* Effect.logWarning("OpenBao sign-in answer had no usable token", { operation: "login" });
    return failed("unavailable");
  }
  return { _tag: "session", session } as const;
});

/** A fresh sign-in, shared by every caller while it runs; its token replaces the held one. */
export const login = Effect.fn("OpenBao.login")(function* (config: OpenBaoSecretProviderConfig) {
  const key = identityOf(config);
  const running = signingIn.get(key);
  if (running !== undefined) return yield* Deferred.await(running);
  const done = yield* Deferred.make<SessionOutcome>();
  signingIn.set(key, done);
  return yield* signIn(config).pipe(
    Effect.tap((outcome) =>
      Effect.sync(() => {
        if (outcome._tag === "session") sessions.set(key, outcome.session);
      }),
    ),
    Effect.tap((outcome) => Deferred.succeed(done, outcome)),
    Effect.ensuring(
      Effect.suspend(() => {
        signingIn.delete(key);
        return Deferred.succeed(done, failed("unavailable"));
      }),
    ),
  );
});

/** Renews `session` (or signs in anew when it cannot be renewed); errors only logged. */
const refresh = Effect.fn("OpenBao.refresh")(function* (
  config: OpenBaoSecretProviderConfig,
  key: string,
  session: Session,
) {
  if (session.renewable) {
    const response = yield* openBaoRequest(endpointOf(config), {
      method: "POST",
      path: "auth/token/renew-self",
      token: session.token,
    });
    if (response._tag === "status" && response.status === 200) {
      const auth = record(record(response.json)?.auth);
      const renewed = sessionFrom(
        session.token,
        auth?.lease_duration,
        auth?.renewable,
        yield* Clock.currentTimeMillis,
      );
      if (renewed !== undefined) {
        if (sessions.get(key) === session) sessions.set(key, renewed);
        return;
      }
    } else {
      yield* classify("renew", response);
    }
  }
  // A token cannot sign in again: it runs to its end.
  if (config.authMethod !== "token") yield* login(config);
});

/** The token to use now: held, renewed in the background past two thirds, or a new sign-in. */
export const currentSession = Effect.fn("OpenBao.currentSession")(function* (
  config: OpenBaoSecretProviderConfig,
) {
  const key = identityOf(config);
  const held = sessions.get(key);
  const now = yield* Clock.currentTimeMillis;
  if (held === undefined || (held.ttl !== undefined && now >= held.issuedAt + held.ttl)) {
    return yield* login(config);
  }
  if (held.ttl !== undefined && now >= held.issuedAt + (held.ttl * 2) / 3 && !renewing.has(key)) {
    renewing.add(key);
    yield* refresh(config, key, held).pipe(
      Effect.ensuring(Effect.sync(() => renewing.delete(key))),
      Effect.forkDetach,
    );
  }
  return { _tag: "session", session: held } as SessionOutcome;
});

/** Forgets `token` if it is still the one held (a 403 said it no longer works). */
export const dropToken = (config: OpenBaoSecretProviderConfig, token: string) =>
  Effect.sync(() => {
    const key = identityOf(config);
    if (sessions.get(key)?.token === token) sessions.delete(key);
  });
