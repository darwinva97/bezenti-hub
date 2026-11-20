/**
 * The Platform's sign-in settings (Keycloak sign-in spec, ticket 01): the Owner's alone, audited.
 * The client secret is write-only (`keycloak-client-secret`, read back only by `keycloakConfig`).
 * A strong-list change (ticket 06) ends the Owner's and Admins' sign-ins it makes weak, confirmed.
 */
import {
  type KeycloakCheckResult,
  type KeycloakGroupMapping,
  type MappableOrganization,
  MAX_GROUP_LENGTH,
  type RegistrationMode,
  type SignInSettings as SignInSettingsView,
  type SpaceId,
  type SpaceRole,
  type UpdateSignInSettingsRequest,
  type UserId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as AuditLog from "../audit/AuditLog.ts";
import * as ServerConfig from "../config.ts";
import * as UserIdentities from "../persistence/UserIdentities.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as AccessPolicy from "./AccessPolicy.ts";
import * as GroupSync from "./GroupSync.ts";
import * as KeycloakAdmission from "./KeycloakAdmission.ts";
import * as KeycloakClient from "./KeycloakClient.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as UserDirectory from "./UserDirectory.ts";

/** The client secret's name in the Hub's encrypted store. */
export const CLIENT_SECRET_NAME = "keycloak-client-secret";

const OWNER_ONLY = "Only the Owner manages the sign-in settings.";

export class SignInSettingsDeniedError extends Schema.TaggedError<SignInSettingsDeniedError>()(
  "SignInSettingsDeniedError",
  {},
) {
  override get message(): string {
    return OWNER_ONLY;
  }
}

/** A value the Owner must correct; `message` says which, in plain words. */
export class SignInSettingsInvalidError extends Schema.TaggedError<SignInSettingsInvalidError>()(
  "SignInSettingsInvalidError",
  { message: Schema.String },
) {}

export class SignInSettingsStorageError extends Schema.TaggedError<SignInSettingsStorageError>()(
  "SignInSettingsStorageError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not read or save the sign-in settings.";
  }
}

/**
 * The settings were saved and audited, but the encrypted store refused the new client secret:
 * the Hub still holds the previous one, or none. The Owner enters it again.
 */
export class SignInSecretNotStoredError extends Schema.TaggedError<SignInSecretNotStoredError>()(
  "SignInSecretNotStoredError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "The settings were saved, but the client secret could not be stored. Enter it again.";
  }
}

/**
 * A change to the strong-factor lists would end Keycloak sign-ins of the Owner and Admins
 * (ticket 06), and the request did not confirm it: nothing was saved. `loginsToEnd` says how many.
 */
export class SignInSettingsConfirmError extends Schema.TaggedError<SignInSettingsConfirmError>()(
  "SignInSettingsConfirmError",
  { loginsToEnd: Schema.Number, otherAccessToEnd: Schema.Number },
) {
  override get message(): string {
    const signIns =
      this.loginsToEnd === 1 ? "1 Keycloak sign-in" : `${this.loginsToEnd} Keycloak sign-ins`;
    const other =
      this.otherAccessToEnd === 0
        ? ""
        : this.otherAccessToEnd === 1
          ? ", and 1 app session or pairing link of those Admins"
          : `, and ${this.otherAccessToEnd} app sessions or pairing links of those Admins`;
    return `This change ends ${signIns} of the Owner or Admins that would no longer count as strong${other} (yours too, if yours is one; your passkey still signs you in). Save again to confirm.`;
  }
}

/** What ticket 02 signs in with: the enabled realm's client, its secret Redacted. */
export interface KeycloakConfig {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: Redacted.Redacted<string>;
  /** Who a new identity may become a User as (ticket 03), read with the client. */
  readonly registrationMode: RegistrationMode;
  readonly groupsClaim: string;
  readonly strongAcr: ReadonlyArray<string>;
  readonly strongAmr: ReadonlyArray<string>;
}

export class SignInSettings extends Context.Service<
  SignInSettings,
  {
    readonly read: (
      actor: UserId,
    ) => Effect.Effect<SignInSettingsView, SignInSettingsDeniedError | SignInSettingsStorageError>;
    /**
     * Merges the change onto the saved settings; turning Keycloak on runs «Check» first. A
     * strong-list change re-marks live Keycloak sign-ins and ends the Owner's and Admins' now weak;
     * unconfirmed (`endLoginsConfirmed`), one that would end any saves nothing and says how many.
     */
    readonly update: (
      actor: UserId,
      request: UpdateSignInSettingsRequest,
    ) => Effect.Effect<
      SignInSettingsView,
      | SignInSettingsDeniedError
      | SignInSettingsInvalidError
      | SignInSettingsStorageError
      | SignInSecretNotStoredError
      | SignInSettingsConfirmError
    >;
    /** «Check» the saved issuer: discovery and key set. Never another address. */
    readonly check: (
      actor: UserId,
    ) => Effect.Effect<KeycloakCheckResult, SignInSettingsDeniedError | SignInSettingsStorageError>;
    /** Internal (ticket 02): the client to sign in with, while Keycloak is on. No door. */
    readonly keycloakConfig: Effect.Effect<
      Option.Option<KeycloakConfig>,
      SignInSettingsStorageError
    >;
    /**
     * Whether the sign-in page offers «Sign in with Keycloak» (ticket 02): on, with an issuer and
     * a client id. Read from the row alone, for every `/api/auth/session`; a missing secret shows
     * when the flow starts.
     */
    readonly keycloakOffered: Effect.Effect<boolean, SignInSettingsStorageError>;
    /**
     * Internal (ticket 05): the Owner's group mappings as a sign-in applies them, each with
     * whether it is enabled (the Owner is the Organization's Steward) and whether its
     * Organization is archived. No door.
     */
    readonly groupMappings: Effect.Effect<
      ReadonlyArray<GroupSync.GroupMapping>,
      SignInSettingsStorageError
    >;
  }
>()("t3/auth/SignInSettings") {}

/**
 * The Owner may map a group into Organization `s` only as its Steward (ADR 0008), never as a
 * Member: the Owner holds no Memberships. Steward is its creator; NULL counts as the Owner only
 * because those are single-user-era Organizations (migration 138). plans-and-limits 02 moves this
 * to `spaces.steward_user_id`.
 */
const OWNER_MAY_MAP = `(o.user_id IS NOT NULL AND (
    s.created_by_user_id IS NULL OR s.created_by_user_id = o.user_id
  ))`;

const MAPPING_ELSEWHERE =
  "You can map a group only into an Organization you're the Steward of, and not an archived one.";

interface Row {
  readonly registrationMode: RegistrationMode;
  readonly localSignInForMembers: number;
  readonly keycloakEnabled: number;
  readonly issuer: string | null;
  readonly clientId: string | null;
  readonly secretUpdatedAt: string | null;
  readonly groupsClaim: string;
  readonly strongAcr: string;
  readonly strongAmr: string;
  readonly updatedAt: string | null;
}

/** The settings as one value, to merge a change onto and compare. */
interface Settings {
  readonly registrationMode: RegistrationMode;
  readonly localSignInForMembers: boolean;
  readonly keycloakEnabled: boolean;
  readonly issuer: string | null;
  readonly clientId: string | null;
  readonly groupsClaim: string;
  readonly strongAcr: ReadonlyArray<string>;
  readonly strongAmr: ReadonlyArray<string>;
}

const ListJson = Schema.fromJsonString(Schema.Array(Schema.String));
const decodeList = Schema.decodeUnknownOption(ListJson);
const encodeList = Schema.encodeSync(ListJson);
const listOf = (json: string) => Option.getOrElse(decodeList(json), () => []);

const settingsOf = (row: Row): Settings => ({
  registrationMode: row.registrationMode,
  localSignInForMembers: row.localSignInForMembers === 1,
  keycloakEnabled: row.keycloakEnabled === 1,
  issuer: row.issuer,
  clientId: row.clientId,
  groupsClaim: row.groupsClaim,
  strongAcr: listOf(row.strongAcr),
  strongAmr: listOf(row.strongAmr),
});

/** The most mapping changes one `signIn.settings.update` entry names; the rest are counted. */
const MAX_AUDITED_MAPPING_CHANGES = 20;

const mappingKey = (mapping: { readonly group: string; readonly spaceId: string }) =>
  `${mapping.group}\u0000${mapping.spaceId}`;

const sameList = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

// Printable text only: a pasted value with a control character is a paste gone wrong.
const hasControl = (value: string) => [...value].some((char) => char < " " || char === "\u007f");

const invalid = (message: string) => new SignInSettingsInvalidError({ message });

/** A trimmed, non-empty, printable value; `undefined` when left out. */
const textOf = (value: string | undefined, empty: string) => {
  if (value === undefined) return Effect.undefined;
  const trimmed = value.trim();
  if (trimmed === "") return Effect.fail(invalid(empty));
  if (hasControl(trimmed))
    return Effect.fail(invalid(`${empty} It has a character that can't be typed.`));
  return Effect.succeed(trimmed);
};

const listFrom = (values: ReadonlyArray<string> | undefined, what: string) => {
  if (values === undefined) return Effect.undefined;
  const trimmed = [...new Set(values.map((value) => value.trim()))];
  if (trimmed.some((value) => value === "" || hasControl(value))) {
    return Effect.fail(invalid(`Each ${what} value must be a word, without blanks.`));
  }
  return Effect.succeed(trimmed);
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const spaces = yield* SpaceDirectory.SpaceDirectory;
  const audit = yield* AuditLog.AuditLog;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const keycloak = yield* KeycloakClient.KeycloakClient;
  const config = yield* ServerConfig.ServerConfig;
  const identities = yield* UserIdentities.UserIdentities;
  const userDirectory = yield* UserDirectory.UserDirectory;
  // One change at a time: two tabs of the Owner's never interleave a row and a secret.
  const changing = yield* Semaphore.make(1);

  const storage = (cause: unknown) => new SignInSettingsStorageError({ cause });

  const requireOwner = Effect.fn("SignInSettings.requireOwner")(function* (actor: UserId) {
    const principal = yield* spaces.principalOf(actor).pipe(Effect.mapError(storage));
    const decision = AccessPolicy.decide(
      principal,
      "signInSettings.manage",
      AccessPolicy.installation,
    );
    if (!AccessPolicy.isAllowed(decision)) return yield* new SignInSettingsDeniedError();
  });

  const readRow = sql<Row>`
    SELECT registration_mode AS "registrationMode",
      local_sign_in_for_members AS "localSignInForMembers",
      keycloak_enabled AS "keycloakEnabled", keycloak_issuer AS "issuer",
      keycloak_client_id AS "clientId",
      keycloak_client_secret_updated_at AS "secretUpdatedAt",
      keycloak_groups_claim AS "groupsClaim", strong_acr_json AS "strongAcr",
      strong_amr_json AS "strongAmr", updated_at AS "updatedAt"
    FROM sign_in_settings WHERE id = 1
  `.pipe(
    Effect.mapError(storage),
    Effect.flatMap((rows) =>
      rows[0] === undefined
        ? Effect.fail(storage(new Error("sign_in_settings has no row")))
        : Effect.succeed(rows[0]),
    ),
  );

  /** The secret, if the store holds one. Never leaves this module but through `keycloakConfig`. */
  const storedSecret = secrets
    .get(CLIENT_SECRET_NAME)
    .pipe(
      Effect.map(Option.map((bytes) => Redacted.make(new TextDecoder().decode(bytes)))),
      Effect.mapError(storage),
    );

  /** The mappings with their Organization's name, whether they apply and whether it is archived. */
  const readMappings = sql<{
    readonly group: string;
    readonly spaceId: SpaceId;
    readonly organizationName: string;
    readonly role: SpaceRole;
    readonly enabled: number;
    readonly archived: number;
  }>`
    SELECT m.group_name AS "group", m.space_id AS "spaceId", s.name AS "organizationName",
      m.role AS role, ${sql.literal(OWNER_MAY_MAP)} AS enabled,
      s.archived_at IS NOT NULL AS archived
    FROM keycloak_group_mappings AS m JOIN spaces AS s ON s.space_id = m.space_id
    LEFT JOIN users AS o ON o.is_owner = 1
    ORDER BY m.group_name, s.name COLLATE NOCASE, m.space_id
  `.pipe(
    Effect.mapError(storage),
    Effect.map((rows) =>
      rows.map((row): KeycloakGroupMapping => ({
        group: row.group,
        spaceId: row.spaceId,
        organizationName: row.organizationName,
        role: row.role,
        enabled: row.enabled === 1,
        archived: row.archived === 1,
      })),
    ),
  );

  /** Where a new mapping may point: the Organizations, not archived, the Owner may map into. */
  const readMappable = sql<MappableOrganization>`
    SELECT s.space_id AS "spaceId", s.name AS name
    FROM spaces AS s LEFT JOIN users AS o ON o.is_owner = 1
    WHERE s.kind = 'organization' AND s.archived_at IS NULL AND ${sql.literal(OWNER_MAY_MAP)}
    ORDER BY s.name COLLATE NOCASE, s.space_id
  `.pipe(Effect.mapError(storage));

  /** The mappings a change asks for: groups trimmed, without a leading `/`, each pair once. */
  const mappingsFrom = Effect.fn("SignInSettings.mappingsFrom")(function* (
    mappings: UpdateSignInSettingsRequest["groupMappings"],
  ) {
    if (mappings === undefined) return undefined;
    const seen = new Set<string>();
    const kept: Array<{ group: string; spaceId: SpaceId; role: SpaceRole }> = [];
    for (const mapping of mappings) {
      const group = GroupSync.normalizeGroup(mapping.group.trim());
      if (group === "") return yield* invalid("Enter the group of each mapping.");
      if (hasControl(group)) {
        return yield* invalid("A mapping's group has a character that can't be typed.");
      }
      if (group.length > MAX_GROUP_LENGTH) {
        return yield* invalid(`A group name has at most ${MAX_GROUP_LENGTH} characters.`);
      }
      const key = mappingKey({ group, spaceId: mapping.spaceId });
      if (seen.has(key)) {
        return yield* invalid(`The group ${group} is mapped to the same Organization twice.`);
      }
      seen.add(key);
      kept.push({ group, spaceId: mapping.spaceId, role: mapping.role });
    }
    return kept;
  });

  /**
   * Inside the settings' transaction: a managed Membership in an Organization left without an
   * enabled mapping becomes manual, its Role kept, so it never stays where nobody may change it.
   * Archived Organizations are left as they are. Returns whose Memberships changed.
   */
  const releaseUnmapped = Effect.fn("SignInSettings.releaseUnmapped")(function* (
    actor: UserId,
    spaceIds: ReadonlyArray<SpaceId>,
  ) {
    const remaining = yield* readMappings;
    const users: Array<UserId> = [];
    for (const spaceId of new Set(spaceIds)) {
      if (remaining.some((mapping) => mapping.spaceId === spaceId && mapping.enabled)) continue;
      const managed = yield* sql<{
        readonly userId: UserId;
        readonly role: SpaceRole;
        readonly group: string | null;
      }>`
        SELECT m.user_id AS "userId", m.role AS role, m.keycloak_group AS "group"
        FROM space_memberships AS m JOIN spaces AS s ON s.space_id = m.space_id
        WHERE m.space_id = ${spaceId} AND m.managed_by_keycloak = 1 AND s.archived_at IS NULL
      `.pipe(Effect.mapError(storage));
      for (const membership of managed) {
        yield* spaces
          .setKeycloakManaged({ spaceId, userId: membership.userId, keycloakGroup: null })
          .pipe(Effect.mapError(storage));
        yield* audit
          .record({
            actor: AuditLog.userActor(actor),
            action: "membership.changeRole",
            spaceId,
            target: { kind: "user", id: membership.userId },
            detail: {
              from: membership.role,
              to: membership.role,
              managed: "manual",
              ...(membership.group === null ? {} : { keycloakGroup: membership.group }),
            },
          })
          .pipe(Effect.mapError(storage));
        users.push(membership.userId);
      }
    }
    return users;
  });

  /**
   * In the settings' transaction: lowers the managed Memberships a lowered mapping made to its
   * new Role, never raises one. Another group of theirs may restore a higher Role at their next
   * sign-in. Returns whose Memberships changed.
   */
  const lowerToMappingRole = Effect.fn("SignInSettings.lowerToMappingRole")(function* (
    lowered: ReadonlyArray<{
      readonly group: string;
      readonly spaceId: SpaceId;
      readonly role: SpaceRole;
    }>,
  ) {
    const users: Array<UserId> = [];
    for (const mapping of lowered) {
      const managed = yield* sql<{ readonly userId: UserId; readonly role: SpaceRole }>`
        SELECT m.user_id AS "userId", m.role AS role
        FROM space_memberships AS m JOIN spaces AS s ON s.space_id = m.space_id
        WHERE m.space_id = ${mapping.spaceId} AND m.managed_by_keycloak = 1
          AND m.keycloak_group = ${mapping.group} AND s.archived_at IS NULL
        ORDER BY m.user_id
      `;
      for (const membership of managed) {
        if (GroupSync.RANK[membership.role] <= GroupSync.RANK[mapping.role]) continue;
        yield* spaces.setRole({
          spaceId: mapping.spaceId,
          userId: membership.userId,
          role: mapping.role,
        });
        yield* audit.record({
          actor: { source: "system" },
          action: "membership.changeRole",
          spaceId: mapping.spaceId,
          target: { kind: "user", id: membership.userId },
          detail: { from: membership.role, to: mapping.role, keycloakGroup: mapping.group },
        });
        users.push(membership.userId);
      }
    }
    return users;
  }, Effect.mapError(storage));

  const viewOf = Effect.fn("SignInSettings.viewOf")(function* (row: Row) {
    const settings = settingsOf(row);
    // Whether a secret is saved is the store's answer, not the row's: a secret that could not be
    // stored after its row was saved (see `update`) reads as missing, never as saved.
    const secretSet = Option.isSome(yield* storedSecret);
    return {
      groupMappings: yield* readMappings,
      mappableOrganizations: yield* readMappable,
      registrationMode: settings.registrationMode,
      localSignInForMembers: settings.localSignInForMembers,
      keycloak: {
        enabled: settings.keycloakEnabled,
        issuer: settings.issuer,
        clientId: settings.clientId,
        clientSecretSet: secretSet,
        clientSecretUpdatedAt: secretSet ? row.secretUpdatedAt : null,
        groupsClaim: settings.groupsClaim,
        strongAcr: settings.strongAcr,
        strongAmr: settings.strongAmr,
      },
      publicOrigin: config.publicUrl?.origin ?? null,
      updatedAt: row.updatedAt,
    } satisfies SignInSettingsView;
  });

  /**
   * What the lists `next` make of the live Keycloak sign-ins: which turn strong, which turn weak,
   * and which of those end (the Owner's and Admins', who need a strong one).
   */
  const strengthPlan = Effect.fn("SignInSettings.strengthPlan")(function* (
    next: KeycloakAdmission.StrongLists,
  ) {
    const live = yield* identities.liveLogins().pipe(Effect.mapError(storage));
    const toStrong: Array<string> = [];
    const toWeak: Array<string> = [];
    const toEnd: Array<string> = [];
    /** Whose weak access ends: the Owner's and Admins' with a sign-in that turns (or is) weak. */
    const users = new Set<UserId>();
    for (const login of live) {
      const strong = KeycloakAdmission.loginIsStrong(login, next);
      if (strong && !login.strong) toStrong.push(login.loginId);
      if (!strong && login.strong) toWeak.push(login.loginId);
      if (!strong && login.requiresStrong) {
        toEnd.push(login.loginId);
        users.add(login.userId);
      }
    }
    return { toStrong, toWeak, toEnd, users: [...users] };
  });

  const read: SignInSettings["Service"]["read"] = Effect.fn("SignInSettings.read")(
    function* (actor) {
      yield* requireOwner(actor);
      return yield* viewOf(yield* readRow);
    },
  );

  const update: SignInSettings["Service"]["update"] = Effect.fn("SignInSettings.update")(
    function* (actor, request) {
      yield* requireOwner(actor);
      return yield* changing.withPermits(1)(
        Effect.gen(function* () {
          const row = yield* readRow;
          const was = settingsOf(row);

          const issuerText = yield* textOf(request.issuer, "Enter the realm's issuer address.");
          const issuer =
            issuerText === undefined ? undefined : KeycloakClient.normalizeIssuer(issuerText);
          if (issuerText !== undefined && issuer === undefined) {
            return yield* invalid(KeycloakClient.INVALID_ISSUER_MESSAGE);
          }
          const clientId = yield* textOf(request.clientId, "Enter the client id.");
          const groupsClaim = yield* textOf(request.groupsClaim, "Enter the groups claim.");
          const strongAcr = yield* listFrom(request.strongAcr, "acr");
          const strongAmr = yield* listFrom(request.strongAmr, "amr");
          // Ticket 05: the whole list of mappings, against the saved one. A mapping kept as it is
          // stays even if the Owner may no longer make it (it is disabled); a new one, or a new
          // Role for one, must point where the Owner is the Steward.
          const nextMappings = yield* mappingsFrom(request.groupMappings);
          let mappingsAdded: ReadonlyArray<{ group: string; spaceId: SpaceId; role: SpaceRole }> =
            [];
          let mappingsRemoved: ReadonlyArray<KeycloakGroupMapping> = [];
          let mappingsLowered: ReadonlyArray<{ group: string; spaceId: SpaceId; role: SpaceRole }> =
            [];
          let mappingChanges = "";
          let mappingChangesTruncated = false;
          if (nextMappings !== undefined) {
            const saved = yield* readMappings;
            const savedByKey = new Map(saved.map((mapping) => [mappingKey(mapping), mapping]));
            const nextByKey = new Map(
              nextMappings.map((mapping) => [mappingKey(mapping), mapping]),
            );
            mappingsRemoved = saved.filter(
              (mapping) => nextByKey.get(mappingKey(mapping))?.role !== mapping.role,
            );
            mappingsAdded = nextMappings.filter(
              (mapping) => savedByKey.get(mappingKey(mapping))?.role !== mapping.role,
            );
            // Which mappings changed, for the audit: a new Role for a pair is one «role» line, not
            // an add and a remove. Bounded, so a huge save can't bloat the row.
            const lines: Array<string> = [];
            for (const mapping of nextMappings) {
              const was = savedByKey.get(mappingKey(mapping));
              if (was === undefined) {
                lines.push(`added ${mapping.group} ${mapping.spaceId} ${mapping.role}`);
              }
            }
            const lowered: Array<{ group: string; spaceId: SpaceId; role: SpaceRole }> = [];
            for (const mapping of nextMappings) {
              const was = savedByKey.get(mappingKey(mapping));
              if (was === undefined || was.role === mapping.role) continue;
              lines.push(`role ${mapping.group} ${mapping.spaceId} ${was.role} -> ${mapping.role}`);
              if (GroupSync.RANK[mapping.role] < GroupSync.RANK[was.role]) lowered.push(mapping);
            }
            for (const mapping of saved) {
              if (!nextByKey.has(mappingKey(mapping))) {
                lines.push(`removed ${mapping.group} ${mapping.spaceId} ${mapping.role}`);
              }
            }
            mappingsLowered = lowered;
            mappingChangesTruncated = lines.length > MAX_AUDITED_MAPPING_CHANGES;
            mappingChanges = lines.slice(0, MAX_AUDITED_MAPPING_CHANGES).join("; ");
            if (mappingsAdded.length > 0) {
              const mappable = new Set(
                (yield* readMappable).map((organization) => organization.spaceId),
              );
              if (mappingsAdded.some((mapping) => !mappable.has(mapping.spaceId))) {
                return yield* invalid(MAPPING_ELSEWHERE);
              }
            }
          }
          const mappingsChanged = mappingsAdded.length > 0 || mappingsRemoved.length > 0;
          const secret =
            request.clientSecret === undefined ? undefined : Redacted.value(request.clientSecret);
          if (secret !== undefined) {
            if (secret.trim() === "") return yield* invalid("Enter the client secret.");
            if (secret.trim() !== secret) {
              return yield* invalid(
                "The client secret starts or ends with a space. Paste it again without it.",
              );
            }
            if (hasControl(secret)) {
              return yield* invalid("The client secret has a character that can't be typed.");
            }
          }

          const keycloakEnabled = request.keycloakEnabled ?? was.keycloakEnabled;
          let localSignInForMembers = request.localSignInForMembers ?? was.localSignInForMembers;
          if (!keycloakEnabled && !localSignInForMembers) {
            // Without Keycloak, local sign-in is the only way in: turning Keycloak off brings it
            // back; asking for both off is refused.
            if (request.localSignInForMembers === false) {
              return yield* invalid(
                "Turn Keycloak on before turning off local sign-in for everyone but you.",
              );
            }
            localSignInForMembers = true;
          }
          const next: Settings = {
            registrationMode: request.registrationMode ?? was.registrationMode,
            localSignInForMembers,
            keycloakEnabled,
            issuer: issuer ?? was.issuer,
            clientId: clientId ?? was.clientId,
            groupsClaim: groupsClaim ?? was.groupsClaim,
            strongAcr: strongAcr ?? was.strongAcr,
            strongAmr: strongAmr ?? was.strongAmr,
          };

          if (next.keycloakEnabled) {
            const hasSecret = secret !== undefined || Option.isSome(yield* storedSecret);
            if (next.issuer === null || next.clientId === null || !hasSecret) {
              return yield* invalid(
                "Keycloak needs its issuer, client id and client secret before it can be turned on.",
              );
            }
            // «Keycloak active» never turns on, nor moves to another realm, past a failing Check.
            if (!was.keycloakEnabled || next.issuer !== was.issuer) {
              const checked = yield* keycloak.check(next.issuer);
              if (checked._tag === "failed") {
                return yield* invalid(`Check failed, so nothing was saved. ${checked.message}`);
              }
            }
          }

          const changed = [
            ...(next.registrationMode !== was.registrationMode ? ["registrationMode"] : []),
            ...(next.localSignInForMembers !== was.localSignInForMembers
              ? ["localSignInForMembers"]
              : []),
            ...(next.keycloakEnabled !== was.keycloakEnabled ? ["keycloakEnabled"] : []),
            ...(next.issuer !== was.issuer ? ["issuer"] : []),
            ...(next.clientId !== was.clientId ? ["clientId"] : []),
            ...(secret !== undefined ? ["clientSecret"] : []),
            ...(next.groupsClaim !== was.groupsClaim ? ["groupsClaim"] : []),
            ...(mappingsChanged ? ["groupMappings"] : []),
            ...(!sameList(next.strongAcr, was.strongAcr) ? ["strongAcr"] : []),
            ...(!sameList(next.strongAmr, was.strongAmr) ? ["strongAmr"] : []),
          ];
          if (changed.length === 0) return yield* viewOf(row);

          const listsChanged = changed.includes("strongAcr") || changed.includes("strongAmr");
          // A dry run first: the Owner sees how many sign-ins the change ends before it does.
          if (listsChanged && request.endLoginsConfirmed !== true) {
            const planned = yield* strengthPlan(next);
            if (planned.toEnd.length > 0) {
              // The Owner's sessions without a sign-in are their local ones, and stay.
              const admins: Array<UserId> = [];
              for (const userId of planned.users) {
                const principal = yield* spaces.principalOf(userId).pipe(Effect.mapError(storage));
                if (!principal.isOwner) admins.push(userId);
              }
              const otherAccessToEnd = yield* identities
                .unboundAccessCount(admins, DateTime.formatIso(yield* DateTime.now))
                .pipe(Effect.mapError(storage));
              return yield* new SignInSettingsConfirmError({
                loginsToEnd: planned.toEnd.length,
                otherAccessToEnd,
              });
            }
          }

          const now = DateTime.formatIso(yield* DateTime.now);
          const closeSockets = yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* sql`
                  UPDATE sign_in_settings SET
                    registration_mode = ${next.registrationMode},
                    local_sign_in_for_members = ${next.localSignInForMembers ? 1 : 0},
                    keycloak_enabled = ${next.keycloakEnabled ? 1 : 0},
                    keycloak_issuer = ${next.issuer},
                    keycloak_client_id = ${next.clientId},
                    keycloak_client_secret_updated_at = ${
                      secret === undefined ? row.secretUpdatedAt : now
                    },
                    keycloak_groups_claim = ${next.groupsClaim},
                    strong_acr_json = ${encodeList(next.strongAcr)},
                    strong_amr_json = ${encodeList(next.strongAmr)},
                    updated_at = ${now},
                    updated_by = ${actor}
                  WHERE id = 1
                `;
                // Read again inside the transaction: a sign-in that arrived since the dry run is
                // weighed too. A Member's sign-in is only re-marked: it matters if they become
                // an Admin, which ends it then if it is weak.
                let ended = 0;
                const closes: Array<Effect.Effect<void>> = [];
                if (listsChanged) {
                  const plan = yield* strengthPlan(next);
                  yield* identities.setStrength(plan.toStrong, true);
                  yield* identities.setStrength(plan.toWeak, false);
                  // As a promotion does: their weak sign-ins, and the apps, MCP clients and
                  // pairing links no sign-in vouches for, end with their sessions.
                  for (const userId of plan.users) {
                    const done = yield* userDirectory.endWeakKeycloakLogins(userId);
                    ended += done.ended;
                    closes.push(done.afterCommit);
                  }
                }
                let released: ReadonlyArray<UserId> = [];
                if (mappingsChanged) {
                  for (const mapping of mappingsRemoved) {
                    yield* sql`
                      DELETE FROM keycloak_group_mappings
                      WHERE group_name = ${mapping.group} AND space_id = ${mapping.spaceId}
                    `;
                  }
                  for (const mapping of mappingsAdded) {
                    yield* sql`
                      INSERT INTO keycloak_group_mappings
                        (group_name, space_id, role, created_at, created_by)
                      VALUES (${mapping.group}, ${mapping.spaceId}, ${mapping.role}, ${now},
                        ${actor})
                    `;
                  }
                  const lowered = yield* lowerToMappingRole(mappingsLowered);
                  if (lowered.length > 0) closes.push(spaces.membershipsChanged(lowered));
                  released = yield* releaseUnmapped(
                    actor,
                    mappingsRemoved.map((mapping) => mapping.spaceId),
                  );
                }
                if (released.length > 0) closes.push(spaces.membershipsChanged(released));
                const close = Effect.all(closes, { discard: true });
                yield* audit.record({
                  actor: AuditLog.userActor(actor),
                  action: "signIn.settings.update",
                  target: { kind: "sign_in_settings", id: "sign-in", name: "Sign-in settings" },
                  detail: {
                    changed: changed.join(", "),
                    registrationMode: next.registrationMode,
                    keycloakEnabled: next.keycloakEnabled,
                    localSignInForMembers: next.localSignInForMembers,
                    issuer: next.issuer,
                    secretReplaced: secret !== undefined,
                    ...(next.groupsClaim !== was.groupsClaim
                      ? { groupsClaim: next.groupsClaim }
                      : {}),
                    ...(mappingsChanged
                      ? {
                          mappingsAdded: mappingsAdded.length,
                          mappingsRemoved: mappingsRemoved.length,
                          mappingChanges,
                          mappingChangesTruncated,
                        }
                      : {}),
                    ...(listsChanged
                      ? {
                          strongAcr: next.strongAcr.join(" "),
                          strongAmr: next.strongAmr.join(" "),
                          loginsEnded: ended,
                        }
                      : {}),
                  },
                });
                return close;
              }),
            )
            .pipe(Effect.mapError(storage));
          // Once committed: the ended sign-ins' sessions lose their sockets.
          yield* closeSockets;

          // After the commit, never before: a secret the audit log never recorded is the worse
          // mismatch. If this write fails the row says «replaced» but the store keeps the old one
          // (or none): the Owner is told to enter it again, and reads follow the store, so a
          // missing secret reads as missing and Keycloak can't turn on without one.
          if (secret !== undefined) {
            yield* secrets.set(CLIENT_SECRET_NAME, new TextEncoder().encode(secret)).pipe(
              Effect.tapError((error) =>
                Effect.logError("SignInSettings: could not store the Keycloak client secret", {
                  errorTag: error._tag,
                }),
              ),
              Effect.mapError((error) => new SignInSecretNotStoredError({ cause: error._tag })),
            );
          }
          return yield* viewOf(yield* readRow);
        }),
      );
    },
  );

  const check: SignInSettings["Service"]["check"] = Effect.fn("SignInSettings.check")(
    function* (actor) {
      yield* requireOwner(actor);
      const row = yield* readRow;
      if (row.issuer === null) {
        return {
          _tag: "failed",
          step: "issuer",
          reason: "not-configured",
          message: "Save the realm's issuer address first.",
        } as const;
      }
      return yield* keycloak.check(row.issuer);
    },
  );

  const keycloakConfig: SignInSettings["Service"]["keycloakConfig"] = Effect.gen(function* () {
    const settings = settingsOf(yield* readRow);
    if (!settings.keycloakEnabled || settings.issuer === null || settings.clientId === null) {
      return Option.none();
    }
    const { issuer, clientId } = settings;
    return Option.map(yield* storedSecret, (clientSecret) => ({
      issuer,
      clientId,
      clientSecret,
      registrationMode: settings.registrationMode,
      groupsClaim: settings.groupsClaim,
      strongAcr: settings.strongAcr,
      strongAmr: settings.strongAmr,
    }));
  }).pipe(Effect.withSpan("SignInSettings.keycloakConfig"));

  const keycloakOffered: SignInSettings["Service"]["keycloakOffered"] = readRow.pipe(
    Effect.map((row) => row.keycloakEnabled === 1 && row.issuer !== null && row.clientId !== null),
    Effect.withSpan("SignInSettings.keycloakOffered"),
  );

  const groupMappings: SignInSettings["Service"]["groupMappings"] = readMappings.pipe(
    Effect.map((mappings) =>
      mappings.map((mapping): GroupSync.GroupMapping => ({
        group: mapping.group,
        spaceId: mapping.spaceId,
        role: mapping.role,
        enabled: mapping.enabled,
        archived: mapping.archived,
      })),
    ),
    Effect.withSpan("SignInSettings.groupMappings"),
  );

  return SignInSettings.of({
    read,
    update,
    check,
    keycloakConfig,
    keycloakOffered,
    groupMappings,
  });
});

export const layer = Layer.effect(SignInSettings, make);
