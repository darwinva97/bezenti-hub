import type { Grant, GrantOfferPreview, SandboxHostReport, SpaceId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import {
  hostLimitsNotice,
  limitsText,
  offerLinkOf,
  offerSpaceLabel,
  offerStatusText,
  offerWarnings,
  quotaShareText,
  recipientLabel,
  vaultLendWarning,
} from "./grantText";

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
