import * as Schema from "effect/Schema";

import { SpaceId, TrimmedNonEmptyString, UserId } from "./baseSchemas.ts";

/**
 * Every action the audit log records. Closed: a new sensitive action adds its name here and
 * records it from its service. `secret.*` are recorded by the spec that owns secrets.
 */
export const AuditAction = Schema.Literals([
  "owner.bootstrap",
  "owner.resetLink",
  "resetLink.redeem",
  "invitation.create",
  "invitation.accept",
  "invitation.revoke",
  "membership.changeRole",
  "membership.remove",
  "membership.leave",
  "membership.resetLink",
  "installationPermission.grant",
  "installationPermission.revoke",
  "user.disable",
  "user.enable",
  "user.remove",
  "organization.archive",
  "organization.restore",
  "organization.delete",
  "project.move",
  "project.delete",
  "thread.delete",
  "guestLink.create",
  "appSignIn.approve",
  "mcpClient.approve",
  "cliSession.issue",
  "secret.reveal",
  "secret.edit",
  "vault.create",
  "vault.update",
  "vault.delete",
  "vault.allow",
  "vault.choose",
  "secret.master_key.export",
  "secret.master_key.rotate",
  "environment.register",
  "environment.rename",
  "environment.remove",
  "environment.mode.change",
  "thread.move",
  "sandbox.create",
  "sandbox.start",
  "sandbox.stop",
  "sandbox.delete",
  "sandbox.limits.change",
  "sandbox.image.update",
  "ai_gateway.update",
  "ai_gateway.rollback",
  "ai_gateway.enable",
  "ai_account.create",
  "ai_account.update",
  "ai_account.delete",
  "ai_account.allow",
  // Spec 4 ticket 03: a subscription signed in (or not), or a Vertex service account imported.
  "ai_account.login",
  // Spec 4 ticket 04: a User's gateway key for a local CLI made or revoked (Thread keys rotate
  // with each provider session and are not audited one by one).
  "ai_gateway_key.create",
  "ai_gateway_key.revoke",
]);
export type AuditAction = typeof AuditAction.Type;

export const AuditTargetKind = Schema.Literals([
  "user",
  "space",
  "invitation",
  "project",
  "thread",
  "session",
  "secret",
  "vault",
  "environment",
  "ai_account",
  "ai_gateway_key",
]);
export type AuditTargetKind = typeof AuditTargetKind.Type;

/**
 * Who acted: a signed-in User, an agent acting as its User (MCP tools, a Thread's agent), the
 * Hub's shell (`t3 ...`, as `--user` when given), or the server's own work.
 */
export const AuditActorSource = Schema.Literals(["user", "agent", "cli", "system"]);
export type AuditActorSource = typeof AuditActorSource.Type;

/**
 * The only detail keys each action may carry; anything else is dropped on write. Values are ids,
 * enums, counts and names already shown elsewhere, never a token, password, code or secret.
 */
export const AUDIT_DETAIL_KEYS = {
  "owner.bootstrap": [],
  "owner.resetLink": [],
  "resetLink.redeem": ["method"],
  "invitation.create": ["role"],
  "invitation.accept": ["role", "newUser"],
  "invitation.revoke": ["role"],
  "membership.changeRole": ["from", "to"],
  "membership.remove": [],
  "membership.leave": [],
  "membership.resetLink": [],
  "installationPermission.grant": ["permission"],
  "installationPermission.revoke": ["permission"],
  "user.disable": ["from"],
  "user.enable": ["from"],
  "user.remove": ["from"],
  "organization.archive": [],
  "organization.restore": [],
  "organization.delete": [],
  "project.move": ["fromSpaceId"],
  "project.delete": [],
  "thread.delete": ["via"],
  "guestLink.create": ["expiresAt"],
  "appSignIn.approve": ["client", "redirect"],
  "mcpClient.approve": ["client", "access", "method"],
  "cliSession.issue": ["sessionId", "label", "scopes"],
  /** The Vault's name and id and the entry's kind (`own`, `copy`, `link`); never the value. */
  "secret.reveal": ["vault", "vaultId", "kind"],
  /**
   * As `secret.reveal`, with `op`: `add`, `replace` (a new value), `rename`, `describe`, `link`,
   * `copy` or `delete` (`brokenLinks`: how many Secret links its deletion broke), `seal`,
   * `allow-reveal` or `class` (`class`: the new one); `dangerous` when the Owner confirmed a name
   * that changes how tools run.
   */
  "secret.edit": [
    "vault",
    "vaultId",
    "kind",
    "op",
    "from",
    "brokenLinks",
    "dangerous",
    "class",
    // A Provider entry's provider, by label (`op: reference` when it reads elsewhere).
    "provider",
  ],
  "vault.create": [],
  /** The name `from` and `to`, whether it was described, and `archived` when that changed. */
  "vault.update": ["from", "to", "described", "archived"],
  /** How many secrets it held. */
  "vault.delete": ["entries"],
  /** Allowed (`allowed`: true) or taken back, to a `space` or a `user` (`subjectKind`, `subjectId`). */
  "vault.allow": ["subjectKind", "subjectId", "subjectName", "allowed"],
  /**
   * A Space's defaults or a Project's choice changed: `scope` space or project (`projectId`),
   * `choice` default, none, add, remove or inherit, and the default's `position`.
   */
  "vault.choose": ["scope", "projectId", "choice", "position"],
  /** `settings` or `cli`, and the key's id (a fingerprint, never the key). */
  "secret.master_key.export": ["via", "keyId"],
  /** The key ids before and after (fingerprints, never keys). */
  "secret.master_key.rotate": ["via", "from", "keyId"],
  /**
   * `mode` personal or dedicated (with its `spaceId`), `via` join or ssh (with the `host` the Hub
   * installed it on, never its key).
   */
  "environment.register": ["kind", "os", "mode", "spaceId", "via", "host"],
  "environment.rename": ["from", "to"],
  /**
   * `settings` from the Hub, `leave` from the machine, `userTurnedOff` with its owner, `ssh` when
   * an SSH install that registered it failed or was cancelled afterwards.
   */
  "environment.remove": ["via"],
  /** Modes (`personal`, `dedicated`) and Spaces (null for personal) before and after. */
  "environment.mode.change": ["from", "to", "fromSpaceId", "toSpaceId"],
  /**
   * Environment ids; `started`, `switched`, `failed` or `cancelled`; the failed step and its
   * trimmed message; what the target continues from; whether the source was offline; set-aside refs.
   */
  "thread.move": [
    "from",
    "to",
    "outcome",
    "failedStep",
    "failureMessage",
    "continuesFrom",
    "continuesFromRef",
    "sourceOffline",
    "setAside",
  ],
  /** Which Sandbox runtime made it (process or podman). */
  "sandbox.create": ["runtime"],
  /**
   * `demand`: work needed it; `retry`: a User's «Try again»; `settings` or `restart`: the Owner
   * by hand; `update`: moved to a new image. `started` or `failed`, with the trimmed reason.
   */
  "sandbox.start": ["via", "outcome", "reason"],
  /**
   * `archived`: its Organization was; `idle`: nothing ran in it for the idle timeout; `settings` or
   * `restart`: the Owner by hand; `update`: the Owner moved it to a new image; `disk-full`: its
   * home went over its disk limit (or could not be measured); `host-disk-low`: the Hub's disk for
   * Sandboxes is almost full. `hold`: the Owner's stop, which waiting work does not undo.
   */
  "sandbox.stop": ["via", "hold"],
  "sandbox.delete": [],
  /**
   * `defaults` (the Installation's, no Space) or `space`; each new value, null where there is no
   * limit (defaults) or the default applies (a Space).
   */
  "sandbox.limits.change": ["scope", "cpus", "memoryBytes", "pids", "diskBytes"],
  /**
   * `build`: the base image was built from `settings` or the `cli` (`outcome` `built` or
   * `failed`, the new `version` or the trimmed `reason`); `restart`: a running Sandbox moved
   * `from` one version to `version` at the Owner's request.
   */
  "sandbox.image.update": ["via", "outcome", "version", "from", "reason"],
  /** The CLIProxyAPI releases before and after; `updated` or `failed`, with the trimmed reason. */
  "ai_gateway.update": ["from", "version", "outcome", "reason"],
  "ai_gateway.rollback": ["from", "version", "outcome", "reason"],
  /** `on` or `off`, as the Owner chose where the environment does not decide. */
  "ai_gateway.enable": ["to"],
  /** The account's provider and type, and `via: "migration"` for a key moved from a provider
   * instance at the Hub's start (spec 4 ticket 09); never its credential, nor any part of it. */
  "ai_account.create": ["provider", "type", "via"],
  /** What changed: `from` and `to` on a rename, `disabled`, `credential` (replaced), `endpoint`. */
  "ai_account.update": ["provider", "from", "to", "disabled", "credential", "endpoint", "priority"],
  "ai_account.delete": ["provider"],
  /** How many Spaces and Users it is allowed to now, and the change. */
  "ai_account.allow": ["spaces", "users", "added", "removed"],
  /** Which provider, a new account or «Sign in again», and how it ended; never a token. */
  "ai_account.login": ["provider", "kind", "outcome", "reason"],
  /** The key's kind and Space; never the key, nor any part of it. */
  "ai_gateway_key.create": ["kind", "space"],
  /** Why: `revoked` by a person (its User or the Owner); `space-lost` or `user-inactive` by the Hub. */
  "ai_gateway_key.revoke": ["kind", "space", "reason"],
} as const satisfies Record<AuditAction, ReadonlyArray<string>>;

export type AuditDetailOf<A extends AuditAction> = {
  readonly [K in (typeof AUDIT_DETAIL_KEYS)[A][number]]?: string | number | boolean | null;
};

/** Small facts about the action, limited to `AUDIT_DETAIL_KEYS` for its action. */
export const AuditDetail = Schema.Record(
  Schema.String,
  Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null]),
);
export type AuditDetail = typeof AuditDetail.Type;

export const AuditEntry = Schema.Struct({
  id: Schema.Number,
  at: Schema.DateTimeUtc,
  actor: Schema.Struct({
    source: AuditActorSource,
    userId: Schema.NullOr(UserId),
    /** Still resolves for a removed User. */
    displayName: Schema.NullOr(Schema.String),
  }),
  space: Schema.NullOr(Schema.Struct({ id: SpaceId, name: Schema.NullOr(Schema.String) })),
  action: AuditAction,
  target: Schema.Struct({
    kind: AuditTargetKind,
    id: Schema.String,
    /** Its name now, else its name when the action happened. */
    name: Schema.NullOr(Schema.String),
  }),
  detail: AuditDetail,
});
export type AuditEntry = typeof AuditEntry.Type;

export const AuditLogPage = Schema.Struct({
  entries: Schema.Array(AuditEntry),
  /** Every Space the log names, deleted ones too, to filter by. */
  spaces: Schema.Array(
    Schema.Struct({ id: SpaceId, name: Schema.NullOr(Schema.String), deleted: Schema.Boolean }),
  ),
  /** Pass as `before` for the next, older page; null on the last page. */
  nextCursor: Schema.NullOr(Schema.String),
});
export type AuditLogPage = typeof AuditLogPage.Type;

/** Newest first. Dates are ISO 8601; `from` is inclusive and `to` exclusive. */
export const AuditLogQuery = Schema.Struct({
  action: Schema.optional(AuditAction),
  actorUserId: Schema.optional(UserId),
  spaceId: Schema.optional(SpaceId),
  from: Schema.optional(TrimmedNonEmptyString),
  to: Schema.optional(TrimmedNonEmptyString),
  before: Schema.optional(TrimmedNonEmptyString),
  limit: Schema.optional(TrimmedNonEmptyString),
});
export type AuditLogQuery = typeof AuditLogQuery.Type;
