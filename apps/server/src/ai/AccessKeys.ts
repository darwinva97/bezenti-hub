// @effect-diagnostics nodeBuiltinImport:off -- random keys and their SHA-256, synchronous and small.
/**
 * Access keys (access-keys ticket 01): a Space's AI gateway keys, made, listed and revoked by
 * whoever manages it (AccessPolicy `accessKey.*`), checked per request through
 * `accessKeyForRequest`. The only file that names `ai_access_keys`. docs: ai-gateway.md.
 */
import * as NodeCrypto from "node:crypto";

import {
  ACCESS_KEY_MAX_ACCOUNTS,
  ACCESS_KEY_MAX_MODELS,
  ACCESS_KEY_MAX_PER_SPACE,
  ACCESS_KEY_MAX_VALIDITY_DAYS,
  ACCESS_KEY_NO_LIMITS,
  ACCESS_KEY_PREFIX,
  type AccessKey,
  type AccessKeyCreateInput,
  type AccessKeyCreateResult,
  AccessKeyError,
  AccessKeyLimits,
  type AccessKeyListInput,
  type AccessKeyListResult,
  type AccessKeyModelOptions,
  type AccessKeyModelOptionsInput,
  type AccessKeyReach,
  type AccessKeyRevokeInput,
  type AccessKeyValidity,
  accessKeyModelEntryValid,
  AiAccountId,
  SpaceId,
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
import type * as Statement from "effect/sql/Statement";

import * as AuditLog from "../audit/AuditLog.ts";
import * as AccessPolicy from "../auth/AccessPolicy.ts";
import * as CommandActor from "../auth/CommandActor.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as AccessKeyCaps from "./AccessKeyCaps.ts";
import * as AiAccounts from "./AiAccounts.ts";
import * as AllowedAiAccounts from "./AllowedAiAccounts.ts";

export { AccessKeyError };

const DAY_MS = 86_400_000;
const MAX_LABEL_LENGTH = 80;
/** A key that ended this long ago no longer counts as live, nor shows by default. */
const ENDED_SHOWN_DAYS = 30;
/** No caps until access-keys ticket 05. */
const NO_LIMITS_JSON = JSON.stringify(ACCESS_KEY_NO_LIMITS);
const jsonOf = (value: ReadonlyArray<string>) => JSON.stringify(value);

/**
 * A key's model list as stored (access-keys ticket 02): 1 to 50 well-formed entries, each once
 * (without case); `*` among others is «All models», `["*"]`.
 */
const checkedModels = (
  raw: ReadonlyArray<string>,
):
  | { readonly _tag: "models"; readonly models: ReadonlyArray<string> }
  | { readonly _tag: "refused" } => {
  const entries = raw.map((entry) => entry.trim());
  if (
    entries.length === 0 ||
    entries.length > ACCESS_KEY_MAX_MODELS ||
    !entries.every(accessKeyModelEntryValid)
  ) {
    return { _tag: "refused" };
  }
  if (entries.includes("*")) return { _tag: "models", models: ["*"] };
  const seen = new Set<string>();
  return {
    _tag: "models",
    models: entries.filter((entry) => {
      const key = entry.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  };
};
const NOT_YOURS =
  "Access keys are made, listed and revoked by a person in Space settings, not by an agent.";
const NO_SUCH_KEY = "No such access key.";

/** The only form a key is kept in: its SHA-256, hex. */
const accessKeyHash = (key: string) =>
  NodeCrypto.createHash("sha256").update(key, "utf8").digest("hex");

const newKey = () => `${ACCESS_KEY_PREFIX}${NodeCrypto.randomBytes(32).toString("base64url")}`;
const newKeyId = () => `ak_${NodeCrypto.randomBytes(12).toString("hex")}`;

const decodeModels = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodeAccounts = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.NullOr(Schema.Array(AiAccountId))),
);
const decodeLimits = Schema.decodeUnknownOption(Schema.fromJsonString(AccessKeyLimits));

interface KeyRow {
  readonly keyId: string;
  readonly spaceId: string;
  readonly label: string;
  readonly hint: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly modelsJson: string;
  readonly accountsJson: string | null;
  readonly expiresAt: string;
  readonly limitsJson: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
}

const KEY_COLUMNS = `key_id AS "keyId", space_id AS "spaceId", label, key_hint AS "hint",
  created_by AS "createdBy", created_at AS "createdAt", models_json AS "modelsJson",
  accounts_json AS "accountsJson", expires_at AS "expiresAt", limits_json AS "limitsJson",
  last_used_at AS "lastUsedAt", revoked_at AS "revokedAt"`;

/**
 * Its models, accounts and caps as stored. One that cannot be read reaches nothing: no model, no
 * account (never «all» by mistake).
 */
const limitsOf = (row: Pick<KeyRow, "modelsJson" | "accountsJson" | "limitsJson">) => ({
  models: Option.getOrElse(decodeModels(row.modelsJson), () => [] as ReadonlyArray<string>),
  accounts:
    row.accountsJson === null
      ? null
      : Option.getOrElse(decodeAccounts(row.accountsJson), () => [] as ReadonlyArray<AiAccountId>),
  limits: Option.getOrElse(decodeLimits(row.limitsJson), () => ACCESS_KEY_NO_LIMITS),
});

/** How the key's Space stands for a request, read with the key. */
export type AccessKeySpaceState =
  | "open"
  | "missing"
  | "archived"
  | "frozen"
  | "deleting"
  /** A Personal space whose User is disabled or removed: its AI accounts serve nobody. */
  | "owner-inactive";

/** What `AiGatewayKeys.authorize` needs of a request's access key. Never the key or its hash. */
export interface AccessKeyForRequest {
  readonly keyId: string;
  readonly spaceId: SpaceId;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly space: AccessKeySpaceState;
  readonly models: ReadonlyArray<string>;
  /** Null: every AI account the Space owns. */
  readonly accounts: ReadonlyArray<AiAccountId> | null;
  readonly limits: AccessKeyLimits;
}

/**
 * One read for a request: the key by its hash, its Space's state and, for a Personal space,
 * whether its User is active. None for an unknown key.
 */
export const accessKeyForRequest = Effect.fn("AccessKeys.accessKeyForRequest")(function* (
  sql: SqlClient.SqlClient,
  key: string,
) {
  const rows = yield* sql<
    KeyRow & {
      readonly spaceFound: number;
      readonly archived: number | null;
      readonly frozen: number | null;
      readonly deleting: number | null;
      readonly ownerActive: number | null;
    }
  >`
    SELECT k.key_id AS "keyId", k.space_id AS "spaceId", k.label, k.key_hint AS "hint",
      k.created_by AS "createdBy", k.created_at AS "createdAt", k.models_json AS "modelsJson",
      k.accounts_json AS "accountsJson", k.expires_at AS "expiresAt",
      k.limits_json AS "limitsJson", k.last_used_at AS "lastUsedAt", k.revoked_at AS "revokedAt",
      s.space_id IS NOT NULL AS "spaceFound", s.archived_at IS NOT NULL AS "archived",
      s.frozen_at IS NOT NULL AS "frozen", s.deleting_at IS NOT NULL AS "deleting",
      CASE WHEN s.kind = 'personal' THEN (
        SELECT u.disabled_at IS NULL AND u.removed_at IS NULL FROM users u
        WHERE u.user_id = s.personal_owner_user_id
      ) ELSE 1 END AS "ownerActive"
    FROM ai_access_keys k
    LEFT JOIN spaces s ON s.space_id = k.space_id
    WHERE k.key_hash = ${accessKeyHash(key)}
  `;
  const row = rows[0];
  if (row === undefined) return Option.none<AccessKeyForRequest>();
  const space: AccessKeySpaceState = !row.spaceFound
    ? "missing"
    : row.deleting === 1
      ? "deleting"
      : row.archived === 1
        ? "archived"
        : row.frozen === 1
          ? "frozen"
          : row.ownerActive !== 1
            ? "owner-inactive"
            : "open";
  return Option.some<AccessKeyForRequest>({
    keyId: row.keyId,
    spaceId: SpaceId.make(row.spaceId),
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    space,
    ...limitsOf(row),
  });
});

/** The labels of these keys, for the usage view (access-keys ticket 04); never more of a key. */
export const accessKeyLabels = Effect.fn("AccessKeys.accessKeyLabels")(function* (
  sql: SqlClient.SqlClient,
  keyIds: ReadonlyArray<string>,
) {
  if (keyIds.length === 0)
    return [] as ReadonlyArray<{ readonly id: string; readonly label: string }>;
  return yield* sql<{ readonly id: string; readonly label: string }>`
    SELECT key_id AS "id", label FROM ai_access_keys WHERE ${sql.in("key_id", [...new Set(keyIds)])}
  `;
});

/** Notes a key's use: written at most once a minute per key. */
export const noteAccessKeyUse = Effect.fn("AccessKeys.noteAccessKeyUse")(function* (
  sql: SqlClient.SqlClient,
  keyId: string,
  now: DateTime.Utc,
) {
  const at = DateTime.formatIso(now);
  const stale = DateTime.formatIso(DateTime.subtract(now, { minutes: 1 }));
  yield* sql`
    UPDATE ai_access_keys SET last_used_at = ${at}
    WHERE key_id = ${keyId} AND (last_used_at IS NULL OR last_used_at < ${stale})
  `;
});

export class AccessKeys extends Context.Service<
  AccessKeys,
  {
    /** Makes a key for a Space the actor manages (`accessKey.manage`); the key, once. */
    readonly create: (
      input: AccessKeyCreateInput & { readonly actorUserId: UserId },
    ) => Effect.Effect<AccessKeyCreateResult, AccessKeyError>;
    /**
     * One Space's keys (`accessKey.view` there), or, without a Space, every Space's whose keys
     * the actor sees (the Owner: all). Revoked keys and those that ended more than 30 days ago
     * only with `includeEnded`.
     */
    readonly list: (
      input: AccessKeyListInput & { readonly actorUserId: UserId },
    ) => Effect.Effect<AccessKeyListResult, AccessKeyError>;
    /** Revokes a key whose Space the actor may see keys of; anyone else's answers `not-found`. */
    readonly revoke: (
      input: AccessKeyRevokeInput & { readonly actorUserId: UserId },
    ) => Effect.Effect<AccessKey, AccessKeyError>;
    /**
     * The WS doors (Space settings → AI accounts → «Access keys»): for a person's own session
     * only. An agent (MCP, as its User), the Hub's shell or a session limited to one Space makes,
     * lists and revokes nothing.
     */
    readonly createForSession: (
      input: AccessKeyCreateInput,
    ) => Effect.Effect<AccessKeyCreateResult, AccessKeyError>;
    readonly listForSession: (
      input: AccessKeyListInput,
    ) => Effect.Effect<AccessKeyListResult, AccessKeyError>;
    readonly revokeForSession: (
      input: AccessKeyRevokeInput,
    ) => Effect.Effect<AccessKey, AccessKeyError>;
    /**
     * What a key of the Space may reach, for the form (access-keys ticket 02): the Space's own
     * gateway accounts and the models each serves. Whoever may make keys there.
     */
    readonly modelOptions: (
      input: AccessKeyModelOptionsInput & { readonly actorUserId: UserId },
    ) => Effect.Effect<AccessKeyModelOptions, AccessKeyError>;
    readonly modelOptionsForSession: (
      input: AccessKeyModelOptionsInput,
    ) => Effect.Effect<AccessKeyModelOptions, AccessKeyError>;
  }
>()("t3/ai/AccessKeys") {}

/**
 * When a key made (or renewed) now with this validity expires: N × 24 hours, or the instant
 * given, never past `ACCESS_KEY_MAX_VALIDITY_DAYS` from now.
 */
const expiryOf = (
  validity: AccessKeyValidity,
  now: DateTime.Utc,
):
  | { readonly _tag: "expires"; readonly expiresAt: string }
  | { readonly _tag: "refused"; readonly message: string } => {
  const nowMs = DateTime.toEpochMillis(now);
  if ("days" in validity) {
    return Number.isInteger(validity.days) &&
      validity.days >= 1 &&
      validity.days <= ACCESS_KEY_MAX_VALIDITY_DAYS
      ? {
          _tag: "expires",
          expiresAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs + validity.days * DAY_MS)),
        }
      : {
          _tag: "refused",
          message: `A key is valid for 1 to ${ACCESS_KEY_MAX_VALIDITY_DAYS} days.`,
        };
  }
  const until = DateTime.make(validity.until);
  if (Option.isNone(until)) return { _tag: "refused", message: "That end date is not a date." };
  const untilMs = DateTime.toEpochMillis(until.value);
  if (untilMs <= nowMs) return { _tag: "refused", message: "Choose an end date after now." };
  if (untilMs > nowMs + ACCESS_KEY_MAX_VALIDITY_DAYS * DAY_MS) {
    return {
      _tag: "refused",
      message: `A key is valid for at most ${ACCESS_KEY_MAX_VALIDITY_DAYS} days from now.`,
    };
  }
  return { _tag: "expires", expiresAt: DateTime.formatIso(until.value) };
};

const fail = (reason: AccessKeyError["reason"], message: string) =>
  Effect.fail(new AccessKeyError({ reason, message }));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const spaces = yield* SpaceDirectory.SpaceDirectory;
  const allowedAccounts = yield* AllowedAiAccounts.AllowedAiAccounts;
  const aiAccounts = yield* AiAccounts.AiAccounts;
  const caps = yield* AccessKeyCaps.AccessKeyCaps;
  const audit = yield* AuditLog.AuditLog;

  /** Listed keys with what each used (access-keys ticket 04). */
  const withUsage = Effect.fn("AccessKeys.withUsage")(function* (keys: ReadonlyArray<AccessKey>) {
    const usage = yield* caps
      .usageOf(keys.map((key) => key.keyId))
      .pipe(Effect.catch(storage("read the keys' use")));
    return keys.map((key): AccessKey => {
      const used = usage.get(key.keyId);
      return used === undefined ? key : { ...key, usage: used };
    });
  });

  const storage = (what: string) => (cause: unknown) =>
    Effect.logError(`AccessKeys: could not ${what}`, { cause }).pipe(
      Effect.andThen(fail("storage", `Could not ${what}. Try again.`)),
    );

  /** Whether a Space's own accounts hold a subscription (ADR 0005: the issuer is warned). */
  const reachesSubscription = (spaceId: SpaceId) =>
    allowedAccounts
      .forSpace(spaceId)
      .pipe(Effect.map((accounts) => accounts.some((account) => account.type === "subscription")));

  const checkedLabel = (raw: string) => {
    const label = raw.trim();
    return label.length === 0 || label.length > MAX_LABEL_LENGTH
      ? fail("invalid", `Say who the key is for (up to ${MAX_LABEL_LENGTH} characters).`)
      : Effect.succeed(label);
  };

  /** What a list shows of keys: names of their Spaces and issuers, never a key or its hash. */
  const shown = Effect.fn("AccessKeys.shown")(function* (rows: ReadonlyArray<KeyRow>) {
    const spaceNames = yield* spaces
      .spacesById([...new Set(rows.map((row) => SpaceId.make(row.spaceId)))])
      .pipe(Effect.catch(storage("read the Spaces")));
    const userIds = [...new Set(rows.map((row) => row.createdBy))];
    const users =
      userIds.length === 0
        ? []
        : yield* sql<{ readonly userId: string; readonly name: string }>`
            SELECT user_id AS "userId", display_name AS name FROM users
            WHERE ${sql.in("user_id", userIds)}
          `.pipe(Effect.catch(storage("read the Users")));
    const userNames = new Map(users.map((user) => [user.userId, user.name]));
    // A key's list of accounts (access-keys ticket 03): names, and whether the Space still has
    // each (one it no longer has serves the key no more).
    const lists = rows.flatMap((row) => {
      const accounts = limitsOf(row).accounts;
      return accounts === null ? [] : [{ spaceId: SpaceId.make(row.spaceId), accounts }];
    });
    const listedIds = [...new Set(lists.flatMap((list) => list.accounts))];
    const names =
      listedIds.length === 0
        ? []
        : yield* sql<{ readonly id: string; readonly name: string }>`
            SELECT account_id AS "id", name FROM ai_accounts WHERE ${sql.in("account_id", listedIds)}
          `.pipe(Effect.catch(storage("read the AI accounts")));
    const nameOf = new Map(names.map((account) => [account.id, account.name]));
    const ownBySpace = new Map<string, ReadonlySet<string>>();
    for (const spaceId of new Set(lists.map((list) => list.spaceId))) {
      const own = yield* allowedAccounts
        .forSpace(spaceId)
        .pipe(Effect.catch(storage("read the Space's AI accounts")));
      ownBySpace.set(
        spaceId,
        new Set(own.filter((account) => account.type !== "direct").map((account) => account.id)),
      );
    }
    const reachesOf = (row: KeyRow): ReadonlyArray<AccessKeyReach> | null => {
      const accounts = limitsOf(row).accounts;
      return accounts === null
        ? null
        : accounts.map((id) => ({
            id,
            name: nameOf.get(id) ?? null,
            inSpace: ownBySpace.get(row.spaceId)?.has(id) === true,
          }));
    };
    return rows.map((row): AccessKey => ({
      keyId: row.keyId,
      spaceId: SpaceId.make(row.spaceId),
      spaceName: spaceNames.get(SpaceId.make(row.spaceId))?.name ?? null,
      label: row.label,
      hint: row.hint,
      createdBy: UserId.make(row.createdBy),
      createdByName: userNames.get(row.createdBy) ?? null,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      lastUsedAt: row.lastUsedAt,
      revokedAt: row.revokedAt,
      ...limitsOf(row),
      reaches: reachesOf(row),
    }));
  });

  const principalFor = (userId: UserId) =>
    spaces.principalOf(userId).pipe(Effect.catch(storage("read who you are")));

  /**
   * Makes a key. The Space check, the live count and the insert are one write transaction (the
   * Hub's SQLite client begins every writing transaction `IMMEDIATE`): an Admin demoted, or an
   * Organization archived, commits either before (refused here) or after it. The answer is built
   * from what this call stored.
   */
  const create = Effect.fn("AccessKeys.create")(function* (
    input: AccessKeyCreateInput & { readonly actorUserId: UserId },
  ) {
    const label = yield* checkedLabel(input.label);
    const models = checkedModels(input.models);
    if (models._tag === "refused") {
      return yield* fail(
        "invalid",
        `Choose «All models», or 1 to ${ACCESS_KEY_MAX_MODELS} model names or patterns ending in a single *.`,
      );
    }
    // The accounts it reaches (access-keys ticket 03): absent or null, every one the Space owns.
    const chosen =
      input.accounts === undefined || input.accounts === null ? null : [...new Set(input.accounts)];
    if (chosen !== null && (chosen.length === 0 || chosen.length > ACCESS_KEY_MAX_ACCOUNTS)) {
      return yield* fail(
        "invalid",
        "Choose all of this Space's AI accounts, or at least one of them.",
      );
    }
    const now = yield* DateTime.now;
    const expiry = expiryOf(input.validity, now);
    if (expiry._tag === "refused") return yield* fail("invalid", expiry.message);
    const expiresAt = expiry.expiresAt;
    const at = DateTime.formatIso(now);
    const liveSince = DateTime.formatIso(DateTime.subtract(now, { days: ENDED_SHOWN_DAYS }));
    const key = newKey();
    const keyId = newKeyId();
    const row: KeyRow = {
      keyId,
      spaceId: input.spaceId,
      label,
      hint: key.slice(-4),
      createdBy: input.actorUserId,
      createdAt: at,
      modelsJson: jsonOf(models.models),
      accountsJson: chosen === null ? null : jsonOf(chosen),
      expiresAt,
      limitsJson: NO_LIMITS_JSON,
      lastUsedAt: null,
      revokedAt: null,
    };
    const outcome = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const principal = yield* spaces.principalOf(input.actorUserId);
          const space = (yield* spaces.spacesById([input.spaceId])).get(input.spaceId);
          if (space === undefined) return { _tag: "forbidden" } as const;
          const decision = AccessPolicy.decide(principal, "accessKey.manage", space.resource);
          if (decision._tag === "Deny") return { _tag: "denied", reason: decision.reason } as const;
          const live = yield* sql<{ readonly n: number }>`
            SELECT COUNT(*) AS n FROM ai_access_keys
            WHERE space_id = ${input.spaceId} AND revoked_at IS NULL AND expires_at > ${liveSince}
          `;
          if ((live[0]?.n ?? 0) >= ACCESS_KEY_MAX_PER_SPACE) return { _tag: "limit" } as const;
          // Only gateway accounts the Space owns: never one lent to it, a direct one or another's.
          const own = (yield* allowedAccounts.forSpace(input.spaceId)).filter(
            (account) => account.type !== "direct",
          );
          const ownIds = new Set<string>(own.map((account) => account.id));
          if (chosen !== null && !chosen.every((id) => ownIds.has(id))) {
            return { _tag: "not-own" } as const;
          }
          const reached =
            chosen === null ? own : own.filter((account) => chosen.includes(account.id));
          const subscription = reached.some((account) => account.type === "subscription");
          yield* sql`
            INSERT INTO ai_access_keys (key_id, key_hash, key_hint, space_id, label, created_by,
              created_at, models_json, accounts_json, expires_at, limits_json, updated_at)
            VALUES (${keyId}, ${accessKeyHash(key)}, ${row.hint}, ${row.spaceId}, ${label},
              ${row.createdBy}, ${at}, ${row.modelsJson}, ${row.accountsJson}, ${expiresAt},
              ${row.limitsJson}, ${at})
          `;
          yield* audit.record({
            actor: AuditLog.userActor(input.actorUserId),
            action: "access_key.create",
            spaceId: input.spaceId,
            target: { kind: "access_key", id: keyId, name: label },
            detail: {
              space: input.spaceId,
              expiresAt,
              limits: "none",
              models: models.models.includes("*") ? "all" : models.models.length,
              accounts: chosen === null ? "all" : chosen.length,
              subscription,
            },
          });
          return { _tag: "made" } as const;
        }),
      )
      .pipe(Effect.catch(storage("make the access key")));
    switch (outcome._tag) {
      case "forbidden":
        return yield* fail("forbidden", "You cannot make access keys in this Space.");
      case "not-own":
        return yield* fail(
          "invalid",
          "Choose AI accounts this Space owns that go through the AI gateway (not a direct one, nor one lent to it).",
        );
      case "denied":
        return yield* fail(
          "forbidden",
          outcome.reason === "space-archived" || outcome.reason === "space-frozen"
            ? "This Space is archived: its access keys can be revoked, not made."
            : "You cannot make access keys in this Space.",
        );
      case "limit":
        return yield* fail(
          "limit",
          `This Space has ${ACCESS_KEY_MAX_PER_SPACE} access keys. Revoke one to make another.`,
        );
      case "made": {
        const [created] = yield* shown([row]);
        return { created: created!, key: Redacted.make(key) } satisfies AccessKeyCreateResult;
      }
    }
  });

  const list = Effect.fn("AccessKeys.list")(function* (
    input: AccessKeyListInput & { readonly actorUserId: UserId },
  ) {
    const principal = yield* principalFor(input.actorUserId);
    const now = yield* DateTime.now;
    const liveSince = DateTime.formatIso(DateTime.subtract(now, { days: ENDED_SHOWN_DAYS }));
    const live =
      input.includeEnded === true
        ? sql`1 = 1`
        : sql`revoked_at IS NULL AND expires_at > ${liveSince}`;
    const read = (where: Statement.Fragment) =>
      sql<KeyRow>`
        SELECT ${sql.literal(KEY_COLUMNS)} FROM ai_access_keys
        WHERE ${where} AND ${live} ORDER BY created_at DESC, key_id
      `.pipe(Effect.catch(storage("list the access keys")));

    if (input.spaceId !== undefined) {
      const spaceId = input.spaceId;
      const space = (yield* spaces
        .spacesById([spaceId])
        .pipe(Effect.catch(storage("read the Space")))).get(spaceId);
      // A Space that no longer exists: only the Owner still sees (and revokes) its keys.
      const mayView =
        space === undefined
          ? principal.isOwner && principal.inactive !== true
          : AccessPolicy.isAllowed(
              AccessPolicy.decide(principal, "accessKey.view", space.resource),
            );
      if (!mayView) return yield* fail("forbidden", "You cannot see this Space's access keys.");
      const canManage =
        space !== undefined &&
        AccessPolicy.isAllowed(AccessPolicy.decide(principal, "accessKey.manage", space.resource));
      const subscription = yield* reachesSubscription(spaceId).pipe(
        Effect.catch(storage("read the Space's AI accounts")),
      );
      return {
        keys: yield* withUsage(yield* shown(yield* read(sql`space_id = ${spaceId}`))),
        everyone: false,
        space: { canManage, subscription },
      } satisfies AccessKeyListResult;
    }

    if (principal.isOwner && principal.inactive !== true) {
      return {
        keys: yield* withUsage(yield* shown(yield* read(sql`1 = 1`))),
        everyone: true,
        space: null,
      } satisfies AccessKeyListResult;
    }
    // Their Personal space and the Organizations they run, where the policy agrees.
    const candidates = [
      SpaceDirectory.personalSpaceIdOf(input.actorUserId),
      ...[...principal.roles].flatMap(([spaceId, role]) => (role === "admin" ? [spaceId] : [])),
    ];
    const known = yield* spaces
      .spacesById(candidates)
      .pipe(Effect.catch(storage("read your Spaces")));
    const viewable = [...known].flatMap(([spaceId, space]) =>
      AccessPolicy.isAllowed(AccessPolicy.decide(principal, "accessKey.view", space.resource))
        ? [spaceId]
        : [],
    );
    return {
      keys:
        viewable.length === 0
          ? []
          : yield* withUsage(yield* shown(yield* read(sql.in("space_id", viewable)))),
      everyone: false,
      space: null,
    } satisfies AccessKeyListResult;
  });

  const revoke = Effect.fn("AccessKeys.revoke")(function* (
    input: AccessKeyRevokeInput & { readonly actorUserId: UserId },
  ) {
    const readRow = sql<KeyRow>`
      SELECT ${sql.literal(KEY_COLUMNS)} FROM ai_access_keys WHERE key_id = ${input.keyId}
    `.pipe(Effect.catch(storage("read the access key")));
    const row = (yield* readRow)[0];
    if (row === undefined) return yield* fail("not-found", NO_SUCH_KEY);
    const principal = yield* principalFor(input.actorUserId);
    const space = (yield* spaces
      .spacesById([SpaceId.make(row.spaceId)])
      .pipe(Effect.catch(storage("read the Space")))).get(SpaceId.make(row.spaceId));
    const mayRevoke =
      space === undefined
        ? principal.isOwner && principal.inactive !== true
        : AccessPolicy.isAllowed(AccessPolicy.decide(principal, "accessKey.view", space.resource));
    // A key the actor does not manage answers like a missing one.
    if (!mayRevoke) return yield* fail("not-found", NO_SUCH_KEY);
    if (row.revokedAt === null) {
      const at = DateTime.formatIso(yield* DateTime.now);
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const revoked = yield* sql<{ readonly keyId: string }>`
              UPDATE ai_access_keys SET revoked_at = ${at}, revoked_reason = 'revoked',
                revoked_by = ${input.actorUserId}, updated_at = ${at}
              WHERE key_id = ${row.keyId} AND revoked_at IS NULL
              RETURNING key_id AS "keyId"
            `;
            // Revoked by someone else meanwhile: audited once, by them.
            if (revoked.length === 0) return;
            yield* audit.record({
              actor: AuditLog.userActor(input.actorUserId),
              action: "access_key.revoke",
              spaceId: space === undefined ? null : SpaceId.make(row.spaceId),
              target: { kind: "access_key", id: row.keyId, name: row.label },
              detail: { space: row.spaceId, reason: "revoked" },
            });
          }),
        )
        .pipe(Effect.catch(storage("revoke the access key")));
    }
    const [now] = yield* shown(yield* readRow);
    if (now === undefined) return yield* fail("not-found", NO_SUCH_KEY);
    return now;
  });

  const modelOptions = Effect.fn("AccessKeys.modelOptions")(function* (
    input: AccessKeyModelOptionsInput & { readonly actorUserId: UserId },
  ) {
    const principal = yield* principalFor(input.actorUserId);
    const space = (yield* spaces
      .spacesById([input.spaceId])
      .pipe(Effect.catch(storage("read the Space")))).get(input.spaceId);
    if (
      space === undefined ||
      !AccessPolicy.isAllowed(AccessPolicy.decide(principal, "accessKey.manage", space.resource))
    ) {
      return yield* fail("forbidden", "You cannot make access keys in this Space.");
    }
    const own = yield* allowedAccounts
      .forSpace(input.spaceId)
      .pipe(Effect.catch(storage("read the Space's AI accounts")));
    const accounts = yield* Effect.forEach(
      own.filter((account) => account.type !== "direct"),
      (account) =>
        aiAccounts.modelsOf(account.id).pipe(
          Effect.orElseSucceed(() => [] as ReadonlyArray<string>),
          Effect.map((served) => ({
            id: account.id,
            name: account.name,
            provider: account.provider,
            type: account.type,
            models: [...served],
          })),
        ),
      { concurrency: "unbounded" },
    );
    return { accounts } satisfies AccessKeyModelOptions;
  });

  /** The person behind a WS session: never an agent, the Hub's shell or a one-Space session. */
  const sessionUser = Effect.gen(function* () {
    const actor = yield* CommandActor.resolve;
    if (actor._tag !== "User" || actor.via !== undefined || actor.spaceLimit !== undefined) {
      return yield* fail("forbidden", NOT_YOURS);
    }
    return actor.userId;
  });

  return AccessKeys.of({
    create,
    list,
    revoke,
    createForSession: Effect.fn("AccessKeys.createForSession")(function* (
      input: AccessKeyCreateInput,
    ) {
      return yield* create({ ...input, actorUserId: yield* sessionUser });
    }),
    listForSession: Effect.fn("AccessKeys.listForSession")(function* (input: AccessKeyListInput) {
      return yield* list({ ...input, actorUserId: yield* sessionUser });
    }),
    revokeForSession: Effect.fn("AccessKeys.revokeForSession")(function* (
      input: AccessKeyRevokeInput,
    ) {
      return yield* revoke({ ...input, actorUserId: yield* sessionUser });
    }),
    modelOptions,
    modelOptionsForSession: Effect.fn("AccessKeys.modelOptionsForSession")(function* (
      input: AccessKeyModelOptionsInput,
    ) {
      return yield* modelOptions({ ...input, actorUserId: yield* sessionUser });
    }),
  });
});

/** With the keys' use (AccessKeyCaps), which the gateway's caps read too. */
export const layer = Layer.effect(AccessKeys, make).pipe(Layer.provideMerge(AccessKeyCaps.layer));
