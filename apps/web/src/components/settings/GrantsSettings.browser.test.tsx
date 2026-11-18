import type { Grant } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { GrantsSettings, groupLentLoans } from "./GrantsSettings";

const loans = vi.hoisted(() => ({ given: [] as unknown[], received: [] as unknown[] }));

vi.mock("../../state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/environments")>()),
  usePrimaryEnvironmentId: () => "env-primary",
}));
vi.mock("../../state/grants", () => ({
  grantsEnvironment: {
    end: { permissionAtom: () => ({}) },
    listGiven: {},
    listReceived: {},
    reject: {},
    cancel: {},
  },
}));
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: () => true,
}));
vi.mock("../../state/use-atom-command", () => ({
  // The label tells the commands apart; only the two lists answer here.
  useAtomCommand: (_command: unknown, label: string) => () =>
    Promise.resolve({
      _tag: "Success",
      value: {
        grants: label === "list your loans" ? loans.given : loans.received,
      },
    }),
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
  await render(<GrantsSettings />);

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
