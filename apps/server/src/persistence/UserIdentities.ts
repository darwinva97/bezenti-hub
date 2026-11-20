/**
 * Who a User is in Keycloak and each sign-in through it (Keycloak sign-in spec, ticket 02;
 * migration 152). The identity is the issuer and subject; user name and email are labels. Rows
 * only: the rules (who may link, what a link removes) are `KeycloakSignIn`'s and `UserDirectory`'s.
 */
import type { UserId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlError from "effect/sql/SqlError";
import * as SqlClient from "effect/sql/SqlClient";

export interface LinkedIdentity {
  readonly userId: UserId;
  readonly issuer: string;
  readonly subject: string;
  readonly username: string | null;
  readonly email: string | null;
}

export interface NewIdentityLogin {
  readonly loginId: string;
  readonly userId: UserId;
  readonly issuer: string;
  readonly subject: string;
  /** Keycloak's SSO session (`sid`), for back-channel logout (ticket 07). */
  readonly keycloakSid: string | null;
  /** The refresh token, sealed with the login's id as associated data; null when none came. */
  readonly refreshTokenSealed: string | null;
  /** The ID token, sealed likewise (ticket 07: «also sign out of Keycloak»'s `id_token_hint`). */
  readonly idTokenSealed: string | null;
  readonly offline: boolean;
  /** Whether it counts as a strong factor (ticket 06), and the `acr`/`amr` that said so. */
  readonly strong: boolean;
  readonly acr: string | null;
  readonly amr: ReadonlyArray<string>;
  readonly now: string;
}

/** A Keycloak sign-in that has not ended, with what its ID token said about the factor. */
export interface LiveLogin {
  readonly loginId: string;
  readonly userId: UserId;
  readonly strong: boolean;
  readonly acr: string | null;
  readonly amr: ReadonlyArray<string>;
  /** The User is the Owner or an Admin of some Organization: they need a strong sign-in. */
  readonly requiresStrong: boolean;
}

/** What a re-check reads of a sign-in (ticket 07). Sealed values only, never a token. */
export interface LoginForRefresh {
  readonly loginId: string;
  readonly userId: UserId;
  readonly issuer: string;
  readonly subject: string;
  readonly keycloakSid: string | null;
  readonly refreshTokenSealed: string | null;
  readonly checkedAt: string;
  readonly ended: boolean;
}

/** A sign-in that just ended, and whose it was (ticket 07: for the audit entry). */
export interface EndedLogin {
  readonly loginId: string;
  readonly userId: UserId;
}

export class UserIdentities extends Context.Service<
  UserIdentities,
  {
    readonly findByUser: (
      userId: UserId,
    ) => Effect.Effect<Option.Option<LinkedIdentity>, SqlError.SqlError>;
    readonly findBySubject: (
      issuer: string,
      subject: string,
    ) => Effect.Effect<Option.Option<LinkedIdentity>, SqlError.SqlError>;
    /** Links an identity to a User without one; false when either is already linked. */
    readonly link: (input: {
      readonly userId: UserId;
      readonly issuer: string;
      readonly subject: string;
      readonly username: string | null;
      readonly email: string | null;
      readonly now: string;
    }) => Effect.Effect<boolean, SqlError.SqlError>;
    /** The labels as Keycloak sent them in this sign-in. */
    readonly updateLabels: (input: {
      readonly userId: UserId;
      readonly username: string | null;
      readonly email: string | null;
      readonly now: string;
    }) => Effect.Effect<void, SqlError.SqlError>;
    readonly insertLogin: (input: NewIdentityLogin) => Effect.Effect<void, SqlError.SqlError>;
    /** Every Keycloak sign-in that has not ended (ticket 06: the lists changed). */
    readonly liveLogins: () => Effect.Effect<ReadonlyArray<LiveLogin>, SqlError.SqlError>;
    /** Marks live sign-ins strong or not, as the Owner's lists now say. */
    readonly setStrength: (
      loginIds: ReadonlyArray<string>,
      strong: boolean,
    ) => Effect.Effect<void, SqlError.SqlError>;
    /**
     * Ends a User's live sign-ins that are not strong (ticket 06: they became an Admin); their
     * ids, for the sessions born of them. Run it in the promotion's transaction.
     */
    readonly endWeakLogins: (
      userId: UserId,
      now: string,
    ) => Effect.Effect<ReadonlyArray<string>, SqlError.SqlError>;
    /**
     * Whether the Keycloak sign-in a session was born of is live and strong; none when the session
     * comes from no Keycloak sign-in (ticket 06: may this session make its User an Admin).
     */
    readonly sessionLoginStrong: (
      sessionId: string,
    ) => Effect.Effect<Option.Option<boolean>, SqlError.SqlError>;
    /**
     * How many live sessions born of no Keycloak sign-in and unspent pairing links these Users
     * hold: what ending their weak access also ends (the confirmation's count).
     */
    readonly unboundAccessCount: (
      userIds: ReadonlyArray<UserId>,
      now: string,
    ) => Effect.Effect<number, SqlError.SqlError>;
    /** Ends these live sign-ins, dropping their sealed tokens; the ones it ended. */
    readonly endLogins: (
      loginIds: ReadonlyArray<string>,
      now: string,
    ) => Effect.Effect<ReadonlyArray<EndedLogin>, SqlError.SqlError>;
    /** Ticket 07: a sign-in as a re-check reads it. */
    readonly loginForRefresh: (
      loginId: string,
    ) => Effect.Effect<Option.Option<LoginForRefresh>, SqlError.SqlError>;
    /**
     * Ticket 07: a good re-check, on a live sign-in only: `checked_at`, the new sealed refresh token
     * (the old one kept when Keycloak sent none) and ID token. False when it ended meanwhile.
     */
    readonly saveRefresh: (input: {
      readonly loginId: string;
      readonly refreshTokenSealed: string | null;
      readonly idTokenSealed: string;
      readonly now: string;
    }) => Effect.Effect<boolean, SqlError.SqlError>;
    /** Ticket 07: the sealed ID token of a live sign-in, for `id_token_hint`. */
    readonly sealedIdToken: (
      loginId: string,
    ) => Effect.Effect<Option.Option<string>, SqlError.SqlError>;
    /**
     * Ticket 07, back-channel logout: the live sign-ins of Keycloak's SSO session `sid` (of
     * `subject` when given), or without `sid` every live one of the identity.
     */
    readonly liveLoginsFor: (input: {
      readonly issuer: string;
      readonly sid: string | undefined;
      readonly subject: string | undefined;
    }) => Effect.Effect<ReadonlyArray<string>, SqlError.SqlError>;
    /** Ticket 07: whether the newest Keycloak sign-in got `offline_access`; none before any. */
    readonly newestLoginOffline: () => Effect.Effect<Option.Option<boolean>, SqlError.SqlError>;
    /**
     * Ends a User's link (a reset link replaces every way in): the identity goes, and their
     * Keycloak sign-ins end. True when there was one.
     */
    readonly unlink: (userId: UserId, now: string) => Effect.Effect<boolean, SqlError.SqlError>;
  }
>()("t3/persistence/UserIdentities") {}

interface Row {
  readonly userId: UserId;
  readonly issuer: string;
  readonly subject: string;
  readonly username: string | null;
  readonly email: string | null;
}

const AmrJson = Schema.fromJsonString(Schema.Array(Schema.String));
const encodeAmr = Schema.encodeSync(AmrJson);
const decodeAmr = Schema.decodeUnknownOption(AmrJson);
/** A stored `amr` list; anything but an array of strings reads as empty (never strong). */
const amrOf = (json: string): ReadonlyArray<string> => Option.getOrElse(decodeAmr(json), () => []);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const first = (rows: ReadonlyArray<Row>) => Option.fromUndefinedOr(rows[0]);

  const findByUser: UserIdentities["Service"]["findByUser"] = Effect.fn(
    "UserIdentities.findByUser",
  )(function* (userId) {
    return first(
      yield* sql<Row>`
        SELECT user_id AS "userId", issuer, subject, username, email
        FROM user_identities WHERE user_id = ${userId}
      `,
    );
  });

  const findBySubject: UserIdentities["Service"]["findBySubject"] = Effect.fn(
    "UserIdentities.findBySubject",
  )(function* (issuer, subject) {
    return first(
      yield* sql<Row>`
        SELECT user_id AS "userId", issuer, subject, username, email
        FROM user_identities WHERE issuer = ${issuer} AND subject = ${subject}
      `,
    );
  });

  const link: UserIdentities["Service"]["link"] = Effect.fn("UserIdentities.link")(
    function* (input) {
      const rows = yield* sql<{ readonly userId: string }>`
        INSERT INTO user_identities (
          user_id, issuer, subject, username, email, linked_at, updated_at
        )
        VALUES (
          ${input.userId}, ${input.issuer}, ${input.subject}, ${input.username}, ${input.email},
          ${input.now}, ${input.now}
        )
        ON CONFLICT DO NOTHING
        RETURNING user_id AS "userId"
      `;
      return rows.length === 1;
    },
  );

  const updateLabels: UserIdentities["Service"]["updateLabels"] = Effect.fn(
    "UserIdentities.updateLabels",
  )(function* (input) {
    yield* sql`
      UPDATE user_identities
      SET username = ${input.username}, email = ${input.email}, updated_at = ${input.now}
      WHERE user_id = ${input.userId}
    `;
  });

  const insertLogin: UserIdentities["Service"]["insertLogin"] = Effect.fn(
    "UserIdentities.insertLogin",
  )(function* (input) {
    yield* sql`
      INSERT INTO identity_logins (
        login_id, user_id, issuer, subject, keycloak_sid, refresh_token_sealed, id_token_sealed,
        strong, offline, acr, amr_json, created_at, checked_at
      )
      VALUES (
        ${input.loginId}, ${input.userId}, ${input.issuer}, ${input.subject},
        ${input.keycloakSid}, ${input.refreshTokenSealed}, ${input.idTokenSealed},
        ${input.strong ? 1 : 0},
        ${input.offline ? 1 : 0}, ${input.acr}, ${encodeAmr(input.amr)},
        ${input.now}, ${input.now}
      )
    `;
  });

  const liveLogins: UserIdentities["Service"]["liveLogins"] = Effect.fn(
    "UserIdentities.liveLogins",
  )(function* () {
    const rows = yield* sql<{
      readonly loginId: string;
      readonly userId: UserId;
      readonly strong: number;
      readonly acr: string | null;
      readonly amrJson: string;
      readonly requiresStrong: number;
    }>`
      SELECT l.login_id AS "loginId", l.user_id AS "userId", l.strong AS strong, l.acr AS acr,
        l.amr_json AS "amrJson",
        (u.is_owner = 1 OR EXISTS (
          SELECT 1 FROM space_memberships AS m
          WHERE m.user_id = l.user_id AND m.role = 'admin'
        )) AS "requiresStrong"
      FROM identity_logins AS l JOIN users AS u ON u.user_id = l.user_id
      WHERE l.ended_at IS NULL
      ORDER BY l.created_at, l.login_id
    `;
    return rows.map((row) => ({
      loginId: row.loginId,
      userId: row.userId,
      strong: row.strong === 1,
      acr: row.acr,
      amr: amrOf(row.amrJson),
      requiresStrong: row.requiresStrong === 1,
    }));
  });

  const setStrength: UserIdentities["Service"]["setStrength"] = Effect.fn(
    "UserIdentities.setStrength",
  )(function* (loginIds, strong) {
    if (loginIds.length === 0) return;
    yield* sql`
      UPDATE identity_logins SET strong = ${strong ? 1 : 0}
      WHERE ended_at IS NULL AND ${sql.in("login_id", loginIds)}
    `;
  });

  const endWeakLogins: UserIdentities["Service"]["endWeakLogins"] = Effect.fn(
    "UserIdentities.endWeakLogins",
  )(function* (userId, now) {
    const rows = yield* sql<{ readonly loginId: string }>`
      UPDATE identity_logins
      SET ended_at = ${now}, refresh_token_sealed = NULL, id_token_sealed = NULL
      WHERE user_id = ${userId} AND ended_at IS NULL AND strong = 0
      RETURNING login_id AS "loginId"
    `;
    return rows.map((row) => row.loginId);
  });

  const sessionLoginStrong: UserIdentities["Service"]["sessionLoginStrong"] = Effect.fn(
    "UserIdentities.sessionLoginStrong",
  )(function* (sessionId) {
    const rows = yield* sql<{ readonly strong: number; readonly live: number }>`
      SELECT l.strong AS strong, (l.ended_at IS NULL) AS live
      FROM auth_sessions AS s JOIN identity_logins AS l ON l.login_id = s.identity_login_id
      WHERE s.session_id = ${sessionId}
    `;
    const row = rows[0];
    return row === undefined ? Option.none() : Option.some(row.live === 1 && row.strong === 1);
  });

  const unboundAccessCount: UserIdentities["Service"]["unboundAccessCount"] = Effect.fn(
    "UserIdentities.unboundAccessCount",
  )(function* (userIds, now) {
    if (userIds.length === 0) return 0;
    const rows = yield* sql<{ readonly count: number }>`
      SELECT
        (SELECT COUNT(*) FROM auth_sessions
          WHERE ${sql.in("user_id", userIds)} AND revoked_at IS NULL
            AND identity_login_id IS NULL AND expires_at > ${now})
        + (SELECT COUNT(*) FROM auth_pairing_links
          WHERE ${sql.in("user_id", userIds)} AND revoked_at IS NULL AND consumed_at IS NULL
            AND identity_login_id IS NULL AND expires_at > ${now}) AS count
    `;
    return rows[0]?.count ?? 0;
  });

  const endLogins: UserIdentities["Service"]["endLogins"] = Effect.fn("UserIdentities.endLogins")(
    function* (loginIds, now) {
      if (loginIds.length === 0) return [];
      const rows = yield* sql<{ readonly loginId: string; readonly userId: UserId }>`
        UPDATE identity_logins
        SET ended_at = ${now}, refresh_token_sealed = NULL, id_token_sealed = NULL
        WHERE ended_at IS NULL AND ${sql.in("login_id", loginIds)}
        RETURNING login_id AS "loginId", user_id AS "userId"
      `;
      return rows.map((row) => ({ loginId: row.loginId, userId: row.userId }));
    },
  );

  const loginForRefresh: UserIdentities["Service"]["loginForRefresh"] = Effect.fn(
    "UserIdentities.loginForRefresh",
  )(function* (loginId) {
    const rows = yield* sql<{
      readonly loginId: string;
      readonly userId: UserId;
      readonly issuer: string;
      readonly subject: string;
      readonly keycloakSid: string | null;
      readonly refreshTokenSealed: string | null;
      readonly checkedAt: string;
      readonly endedAt: string | null;
    }>`
      SELECT login_id AS "loginId", user_id AS "userId", issuer, subject,
        keycloak_sid AS "keycloakSid", refresh_token_sealed AS "refreshTokenSealed",
        checked_at AS "checkedAt", ended_at AS "endedAt"
      FROM identity_logins WHERE login_id = ${loginId}
    `;
    const row = rows[0];
    return row === undefined
      ? Option.none()
      : Option.some({
          loginId: row.loginId,
          userId: row.userId,
          issuer: row.issuer,
          subject: row.subject,
          keycloakSid: row.keycloakSid,
          refreshTokenSealed: row.refreshTokenSealed,
          checkedAt: row.checkedAt,
          ended: row.endedAt !== null,
        });
  });

  const saveRefresh: UserIdentities["Service"]["saveRefresh"] = Effect.fn(
    "UserIdentities.saveRefresh",
  )(function* (input) {
    const rows = yield* sql<{ readonly loginId: string }>`
      UPDATE identity_logins
      SET checked_at = ${input.now},
        refresh_token_sealed = COALESCE(${input.refreshTokenSealed}, refresh_token_sealed),
        id_token_sealed = ${input.idTokenSealed}
      WHERE login_id = ${input.loginId} AND ended_at IS NULL
      RETURNING login_id AS "loginId"
    `;
    return rows.length > 0;
  });

  const sealedIdToken: UserIdentities["Service"]["sealedIdToken"] = Effect.fn(
    "UserIdentities.sealedIdToken",
  )(function* (loginId) {
    const rows = yield* sql<{ readonly sealed: string | null }>`
      SELECT id_token_sealed AS sealed FROM identity_logins
      WHERE login_id = ${loginId} AND ended_at IS NULL
    `;
    return Option.fromNullishOr(rows[0]?.sealed);
  });

  const liveLoginsFor: UserIdentities["Service"]["liveLoginsFor"] = Effect.fn(
    "UserIdentities.liveLoginsFor",
  )(function* ({ issuer, sid, subject }) {
    if (sid === undefined && subject === undefined) return [];
    const rows = yield* sql<{ readonly loginId: string }>`
      SELECT login_id AS "loginId" FROM identity_logins
      WHERE ended_at IS NULL AND issuer = ${issuer}
        ${sid === undefined ? sql`` : sql`AND keycloak_sid = ${sid}`}
        ${subject === undefined ? sql`` : sql`AND subject = ${subject}`}
    `;
    return rows.map((row) => row.loginId);
  });

  const newestLoginOffline: UserIdentities["Service"]["newestLoginOffline"] = Effect.fn(
    "UserIdentities.newestLoginOffline",
  )(function* () {
    const rows = yield* sql<{ readonly offline: number }>`
      SELECT offline FROM identity_logins ORDER BY created_at DESC, rowid DESC LIMIT 1
    `;
    const row = rows[0];
    return row === undefined ? Option.none() : Option.some(row.offline === 1);
  });

  const unlink: UserIdentities["Service"]["unlink"] = Effect.fn("UserIdentities.unlink")(
    function* (userId, now) {
      yield* sql`
        UPDATE identity_logins
        SET ended_at = ${now}, refresh_token_sealed = NULL, id_token_sealed = NULL
        WHERE user_id = ${userId} AND ended_at IS NULL
      `;
      const removed = yield* sql<{ readonly userId: string }>`
        DELETE FROM user_identities WHERE user_id = ${userId} RETURNING user_id AS "userId"
      `;
      return removed.length > 0;
    },
  );

  return UserIdentities.of({
    findByUser,
    findBySubject,
    link,
    updateLabels,
    insertLogin,
    liveLogins,
    setStrength,
    endWeakLogins,
    endLogins,
    loginForRefresh,
    saveRefresh,
    sealedIdToken,
    liveLoginsFor,
    newestLoginOffline,
    sessionLoginStrong,
    unboundAccessCount,
    unlink,
  });
});

export const layer = Layer.effect(UserIdentities, make);
