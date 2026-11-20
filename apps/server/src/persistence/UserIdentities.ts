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
  readonly now: string;
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
  }
>()("t3/persistence/UserIdentities") {}

interface Row {
  readonly userId: UserId;
  readonly issuer: string;
  readonly subject: string;
  readonly username: string | null;
  readonly email: string | null;
}

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
        created_at, checked_at
      )
      VALUES (
        ${input.loginId}, ${input.userId}, ${input.issuer}, ${input.subject},
        ${input.keycloakSid}, ${input.refreshTokenSealed}, 0, ${input.offline ? 1 : 0},
        ${input.now}, ${input.now}
      )
    `;
  });

  return UserIdentities.of({ findByUser, findBySubject, link, updateLabels, insertLogin });
});

export const layer = Layer.effect(UserIdentities, make);
