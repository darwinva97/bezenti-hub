import {
  type AuthAccount,
  type AuthSessionId,
  type AuthPasskeyAuthenticationResponse,
  type AuthPasskeyRegistrationCeremony,
  type AuthPasskeyRegistrationResponse,
  type AuthPasskeySignInCeremony,
  type AuthPasswordSignInRequest,
  type AuthReauth,
  type AuthResetLinkStatus,
  type AuthSetPasswordRequest,
  type AuthTotpConfirmRequest,
  type AuthTotpEnrollment,
  type AuthTotpSignInRequest,
  type AuthUser,
  UserId,
} from "@t3tools/contracts";
import { verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import * as Context from "effect/Context";
import * as Aead from "effect/crypto/Aead";
import * as Digest from "effect/crypto/Digest";
import * as Mac from "effect/crypto/Mac";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as UserIdentities from "../persistence/UserIdentities.ts";
import * as Users from "../persistence/Users.ts";
import * as AccessChanges from "./AccessChanges.ts";
import * as AccountCredentials from "./AccountCredentials.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as PairingGrantStore from "./PairingGrantStore.ts";
import * as SessionStore from "./SessionStore.ts";
import { makeSignInThrottle } from "./signInThrottle.ts";

const CEREMONY_TTL = Duration.minutes(5);
// Sign-in challenges are unauthenticated, so they get their own bounded store; an Owner
// registration needs the bootstrap link and can never be evicted by them.
const MAX_PENDING_SIGN_INS = 1_000;
const MAX_PENDING_OWNER_REGISTRATIONS = 16;
const TOTP_ENROLLMENT_TTL = Duration.minutes(10);
const MAX_PENDING_TOTP = 1_000;
const MAX_TOTP_ATTEMPTS = 5;
const RESET_LINK_TTL = Duration.hours(1);
const CREDENTIAL_KEY_SECRET_NAME = "user-credential-key";
const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_LENGTH = 10;
// Crockford base32: 32 symbols, so `byte & 31` is unbiased; no I, L, O or U to misread.
const RECOVERY_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
// COSE ES256, EdDSA and RS256: what platform authenticators and security keys produce.
const SUPPORTED_ALGORITHMS = [-7, -8, -257];

export class OwnerAlreadyClaimedError extends Schema.TaggedError<OwnerAlreadyClaimedError>()(
  "OwnerAlreadyClaimedError",
  {},
) {
  override get message(): string {
    return "This Installation already has an Owner.";
  }
}

export class PasskeyRejectedError extends Schema.TaggedError<PasskeyRejectedError>()(
  "PasskeyRejectedError",
  { reason: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `Passkey rejected: ${this.reason}.`;
  }
}

export class RecoveryCodeRejectedError extends Schema.TaggedError<RecoveryCodeRejectedError>()(
  "RecoveryCodeRejectedError",
  {},
) {
  override get message(): string {
    return "That recovery code is unknown or was already used.";
  }
}

/** A signed-in User's change to their own credentials that the account's rules refuse. */
export class AccountChangeRefusedError extends Schema.TaggedError<AccountChangeRefusedError>()(
  "AccountChangeRefusedError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

export class LoginNameTakenError extends Schema.TaggedError<LoginNameTakenError>()(
  "LoginNameTakenError",
  {},
) {
  override get message(): string {
    return "Another account already uses that sign-in name.";
  }
}

export class PasswordRejectedError extends Schema.TaggedError<PasswordRejectedError>()(
  "PasswordRejectedError",
  {},
) {
  override get message(): string {
    return "That sign-in name, password or code is not right.";
  }
}

/** The right password for an account that may use one only with TOTP, which it has not set up. */
export class SecondFactorMissingError extends Schema.TaggedError<SecondFactorMissingError>()(
  "SecondFactorMissingError",
  {},
) {
  override get message(): string {
    return "This account needs an authenticator app with its password. Sign in with your passkey, then add one under Settings → Access.";
  }
}

/**
 * The right credential for an account the Owner disabled or removed. Said only once the
 * credential checked out, so it tells a guesser nothing.
 */
export class AccountInactiveError extends Schema.TaggedError<AccountInactiveError>()(
  "AccountInactiveError",
  { removed: Schema.Boolean },
) {
  override get message(): string {
    return this.removed
      ? "This account was removed from this Hub."
      : "The Owner disabled this account. Ask them to turn it back on.";
  }
}

const inactiveError = (user: Users.UserRecord) =>
  user.disabledAt === null && user.removedAt === null
    ? undefined
    : new AccountInactiveError({ removed: user.removedAt !== null });

export class ResetLinkRejectedError extends Schema.TaggedError<ResetLinkRejectedError>()(
  "ResetLinkRejectedError",
  {},
) {
  override get message(): string {
    return "This reset link expired or was already used.";
  }
}

export class NoOwnerError extends Schema.TaggedError<NoOwnerError>()("NoOwnerError", {}) {
  override get message(): string {
    return "This Installation has no Owner yet. Open the first-run setup link instead.";
  }
}

export class SignInThrottledError extends Schema.TaggedError<SignInThrottledError>()(
  "SignInThrottledError",
  { retryAfterSeconds: Schema.Number },
) {
  override get message(): string {
    return `Too many failed attempts. Try again in ${formatWait(this.retryAfterSeconds)}.`;
  }
}

const formatWait = (seconds: number) =>
  seconds < 90 ? `${seconds} seconds` : `${Math.ceil(seconds / 60)} minutes`;

export class UserDirectoryStorageError extends Schema.TaggedError<UserDirectoryStorageError>()(
  "UserDirectoryStorageError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to read or write user accounts.";
  }
}

/** A verified Owner passkey registration, not yet stored. */
export interface PendingOwner {
  readonly userId: UserId;
  readonly displayName: string;
  readonly passkey: Users.CreateOwnerInput["passkey"];
}

/** A verified passkey registration from a reset link, not yet stored. */
export interface PendingResetPasskey {
  readonly userId: UserId;
  readonly passkey: Users.CreateOwnerInput["passkey"];
  /** The link the registration started from; only that link can finish it. */
  readonly tokenHash: string;
}

export type PasswordCheck =
  | { readonly _tag: "verified"; readonly user: AuthUser }
  | { readonly _tag: "totp-required"; readonly challengeId: string };

/** A signed-in User changing their own credentials, from one session and page origin. */
export interface AccountActor {
  readonly userId: UserId;
  readonly sessionId: AuthSessionId;
  readonly origin: string;
}

/**
 * Accounts that may use a password only together with TOTP: the Owner and every Admin (see the
 * sign-in rules in docs/internals/environment-auth.md).
 */
const passwordRequiresTotp = (
  user: Pick<Users.UserRecord, "isOwner">,
  credentials: Pick<Users.UserCredentials, "isAdmin">,
): boolean => user.isOwner || credentials.isAdmin;

/** A User an Invitation creates, verified and hashed but not stored yet. */
export interface PendingInvitee {
  readonly userId: UserId;
  readonly displayName: string;
  /** The Invitation it was prepared for; only that one can create it. */
  readonly tokenHash: string;
  readonly passkey: Users.CreateOwnerInput["passkey"] | null;
  readonly password: { readonly loginName: string; readonly passwordHash: string } | null;
  readonly totpSecretCiphertext: string | null;
  /** The step of the code that confirmed the enrollment, so it cannot also sign in. */
  readonly totpStep: number | null;
}

interface Ceremony {
  readonly challenge: string;
  readonly origin: string;
  readonly rpId: string;
  readonly expiresAt: DateTime.DateTime;
}

interface OwnerRegistrationCeremony extends Ceremony {
  readonly userId: UserId;
  readonly displayName: string;
}

/** Started from a reset link or an Invitation: bound to the token it came from. */
interface ResetRegistrationCeremony extends OwnerRegistrationCeremony {
  readonly tokenHash: string;
}

/**
 * Short-lived pending entries keyed by a random id. Every entry in one store has the same TTL, so
 * insertion order is expiry order and pruning stops at the first live entry.
 */
const makeExpiringStore = <V extends { readonly expiresAt: DateTime.DateTime }>(
  capacity: number,
) => {
  const entries = new Map<string, V>();
  return {
    put: (id: string, value: V, now: DateTime.DateTime) =>
      Effect.sync(() => {
        for (const [key, entry] of entries) {
          if (entries.size < capacity && DateTime.isGreaterThan(entry.expiresAt, now)) break;
          entries.delete(key);
        }
        entries.set(id, value);
      }),
    get: (id: string, now: DateTime.DateTime) =>
      Effect.sync(() => {
        const value = entries.get(id);
        return value !== undefined && DateTime.isGreaterThan(value.expiresAt, now)
          ? value
          : undefined;
      }),
    delete: (id: string) =>
      Effect.sync(() => {
        entries.delete(id);
      }),
  };
};

/** Pending WebAuthn ceremonies, single use and bound to the origin that started them. */
const makeCeremonyStore = <C extends Ceremony>(capacity: number) => {
  const store = makeExpiringStore<C>(capacity);
  return {
    put: store.put,
    take: (ceremonyId: string, origin: string, now: DateTime.DateTime) =>
      store.get(ceremonyId, now).pipe(
        Effect.tap(() => store.delete(ceremonyId)),
        Effect.map((ceremony) => (ceremony?.origin === origin ? ceremony : undefined)),
      ),
  };
};

/** Whose reset link was spent, and whether it also ended their Keycloak link. */
export interface ResetRedeemed {
  readonly user: AuthUser;
  readonly identityRemoved: boolean;
}

export class UserDirectory extends Context.Service<
  UserDirectory,
  {
    readonly hasOwner: () => Effect.Effect<boolean, UserDirectoryStorageError>;
    /** The User a session with no User of its own belongs to once the Installation has one. */
    readonly ownerId: () => Effect.Effect<Option.Option<UserId>, UserDirectoryStorageError>;
    readonly findUser: (
      userId: UserId,
    ) => Effect.Effect<Option.Option<AuthUser>, UserDirectoryStorageError>;
    /** Display names of the Users that exist among the given ids. */
    readonly displayNames: (
      userIds: ReadonlyArray<UserId>,
    ) => Effect.Effect<ReadonlyMap<UserId, string>, UserDirectoryStorageError>;
    /** The User unless they were disabled or removed. */
    readonly findActiveUser: (
      userId: UserId,
    ) => Effect.Effect<Option.Option<AuthUser>, UserDirectoryStorageError>;
    /** Why the User may not sign in, when the Owner disabled or removed them. */
    readonly inactiveReason: (
      userId: UserId,
    ) => Effect.Effect<AccountInactiveError | undefined, UserDirectoryStorageError>;
    /** The active User with this sign-in name or id, for the Hub's shell (`t3 ... --user`). */
    readonly findActiveUserByName: (
      loginNameOrId: string,
    ) => Effect.Effect<Option.Option<AuthUser>, UserDirectoryStorageError>;
    readonly startOwnerRegistration: (input: {
      readonly displayName: string;
      readonly origin: string;
    }) => Effect.Effect<
      AuthPasskeyRegistrationCeremony,
      OwnerAlreadyClaimedError | UserDirectoryStorageError
    >;
    /** Checks the passkey without writing, so a rejected attempt leaves the bootstrap link unspent. */
    readonly verifyOwnerRegistration: (input: {
      readonly ceremonyId: string;
      readonly origin: string;
      readonly response: AuthPasskeyRegistrationResponse;
    }) => Effect.Effect<PendingOwner, PasskeyRejectedError>;
    readonly createOwner: (
      owner: PendingOwner,
    ) => Effect.Effect<
      { readonly user: AuthUser; readonly recoveryCodes: ReadonlyArray<string> },
      OwnerAlreadyClaimedError | UserDirectoryStorageError
    >;
    readonly startPasskeySignIn: (input: {
      readonly origin: string;
    }) => Effect.Effect<AuthPasskeySignInCeremony>;
    readonly finishPasskeySignIn: (input: {
      readonly ceremonyId: string;
      readonly origin: string;
      readonly response: AuthPasskeyAuthenticationResponse;
    }) => Effect.Effect<
      AuthUser,
      PasskeyRejectedError | AccountInactiveError | UserDirectoryStorageError
    >;
    readonly redeemRecoveryCode: (
      code: string,
    ) => Effect.Effect<
      AuthUser,
      RecoveryCodeRejectedError | AccountInactiveError | UserDirectoryStorageError
    >;
    readonly getAccount: (
      userId: UserId,
    ) => Effect.Effect<AuthAccount, AccountChangeRefusedError | UserDirectoryStorageError>;
    /**
     * «Connect Keycloak» (Keycloak sign-in spec, ticket 02): a proof in this request of the
     * account's current passkey or password (and code), always; refused for an account already
     * linked, one with nothing to confirm with (the Owner's reset link is its way), and an Admin
     * other than the Owner until Keycloak can give them a strong factor (ticket 06).
     */
    readonly confirmLinkStepUp: (
      actor: AccountActor,
      reauth: AuthReauth | undefined,
    ) => Effect.Effect<AuthUser, AccountChangeError>;
    /** The per-client sign-in back-off, for a door that signs in some other way (Keycloak). */
    readonly requireClientNotThrottled: (
      clientIp: string | undefined,
    ) => Effect.Effect<void, SignInThrottledError>;
    /** Counts a failed sign-in against the client: a bad state, cookie, code or token. */
    readonly recordClientSignInFailure: (clientIp: string | undefined) => Effect.Effect<void>;
    readonly setPassword: (
      actor: AccountActor,
      input: AuthSetPasswordRequest,
    ) => Effect.Effect<AuthAccount, AccountChangeError | LoginNameTakenError>;
    readonly removePassword: (
      actor: AccountActor,
      reauth: AuthReauth,
    ) => Effect.Effect<AuthAccount, AccountChangeError>;
    /** A new secret, held under the returned id until a code from it confirms the enrollment. */
    readonly startTotpEnrollment: (
      userId: UserId,
    ) => Effect.Effect<AuthTotpEnrollment, AccountChangeRefusedError | UserDirectoryStorageError>;
    readonly confirmTotpEnrollment: (
      actor: AccountActor,
      input: AuthTotpConfirmRequest,
    ) => Effect.Effect<AuthAccount, AccountChangeError>;
    readonly removeTotp: (
      actor: AccountActor,
      reauth: AuthReauth,
    ) => Effect.Effect<AuthAccount, AccountChangeError>;
    /**
     * Proof in this request of a strong sign-in, for actions a stolen session must not take: a
     * fresh passkey assertion, or the password together with a TOTP code. A password alone never
     * passes, whatever the account's rules allow at sign-in.
     */
    readonly confirmStrongFactor: (
      actor: AccountActor,
      reauth: AuthReauth | undefined,
    ) => Effect.Effect<void, AccountChangeError>;
    readonly checkPassword: (
      input: AuthPasswordSignInRequest,
      clientIp: string | undefined,
    ) => Effect.Effect<
      PasswordCheck,
      | PasswordRejectedError
      | AccountInactiveError
      | SecondFactorMissingError
      | SignInThrottledError
      | UserDirectoryStorageError
    >;
    readonly checkTotp: (
      input: AuthTotpSignInRequest,
      clientIp: string | undefined,
    ) => Effect.Effect<
      AuthUser,
      | PasswordRejectedError
      | AccountInactiveError
      | SignInThrottledError
      | UserDirectoryStorageError
    >;
    /** A single-use link that lets the Owner register a new passkey; the token is shown once. */
    readonly issueOwnerResetLink: () => Effect.Effect<
      { readonly token: string; readonly expiresAt: DateTime.Utc; readonly user: AuthUser },
      NoOwnerError | UserDirectoryStorageError
    >;
    /**
     * The same link for an active User, issued by the Owner (`createdBy`); only the newest link
     * works. None when the User is disabled or removed.
     */
    readonly issueResetLink: (input: {
      readonly userId: UserId;
      readonly createdBy: UserId;
    }) => Effect.Effect<
      Option.Option<{ readonly token: string; readonly expiresAt: DateTime.Utc }>,
      UserDirectoryStorageError
    >;
    /**
     * Where a User just made Admin stands. Without a passkey or authenticator app they are
     * `pending` and keep a Member's rights until they add an app from a signed-in session. With a
     * passkey but a password that needs no code, their sessions end (`signedOut`): any of them may
     * have come from the password alone. Run it in the promotion's transaction.
     */
    readonly onPromotedToAdmin: (
      userId: UserId,
    ) => Effect.Effect<
      { readonly pending: boolean; readonly signedOut: boolean },
      UserDirectoryStorageError
    >;
    /**
     * After a change to a User's credentials commits: their Admin rights may have started or
     * ended, so cached principals are dropped and their connections close.
     */
    readonly credentialsChanged: (userId: UserId) => Effect.Effect<void>;
    readonly getResetLinkStatus: (
      token: string,
    ) => Effect.Effect<AuthResetLinkStatus, UserDirectoryStorageError>;
    readonly startResetRegistration: (input: {
      readonly token: string;
      readonly origin: string;
    }) => Effect.Effect<
      AuthPasskeyRegistrationCeremony,
      ResetLinkRejectedError | UserDirectoryStorageError
    >;
    readonly verifyResetRegistration: (input: {
      readonly ceremonyId: string;
      readonly origin: string;
      readonly response: AuthPasskeyRegistrationResponse;
    }) => Effect.Effect<PendingResetPasskey, PasskeyRejectedError>;
    /** A passkey registration for a new User an Invitation (by its token hash) creates. */
    readonly startInviteeRegistration: (input: {
      readonly displayName: string;
      readonly origin: string;
      readonly tokenHash: string;
    }) => Effect.Effect<AuthPasskeyRegistrationCeremony>;
    readonly verifyInviteeRegistration: (input: {
      readonly ceremonyId: string;
      readonly origin: string;
      readonly response: AuthPasskeyRegistrationResponse;
    }) => Effect.Effect<PendingInvitee, PasskeyRejectedError>;
    /** A TOTP secret for an invitee, held until the accept that confirms it with a code. */
    readonly startInviteeTotpEnrollment: (input: {
      readonly tokenHash: string;
      readonly label: string;
    }) => Effect.Effect<AuthTotpEnrollment, UserDirectoryStorageError>;
    /** Hashes the password and checks the TOTP code, outside the transaction that stores them. */
    readonly prepareInviteePassword: (input: {
      readonly tokenHash: string;
      readonly displayName: string;
      readonly loginName: string;
      readonly password: string;
      readonly totp: { readonly enrollmentId: string; readonly code: string } | undefined;
    }) => Effect.Effect<
      PendingInvitee,
      AccountChangeRefusedError | LoginNameTakenError | UserDirectoryStorageError
    >;
    /** Stores a prepared invitee; run it in the transaction that spends the Invitation. */
    readonly createInvitedUser: (
      pending: PendingInvitee,
    ) => Effect.Effect<AuthUser, LoginNameTakenError | UserDirectoryStorageError>;
    /**
     * Keycloak sign-in, ticket 03: a User whose only way in is a Keycloak identity: no sign-in
     * name, passkey, password or TOTP. Run it in the transaction that links the identity.
     */
    readonly createIdentityUser: (
      displayName: string,
    ) => Effect.Effect<AuthUser, UserDirectoryStorageError>;
    /** Whether the User signs in with more than a password: a passkey or TOTP. */
    readonly hasStrongSignIn: (userId: UserId) => Effect.Effect<boolean, UserDirectoryStorageError>;
    /**
     * Spends the link, replaces every passkey with the new one and ends the User's sessions; run
     * it in the transaction that issues the new session.
     */
    readonly redeemResetLink: (input: {
      readonly token: string;
      readonly pending: PendingResetPasskey;
    }) => Effect.Effect<ResetRedeemed, ResetLinkRejectedError | UserDirectoryStorageError>;
    /**
     * Spends a reset link on a new password instead of a passkey, for anyone but the Owner. Like
     * the passkey way, every old credential and session ends. Run it in a transaction.
     */
    readonly redeemResetLinkWithPassword: (input: {
      readonly token: string;
      readonly loginName: string;
      readonly password: string;
    }) => Effect.Effect<
      ResetRedeemed,
      | ResetLinkRejectedError
      | AccountChangeRefusedError
      | LoginNameTakenError
      | UserDirectoryStorageError
    >;
  }
>()("t3/auth/UserDirectory") {}

type AccountChangeError =
  | AccountChangeRefusedError
  | SignInThrottledError
  | UserDirectoryStorageError;

const registrationCeremony = (input: {
  readonly ceremonyId: string;
  readonly challenge: string;
  readonly rpId: string;
  readonly userId: UserId;
  readonly displayName: string;
}): AuthPasskeyRegistrationCeremony => ({
  ceremonyId: input.ceremonyId,
  options: {
    challenge: input.challenge,
    rp: { id: input.rpId, name: "T3 Code" },
    user: {
      id: isoBase64URL.fromUTF8String(input.userId),
      name: input.displayName,
      displayName: input.displayName,
    },
    pubKeyCredParams: SUPPORTED_ALGORITHMS.map((alg) => ({ alg, type: "public-key" as const })),
    timeout: Duration.toMillis(CEREMONY_TTL),
    authenticatorSelection: {
      residentKey: "required",
      requireResidentKey: true,
      userVerification: "preferred",
    },
    attestation: "none",
  },
});

const normalizeLoginName = (loginName: string) => loginName.trim().toLowerCase();

const toAuthUser = (user: Users.UserRecord): AuthUser => ({
  id: user.userId,
  displayName: user.displayName,
  isOwner: user.isOwner,
});

const normalizeRecoveryCode = (code: string) =>
  code
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");

const make = Effect.gen(function* () {
  const users = yield* Users.UserRepository;
  const identities = yield* UserIdentities.UserIdentities;
  const random = yield* SecureRandom.SecureRandom;
  const digest = yield* Digest.Digest;
  const ownerRegistrations = makeCeremonyStore<OwnerRegistrationCeremony>(
    MAX_PENDING_OWNER_REGISTRATIONS,
  );
  const signIns = makeCeremonyStore<Ceremony>(MAX_PENDING_SIGN_INS);
  // Gated by a live reset link, so the Owner-registration bound is plenty.
  const resetRegistrations = makeCeremonyStore<ResetRegistrationCeremony>(
    MAX_PENDING_OWNER_REGISTRATIONS,
  );
  // Each needs a live Invitation; the bound keeps a flood of them from growing memory.
  const inviteeRegistrations = makeCeremonyStore<ResetRegistrationCeremony>(MAX_PENDING_SIGN_INS);
  const inviteeTotpEnrollments = makeExpiringStore<{
    readonly tokenHash: string;
    readonly secret: Uint8Array;
    readonly expiresAt: DateTime.DateTime;
  }>(MAX_PENDING_TOTP);
  const totpEnrollments = makeExpiringStore<{
    readonly userId: UserId;
    readonly secret: Uint8Array;
    readonly expiresAt: DateTime.DateTime;
  }>(MAX_PENDING_TOTP);
  const totpChallenges = makeExpiringStore<{
    readonly userId: UserId;
    /** False for a decoy challenge after a wrong password: no code will pass it. */
    readonly passwordOk: boolean;
    /** The password was right but the Owner disabled or removed the account. */
    readonly inactiveWithPassword: boolean;
    readonly clientIp: string | undefined;
    attempts: number;
    readonly expiresAt: DateTime.DateTime;
  }>(MAX_PENDING_TOTP);
  const throttle = makeSignInThrottle();
  const sessions = yield* SessionStore.SessionStore;
  const pairingLinks = yield* PairingGrantStore.PairingGrantStore;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const cryptoContext = yield* Effect.context<Mac.Mac | Aead.Aead | SecureRandom.SecureRandom>();
  const withCrypto = Effect.provide(cryptoContext);

  const storage = Effect.mapError((cause: unknown) => new UserDirectoryStorageError({ cause }));

  const randomBase64Url = (size: number) =>
    random
      .randomBytes(size)
      .pipe(Effect.map((bytes) => isoBase64URL.fromBuffer(new Uint8Array(bytes))));

  const hashRecoveryCode = (code: string) =>
    digest.digestHex(Digest.sha256, new TextEncoder().encode(normalizeRecoveryCode(code)));

  const ceremonyExpiry = (now: DateTime.DateTime) =>
    DateTime.add(now, { milliseconds: Duration.toMillis(CEREMONY_TTL) });

  const takeCeremony = Effect.fn("UserDirectory.takeCeremony")(function* <C extends Ceremony>(
    store: ReturnType<typeof makeCeremonyStore<C>>,
    ceremonyId: string,
    origin: string,
  ) {
    const ceremony = yield* store.take(ceremonyId, origin, yield* DateTime.now);
    if (ceremony === undefined) {
      return yield* new PasskeyRejectedError({ reason: "the sign-in attempt expired" });
    }
    return ceremony;
  });

  const startOwnerRegistration: UserDirectory["Service"]["startOwnerRegistration"] = Effect.fn(
    "UserDirectory.startOwnerRegistration",
  )(function* ({ displayName, origin }) {
    if (yield* users.hasOwner().pipe(storage)) {
      return yield* new OwnerAlreadyClaimedError({});
    }
    const userId = UserId.make(yield* random.uuidV4());
    const challenge = yield* randomBase64Url(32);
    const rpId = new URL(origin).hostname;
    const ceremonyId = yield* random.uuidV4();
    const now = yield* DateTime.now;
    yield* ownerRegistrations.put(
      ceremonyId,
      { challenge, origin, rpId, expiresAt: ceremonyExpiry(now), userId, displayName },
      now,
    );
    return registrationCeremony({ ceremonyId, challenge, rpId, userId, displayName });
  });

  const verifyRegistration = Effect.fn("UserDirectory.verifyRegistration")(function* <
    C extends OwnerRegistrationCeremony,
  >(
    store: ReturnType<typeof makeCeremonyStore<C>>,
    input: {
      readonly ceremonyId: string;
      readonly origin: string;
      readonly response: AuthPasskeyRegistrationResponse;
    },
  ) {
    const { response } = input;
    const ceremony = yield* takeCeremony(store, input.ceremonyId, input.origin);
    const verification = yield* Effect.tryPromise({
      try: () =>
        verifyRegistrationResponse({
          response: {
            id: response.id,
            rawId: response.rawId,
            type: response.type,
            response: {
              clientDataJSON: response.response.clientDataJSON,
              attestationObject: response.response.attestationObject,
              ...(response.response.transports
                ? { transports: [...response.response.transports] }
                : {}),
            },
            clientExtensionResults: {},
          },
          expectedChallenge: ceremony.challenge,
          expectedOrigin: ceremony.origin,
          expectedRPID: ceremony.rpId,
          requireUserVerification: false,
          supportedAlgorithmIDs: SUPPORTED_ALGORITHMS,
        }),
      catch: (cause) => new PasskeyRejectedError({ reason: "the passkey did not verify", cause }),
    });
    if (!verification.verified) {
      return yield* new PasskeyRejectedError({ reason: "the passkey did not verify" });
    }
    const { credential } = verification.registrationInfo;
    return {
      ceremony,
      passkey: {
        credentialId: credential.id,
        publicKey: isoBase64URL.fromBuffer(credential.publicKey),
        signCount: credential.counter,
        transports: credential.transports ?? [],
        rpId: ceremony.rpId,
      },
    };
  });

  const verifyOwnerRegistration: UserDirectory["Service"]["verifyOwnerRegistration"] = Effect.fn(
    "UserDirectory.verifyOwnerRegistration",
  )(function* (input) {
    const { ceremony, passkey } = yield* verifyRegistration(ownerRegistrations, input);
    return {
      userId: ceremony.userId,
      displayName: ceremony.displayName,
      passkey,
    } satisfies PendingOwner;
  });

  const generateRecoveryCode = random.randomBytes(RECOVERY_CODE_LENGTH).pipe(
    Effect.map((bytes) => {
      const symbols = Array.from(bytes, (byte) => RECOVERY_CODE_ALPHABET[byte & 31]).join("");
      return `${symbols.slice(0, 5)}-${symbols.slice(5)}`;
    }),
  );

  const createOwner: UserDirectory["Service"]["createOwner"] = Effect.fn(
    "UserDirectory.createOwner",
  )(function* (owner) {
    const recoveryCodes = yield* Effect.replicateEffect(generateRecoveryCode, RECOVERY_CODE_COUNT);
    const recoveryCodeHashes = yield* Effect.forEach(recoveryCodes, hashRecoveryCode);
    const created = yield* users
      .createOwner({
        userId: owner.userId,
        displayName: owner.displayName,
        createdAt: yield* DateTime.now,
        passkey: owner.passkey,
        recoveryCodeHashes,
      })
      .pipe(storage);
    if (!created) {
      return yield* new OwnerAlreadyClaimedError({});
    }
    return {
      user: { id: owner.userId, displayName: owner.displayName, isOwner: true },
      recoveryCodes,
    };
  });

  const startPasskeySignIn: UserDirectory["Service"]["startPasskeySignIn"] = Effect.fn(
    "UserDirectory.startPasskeySignIn",
  )(function* ({ origin }) {
    const challenge = yield* randomBase64Url(32);
    const rpId = new URL(origin).hostname;
    const ceremonyId = yield* random.uuidV4();
    const now = yield* DateTime.now;
    yield* signIns.put(
      ceremonyId,
      { challenge, origin, rpId, expiresAt: ceremonyExpiry(now) },
      now,
    );
    return {
      ceremonyId,
      options: {
        challenge,
        rpId,
        timeout: Duration.toMillis(CEREMONY_TTL),
        userVerification: "preferred",
      },
    } satisfies AuthPasskeySignInCeremony;
  });

  const activeUser = (userId: UserId) =>
    users
      .getById(userId)
      .pipe(
        storage,
        Effect.map(Option.filter((user) => user.disabledAt === null && user.removedAt === null)),
      );

  const finishPasskeySignIn: UserDirectory["Service"]["finishPasskeySignIn"] = Effect.fn(
    "UserDirectory.finishPasskeySignIn",
  )(function* ({ ceremonyId, origin, response }) {
    const ceremony = yield* takeCeremony(signIns, ceremonyId, origin);
    const passkey = yield* users.getPasskey(response.id).pipe(storage);
    if (Option.isNone(passkey) || passkey.value.rpId !== ceremony.rpId) {
      return yield* new PasskeyRejectedError({ reason: "this passkey is not registered here" });
    }
    const verification = yield* Effect.tryPromise({
      try: () =>
        verifyAuthenticationResponse({
          response: {
            id: response.id,
            rawId: response.rawId,
            type: response.type,
            response: {
              clientDataJSON: response.response.clientDataJSON,
              authenticatorData: response.response.authenticatorData,
              signature: response.response.signature,
              ...(response.response.userHandle !== undefined
                ? { userHandle: response.response.userHandle }
                : {}),
            },
            clientExtensionResults: {},
          },
          expectedChallenge: ceremony.challenge,
          expectedOrigin: ceremony.origin,
          expectedRPID: ceremony.rpId,
          credential: {
            id: passkey.value.credentialId,
            publicKey: isoBase64URL.toBuffer(passkey.value.publicKey),
            counter: passkey.value.signCount,
            transports: [...passkey.value.transports],
          },
          requireUserVerification: false,
        }),
      catch: (cause) => new PasskeyRejectedError({ reason: "the passkey did not verify", cause }),
    });
    if (!verification.verified) {
      return yield* new PasskeyRejectedError({ reason: "the passkey did not verify" });
    }
    yield* users
      .recordPasskeyUse({
        credentialId: passkey.value.credentialId,
        signCount: verification.authenticationInfo.newCounter,
        usedAt: yield* DateTime.now,
      })
      .pipe(storage);
    const user = yield* users.getById(passkey.value.userId).pipe(storage);
    if (Option.isNone(user)) {
      return yield* new PasskeyRejectedError({ reason: "this account cannot sign in" });
    }
    const inactive = inactiveError(user.value);
    if (inactive !== undefined) return yield* inactive;
    return toAuthUser(user.value);
  });

  const redeemRecoveryCode: UserDirectory["Service"]["redeemRecoveryCode"] = Effect.fn(
    "UserDirectory.redeemRecoveryCode",
  )(function* (code) {
    const codeHash = yield* hashRecoveryCode(code);
    // An account that may not sign in keeps its code unspent and is told why.
    const holder = yield* users.findRecoveryCodeUser(codeHash).pipe(storage);
    if (Option.isNone(holder)) return yield* new RecoveryCodeRejectedError({});
    const record = yield* users.getById(holder.value).pipe(storage);
    if (Option.isNone(record)) return yield* new RecoveryCodeRejectedError({});
    const inactive = inactiveError(record.value);
    if (inactive !== undefined) return yield* inactive;
    const userId = yield* users
      .consumeRecoveryCode({ codeHash, usedAt: yield* DateTime.now })
      .pipe(storage);
    if (Option.isNone(userId)) return yield* new RecoveryCodeRejectedError({});
    return toAuthUser(record.value);
  });

  let cachedCredentialKey: Uint8Array | undefined;
  const credentialKey = Effect.suspend(() =>
    cachedCredentialKey !== undefined
      ? Effect.succeed(cachedCredentialKey)
      : secretStore.getOrCreateRandom(CREDENTIAL_KEY_SECRET_NAME, 32).pipe(
          storage,
          Effect.tap((key) =>
            Effect.sync(() => {
              cachedCredentialKey = key;
            }),
          ),
        ),
  );

  // argon2id holds the event loop for tens of milliseconds and 19 MiB per run, so unauthenticated
  // sign-ins queue for a permit instead of piling up.
  const hashing = yield* Semaphore.make(2);
  const hashPassword = (password: string) =>
    hashing.withPermits(1)(AccountCredentials.hashPassword(password).pipe(withCrypto));
  const verifyPassword = (password: string, hash: string) =>
    hashing.withPermits(1)(AccountCredentials.verifyPassword(password, hash));
  // Unknown names still pay for one hash, so timing does not reveal which names exist.
  const decoyPasswordHash = yield* Effect.cached(hashPassword("decoy password"));

  const nowMillis = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
  const accountKey = (userId: UserId) => `user:${userId}`;
  const throttleKeys = (userId: UserId | undefined, clientIp: string | undefined) => [
    ...(userId === undefined ? [] : [accountKey(userId)]),
    ...(clientIp === undefined ? [] : [`ip:${clientIp}`]),
  ];
  const requireNotThrottled = Effect.fn("UserDirectory.requireNotThrottled")(function* (
    keys: ReadonlyArray<string>,
  ) {
    const now = yield* nowMillis;
    const lockedUntil = throttle.lockedUntil(keys, now);
    if (lockedUntil !== undefined) {
      return yield* new SignInThrottledError({
        retryAfterSeconds: Math.ceil((lockedUntil - now) / 1000),
      });
    }
  });
  const recordFailure = (keys: ReadonlyArray<string>) =>
    nowMillis.pipe(Effect.map((now) => throttle.recordFailure(keys, now)));

  const requireAccount = (userId: UserId) =>
    activeUser(userId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(new AccountChangeRefusedError({ reason: "This account cannot sign in." })),
          onSome: Effect.succeed,
        }),
      ),
    );

  const identityOf = (userId: UserId) =>
    identities.findByUser(userId).pipe(Effect.map(Option.getOrUndefined), storage);

  /** Whether «Connect Keycloak» is open to an account without an identity, and if not, why. */
  const keycloakLinkOf = (
    user: Users.UserRecord,
    credentials: Users.UserCredentials,
  ): NonNullable<AuthAccount["keycloakLink"]> =>
    !credentials.hasPasskey && credentials.passwordHash === null
      ? "needs-reset"
      : !user.isOwner && credentials.isAdmin
        ? "admins-later"
        : "allowed";

  const accountOf = Effect.fn("UserDirectory.accountOf")(function* (user: Users.UserRecord) {
    const credentials = yield* users.getCredentials(user.userId).pipe(storage);
    const identity = yield* identityOf(user.userId);
    return {
      user: toAuthUser(user),
      loginName: user.loginName,
      hasPasskey: credentials.hasPasskey,
      hasPassword: credentials.passwordHash !== null,
      totpEnrolled: credentials.totpSecretCiphertext !== null,
      passwordRequiresTotp: passwordRequiresTotp(user, credentials),
      ...(identity === undefined
        ? { keycloakLink: keycloakLinkOf(user, credentials) }
        : {
            identity: {
              username: identity.username,
              email: identity.email,
              accountUrl: `${identity.issuer}/account`,
            },
          }),
    } satisfies AuthAccount;
  });

  /**
   * A User who signs in with Keycloak keeps no local credentials (the Owner aside, whose passkey
   * and codes are the break-glass): adding one would be a way in Keycloak cannot cut.
   */
  const refuseLocalCredentialsForIdentity = Effect.fn(
    "UserDirectory.refuseLocalCredentialsForIdentity",
  )(function* (user: Users.UserRecord) {
    if (user.isOwner) return;
    if ((yield* identityOf(user.userId)) !== undefined) {
      return yield* new AccountChangeRefusedError({
        reason:
          "You sign in with Keycloak: change your password or second factor in your Keycloak account.",
      });
    }
  });

  const getAccount: UserDirectory["Service"]["getAccount"] = Effect.fn("UserDirectory.getAccount")(
    function* (userId) {
      return yield* accountOf(yield* requireAccount(userId));
    },
  );

  const openTotpSecret = (userId: UserId, ciphertext: string) =>
    credentialKey.pipe(
      Effect.flatMap((key) => AccountCredentials.open(key, ciphertext, userId)),
      withCrypto,
      storage,
    );

  /** A code from the User's enrolled secret whose step was not used yet; records the step. */
  const acceptTotpCode = Effect.fn("UserDirectory.acceptTotpCode")(function* (
    userId: UserId,
    ciphertext: string,
    code: string,
  ) {
    const secret = yield* openTotpSecret(userId, ciphertext);
    const step = yield* AccountCredentials.matchTotpStep(secret, code, yield* nowMillis).pipe(
      withCrypto,
    );
    return step !== undefined && (yield* users.recordTotpStep({ userId, step }).pipe(storage));
  });

  const stepUpRefused = new AccountChangeRefusedError({
    reason: "Confirming it's you failed: check your password, code or passkey.",
  });

  /**
   * Credential changes need proof in the same request that the person can sign in now, so a
   * stolen session cannot install its own password or authenticator. An account with no way to
   * sign in yet has nothing to prove.
   */
  const requireStepUp = Effect.fn("UserDirectory.requireStepUp")(function* (
    actor: AccountActor,
    user: Users.UserRecord,
    reauth: AuthReauth | undefined,
  ) {
    const credentials = yield* users.getCredentials(user.userId).pipe(storage);
    if (!credentials.hasPasskey && credentials.passwordHash === null) {
      // Signing in with Keycloak is a way to sign in: an account with an identity always has
      // something to prove, and until Keycloak can confirm it (ticket 06) nothing here does.
      if ((yield* identityOf(user.userId)) !== undefined) {
        return yield* new AccountChangeRefusedError({
          reason: "Confirming it's you through Keycloak is not available yet for this action.",
        });
      }
      return;
    }
    const keys = [accountKey(user.userId)];
    yield* requireNotThrottled(keys);
    const verified =
      reauth === undefined
        ? false
        : reauth.method === "passkey"
          ? yield* finishPasskeySignIn({
              ceremonyId: reauth.ceremonyId,
              origin: actor.origin,
              response: reauth.response,
            }).pipe(
              Effect.map((signedIn) => signedIn.id === user.userId),
              Effect.catchTags({
                PasskeyRejectedError: () => Effect.succeed(false),
                AccountInactiveError: () => Effect.succeed(false),
              }),
            )
          : credentials.passwordHash !== null &&
            (yield* verifyPassword(reauth.password, credentials.passwordHash)) &&
            (credentials.totpSecretCiphertext === null ||
              (reauth.totpCode !== undefined &&
                (yield* acceptTotpCode(
                  user.userId,
                  credentials.totpSecretCiphertext,
                  reauth.totpCode,
                ))));
    if (!verified) {
      if (reauth !== undefined) yield* recordFailure(keys);
      return yield* stepUpRefused;
    }
    throttle.reset(keys);
  });

  const confirmLinkStepUp: UserDirectory["Service"]["confirmLinkStepUp"] = Effect.fn(
    "UserDirectory.confirmLinkStepUp",
  )(function* (actor, reauth) {
    const user = yield* requireAccount(actor.userId);
    if ((yield* identityOf(user.userId)) !== undefined) {
      return yield* new AccountChangeRefusedError({
        reason: "This account already signs in with Keycloak.",
      });
    }
    const credentials = yield* users.getCredentials(user.userId).pipe(storage);
    switch (keycloakLinkOf(user, credentials)) {
      case "needs-reset":
        return yield* new AccountChangeRefusedError({
          reason: "Ask the Owner for a reset link to connect Keycloak to this account.",
        });
      case "admins-later":
        return yield* new AccountChangeRefusedError({
          reason: "Connecting Keycloak is available soon for Admins.",
        });
      case "allowed":
        break;
    }
    // The account has a passkey or password, so a missing or wrong proof is refused (and counted).
    yield* requireStepUp(actor, user, reauth);
    return toAuthUser(user);
  });

  const confirmStrongFactor: UserDirectory["Service"]["confirmStrongFactor"] = Effect.fn(
    "UserDirectory.confirmStrongFactor",
  )(function* (actor, reauth) {
    const user = yield* requireAccount(actor.userId);
    const credentials = yield* users.getCredentials(actor.userId).pipe(storage);
    const strong =
      reauth !== undefined &&
      (reauth.method === "passkey"
        ? credentials.hasPasskey
        : credentials.passwordHash !== null &&
          credentials.totpSecretCiphertext !== null &&
          reauth.totpCode !== undefined);
    if (!strong) {
      return yield* new AccountChangeRefusedError({
        reason: "Confirm with your passkey, or with your password and a code from your app.",
      });
    }
    yield* requireStepUp(actor, user, reauth);
  });

  // A credential change ends every other session and unspent link, which may belong to whoever
  // took the old one.
  const signOutOtherSessions = (actor: AccountActor) =>
    sessions
      .revokeAllForUser(actor.userId, { except: actor.sessionId })
      .pipe(Effect.andThen(pairingLinks.revokeAllForUser(actor.userId)), storage);

  const setPassword: UserDirectory["Service"]["setPassword"] = Effect.fn(
    "UserDirectory.setPassword",
  )(function* (actor, input) {
    const user = yield* requireAccount(actor.userId);
    yield* refuseLocalCredentialsForIdentity(user);
    const credentials = yield* users.getCredentials(actor.userId).pipe(storage);
    if (passwordRequiresTotp(user, credentials) && credentials.totpSecretCiphertext === null) {
      return yield* new AccountChangeRefusedError({
        reason: "Set up an authenticator app first: this account needs a code with its password.",
      });
    }
    yield* requireStepUp(actor, user, input.reauth);
    const passwordHash = yield* hashPassword(input.password);
    const saved = yield* users
      .setPassword({
        userId: actor.userId,
        loginName: normalizeLoginName(input.loginName),
        passwordHash,
        updatedAt: yield* DateTime.now,
      })
      .pipe(storage);
    if (!saved) {
      return yield* new LoginNameTakenError({});
    }
    yield* signOutOtherSessions(actor);
    return yield* accountOf(yield* requireAccount(actor.userId));
  });

  const removePassword: UserDirectory["Service"]["removePassword"] = Effect.fn(
    "UserDirectory.removePassword",
  )(function* (actor, reauth) {
    const user = yield* requireAccount(actor.userId);
    yield* requireStepUp(actor, user, reauth);
    const credentials = yield* users.getCredentials(actor.userId).pipe(storage);
    if (!credentials.hasPasskey) {
      return yield* new AccountChangeRefusedError({
        reason: "Your password is your only way to sign in. Add a passkey before removing it.",
      });
    }
    yield* users.removePassword(actor.userId).pipe(storage);
    yield* signOutOtherSessions(actor);
    return yield* accountOf(user);
  });

  const removeTotp: UserDirectory["Service"]["removeTotp"] = Effect.fn("UserDirectory.removeTotp")(
    function* (actor, reauth) {
      const user = yield* requireAccount(actor.userId);
      yield* requireStepUp(actor, user, reauth);
      const credentials = yield* users.getCredentials(actor.userId).pipe(storage);
      if (passwordRequiresTotp(user, credentials) && credentials.passwordHash !== null) {
        return yield* new AccountChangeRefusedError({
          reason: "Remove your password first: this account cannot use a password without a code.",
        });
      }
      if (!credentials.hasPasskey && credentials.passwordHash === null) {
        return yield* new AccountChangeRefusedError({
          reason: "Your authenticator app is part of your only way to sign in.",
        });
      }
      yield* users.removeTotp(actor.userId).pipe(storage);
      yield* signOutOtherSessions(actor);
      return yield* accountOf(user);
    },
  );

  const startTotpEnrollment: UserDirectory["Service"]["startTotpEnrollment"] = Effect.fn(
    "UserDirectory.startTotpEnrollment",
  )(function* (userId) {
    const user = yield* requireAccount(userId);
    yield* refuseLocalCredentialsForIdentity(user);
    const secret = yield* AccountCredentials.generateTotpSecret.pipe(withCrypto);
    const enrollmentId = yield* random.uuidV4();
    const now = yield* DateTime.now;
    yield* totpEnrollments.put(
      enrollmentId,
      {
        userId,
        secret,
        expiresAt: DateTime.add(now, { milliseconds: Duration.toMillis(TOTP_ENROLLMENT_TTL) }),
      },
      now,
    );
    return {
      enrollmentId,
      ...AccountCredentials.totpEnrollment(secret, user.loginName ?? user.displayName),
    };
  });

  const confirmTotpEnrollment: UserDirectory["Service"]["confirmTotpEnrollment"] = Effect.fn(
    "UserDirectory.confirmTotpEnrollment",
  )(function* (actor, input) {
    const user = yield* requireAccount(actor.userId);
    yield* refuseLocalCredentialsForIdentity(user);
    const now = yield* DateTime.now;
    const pending = yield* totpEnrollments.get(input.enrollmentId, now);
    if (pending === undefined || pending.userId !== actor.userId) {
      return yield* new AccountChangeRefusedError({
        reason: "This setup expired. Start again to get a new code.",
      });
    }
    yield* requireStepUp(actor, user, input.reauth);
    const step = yield* AccountCredentials.matchTotpStep(
      pending.secret,
      input.code,
      DateTime.toEpochMillis(now),
    ).pipe(withCrypto);
    if (step === undefined) {
      return yield* new AccountChangeRefusedError({
        reason: "That code did not match. Check the time on your device and try again.",
      });
    }
    const secretCiphertext = yield* credentialKey.pipe(
      Effect.flatMap((key) => AccountCredentials.seal(key, pending.secret, actor.userId)),
      withCrypto,
      storage,
    );
    // The enrollment code proves the app works; it is not a sign-in, so no step is spent.
    yield* users
      .setTotp({ userId: actor.userId, secretCiphertext, step: -1, enrolledAt: now })
      .pipe(storage);
    yield* totpEnrollments.delete(input.enrollmentId);
    yield* signOutOtherSessions(actor);
    // A pending Admin becomes one now; their open session keeps working.
    if (Option.isSome(accessChanges)) yield* accessChanges.value.widened;
    return yield* accountOf(user);
  });

  const checkPassword: UserDirectory["Service"]["checkPassword"] = Effect.fn(
    "UserDirectory.checkPassword",
  )(function* (input, clientIp) {
    const found = yield* users.getByLoginName(normalizeLoginName(input.loginName)).pipe(storage);
    const user = Option.getOrUndefined(found);
    // Unknown names count only against the client, so they cannot evict real accounts' counters.
    const keys = throttleKeys(user?.userId, clientIp);
    yield* requireNotThrottled(keys);
    const credentials =
      user === undefined ? undefined : yield* users.getCredentials(user.userId).pipe(storage);
    const hash = credentials?.passwordHash ?? (yield* decoyPasswordHash);
    const passwordMatches =
      (yield* verifyPassword(input.password, hash)) && credentials?.passwordHash != null;
    const inactive = user === undefined ? undefined : inactiveError(user);
    const canSignIn = user !== undefined && inactive === undefined && passwordMatches;
    const totpCiphertext = credentials?.totpSecretCiphertext ?? null;
    if (user !== undefined && totpCiphertext !== null) {
      // The code step comes whether or not the password was right, so this answer alone never
      // confirms a guessed password; a wrong one fails, and counts, at the code step.
      const challengeId = yield* random.uuidV4();
      const now = yield* DateTime.now;
      yield* totpChallenges.put(
        challengeId,
        {
          userId: user.userId,
          passwordOk: canSignIn,
          inactiveWithPassword: inactive !== undefined && passwordMatches,
          clientIp,
          attempts: 0,
          expiresAt: ceremonyExpiry(now),
        },
        now,
      );
      return { _tag: "totp-required", challengeId } as const;
    }
    if (inactive !== undefined && passwordMatches) return yield* inactive;
    if (!canSignIn || credentials === undefined) {
      yield* recordFailure(keys);
      return yield* new PasswordRejectedError({});
    }
    // A rule change (gaining a passkey as an Admin) can leave a password that now needs TOTP.
    // The password was right, so say why instead of counting a guess.
    if (passwordRequiresTotp(user, credentials)) {
      return yield* new SecondFactorMissingError({});
    }
    throttle.reset(keys);
    return { _tag: "verified", user: toAuthUser(user) } as const;
  });

  const checkTotp: UserDirectory["Service"]["checkTotp"] = Effect.fn("UserDirectory.checkTotp")(
    function* (input, clientIp) {
      const now = yield* DateTime.now;
      const challenge = yield* totpChallenges.get(input.challengeId, now);
      if (challenge === undefined) {
        return yield* new PasswordRejectedError({});
      }
      const keys = throttleKeys(challenge.userId, clientIp ?? challenge.clientIp);
      yield* requireNotThrottled(keys);
      challenge.attempts += 1;
      if (challenge.attempts >= MAX_TOTP_ATTEMPTS) {
        yield* totpChallenges.delete(input.challengeId);
      }
      const credentials = yield* users.getCredentials(challenge.userId).pipe(storage);
      // Re-read now: the Owner may have disabled the account since the password step. When both
      // factors were right, say so without counting a failure.
      const record = yield* users.getById(challenge.userId).pipe(storage);
      const inactive = Option.isSome(record) ? inactiveError(record.value) : undefined;
      if (
        inactive !== undefined &&
        (challenge.passwordOk || challenge.inactiveWithPassword) &&
        credentials.totpSecretCiphertext !== null &&
        (yield* acceptTotpCode(challenge.userId, credentials.totpSecretCiphertext, input.code))
      ) {
        yield* totpChallenges.delete(input.challengeId);
        return yield* inactive;
      }
      const user = yield* activeUser(challenge.userId);
      const accepted =
        challenge.passwordOk &&
        Option.isSome(user) &&
        credentials.totpSecretCiphertext !== null &&
        (yield* acceptTotpCode(challenge.userId, credentials.totpSecretCiphertext, input.code));
      if (!accepted || Option.isNone(user)) {
        yield* recordFailure(keys);
        return yield* new PasswordRejectedError({});
      }
      yield* totpChallenges.delete(input.challengeId);
      throttle.reset(keys);
      return toAuthUser(user.value);
    },
  );

  const hashResetToken = (token: string) =>
    digest.digestHex(Digest.sha256, new TextEncoder().encode(token));

  const createResetLink = Effect.fn("UserDirectory.createResetLink")(function* (
    userId: UserId,
    createdBy: UserId | null,
  ) {
    const token = yield* randomBase64Url(32);
    const now = DateTime.toUtc(yield* DateTime.now);
    const expiresAt = DateTime.toUtc(
      DateTime.add(now, { milliseconds: Duration.toMillis(RESET_LINK_TTL) }),
    );
    // Only the newest link works, so an older one left in a terminal's history is harmless.
    yield* users.expireResetLinks({ userId, now }).pipe(storage);
    yield* users
      .createResetLink({
        linkId: yield* random.uuidV4(),
        userId,
        tokenHash: yield* hashResetToken(token),
        createdBy,
        createdAt: now,
        expiresAt,
      })
      .pipe(storage);
    return { token, expiresAt };
  });

  const issueOwnerResetLink: UserDirectory["Service"]["issueOwnerResetLink"] = Effect.fn(
    "UserDirectory.issueOwnerResetLink",
  )(function* () {
    const owner = yield* users.getOwner().pipe(storage);
    if (Option.isNone(owner)) {
      return yield* new NoOwnerError({});
    }
    // Issued from the Hub's shell, not by a signed-in User.
    const link = yield* createResetLink(owner.value.userId, null);
    return { ...link, user: toAuthUser(owner.value) };
  });

  const issueResetLink: UserDirectory["Service"]["issueResetLink"] = Effect.fn(
    "UserDirectory.issueResetLink",
  )(function* ({ userId, createdBy }) {
    const user = yield* activeUser(userId);
    if (Option.isNone(user)) return Option.none();
    return Option.some(yield* createResetLink(userId, createdBy));
  });

  const onPromotedToAdmin: UserDirectory["Service"]["onPromotedToAdmin"] = Effect.fn(
    "UserDirectory.onPromotedToAdmin",
  )(function* (userId) {
    const credentials = yield* users.getCredentials(userId).pipe(storage);
    const hasApp = credentials.totpSecretCiphertext !== null;
    if (!credentials.hasPasskey && !hasApp) return { pending: true, signedOut: false };
    if (hasApp || credentials.passwordHash === null) return { pending: false, signedOut: false };
    yield* sessions.revokeAllForUser(userId).pipe(storage);
    yield* pairingLinks.revokeAllForUser(userId).pipe(storage);
    return { pending: false, signedOut: true };
  });

  const accessChanges = yield* Effect.serviceOption(AccessChanges.AccessChanges);
  const credentialsChanged = (userId: UserId) =>
    Option.match(accessChanges, {
      onNone: () => Effect.void,
      onSome: (changes) => changes.changed([userId]),
    });

  const liveResetLinkUser = Effect.fn("UserDirectory.liveResetLinkUser")(function* (token: string) {
    const userId = yield* users
      .findResetLink({ tokenHash: yield* hashResetToken(token), now: yield* DateTime.now })
      .pipe(storage);
    return Option.isNone(userId) ? Option.none() : yield* activeUser(userId.value);
  });

  const getResetLinkStatus: UserDirectory["Service"]["getResetLinkStatus"] = Effect.fn(
    "UserDirectory.getResetLinkStatus",
  )(function* (token) {
    const user = yield* liveResetLinkUser(token);
    return Option.isSome(user)
      ? ({
          status: "valid",
          displayName: user.value.displayName,
          loginName: user.value.loginName,
          // The Owner's account always needs a passkey or a password with a code.
          passwordAllowed: !user.value.isOwner,
        } as const)
      : ({ status: "invalid" } as const);
  });

  const startResetRegistration: UserDirectory["Service"]["startResetRegistration"] = Effect.fn(
    "UserDirectory.startResetRegistration",
  )(function* ({ token, origin }) {
    const user = yield* liveResetLinkUser(token);
    if (Option.isNone(user)) {
      return yield* new ResetLinkRejectedError({});
    }
    const challenge = yield* randomBase64Url(32);
    const rpId = new URL(origin).hostname;
    const ceremonyId = yield* random.uuidV4();
    const now = yield* DateTime.now;
    const { userId, displayName } = user.value;
    yield* resetRegistrations.put(
      ceremonyId,
      {
        challenge,
        origin,
        rpId,
        expiresAt: ceremonyExpiry(now),
        userId,
        displayName,
        tokenHash: yield* hashResetToken(token),
      },
      now,
    );
    return registrationCeremony({ ceremonyId, challenge, rpId, userId, displayName });
  });

  const verifyResetRegistration: UserDirectory["Service"]["verifyResetRegistration"] = Effect.fn(
    "UserDirectory.verifyResetRegistration",
  )(function* (input) {
    const { ceremony, passkey } = yield* verifyRegistration(resetRegistrations, input);
    return {
      userId: ceremony.userId,
      passkey,
      tokenHash: ceremony.tokenHash,
    } satisfies PendingResetPasskey;
  });

  const redeemResetLink: UserDirectory["Service"]["redeemResetLink"] = Effect.fn(
    "UserDirectory.redeemResetLink",
  )(function* ({ token, pending }) {
    const tokenHash = yield* hashResetToken(token);
    if (tokenHash !== pending.tokenHash) {
      return yield* new ResetLinkRejectedError({});
    }
    const now = yield* DateTime.now;
    const userId = yield* users.consumeResetLink({ tokenHash, now }).pipe(storage);
    if (Option.isNone(userId) || userId.value !== pending.userId) {
      return yield* new ResetLinkRejectedError({});
    }
    const user = yield* activeUser(userId.value);
    if (Option.isNone(user)) {
      return yield* new ResetLinkRejectedError({});
    }
    // A reset means the old passkeys are lost or stolen: they stop working, and so does every
    // session they opened.
    yield* users
      .addPasskey({ userId: userId.value, passkey: pending.passkey, createdAt: now })
      .pipe(storage);
    yield* users
      .removePasskeysExcept({ userId: userId.value, credentialId: pending.passkey.credentialId })
      .pipe(storage);
    yield* users.removePassword(userId.value).pipe(storage);
    yield* users.removeTotp(userId.value).pipe(storage);
    // Every way in is replaced, Keycloak's too: the identity and its sign-ins end.
    const identityRemoved = yield* identities
      .unlink(userId.value, DateTime.formatIso(now))
      .pipe(storage);
    yield* sessions.revokeAllForUser(userId.value).pipe(storage);
    yield* pairingLinks.revokeAllForUser(userId.value).pipe(storage);
    return { user: toAuthUser(user.value), identityRemoved } satisfies ResetRedeemed;
  });

  const redeemResetLinkWithPassword: UserDirectory["Service"]["redeemResetLinkWithPassword"] =
    Effect.fn("UserDirectory.redeemResetLinkWithPassword")(function* (input) {
      const live = yield* liveResetLinkUser(input.token);
      if (Option.isNone(live)) return yield* new ResetLinkRejectedError({});
      if (live.value.isOwner) {
        return yield* new AccountChangeRefusedError({
          reason: "The Owner's account resets with a passkey.",
        });
      }
      const passwordHash = yield* hashPassword(input.password);
      const now = DateTime.toUtc(yield* DateTime.now);
      const tokenHash = yield* hashResetToken(input.token);
      const userId = yield* users.consumeResetLink({ tokenHash, now }).pipe(storage);
      if (Option.isNone(userId) || userId.value !== live.value.userId) {
        return yield* new ResetLinkRejectedError({});
      }
      // The old credentials may be what someone else holds: all of them end.
      yield* users.removePasskeysExcept({ userId: userId.value, credentialId: "" }).pipe(storage);
      yield* users.removeTotp(userId.value).pipe(storage);
      const saved = yield* users
        .setPassword({
          userId: userId.value,
          loginName: normalizeLoginName(input.loginName),
          passwordHash,
          updatedAt: now,
        })
        .pipe(storage);
      if (!saved) return yield* new LoginNameTakenError({});
      // Every way in is replaced, Keycloak's too: the identity and its sign-ins end.
      const identityRemoved = yield* identities
        .unlink(userId.value, DateTime.formatIso(now))
        .pipe(storage);
      yield* sessions.revokeAllForUser(userId.value).pipe(storage);
      yield* pairingLinks.revokeAllForUser(userId.value).pipe(storage);
      return { user: toAuthUser(live.value), identityRemoved } satisfies ResetRedeemed;
    });

  const startInviteeRegistration: UserDirectory["Service"]["startInviteeRegistration"] = Effect.fn(
    "UserDirectory.startInviteeRegistration",
  )(function* ({ displayName, origin, tokenHash }) {
    const userId = UserId.make(yield* random.uuidV4());
    const challenge = yield* randomBase64Url(32);
    const rpId = new URL(origin).hostname;
    const ceremonyId = yield* random.uuidV4();
    const now = yield* DateTime.now;
    yield* inviteeRegistrations.put(
      ceremonyId,
      { challenge, origin, rpId, expiresAt: ceremonyExpiry(now), userId, displayName, tokenHash },
      now,
    );
    return registrationCeremony({ ceremonyId, challenge, rpId, userId, displayName });
  });

  const verifyInviteeRegistration: UserDirectory["Service"]["verifyInviteeRegistration"] =
    Effect.fn("UserDirectory.verifyInviteeRegistration")(function* (input) {
      const { ceremony, passkey } = yield* verifyRegistration(inviteeRegistrations, input);
      return {
        userId: ceremony.userId,
        displayName: ceremony.displayName,
        tokenHash: ceremony.tokenHash,
        passkey,
        password: null,
        totpSecretCiphertext: null,
        totpStep: null,
      } satisfies PendingInvitee;
    });

  const startInviteeTotpEnrollment: UserDirectory["Service"]["startInviteeTotpEnrollment"] =
    Effect.fn("UserDirectory.startInviteeTotpEnrollment")(function* ({ tokenHash, label }) {
      const secret = yield* AccountCredentials.generateTotpSecret.pipe(withCrypto);
      const enrollmentId = yield* random.uuidV4();
      const now = yield* DateTime.now;
      yield* inviteeTotpEnrollments.put(
        enrollmentId,
        {
          tokenHash,
          secret,
          expiresAt: DateTime.add(now, { milliseconds: Duration.toMillis(TOTP_ENROLLMENT_TTL) }),
        },
        now,
      );
      return { enrollmentId, ...AccountCredentials.totpEnrollment(secret, label) };
    });

  const prepareInviteePassword: UserDirectory["Service"]["prepareInviteePassword"] = Effect.fn(
    "UserDirectory.prepareInviteePassword",
  )(function* (input) {
    const loginName = normalizeLoginName(input.loginName);
    const userId = UserId.make(yield* random.uuidV4());
    let totpSecretCiphertext: string | null = null;
    let totpStep: number | null = null;
    if (input.totp !== undefined) {
      const now = yield* DateTime.now;
      const pending = yield* inviteeTotpEnrollments.get(input.totp.enrollmentId, now);
      if (pending === undefined || pending.tokenHash !== input.tokenHash) {
        return yield* new AccountChangeRefusedError({
          reason: "This authenticator setup expired. Start it again to get a new code.",
        });
      }
      const step = yield* AccountCredentials.matchTotpStep(
        pending.secret,
        input.totp.code,
        DateTime.toEpochMillis(now),
      ).pipe(withCrypto);
      if (step === undefined) {
        return yield* new AccountChangeRefusedError({
          reason: "That code did not match. Check the time on your device and try again.",
        });
      }
      totpStep = step;
      totpSecretCiphertext = yield* credentialKey.pipe(
        Effect.flatMap((key) => AccountCredentials.seal(key, pending.secret, userId)),
        withCrypto,
        storage,
      );
    }
    // Only after the code checks out, so the answer is no free probe of which names exist.
    if (Option.isSome(yield* users.getByLoginName(loginName).pipe(storage))) {
      return yield* new LoginNameTakenError({});
    }
    return {
      userId,
      displayName: input.displayName,
      tokenHash: input.tokenHash,
      passkey: null,
      password: { loginName, passwordHash: yield* hashPassword(input.password) },
      totpSecretCiphertext,
      totpStep,
    } satisfies PendingInvitee;
  });

  const createInvitedUser: UserDirectory["Service"]["createInvitedUser"] = Effect.fn(
    "UserDirectory.createInvitedUser",
  )(function* (pending) {
    const created = yield* users
      .createUser({
        userId: pending.userId,
        displayName: pending.displayName,
        createdAt: yield* DateTime.now,
        passkey: pending.passkey,
        password: pending.password,
        totp:
          pending.totpSecretCiphertext === null
            ? null
            : {
                secretCiphertext: pending.totpSecretCiphertext,
                lastUsedStep: pending.totpStep ?? -1,
              },
      })
      .pipe(storage);
    if (!created) return yield* new LoginNameTakenError({});
    return { id: pending.userId, displayName: pending.displayName, isOwner: false };
  });

  const createIdentityUser: UserDirectory["Service"]["createIdentityUser"] = Effect.fn(
    "UserDirectory.createIdentityUser",
  )(function* (displayName) {
    const userId = UserId.make(yield* random.uuidV4());
    const created = yield* users
      .createUser({
        userId,
        displayName,
        createdAt: yield* DateTime.now,
        passkey: null,
        password: null,
        totp: null,
      })
      .pipe(storage);
    // Without a sign-in name nothing can conflict; a false here is the database lying.
    if (!created) return yield* new UserDirectoryStorageError({ cause: "user row not created" });
    return { id: userId, displayName, isOwner: false };
  });

  const hasStrongSignIn: UserDirectory["Service"]["hasStrongSignIn"] = Effect.fn(
    "UserDirectory.hasStrongSignIn",
  )(function* (userId) {
    const credentials = yield* users.getCredentials(userId).pipe(storage);
    return credentials.hasPasskey || credentials.totpSecretCiphertext !== null;
  });

  const requireClientNotThrottled: UserDirectory["Service"]["requireClientNotThrottled"] = (
    clientIp,
  ) => requireNotThrottled(throttleKeys(undefined, clientIp));
  const recordClientSignInFailure: UserDirectory["Service"]["recordClientSignInFailure"] = (
    clientIp,
  ) => recordFailure(throttleKeys(undefined, clientIp));

  return UserDirectory.of({
    confirmLinkStepUp,
    requireClientNotThrottled,
    recordClientSignInFailure,
    startInviteeRegistration,
    verifyInviteeRegistration,
    startInviteeTotpEnrollment,
    prepareInviteePassword,
    createInvitedUser,
    createIdentityUser,
    hasStrongSignIn,
    issueResetLink,
    onPromotedToAdmin,
    credentialsChanged,
    redeemResetLinkWithPassword,
    hasOwner: Effect.fn("UserDirectory.hasOwner")(function () {
      return users.hasOwner().pipe(storage);
    }),
    ownerId: Effect.fn("UserDirectory.ownerId")(function () {
      return users.getOwner().pipe(Effect.map(Option.map((owner) => owner.userId)), storage);
    }),
    findUser: Effect.fn("UserDirectory.findUser")(function (userId: UserId) {
      return users.getById(userId).pipe(Effect.map(Option.map(toAuthUser)), storage);
    }),
    displayNames: Effect.fn("UserDirectory.displayNames")(function (
      userIds: ReadonlyArray<UserId>,
    ) {
      return users.getByIds(userIds).pipe(
        Effect.map((found) => new Map(found.map((user) => [user.userId, user.displayName]))),
        storage,
      );
    }),
    findActiveUser: Effect.fn("UserDirectory.findActiveUser")(function (userId: UserId) {
      return activeUser(userId).pipe(Effect.map(Option.map(toAuthUser)));
    }),
    inactiveReason: Effect.fn("UserDirectory.inactiveReason")(function* (userId: UserId) {
      const record = yield* users.getById(userId).pipe(storage);
      return Option.isSome(record) ? inactiveError(record.value) : undefined;
    }),
    findActiveUserByName: Effect.fn("UserDirectory.findActiveUserByName")(function* (
      loginNameOrId: string,
    ) {
      if (loginNameOrId.trim().length === 0) return Option.none<AuthUser>();
      const byName = yield* users.getByLoginName(normalizeLoginName(loginNameOrId)).pipe(storage);
      const userId = Option.isSome(byName)
        ? byName.value.userId
        : UserId.make(loginNameOrId.trim());
      return yield* activeUser(userId).pipe(Effect.map(Option.map(toAuthUser)));
    }),
    startOwnerRegistration,
    verifyOwnerRegistration,
    createOwner,
    startPasskeySignIn,
    finishPasskeySignIn,
    redeemRecoveryCode,
    getAccount,
    setPassword,
    removePassword,
    startTotpEnrollment,
    confirmTotpEnrollment,
    removeTotp,
    confirmStrongFactor,
    checkPassword,
    checkTotp,
    issueOwnerResetLink,
    getResetLinkStatus,
    startResetRegistration,
    verifyResetRegistration,
    redeemResetLink,
  });
});

export const layer = Layer.effect(UserDirectory, make).pipe(
  Layer.provideMerge(Users.layer),
  Layer.provideMerge(UserIdentities.layer),
);
