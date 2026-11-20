/**
 * The Platform's sign-in settings (Keycloak sign-in spec, ticket 01): the Owner's alone, audited.
 * The client secret is write-only (`keycloak-client-secret`, read back only by `keycloakConfig`).
 * A strong-list change (ticket 06) ends the Owner's and Admins' sign-ins it makes weak, confirmed.
 */
import type {
  KeycloakCheckResult,
  RegistrationMode,
  SignInSettings as SignInSettingsView,
  UpdateSignInSettingsRequest,
  UserId,
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
  }
>()("t3/auth/SignInSettings") {}

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

  const viewOf = Effect.fn("SignInSettings.viewOf")(function* (row: Row) {
    const settings = settingsOf(row);
    // Whether a secret is saved is the store's answer, not the row's: a secret that could not be
    // stored after its row was saved (see `update`) reads as missing, never as saved.
    const secretSet = Option.isSome(yield* storedSecret);
    return {
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

  return SignInSettings.of({ read, update, check, keycloakConfig, keycloakOffered });
});

export const layer = Layer.effect(SignInSettings, make);
