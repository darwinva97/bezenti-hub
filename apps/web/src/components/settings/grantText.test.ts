import type { SandboxHostReport } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { hostLimitsNotice, quotaShareText } from "./grantText";

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
