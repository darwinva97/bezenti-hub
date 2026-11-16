// @effect-diagnostics nodeBuiltinImport:off -- a token id is a random UUID from node:crypto.
/**
 * Workload identity tokens (ADR 0009): short-lived JWTs the Hub signs for a Thread's entry or for
 * its own sign-in to a provider. One audience each, taken from what the Owner saved, never from
 * the caller. Claims come from the rows, never from a client, and never name a Vault. The token
 * itself is never logged nor audited. docs/internals/secrets.md, «Workload identity».
 */
import {
  type EnvironmentId,
  HUB_MACHINE_ENVIRONMENT_ID,
  IDENTITY_TTL_MAX_SECONDS,
  IDENTITY_TTL_MIN_SECONDS,
  type SpaceId,
  type ThreadId,
  type UserId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeCrypto from "node:crypto";

import * as AuditLog from "../audit/AuditLog.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as IdentityIssuer from "./IdentityIssuer.ts";
import * as IdentityKeys from "./IdentityKeys.ts";

/** The Hub's own sign-in to a provider. */
const HUB_TTL_SECONDS = 300;
/** `nbf` this far before `iat`: a verifier whose clock is a little behind still accepts. */
const CLOCK_SKEW_SECONDS = 60;

export class IdentityError extends Schema.TaggedError<IdentityError>()("IdentityError", {
  reason: Schema.Literals(["no-issuer", "audience", "storage"]),
  message: Schema.String,
}) {}

export interface IssuedToken {
  readonly token: string;
  readonly jti: string;
  /** Epoch milliseconds. */
  readonly issuedAt: number;
  readonly expiresAt: number;
}

/**
 * Why `audience` is not one a token may carry, or undefined: empty, too long, a list, or the Hub
 * itself (a token for the Hub would be a way into it).
 */
export const audienceProblem = (
  audience: string,
  hubOrigins: ReadonlyArray<string>,
): string | undefined => {
  if (audience.length === 0 || audience.length > 256) {
    return "An audience is 1 to 256 characters.";
  }
  if (/[\s,]/u.test(audience)) return "An audience is one value: no spaces or commas.";
  const origin = URL.parse(audience)?.origin;
  if (hubOrigins.includes(audience) || (origin !== undefined && hubOrigins.includes(origin))) {
    return "A token for this Hub itself is never issued: choose the system that verifies it.";
  }
  return undefined;
};

const base64url = (value: string | Uint8Array) =>
  Buffer.from(typeof value === "string" ? new TextEncoder().encode(value) : value).toString(
    "base64url",
  );

/** `header.payload`, the part an ES256 signature covers. */
const signingInputOf = (kid: string, claims: Readonly<Record<string, unknown>>) =>
  `${base64url(JSON.stringify({ alg: "ES256", typ: "JWT", kid }))}.${base64url(JSON.stringify(claims))}`;

const isoOfSeconds = (seconds: number) => DateTime.formatIso(DateTime.makeUnsafe(seconds * 1000));

/** What a Thread's token says about it: from the rows, never from a client. */
export interface ThreadFacts {
  readonly threadId: ThreadId;
  readonly userId: UserId;
  readonly spaceId: SpaceId;
  readonly environmentId: EnvironmentId;
}

export class IdentityTokens extends Context.Service<
  IdentityTokens,
  {
    /** Whether any identity entry, or a provider signing in as the Hub, exists (question 12). */
    readonly inUse: Effect.Effect<boolean>;
    /**
     * A token for an identity entry in a Thread: the one already issued while more than a third
     * of its life is left, else a new one (audited).
     */
    readonly forThread: (input: {
      readonly facts: ThreadFacts;
      readonly entryId: string;
      readonly audience: string;
      readonly ttlSeconds: number;
    }) => Effect.Effect<IssuedToken, IdentityError>;
    /** The Hub's own token for a provider: `sub` t3:hub:<installation>, `scope` the scope's id. */
    readonly forHub: (input: {
      readonly audience: string;
      readonly scopeId: string | null;
    }) => Effect.Effect<IssuedToken, IdentityError>;
  }
>()("t3/identity/IdentityTokens") {}

interface ClaimRow {
  readonly loginName: string | null;
  readonly isOwner: number | null;
  readonly spaceKind: string | null;
  readonly spaceName: string | null;
  readonly role: string | null;
  readonly projectId: string | null;
  readonly rootThreadId: string | null;
  readonly sandbox: number;
  readonly dedicated: number;
}

/** Where the process runs, as a verifier's rules see it. */
const environmentKindOf = (environmentId: EnvironmentId, row: ClaimRow | undefined) =>
  environmentId === HUB_MACHINE_ENVIRONMENT_ID
    ? "hub"
    : row?.dedicated === 1
      ? "dedicated"
      : row?.sandbox === 1
        ? "sandbox"
        : "personal";

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const keys = yield* IdentityKeys.IdentityKeys;
  const issuer = yield* IdentityIssuer.IdentityIssuer;
  const audit = yield* AuditLog.AuditLog;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const installation = yield* environment.getEnvironmentId;
  const held = new Map<string, IssuedToken>();

  const failStorage = (what: string) => (cause: unknown) =>
    Effect.logError(`IdentityTokens: could not ${what}`, { cause: String(cause) }).pipe(
      Effect.andThen(
        Effect.fail(new IdentityError({ reason: "storage", message: `Could not ${what}.` })),
      ),
    );

  const issuerOrFail = Effect.fromOption(issuer.issuer).pipe(
    Effect.mapError(
      () =>
        new IdentityError({
          reason: "no-issuer",
          message:
            "Workload identity is off: set T3CODE_IDENTITY_ISSUER or T3CODE_PUBLIC_URL on the Hub.",
        }),
    ),
  );

  /** Signs `claims` for `audience`; records `identity.issue` (never the token) before it leaves. */
  const issue = Effect.fn("IdentityTokens.issue")(function* (input: {
    readonly audience: string;
    readonly ttlSeconds: number;
    readonly subject: string;
    readonly claims: Readonly<Record<string, unknown>>;
    readonly target: AuditLog.AuditRecord["target"];
    readonly spaceId: SpaceId | null;
    readonly threadId: string | null;
  }) {
    const iss = yield* issuerOrFail;
    const problem = audienceProblem(input.audience, issuer.hubOrigins);
    if (problem !== undefined) {
      return yield* new IdentityError({ reason: "audience", message: problem });
    }
    const ttl = Math.min(
      IDENTITY_TTL_MAX_SECONDS,
      Math.max(IDENTITY_TTL_MIN_SECONDS, Math.floor(input.ttlSeconds)),
    );
    const now = yield* Clock.currentTimeMillis;
    const iat = Math.floor(now / 1000);
    const jti = NodeCrypto.randomUUID();
    const claims = {
      ...input.claims,
      iss,
      sub: input.subject,
      aud: input.audience,
      iat,
      nbf: iat - CLOCK_SKEW_SECONDS,
      exp: iat + ttl,
      jti,
    };
    // The key of the moment names itself in the header it signs.
    const signed = yield* keys
      .sign((kid) => new TextEncoder().encode(signingInputOf(kid, claims)))
      .pipe(Effect.catch(failStorage("sign the token")));
    const signingInput = signingInputOf(signed.kid, claims);
    yield* audit
      .record({
        actor: { source: "system" },
        action: "identity.issue",
        spaceId: input.spaceId,
        target: input.target,
        detail: {
          aud: input.audience,
          sub: input.subject,
          jti,
          exp: isoOfSeconds(iat + ttl),
          thread: input.threadId,
        },
      })
      .pipe(Effect.catch(failStorage("record the token in the audit log")));
    return {
      token: `${signingInput}.${base64url(signed.signature)}`,
      jti,
      issuedAt: iat * 1000,
      expiresAt: (iat + ttl) * 1000,
    } satisfies IssuedToken;
  });

  const claimRow = Effect.fn("IdentityTokens.claimRow")(function* (facts: ThreadFacts) {
    const rows = yield* sql<ClaimRow>`
      SELECT u.login_name AS "loginName", u.is_owner AS "isOwner",
        s.kind AS "spaceKind", s.name AS "spaceName", m.role AS "role",
        th.project_id AS "projectId",
        json_extract(th.payload_json, '$.lineage.rootThreadId') AS "rootThreadId",
        EXISTS (SELECT 1 FROM sandboxes x WHERE x.environment_id = ${facts.environmentId})
          AS "sandbox",
        EXISTS (SELECT 1 FROM dedicated_sandbox_credentials d
          WHERE d.environment_id = ${facts.environmentId}) AS "dedicated"
      FROM users u
      LEFT JOIN spaces s ON s.space_id = ${facts.spaceId}
      LEFT JOIN space_memberships m ON m.space_id = ${facts.spaceId} AND m.user_id = u.user_id
      LEFT JOIN orchestration_v2_projection_threads th ON th.thread_id = ${facts.threadId}
      WHERE u.user_id = ${facts.userId}
    `.pipe(Effect.catch(failStorage("read the Thread's facts")));
    return rows[0];
  });

  const forThread = Effect.fn("IdentityTokens.forThread")(function* (input: {
    readonly facts: ThreadFacts;
    readonly entryId: string;
    readonly audience: string;
    readonly ttlSeconds: number;
  }) {
    const { facts } = input;
    const key = [
      facts.threadId,
      facts.userId,
      facts.environmentId,
      input.entryId,
      input.audience,
      input.ttlSeconds,
    ].join("\u0000");
    const now = yield* Clock.currentTimeMillis;
    const kept = held.get(key);
    // Reused while more than a third of its life is left.
    if (kept !== undefined && now < kept.expiresAt - (kept.expiresAt - kept.issuedAt) / 3) {
      return kept;
    }
    const row = yield* claimRow(facts);
    const username = row?.loginName ?? facts.userId;
    const project = row?.projectId ?? null;
    const role =
      row?.isOwner === 1
        ? "owner"
        : (row?.role ?? (row?.spaceKind === "personal" ? "owner" : null));
    const issued = yield* issue({
      audience: input.audience,
      ttlSeconds: input.ttlSeconds,
      subject: `t3:space:${facts.spaceId}:project:${project ?? "-"}:user:${username}`,
      claims: {
        username,
        groups: [`t3:space:${facts.spaceId}`],
        installation,
        user_id: facts.userId,
        space_id: facts.spaceId,
        space_name: row?.spaceName ?? null,
        organization: row?.spaceKind === "organization" ? facts.spaceId : "personal",
        project_id: project,
        thread_id: facts.threadId,
        root_thread_id: row?.rootThreadId ?? facts.threadId,
        environment_id: facts.environmentId,
        environment_kind: environmentKindOf(facts.environmentId, row),
        role,
      },
      target: { kind: "secret", id: input.entryId },
      spaceId: facts.spaceId,
      threadId: facts.threadId,
    });
    held.set(key, issued);
    return issued;
  });

  const forHub = Effect.fn("IdentityTokens.forHub")(function* (input: {
    readonly audience: string;
    readonly scopeId: string | null;
  }) {
    return yield* issue({
      audience: input.audience,
      ttlSeconds: HUB_TTL_SECONDS,
      subject: `t3:hub:${installation}`,
      claims: { installation, scope: input.scopeId ?? "direct" },
      target: { kind: "provider_scope", id: input.scopeId ?? "direct" },
      spaceId: null,
      threadId: null,
    });
  });

  const inUse = sql<{ readonly found: number }>`
    SELECT EXISTS (SELECT 1 FROM vault_entries WHERE kind = 'identity') AS "found"
  `.pipe(
    Effect.map((rows) => rows[0]?.found === 1),
    Effect.orElseSucceed(() => false),
  );

  return IdentityTokens.of({ inUse, forThread, forHub });
});

export const layer = Layer.effect(IdentityTokens, make);
