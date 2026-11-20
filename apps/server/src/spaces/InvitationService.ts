/**
 * Invitations into an Organization. Only a hash of each link's token is stored. Accepting spends
 * the Invitation, creates the User and membership and issues the session in one transaction, so a
 * link works once even when two browsers race.
 */
import {
  type AcceptInvitationRequest,
  type AcceptInvitationResult,
  type AuthPasskeyRegistrationCeremony,
  type AuthTotpEnrollment,
  type CreatedInvitation,
  InvitationId,
  type InvitationList,
  type InvitationPreview,
  type InvitationStatus,
  type InvitationSummary,
  type JoinInvitationResult,
  SpaceId,
  SpaceRole,
  UserId,
} from "@t3tools/contracts";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { HttpServerRequest } from "effect/http";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import * as AuditLog from "../audit/AuditLog.ts";
import type * as AccessPolicy from "../auth/AccessPolicy.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { makeSignInThrottle } from "../auth/signInThrottle.ts";
import type { AuthRequestMetadata } from "../auth/utils.ts";
import * as UserDirectory from "../auth/UserDirectory.ts";
import * as SpaceDirectory from "./SpaceDirectory.ts";

const INVITATION_TTL = Duration.days(7);

export class InvitationRefusedError extends Schema.TaggedError<InvitationRefusedError>()(
  "InvitationRefusedError",
  {
    reason: Schema.String,
    /** For a caller that answers in codes (Keycloak's callback): an Admin's Role, no strong sign-in. */
    code: Schema.optionalKey(Schema.Literal("strong-factor-required")),
  },
) {
  override get message(): string {
    return this.reason;
  }
}

/** Unknown, expired, revoked, used, or into an archived Organization: all look the same. */
export class InvitationInvalidError extends Schema.TaggedError<InvitationInvalidError>()(
  "InvitationInvalidError",
  {},
) {
  override get message(): string {
    return "This invitation is no longer valid. Ask whoever invited you for a new link.";
  }
}

export class InvitationConflictError extends Schema.TaggedError<InvitationConflictError>()(
  "InvitationConflictError",
  {
    reason: Schema.String,
    /** For a caller that answers in codes: the Owner, or someone already in the Organization. */
    code: Schema.optionalKey(Schema.Literals(["owner", "already-member"])),
  },
) {
  override get message(): string {
    return this.reason;
  }
}

export class InvitationStorageError extends Schema.TaggedError<InvitationStorageError>()(
  "InvitationStorageError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to read or write Invitations.";
  }
}

type ManageError =
  | InvitationRefusedError
  | SpaceDirectory.SpaceDirectoryStorageError
  | InvitationStorageError;

type RedeemError =
  | InvitationInvalidError
  | InvitationRefusedError
  | InvitationConflictError
  | UserDirectory.SignInThrottledError
  | InvitationStorageError;

export class InvitationService extends Context.Service<
  InvitationService,
  {
    readonly create: (
      actor: UserId,
      spaceId: SpaceId,
      role: SpaceRole,
    ) => Effect.Effect<CreatedInvitation, ManageError>;
    readonly list: (actor: UserId, spaceId: SpaceId) => Effect.Effect<InvitationList, ManageError>;
    readonly revoke: (
      actor: UserId,
      invitationId: InvitationId,
    ) => Effect.Effect<InvitationSummary, ManageError>;
    readonly preview: (
      token: string,
      clientIp: string | undefined,
    ) => Effect.Effect<
      InvitationPreview,
      UserDirectory.SignInThrottledError | InvitationStorageError
    >;
    /** A passkey registration for the new User the Invitation creates. */
    readonly startRegistration: (
      request: HttpServerRequest.HttpServerRequest,
      input: { readonly token: string; readonly displayName: string },
      clientIp: string | undefined,
    ) => Effect.Effect<
      AuthPasskeyRegistrationCeremony,
      RedeemError | EnvironmentAuth.ServerAuthInvalidOriginError
    >;
    /** An authenticator app for an invitee who signs in with a password (required for Admins). */
    readonly startTotpEnrollment: (
      token: string,
      clientIp: string | undefined,
    ) => Effect.Effect<AuthTotpEnrollment, RedeemError>;
    /** Creates the User, adds them to the Organization and signs this browser in. */
    readonly accept: (
      request: HttpServerRequest.HttpServerRequest,
      input: AcceptInvitationRequest,
      requestMetadata: AuthRequestMetadata,
    ) => Effect.Effect<
      { readonly result: AcceptInvitationResult; readonly sessionToken: string },
      | RedeemError
      | EnvironmentAuth.ServerAuthInvalidOriginError
      | EnvironmentAuth.ServerAuthInvalidCredentialError
      | EnvironmentAuth.ServerAuthInsecureTransportError
      | EnvironmentAuth.ServerAuthInternalError
    >;
    /** Adds the Invitation's Organization to the signed-in User. */
    readonly join: (
      userId: UserId,
      token: string,
      clientIp: string | undefined,
    ) => Effect.Effect<JoinInvitationResult, RedeemError>;
    /**
     * Keycloak sign-in, ticket 03: whether a token is a live Invitation and its Role, spending
     * nothing and saying no more than its preview. A dead or unknown link counts as a failure.
     */
    readonly inspect: (
      token: string,
      clientIp: string | undefined,
    ) => Effect.Effect<
      { readonly role: SpaceRole },
      InvitationInvalidError | UserDirectory.SignInThrottledError | InvitationStorageError
    >;
    /**
     * Keycloak sign-in, ticket 03: spends the Invitation for a User just created, in the caller's
     * transaction (a refusal rolls it all back, the Invitation unspent): the conditional spend, the
     * membership with the spent row's Role (an Admin's only if `adminAllowed`) and
     * `invitation.accept`. Run `afterCommit` once the transaction committed.
     */
    readonly redeemForNewUser: (input: {
      readonly token: string;
      readonly clientIp: string | undefined;
      readonly userId: UserId;
      readonly adminAllowed: boolean;
    }) => Effect.Effect<{ readonly afterCommit: Effect.Effect<void> }, RedeemError>;
  }
>()("t3/spaces/InvitationService") {}

const LiveInvitationRow = Schema.Struct({
  invitationId: InvitationId,
  spaceId: SpaceId,
  role: SpaceRole,
  organizationName: Schema.String,
  inviterName: Schema.NullOr(Schema.String),
  expiresAt: Schema.String,
});
type LiveInvitationRow = typeof LiveInvitationRow.Type;

const InvitationRow = Schema.Struct({
  invitationId: InvitationId,
  spaceId: SpaceId,
  role: SpaceRole,
  createdByName: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  expiresAt: Schema.String,
  acceptedByName: Schema.NullOr(Schema.String),
  acceptedAt: Schema.NullOr(Schema.String),
  revokedAt: Schema.NullOr(Schema.String),
});
type InvitationRow = typeof InvitationRow.Type;

const utc = (iso: string) => DateTime.makeUnsafe(iso);

const toSummary = (row: InvitationRow, nowIso: string): InvitationSummary => {
  const status: InvitationStatus =
    row.revokedAt !== null
      ? "revoked"
      : row.acceptedAt !== null
        ? "accepted"
        : row.expiresAt <= nowIso
          ? "expired"
          : "pending";
  return {
    id: row.invitationId,
    spaceId: row.spaceId,
    role: row.role,
    status,
    createdByName: row.createdByName,
    createdAt: utc(row.createdAt),
    expiresAt: utc(row.expiresAt),
    acceptedByName: row.acceptedByName,
    acceptedAt: row.acceptedAt === null ? null : utc(row.acceptedAt),
    revokedAt: row.revokedAt === null ? null : utc(row.revokedAt),
  };
};

const ADMINS_INVITE = "Only an Admin or the Owner invites people to this Organization.";

const DENIED_REASONS: Record<AccessPolicy.DenyReason, string> = {
  "owner-only": "Only the Owner invites Admins.",
  "not-a-member": ADMINS_INVITE,
  "role-not-allowed": ADMINS_INVITE,
  "not-your-personal-space": "Nothing is shared from a Personal space.",
  "personal-space-read-only": "Nothing is shared from a Personal space.",
  "default-group": ADMINS_INVITE,
  "space-archived": "This Organization is archived.",
  "space-frozen": "This Space is frozen.",
  "wrong-resource": "Only Organizations take Invitations; nothing is shared from a Personal space.",
  "not-yours": ADMINS_INVITE,
  "not-archived": ADMINS_INVITE,
  "user-inactive": "This account can no longer sign in.",
  "owner-protected": ADMINS_INVITE,
  "hub-machine": ADMINS_INVITE,
  sandbox: ADMINS_INVITE,
  "other-space": ADMINS_INVITE,
};

const deniedReason = (reason: string) =>
  Object.hasOwn(DENIED_REASONS, reason)
    ? DENIED_REASONS[reason as AccessPolicy.DenyReason]
    : ADMINS_INVITE;

// Not found and not allowed answer alike, so a revoke never confirms an Invitation exists.
const NOT_YOURS_TO_REVOKE = "You can't revoke that Invitation.";

const ADMIN_NEEDS_MORE =
  "An Admin signs in with a passkey, or with a password plus an authenticator app.";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const random = yield* SecureRandom.SecureRandom;
  const digest = yield* Digest.Digest;
  const spaces = yield* SpaceDirectory.SpaceDirectory;
  const users = yield* UserDirectory.UserDirectory;
  const audit = yield* AuditLog.AuditLog;
  const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
  // Failed redemptions back off per client, as password sign-in does.
  const throttle = makeSignInThrottle();

  const storageError = (cause: unknown) => new InvitationStorageError({ cause });
  const storage = Effect.mapError(storageError);
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  // SHA-256 of 32 random bytes: looking the hash up leaks nothing about the token through timing.
  const hashToken = (token: string) =>
    digest.digestHex(Digest.sha256, new TextEncoder().encode(token));

  const SUMMARY_SELECT = `
    SELECT i.invitation_id AS "invitationId", i.space_id AS "spaceId", i.role AS role,
      creator.display_name AS "createdByName", i.created_at AS "createdAt",
      i.expires_at AS "expiresAt", accepter.display_name AS "acceptedByName",
      i.accepted_at AS "acceptedAt", i.revoked_at AS "revokedAt"
    FROM space_invitations AS i
    LEFT JOIN users AS creator ON creator.user_id = i.created_by
    LEFT JOIN users AS accepter ON accepter.user_id = i.accepted_by`;

  const findById = SqlSchema.findOneOption({
    Request: InvitationId,
    Result: InvitationRow,
    execute: (invitationId) =>
      sql`${sql.literal(SUMMARY_SELECT)} WHERE i.invitation_id = ${invitationId}`,
  });
  const listBySpace = SqlSchema.findAll({
    Request: SpaceId,
    Result: InvitationRow,
    execute: (spaceId) =>
      sql`${sql.literal(SUMMARY_SELECT)} WHERE i.space_id = ${spaceId}
        ORDER BY i.created_at DESC, i.invitation_id DESC`,
  });
  const findLive = SqlSchema.findOneOption({
    Request: Schema.Struct({ tokenHash: Schema.String, now: Schema.String }),
    Result: LiveInvitationRow,
    execute: ({ tokenHash, now }) => sql`
      SELECT i.invitation_id AS "invitationId", i.space_id AS "spaceId", i.role AS role,
        s.name AS "organizationName", creator.display_name AS "inviterName",
        i.expires_at AS "expiresAt"
      FROM space_invitations AS i
      JOIN spaces AS s ON s.space_id = i.space_id
      LEFT JOIN users AS creator ON creator.user_id = i.created_by
      WHERE i.token_hash = ${tokenHash} AND i.accepted_at IS NULL AND i.revoked_at IS NULL
        AND i.expires_at > ${now} AND s.kind = 'organization' AND s.archived_at IS NULL
    `,
  });
  // The one write that decides who gets a link: whoever's UPDATE matches first.
  const spend = SqlSchema.findOneOption({
    Request: Schema.Struct({ tokenHash: Schema.String, now: Schema.String, userId: UserId }),
    Result: Schema.Struct({ spaceId: SpaceId, role: SpaceRole }),
    execute: ({ tokenHash, now, userId }) => sql`
      UPDATE space_invitations
      SET accepted_at = ${now}, accepted_by = ${userId}
      WHERE token_hash = ${tokenHash} AND accepted_at IS NULL AND revoked_at IS NULL
        AND expires_at > ${now}
        AND EXISTS (
          SELECT 1 FROM spaces AS s
          WHERE s.space_id = space_invitations.space_id
            AND s.kind = 'organization' AND s.archived_at IS NULL
        )
      RETURNING space_id AS "spaceId", role
    `,
  });

  const refuseDenied = <A, R>(
    effect: Effect.Effect<A, SpaceDirectory.SpaceClaimError, R>,
  ): Effect.Effect<A, InvitationRefusedError | SpaceDirectory.SpaceDirectoryStorageError, R> =>
    effect.pipe(
      Effect.catchTags({
        SpaceAccessDeniedError: (error) =>
          Effect.fail(new InvitationRefusedError({ reason: deniedReason(error.reason) })),
        SpaceNotFoundError: () =>
          Effect.fail(new InvitationRefusedError({ reason: "That Organization does not exist." })),
      }),
    );

  const create: InvitationService["Service"]["create"] = Effect.fn("InvitationService.create")(
    function* (actor, spaceId, role) {
      const space = yield* spaces.authorize(actor, "invitation.create", spaceId).pipe(refuseDenied);
      if (role === "admin") {
        yield* spaces.authorize(actor, "admin.manage", spaceId).pipe(refuseDenied);
      }
      const token = isoBase64URL.fromBuffer(
        new Uint8Array(yield* random.randomBytes(32).pipe(storage)),
      );
      const invitationId = InvitationId.make(yield* random.uuidV4().pipe(storage));
      const now = yield* DateTime.now;
      const createdAt = DateTime.formatIso(now);
      const expiresAt = DateTime.formatIso(
        DateTime.add(now, { milliseconds: Duration.toMillis(INVITATION_TTL) }),
      );
      const tokenHash = yield* hashToken(token);
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`
              INSERT INTO space_invitations (
                invitation_id, space_id, role, token_hash, created_by, created_at, expires_at
              )
              VALUES (
                ${invitationId}, ${space.id}, ${role}, ${tokenHash}, ${actor},
                ${createdAt}, ${expiresAt}
              )
            `;
            yield* audit.record({
              actor: AuditLog.userActor(actor),
              action: "invitation.create",
              spaceId: space.id,
              target: { kind: "invitation", id: invitationId },
              detail: { role },
            });
          }),
        )
        .pipe(storage);
      const row = yield* findById(invitationId).pipe(storage);
      if (Option.isNone(row)) return yield* storageError("invitation vanished after insert");
      return { invitation: toSummary(row.value, createdAt), token };
    },
  );

  const list: InvitationService["Service"]["list"] = Effect.fn("InvitationService.list")(
    function* (actor, spaceId) {
      yield* spaces.authorize(actor, "invitation.manage", spaceId).pipe(refuseDenied);
      const rows = yield* listBySpace(spaceId).pipe(storage);
      const now = yield* nowIso;
      return { invitations: rows.map((row) => toSummary(row, now)) };
    },
  );

  const revoke: InvitationService["Service"]["revoke"] = Effect.fn("InvitationService.revoke")(
    function* (actor, invitationId) {
      const found = yield* findById(invitationId).pipe(storage);
      if (Option.isNone(found)) {
        return yield* new InvitationRefusedError({ reason: NOT_YOURS_TO_REVOKE });
      }
      const notYours = {
        SpaceAccessDeniedError: () =>
          Effect.fail(new InvitationRefusedError({ reason: NOT_YOURS_TO_REVOKE })),
        SpaceNotFoundError: () =>
          Effect.fail(new InvitationRefusedError({ reason: NOT_YOURS_TO_REVOKE })),
      };
      yield* spaces
        .authorize(actor, "invitation.manage", found.value.spaceId)
        .pipe(Effect.catchTags(notYours));
      // An Admin never touches an Admin, not even one still invited.
      if (found.value.role === "admin") {
        yield* spaces
          .authorize(actor, "admin.manage", found.value.spaceId)
          .pipe(Effect.catchTags(notYours));
      }
      const now = yield* nowIso;
      const revoked = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<{ readonly invitationId: string }>`
              UPDATE space_invitations SET revoked_at = ${now}
              WHERE invitation_id = ${invitationId} AND accepted_at IS NULL AND revoked_at IS NULL
                AND expires_at > ${now}
              RETURNING invitation_id AS "invitationId"
            `;
            if (rows.length > 0) {
              yield* audit.record({
                actor: AuditLog.userActor(actor),
                action: "invitation.revoke",
                spaceId: found.value.spaceId,
                target: { kind: "invitation", id: invitationId },
                detail: { role: found.value.role },
              });
            }
            return rows;
          }),
        )
        .pipe(storage);
      if (revoked.length === 0) {
        return yield* new InvitationRefusedError({
          reason: "Only a pending Invitation can be revoked.",
        });
      }
      const row = yield* findById(invitationId).pipe(storage);
      return toSummary(
        Option.getOrElse(row, () => found.value),
        now,
      );
    },
  );

  const nowMillis = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
  // A link's failures count against that link, and against the client when its address is known.
  // There is no shared bucket for unknown addresses: behind a proxy one prober would lock out
  // every invitee.
  const ipKeys = (clientIp: string | undefined) =>
    clientIp === undefined ? [] : [`invitation-ip:${clientIp}`];
  const linkKeys = (tokenHash: string, clientIp: string | undefined) => [
    `invitation:${tokenHash}`,
    ...ipKeys(clientIp),
  ];
  const requireNotThrottled = Effect.fn("InvitationService.requireNotThrottled")(function* (
    keys: ReadonlyArray<string>,
  ) {
    const now = yield* nowMillis;
    const lockedUntil = throttle.lockedUntil(keys, now);
    if (lockedUntil !== undefined) {
      return yield* new UserDirectory.SignInThrottledError({
        retryAfterSeconds: Math.ceil((lockedUntil - now) / 1000),
      });
    }
  });
  const recordFailure = (keys: ReadonlyArray<string>) =>
    nowMillis.pipe(Effect.map((now) => throttle.recordFailure(keys, now)));
  const tokenExists = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ invitationId: InvitationId }),
    execute: (tokenHash) => sql`
      SELECT invitation_id AS "invitationId" FROM space_invitations WHERE token_hash = ${tokenHash}
    `,
  });

  /**
   * The live Invitation behind a token. An unknown token counts against the client; one that
   * expired, was revoked or used counts against itself, except when only previewed.
   */
  const requireLive = Effect.fn("InvitationService.requireLive")(function* (
    token: string,
    clientIp: string | undefined,
    options: { readonly countDeadLink: boolean } = { countDeadLink: true },
  ) {
    const tokenHash = yield* hashToken(token);
    const keys = linkKeys(tokenHash, clientIp);
    yield* requireNotThrottled(keys);
    const live = yield* findLive({ tokenHash, now: yield* nowIso }).pipe(storage);
    if (Option.isNone(live)) {
      const known = Option.isSome(yield* tokenExists(tokenHash).pipe(storage));
      if (!known) yield* recordFailure(ipKeys(clientIp));
      else if (options.countDeadLink) yield* recordFailure(keys);
      return yield* new InvitationInvalidError({});
    }
    return { tokenHash, keys, invitation: live.value };
  });

  /** A refusal after the link checked out (a wrong code, a taken name) counts against it. */
  const countRefusals =
    (keys: ReadonlyArray<string>) =>
    <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.tapError((error) =>
          error._tag === "InvitationRefusedError" ||
          error._tag === "InvitationConflictError" ||
          error._tag === "InvitationInvalidError"
            ? recordFailure(keys)
            : Effect.void,
        ),
      );

  const preview: InvitationService["Service"]["preview"] = Effect.fn("InvitationService.preview")(
    function* (token, clientIp) {
      return yield* requireLive(token, clientIp, { countDeadLink: false }).pipe(
        Effect.map(({ invitation }): InvitationPreview => ({
          status: "valid",
          organizationName: invitation.organizationName,
          role: invitation.role,
          inviterName: invitation.inviterName ?? "The Owner",
          expiresAt: utc(invitation.expiresAt),
        })),
        Effect.catchTags({
          InvitationInvalidError: () => Effect.succeed({ status: "invalid" } as const),
        }),
      );
    },
  );

  const startRegistration: InvitationService["Service"]["startRegistration"] = Effect.fn(
    "InvitationService.startRegistration",
  )(function* (request, input, clientIp) {
    const origin = yield* environmentAuth.passkeyOrigin(request);
    const { tokenHash } = yield* requireLive(input.token, clientIp);
    return yield* users.startInviteeRegistration({
      displayName: input.displayName,
      origin,
      tokenHash,
    });
  });

  const startTotpEnrollment: InvitationService["Service"]["startTotpEnrollment"] = Effect.fn(
    "InvitationService.startTotpEnrollment",
  )(function* (token, clientIp) {
    const { tokenHash, invitation } = yield* requireLive(token, clientIp);
    return yield* users
      .startInviteeTotpEnrollment({ tokenHash, label: invitation.organizationName })
      .pipe(storage);
  });

  type LiveLink = Effect.Success<ReturnType<typeof requireLive>>;

  const acceptLive = Effect.fnUntraced(function* (
    request: HttpServerRequest.HttpServerRequest,
    input: AcceptInvitationRequest,
    requestMetadata: AuthRequestMetadata,
    { tokenHash, invitation, keys }: LiveLink,
  ) {
    let pending: UserDirectory.PendingInvitee;
    if (input.method === "passkey") {
      const origin = yield* environmentAuth.passkeyOrigin(request);
      pending = yield* users
        .verifyInviteeRegistration({
          ceremonyId: input.ceremonyId,
          origin,
          response: input.response,
        })
        .pipe(Effect.mapError((error) => new InvitationRefusedError({ reason: error.message })));
      if (pending.tokenHash !== tokenHash) return yield* new InvitationInvalidError({});
    } else {
      if (invitation.role === "admin" && input.totp === undefined) {
        return yield* new InvitationRefusedError({ reason: ADMIN_NEEDS_MORE });
      }
      pending = yield* users
        .prepareInviteePassword({
          tokenHash,
          displayName: input.displayName,
          loginName: input.loginName,
          password: input.password,
          totp: input.totp,
        })
        .pipe(
          Effect.catchTags({
            AccountChangeRefusedError: (error) =>
              Effect.fail(new InvitationRefusedError({ reason: error.reason })),
            LoginNameTakenError: (error) =>
              Effect.fail(new InvitationConflictError({ reason: error.message })),
            UserDirectoryStorageError: (error) => Effect.fail(storageError(error)),
          }),
        );
    }
    const userFailures = {
      LoginNameTakenError: (error: UserDirectory.LoginNameTakenError) =>
        Effect.fail(new InvitationConflictError({ reason: error.message })),
      UserDirectoryStorageError: (error: UserDirectory.UserDirectoryStorageError) =>
        Effect.fail(storageError(error)),
    };
    const { spaceId, session } = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const user = yield* users.createInvitedUser(pending).pipe(Effect.catchTags(userFailures));
          const spent = yield* spend({ tokenHash, now: yield* nowIso, userId: user.id }).pipe(
            storage,
          );
          // Another browser accepted it first, or it was revoked or expired meanwhile.
          if (Option.isNone(spent)) return yield* new InvitationInvalidError({});
          yield* spaces
            .addMembership({
              spaceId: spent.value.spaceId,
              userId: user.id,
              role: spent.value.role,
            })
            .pipe(storage);
          yield* audit
            .record({
              actor: AuditLog.userActor(user.id),
              action: "invitation.accept",
              spaceId: spent.value.spaceId,
              target: { kind: "invitation", id: invitation.invitationId },
              detail: { role: spent.value.role, newUser: true },
            })
            .pipe(storage);
          const session = yield* environmentAuth.startUserBrowserSession(
            request,
            user,
            requestMetadata,
          );
          return { spaceId: spent.value.spaceId, session };
        }),
      )
      // After the commit, so a viewer that refreshes on the bump reads the new Membership.
      .pipe(
        Effect.catchTags({ SqlError: (cause) => Effect.fail(storageError(cause)) }),
        Effect.ensuring(spaces.changed),
      );
    throttle.reset(keys);
    return {
      result: { session: session.response, userId: pending.userId, spaceId },
      sessionToken: session.sessionToken,
    };
  });

  const accept: InvitationService["Service"]["accept"] = Effect.fn("InvitationService.accept")(
    function* (request, input, requestMetadata) {
      const live = yield* requireLive(input.token, requestMetadata.ipAddress);
      return yield* acceptLive(request, input, requestMetadata, live).pipe(
        countRefusals(live.keys),
      );
    },
  );

  const joinLive = Effect.fnUntraced(function* (
    userId: UserId,
    { tokenHash, invitation, keys }: LiveLink,
  ) {
    const principal = yield* spaces.principalOf(userId).pipe(storage);
    if (principal.isOwner) {
      return yield* new InvitationConflictError({
        reason: "You're the Owner, who already sees every Organization.",
        code: "owner",
      });
    }
    if (principal.roles.has(invitation.spaceId)) {
      return yield* new InvitationConflictError({
        reason: `You're already in ${invitation.organizationName}.`,
        code: "already-member",
      });
    }
    if (invitation.role === "admin" && !(yield* users.hasStrongSignIn(userId).pipe(storage))) {
      return yield* new InvitationRefusedError({
        reason: `${ADMIN_NEEDS_MORE} Add one in Settings, then open this link again.`,
        code: "strong-factor-required",
      });
    }
    const { spaceId, afterCommit } = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const spent = yield* spend({ tokenHash, now: yield* nowIso, userId }).pipe(storage);
          if (Option.isNone(spent)) return yield* new InvitationInvalidError({});
          const added = yield* spaces
            .addMembership({ spaceId: spent.value.spaceId, userId, role: spent.value.role })
            .pipe(storage);
          if (!added) {
            return yield* new InvitationConflictError({
              reason: `You're already in ${invitation.organizationName}.`,
              code: "already-member",
            });
          }
          yield* audit
            .record({
              actor: AuditLog.userActor(userId),
              action: "invitation.accept",
              spaceId: spent.value.spaceId,
              target: { kind: "invitation", id: invitation.invitationId },
              detail: { role: spent.value.role, newUser: false },
            })
            .pipe(storage);
          // Becoming an Admin ends a Keycloak User's sign-ins without a strong factor (ticket 06),
          // as a promotion in the Hub does: every live session of a Keycloak Admin is strong.
          const promoted =
            spent.value.role === "admin"
              ? yield* users.endWeakKeycloakLogins(userId).pipe(storage)
              : { afterCommit: Effect.void };
          return { spaceId: spent.value.spaceId, afterCommit: promoted.afterCommit };
        }),
      )
      // After the commit, so a viewer that refreshes on the bump reads the new Membership.
      .pipe(
        Effect.catchTags({ SqlError: (cause) => Effect.fail(storageError(cause)) }),
        Effect.ensuring(spaces.changed),
      );
    yield* afterCommit;
    throttle.reset(keys);
    return { userId, spaceId };
  });

  const join: InvitationService["Service"]["join"] = Effect.fn("InvitationService.join")(
    function* (userId, token, clientIp) {
      const live = yield* requireLive(token, clientIp);
      return yield* joinLive(userId, live).pipe(countRefusals(live.keys));
    },
  );

  const inspect: InvitationService["Service"]["inspect"] = Effect.fn("InvitationService.inspect")(
    function* (token, clientIp) {
      const { invitation } = yield* requireLive(token, clientIp);
      return { role: invitation.role };
    },
  );

  const redeemForNewUser: InvitationService["Service"]["redeemForNewUser"] = Effect.fn(
    "InvitationService.redeemForNewUser",
  )(function* ({ token, clientIp, userId, adminAllowed }) {
    const { tokenHash, invitation, keys } = yield* requireLive(token, clientIp);
    yield* Effect.gen(function* () {
      const spent = yield* spend({ tokenHash, now: yield* nowIso, userId }).pipe(storage);
      // Another browser accepted it first, or it was revoked or expired meanwhile.
      if (Option.isNone(spent)) return yield* new InvitationInvalidError({});
      // The Role is the spent row's, never a copy read before the transaction.
      if (spent.value.role === "admin" && !adminAllowed) {
        return yield* new InvitationRefusedError({
          reason: ADMIN_NEEDS_MORE,
          code: "strong-factor-required",
        });
      }
      yield* spaces
        .addMembership({ spaceId: spent.value.spaceId, userId, role: spent.value.role })
        .pipe(storage);
      yield* audit
        .record({
          actor: AuditLog.userActor(userId),
          action: "invitation.accept",
          spaceId: spent.value.spaceId,
          target: { kind: "invitation", id: invitation.invitationId },
          detail: { role: spent.value.role, newUser: true },
        })
        .pipe(storage);
    }).pipe(countRefusals(keys));
    // After the commit, so a viewer that refreshes on the bump reads the new Membership.
    return {
      afterCommit: Effect.sync(() => throttle.reset(keys)).pipe(Effect.andThen(spaces.changed)),
    };
  });

  return InvitationService.of({
    create,
    list,
    revoke,
    preview,
    startRegistration,
    startTotpEnrollment,
    accept,
    join,
    inspect,
    redeemForNewUser,
  });
});

export const layer = Layer.effect(InvitationService, make).pipe(Layer.provide(AuditLog.layer));
