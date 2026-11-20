/**
 * Who a verified Keycloak identity becomes (Keycloak sign-in spec, «Admisión»), and whether its
 * sign-in is strong («Factor fuerte», ticket 06): pure, no I/O. The spec's table, one row per
 * rule, first match wins; a new rule (Platform invitations, mapped groups) is a new row.
 */
import {
  MAX_CLAIM_LENGTH,
  MAX_STRONG_VALUES,
  type RegistrationMode,
  type SpaceRole,
  type UserId,
} from "@t3tools/contracts";

/** The identity (issuer + `sub`, never an email) as the Hub knows it. */
export type IdentityState =
  | { readonly kind: "unknown" }
  | { readonly kind: "active"; readonly userId: UserId }
  | { readonly kind: "inactive"; readonly userId: UserId; readonly removed: boolean };

/** The Invitation the flow carries, as read when the browser came back. */
export type InvitationState =
  | { readonly kind: "none" }
  /** Unknown, expired, revoked, used or into an archived Organization: all alike. */
  | { readonly kind: "invalid" }
  | { readonly kind: "organization"; readonly role: SpaceRole };

export type AdmissionIntent = "sign-in" | "invitation";

export interface AdmissionInput {
  readonly mode: RegistrationMode;
  readonly intent: AdmissionIntent;
  readonly identity: IdentityState;
  readonly invitation: InvitationState;
  /**
   * Whether a mapped Keycloak group of theirs gives them a Membership (ticket 05): for a new
   * identity, a permanent Invitation the Owner set up on purpose.
   */
  readonly mappedGroup: boolean;
  /**
   * Whether the result needs a strong factor: the identity's User is the Owner or an Admin (after
   * the group mapping, ticket 05), or the Invitation makes them one.
   */
  readonly requiresStrong: boolean;
  /** Whether this login counts as a strong factor (`loginIsStrong`). */
  readonly loginStrong: boolean;
}

export type AdmissionRefusal =
  | "disabled"
  | "removed"
  | "invitation-only"
  | "registration-closed"
  | "invitation-invalid"
  | "strong-factor-required";

export type AdmissionOutcome =
  /** Sign the identity's User in. */
  | { readonly kind: "enter" }
  /** Sign the User in, then join the Invitation's Organization as `/api/invitations/join` does. */
  | { readonly kind: "enter-and-join" }
  /** A new User, without any Organization. */
  | { readonly kind: "create-user" }
  /** A new User and the Invitation's membership, spending it, all in one transaction. */
  | { readonly kind: "create-user-and-join" }
  | { readonly kind: "refuse"; readonly reason: AdmissionRefusal };

export interface AdmissionRule {
  /** Names the row, for the table's tests and a debug log. */
  readonly name: string;
  readonly when: (input: AdmissionInput) => boolean;
  readonly outcome: (input: AdmissionInput) => AdmissionOutcome;
}

const refuse = (reason: AdmissionRefusal): AdmissionOutcome => ({ kind: "refuse", reason });
const isNew = (input: AdmissionInput) => input.identity.kind === "unknown";

/** The spec's admission table for `sign-in` and `invitation`, in order. */
export const RULES: ReadonlyArray<AdmissionRule> = [
  {
    // Checked after the token is verified, so the answer is no oracle for who exists.
    name: "inactive user",
    when: (input) => input.identity.kind === "inactive",
    outcome: (input) =>
      refuse(input.identity.kind === "inactive" && input.identity.removed ? "removed" : "disabled"),
  },
  {
    // Even when registration is open: who came to accept an Invitation gets no empty User.
    name: "new identity, invitation no longer valid",
    when: (input) => isNew(input) && input.invitation.kind === "invalid",
    outcome: () => refuse("invitation-invalid"),
  },
  {
    name: "new identity, organization invitation, registration closed",
    when: (input) =>
      isNew(input) && input.invitation.kind === "organization" && input.mode === "closed",
    outcome: () => refuse("registration-closed"),
  },
  {
    // A mapped group (ticket 05) is a permanent Invitation: see its row below.
    name: "new identity, invitation only",
    when: (input) =>
      isNew(input) &&
      input.invitation.kind === "none" &&
      input.mode === "invitation-only" &&
      !input.mappedGroup,
    outcome: () => refuse("invitation-only"),
  },
  {
    name: "new identity, registration closed",
    when: (input) => isNew(input) && input.invitation.kind === "none" && input.mode === "closed",
    outcome: () => refuse("registration-closed"),
  },
  {
    // The Owner and Admins (or who an Invitation makes one) need a strong factor, as locally
    // they need a passkey or a password with a code. The Owner's local sign-in is untouched.
    name: "strong factor required, weak login",
    when: (input) => input.requiresStrong && !input.loginStrong,
    outcome: () => refuse("strong-factor-required"),
  },
  {
    name: "active user signs in",
    when: (input) => input.identity.kind === "active" && input.intent === "sign-in",
    outcome: () => ({ kind: "enter" }),
  },
  {
    // Whether the Invitation still holds is `join`'s to say, with today's refusals.
    name: "active user accepts an invitation",
    when: (input) => input.identity.kind === "active" && input.intent === "invitation",
    outcome: () => ({ kind: "enter-and-join" }),
  },
  {
    name: "new identity, organization invitation",
    when: (input) => isNew(input) && input.invitation.kind === "organization",
    outcome: () => ({ kind: "create-user-and-join" }),
  },
  {
    name: "new identity, open registration",
    when: (input) => isNew(input) && input.invitation.kind === "none" && input.mode === "open",
    outcome: () => ({ kind: "create-user" }),
  },
  {
    // Ticket 05: the Owner mapped one of their groups on purpose, so «invitation only» admits
    // them, with the group's Memberships. Where registration is closed it does not (above).
    name: "new identity, mapped group, invitation only",
    when: (input) =>
      isNew(input) &&
      input.invitation.kind === "none" &&
      input.mappedGroup &&
      input.mode === "invitation-only",
    outcome: () => ({ kind: "create-user" }),
  },
];

/** The first row that matches; the table covers every input, so the fallback never runs. */
export const ruleFor = (input: AdmissionInput): AdmissionRule | undefined =>
  RULES.find((rule) => rule.when(input));

export const decide = (input: AdmissionInput): AdmissionOutcome =>
  ruleFor(input)?.outcome(input) ?? refuse("registration-closed");

/** What a verified ID token says about how the person authenticated, bounded and cleaned. */
export interface LoginEvidence {
  readonly acr: string | null;
  readonly amr: ReadonlyArray<string>;
}

/** The Owner's lists (`strong_acr`, `strong_amr`). */
export interface StrongLists {
  readonly strongAcr: ReadonlyArray<string>;
  readonly strongAmr: ReadonlyArray<string>;
}

const claimValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_CLAIM_LENGTH
    ? value
    : undefined;

/**
 * `acr` and `amr` from the verified ID token: `acr` only as a string, `amr` only as an array of
 * strings (anything else in it is skipped). A value longer than a list entry may be could never
 * match one, so it is not kept.
 */
export const loginEvidence = (claims: {
  readonly acr?: unknown;
  readonly amr?: unknown;
}): LoginEvidence => ({
  acr: claimValue(claims.acr) ?? null,
  amr: Array.isArray(claims.amr)
    ? [
        ...new Set(
          claims.amr.flatMap((value: unknown) => {
            const kept = claimValue(value);
            return kept === undefined ? [] : [kept];
          }),
        ),
      ].slice(0, MAX_STRONG_VALUES)
    : [],
});

/**
 * A Keycloak sign-in is strong when its `acr` is in `strongAcr` or one of its `amr` values is in
 * `strongAmr`: whole values, case and all, never a prefix or a part. Empty lists: never strong.
 */
export const loginIsStrong = (evidence: LoginEvidence, lists: StrongLists): boolean =>
  (evidence.acr !== null && lists.strongAcr.includes(evidence.acr)) ||
  evidence.amr.some((value) => lists.strongAmr.includes(value));

/** `auth_time` as epoch seconds, or undefined when absent or not a sane number. */
export const authTimeOf = (claims: { readonly auth_time?: unknown }): number | undefined =>
  typeof claims.auth_time === "number" &&
  Number.isSafeInteger(claims.auth_time) &&
  claims.auth_time >= 0
    ? claims.auth_time
    : undefined;

/** The longest display name a new User gets, as an invitee types one. */
export const DISPLAY_NAME_MAX = 80;
/** A Keycloak label (username, email) kept on the identity, as shown in the account. */
const LABEL_MAX = 255;
const FALLBACK_DISPLAY_NAME = "Keycloak user";

/**
 * Printable text from a claim: control and format characters (bidi overrides, zero-width joiners)
 * gone, whitespace runs one space, trimmed, at most `max` characters. Empty when nothing is left.
 */
export const cleanClaimText = (value: string | undefined, max: number): string => {
  if (value === undefined) return "";
  const cleaned = value
    .replace(/\s+/gu, " ")
    .replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cs}]/gu, "")
    .replace(/ {2,}/g, " ")
    .trim();
  return [...cleaned].slice(0, max).join("").trim();
};

/** A new User's display name: `name`, else `preferred_username`; never an email. */
export const newUserDisplayName = (claims: {
  readonly name?: string | undefined;
  readonly preferred_username?: string | undefined;
}): string =>
  cleanClaimText(claims.name, DISPLAY_NAME_MAX) ||
  cleanClaimText(claims.preferred_username, DISPLAY_NAME_MAX) ||
  FALLBACK_DISPLAY_NAME;

/** A label kept on the identity (username, email): cleaned, or null when nothing is left. */
export const identityLabel = (value: string | undefined): string | null =>
  cleanClaimText(value, LABEL_MAX) || null;
