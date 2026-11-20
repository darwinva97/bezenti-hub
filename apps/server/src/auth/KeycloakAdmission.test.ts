/**
 * The admission table (Keycloak sign-in spec, «Admisión», ticket 03): every row, every mode, both
 * intents, and the strong-factor rule for the Owner, Admins and Members (ticket 06). A new rule is
 * a new row here and in `RULES`.
 */
import { type RegistrationMode, type SpaceRole, UserId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import {
  type AdmissionInput,
  type AdmissionOutcome,
  authTimeOf,
  cleanClaimText,
  decide,
  DISPLAY_NAME_MAX,
  identityLabel,
  type IdentityState,
  type InvitationState,
  loginEvidence,
  loginIsStrong,
  newUserDisplayName,
  ruleFor,
  RULES,
} from "./KeycloakAdmission.ts";

const userId = UserId.make("user-1");
const unknown: IdentityState = { kind: "unknown" };
const active: IdentityState = { kind: "active", userId };
const disabled: IdentityState = { kind: "inactive", userId, removed: false };
const removed: IdentityState = { kind: "inactive", userId, removed: true };
const none: InvitationState = { kind: "none" };
const invalid: InvitationState = { kind: "invalid" };
const organization = (role: SpaceRole): InvitationState => ({ kind: "organization", role });

const enter: AdmissionOutcome = { kind: "enter" };
const join: AdmissionOutcome = { kind: "enter-and-join" };
const createUser: AdmissionOutcome = { kind: "create-user" };
const createAndJoin: AdmissionOutcome = { kind: "create-user-and-join" };
const refuse = (reason: string) => ({ kind: "refuse", reason }) as AdmissionOutcome;

/** The identity's User, for who needs a strong factor: by default a Member (or nobody yet). */
type Standing = "owner" | "admin" | "member";

/** As the callback reads it: the Owner, an Admin, or who the Invitation makes an Admin. */
const requiresStrongFor = (standing: Standing, invitation: InvitationState) =>
  standing !== "member" || (invitation.kind === "organization" && invitation.role === "admin");

/** One row of the spec's table: the same facts in each mode, and what each mode answers. */
interface Row {
  readonly name: string;
  readonly intent: AdmissionInput["intent"];
  readonly identity: IdentityState;
  readonly invitation: InvitationState;
  readonly standing?: Standing;
  readonly loginStrong?: boolean;
  readonly open: AdmissionOutcome;
  readonly "invitation-only": AdmissionOutcome;
  readonly closed: AdmissionOutcome;
}

const TABLE: ReadonlyArray<Row> = [
  {
    name: "an active User signs in",
    intent: "sign-in",
    identity: active,
    invitation: none,
    open: enter,
    "invitation-only": enter,
    closed: enter,
  },
  {
    name: "an active User accepts an Organization Invitation",
    intent: "invitation",
    identity: active,
    invitation: organization("member"),
    open: join,
    "invitation-only": join,
    closed: join,
  },
  {
    // `join` gives today's refusal for a dead link, after signing them in.
    name: "an active User with an Invitation no longer valid",
    intent: "invitation",
    identity: active,
    invitation: invalid,
    open: join,
    "invitation-only": join,
    closed: join,
  },
  {
    name: "a disabled User signs in",
    intent: "sign-in",
    identity: disabled,
    invitation: none,
    open: refuse("disabled"),
    "invitation-only": refuse("disabled"),
    closed: refuse("disabled"),
  },
  {
    name: "a removed User signs in",
    intent: "sign-in",
    identity: removed,
    invitation: none,
    open: refuse("removed"),
    "invitation-only": refuse("removed"),
    closed: refuse("removed"),
  },
  {
    name: "a disabled User with an Invitation",
    intent: "invitation",
    identity: disabled,
    invitation: organization("member"),
    open: refuse("disabled"),
    "invitation-only": refuse("disabled"),
    closed: refuse("disabled"),
  },
  {
    name: "a new identity with an Organization Invitation",
    intent: "invitation",
    identity: unknown,
    invitation: organization("member"),
    open: createAndJoin,
    "invitation-only": createAndJoin,
    closed: refuse("registration-closed"),
  },
  {
    name: "a new identity with a Guest Invitation",
    intent: "invitation",
    identity: unknown,
    invitation: organization("guest"),
    open: createAndJoin,
    "invitation-only": createAndJoin,
    closed: refuse("registration-closed"),
  },
  {
    name: "a new identity with an Admin Invitation and a weak login",
    intent: "invitation",
    identity: unknown,
    invitation: organization("admin"),
    open: refuse("strong-factor-required"),
    "invitation-only": refuse("strong-factor-required"),
    closed: refuse("registration-closed"),
  },
  {
    name: "a new identity with an Admin Invitation and a strong login",
    intent: "invitation",
    identity: unknown,
    invitation: organization("admin"),
    loginStrong: true,
    open: createAndJoin,
    "invitation-only": createAndJoin,
    closed: refuse("registration-closed"),
  },
  {
    name: "a new identity with an Invitation no longer valid",
    intent: "invitation",
    identity: unknown,
    invitation: invalid,
    open: refuse("invitation-invalid"),
    "invitation-only": refuse("invitation-invalid"),
    closed: refuse("invitation-invalid"),
  },
  {
    name: "a new identity with nothing",
    intent: "sign-in",
    identity: unknown,
    invitation: none,
    open: createUser,
    "invitation-only": refuse("invitation-only"),
    closed: refuse("registration-closed"),
  },
  // Ticket 06: the Owner and Admins need a strong Keycloak sign-in; Members don't.
  {
    name: "the Owner signs in without a strong factor",
    intent: "sign-in",
    identity: active,
    invitation: none,
    standing: "owner",
    open: refuse("strong-factor-required"),
    "invitation-only": refuse("strong-factor-required"),
    closed: refuse("strong-factor-required"),
  },
  {
    name: "the Owner signs in with a strong factor",
    intent: "sign-in",
    identity: active,
    invitation: none,
    standing: "owner",
    loginStrong: true,
    open: enter,
    "invitation-only": enter,
    closed: enter,
  },
  {
    name: "an Admin signs in without a strong factor",
    intent: "sign-in",
    identity: active,
    invitation: none,
    standing: "admin",
    open: refuse("strong-factor-required"),
    "invitation-only": refuse("strong-factor-required"),
    closed: refuse("strong-factor-required"),
  },
  {
    name: "an Admin signs in with a strong factor",
    intent: "sign-in",
    identity: active,
    invitation: none,
    standing: "admin",
    loginStrong: true,
    open: enter,
    "invitation-only": enter,
    closed: enter,
  },
  {
    name: "a Member signs in with a strong factor",
    intent: "sign-in",
    identity: active,
    invitation: none,
    loginStrong: true,
    open: enter,
    "invitation-only": enter,
    closed: enter,
  },
  {
    name: "a Member accepts an Admin Invitation without a strong factor",
    intent: "invitation",
    identity: active,
    invitation: organization("admin"),
    open: refuse("strong-factor-required"),
    "invitation-only": refuse("strong-factor-required"),
    closed: refuse("strong-factor-required"),
  },
  {
    name: "a Member accepts an Admin Invitation with a strong factor",
    intent: "invitation",
    identity: active,
    invitation: organization("admin"),
    loginStrong: true,
    open: join,
    "invitation-only": join,
    closed: join,
  },
  {
    name: "an Admin accepts a Member Invitation without a strong factor",
    intent: "invitation",
    identity: active,
    invitation: organization("member"),
    standing: "admin",
    open: refuse("strong-factor-required"),
    "invitation-only": refuse("strong-factor-required"),
    closed: refuse("strong-factor-required"),
  },
  {
    // Checked first: the answer for a disabled account is the same, whatever its sign-in.
    name: "a disabled Admin signs in without a strong factor",
    intent: "sign-in",
    identity: disabled,
    invitation: none,
    standing: "admin",
    open: refuse("disabled"),
    "invitation-only": refuse("disabled"),
    closed: refuse("disabled"),
  },
];

const MODES: ReadonlyArray<RegistrationMode> = ["open", "invitation-only", "closed"];

/** Each row once per mode: the facts, the mode and what that mode answers. */
const CASES = TABLE.flatMap((row) =>
  MODES.map((mode) => ({ name: `${row.name}, ${mode}`, row, mode })),
);

describe("KeycloakAdmission.decide", () => {
  it.each(CASES)("$name", ({ row, mode }) => {
    const outcome = decide({
      mode,
      intent: row.intent,
      identity: row.identity,
      invitation: row.invitation,
      requiresStrong: requiresStrongFor(row.standing ?? "member", row.invitation),
      loginStrong: row.loginStrong ?? false,
    });
    assert.deepEqual(outcome, row[mode]);
  });

  it("every input the callback can build matches a row of the table, never the fallback", () => {
    const identities = [unknown, active, disabled, removed];
    const used = new Set<string>();
    for (const mode of MODES) {
      for (const identity of identities) {
        // Only an existing User has a standing; a new identity is nobody yet.
        const standings: ReadonlyArray<Standing> =
          identity.kind === "unknown" ? ["member"] : ["owner", "admin", "member"];
        for (const standing of standings) {
          for (const loginStrong of [false, true]) {
            const inputs: ReadonlyArray<AdmissionInput> = [
              {
                mode,
                intent: "sign-in",
                identity,
                invitation: none,
                requiresStrong: requiresStrongFor(standing, none),
                loginStrong,
              },
              ...[
                invalid,
                organization("admin"),
                organization("member"),
                organization("guest"),
              ].map((invitation): AdmissionInput => ({
                mode,
                intent: "invitation",
                identity,
                invitation,
                requiresStrong: requiresStrongFor(standing, invitation),
                loginStrong,
              })),
            ];
            for (const input of inputs) {
              const rule = ruleFor(input);
              assert.isDefined(rule, JSON.stringify(input));
              used.add(rule?.name ?? "");
            }
          }
        }
      }
    }
    // And no row is dead.
    assert.sameMembers(
      [...used],
      RULES.map((rule) => rule.name),
    );
  });
});

describe("a strong Keycloak sign-in (ticket 06)", () => {
  const lists = { strongAcr: ["critica"], strongAmr: ["otp", "webauthn"] };
  const strong = (claims: { readonly acr?: unknown; readonly amr?: unknown }, using = lists) =>
    loginIsStrong(loginEvidence(claims), using);

  it("is an `acr` in the Owner's list, or an `amr` value in the other", () => {
    assert.isTrue(strong({ acr: "critica" }));
    assert.isTrue(strong({ acr: "basico", amr: ["pwd", "otp"] }));
    assert.isTrue(strong({ amr: ["webauthn"] }));
    assert.isFalse(strong({ acr: "basico", amr: ["pwd"] }));
    assert.isFalse(strong({}));
  });

  it("matches whole values only: no prefix, part, other case or padding", () => {
    for (const acr of ["critic", "criticas", "Critica", " critica", "critica ", "xcritica"]) {
      assert.isFalse(strong({ acr }), acr);
    }
    for (const value of ["ot", "otp2", "OTP", "web", "webauthn-x"]) {
      assert.isFalse(strong({ amr: [value] }), value);
    }
    // A value is matched as itself, never split: "otp webauthn" is not two values.
    assert.isFalse(strong({ amr: ["otp webauthn"] }));
    assert.isFalse(strong({ acr: "critica basico" }));
  });

  it("without lists, no sign-in is strong", () => {
    const empty = { strongAcr: [], strongAmr: [] };
    assert.isFalse(strong({ acr: "critica", amr: ["otp"] }, empty));
    assert.isFalse(strong({ acr: "", amr: [""] }, empty));
  });

  it("an odd claim counts as absent, never as strong", () => {
    // `amr` must be an array; a lone string, a number or an object is no list of methods.
    assert.isFalse(strong({ amr: "otp" }));
    assert.isFalse(strong({ amr: { otp: true } }));
    assert.isFalse(strong({ acr: ["critica"] }));
    assert.isFalse(strong({ acr: 1 }));
    // Non-strings inside `amr` are skipped; the strings beside them still count.
    assert.isTrue(strong({ amr: [1, null, "otp"] }));
    // A value longer than a list entry may be is never kept.
    assert.deepEqual(loginEvidence({ acr: "x".repeat(101), amr: ["y".repeat(101)] }), {
      acr: null,
      amr: [],
    });
  });

  it("`auth_time` is a positive whole number of seconds, or absent", () => {
    assert.equal(authTimeOf({ auth_time: 1_700_000_000 }), 1_700_000_000);
    assert.isUndefined(authTimeOf({}));
    assert.isUndefined(authTimeOf({ auth_time: "1700000000" }));
    assert.isUndefined(authTimeOf({ auth_time: 1.5 }));
    assert.isUndefined(authTimeOf({ auth_time: -1 }));
  });
});

describe("a new User's display name", () => {
  it("is `name`, else `preferred_username`, cleaned and capped", () => {
    assert.equal(
      newUserDisplayName({ name: "  Grace   Hopper ", preferred_username: "g" }),
      "Grace Hopper",
    );
    assert.equal(newUserDisplayName({ preferred_username: "grace" }), "grace");
    assert.equal(newUserDisplayName({ name: "\u0000​ ", preferred_username: "grace" }), "grace");
    assert.equal(newUserDisplayName({}), "Keycloak user");
    // Bidi overrides and other control characters never reach a name another person reads.
    assert.equal(newUserDisplayName({ name: "Ada‮gnp.exe\u0007\n" }), "Adagnp.exe");
    const long = newUserDisplayName({ name: "x".repeat(500) });
    assert.equal([...long].length, DISPLAY_NAME_MAX);
    // Emoji count as one character each, and are never cut in half.
    assert.equal([...newUserDisplayName({ name: "😀".repeat(100) })].length, DISPLAY_NAME_MAX);
  });

  it("an identity's labels are cleaned the same way, or null", () => {
    assert.equal(identityLabel("gra‮ce\r\n"), "grace");
    assert.isNull(identityLabel("​"));
    assert.isNull(identityLabel(undefined));
    assert.equal(cleanClaimText("a\tb", 10), "a b");
  });
});
