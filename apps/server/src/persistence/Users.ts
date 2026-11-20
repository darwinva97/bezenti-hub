import * as Context from "effect/Context";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { UserId } from "@t3tools/contracts";

import { PersistenceDecodeError, PersistenceSqlError, type UserRepositoryError } from "./Errors.ts";
import * as VaultGroups from "../vaults/VaultGroups.ts";

export const UserRecord = Schema.Struct({
  userId: UserId,
  displayName: Schema.String,
  loginName: Schema.NullOr(Schema.String),
  isOwner: Schema.BooleanFromBit,
  createdAt: Schema.DateTimeUtcFromString,
  disabledAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  removedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});
export type UserRecord = typeof UserRecord.Type;

const PasskeyFields = {
  credentialId: Schema.String,
  /** Base64url COSE public key. */
  publicKey: Schema.String,
  signCount: Schema.Int,
  transports: Schema.fromJsonString(Schema.Array(Schema.String)),
  rpId: Schema.String,
};

export const PasskeyRecord = Schema.Struct({ ...PasskeyFields, userId: UserId });
export type PasskeyRecord = typeof PasskeyRecord.Type;

export const CreateOwnerInput = Schema.Struct({
  userId: UserId,
  displayName: Schema.String,
  createdAt: Schema.DateTimeUtcFromString,
  passkey: Schema.Struct(PasskeyFields),
  recoveryCodeHashes: Schema.Array(Schema.String),
});
export type CreateOwnerInput = typeof CreateOwnerInput.Type;

const RecordPasskeyUseInput = Schema.Struct({
  credentialId: Schema.String,
  signCount: Schema.Int,
  usedAt: Schema.DateTimeUtcFromString,
});

const ConsumeRecoveryCodeInput = Schema.Struct({
  codeHash: Schema.String,
  usedAt: Schema.DateTimeUtcFromString,
});

export const UserCredentials = Schema.Struct({
  hasPasskey: Schema.BooleanFromBit,
  /** An Admin of some Organization, who like the Owner needs more than a password. */
  isAdmin: Schema.BooleanFromBit,
  /** An Admin Membership, pending or not: what a Keycloak sign-in must be strong for. */
  hasAdminMembership: Schema.BooleanFromBit,
  passwordHash: Schema.NullOr(Schema.String),
  totpSecretCiphertext: Schema.NullOr(Schema.String),
});
export type UserCredentials = typeof UserCredentials.Type;

const SetPasswordInput = Schema.Struct({
  userId: UserId,
  loginName: Schema.String,
  passwordHash: Schema.String,
  updatedAt: Schema.DateTimeUtcFromString,
});

const SetTotpInput = Schema.Struct({
  userId: UserId,
  secretCiphertext: Schema.String,
  step: Schema.Int,
  enrolledAt: Schema.DateTimeUtcFromString,
});

const RecordTotpStepInput = Schema.Struct({ userId: UserId, step: Schema.Int });

const CreateResetLinkInput = Schema.Struct({
  linkId: Schema.String,
  userId: UserId,
  tokenHash: Schema.String,
  createdBy: Schema.NullOr(UserId),
  createdAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
});

const ResetLinkLookup = Schema.Struct({
  tokenHash: Schema.String,
  now: Schema.DateTimeUtcFromString,
});

export const CreateUserInput = Schema.Struct({
  userId: UserId,
  displayName: Schema.String,
  createdAt: Schema.DateTimeUtcFromString,
  passkey: Schema.NullOr(Schema.Struct(PasskeyFields)),
  password: Schema.NullOr(Schema.Struct({ loginName: Schema.String, passwordHash: Schema.String })),
  totp: Schema.NullOr(Schema.Struct({ secretCiphertext: Schema.String, lastUsedStep: Schema.Int })),
});
export type CreateUserInput = typeof CreateUserInput.Type;

const AddPasskeyInput = Schema.Struct({
  userId: UserId,
  passkey: Schema.Struct(PasskeyFields),
  createdAt: Schema.DateTimeUtcFromString,
});

export class UserRepository extends Context.Service<
  UserRepository,
  {
    readonly hasOwner: () => Effect.Effect<boolean, UserRepositoryError>;
    /** Creates the Owner with its first passkey and recovery codes; false when one exists. */
    readonly createOwner: (input: CreateOwnerInput) => Effect.Effect<boolean, UserRepositoryError>;
    /**
     * Creates a User who is not the Owner with their first credentials; false when the login name
     * is taken. Run it in the caller's transaction.
     */
    readonly createUser: (input: CreateUserInput) => Effect.Effect<boolean, UserRepositoryError>;
    readonly getById: (
      userId: UserId,
    ) => Effect.Effect<Option.Option<UserRecord>, UserRepositoryError>;
    readonly getPasskey: (
      credentialId: string,
    ) => Effect.Effect<Option.Option<PasskeyRecord>, UserRepositoryError>;
    readonly recordPasskeyUse: (
      input: typeof RecordPasskeyUseInput.Type,
    ) => Effect.Effect<void, UserRepositoryError>;
    /** Marks an unused code used and returns its User; none when unknown or already used. */
    readonly consumeRecoveryCode: (
      input: typeof ConsumeRecoveryCodeInput.Type,
    ) => Effect.Effect<Option.Option<UserId>, UserRepositoryError>;
    /** The User of an unused recovery code, without spending it. */
    readonly findRecoveryCodeUser: (
      codeHash: string,
    ) => Effect.Effect<Option.Option<UserId>, UserRepositoryError>;
    readonly getOwner: () => Effect.Effect<Option.Option<UserRecord>, UserRepositoryError>;
    readonly getByIds: (
      userIds: ReadonlyArray<UserId>,
    ) => Effect.Effect<ReadonlyArray<UserRecord>, UserRepositoryError>;
    readonly getByLoginName: (
      loginName: string,
    ) => Effect.Effect<Option.Option<UserRecord>, UserRepositoryError>;
    readonly getCredentials: (
      userId: UserId,
    ) => Effect.Effect<UserCredentials, UserRepositoryError>;
    /** Sets the login name and password together; false when another User has that name. */
    readonly setPassword: (
      input: typeof SetPasswordInput.Type,
    ) => Effect.Effect<boolean, UserRepositoryError>;
    readonly setTotp: (input: typeof SetTotpInput.Type) => Effect.Effect<void, UserRepositoryError>;
    /** Records a used TOTP step; false when that step or a later one was already used. */
    readonly recordTotpStep: (
      input: typeof RecordTotpStepInput.Type,
    ) => Effect.Effect<boolean, UserRepositoryError>;
    readonly createResetLink: (
      input: typeof CreateResetLinkInput.Type,
    ) => Effect.Effect<void, UserRepositoryError>;
    /** The User of an unused, unexpired reset link. */
    readonly findResetLink: (
      input: typeof ResetLinkLookup.Type,
    ) => Effect.Effect<Option.Option<UserId>, UserRepositoryError>;
    /** Marks an unused, unexpired link used and returns its User. */
    readonly consumeResetLink: (
      input: typeof ResetLinkLookup.Type,
    ) => Effect.Effect<Option.Option<UserId>, UserRepositoryError>;
    readonly removePassword: (userId: UserId) => Effect.Effect<void, UserRepositoryError>;
    readonly removeTotp: (userId: UserId) => Effect.Effect<void, UserRepositoryError>;
    /** Drops every passkey of a User but one, after an Owner reset. */
    readonly removePasskeysExcept: (input: {
      readonly userId: UserId;
      readonly credentialId: string;
    }) => Effect.Effect<void, UserRepositoryError>;
    /** Ends a User's live reset links, so only the newest one works. */
    readonly expireResetLinks: (input: {
      readonly userId: UserId;
      readonly now: DateTime.Utc;
    }) => Effect.Effect<void, UserRepositoryError>;
    readonly addPasskey: (
      input: typeof AddPasskeyInput.Type,
    ) => Effect.Effect<void, UserRepositoryError>;
  }
>()("t3/persistence/Users/UserRepository") {}

const toUserRepositoryError =
  (operation: string) =>
  (cause: unknown): UserRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(operation, cause)
      : new PersistenceSqlError({ operation, cause });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findOwner = SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: Schema.Struct({ userId: UserId }),
    execute: () => sql`SELECT user_id AS "userId" FROM users WHERE is_owner = 1`,
  });

  const insertOwner = SqlSchema.void({
    Request: CreateOwnerInput,
    execute: Effect.fn("UserRepository.insertOwner")(function* (input) {
      yield* sql`
          INSERT INTO users (user_id, display_name, is_owner, created_at)
          VALUES (${input.userId}, ${input.displayName}, 1, ${input.createdAt})
        `;
      yield* sql`
          INSERT INTO user_passkeys (
            credential_id, user_id, public_key, sign_count, transports, rp_id, created_at
          )
          VALUES (
            ${input.passkey.credentialId},
            ${input.userId},
            ${input.passkey.publicKey},
            ${input.passkey.signCount},
            ${input.passkey.transports},
            ${input.passkey.rpId},
            ${input.createdAt}
          )
        `;
      // Sessions paired before the Owner existed were the operator's, and the operator is the Owner.
      yield* sql`UPDATE auth_sessions SET user_id = ${input.userId} WHERE user_id IS NULL`;
      // The Owner's Vault starts with its `default` group (owned-resources 03).
      yield* VaultGroups.ensureDefault(sql, { ownerKind: "user", ownerId: input.userId });
      yield* Effect.forEach(
        input.recoveryCodeHashes,
        (codeHash) => sql`
            INSERT INTO user_recovery_codes (code_hash, user_id, created_at)
            VALUES (${codeHash}, ${input.userId}, ${input.createdAt})
          `,
        { discard: true },
      );
    }),
  });

  // Only a taken login name is an expected conflict; any other one is a storage error.
  const insertUserRow = SqlSchema.findAll({
    Request: CreateUserInput,
    Result: Schema.Struct({ userId: UserId }),
    execute: (input) => sql`
      INSERT INTO users (user_id, display_name, login_name, is_owner, created_at)
      VALUES (
        ${input.userId}, ${input.displayName}, ${input.password?.loginName ?? null}, 0, ${input.createdAt}
      )
      ON CONFLICT (login_name) DO NOTHING
      RETURNING user_id AS "userId"
    `,
  });

  const insertUserCredentials = SqlSchema.void({
    Request: CreateUserInput,
    execute: Effect.fn("UserRepository.insertUserCredentials")(function* (input) {
      // Every User's Vault starts with its `default` group (owned-resources 04).
      yield* VaultGroups.ensureDefault(sql, { ownerKind: "user", ownerId: input.userId });
      if (input.passkey !== null) {
        yield* sql`
          INSERT INTO user_passkeys (
            credential_id, user_id, public_key, sign_count, transports, rp_id, created_at
          )
          VALUES (
            ${input.passkey.credentialId},
            ${input.userId},
            ${input.passkey.publicKey},
            ${input.passkey.signCount},
            ${input.passkey.transports},
            ${input.passkey.rpId},
            ${input.createdAt}
          )
        `;
      }
      if (input.password !== null) {
        yield* sql`
          INSERT INTO user_passwords (user_id, password_hash, updated_at)
          VALUES (${input.userId}, ${input.password.passwordHash}, ${input.createdAt})
        `;
      }
      if (input.totp !== null) {
        // The enrollment code's step counts as used, so the same code cannot also sign in.
        yield* sql`
          INSERT INTO user_totp (user_id, secret_ciphertext, enrolled_at, last_used_step)
          VALUES (
            ${input.userId}, ${input.totp.secretCiphertext}, ${input.createdAt},
            ${input.totp.lastUsedStep}
          )
        `;
      }
    }),
  });

  const userColumns = sql.literal(`
    user_id AS "userId",
    display_name AS "displayName",
    login_name AS "loginName",
    is_owner AS "isOwner",
    created_at AS "createdAt",
    disabled_at AS "disabledAt",
    removed_at AS "removedAt"
  `);

  const findUserById = SqlSchema.findOneOption({
    Request: UserId,
    Result: UserRecord,
    execute: (userId) => sql`SELECT ${userColumns} FROM users WHERE user_id = ${userId}`,
  });

  const findUsersByIds = SqlSchema.findAll({
    Request: Schema.Array(UserId),
    Result: UserRecord,
    execute: (userIds) => sql`SELECT ${userColumns} FROM users WHERE ${sql.in("user_id", userIds)}`,
  });

  const findOwnerRecord = SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: UserRecord,
    execute: () => sql`SELECT ${userColumns} FROM users WHERE is_owner = 1`,
  });

  const findUserByLoginName = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: UserRecord,
    execute: (loginName) => sql`SELECT ${userColumns} FROM users WHERE login_name = ${loginName}`,
  });

  const findCredentials = SqlSchema.findOne({
    Request: UserId,
    Result: UserCredentials,
    execute: (userId) => sql`
      SELECT
        EXISTS (SELECT 1 FROM user_passkeys WHERE user_id = ${userId}) AS "hasPasskey",
        -- An Admin Membership counts once the User has a passkey or an authenticator app, or
        -- signs in with Keycloak (ticket 06: their weak Keycloak sign-ins are refused and end).
        EXISTS (
          SELECT 1 FROM space_memberships WHERE user_id = ${userId} AND role = 'admin'
        ) AND (
          EXISTS (SELECT 1 FROM user_passkeys WHERE user_id = ${userId})
          OR EXISTS (SELECT 1 FROM user_totp WHERE user_id = ${userId})
          OR EXISTS (SELECT 1 FROM user_identities WHERE user_id = ${userId})
        ) AS "isAdmin",
        EXISTS (
          SELECT 1 FROM space_memberships WHERE user_id = ${userId} AND role = 'admin'
        ) AS "hasAdminMembership",
        (SELECT password_hash FROM user_passwords WHERE user_id = ${userId}) AS "passwordHash",
        (SELECT secret_ciphertext FROM user_totp WHERE user_id = ${userId}) AS "totpSecretCiphertext"
    `,
  });

  const writePassword = SqlSchema.void({
    Request: SetPasswordInput,
    execute: Effect.fn("UserRepository.writePassword")(function* (input) {
      yield* sql`UPDATE users SET login_name = ${input.loginName} WHERE user_id = ${input.userId}`;
      yield* sql`
        INSERT INTO user_passwords (user_id, password_hash, updated_at)
        VALUES (${input.userId}, ${input.passwordHash}, ${input.updatedAt})
        ON CONFLICT (user_id) DO UPDATE
        SET password_hash = excluded.password_hash, updated_at = excluded.updated_at
      `;
    }),
  });

  const writeTotp = SqlSchema.void({
    Request: SetTotpInput,
    execute: (input) => sql`
      INSERT INTO user_totp (user_id, secret_ciphertext, enrolled_at, last_used_step)
      VALUES (${input.userId}, ${input.secretCiphertext}, ${input.enrolledAt}, ${input.step})
      ON CONFLICT (user_id) DO UPDATE
      SET
        secret_ciphertext = excluded.secret_ciphertext,
        enrolled_at = excluded.enrolled_at,
        last_used_step = excluded.last_used_step
    `,
  });

  const advanceTotpStep = SqlSchema.findOneOption({
    Request: RecordTotpStepInput,
    Result: Schema.Struct({ userId: UserId }),
    execute: ({ userId, step }) => sql`
      UPDATE user_totp
      SET last_used_step = ${step}
      WHERE user_id = ${userId} AND last_used_step < ${step}
      RETURNING user_id AS "userId"
    `,
  });

  const insertResetLink = SqlSchema.void({
    Request: CreateResetLinkInput,
    execute: (input) => sql`
      INSERT INTO user_reset_links (
        link_id, user_id, token_hash, created_by, created_at, expires_at
      )
      VALUES (
        ${input.linkId},
        ${input.userId},
        ${input.tokenHash},
        ${input.createdBy},
        ${input.createdAt},
        ${input.expiresAt}
      )
    `,
  });

  // ISO-8601 UTC strings of one width compare in time order.
  const findLiveResetLink = SqlSchema.findOneOption({
    Request: ResetLinkLookup,
    Result: Schema.Struct({ userId: UserId }),
    execute: ({ tokenHash, now }) => sql`
      SELECT user_id AS "userId"
      FROM user_reset_links
      WHERE token_hash = ${tokenHash} AND used_at IS NULL AND expires_at > ${now}
    `,
  });

  const useResetLink = SqlSchema.findOneOption({
    Request: ResetLinkLookup,
    Result: Schema.Struct({ userId: UserId }),
    execute: ({ tokenHash, now }) => sql`
      UPDATE user_reset_links
      SET used_at = ${now}
      WHERE token_hash = ${tokenHash} AND used_at IS NULL AND expires_at > ${now}
      RETURNING user_id AS "userId"
    `,
  });

  const expireLiveResetLinks = SqlSchema.void({
    Request: Schema.Struct({ userId: UserId, now: Schema.DateTimeUtcFromString }),
    execute: ({ userId, now }) => sql`
      UPDATE user_reset_links
      SET expires_at = ${now}
      WHERE user_id = ${userId} AND used_at IS NULL AND expires_at > ${now}
    `,
  });

  const insertPasskey = SqlSchema.void({
    Request: AddPasskeyInput,
    execute: ({ userId, passkey, createdAt }) => sql`
      INSERT INTO user_passkeys (
        credential_id, user_id, public_key, sign_count, transports, rp_id, created_at
      )
      VALUES (
        ${passkey.credentialId},
        ${userId},
        ${passkey.publicKey},
        ${passkey.signCount},
        ${passkey.transports},
        ${passkey.rpId},
        ${createdAt}
      )
    `,
  });

  const findPasskey = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: PasskeyRecord,
    execute: (credentialId) => sql`
      SELECT
        credential_id AS "credentialId",
        user_id AS "userId",
        public_key AS "publicKey",
        sign_count AS "signCount",
        transports AS "transports",
        rp_id AS "rpId"
      FROM user_passkeys
      WHERE credential_id = ${credentialId}
    `,
  });

  const updatePasskeyUse = SqlSchema.void({
    Request: RecordPasskeyUseInput,
    execute: ({ credentialId, signCount, usedAt }) => sql`
      UPDATE user_passkeys
      SET sign_count = ${signCount}, last_used_at = ${usedAt}
      WHERE credential_id = ${credentialId}
    `,
  });

  const useRecoveryCode = SqlSchema.findOneOption({
    Request: ConsumeRecoveryCodeInput,
    Result: Schema.Struct({ userId: UserId }),
    execute: ({ codeHash, usedAt }) => sql`
      UPDATE user_recovery_codes
      SET used_at = ${usedAt}
      WHERE code_hash = ${codeHash} AND used_at IS NULL
      RETURNING user_id AS "userId"
    `,
  });

  const findUnusedRecoveryCode = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ userId: UserId }),
    execute: (codeHash) => sql`
      SELECT user_id AS "userId" FROM user_recovery_codes
      WHERE code_hash = ${codeHash} AND used_at IS NULL
    `,
  });

  return UserRepository.of({
    hasOwner: Effect.fn("UserRepository.hasOwner")(function () {
      return findOwner(undefined).pipe(
        NodeSqliteClient.readOnly,
        Effect.map(Option.isSome),
        Effect.mapError(toUserRepositoryError("UserRepository.hasOwner")),
      );
    }),
    createOwner: Effect.fn("UserRepository.createOwner")(function (input) {
      return sql
        .withTransaction(
          findOwner(undefined).pipe(
            Effect.flatMap((owner) =>
              Option.isSome(owner)
                ? Effect.succeed(false)
                : insertOwner(input).pipe(Effect.as(true)),
            ),
          ),
        )
        .pipe(
          // Another writer created the Owner between the check and the insert.
          Effect.catchIf(
            (error) => !Schema.isSchemaError(error) && error.reason._tag === "UniqueViolation",
            () => Effect.succeed(false),
          ),
          Effect.mapError(toUserRepositoryError("UserRepository.createOwner")),
        );
    }),
    createUser: Effect.fn("UserRepository.createUser")(function (input) {
      return insertUserRow(input).pipe(
        Effect.flatMap((inserted) =>
          // Another User already signs in with this login name.
          inserted.length === 0
            ? Effect.succeed(false)
            : insertUserCredentials(input).pipe(Effect.as(true)),
        ),
        Effect.mapError(toUserRepositoryError("UserRepository.createUser")),
      );
    }),
    getById: Effect.fn("UserRepository.getById")(function (userId) {
      return findUserById(userId).pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError(toUserRepositoryError("UserRepository.getById")),
      );
    }),
    getByIds: Effect.fn("UserRepository.getByIds")(function (userIds) {
      if (userIds.length === 0) return Effect.succeed([]);
      return findUsersByIds(userIds).pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError(toUserRepositoryError("UserRepository.getByIds")),
      );
    }),
    getPasskey: Effect.fn("UserRepository.getPasskey")(function (credentialId) {
      return findPasskey(credentialId).pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError(toUserRepositoryError("UserRepository.getPasskey")),
      );
    }),
    recordPasskeyUse: Effect.fn("UserRepository.recordPasskeyUse")(function (input) {
      return updatePasskeyUse(input).pipe(
        Effect.mapError(toUserRepositoryError("UserRepository.recordPasskeyUse")),
      );
    }),
    consumeRecoveryCode: Effect.fn("UserRepository.consumeRecoveryCode")(function (input) {
      return useRecoveryCode(input).pipe(
        Effect.map(Option.map((row) => row.userId)),
        Effect.mapError(toUserRepositoryError("UserRepository.consumeRecoveryCode")),
      );
    }),
    findRecoveryCodeUser: Effect.fn("UserRepository.findRecoveryCodeUser")(function (codeHash) {
      return findUnusedRecoveryCode(codeHash).pipe(
        NodeSqliteClient.readOnly,
        Effect.map(Option.map((row) => row.userId)),
        Effect.mapError(toUserRepositoryError("UserRepository.findRecoveryCodeUser")),
      );
    }),
    getOwner: Effect.fn("UserRepository.getOwner")(function () {
      return findOwnerRecord(undefined).pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError(toUserRepositoryError("UserRepository.getOwner")),
      );
    }),
    getByLoginName: Effect.fn("UserRepository.getByLoginName")(function (loginName) {
      return findUserByLoginName(loginName).pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError(toUserRepositoryError("UserRepository.getByLoginName")),
      );
    }),
    getCredentials: Effect.fn("UserRepository.getCredentials")(function (userId) {
      return findCredentials(userId).pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError(toUserRepositoryError("UserRepository.getCredentials")),
      );
    }),
    setPassword: Effect.fn("UserRepository.setPassword")(function (input) {
      return sql.withTransaction(writePassword(input)).pipe(
        Effect.as(true),
        // Another User already signs in with this login name.
        Effect.catchIf(
          (error) => !Schema.isSchemaError(error) && error.reason._tag === "UniqueViolation",
          () => Effect.succeed(false),
        ),
        Effect.mapError(toUserRepositoryError("UserRepository.setPassword")),
      );
    }),
    setTotp: Effect.fn("UserRepository.setTotp")(function (input) {
      return writeTotp(input).pipe(
        Effect.mapError(toUserRepositoryError("UserRepository.setTotp")),
      );
    }),
    recordTotpStep: Effect.fn("UserRepository.recordTotpStep")(function (input) {
      return advanceTotpStep(input).pipe(
        Effect.map(Option.isSome),
        Effect.mapError(toUserRepositoryError("UserRepository.recordTotpStep")),
      );
    }),
    createResetLink: Effect.fn("UserRepository.createResetLink")(function (input) {
      return insertResetLink(input).pipe(
        Effect.mapError(toUserRepositoryError("UserRepository.createResetLink")),
      );
    }),
    findResetLink: Effect.fn("UserRepository.findResetLink")(function (input) {
      return findLiveResetLink(input).pipe(
        NodeSqliteClient.readOnly,
        Effect.map(Option.map((row) => row.userId)),
        Effect.mapError(toUserRepositoryError("UserRepository.findResetLink")),
      );
    }),
    consumeResetLink: Effect.fn("UserRepository.consumeResetLink")(function (input) {
      return useResetLink(input).pipe(
        Effect.map(Option.map((row) => row.userId)),
        Effect.mapError(toUserRepositoryError("UserRepository.consumeResetLink")),
      );
    }),
    removePassword: Effect.fn("UserRepository.removePassword")(function (userId) {
      return sql`DELETE FROM user_passwords WHERE user_id = ${userId}`.pipe(
        Effect.asVoid,
        Effect.mapError(toUserRepositoryError("UserRepository.removePassword")),
      );
    }),
    removeTotp: Effect.fn("UserRepository.removeTotp")(function (userId) {
      return sql`DELETE FROM user_totp WHERE user_id = ${userId}`.pipe(
        Effect.asVoid,
        Effect.mapError(toUserRepositoryError("UserRepository.removeTotp")),
      );
    }),
    removePasskeysExcept: Effect.fn("UserRepository.removePasskeysExcept")(function ({
      userId,
      credentialId,
    }) {
      return sql`
        DELETE FROM user_passkeys WHERE user_id = ${userId} AND credential_id != ${credentialId}
      `.pipe(
        Effect.asVoid,
        Effect.mapError(toUserRepositoryError("UserRepository.removePasskeysExcept")),
      );
    }),
    expireResetLinks: Effect.fn("UserRepository.expireResetLinks")(function ({ userId, now }) {
      return expireLiveResetLinks({ userId, now }).pipe(
        Effect.mapError(toUserRepositoryError("UserRepository.expireResetLinks")),
      );
    }),
    addPasskey: Effect.fn("UserRepository.addPasskey")(function (input) {
      return insertPasskey(input).pipe(
        Effect.mapError(toUserRepositoryError("UserRepository.addPasskey")),
      );
    }),
  });
});

export const layer = Layer.effect(UserRepository, make);
