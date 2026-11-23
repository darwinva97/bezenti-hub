import * as Schema from "effect/Schema";

import { AiAccountId, AiAccountProvider, AiAccountType } from "./aiAccounts.ts";
import { SpaceId, TrimmedNonEmptyString, UserId } from "./baseSchemas.ts";

/**
 * Access keys (spec `access-keys`): a Space's AI gateway keys for someone with or without a Hub
 * account; their use counts on the key, never a User. Only WS `accessKeys.*`, for whoever manages
 * the Space; no agent, MCP tool or HTTP endpoint. docs/internals/ai-gateway.md, «Access keys».
 */

/** Every access key starts so: `t3ak_` and 32 random bytes, base64url. Stored only hashed. */
export const ACCESS_KEY_PREFIX = "t3ak_";

/** Live access keys one Space may hold (neither revoked nor expired more than 30 days ago). */
export const ACCESS_KEY_MAX_PER_SPACE = 50;
/** The longest validity, in days from the moment it is set. */
export const ACCESS_KEY_MAX_VALIDITY_DAYS = 366;

/** Who the key is for, as its issuer names it (the recipient's name, a team, a test). */
export const AccessKeyLabel = TrimmedNonEmptyString.check(Schema.isMaxLength(80));

/**
 * Token caps of a key: for its whole life (`total`) and per UTC day, ISO week and month; null: no
 * cap of that kind. Access-keys ticket 05 sets them; until then every key has none.
 */
export const AccessKeyLimits = Schema.Struct({
  total: Schema.NullOr(Schema.Number),
  day: Schema.NullOr(Schema.Number),
  week: Schema.NullOr(Schema.Number),
  month: Schema.NullOr(Schema.Number),
});
export type AccessKeyLimits = typeof AccessKeyLimits.Type;

export const ACCESS_KEY_NO_LIMITS: AccessKeyLimits = {
  total: null,
  day: null,
  week: null,
  month: null,
};

/**
 * How long a key is valid: N days from now, or until an instant (the end of a day in the issuer's
 * time zone, sent as UTC). At most `ACCESS_KEY_MAX_VALIDITY_DAYS`; never «forever».
 */
export const AccessKeyValidity = Schema.Union([
  Schema.Struct({
    days: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: ACCESS_KEY_MAX_VALIDITY_DAYS })),
  }),
  Schema.Struct({ until: TrimmedNonEmptyString }),
]);
export type AccessKeyValidity = typeof AccessKeyValidity.Type;

/** At most this many model entries per key. */
export const ACCESS_KEY_MAX_MODELS = 50;

/** An exact name, a `prefix*` pattern, or `*` alone («All models»): never a space or a control. */
const MODEL_ENTRY = /^(?:\*|[^\s*\u0000-\u001f]+\*?)$/u;

/** Whether one entry of a key's model list has the right form. */
export const accessKeyModelEntryValid = (entry: string) =>
  entry.length >= 1 && entry.length <= 256 && MODEL_ENTRY.test(entry);

export const AccessKeyModelEntry = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  Schema.isPattern(MODEL_ENTRY),
);

/** The models a key may use: 1 to 50 entries; `["*"]` is «All models». */
export const AccessKeyModels = Schema.Array(AccessKeyModelEntry).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(ACCESS_KEY_MAX_MODELS),
);

/** Whether a key's list is «All models». */
export const accessKeyAllowsAllModels = (entries: ReadonlyArray<string>) => entries.includes("*");

/**
 * Whether a key with these entries may use `requested` (access-keys ticket 02). Without case; the
 * requested name without an `acct-<id>/` prefix (the account rule decides that) and without a
 * trailing `[…]` such as `[1m]`. An exact name admits only itself (a dated version needs a
 * pattern); `prefix*` what starts so; `*` everything; an entry of the wrong form nothing.
 */
export const accessKeyModelAllowed = (entries: ReadonlyArray<string>, requested: string) => {
  const model = requested
    .replace(/^acct-[^/]+\//iu, "")
    .replace(/\[[^\]]*\]$/u, "")
    .toLowerCase();
  return entries.some((entry) => {
    if (!accessKeyModelEntryValid(entry)) return false;
    const wanted = entry.toLowerCase();
    if (wanted === "*") return true;
    return wanted.endsWith("*") ? model.startsWith(wanted.slice(0, -1)) : model === wanted;
  });
};

/** An access key as whoever manages its Space sees it: never the key, nor its hash. */
export const AccessKey = Schema.Struct({
  keyId: TrimmedNonEmptyString,
  spaceId: SpaceId,
  /** Null for a Space that no longer exists (the Owner lists every Space's keys). */
  spaceName: Schema.NullOr(Schema.String),
  label: Schema.String,
  /** The key's last four characters, to tell it apart from others in the list. */
  hint: Schema.String,
  createdBy: UserId,
  /** The issuer's name; the key stays the Space's whatever happens to them. */
  createdByName: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  expiresAt: Schema.String,
  /** Written at most once a minute per key. */
  lastUsedAt: Schema.NullOr(Schema.String),
  revokedAt: Schema.NullOr(Schema.String),
  /** Models it may use, exact names or `prefix*`; `["*"]`: every model. */
  models: Schema.Array(Schema.String),
  /** The Space's AI accounts it reaches; null: every one the Space owns, now and later. */
  accounts: Schema.NullOr(Schema.Array(AiAccountId)),
  limits: AccessKeyLimits,
});
export type AccessKey = typeof AccessKey.Type;

export const AccessKeyCreateInput = Schema.Struct({
  spaceId: SpaceId,
  label: AccessKeyLabel,
  validity: AccessKeyValidity,
  /** Exact names or `prefix*` patterns; `["*"]` only by choosing «All models». */
  models: AccessKeyModels,
});
export type AccessKeyCreateInput = typeof AccessKeyCreateInput.Type;

/** The one answer that carries the key: right after it is made, shown once, never stored. */
export const AccessKeyCreateResult = Schema.Struct({
  created: AccessKey,
  key: Schema.RedactedFromValue(Schema.String),
});
export type AccessKeyCreateResult = typeof AccessKeyCreateResult.Type;

export const AccessKeyListInput = Schema.Struct({
  /** One Space's keys. Without it: every Space whose keys the viewer sees (the Owner: all). */
  spaceId: Schema.optionalKey(SpaceId),
  /** Also revoked keys and those expired more than 30 days ago («Show ended»). */
  includeEnded: Schema.optionalKey(Schema.Boolean),
});
export type AccessKeyListInput = typeof AccessKeyListInput.Type;

export const AccessKeyListResult = Schema.Struct({
  keys: Schema.Array(AccessKey),
  /** True for the Owner's list of every Space. */
  everyone: Schema.Boolean,
  /** For a list of one Space: what the viewer may do there and what its keys would reach. */
  space: Schema.NullOr(
    Schema.Struct({
      /** May make keys here (`accessKey.manage`): not in an archived or frozen Space. */
      canManage: Schema.Boolean,
      /** A key here reaches a subscription account (ADR 0005: the form warns). */
      subscription: Schema.Boolean,
    }),
  ),
});
export type AccessKeyListResult = typeof AccessKeyListResult.Type;

export const AccessKeyRevokeInput = Schema.Struct({ keyId: TrimmedNonEmptyString });

export const AccessKeyModelOptionsInput = Schema.Struct({ spaceId: SpaceId });
export type AccessKeyModelOptionsInput = typeof AccessKeyModelOptionsInput.Type;

/** One AI account the Space owns that a key may reach (gateway only), with what it serves. */
export const AccessKeyAccountOption = Schema.Struct({
  id: AiAccountId,
  name: Schema.String,
  provider: AiAccountProvider,
  type: AiAccountType,
  models: Schema.Array(Schema.String),
});
export type AccessKeyAccountOption = typeof AccessKeyAccountOption.Type;

/** What the form offers: the Space's own gateway accounts, in its order, and their models. */
export const AccessKeyModelOptions = Schema.Struct({
  accounts: Schema.Array(AccessKeyAccountOption),
});
export type AccessKeyModelOptions = typeof AccessKeyModelOptions.Type;
export type AccessKeyRevokeInput = typeof AccessKeyRevokeInput.Type;

/** Why making, listing or revoking an access key failed, in words for its issuer; never a key. */
export class AccessKeyError extends Schema.TaggedError<AccessKeyError>()("AccessKeyError", {
  reason: Schema.Literals(["forbidden", "not-found", "invalid", "limit", "storage"]),
  message: Schema.String,
}) {}
