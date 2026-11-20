/**
 * The admission table (Keycloak sign-in spec, «Admisión», ticket 03): every row, every mode, both
 * intents. A new rule is a new row here and in `RULES`.
 */
import { type RegistrationMode, type SpaceRole, UserId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import {
  type AdmissionInput,
  type AdmissionOutcome,
  cleanClaimText,
  decide,
  DISPLAY_NAME_MAX,
  identityLabel,
  type IdentityState,
  type InvitationState,
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

/** One row of the spec's table: the same facts in each mode, and what each mode answers. */
interface Row {
  readonly name: string;
  readonly intent: AdmissionInput["intent"];
  readonly identity: IdentityState;
  readonly invitation: InvitationState;
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
      loginStrong: row.loginStrong ?? false,
    });
    assert.deepEqual(outcome, row[mode]);
  });

  it("every input the callback can build matches a row of the table, never the fallback", () => {
    const identities = [unknown, active, disabled, removed];
    const used = new Set<string>();
    for (const mode of MODES) {
      for (const identity of identities) {
        for (const loginStrong of [false, true]) {
          const inputs: ReadonlyArray<AdmissionInput> = [
            { mode, intent: "sign-in", identity, invitation: none, loginStrong },
            ...[invalid, organization("admin"), organization("member"), organization("guest")].map(
              (invitation): AdmissionInput => ({
                mode,
                intent: "invitation",
                identity,
                invitation,
                loginStrong,
              }),
            ),
          ];
          for (const input of inputs) {
            const rule = ruleFor(input);
            assert.isDefined(rule, JSON.stringify(input));
            used.add(rule?.name ?? "");
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
