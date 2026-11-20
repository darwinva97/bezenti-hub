import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { AuthEnvironmentScopes, UserId } from "@t3tools/contracts";

import {
  type AuthPairingLinkRepositoryError,
  PersistenceDecodeError,
  type PersistenceErrorCorrelation,
  PersistenceSqlError,
} from "./Errors.ts";

export const AuthPairingLinkRecord = Schema.Struct({
  id: Schema.String,
  credential: Schema.String,
  method: Schema.Literals(["desktop-bootstrap", "one-time-token"]),
  scopes: Schema.fromJsonString(AuthEnvironmentScopes),
  subject: Schema.String,
  label: Schema.NullOr(Schema.String),
  proofKeyThumbprint: Schema.NullOr(Schema.String),
  userId: Schema.NullOr(UserId),
  createdAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
  consumedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  revokedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  /** The Keycloak sign-in of the session that created it (ticket 07); it ends with it. */
  identityLoginId: Schema.NullOr(Schema.String),
});
export type AuthPairingLinkRecord = typeof AuthPairingLinkRecord.Type;

export const CreateAuthPairingLinkInput = Schema.Struct({
  id: Schema.String,
  credential: Schema.String,
  method: Schema.Literals(["desktop-bootstrap", "one-time-token"]),
  scopes: AuthEnvironmentScopes,
  subject: Schema.String,
  label: Schema.NullOr(Schema.String),
  proofKeyThumbprint: Schema.NullOr(Schema.String),
  userId: Schema.NullOr(UserId),
  createdAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
  identityLoginId: Schema.optionalKey(Schema.String),
});
export type CreateAuthPairingLinkInput = typeof CreateAuthPairingLinkInput.Type;

export const ConsumeAuthPairingLinkInput = Schema.Struct({
  credential: Schema.String,
  proofKeyThumbprint: Schema.NullOr(Schema.String),
  requestedScopes: Schema.optionalKey(AuthEnvironmentScopes),
  requiredScopes: Schema.optionalKey(AuthEnvironmentScopes),
  consumedAt: Schema.DateTimeUtcFromString,
  now: Schema.DateTimeUtcFromString,
});
export type ConsumeAuthPairingLinkInput = typeof ConsumeAuthPairingLinkInput.Type;

export const ListActiveAuthPairingLinksInput = Schema.Struct({
  now: Schema.DateTimeUtcFromString,
});
export type ListActiveAuthPairingLinksInput = typeof ListActiveAuthPairingLinksInput.Type;

export const RevokeAuthPairingLinkInput = Schema.Struct({
  id: Schema.String,
  revokedAt: Schema.DateTimeUtcFromString,
});
export type RevokeAuthPairingLinkInput = typeof RevokeAuthPairingLinkInput.Type;

export const GetAuthPairingLinkByCredentialInput = Schema.Struct({
  credential: Schema.String,
});
export type GetAuthPairingLinkByCredentialInput = typeof GetAuthPairingLinkByCredentialInput.Type;

const AuthPairingLinkRawDbRow = Schema.Struct({
  id: Schema.String,
  credential: Schema.Unknown,
  method: Schema.Unknown,
  scopes: Schema.Unknown,
  subject: Schema.Unknown,
  label: Schema.Unknown,
  proofKeyThumbprint: Schema.Unknown,
  userId: Schema.Unknown,
  createdAt: Schema.Unknown,
  expiresAt: Schema.Unknown,
  consumedAt: Schema.Unknown,
  revokedAt: Schema.Unknown,
  identityLoginId: Schema.Unknown,
});

const decodeAuthPairingLinkDbRow = Schema.decodeUnknownEffect(AuthPairingLinkRecord);

export class AuthPairingLinkRepository extends Context.Service<
  AuthPairingLinkRepository,
  {
    readonly create: (
      input: CreateAuthPairingLinkInput,
    ) => Effect.Effect<void, AuthPairingLinkRepositoryError>;
    readonly consumeAvailable: (
      input: ConsumeAuthPairingLinkInput,
    ) => Effect.Effect<Option.Option<AuthPairingLinkRecord>, AuthPairingLinkRepositoryError>;
    readonly listActive: (
      input: ListActiveAuthPairingLinksInput,
    ) => Effect.Effect<ReadonlyArray<AuthPairingLinkRecord>, AuthPairingLinkRepositoryError>;
    readonly revoke: (
      input: RevokeAuthPairingLinkInput,
    ) => Effect.Effect<boolean, AuthPairingLinkRepositoryError>;
    readonly getByCredential: (
      input: GetAuthPairingLinkByCredentialInput,
    ) => Effect.Effect<Option.Option<AuthPairingLinkRecord>, AuthPairingLinkRepositoryError>;
    /** The creator of an unspent link; none when the link is gone, spent or revoked. */
    readonly getUnspentCreator: (input: {
      readonly id: string;
    }) => Effect.Effect<
      Option.Option<{ readonly userId: UserId | null }>,
      AuthPairingLinkRepositoryError
    >;
    readonly revokeUnspentForUser: (input: {
      readonly userId: UserId;
      /** Only the links no Keycloak sign-in vouches for (ticket 07). */
      readonly unboundOnly?: boolean;
      readonly revokedAt: DateTime.Utc;
    }) => Effect.Effect<ReadonlyArray<string>, AuthPairingLinkRepositoryError>;
    /** Ends the unspent links created from these Keycloak sign-ins (ticket 07). */
    readonly revokeForIdentityLogins: (input: {
      readonly loginIds: ReadonlyArray<string>;
      readonly revokedAt: DateTime.Utc;
    }) => Effect.Effect<ReadonlyArray<string>, AuthPairingLinkRepositoryError>;
  }
>()("t3/persistence/AuthPairingLinks/AuthPairingLinkRepository") {}

/** Ticket 07: the Keycloak sign-in a new pairing link would come from has ended. */
export class PairingLinkLoginEndedError extends Schema.TaggedError<PairingLinkLoginEndedError>()(
  "PairingLinkLoginEndedError",
  { pairingLinkId: Schema.String },
) {
  override get message(): string {
    return "The Keycloak sign-in this pairing link would come from has ended.";
  }
}

function toPersistenceSqlOrDecodeError(
  sqlOperation: string,
  decodeOperation: string,
  correlation?: PersistenceErrorCorrelation,
) {
  return (cause: unknown): AuthPairingLinkRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(decodeOperation, cause, correlation)
      : new PersistenceSqlError({
          operation: sqlOperation,
          ...(correlation === undefined ? {} : { correlation }),
          cause,
        });
}

/** @public */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const createPairingLinkRow = SqlSchema.findAll({
    Request: CreateAuthPairingLinkInput,
    Result: Schema.Struct({ id: Schema.String }),
    execute: (input) =>
      sql`
        INSERT INTO auth_pairing_links (
          id,
          credential,
          method,
          scopes,
          subject,
          label,
          proof_key_thumbprint,
          user_id,
          created_at,
          expires_at,
          consumed_at,
          revoked_at,
          identity_login_id
        )
        SELECT
          ${input.id},
          ${input.credential},
          ${input.method},
          ${JSON.stringify(input.scopes)},
          ${input.subject},
          ${input.label},
          ${input.proofKeyThumbprint},
          ${input.userId},
          ${input.createdAt},
          ${input.expiresAt},
          NULL,
          NULL,
          ${input.identityLoginId ?? null}
        -- Ticket 07: a link from a Keycloak session only while that sign-in is live.
        WHERE ${
          input.identityLoginId === undefined
            ? sql`1`
            : sql`EXISTS (
                SELECT 1 FROM identity_logins
                WHERE login_id = ${input.identityLoginId} AND ended_at IS NULL
              )`
        }
        RETURNING id AS "id"
      `,
  });

  const consumeAvailablePairingLinkRow = SqlSchema.findOneOption({
    Request: ConsumeAuthPairingLinkInput,
    Result: AuthPairingLinkRawDbRow,
    execute: ({
      credential,
      proofKeyThumbprint,
      requestedScopes,
      requiredScopes,
      consumedAt,
      now,
    }) =>
      sql`
        UPDATE auth_pairing_links
        SET consumed_at = ${consumedAt}
        WHERE credential = ${credential}
          AND revoked_at IS NULL
          AND consumed_at IS NULL
          AND expires_at > ${now}
          -- Ticket 07: never spent once the Keycloak sign-in it came from has ended.
          AND (
            identity_login_id IS NULL
            OR EXISTS (
              SELECT 1 FROM identity_logins AS l
              WHERE l.login_id = auth_pairing_links.identity_login_id AND l.ended_at IS NULL
            )
          )
          AND (
            proof_key_thumbprint IS NULL
            OR proof_key_thumbprint = ${proofKeyThumbprint}
          )
          AND (${requestedScopes === undefined ? 1 : 0} OR EXISTS (
            SELECT 1
            FROM json_each(${JSON.stringify(requestedScopes ?? [])}) AS requested
            WHERE requested.value IN (
              SELECT value FROM json_each(auth_pairing_links.scopes)
            )
          ))
          AND NOT EXISTS (
            SELECT 1
            FROM json_each(${JSON.stringify(requiredScopes ?? [])}) AS required
            WHERE required.value NOT IN (
              SELECT value FROM json_each(auth_pairing_links.scopes)
            )
          )
        RETURNING
          id AS "id",
          credential AS "credential",
          method AS "method",
          scopes AS "scopes",
          subject AS "subject",
          label AS "label",
          proof_key_thumbprint AS "proofKeyThumbprint",
          user_id AS "userId",
          created_at AS "createdAt",
          expires_at AS "expiresAt",
          consumed_at AS "consumedAt",
          revoked_at AS "revokedAt",
          identity_login_id AS "identityLoginId"
      `,
  });

  const listActivePairingLinkRows = SqlSchema.findAll({
    Request: ListActiveAuthPairingLinksInput,
    Result: AuthPairingLinkRawDbRow,
    execute: ({ now }) =>
      sql`
        SELECT
          id AS "id",
          credential AS "credential",
          method AS "method",
          scopes AS "scopes",
          subject AS "subject",
          label AS "label",
          proof_key_thumbprint AS "proofKeyThumbprint",
          user_id AS "userId",
          created_at AS "createdAt",
          expires_at AS "expiresAt",
          consumed_at AS "consumedAt",
          revoked_at AS "revokedAt",
          identity_login_id AS "identityLoginId"
        FROM auth_pairing_links
        WHERE revoked_at IS NULL
          AND consumed_at IS NULL
          AND expires_at > ${now}
        ORDER BY created_at DESC, id DESC
      `,
  });

  const revokePairingLinkRow = SqlSchema.findAll({
    Request: RevokeAuthPairingLinkInput,
    Result: Schema.Struct({ id: Schema.String }),
    execute: ({ id, revokedAt }) =>
      sql`
        UPDATE auth_pairing_links
        SET revoked_at = ${revokedAt}
        WHERE id = ${id}
          AND revoked_at IS NULL
          AND consumed_at IS NULL
        RETURNING id AS "id"
      `,
  });

  const getPairingLinkRowByCredential = SqlSchema.findOneOption({
    Request: GetAuthPairingLinkByCredentialInput,
    Result: AuthPairingLinkRawDbRow,
    execute: ({ credential }) =>
      sql`
        SELECT
          id AS "id",
          credential AS "credential",
          method AS "method",
          scopes AS "scopes",
          subject AS "subject",
          label AS "label",
          proof_key_thumbprint AS "proofKeyThumbprint",
          user_id AS "userId",
          created_at AS "createdAt",
          expires_at AS "expiresAt",
          consumed_at AS "consumedAt",
          revoked_at AS "revokedAt",
          identity_login_id AS "identityLoginId"
        FROM auth_pairing_links
        WHERE credential = ${credential}
      `,
  });

  const create: AuthPairingLinkRepository["Service"]["create"] = (input) =>
    createPairingLinkRow(input).pipe(
      Effect.flatMap((rows) =>
        rows.length > 0
          ? Effect.void
          : Effect.fail(new PairingLinkLoginEndedError({ pairingLinkId: input.id })),
      ),
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthPairingLinkRepository.create:query",
          "AuthPairingLinkRepository.create:encodeRequest",
          { pairingLinkId: input.id },
        ),
      ),
    );

  const consumeAvailable: AuthPairingLinkRepository["Service"]["consumeAvailable"] = (input) =>
    consumeAvailablePairingLinkRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthPairingLinkRepository.consumeAvailable:query",
          "AuthPairingLinkRepository.consumeAvailable:decodeRow",
        ),
      ),
      Effect.flatMap((rowOption) =>
        Option.match(rowOption, {
          onNone: () => Effect.succeedNone,
          onSome: (row) =>
            decodeAuthPairingLinkDbRow(row).pipe(
              Effect.mapError((cause) =>
                PersistenceDecodeError.fromSchemaError(
                  "AuthPairingLinkRepository.consumeAvailable:decodeRow",
                  cause,
                  { pairingLinkId: row.id },
                ),
              ),
              Effect.asSome,
            ),
        }),
      ),
    );

  const listActive: AuthPairingLinkRepository["Service"]["listActive"] = (input) =>
    listActivePairingLinkRows(input).pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthPairingLinkRepository.listActive:query",
          "AuthPairingLinkRepository.listActive:decodeRows",
        ),
      ),
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          decodeAuthPairingLinkDbRow(row).pipe(
            Effect.mapError((cause) =>
              PersistenceDecodeError.fromSchemaError(
                "AuthPairingLinkRepository.listActive:decodeRows",
                cause,
                { pairingLinkId: row.id },
              ),
            ),
          ),
        ),
      ),
    );

  const findUnspentCreator = SqlSchema.findOneOption({
    Request: Schema.Struct({ id: Schema.String }),
    Result: Schema.Struct({ userId: Schema.NullOr(UserId) }),
    execute: ({ id }) => sql`
      SELECT user_id AS "userId" FROM auth_pairing_links
      WHERE id = ${id} AND revoked_at IS NULL AND consumed_at IS NULL
    `,
  });

  const revokeUnspentRowsForUser = SqlSchema.findAll({
    Request: Schema.Struct({
      userId: UserId,
      unboundOnly: Schema.Boolean,
      revokedAt: Schema.DateTimeUtcFromString,
    }),
    Result: Schema.Struct({ id: Schema.String }),
    execute: ({ userId, unboundOnly, revokedAt }) => sql`
      UPDATE auth_pairing_links
      SET revoked_at = ${revokedAt}
      WHERE user_id = ${userId} AND revoked_at IS NULL AND consumed_at IS NULL
        ${unboundOnly ? sql`AND identity_login_id IS NULL` : sql``}
      RETURNING id AS "id"
    `,
  });

  const revokeIdentityLoginRows = SqlSchema.findAll({
    Request: Schema.Struct({
      loginIds: Schema.Array(Schema.String),
      revokedAt: Schema.DateTimeUtcFromString,
    }),
    Result: Schema.Struct({ id: Schema.String }),
    execute: ({ loginIds, revokedAt }) => sql`
      UPDATE auth_pairing_links
      SET revoked_at = ${revokedAt}
      WHERE revoked_at IS NULL AND consumed_at IS NULL AND ${sql.in("identity_login_id", loginIds)}
      RETURNING id AS "id"
    `,
  });

  const getUnspentCreator: AuthPairingLinkRepository["Service"]["getUnspentCreator"] = (input) =>
    findUnspentCreator(input).pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthPairingLinkRepository.getUnspentCreator:query",
          "AuthPairingLinkRepository.getUnspentCreator:decodeRow",
          { pairingLinkId: input.id },
        ),
      ),
    );

  const revokeUnspentForUser: AuthPairingLinkRepository["Service"]["revokeUnspentForUser"] = (
    input,
  ) =>
    revokeUnspentRowsForUser({
      userId: input.userId,
      unboundOnly: input.unboundOnly === true,
      revokedAt: input.revokedAt,
    }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthPairingLinkRepository.revokeUnspentForUser:query",
          "AuthPairingLinkRepository.revokeUnspentForUser:decodeRows",
        ),
      ),
      Effect.map((rows) => rows.map((row) => row.id)),
    );

  const revokeForIdentityLogins: AuthPairingLinkRepository["Service"]["revokeForIdentityLogins"] = (
    input,
  ) =>
    input.loginIds.length === 0
      ? Effect.succeed([])
      : revokeIdentityLoginRows(input).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "AuthPairingLinkRepository.revokeForIdentityLogins:query",
              "AuthPairingLinkRepository.revokeForIdentityLogins:decodeRows",
            ),
          ),
          Effect.map((rows) => rows.map((row) => row.id)),
        );

  const revoke: AuthPairingLinkRepository["Service"]["revoke"] = (input) =>
    revokePairingLinkRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthPairingLinkRepository.revoke:query",
          "AuthPairingLinkRepository.revoke:decodeRows",
          { pairingLinkId: input.id },
        ),
      ),
      Effect.map((rows) => rows.length > 0),
    );

  const getByCredential: AuthPairingLinkRepository["Service"]["getByCredential"] = (input) =>
    getPairingLinkRowByCredential(input).pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthPairingLinkRepository.getByCredential:query",
          "AuthPairingLinkRepository.getByCredential:decodeRow",
        ),
      ),
      Effect.flatMap((rowOption) =>
        Option.match(rowOption, {
          onNone: () => Effect.succeedNone,
          onSome: (row) =>
            decodeAuthPairingLinkDbRow(row).pipe(
              Effect.mapError((cause) =>
                PersistenceDecodeError.fromSchemaError(
                  "AuthPairingLinkRepository.getByCredential:decodeRow",
                  cause,
                  { pairingLinkId: row.id },
                ),
              ),
              Effect.asSome,
            ),
        }),
      ),
    );

  return {
    create,
    consumeAvailable,
    listActive,
    revoke,
    getByCredential,
    getUnspentCreator,
    revokeUnspentForUser,
    revokeForIdentityLogins,
  } satisfies AuthPairingLinkRepository["Service"];
});

export const layer = Layer.effect(AuthPairingLinkRepository, make);
