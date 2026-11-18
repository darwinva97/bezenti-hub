import type { SandboxHostReport } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { diagnose, type DoctorInputs } from "./hostDoctorReport.ts";

const GIB = 1024 ** 3;

const report = (over: Partial<SandboxHostReport> = {}): SandboxHostReport => ({
  ready: false,
  reason: "its Sandbox containers could reach this machine's 0.0.0.0:22.",
  limitSupport: { cpus: true, memory: true, pids: true, note: null },
  reachablePorts: [],
  hostCpus: 4,
  hostMemoryBytes: 8 * GIB,
  hostFreeBytes: 50 * GIB,
  hostTotalBytes: 100 * GIB,
  ...over,
});

const base = (over: Partial<DoctorInputs> = {}): DoctorInputs => ({
  report: report(),
  listeners: [
    { address: "0.0.0.0", port: 22 },
    { address: "0.0.0.0", port: 5355 },
  ],
  owners: new Map([[5355, "systemd-resolve"]]),
  passwordAuth: "no",
  cgroupInfo: {
    cgroupManager: "systemd",
    cgroupVersion: "v2",
    cgroupControllers: ["cpu", "memory", "pids"],
  },
  user: { name: "ana", uid: 1000 },
  fileValue: undefined,
  filePorts: new Set(),
  runningPorts: new Set(),
  serviceInstalled: true,
  disk: { freeBytes: 50 * GIB, totalBytes: 100 * GIB },
  ...over,
});

describe("diagnose", () => {
  it("reports ports, limits, disk and the Hub's reason in words", () => {
    const text = diagnose(base()).lines.join("\n");
    expect(text).toContain("Port 22 on 0.0.0.0 (owner not readable)");
    expect(text).toContain("Port 5355 on 0.0.0.0 (owned by systemd-resolve)");
    expect(text).toContain("LLMNR=no");
    expect(text).toContain("CPU: enforced. Memory: enforced. Processes: enforced.");
    expect(text).toContain("50.0 GiB free of 100.0 GiB");
    expect(text).toContain("The Hub says: its Sandbox containers could reach");
  });

  it("plans to allow sshd with keys only, and leaves LLMNR to root", () => {
    const { fix } = diagnose(base());
    expect(fix.allow).toEqual([22]);
    expect(fix.newValue).toBe("22");
  });

  it("plans nothing for sshd that accepts passwords", () => {
    const { fix } = diagnose(base({ passwordAuth: "yes" }));
    expect(fix.allow).toEqual([]);
    expect(fix.newValue).toBeUndefined();
  });

  it("says a restart is needed when service.env differs from the running server", () => {
    const diagnosis = diagnose(
      base({
        report: report({ ready: true, reason: null }),
        listeners: [],
        fileValue: "22",
        filePorts: new Set([22]),
        runningPorts: new Set(),
      }),
    );
    expect(diagnosis.lines.join("\n")).toContain("restart it to apply them");
    expect(diagnosis.fix.restart).toBe(true);
    expect(diagnosis.fix.newValue).toBeUndefined();
  });

  it("restarts after a fix when a server runs, and not when none does", () => {
    expect(diagnose(base()).fix.restart).toBe(true);
    expect(diagnose(base({ runningPorts: undefined })).fix.restart).toBe(false);
  });

  it("tells the User to restart by hand when the service is not installed", () => {
    const { fix } = diagnose(base({ serviceInstalled: false }));
    expect(fix.restart).toBe(false);
    expect(fix.restartNote).toContain("restart the server yourself");
  });

  it("needs no restart and no fix when everything matches (idempotent)", () => {
    const diagnosis = diagnose(
      base({
        report: report({ ready: true, reason: null, reachablePorts: [22] }),
        listeners: [{ address: "0.0.0.0", port: 22 }],
        fileValue: "22",
        filePorts: new Set([22]),
        runningPorts: new Set([22]),
      }),
    );
    expect(diagnosis.fix).toEqual({
      allow: [],
      newValue: undefined,
      restart: false,
      restartNote: undefined,
    });
    expect(diagnosis.lines.join("\n")).toContain("No restart needed");
    expect(diagnosis.ready).toBe(true);
  });

  it("prints the dbus root step when Podman fell back to cgroupfs", () => {
    const text = diagnose(
      base({
        cgroupInfo: { cgroupManager: "cgroupfs", cgroupVersion: "v2", cgroupControllers: [] },
      }),
    ).lines.join("\n");
    expect(text).toContain("NOT enforced");
    expect(text).toContain("apt install dbus-user-session");
    expect(text).toContain("loginctl enable-linger ana");
  });

  it("says plainly when no server runs to compare with", () => {
    expect(diagnose(base({ runningPorts: undefined })).lines.join("\n")).toContain(
      "No running server to compare with",
    );
  });

  it("never prints service.env values: only ports", () => {
    const text = diagnose(
      base({ fileValue: "22,SECRET_TOKEN_VALUE", filePorts: new Set([22]) }),
    ).lines.join("\n");
    expect(text).not.toContain("SECRET_TOKEN_VALUE");
  });
});
