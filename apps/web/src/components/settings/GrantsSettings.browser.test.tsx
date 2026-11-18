import type { Grant } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
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
  useAtomCommand: (_command: unknown, label: string) => () => {
    if (label === "list your loans") loans.listCalls += 1;
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

const resetLoans = () => {
  loans.given = [];
  loans.received = [];
  loans.targets = [];
  loans.phase = "connected";
  loans.failWith = null;
  loans.listCalls = 0;
  loans.account = { hasPasskey: false, hasPassword: true, totpEnrolled: false };
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
