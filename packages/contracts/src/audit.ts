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
  // Keycloak sign-in, ticket 05: a mapped Keycloak group gave someone a Membership.
  "membership.add",
  "installationPermission.grant",
  "installationPermission.revoke",
  "user.disable",
  "user.enable",
  "user.remove",
  // Keycloak sign-in spec, ticket 01: the Owner's sign-in settings.
  "signIn.settings.update",
  // Ticket 02: a User linked a Keycloak identity (by issuer and subject, never by email).
  "user.identity.link",
  // Ticket 03: a User created by signing in through Keycloak without an Invitation.
  "user.register",
  // Ticket 07: a Keycloak sign-in ended, with the sessions and pairing links born of it.
  "keycloak.login.end",
  "organization.create",
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
  "vault_group.create",
  "vault_group.update",
  "vault_group.delete",
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
  // Access-keys ticket 01: a Space's access key made or revoked (by a person, or by the Hub).
  "access_key.create",
  "access_key.revoke",
  // Access-keys ticket 06: renewed, extended, or its caps, models, accounts or label changed.
  "access_key.update",
  // Makita ticket 01: the bot's GitHub account registered or replaced, and the Owner's switch.
  "makita.account.update",
  "makita.pause_all",
  "makita.resume_all",
  // Makita ticket 02: «may use Makita» given or taken back per User and Space.
  "makita.permission.grant",
  "makita.permission.revoke",
  // Makita ticket 03: a configuration made, changed, deleted, paused or resumed, and the label
  // Makita made on GitHub for it.
  "makita.config.create",
  "makita.config.update",
  "makita.config.delete",
  "makita.config.pause",
  "makita.config.resume",
  "makita.github.label",
  // Vaults ticket 03: Secret providers (from the settings) and their Provider scopes.
  "secret_provider.create",
  "secret_provider.update",
  "secret_provider.delete",
  "secret_provider.test",
  "provider_scope.create",
  "provider_scope.update",
  "provider_scope.delete",
  "provider_scope.allow",
  // Vaults ticket 07: a workload identity token the Hub signed (never the token itself).
  "identity.issue",
  // Grants: a resource lent to a Space, decided, taken back or returned.
  "grant.give",
  "grant.offer",
  "grant.accept",
  "grant.reject",
  "grant.cancel",
  "grant.end",
  "grant.limits.change",
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
  "access_key",
  "makita_account",
  "makita_config",
  "secret_provider",
  "provider_scope",
  "grant",
  "sign_in_settings",
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
  /**
   * `identityRemoved` when the reset also ended a Keycloak link (Keycloak sign-in, ticket 02);
   * `method` `keycloak` when it bound a Keycloak account instead (ticket 08).
   */
  "resetLink.redeem": ["method", "identityRemoved"],
  /** `platform` for a Platform invitation (Keycloak sign-in, ticket 04): no Space, no Role. */
  "invitation.create": ["role", "platform"],
  "invitation.accept": ["role", "newUser", "platform"],
  "invitation.revoke": ["role", "platform"],
  /**
   * Ticket 05: `keycloakGroup` when a mapped group decided it (actor `system`), and `managed` when
   * it moved between `keycloak` and `manual` (a group took over a manual one, or its mapping went).
   */
  "membership.changeRole": ["from", "to", "keycloakGroup", "managed"],
  /** `keycloakGroup`: the group whose leaving took it (ticket 05, actor `system`). */
  "membership.remove": ["keycloakGroup"],
  "membership.leave": [],
  "membership.resetLink": [],
  "membership.add": ["role", "keycloakGroup"],
  "installationPermission.grant": ["permission"],
  "installationPermission.revoke": ["permission"],
  "user.disable": ["from"],
  "user.enable": ["from"],
  "user.remove": ["from"],
  /**
   * The fields that changed, the new mode, switches and issuer; never the client secret. How many
   * sign-ins a strong-list change ended (`loginsEnded`, ticket 06), and how many local sessions and
   * links turning local sign-in off ended (ticket 08). Other ended sign-ins have their own entry.
   */
  "signIn.settings.update": [
    "changed",
    "registrationMode",
    "keycloakEnabled",
    "localSignInForMembers",
    "issuer",
    "secretReplaced",
    "strongAcr",
    "strongAmr",
    "loginsEnded",
    "groupsClaim",
    "mappingsAdded",
    "mappingsRemoved",
    // Which mappings changed: «added|removed|role group organization role» lines, at most 20.
    "mappingChanges",
    "mappingChangesTruncated",
    "localSessionsEnded",
    "localPairingLinksEnded",
  ],
  /**
   * The realm the identity comes from and whether the User's own passkeys, password and TOTP went
   * with the link (the Owner keeps theirs); `via` `reset` when an Owner's reset link bound it
   * (ticket 08). Never the subject, the email or a token.
   */
  "user.identity.link": ["issuer", "credentialsRemoved", "via"],
  /**
   * `via` what admitted them (`open` registration; ticket 05 adds `group`) and the realm their
   * identity comes from. Never the subject, the email or a token.
   */
  "user.register": ["via", "issuer"],
  /**
   * Ticket 07: why a Keycloak sign-in ended (`refresh-refused`, `backchannel`, `sign-out`,
   * `no-refresh-token`, `token-unusable`, `keycloak-off`, `issuer-changed`, and ticket 11's
   * `user-disabled`, `user-removed`; see KeycloakLogins)
   * and how many sessions and pairing links ended with it. Never the subject, `sid` or a token.
   */
  "keycloak.login.end": ["reason", "sessions", "pairingLinks"],
  "organization.create": [],
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
  /**
   * No longer written (owned-resources 01: nothing reveals a Secret); older rows still show. The
   * Vault's name and id and the entry's kind; never the value.
   */
  "secret.reveal": ["vault", "vaultId", "kind"],
  /**
   * Group (`vault`, `vaultId`), kind, `type` (secret|variable) and `op`: add, replace, rename,
   * describe, delete, to-secret, to-variable, unlinked (migration 142); older rows: class, link,
   * copy, seal, allow-reveal, `brokenLinks`. Never a value, a Variable's included.
   */
  "secret.edit": [
    "vault",
    "vaultId",
    "kind",
    "op",
    "type",
    "from",
    "brokenLinks",
    "dangerous",
    "class",
    // A Provider entry's provider, by label (`op: reference` when it reads elsewhere).
    "provider",
    // How it reaches a process (`op: delivery` when that changed); a template's text never goes.
    "delivery",
  ],
  /** Before owned-resources 03 (a Vault); later rows say `vault_group.*`. */
  "vault.create": [],
  "vault.update": ["from", "to", "described", "archived"],
  "vault.delete": ["entries"],
  /** A group of a Vault (owned-resources 03): whose Vault it is part of. */
  "vault_group.create": ["ownerKind", "ownerId"],
  /** The name `from` and `to`, whether it was described, and `archived` when that changed. */
  "vault_group.update": ["from", "to", "described", "archived"],
  /** How many entries it held. */
  /** `via` the removal that took it (`user.remove`, `organization.delete`), if any. */
  "vault_group.delete": ["entries", "via"],
  /** Allowed (`allowed`: true) or taken back, to a `space` or a `user` (`subjectKind`, `subjectId`). */
  /** No longer written (Grants ticket 07: allowances became Grants); older rows still show. */
  "vault.allow": ["subjectKind", "subjectId", "subjectName", "allowed"],
  /**
   * A Space's defaults or a Project's choice changed: `scope` space or project (`projectId`),
   * `choice` default, none, add, remove or inherit, and the default's `position`; `via` what did
   * it besides a choice (`grant.accept`, `grant.end`, `migration`).
   */
  "vault.choose": ["scope", "projectId", "choice", "position", "via"],
  /** `settings` or `cli`, and the key's id (a fingerprint, never the key). */
  "secret.master_key.export": ["via", "keyId"],
  /** The key ids before and after (fingerprints, never keys). */
  "secret.master_key.rotate": ["via", "from", "keyId"],
  /**
   * `mode` personal or dedicated (with its `spaceId`), `via` join or ssh (with the `host` the Hub
   * installed it on, never its key).
   */
  "environment.register": ["kind", "os", "mode", "spaceId", "via", "host", "ownerKind", "ownerId"],
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
  "ai_account.create": ["provider", "type", "via", "ownerKind", "ownerId"],
  /** What changed: `from` and `to` on a rename, `disabled`, `credential` (replaced), `endpoint`. */
  "ai_account.update": [
    "provider",
    "from",
    "to",
    "disabled",
    "credential",
    "endpoint",
    "priority",
    "ownerKind",
    "ownerId",
  ],
  "ai_account.delete": ["provider", "ownerKind", "ownerId", "via"],
  /** How many Spaces and Users it is allowed to now, and the change. */
  "ai_account.allow": ["spaces", "users", "added", "removed"],
  /** Which provider, a new account or «Sign in again», and how it ended; never a token. */
  "ai_account.login": ["provider", "kind", "outcome", "reason", "ownerKind", "ownerId"],
  /** The key's kind and Space; never the key, nor any part of it. */
  "ai_gateway_key.create": ["kind", "space"],
  /** Why: `revoked` by a person (its User or the Owner); `space-lost` or `user-inactive` by the Hub. */
  "ai_gateway_key.revoke": ["kind", "space", "reason"],
  /**
   * The key's Space and expiry, and what it may use: `limits` (`none` until caps exist), `models`
   * (`all` or how many), `accounts` (`all` or how many), whether it reaches a `subscription`.
   * Never the key, its hash or its hint.
   */
  "access_key.create": ["space", "expiresAt", "limits", "models", "accounts", "subscription"],
  /** Why: `revoked` by a person; `space-gone` by the Hub (`via` the removal that took it). */
  "access_key.revoke": ["space", "reason", "via"],
  /** Which fields changed (`changed`), the new expiry and caps; `via: renew` for only the expiry. */
  "access_key.update": ["space", "changed", "expiresAt", "limits", "via"],
  /**
   * Makita's GitHub account registered or replaced: its login, the token's kind and a classic
   * token's scopes (joined by commas; `fine-grained` lists none). Never the token or any part of it.
   */
  "makita.account.update": ["login", "tokenKind", "scopes", "replaced"],
  /** «Stop all Makita work» and its undoing, the Owner's. */
  "makita.pause_all": [],
  "makita.resume_all": [],
  /** The Space and the User's Role there; the target is the User. */
  "makita.permission.grant": ["space", "role"],
  /** Why: `revoked` by the Owner; `user-removed` with the User's removal from the Hub. */
  "makita.permission.revoke": ["space", "reason"],
  /**
   * A configuration's Space, repositories (`all` or how many Projects), whom it answers and what
   * it may do; `changed` names the fields an update changed. Never a login list or a model's text.
   */
  "makita.config.create": ["space", "repos", "callersMode", "capability", "mayLand", "aiAccount"],
  "makita.config.update": ["space", "changed", "capability", "mayLand", "aiAccount"],
  "makita.config.delete": ["space"],
  /** `manual` by its creator or an Admin, `owner`, or the Hub's (`permission-revoked`, …). */
  "makita.config.pause": ["space", "reason"],
  "makita.config.resume": ["space"],
  /** The label Makita made in a repository for a configuration (`owner/name`, public). */
  "makita.github.label": ["space", "repo", "label", "outcome"],
  /** The provider's kind and which config fields changed, by name; never a credential. */
  "secret_provider.create": ["kind", "changed"],
  "secret_provider.update": ["kind", "changed"],
  "secret_provider.delete": ["kind"],
  /** Whether it signed in and, for a scope, whether its probe read; classes, never a value. */
  "secret_provider.test": ["scope", "auth", "probe"],
  /** Its provider and how many path prefixes it allows; `broke`: entries the change broke. */
  "provider_scope.create": ["provider", "paths", "writable"],
  "provider_scope.update": ["provider", "paths", "writable", "broke"],
  "provider_scope.delete": ["provider", "broke"],
  "provider_scope.allow": ["vault", "vaultId", "allowed", "broke"],
  /** Its audience, subject, id and expiry, and the Thread it was signed for; never the token. */
  "identity.issue": ["aud", "sub", "jti", "exp", "thread"],
  /**
   * The resource's kind, id and name, the lender, the destination Space and the limits (by field);
   * `state` it started in; `via` `migration` for a loan an allowance became. Never a token or a
   * credential.
   */
  "grant.give": [
    "resourceKind",
    "resourceId",
    "resourceName",
    "lenderId",
    "targetSpaceId",
    "state",
    "cpus",
    "memoryBytes",
    "pids",
    "diskBytes",
    "tokensAmount",
    "tokensPeriod",
    "requestsAmount",
    "requestsPeriod",
    "via",
  ],
  /**
   * Grants ticket 06: a lending link made, with what it lends and its limits and expiry; never
   * the link's token or its hash.
   */
  "grant.offer": [
    "resourceKind",
    "resourceId",
    "resourceName",
    "lenderId",
    "expiresAt",
    "tokensAmount",
    "tokensPeriod",
    "requestsAmount",
    "requestsPeriod",
  ],
  /** `via` `link` when it was accepted by applying a lending link. */
  "grant.accept": [
    "resourceKind",
    "resourceId",
    "resourceName",
    "lenderId",
    "targetSpaceId",
    "via",
  ],
  "grant.reject": ["resourceKind", "resourceId", "resourceName", "lenderId", "targetSpaceId"],
  "grant.cancel": [
    "resourceKind",
    "resourceId",
    "resourceName",
    "lenderId",
    "targetSpaceId",
    "via",
  ],
  /**
   * `reason` (revoked, returned, resource-gone…) and the `side` that ended it; `via` the removal
   * (`user.remove`, `organization.delete`) when a side of it is gone.
   */
  "grant.end": [
    "resourceKind",
    "resourceId",
    "resourceName",
    "lenderId",
    "targetSpaceId",
    "reason",
    "side",
    "via",
  ],
  "grant.limits.change": [
    "resourceKind",
    "resourceId",
    "cpus",
    "memoryBytes",
    "pids",
    "diskBytes",
    "tokensAmount",
    "tokensPeriod",
    "requestsAmount",
    "requestsPeriod",
  ],
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
