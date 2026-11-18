/**
 * Grants: an owner lends one resource to a Space, with limits, and can take it back. Machines
 * (`environment`), AI accounts and Vault groups are lent. See docs/internals/grants.md.
 */
import * as Schema from "effect/Schema";

import { AiAccountId, AiAccountProvider, AiAccountType } from "./aiAccounts.ts";
import { EnvironmentId, GrantId, SpaceId, TrimmedNonEmptyString, UserId } from "./baseSchemas.ts";
import { GrantCap, GrantCapState } from "./grantCaps.ts";
import { SandboxHostReport } from "./hubEnvironments.ts";
import { AuthReauth } from "./userAccounts.ts";
import { VaultEntryId, VaultGroupId } from "./vaults.ts";

export { GrantId };

export const GrantResourceKind = Schema.Literals(["environment", "ai-account", "vault-group"]);
export type GrantResourceKind = typeof GrantResourceKind.Type;

/**
 * `offered`: a lending link not applied yet; `pending`: waiting for the destination;
 * `active`: in use; `rejected`, `cancelled` and `ended` are history.
 */
export const GrantState = Schema.Literals([
  "offered",
  "pending",
  "active",
  "rejected",
  "cancelled",
  "ended",
]);
export type GrantState = typeof GrantState.Type;

export const GrantEndReason = Schema.Literals([
  "revoked",
  "returned",
  "resource-gone",
  "target-gone",
  "lender-gone",
  "owner-changed",
]);
export type GrantEndReason = typeof GrantEndReason.Type;

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

/**
 * A lent machine's limits for its borrower's Sandbox: CPUs (fractions allowed), memory, processes
 * and threads (a fork bomb stops there) and disk, each required. The Hub checks them against the
 * Sandbox floors; the machine caps CPU and memory at what it has.
 */
export const EnvironmentGrantLimits = Schema.Struct({
  kind: Schema.Literal("environment"),
  cpus: Schema.Number.check(Schema.isGreaterThan(0)),
  memoryBytes: PositiveInt,
  pids: PositiveInt,
  diskBytes: PositiveInt,
});
export type EnvironmentGrantLimits = typeof EnvironmentGrantLimits.Type;

/**
 * A lent AI account's caps, enforced by the AI gateway on each request: tokens (input, output and
 * cache writes) and requests per period. Null: no cap, an explicit choice.
 */
export const AiAccountGrantLimits = Schema.Struct({
  kind: Schema.Literal("ai-account"),
  tokens: Schema.NullOr(GrantCap),
  requests: Schema.NullOr(GrantCap),
});
export type AiAccountGrantLimits = typeof AiAccountGrantLimits.Type;

/** A lent Vault group has no limits: its borrower's agents read its Secrets, or nothing reaches them. */
export const VaultGroupGrantLimits = Schema.Struct({ kind: Schema.Literal("vault-group") });
export type VaultGroupGrantLimits = typeof VaultGroupGrantLimits.Type;

/** By resource kind. */
export const GrantLimits = Schema.Union([
  EnvironmentGrantLimits,
  AiAccountGrantLimits,
  VaultGroupGrantLimits,
]);
export type GrantLimits = typeof GrantLimits.Type;

export const GrantResourceRef = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("environment"), environmentId: EnvironmentId }),
  Schema.Struct({ kind: Schema.Literal("ai-account"), aiAccountId: AiAccountId }),
  Schema.Struct({ kind: Schema.Literal("vault-group"), vaultGroupId: VaultGroupId }),
]);
export type GrantResourceRef = typeof GrantResourceRef.Type;

export const GrantSpaceRef = Schema.Struct({
  spaceId: SpaceId,
  kind: Schema.Literals(["organization", "personal"]),
  name: Schema.String,
  /** A Personal space's owner, by display name: every Personal space has the same `name`. */
  ownerDisplayName: Schema.optionalKey(Schema.String),
});
export type GrantSpaceRef = typeof GrantSpaceRef.Type;

export const Grant = Schema.Struct({
  id: GrantId,
  resource: Schema.Struct({
    kind: GrantResourceKind,
    id: Schema.String,
    name: Schema.NullOr(Schema.String),
  }),
  lender: Schema.Struct({
    kind: Schema.Literals(["user", "organization"]),
    id: Schema.String,
    name: Schema.NullOr(Schema.String),
  }),
  target: Schema.NullOr(GrantSpaceRef),
  state: GrantState,
  endReason: Schema.NullOr(GrantEndReason),
  limits: GrantLimits,
  createdAt: Schema.String,
  decidedAt: Schema.NullOr(Schema.String),
  endedAt: Schema.NullOr(Schema.String),
  /**
   * A lent machine's: what it last said of hosting Sandboxes (null: it never did, as an older
   * one), and its Sandbox for this Grant while active, as its host reports it. Never its Threads.
   */
  machine: Schema.optionalKey(
    Schema.Struct({
      host: Schema.NullOr(SandboxHostReport),
      lentEnvironmentId: Schema.NullOr(EnvironmentId),
      sandboxState: Schema.NullOr(Schema.String),
      sandboxMessage: Schema.NullOr(Schema.String),
      diskUsedBytes: Schema.NullOr(Schema.Number),
      diskMeasureFailures: Schema.Int,
    }),
  ),
  /**
   * A lent AI account's provider and type (a subscription's terms forbid sharing it) and, while
   * active, how much of its caps is used (Grants ticket 03).
   */
  aiAccount: Schema.optionalKey(
    Schema.Struct({
      provider: AiAccountProvider,
      type: AiAccountType,
      caps: Schema.optionalKey(GrantCapState),
    }),
  ),
  /**
   * A lending link's (Grants ticket 06), to its lender: when it expires and whether it is still
   * open, expired, used (then the Grant has its destination) or cancelled. Never its token.
   */
  offer: Schema.optionalKey(
    Schema.Struct({
      expiresAt: Schema.String,
      status: Schema.Literals(["open", "expired", "used", "cancelled"]),
    }),
  ),
  /**
   * A lent Vault group's, for its lender only (Grants ticket 07): once the loan is over, the
   * Secrets the borrower's agents could read whose value was not replaced since. Names only.
   */
  vaultGroup: Schema.optionalKey(
    Schema.Struct({
      toRotate: Schema.Array(Schema.Struct({ entryId: VaultEntryId, name: Schema.String })),
    }),
  ),
  /** What the viewer may do with it now. */
  can: Schema.Struct({
    cancel: Schema.Boolean,
    revoke: Schema.Boolean,
    decide: Schema.Boolean,
    return: Schema.Boolean,
    setLimits: Schema.Boolean,
  }),
});
export type Grant = typeof Grant.Type;

export const GrantList = Schema.Struct({ grants: Schema.Array(Grant) });
export type GrantList = typeof GrantList.Type;

export const GrantListGivenInput = Schema.Struct({});
export type GrantListGivenInput = typeof GrantListGivenInput.Type;

/** Without a Space: every Space where the viewer works or decides. */
export const GrantListReceivedInput = Schema.Struct({ spaceId: Schema.optionalKey(SpaceId) });
export type GrantListReceivedInput = typeof GrantListReceivedInput.Type;

/** The Spaces a resource may be lent to by the viewer. */
export const GrantTargetsInput = Schema.Struct({ resource: GrantResourceRef });
export type GrantTargetsInput = typeof GrantTargetsInput.Type;

export const GrantTarget = Schema.Struct({
  ...GrantSpaceRef.fields,
  /** The lender also decides there: the Grant starts active (and asks for a strong factor). */
  startsActive: Schema.Boolean,
});
export type GrantTarget = typeof GrantTarget.Type;

export const GrantTargets = Schema.Struct({
  targets: Schema.Array(GrantTarget),
  /** What the machine last said of hosting Sandboxes; null when it never did. */
  host: Schema.NullOr(SandboxHostReport),
});
export type GrantTargets = typeof GrantTargets.Type;

export const GrantGiveInput = Schema.Struct({
  resource: GrantResourceRef,
  spaceId: SpaceId,
  limits: GrantLimits,
  /** A Plan as the destination: refused (`plan-target-unavailable`) until Plans exist. */
  planId: Schema.optionalKey(Schema.String),
  /**
   * A Vault group's loan that starts active: also make it the Space's last default (Grants
   * ticket 07). Ignored otherwise.
   */
  useAsDefault: Schema.optionalKey(Schema.Boolean),
});
export type GrantGiveInput = typeof GrantGiveInput.Type;

export const GrantRefInput = Schema.Struct({ grantId: GrantId });
export type GrantRefInput = typeof GrantRefInput.Type;

export const GrantSetLimitsInput = Schema.Struct({ grantId: GrantId, limits: GrantLimits });
export type GrantSetLimitsInput = typeof GrantSetLimitsInput.Type;

/**
 * Grants ticket 02: what an AI account allowance «to a User» reached that the Grant it became
 * (to their Personal space) does not: an Organization they work in. Only the Owner sees these;
 * nothing here grants anything until the Owner lends it there.
 */
export const GrantMigrationReview = Schema.Struct({
  aiAccountId: AiAccountId,
  aiAccountName: Schema.String,
  provider: AiAccountProvider,
  userId: UserId,
  userName: Schema.String,
  spaceId: SpaceId,
  spaceName: Schema.String,
  /** The User used the account in that Organization in the 90 days before the migration. */
  usedRecently: Schema.Boolean,
  /** The Owner decides there too: lending starts active at once. */
  startsActive: Schema.Boolean,
});
export type GrantMigrationReview = typeof GrantMigrationReview.Type;

export const GrantMigrationReviewsInput = Schema.Struct({});
export type GrantMigrationReviewsInput = typeof GrantMigrationReviewsInput.Type;

/**
 * Grants ticket 07: the same for a Vault allowance «to a User»: one of the Owner's groups reached
 * that User's own turns in an Organization they work in, and its Grant (to their Personal space)
 * does not. Lending it there reaches every Thread of that Organization that chooses it.
 */
export const GrantVaultGroupMigrationReview = Schema.Struct({
  vaultGroupId: VaultGroupId,
  vaultGroupName: Schema.String,
  userId: UserId,
  userName: Schema.String,
  spaceId: SpaceId,
  spaceName: Schema.String,
  startsActive: Schema.Boolean,
});
export type GrantVaultGroupMigrationReview = typeof GrantVaultGroupMigrationReview.Type;

export const GrantMigrationReviews = Schema.Struct({
  reviews: Schema.Array(GrantMigrationReview),
  vaultGroups: Schema.optionalKey(Schema.Array(GrantVaultGroupMigrationReview)),
});
export type GrantMigrationReviews = typeof GrantMigrationReviews.Type;

/** «Dismiss»: the Owner keeps it narrowed; the row goes. */
export const GrantDismissMigrationReviewInput = Schema.Union([
  Schema.Struct({ aiAccountId: AiAccountId, userId: UserId, spaceId: SpaceId }),
  Schema.Struct({ vaultGroupId: VaultGroupId, userId: UserId, spaceId: SpaceId }),
]);
export type GrantDismissMigrationReviewInput = typeof GrantDismissMigrationReviewInput.Type;

/**
 * HTTP: giving or accepting a machine needs a strong factor when it makes the Grant active;
 * giving a Vault group always does (its Secrets reach the borrower's agents).
 */
export const GrantGiveRequest = Schema.Struct({
  ...GrantGiveInput.fields,
  reauth: Schema.optionalKey(AuthReauth),
});
export type GrantGiveRequest = typeof GrantGiveRequest.Type;

export const GrantAcceptRequest = Schema.Struct({
  grantId: GrantId,
  reauth: Schema.optionalKey(AuthReauth),
  /** A Vault group's loan: also make it the Space's last default (Grants ticket 07). */
  useAsDefault: Schema.optionalKey(Schema.Boolean),
});
export type GrantAcceptRequest = typeof GrantAcceptRequest.Type;

/** How long a lending link works, and how many may be open per resource. */
export const GRANT_OFFER_DAYS = 7;
export const GRANT_OPEN_OFFERS_PER_RESOURCE = 10;

/** A lending link's secret, from its `#token=` fragment. */
export const GrantOfferToken = TrimmedNonEmptyString.check(Schema.isMaxLength(256));

/** A lending link for a Space the lender does not name: works once, for `GRANT_OFFER_DAYS`. */
export const GrantCreateOfferInput = Schema.Struct({
  resource: GrantResourceRef,
  limits: GrantLimits,
});
export type GrantCreateOfferInput = typeof GrantCreateOfferInput.Type;

export const GrantCreatedOffer = Schema.Struct({
  grant: Grant,
  /**
   * `/grants/offer#token=<token>`: shown once, the Hub keeps only its hash. The token rides in the
   * fragment, so no request, log or Referer carries it.
   */
  path: Schema.String,
  /** On the Hub's public address (`T3CODE_PUBLIC_URL`); null: the client's origin. */
  url: Schema.NullOr(Schema.String),
});
export type GrantCreatedOffer = typeof GrantCreatedOffer.Type;

export const GrantReadOfferInput = Schema.Struct({ token: GrantOfferToken });
export type GrantReadOfferInput = typeof GrantReadOfferInput.Type;

/** A Space the reader may apply a link to (they decide there). */
export const GrantOfferSpace = Schema.Struct({
  ...GrantSpaceRef.fields,
  /** The resource is already lent to (or waiting for) this Space: applying it there is refused. */
  alreadyGranted: Schema.Boolean,
});
export type GrantOfferSpace = typeof GrantOfferSpace.Type;

/**
 * What a signed-in User who holds a link sees: what is lent, by whom, with which limits, and
 * their Spaces to apply it to. A used, cancelled, expired or unknown link is just `invalid`.
 */
export const GrantOfferPreview = Schema.Union([
  Schema.Struct({ status: Schema.Literal("invalid") }),
  Schema.Struct({
    status: Schema.Literal("valid"),
    resource: Schema.Struct({
      kind: GrantResourceKind,
      name: Schema.String,
      /** A subscription's terms forbid sharing it. */
      aiAccount: Schema.optionalKey(
        Schema.Struct({ provider: AiAccountProvider, type: AiAccountType }),
      ),
    }),
    lender: Schema.Struct({
      kind: Schema.Literals(["user", "organization"]),
      name: Schema.NullOr(Schema.String),
    }),
    limits: GrantLimits,
    expiresAt: Schema.String,
    spaces: Schema.Array(GrantOfferSpace),
  }),
]);
export type GrantOfferPreview = typeof GrantOfferPreview.Type;

/**
 * Grants ticket 15: a lent Vault group's use. One row per UTC day, User of the borrowing Space and
 * lent name: how many processes (turns, terminals, scripts) received it. Names and counts only,
 * never a value nor a Thread.
 */
export const GrantVaultUsageInput = Schema.Struct({ grantId: GrantId });
export type GrantVaultUsageInput = typeof GrantVaultUsageInput.Type;

export const GrantVaultUsageRow = Schema.Struct({
  day: Schema.String,
  userId: UserId,
  userName: Schema.NullOr(Schema.String),
  name: Schema.String,
  deliveries: Schema.Number,
});
export type GrantVaultUsageRow = typeof GrantVaultUsageRow.Type;

/** The most rows one answer carries, newest first. */
export const GRANT_VAULT_USAGE_ROWS = 1000;

export const GrantVaultUsage = Schema.Struct({
  rows: Schema.Array(GrantVaultUsageRow),
  /** Older rows exist beyond `GRANT_VAULT_USAGE_ROWS`. */
  truncated: Schema.Boolean,
});
export type GrantVaultUsage = typeof GrantVaultUsage.Type;

/** Applying a link is accepting it: the Grant starts active in `spaceId`. */
export const GrantClaimOfferInput = Schema.Struct({ token: GrantOfferToken, spaceId: SpaceId });
export type GrantClaimOfferInput = typeof GrantClaimOfferInput.Type;

export const GrantErrorReason = Schema.Literals([
  "not-found",
  "not-allowed",
  "illegal-transition",
  "already-granted",
  "not-lendable",
  "plan-target-unavailable",
  "invalid-limits",
  /** A resource has `GRANT_OPEN_OFFERS_PER_RESOURCE` open lending links already. */
  "too-many-offers",
  /** Too many links that did not work: wait (`message` says how long). */
  "throttled",
  /** The machine said it cannot host a Sandbox now (`reason` in the message). */
  "host-not-ready",
  /** Making a machine Grant active needs a passkey or TOTP, over HTTP. */
  "strong-factor-required",
  "storage",
]);
export type GrantErrorReason = typeof GrantErrorReason.Type;

export class GrantError extends Schema.TaggedError<GrantError>()("GrantError", {
  reason: GrantErrorReason,
  message: Schema.String,
}) {}
