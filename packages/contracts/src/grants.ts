/**
 * Grants: an owner lends one resource to a Space, with limits, and can take it back. Only machines
 * (`environment`) are lent today; AI accounts and Vault groups fit the same row later. See
 * docs/internals/grants.md.
 */
import * as Schema from "effect/Schema";

import { EnvironmentId, makeEntityId, SpaceId } from "./baseSchemas.ts";
import { SandboxHostReport } from "./hubEnvironments.ts";
import { AuthReauth } from "./userAccounts.ts";

export const GrantId = makeEntityId("GrantId");
export type GrantId = typeof GrantId.Type;

export const GrantResourceKind = Schema.Literals(["environment", "ai-account", "vault-group"]);
export type GrantResourceKind = typeof GrantResourceKind.Type;

/**
 * `offered`: a lending link not applied yet (later); `pending`: waiting for the destination;
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

/** By resource kind; the others join this union when they can be lent. */
export const GrantLimits = Schema.Union([EnvironmentGrantLimits]);
export type GrantLimits = typeof GrantLimits.Type;

export const GrantResourceRef = Schema.Struct({
  kind: Schema.Literal("environment"),
  environmentId: EnvironmentId,
});
export type GrantResourceRef = typeof GrantResourceRef.Type;

export const GrantSpaceRef = Schema.Struct({
  spaceId: SpaceId,
  kind: Schema.Literals(["organization", "personal"]),
  name: Schema.String,
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

export const GrantTargets = Schema.Struct({ targets: Schema.Array(GrantTarget) });
export type GrantTargets = typeof GrantTargets.Type;

export const GrantGiveInput = Schema.Struct({
  resource: GrantResourceRef,
  spaceId: SpaceId,
  limits: GrantLimits,
});
export type GrantGiveInput = typeof GrantGiveInput.Type;

export const GrantRefInput = Schema.Struct({ grantId: GrantId });
export type GrantRefInput = typeof GrantRefInput.Type;

export const GrantSetLimitsInput = Schema.Struct({ grantId: GrantId, limits: GrantLimits });
export type GrantSetLimitsInput = typeof GrantSetLimitsInput.Type;

/** HTTP: giving or accepting a machine needs a strong factor when it makes the Grant active. */
export const GrantGiveRequest = Schema.Struct({
  ...GrantGiveInput.fields,
  reauth: Schema.optionalKey(AuthReauth),
});
export type GrantGiveRequest = typeof GrantGiveRequest.Type;

export const GrantAcceptRequest = Schema.Struct({
  grantId: GrantId,
  reauth: Schema.optionalKey(AuthReauth),
});
export type GrantAcceptRequest = typeof GrantAcceptRequest.Type;

export const GrantErrorReason = Schema.Literals([
  "not-found",
  "not-allowed",
  "illegal-transition",
  "already-granted",
  "not-lendable",
  "plan-target-unavailable",
  "invalid-limits",
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
