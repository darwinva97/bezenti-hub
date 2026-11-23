// @effect-diagnostics nodeBuiltinImport:off -- random keys and their SHA-256, synchronous and small.
/**
 * Gateway keys (spec 4 ticket 04) and the one check of an `/api/ai/*` request (`authorize`): the
 * key, its User, its Thread's Space and owner, and AllowedAiAccounts, all read again per request.
 * Keys are random (`t3gk_` + 32 bytes), kept only as SHA-256. docs/internals/ai-gateway.md.
 */
import * as NodeCrypto from "node:crypto";

import {
  AI_GATEWAY_KEY_PREFIX,
  type AiAccountId,
  AiGatewayKeyError,
  type AiGatewayKeyCreateInput,
  type AiGatewayKeyCreateResult,
  type AiGatewayKeyKind,
  type AiGatewayKeyListResult,
  type AiGatewayUserKey,
  SpaceId,
  ThreadId,
  UserId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as AuditLog from "../audit/AuditLog.ts";
import * as CommandActor from "../auth/CommandActor.ts";
import { threadTurnOwner } from "../orchestration-v2/threadTurnOwner.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import { accessKeyForRequest, noteAccessKeyUse } from "./AccessKeys.ts";
import * as AllowedAiAccounts from "./AllowedAiAccounts.ts";
import { isAccessKeyShaped, isGatewayKeyShaped } from "./gatewayShapes.ts";

/** Why a request's key gets nothing: 401 (no such live key), 403 (not here), 503 (try later). */
export class AiGatewayRefusal extends Schema.TaggedError<AiGatewayRefusal>()("AiGatewayRefusal", {
  status: Schema.Literals([401, 403, 503]),
  message: Schema.String,
}) {}

/** Why making, listing or revoking a key failed, in words for its User (the WS doors' error). */
export { AiGatewayKeyError };

/** A gateway key's kind, or `access`: a Space's access key (access-keys ticket 01). */
export type GatewayCallerKind = AiGatewayKeyKind | "access";

/** Who a request is, decided on the Hub from its key alone, and what it may reach right now. */
export interface GatewayCaller {
  readonly keyId: string;
  readonly kind: GatewayCallerKind;
  /** The key's User; null for an access key, which acts for its Space, never as a User. */
  readonly userId: UserId | null;
  /** The access key's id (`ak_…`); null for a gateway key. */
  readonly accessKeyId: string | null;
  readonly spaceId: SpaceId;
  readonly threadId: ThreadId | null;
  /**
   * AllowedAiAccounts for (User, Space) now, or for an access key the Space's own accounts
   * (`forSpace`), through the gateway only (no direct credential).
   */
  readonly allowed: ReadonlyArray<AllowedAiAccounts.AllowedAiAccount>;
  /** The Thread's own AI account (its model selection), if it chose one. */
  readonly chosenAccountId: AiAccountId | null;
}

/** A key just made: shown once, never stored. */
export interface IssuedGatewayKey {
  readonly keyId: string;
  readonly key: Redacted.Redacted<string>;
}

/** A User key just made: the key, once, and the row as its list will show it. */
export interface IssuedUserKey extends IssuedGatewayKey {
  readonly shown: AiGatewayUserKey;
}

/** A User key as its User sees it: never the key, nor its hash. */
export interface GatewayKeySummary {
  readonly keyId: string;
  readonly name: string;
  readonly userId: UserId;
  readonly spaceId: SpaceId;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly lastUsedAt: string | null;
}

export class AiGatewayKeys extends Context.Service<
  AiGatewayKeys,
  {
    /**
     * A new key for a Thread's provider session (ticket 06 hands it to the agent): for the
     * Thread's turn owner in its Space now. Earlier keys of the Thread are revoked (one live key
     * per Thread, rotated at each session).
     */
    readonly issueForThread: (
      threadId: ThreadId,
      options?: { readonly providerSessionId?: string },
    ) => Effect.Effect<IssuedGatewayKey, AiGatewayKeyError>;
    /** Revokes every live key of a Thread (moved, archived, deleted). */
    readonly revokeThread: (
      threadId: ThreadId,
      reason: string,
    ) => Effect.Effect<void, AiGatewayKeyError>;
    /** Revokes the keys issued for one provider session (of one Thread, when it detaches). */
    readonly revokeSession: (
      providerSessionId: string,
      reason: string,
      threadId?: ThreadId,
    ) => Effect.Effect<void, AiGatewayKeyError>;
    /** Revokes every live Thread key: at a Hub start no provider session of them is alive. */
    readonly revokeLiveThreadKeys: (reason: string) => Effect.Effect<void, AiGatewayKeyError>;
    /** Revokes every key of a User (disabled or removed). */
    readonly revokeUser: (userId: UserId, reason: string) => Effect.Effect<void, AiGatewayKeyError>;
    /** A User's key for a local CLI, in a Space they work in (ticket 10 gives it a screen). */
    readonly createForUser: (input: {
      readonly actorUserId: UserId;
      readonly spaceId: SpaceId;
      readonly name: string;
    }) => Effect.Effect<IssuedUserKey, AiGatewayKeyError>;
    /** The actor's own User keys; the Owner's lists everyone's. */
    readonly listUserKeys: (
      actorUserId: UserId,
    ) => Effect.Effect<ReadonlyArray<GatewayKeySummary>, AiGatewayKeyError>;
    /** Revokes a User key: its User's own, or any for the Owner. */
    readonly revoke: (input: {
      readonly actorUserId: UserId;
      readonly keyId: string;
    }) => Effect.Effect<void, AiGatewayKeyError>;
    /**
     * The WS doors (Settings → AI accounts → «Local CLI keys», spec 4 ticket 10): for the acting
     * person's own session only. An agent (MCP, as its User), the Hub's shell or a session limited
     * to one Space makes, lists and revokes nothing.
     */
    readonly createForSession: (
      input: AiGatewayKeyCreateInput,
    ) => Effect.Effect<AiGatewayKeyCreateResult, AiGatewayKeyError>;
    readonly listForSession: Effect.Effect<AiGatewayKeyListResult, AiGatewayKeyError>;
    readonly revokeForSession: (input: {
      readonly keyId: string;
    }) => Effect.Effect<AiGatewayKeyListResult, AiGatewayKeyError>;
    /**
     * Revokes a User's keys for every Space they no longer work in (a Membership ended, an
     * Organization archived, a Personal space closed), audited. The request-time check refuses
     * them anyway; this keeps them refused if the User comes back.
     */
    readonly revokeLostSpaces: (userId: UserId) => Effect.Effect<void, AiGatewayKeyError>;
    /** The one check of a request: who it is and what it may reach, now. */
    readonly authorize: (
      key: Redacted.Redacted<string>,
    ) => Effect.Effect<GatewayCaller, AiGatewayRefusal>;
  }
>()("t3/ai/AiGatewayKeys") {}

/** A Thread key lives until its session's next one replaces it, or a week at most. */
const THREAD_KEY_LIFETIME_DAYS = 7;
/** Live User keys one User may hold (local CLIs). */
const MAX_USER_KEYS = 5;
const MAX_NAME_LENGTH = 80;

/** The only form a key is kept in: its SHA-256, hex. */
const gatewayKeyHash = (key: string) =>
  NodeCrypto.createHash("sha256").update(key, "utf8").digest("hex");

const newKey = () => `${AI_GATEWAY_KEY_PREFIX}${NodeCrypto.randomBytes(32).toString("base64url")}`;
const newKeyId = () => `gk_${NodeCrypto.randomBytes(12).toString("hex")}`;

interface KeyRow {
  readonly keyId: string;
  readonly kind: AiGatewayKeyKind;
  readonly userId: string;
  readonly spaceId: string;
  readonly threadId: string | null;
  readonly name: string;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
}

const KEY_COLUMNS = `key_id AS "keyId", kind, user_id AS "userId", space_id AS "spaceId",
  thread_id AS "threadId", name, created_at AS "createdAt", expires_at AS "expiresAt",
  last_used_at AS "lastUsedAt", revoked_at AS "revokedAt"`;

const UNKNOWN_KEY = "This AI gateway key is not valid. It may have been revoked or expired.";

/** `2026-12-01 18:00 UTC`: an instant as an error message says it. */
const utcMinute = (millis: number) =>
  `${DateTime.formatIso(DateTime.makeUnsafe(millis)).slice(0, 16).replace("T", " ")} UTC`;
const SPACE_LOST = "You no longer work in this key's Space: it was revoked. Make a new key.";
/** A Thread key is refused, never revoked, here: archive and restore, the key works again. */
const THREAD_SPACE_LOST = "You cannot work in this Thread's Space now, so its key is refused.";
/** SQLite takes at most 32766 parameters per statement: revocations go in batches. */
const REVOKE_BATCH = 500;
/** Why a key was revoked when its User stopped working in its Space. */
const SPACE_LOST_REASON = "space-lost";
const NOT_YOURS =
  "Local CLI keys are made, listed and revoked by their User in Settings, not by an agent.";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const spaces = yield* SpaceDirectory.SpaceDirectory;
  const allowedAccounts = yield* AllowedAiAccounts.AllowedAiAccounts;
  const audit = yield* AuditLog.AuditLog;

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const storage = (what: string) => (cause: unknown) =>
    Effect.logError(`AiGatewayKeys: could not ${what}`, { cause }).pipe(
      Effect.andThen(
        Effect.fail(
          new AiGatewayKeyError({ reason: "storage", message: `Could not ${what}. Try again.` }),
        ),
      ),
    );

  const refused = (status: 401 | 403 | 503, message: string) =>
    Effect.fail(new AiGatewayRefusal({ status, message }));

  /** The Spaces among these the User may work in, with names: AllowedAiAccounts' own rule. */
  const worksInSpaces = (userId: UserId, spaceIds: ReadonlyArray<SpaceId>) =>
    allowedAccounts.workingSpaces(userId, spaceIds);

  const checkedName = (raw: string) => {
    const name = raw.trim();
    return name.length === 0 || name.length > MAX_NAME_LENGTH
      ? Effect.fail(
          new AiGatewayKeyError({
            reason: "invalid",
            message: `Name the key (up to ${MAX_NAME_LENGTH} characters).`,
          }),
        )
      : Effect.succeed(name);
  };

  const revokeThread = Effect.fn("AiGatewayKeys.revokeThread")(function* (
    threadId: ThreadId,
    reason: string,
  ) {
    const at = yield* nowIso;
    yield* sql`
      UPDATE ai_gateway_keys SET revoked_at = ${at}, revoked_reason = ${reason}
      WHERE thread_id = ${threadId} AND revoked_at IS NULL
    `.pipe(Effect.catch(storage("revoke the Thread's AI gateway keys")));
  });

  const revokeSession = Effect.fn("AiGatewayKeys.revokeSession")(function* (
    providerSessionId: string,
    reason: string,
    threadId?: ThreadId,
  ) {
    const at = yield* nowIso;
    yield* sql`
      UPDATE ai_gateway_keys SET revoked_at = ${at}, revoked_reason = ${reason}
      WHERE provider_session_id = ${providerSessionId} AND revoked_at IS NULL
        AND ${threadId === undefined ? sql`1 = 1` : sql`thread_id = ${threadId}`}
    `.pipe(Effect.catch(storage("revoke the session's AI gateway keys")));
  });

  const revokeLiveThreadKeys = Effect.fn("AiGatewayKeys.revokeLiveThreadKeys")(function* (
    reason: string,
  ) {
    const at = yield* nowIso;
    yield* sql`
      UPDATE ai_gateway_keys SET revoked_at = ${at}, revoked_reason = ${reason}
      WHERE kind = 'thread' AND revoked_at IS NULL
    `.pipe(Effect.catch(storage("revoke the earlier sessions' AI gateway keys")));
  });

  /**
   * Revokes these keys if still live, in one guarded UPDATE; each User key it revoked is audited
   * (by `actor`, else as the Hub's own act). A key another caller revoked first is not audited
   * again.
   */
  const revokeRows = Effect.fn("AiGatewayKeys.revokeRows")(function* (
    rows: ReadonlyArray<KeyRow>,
    reason: string,
    actor: AuditLog.AuditActor = { source: "system" },
  ) {
    if (rows.length === 0) return;
    const at = yield* nowIso;
    const byId = new Map(rows.map((row) => [row.keyId, row]));
    const ids = [...byId.keys()];
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const revoked: Array<{ readonly keyId: string }> = [];
          for (let start = 0; start < ids.length; start += REVOKE_BATCH) {
            revoked.push(
              ...(yield* sql<{ readonly keyId: string }>`
                UPDATE ai_gateway_keys SET revoked_at = ${at}, revoked_reason = ${reason}
                WHERE ${sql.in("key_id", ids.slice(start, start + REVOKE_BATCH))}
                  AND revoked_at IS NULL
                RETURNING key_id AS "keyId"
              `),
            );
          }
          for (const { keyId } of revoked) {
            const row = byId.get(keyId);
            if (row === undefined || row.kind !== "user") continue;
            yield* audit.record({
              actor,
              action: "ai_gateway_key.revoke",
              target: { kind: "ai_gateway_key", id: row.keyId, name: row.name },
              detail: { kind: row.kind, space: row.spaceId, reason },
            });
          }
        }),
      )
      .pipe(Effect.catch(storage("revoke the AI gateway keys")));
  });

  const liveKeysOf = (userId: UserId) =>
    sql<KeyRow>`
      SELECT ${sql.literal(KEY_COLUMNS)} FROM ai_gateway_keys
      WHERE user_id = ${userId} AND revoked_at IS NULL
    `.pipe(Effect.catch(storage("read the User's AI gateway keys")));

  const revokeUser = Effect.fn("AiGatewayKeys.revokeUser")(function* (
    userId: UserId,
    reason: string,
  ) {
    const at = yield* nowIso;
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const revoked = yield* sql<KeyRow>`
            UPDATE ai_gateway_keys SET revoked_at = ${at}, revoked_reason = ${reason}
            WHERE user_id = ${userId} AND revoked_at IS NULL
            RETURNING ${sql.literal(KEY_COLUMNS)}
          `;
          for (const row of revoked) {
            if (row.kind !== "user") continue;
            yield* audit.record({
              actor: { source: "system" },
              action: "ai_gateway_key.revoke",
              target: { kind: "ai_gateway_key", id: row.keyId, name: row.name },
              detail: { kind: row.kind, space: row.spaceId, reason },
            });
          }
        }),
      )
      .pipe(Effect.catch(storage("revoke the User's AI gateway keys")));
  });

  /** Whether the User exists and is neither disabled nor removed. */
  const isActiveUser = (userId: UserId) =>
    sql<{ readonly active: number }>`
      SELECT (disabled_at IS NULL AND removed_at IS NULL) AS active FROM users
      WHERE user_id = ${userId}
    `.pipe(
      Effect.map((rows) => rows[0]?.active === 1),
      Effect.catch(storage("read the User")),
    );

  const revokeLostSpaces = Effect.fn("AiGatewayKeys.revokeLostSpaces")(function* (userId: UserId) {
    // A disabled, removed or missing User's keys go for that reason, whichever watch runs first.
    if (!(yield* isActiveUser(userId))) return yield* revokeUser(userId, "user-inactive");
    // Only User keys: a Thread key is refused while its owner cannot work in the Thread's Space
    // and works again once they can (an Organization archived, then restored).
    const live = (yield* liveKeysOf(userId)).filter((row) => row.kind === "user");
    if (live.length === 0) return;
    const working = yield* worksInSpaces(userId, [
      ...new Set(live.map((row) => SpaceId.make(row.spaceId))),
    ]).pipe(Effect.catch(storage("check the Spaces")));
    yield* revokeRows(
      live.filter((row) => !working.has(SpaceId.make(row.spaceId))),
      SPACE_LOST_REASON,
    );
  });

  const issueForThread = Effect.fn("AiGatewayKeys.issueForThread")(function* (
    threadId: ThreadId,
    options: { readonly providerSessionId?: string } = {},
  ) {
    const space = yield* spaces
      .spaceOf({ kind: "thread", id: threadId })
      .pipe(Effect.catch(storage("read the Thread's Space")));
    const owner = yield* threadTurnOwner(sql, threadId).pipe(
      Effect.catch(storage("read who owns the Thread")),
    );
    if (Option.isNone(space) || Option.isNone(owner)) {
      return yield* new AiGatewayKeyError({ reason: "not-found", message: "No such Thread." });
    }
    const key = newKey();
    const keyId = newKeyId();
    const now = yield* DateTime.now;
    const at = DateTime.formatIso(now);
    const expiresAt = DateTime.formatIso(DateTime.add(now, { days: THREAD_KEY_LIFETIME_DAYS }));
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
            UPDATE ai_gateway_keys SET revoked_at = ${at}, revoked_reason = 'rotated'
            WHERE thread_id = ${threadId} AND revoked_at IS NULL
          `;
          yield* sql`
            INSERT INTO ai_gateway_keys (key_id, key_hash, kind, user_id, space_id, thread_id,
              provider_session_id, name, created_at, expires_at)
            VALUES (${keyId}, ${gatewayKeyHash(key)}, 'thread', ${owner.value}, ${space.value.id},
              ${threadId}, ${options.providerSessionId ?? null}, ${`Thread ${threadId}`}, ${at},
              ${expiresAt})
          `;
        }),
      )
      .pipe(Effect.catch(storage("issue the Thread's AI gateway key")));
    return { keyId, key: Redacted.make(key) } satisfies IssuedGatewayKey;
  });

  /**
   * Makes a User key. The Space check and the insert are one write transaction (the Hub's SQLite
   * client begins every writing transaction `IMMEDIATE`, nodeSqliteClient.ts): a Membership that ends commits either before it (refused here) or after it (the
   * Membership watch then sees the key). Without a Space, the User's Personal space. The answer is
   * built from what this call read and stored, so no read after the commit can lose the key.
   */
  const insertUserKey = Effect.fn("AiGatewayKeys.insertUserKey")(function* (input: {
    readonly actorUserId: UserId;
    readonly spaceId: SpaceId | undefined;
    readonly name: string;
  }) {
    const name = yield* checkedName(input.name);
    const key = newKey();
    const keyId = newKeyId();
    const at = yield* nowIso;
    const outcome = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const spaceId = input.spaceId ?? SpaceDirectory.personalSpaceIdOf(input.actorUserId);
          const working = yield* worksInSpaces(input.actorUserId, [spaceId]);
          const space = working.get(spaceId);
          if (space === undefined) {
            return { _tag: input.spaceId === undefined ? "no-personal" : "forbidden" } as const;
          }
          const live = yield* sql<{ readonly n: number }>`
            SELECT COUNT(*) AS n FROM ai_gateway_keys
            WHERE kind = 'user' AND user_id = ${input.actorUserId} AND revoked_at IS NULL
          `;
          if ((live[0]?.n ?? 0) >= MAX_USER_KEYS) return { _tag: "limit" } as const;
          const user = yield* sql<{ readonly name: string }>`
            SELECT display_name AS name FROM users WHERE user_id = ${input.actorUserId}
          `;
          yield* sql`
            INSERT INTO ai_gateway_keys (key_id, key_hash, kind, user_id, space_id, thread_id,
              name, created_at)
            VALUES (${keyId}, ${gatewayKeyHash(key)}, 'user', ${input.actorUserId},
              ${spaceId}, NULL, ${name}, ${at})
          `;
          yield* audit.record({
            actor: AuditLog.userActor(input.actorUserId),
            action: "ai_gateway_key.create",
            target: { kind: "ai_gateway_key", id: keyId, name },
            detail: { kind: "user", space: spaceId },
          });
          const shown: AiGatewayUserKey = {
            keyId,
            name,
            userId: input.actorUserId,
            userName: user[0]?.name ?? null,
            spaceId,
            spaceName: space.name,
            createdAt: at,
            lastUsedAt: null,
          };
          return { _tag: "made", shown } as const;
        }),
      )
      .pipe(Effect.catch(storage("make the AI gateway key")));
    switch (outcome._tag) {
      case "no-personal":
        return yield* new AiGatewayKeyError({
          reason: "forbidden",
          message: "Choose a Space you work in for this key.",
        });
      case "forbidden":
        return yield* new AiGatewayKeyError({
          reason: "forbidden",
          message: "You can make a key only for a Space you work in.",
        });
      case "limit":
        return yield* new AiGatewayKeyError({
          reason: "limit",
          message: `You have ${MAX_USER_KEYS} keys already. Revoke one to make another.`,
        });
      case "made":
        return { keyId, key: Redacted.make(key), shown: outcome.shown } satisfies IssuedUserKey;
    }
  });

  const createForUser = (input: {
    readonly actorUserId: UserId;
    readonly spaceId: SpaceId;
    readonly name: string;
  }) => insertUserKey(input);

  /** Live User keys the viewer sees: the Owner everyone's, anyone else their own. */
  const keysFor = Effect.fn("AiGatewayKeys.keysFor")(function* (
    actorUserId: UserId,
    isOwner: boolean,
  ) {
    const rows = yield* (
      isOwner
        ? sql<KeyRow>`SELECT ${sql.literal(KEY_COLUMNS)} FROM ai_gateway_keys
            WHERE kind = 'user' AND revoked_at IS NULL ORDER BY created_at`
        : sql<KeyRow>`SELECT ${sql.literal(KEY_COLUMNS)} FROM ai_gateway_keys
            WHERE kind = 'user' AND revoked_at IS NULL AND user_id = ${actorUserId}
            ORDER BY created_at`
    ).pipe(Effect.catch(storage("list the AI gateway keys")));
    return rows.map((row): GatewayKeySummary => ({
      keyId: row.keyId,
      name: row.name,
      userId: UserId.make(row.userId),
      spaceId: SpaceId.make(row.spaceId),
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      lastUsedAt: row.lastUsedAt,
    }));
  });

  const principalFor = (userId: UserId) =>
    spaces.principalOf(userId).pipe(Effect.catch(storage("read who you are")));

  const listUserKeys = Effect.fn("AiGatewayKeys.listUserKeys")(function* (actorUserId: UserId) {
    return yield* keysFor(actorUserId, (yield* principalFor(actorUserId)).isOwner);
  });

  const revoke = Effect.fn("AiGatewayKeys.revoke")(function* (input: {
    readonly actorUserId: UserId;
    readonly keyId: string;
  }) {
    const rows = yield* sql<KeyRow>`
      SELECT ${sql.literal(KEY_COLUMNS)} FROM ai_gateway_keys WHERE key_id = ${input.keyId}
    `.pipe(Effect.catch(storage("read the AI gateway key")));
    const row = rows[0];
    const principal = yield* principalFor(input.actorUserId);
    // Someone else's key answers like a missing one.
    if (
      row === undefined ||
      row.kind !== "user" ||
      (row.userId !== input.actorUserId && !principal.isOwner)
    ) {
      return yield* new AiGatewayKeyError({ reason: "not-found", message: "No such key." });
    }
    if (row.revokedAt !== null) return;
    yield* revokeRows([row], "revoked", AuditLog.userActor(input.actorUserId));
  });

  /** The person behind a WS session: never an agent, the Hub's shell or a one-Space session. */
  const sessionUser = Effect.gen(function* () {
    const actor = yield* CommandActor.resolve;
    if (actor._tag !== "User" || actor.via !== undefined || actor.spaceLimit !== undefined) {
      return yield* new AiGatewayKeyError({ reason: "forbidden", message: NOT_YOURS });
    }
    return actor.userId;
  });

  /** What a list shows of keys: names of their Users and Spaces, never a key or its hash. */
  const shown = Effect.fn("AiGatewayKeys.shown")(function* (
    summaries: ReadonlyArray<GatewayKeySummary>,
  ) {
    const spaceNames = yield* spaces
      .spacesById([...new Set(summaries.map((key) => key.spaceId))])
      .pipe(Effect.catch(storage("read the Spaces")));
    const userIds = [...new Set(summaries.map((key) => key.userId))];
    const users =
      userIds.length === 0
        ? []
        : yield* sql<{ readonly userId: string; readonly name: string }>`
            SELECT user_id AS "userId", display_name AS name FROM users
            WHERE ${sql.in("user_id", userIds)}
          `.pipe(Effect.catch(storage("read the Users")));
    const userNames = new Map(users.map((user) => [user.userId, user.name]));
    return summaries.map((key): AiGatewayUserKey => ({
      keyId: key.keyId,
      name: key.name,
      userId: key.userId,
      userName: userNames.get(key.userId) ?? null,
      spaceId: key.spaceId,
      spaceName: spaceNames.get(key.spaceId)?.name ?? null,
      createdAt: key.createdAt,
      lastUsedAt: key.lastUsedAt,
    }));
  });

  const listFor = Effect.fn("AiGatewayKeys.listFor")(function* (userId: UserId) {
    const principal = yield* principalFor(userId);
    const keys = yield* shown(yield* keysFor(userId, principal.isOwner));
    return { keys, everyone: principal.isOwner } satisfies AiGatewayKeyListResult;
  });

  const listForSession = Effect.gen(function* () {
    return yield* listFor(yield* sessionUser);
  }).pipe(Effect.withSpan("AiGatewayKeys.listForSession"));

  const createForSession = Effect.fn("AiGatewayKeys.createForSession")(function* (
    input: AiGatewayKeyCreateInput,
  ) {
    const userId = yield* sessionUser;
    const issued = yield* insertUserKey({
      actorUserId: userId,
      spaceId: input.spaceId,
      name: input.name,
    });
    return { created: issued.shown, key: issued.key } satisfies AiGatewayKeyCreateResult;
  });

  const revokeForSession = Effect.fn("AiGatewayKeys.revokeForSession")(function* (input: {
    readonly keyId: string;
  }) {
    const userId = yield* sessionUser;
    yield* revoke({ actorUserId: userId, keyId: input.keyId });
    return yield* listFor(userId);
  });

  const unavailable = (cause: unknown) =>
    Effect.logError("AiGatewayKeys: could not check a request", { cause }).pipe(
      Effect.andThen(refused(503, "The AI gateway could not check this key. Try again.")),
    );

  /**
   * An access key (access-keys ticket 01): the Space's, never a User's. Decided in the spec's
   * order: unknown or revoked (or its Space gone) 401, expired 403 with its date, its Space not
   * open 403, no AI account of the Space's own 403. Read again on every request.
   */
  const authorizeAccessKey = Effect.fn("AiGatewayKeys.authorizeAccessKey")(function* (raw: string) {
    const found = yield* accessKeyForRequest(sql, raw).pipe(Effect.catch(unavailable));
    if (Option.isNone(found)) return yield* refused(401, UNKNOWN_KEY);
    const accessKey = found.value;
    // A deleted Space's keys answer as revoked ones (access-keys ticket 07 revokes them with it).
    if (accessKey.revokedAt !== null || accessKey.space === "missing") {
      return yield* refused(401, UNKNOWN_KEY);
    }
    const now = yield* DateTime.now;
    const expiresAt = Date.parse(accessKey.expiresAt);
    // 403, not 401: a 401 makes Claude Code ask for `/login` and hides why.
    if (!(expiresAt > DateTime.toEpochMillis(now))) {
      return yield* refused(
        403,
        `This access key expired on ${utcMinute(expiresAt)}. Ask whoever gave it to you to renew it.`,
      );
    }
    if (accessKey.space !== "open") {
      return yield* refused(
        403,
        accessKey.space === "archived" || accessKey.space === "deleting"
          ? "This access key's Space is archived. It works again if the Space is restored."
          : "This access key's Space is closed now. It works again if the Space is reopened.",
      );
    }
    const own = yield* allowedAccounts.forSpace(accessKey.spaceId).pipe(Effect.catch(unavailable));
    const reach = accessKey.accounts === null ? null : new Set<string>(accessKey.accounts);
    const allowed = own.filter(
      (account) => account.type !== "direct" && (reach === null || reach.has(account.id)),
    );
    if (allowed.length === 0) {
      return yield* refused(403, "No AI account this access key may use is available now.");
    }
    yield* noteAccessKeyUse(sql, accessKey.keyId, now).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("AiGatewayKeys: could not note an access key's last use", { cause }),
      ),
    );
    return {
      keyId: accessKey.keyId,
      kind: "access",
      userId: null,
      accessKeyId: accessKey.keyId,
      spaceId: accessKey.spaceId,
      threadId: null,
      allowed,
      chosenAccountId: null,
    } satisfies GatewayCaller;
  });

  const authorize = Effect.fn("AiGatewayKeys.authorize")(function* (
    key: Redacted.Redacted<string>,
  ) {
    const raw = Redacted.value(key);
    if (!isGatewayKeyShaped(raw)) return yield* refused(401, UNKNOWN_KEY);
    if (isAccessKeyShaped(raw)) return yield* authorizeAccessKey(raw);
    // One read: the key, its User's state and, for a Thread key, the Thread.
    const rows = yield* sql<
      KeyRow & {
        readonly userStatus: "active" | "inactive" | "missing";
        readonly threadFound: number;
        readonly archivedAt: string | null;
        readonly deletedAt: string | null;
        readonly chosen: string | null;
        readonly revokedReason: string | null;
      }
    >`
      SELECT k.key_id AS "keyId", k.kind AS "kind", k.user_id AS "userId",
        k.space_id AS "spaceId", k.thread_id AS "threadId", k.name AS "name",
        k.created_at AS "createdAt", k.expires_at AS "expiresAt",
        k.last_used_at AS "lastUsedAt", k.revoked_at AS "revokedAt",
        k.revoked_reason AS "revokedReason",
        CASE WHEN u.user_id IS NULL THEN 'missing'
          WHEN u.disabled_at IS NOT NULL OR u.removed_at IS NOT NULL THEN 'inactive'
          ELSE 'active' END AS "userStatus",
        t.thread_id IS NOT NULL AS "threadFound", t.archived_at AS "archivedAt",
        t.deleted_at AS "deletedAt",
        json_extract(t.payload_json, '$.modelSelection.aiAccountId') AS "chosen"
      FROM ai_gateway_keys k
      LEFT JOIN users u ON u.user_id = k.user_id
      LEFT JOIN orchestration_v2_projection_threads t ON t.thread_id = k.thread_id
      WHERE k.key_hash = ${gatewayKeyHash(raw)}
    `.pipe(Effect.catch(unavailable));
    const row = rows[0];
    if (row === undefined) return yield* refused(401, UNKNOWN_KEY);
    const userId = UserId.make(row.userId);
    const spaceId = SpaceId.make(row.spaceId);
    // A User removed, disabled or gone: none of their keys work, whatever they are for (and
    // the record says so now, whether or not the watch got there first).
    if (row.userStatus !== "active") {
      if (row.userStatus === "inactive" && row.revokedAt === null) {
        yield* revokeUser(userId, "user-inactive").pipe(Effect.ignore);
      }
      return yield* refused(401, UNKNOWN_KEY);
    }
    if (row.revokedAt !== null) {
      // A User key whose User left its Space says so (its holder has it already).
      return yield* row.revokedReason === SPACE_LOST_REASON
        ? refused(403, SPACE_LOST)
        : refused(401, UNKNOWN_KEY);
    }
    const now = yield* DateTime.now;
    if (row.expiresAt !== null && Date.parse(row.expiresAt) <= DateTime.toEpochMillis(now)) {
      return yield* refused(401, UNKNOWN_KEY);
    }
    let threadId: ThreadId | null = null;
    let chosenAccountId: AiAccountId | null = null;
    if (row.kind === "thread") {
      threadId = ThreadId.make(row.threadId ?? "");
      if (!row.threadFound || row.deletedAt !== null || row.archivedAt !== null) {
        return yield* refused(401, UNKNOWN_KEY);
      }
      // The Thread's Space now (SpaceDirectory's rule), its turn owner and any move, at once.
      const [space, owner, blocked] = yield* Effect.all(
        [
          spaces.spaceOf({ kind: "thread", id: threadId }),
          threadTurnOwner(sql, threadId),
          spaces.workBlocked(threadId),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.catch(unavailable));
      // Moved or handed over: the key is over for good, and its row says so.
      const over = (reason: string, message: string) =>
        revokeRows([row], reason).pipe(Effect.ignore, Effect.andThen(refused(403, message)));
      if (Option.isNone(space) || space.value.id !== spaceId) {
        return yield* over(
          "thread-moved",
          "This Thread is in another Space now; its key no longer works.",
        );
      }
      // The key acts for the Thread's turn owner only: another owner, another key.
      if (Option.isNone(owner) || owner.value !== userId) {
        return yield* over("owner-changed", "This key is not for this Thread's owner.");
      }
      if (blocked === "project-moving") {
        return yield* refused(503, "The Project is moving to another Space. Try again.");
      }
      chosenAccountId = (row.chosen ?? null) as AiAccountId | null;
    }
    // Evaluated now, never cached, in one call: access to the Space (for a Thread key, the one
    // its Thread is in now, checked above to be the key's) and the accounts allowed there.
    const access = yield* allowedAccounts.accessIn(userId, spaceId).pipe(Effect.catch(unavailable));
    if (!access.works) {
      // A User key is over for good, recorded here; a Thread key is only refused.
      if (row.kind === "user") {
        yield* revokeRows([row], SPACE_LOST_REASON).pipe(Effect.ignore);
        return yield* refused(403, SPACE_LOST);
      }
      return yield* refused(403, THREAD_SPACE_LOST);
    }
    const allowed = access.accounts.filter((account) => account.type !== "direct");
    if (allowed.length === 0) {
      return yield* refused(403, "No AI account is allowed to you in this Space.");
    }
    // `last_used_at` is written at most once a minute per key.
    const at = DateTime.formatIso(now);
    const stale = DateTime.formatIso(DateTime.subtract(now, { minutes: 1 }));
    yield* sql`
      UPDATE ai_gateway_keys SET last_used_at = ${at}
      WHERE key_id = ${row.keyId} AND (last_used_at IS NULL OR last_used_at < ${stale})
    `.pipe(
      Effect.catch((cause) =>
        Effect.logWarning("AiGatewayKeys: could not note a key's last use", { cause }),
      ),
    );
    return {
      keyId: row.keyId,
      kind: row.kind,
      userId,
      accessKeyId: null,
      spaceId,
      threadId,
      allowed,
      chosenAccountId,
    } satisfies GatewayCaller;
  });

  return AiGatewayKeys.of({
    issueForThread,
    revokeLiveThreadKeys,
    revokeThread,
    revokeSession,
    revokeUser,
    createForUser,
    listUserKeys,
    revoke,
    createForSession,
    listForSession,
    revokeForSession,
    revokeLostSpaces,
    authorize,
  });
});

export const layer = Layer.effect(AiGatewayKeys, make);

/**
 * Spec 4 ticket 11: revokes, inside the caller's write transaction, every live key of a Thread
 * (it moved), of a User (removed) or made for a Space (deleted); each User key is audited.
 */
export const revokeWithin = Effect.fn("AiGatewayKeys.revokeWithin")(function* (
  sql: SqlClient.SqlClient,
  actor: AuditLog.AuditActor,
  of: { readonly threadId: ThreadId } | { readonly userId: UserId } | { readonly spaceId: SpaceId },
  reason: string,
) {
  const at = DateTime.formatIso(yield* DateTime.now);
  const which =
    "threadId" in of
      ? sql`thread_id = ${of.threadId}`
      : "userId" in of
        ? sql`user_id = ${of.userId}`
        : sql`space_id = ${of.spaceId}`;
  const revoked = yield* sql<{
    readonly keyId: string;
    readonly kind: string;
    readonly name: string;
    readonly spaceId: string;
  }>`
    UPDATE ai_gateway_keys SET revoked_at = ${at}, revoked_reason = ${reason}
    WHERE revoked_at IS NULL AND ${which}
    RETURNING key_id AS "keyId", kind AS "kind", name AS "name", space_id AS "spaceId"
  `;
  const write = AuditLog.write(sql);
  for (const row of revoked) {
    if (row.kind !== "user") continue;
    yield* write({
      actor,
      action: "ai_gateway_key.revoke",
      target: { kind: "ai_gateway_key", id: row.keyId, name: row.name },
      detail: { kind: row.kind, space: row.spaceId, reason },
    });
  }
});
