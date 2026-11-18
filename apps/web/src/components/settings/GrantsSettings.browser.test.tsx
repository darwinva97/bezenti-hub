import type { Grant } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { GrantsSettings, groupLentLoans, LendMachineDialog } from "./GrantsSettings";

const loans = vi.hoisted(() => ({
  given: [] as unknown[],
  received: [] as unknown[],
  targets: [] as unknown[],
  phase: "connected" as string,
  listeners: new Set<() => void>(),
  setPhase(next: string) {
    this.phase = next;
    for (const listener of this.listeners) listener();
  },
  failWith: null as unknown,
  listCalls: 0,
  account: { hasPasskey: false, hasPassword: true, totpEnrolled: false } as Record<string, boolean>,
  accepted: [] as Array<{ readonly grantId: string; readonly useAsDefault: boolean | undefined }>,
  vaultUsage: { rows: [], truncated: false } as unknown,
  vaultUsageReads: [] as Array<unknown>,
}));

vi.mock("../../state/environments", async (importOriginal) => {
  const { useSyncExternalStore } = await import("react");
  return {
    ...(await importOriginal<typeof import("../../state/environments")>()),
    usePrimaryEnvironmentId: () => "env-primary",
    useEnvironment: () => {
      const phase = useSyncExternalStore(
        (listener) => {
          loans.listeners.add(listener);
          return () => loans.listeners.delete(listener);
        },
        () => loans.phase,
      );
      return { connection: { phase } };
    },
    usePrimaryEnvironment: () => null,
  };
});
vi.mock("../../environments/primary/grants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../environments/primary/grants")>()),
  acceptGrant: (
    grantId: string,
    _stepUp: unknown,
    options: { readonly useAsDefault?: boolean } = {},
  ) => {
    loans.accepted.push({ grantId, useAsDefault: options.useAsDefault });
    return Promise.resolve({});
  },
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => () => Promise.resolve(),
}));
vi.mock("../../environments/primary/userAccounts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../environments/primary/userAccounts")>()),
  fetchAccount: () => Promise.resolve(loans.account),
}));
vi.mock("../../state/grants", () => ({
  grantsEnvironment: {
    end: { permissionAtom: () => ({}) },
    listGiven: {},
    listReceived: {},
    targets: {},
    reject: {},
    cancel: {},
  },
}));
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: () => true,
}));
vi.mock("../../state/use-atom-command", () => ({
  // The label tells the commands apart; only the two lists and the targets answer here.
  useAtomCommand: (_command: unknown, label: string) => (target?: { readonly input?: unknown }) => {
    if (label === "list your loans") loans.listCalls += 1;
    if (label === "read a loan's use") {
      loans.vaultUsageReads.push(target?.input);
      return Promise.resolve({ _tag: "Success", value: loans.vaultUsage });
    }
    if (loans.failWith !== null && label.startsWith("list your")) {
      return Promise.resolve({ _tag: "Failure", cause: loans.failWith });
    }
    return Promise.resolve({
      _tag: "Success",
      value:
        label === "list where you may lend"
          ? { targets: loans.targets, host: null }
          : { grants: label === "list your loans" ? loans.given : loans.received },
    });
  },
}));
vi.mock("./LoanUsage", () => ({ LoanUsage: () => <p>usage panel</p> }));
vi.mock("./LendAiAccountDialog", () => ({
  ChangeCapsDialog: () => <p>caps dialog</p>,
}));

const grant = (id: string, resourceId: string, name: string, space: string): Grant =>
  ({
    id,
    resource: { kind: "ai-account", id: resourceId, name },
    lender: { kind: "user", id: "user-me", name: "Me" },
    target: { spaceId: `space-${space}`, kind: "organization", name: space },
    state: "active",
    endReason: null,
    limits: { kind: "ai-account", tokens: null, requests: null },
    createdAt: "2026-01-01T00:00:00.000Z",
    decidedAt: null,
    endedAt: null,
    aiAccount: { provider: "claude", type: "api-key" },
    can: { cancel: false, revoke: true, decide: false, return: false, setLimits: true },
  }) as unknown as Grant;

it("groups the loans of one resource into a single header with one line per recipient", () => {
  const groups = groupLentLoans([
    grant("g1", "acct-1", "Claude (me@example.com)", "Zeta"),
    grant("g2", "acct-2", "Codex", "Beta"),
    grant("g3", "acct-1", "Claude (me@example.com)", "Alpha"),
    grant("g4", "acct-1", "Claude (me@example.com)", "Beta"),
  ]);
  expect(groups.map((entry) => [entry.name, entry.loans.length])).toEqual([
    ["Claude (me@example.com)", 3],
    ["Codex", 1],
  ]);
  expect(groups[0]?.loans.map((entry) => entry.target?.name)).toEqual(["Alpha", "Beta", "Zeta"]);
});

it("shows three loans of one account as one group with three recipient lines", async () => {
  loans.given = [
    grant("g1", "acct-1", "Claude (Darwin)", "Bezenti"),
    grant("g2", "acct-1", "Claude (Darwin)", "Eijun"),
    grant("g3", "acct-1", "Claude (Darwin)", "Acme"),
  ];
  await using _screen = await render(<GrantsSettings />);

  await expect.element(page.getByRole("heading", { name: "Lent by you" })).toBeVisible();
  const header = page.getByRole("button", { name: /^Claude \(Darwin\)\s*lent to 3$/ });
  await expect.element(header).toHaveAttribute("aria-expanded", "true");
  const list = page.getByRole("list", { name: "Claude (Darwin) is lent to" });
  await expect.poll(() => list.getByRole("listitem").elements().length).toBe(3);
  await expect.element(page.getByText("Waiting for you")).not.toBeInTheDocument();

  await page.getByRole("button", { name: "Actions for Claude (Darwin) lent to Acme" }).click();
  await expect.element(page.getByRole("menuitem", { name: "View use" })).toBeVisible();
  await expect.element(page.getByRole("menuitem", { name: "Caps…" })).toBeVisible();
  await expect.element(page.getByRole("menuitem", { name: "Take back" })).toBeVisible();

  await userEvent.keyboard("{Escape}");
  await header.click();
  await expect.element(header).toHaveAttribute("aria-expanded", "false");
});

it("shows the Space's name, not its id, in the closed Lend to select", async () => {
  loans.targets = [
    {
      spaceId: "personal:83ad563e-cd0b-4a3f-b140-2c4cbff2f4be",
      kind: "personal",
      name: "Grecia",
      ownerDisplayName: "Grecia Alvarez Garrafa",
      startsActive: false,
    },
  ];
  await using _screen = await render(
    <LendMachineDialog machine={{ id: "env-m", name: "Box" } as never} onClose={() => {}} />,
  );

  const trigger = page.getByRole("combobox", { name: "Lend to" });
  await trigger.click();
  await page.getByRole("option", { name: "Grecia Alvarez Garrafa (personal)" }).click();

  await expect.element(trigger).toHaveTextContent("Grecia Alvarez Garrafa (personal)");
  await expect.element(trigger).not.toHaveTextContent("personal:");
});

const machineGrant = (id: string, state: string, space: string): Grant =>
  ({
    ...grant(id, "env-m", "Box", space),
    resource: { kind: "environment", id: "env-m", name: "Box" },
    state,
    limits: { kind: "environment", cpus: 1, memoryBytes: 1, pids: 1, diskBytes: 1 },
    can: { cancel: false, revoke: true, decide: state === "pending", return: false },
  }) as unknown as Grant;

const resetLoans = () => {
  loans.given = [];
  loans.received = [];
  loans.targets = [];
  loans.phase = "connected";
  loans.failWith = null;
  loans.listCalls = 0;
  loans.account = { hasPasskey: false, hasPassword: true, totpEnrolled: false };
  loans.accepted = [];
};

it("keeps the footer buttons inside the dialog popup, with the body scrolling", async () => {
  resetLoans();
  await using _screen = await render(
    <LendMachineDialog machine={{ id: "env-m", name: "Box" } as never} onClose={() => {}} />,
  );
  const popup = page.getByRole("dialog");
  await expect.element(popup).toBeVisible();
  const popupBox = popup.element().getBoundingClientRect();
  for (const name of ["Cancel", "Lend"]) {
    const button = page.getByRole("button", { name, exact: true });
    await expect.element(button).toBeVisible();
    expect(popup.element().contains(button.element())).toBe(true);
    const box = button.element().getBoundingClientRect();
    expect(box.bottom).toBeLessThanOrEqual(popupBox.bottom + 1);
    expect(box.bottom).toBeLessThanOrEqual(window.innerHeight);
  }
});

it("leaves out of Lend to the Spaces that already have a pending or active loan of the machine", async () => {
  resetLoans();
  loans.targets = ["a", "b", "c"].map((id) => ({
    spaceId: `space-${id.toUpperCase()}`,
    kind: "organization",
    name: id.toUpperCase(),
    startsActive: false,
  }));
  loans.given = [machineGrant("g1", "active", "A"), machineGrant("g2", "rejected", "C")];
  await using _screen = await render(
    <LendMachineDialog machine={{ id: "env-m", name: "Box" } as never} onClose={() => {}} />,
  );
  await page.getByRole("combobox", { name: "Lend to" }).click();
  await expect.element(page.getByRole("option", { name: "B", exact: true })).toBeVisible();
  await expect.element(page.getByRole("option", { name: "C", exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("option", { name: "A", exact: true }))
    .not.toBeInTheDocument();
});

it("loads the loans only once the Hub session is up, and says nothing while it connects", async () => {
  resetLoans();
  loans.given = [grant("g1", "acct-1", "Claude", "Bezenti")];
  loans.phase = "connecting";
  loans.failWith = Cause.fail({
    _tag: "EnvironmentRpcUnavailableError",
    message: "Hub is not connected.",
  });
  await using _screen = await render(<GrantsSettings />);
  await expect.element(page.getByText("Something went wrong")).not.toBeInTheDocument();
  expect(loans.listCalls).toBe(0);

  loans.failWith = null;
  await act(async () => loans.setPhase("connected"));
  await expect.element(page.getByRole("heading", { name: "Lent by you" })).toBeVisible();
});

it("offers Try again on a real error", async () => {
  resetLoans();
  loans.failWith = Cause.fail(new Error("The Hub said no."));
  await using _screen = await render(<GrantsSettings />);
  await expect.element(page.getByText("Something went wrong")).toBeVisible();
  loans.failWith = null;
  loans.given = [grant("g1", "acct-1", "Claude", "Bezenti")];
  await page.getByRole("button", { name: "Try again" }).click();
  await expect.element(page.getByRole("heading", { name: "Lent by you" })).toBeVisible();
  await expect.element(page.getByText("Something went wrong")).not.toBeInTheDocument();
});

it("tells an account with no passkey or authenticator app to add one, and disables Accept", async () => {
  resetLoans();
  loans.received = [machineGrant("g9", "pending", "Eijun")];
  await using _screen = await render(<GrantsSettings />);
  await page.getByRole("button", { name: "Accept…" }).click();
  await expect
    .element(
      page.getByText(
        /To accept a machine, add a passkey or an authenticator app to your account first./,
      ),
    )
    .toBeVisible();
  await expect.element(page.getByRole("button", { name: "Open Settings → Account" })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Confirm and accept" })).toBeDisabled();
  await expect.element(page.getByText("Current password")).not.toBeInTheDocument();
});

// Grants ticket 06: lending links among the loans given, and a subscription's terms when deciding.
it("lists a resource's lending links with why each works or not, and cancels an open one", async () => {
  loans.received = [];
  loans.failWith = null;
  loans.setPhase("connected");
  const link = (id: string, status: "open" | "expired", canCancel: boolean): Grant =>
    ({
      ...grant(id, "acct-1", "Claude", "unused"),
      target: null,
      state: "offered",
      offer: { expiresAt: "2026-11-25T00:00:00.000Z", status },
      can: { cancel: canCancel, revoke: false, decide: false, return: false, setLimits: false },
    }) as unknown as Grant;
  loans.given = [
    grant("g1", "acct-1", "Claude", "Acme"),
    link("g2", "open", true),
    link("g3", "expired", false),
  ];
  await using _screen = await render(<GrantsSettings />);

  const header = page.getByRole("button", { name: /^Claude\s*lent to 1 · 1 open link$/ });
  await expect.element(header).toHaveAttribute("aria-expanded", "true");
  const list = page.getByRole("list", { name: "Claude is lent to" });
  await expect.poll(() => list.getByRole("listitem").elements().length).toBe(3);
  await expect.element(page.getByText(/^Open link, works once until /)).toBeVisible();
  await expect.element(page.getByText(/^Link expired unused/)).toBeVisible();
  await page
    .getByRole("button", { name: "Actions for Claude lent to Lending link" })
    .first()
    .click();
  await expect.element(page.getByRole("menuitem", { name: "Cancel" })).toBeVisible();
});

it("warns whoever decides on a lent subscription of its provider's terms", async () => {
  loans.given = [];
  loans.received = [
    {
      ...grant("g1", "acct-9", "Ana Claude", "Acme"),
      lender: { kind: "user", id: "user-ana", name: "Ana" },
      state: "pending",
      aiAccount: { provider: "claude", type: "subscription" },
      can: { cancel: false, revoke: false, decide: true, return: false, setLimits: false },
    },
  ];
  await using _screen = await render(<GrantsSettings />);

  await expect.element(page.getByRole("heading", { name: "Waiting for you" })).toBeVisible();
  await expect
    .element(
      page.getByText(/The terms of claude forbid sharing this account; it may be suspended\./),
    )
    .toBeVisible();
  loans.received = [];
});

// Grants ticket 07: a lent Vault group.
const groupGrant = (id: string, state: string, space: string, over: Partial<Grant> = {}): Grant =>
  ({
    ...grant(id, "group-1", "Ana keys", space),
    resource: { kind: "vault-group", id: "group-1", name: "Ana keys" },
    lender: { kind: "user", id: "user-ana", name: "Ana" },
    state,
    limits: { kind: "vault-group" },
    aiAccount: undefined,
    can: {
      cancel: false,
      revoke: state === "active",
      decide: state === "pending",
      return: false,
      setLimits: false,
    },
    ...over,
  }) as unknown as Grant;

it("accepts a lent Vault group without a strong factor, also as a Space default unless unticked", async () => {
  resetLoans();
  loans.received = [groupGrant("g7", "pending", "Acme")];
  await using _screen = await render(<GrantsSettings />);
  await expect
    .element(page.getByText(/Names that change how tools run never come from it/).first())
    .toBeVisible();
  await page.getByRole("button", { name: "Accept…" }).click();
  const asDefault = page.getByRole("checkbox", { name: "Also use it as a Space default" });
  await expect.element(asDefault).toBeChecked();
  await expect.element(page.getByText("Current password")).not.toBeInTheDocument();
  await asDefault.click();
  await expect.element(asDefault).not.toBeChecked();
  const submit = page.getByRole("dialog").getByRole("button", { name: "Accept", exact: true });
  await expect.element(submit).toBeEnabled();
  await act(async () => (submit.element() as HTMLButtonElement).click());
  await expect.poll(() => loans.accepted).toEqual([{ grantId: "g7", useAsDefault: false }]);
});

it("tells the lender which Secrets to rotate once a group's loan ended, by name", async () => {
  resetLoans();
  loans.given = [
    groupGrant("g8", "ended", "Acme", {
      endReason: "returned",
      vaultGroup: {
        toRotate: [
          { entryId: "e1", name: "ANA_TOKEN" },
          { entryId: "e2", name: "ANA_DB_PASSWORD" },
        ],
      },
    } as unknown as Partial<Grant>),
  ];
  await using _screen = await render(<GrantsSettings />);
  await expect
    .element(page.getByText("Values may have been read. Rotate these Secrets:"))
    .toBeVisible();
  const list = page.getByRole("list", { name: "Secrets to rotate" });
  await expect.element(list.getByText("ANA_TOKEN")).toBeVisible();
  await expect.element(list.getByText("ANA_DB_PASSWORD")).toBeVisible();
  await expect.element(list.getByRole("button", { name: "Replace…" })).toBeVisible();
  await expect
    .element(page.getByText(/Ended \(given back\) · Read-only for the Space/))
    .toBeVisible();
});

it("warns before taking a group back that its Secrets may have been read", async () => {
  resetLoans();
  loans.given = [
    groupGrant("g9", "active", "Acme", {
      vaultGroup: { toRotate: [{ entryId: "e1", name: "ANA_TOKEN" }] },
    } as unknown as Partial<Grant>),
  ];
  await using _screen = await render(<GrantsSettings />);
  await page.getByRole("button", { name: "Actions for Ana keys lent to Acme" }).click();
  await page.getByRole("menuitem", { name: "Take back" }).click();
  const dialog = page.getByRole("dialog");
  await expect.element(dialog.getByText(/stop receiving it from their next turn/)).toBeVisible();
  await expect.element(dialog.getByText("ANA_TOKEN")).toBeVisible();
});

// Grants ticket 15: a lent Vault group's use, by day, User and name.
it("shows a lent group's use to its lender, and to the borrowing Space's Admins only", async () => {
  resetLoans();
  loans.vaultUsage = {
    rows: [
      { day: "2026-11-18", userId: "adam", userName: "Adam", name: "ANA_TOKEN", deliveries: 3 },
      { day: "2026-11-17", userId: "gone", userName: null, name: "ANA_REGION", deliveries: 1 },
    ],
    truncated: false,
  };
  loans.vaultUsageReads = [];
  loans.given = [groupGrant("g10", "active", "Acme")];
  loans.received = [
    groupGrant("g11", "active", "Globex", {
      can: { cancel: false, revoke: false, decide: false, return: true, setLimits: false },
    } as Partial<Grant>),
    groupGrant("g12", "active", "Initech"),
  ];
  await using _screen = await render(<GrantsSettings />);

  // The lender: from the loan's actions.
  await page.getByRole("button", { name: "Actions for Ana keys lent to Acme" }).click();
  await page.getByRole("menuitem", { name: "View use" }).click();
  const table = page.getByRole("table", { name: "Loan use by day, User and name" });
  await expect.element(table.getByText("ANA_TOKEN")).toBeVisible();
  await expect.element(table.getByText("Adam")).toBeVisible();
  await expect.element(table.getByText("A former User")).toBeVisible();
  expect(loans.vaultUsageReads).toEqual([{ grantId: "g10" }]);

  // The borrower: a Use button where they run the Space (it may give it back), none elsewhere.
  await expect
    .poll(() => page.getByRole("button", { name: "Use", exact: true }).elements().length)
    .toBe(1);
  await page.getByRole("button", { name: "Use", exact: true }).click();
  await expect.poll(() => loans.vaultUsageReads).toEqual([{ grantId: "g10" }, { grantId: "g11" }]);
});
