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
    /** Ends these live sign-ins; the ones it ended. */
    readonly endLogins: (
      loginIds: ReadonlyArray<string>,
      now: string,
    ) => Effect.Effect<ReadonlyArray<string>, SqlError.SqlError>;
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
        login_id, user_id, issuer, subject, keycloak_sid, refresh_token_sealed, strong, offline,
        acr, amr_json, created_at, checked_at
      )
      VALUES (
        ${input.loginId}, ${input.userId}, ${input.issuer}, ${input.subject},
        ${input.keycloakSid}, ${input.refreshTokenSealed}, ${input.strong ? 1 : 0},
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
      UPDATE identity_logins SET ended_at = ${now}
      WHERE user_id = ${userId} AND ended_at IS NULL AND strong = 0
      RETURNING login_id AS "loginId"
    `;
    return rows.map((row) => row.loginId);
  });

  const endLogins: UserIdentities["Service"]["endLogins"] = Effect.fn("UserIdentities.endLogins")(
    function* (loginIds, now) {
      if (loginIds.length === 0) return [];
      const rows = yield* sql<{ readonly loginId: string }>`
        UPDATE identity_logins SET ended_at = ${now}
        WHERE ended_at IS NULL AND ${sql.in("login_id", loginIds)}
        RETURNING login_id AS "loginId"
      `;
      return rows.map((row) => row.loginId);
    },
  );

  const unlink: UserIdentities["Service"]["unlink"] = Effect.fn("UserIdentities.unlink")(
    function* (userId, now) {
      yield* sql`
        UPDATE identity_logins SET ended_at = ${now}
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
    unlink,
  });
});

export const layer = Layer.effect(UserIdentities, make);
