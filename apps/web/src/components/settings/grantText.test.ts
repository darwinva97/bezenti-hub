import type { SandboxHostReport } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { hostLimitsNotice } from "./grantText";

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
