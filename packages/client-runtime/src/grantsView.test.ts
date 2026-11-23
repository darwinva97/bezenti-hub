import type { Grant, GrantOfferPreview, SandboxHostReport, SpaceId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it } from "vite-plus/test";

import {
  grantOfferTokenOf,
  groupLentLoans,
  hostLimitsNotice,
  limitsText,
  offerLinkOf,
  offerSpaceLabel,
  offerStatusText,
  offerWarnings,
  pendingGrantsOf,
  quotaShareText,
  receivedSections,
  recipientLabel,
  stateText,
  vaultLendWarning,
} from "./grantsView.ts";

const host = (overrides: Partial<SandboxHostReport> = {}): SandboxHostReport => ({
  ready: true,
  reason: null,
  limitSupport: { cpus: true, memory: true, pids: true, note: null },
  reachablePorts: [22],
  hostCpus: 8,
  hostMemoryBytes: 16 * 1024 ** 3,
  hostFreeBytes: null,
  hostTotalBytes: null,
  ...overrides,
});

it("says nothing of limits while the machine cannot run a Sandbox: they are not known yet", () => {
  expect(
    hostLimitsNotice(
      host({
        ready: false,
        reason: "Podman is here but the Sandbox image is not.",
        limitSupport: { cpus: false, memory: false, pids: false, note: null },
      }),
    ),
  ).toBeNull();
});

it("says nothing when the machine enforces every limit", () => {
  expect(hostLimitsNotice(host())).toBeNull();
});

it("names only the limits a ready machine does not enforce, with its note", () => {
  expect(
    hostLimitsNotice(
      host({
        limitSupport: {
          cpus: true,
          memory: false,
          pids: true,
          note: "The Hub user's cgroup has no memory controller delegated.",
        },
      }),
    ),
  ).toBe(
    "On this machine these limits are not enforced: memory. The Hub user's cgroup has no memory controller delegated.",
  );
});

// Grants ticket 05: a lent subscription's share of a quota window, always marked approximate.
it("says how much of a quota window went through the loan, approximately, and when it resets", () => {
  const share = {
    windowId: "seven_day",
    label: "Weekly",
    kind: "weekly",
    resetsAt: "2026-11-20T10:00:00.000Z",
    sharePercent: 12.4,
    of: "loan",
  } as const;
  const text = quotaShareText(share);
  expect(text).toMatch(/^Weekly quota: ≈ 12% through this loan \(approx\.\) · resets /u);
  expect(text).not.toContain("account at");
  // The lender also sees the whole account's use; a borrowing Member only their own part.
  expect(quotaShareText({ ...share, usedPercent: 64 })).toContain(" · account at 64% · ");
  expect(quotaShareText({ ...share, of: "own", sharePercent: 0.2 })).toMatch(
    /^Weekly quota: ≈ <1% by you \(approx\.\)/u,
  );
});

// Grants ticket 06: lending links.
it("hands out a link on the Hub's public address, else on this page's", () => {
  const path = "/grants/offer#token=abc";
  expect(offerLinkOf({ path, url: "https://hub.example/grants/offer#token=abc" }, "http://x")).toBe(
    "https://hub.example/grants/offer#token=abc",
  );
  expect(offerLinkOf({ path, url: null }, "http://localhost:3773")).toBe(
    "http://localhost:3773/grants/offer#token=abc",
  );
});

it("tells the lender why a link is dead, and names a link nobody applied", () => {
  const expiresAt = "2026-11-25T00:00:00.000Z";
  expect(offerStatusText({ expiresAt, status: "expired" })).toBe("Link expired unused");
  expect(offerStatusText({ expiresAt, status: "cancelled" })).toBe("Link cancelled");
  expect(offerStatusText({ expiresAt, status: "used" })).toBe("Applied through a link");
  expect(offerStatusText({ expiresAt, status: "open" })).toMatch(/^Open link, works once until /);
  const link = { target: null, offer: { expiresAt, status: "open" } } as unknown as Grant;
  expect(recipientLabel(link)).toBe("Lending link");
  const used = {
    target: {
      spaceId: "personal:bob",
      kind: "personal",
      name: "Personal",
      ownerDisplayName: "Bob",
    },
    offer: { expiresAt, status: "used" },
  } as unknown as Grant;
  expect(recipientLabel(used)).toBe("Bob (personal)");
});

it("warns whoever applies a subscription's link of its terms, and of what the lender sees", () => {
  const preview = {
    status: "valid",
    resource: {
      kind: "ai-account",
      name: "Ana Claude",
      aiAccount: { provider: "claude", type: "subscription" },
    },
    lender: { kind: "user", name: "Ana" },
    limits: { kind: "ai-account", tokens: null, requests: null },
    expiresAt: "2026-11-25T00:00:00.000Z",
    spaces: [],
  } as Extract<GrantOfferPreview, { status: "valid" }>;
  expect(offerWarnings(preview)).toEqual([
    "Ana sees how much each person in the Space uses it, never prompts or Threads, and can take it back at any time.",
    "The terms of claude forbid sharing this account; it may be suspended.",
  ]);
  const apiKey = {
    ...preview,
    resource: { ...preview.resource, aiAccount: { provider: "claude", type: "api-key" } },
  } as Extract<GrantOfferPreview, { status: "valid" }>;
  expect(offerWarnings(apiKey)).toHaveLength(1);
  // Grants ticket 15: a machine's link says what its lender sees.
  const machine = {
    ...preview,
    resource: { kind: "environment", name: "Ana's box" },
  } as Extract<GrantOfferPreview, { status: "valid" }>;
  expect(offerWarnings(machine)).toEqual([
    "Ana controls this machine and can see everything that runs on it: files, processes, the Secrets turns receive and each Thread's AI gateway key. Only accept machines of people you trust that much.",
  ]);
  expect(
    offerSpaceLabel({
      spaceId: "org-acme" as SpaceId,
      kind: "organization",
      name: "Acme",
      alreadyGranted: true,
    }),
  ).toBe("Acme (already lent there)");
});

it("says a lent Vault group has no limits and warns that the Space's agents read its Secrets", () => {
  expect(limitsText({ kind: "vault-group" })).toBe("Read-only for the Space");
  const warning = vaultLendWarning("Acme");
  expect(warning).toContain("The agents of Acme, Guests' Threads included, can read");
  expect(warning).toContain("environment variables");
});

it("says when and why a loan ended, the day in local time (Grants 11)", () => {
  const endedAt = "2026-11-20T10:00:00.000Z";
  const day = DateTime.toDate(DateTime.makeUnsafe(endedAt)).toLocaleDateString();
  expect(stateText({ state: "ended", endReason: "resource-gone", endedAt })).toBe(
    `Ended ${day} (it was deleted)`,
  );
  expect(stateText({ state: "ended", endReason: "target-gone", endedAt })).toBe(
    `Ended ${day} (the Space was deleted)`,
  );
  expect(stateText({ state: "ended", endReason: "lender-gone", endedAt })).toBe(
    `Ended ${day} (its lender was removed)`,
  );
  expect(stateText({ state: "ended", endReason: "returned", endedAt: null })).toBe(
    "Ended (given back)",
  );
});

const loan = (
  id: string,
  resourceId: string,
  name: string,
  space: string,
  overrides: Partial<Grant> = {},
): Grant =>
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
    ...overrides,
  }) as unknown as Grant;

it("groups the loans of one resource into a single header with one line per recipient", () => {
  const groups = groupLentLoans([
    loan("g1", "acct-1", "Claude (me@example.com)", "Zeta"),
    loan("g2", "acct-2", "Codex", "Beta"),
    loan("g3", "acct-1", "Claude (me@example.com)", "Alpha"),
    loan("g4", "acct-1", "Claude (me@example.com)", "Beta"),
  ]);
  expect(groups.map((entry) => [entry.name, entry.loans.length])).toEqual([
    ["Claude (me@example.com)", 3],
    ["Codex", 1],
  ]);
  expect(groups[0]?.loans.map((entry) => entry.target?.name)).toEqual(["Alpha", "Beta", "Zeta"]);
});

it("sorts what a Space received: waiting only for whoever decides, in use, ended (Grants 12)", () => {
  const sections = receivedSections([
    loan("w1", "a", "A", "Acme", {
      state: "pending",
      can: { cancel: false, revoke: false, decide: true, return: false, setLimits: false },
    }),
    loan("w2", "b", "B", "Acme", { state: "pending" }),
    loan("u1", "c", "C", "Acme"),
    loan("e1", "d", "D", "Acme", { state: "ended", endReason: "lender-gone" }),
  ]);
  expect(sections.waiting.map((grant) => grant.id)).toEqual(["w1"]);
  expect(sections.borrowed.map((grant) => grant.id)).toEqual(["u1"]);
  expect(sections.ended.map((grant) => grant.id)).toEqual(["e1"]);
});

it("counts the loans waiting for the viewer per Space and in all (Grants 12)", () => {
  const space = (id: string, pendingGrants?: number) => ({
    id: id as SpaceId,
    kind: "organization" as const,
    name: id,
    role: "admin" as const,
    isOwn: false,
    canCreateThreads: true,
    canInvite: true,
    ...(pendingGrants === undefined ? {} : { pendingGrants }),
  });
  const counted = pendingGrantsOf({
    userId: "ana" as never,
    personalSpaceId: "personal:ana" as SpaceId,
    canCreateOrganization: true,
    spaces: [space("acme", 2), space("globex"), space("initech", 1)],
  });
  expect([...counted.bySpace.entries()]).toEqual([
    ["acme", 2],
    ["initech", 1],
  ]);
  expect(counted.total).toBe(3);
  expect(pendingGrantsOf(null).total).toBe(0);
});

it("reads a lending link's token from the Hub's address, the app's scheme or bare", () => {
  const token = "Zx9_abcDEF-0123456789abcdefghijklmnopqrstu";
  expect(grantOfferTokenOf(`https://hub.example/grants/offer#token=${token}`)).toBe(token);
  expect(grantOfferTokenOf(`  t3code://grants/offer#token=${token} `)).toBe(token);
  expect(grantOfferTokenOf(token)).toBe(token);
  expect(grantOfferTokenOf("https://hub.example/grants/offer?token=nope")).toBeNull();
  expect(grantOfferTokenOf("hello")).toBeNull();
});
