import { describe, expect, it } from "vite-plus/test";

import {
  adviceFor,
  classifyPort,
  findPorts,
  limitCause,
  limitRootSteps,
  listenInodesOf,
  mergeHostPorts,
  restartNeeded,
  sshPasswordAuth,
  valueInEnviron,
} from "./hostDoctor.ts";

const none = () => [] as ReadonlyArray<string>;

describe("classifyPort", () => {
  it("names a port by its owning process first", () => {
    expect(classifyPort(2222, "sshd")).toBe("sshd");
    expect(classifyPort(5355, "systemd-resolve")).toBe("llmnr");
    expect(classifyPort(5353, "systemd-resolve")).toBe("mdns");
    expect(classifyPort(5353, "avahi-daemon")).toBe("mdns");
    expect(classifyPort(22, "nginx")).toBe("unknown");
  });
  it("falls back to the port number when the owner cannot be read", () => {
    expect(classifyPort(22)).toBe("sshd");
    expect(classifyPort(5355)).toBe("llmnr");
    expect(classifyPort(5353)).toBe("mdns");
    expect(classifyPort(8081)).toBe("unknown");
  });
});

describe("sshPasswordAuth", () => {
  it("reads PasswordAuthentication no", () => {
    expect(sshPasswordAuth("Port 22\nPasswordAuthentication no\n", none)).toBe("no");
  });
  it("is yes when passwords are on or the line is absent", () => {
    expect(sshPasswordAuth("PasswordAuthentication yes\n", none)).toBe("yes");
    expect(sshPasswordAuth("Port 22\n", none)).toBe("yes");
  });
  it("takes the first value, as sshd does", () => {
    expect(sshPasswordAuth("PasswordAuthentication no\nPasswordAuthentication yes\n", none)).toBe(
      "no",
    );
  });
  it("ignores comments and what is after a Match", () => {
    expect(
      sshPasswordAuth(
        "#PasswordAuthentication no\nMatch User bob\nPasswordAuthentication no",
        none,
      ),
    ).toBe("yes");
  });
  it("reads an Include where it stands", () => {
    const read = (pattern: string) =>
      pattern === "sshd_config.d/*.conf" ? ["PasswordAuthentication no\n"] : [];
    expect(
      sshPasswordAuth("Include sshd_config.d/*.conf\nPasswordAuthentication yes\n", read),
    ).toBe("no");
  });
  it("is unknown without a config", () => {
    expect(sshPasswordAuth(undefined, none)).toBe("unknown");
  });
});

const finding = (port: number, owner?: string) => {
  const [found] = findPorts(
    [{ address: "0.0.0.0", port }],
    new Map(owner === undefined ? [] : [[port, owner]]),
  );
  return found!;
};

describe("adviceFor", () => {
  it("offers to allow sshd with keys only", () => {
    const advice = adviceFor(finding(22, "sshd"), "no");
    expect(advice.allowable).toBe(true);
    expect(advice.lines.join("\n")).toContain("T3CODE_SANDBOX_HOST_PORTS");
  });
  it("does not allow sshd that accepts passwords, or whose config is unreadable", () => {
    expect(adviceFor(finding(22), "yes").allowable).toBe(false);
    expect(adviceFor(finding(22), "unknown").allowable).toBe(false);
  });
  it("gives the root command for LLMNR and never allows it", () => {
    const advice = adviceFor(finding(5355, "systemd-resolve"), "yes");
    expect(advice.allowable).toBe(false);
    expect(advice.rootSteps.join("\n")).toContain("LLMNR=no");
    expect(advice.rootSteps.join("\n")).toContain("resolved.conf.d");
    expect(advice.rootSteps.at(-1)).toBe("systemctl restart systemd-resolved");
  });
  it("gives the root command for mDNS", () => {
    expect(adviceFor(finding(5353, "systemd-resolve"), "yes").rootSteps.join("\n")).toContain(
      "MulticastDNS=no",
    );
  });
  it("explains both options for an unknown service without choosing", () => {
    const advice = adviceFor(finding(8081, "mystery"), "yes");
    expect(advice.allowable).toBe(false);
    expect(advice.rootSteps).toEqual([]);
    const text = advice.lines.join("\n");
    expect(text).toContain("127.0.0.1");
    expect(text).toContain("T3CODE_SANDBOX_HOST_PORTS");
  });
  it("says plainly when the owner is not readable", () => {
    expect(adviceFor(finding(8081), "yes").lines.join("\n")).toContain("Could not tell");
  });
});

describe("limit causes", () => {
  const user = { name: "ana", uid: 1000 };
  it("finds Podman on cgroupfs without a user bus and prints the dbus steps", () => {
    const cause = limitCause({
      cgroupManager: "cgroupfs",
      cgroupVersion: "v2",
      cgroupControllers: [],
    });
    expect(cause).toEqual({ kind: "no-user-bus" });
    const steps = limitRootSteps(cause!, user).join("\n");
    expect(steps).toContain("dbus-user-session");
    expect(steps).toContain("loginctl enable-linger ana");
  });
  it("finds controllers that are not delegated and prints the drop-in", () => {
    const cause = limitCause({
      cgroupManager: "systemd",
      cgroupVersion: "v2",
      cgroupControllers: ["cpu"],
    });
    expect(cause).toEqual({ kind: "controllers", missing: ["memory", "pids"] });
    const steps = limitRootSteps(cause!, user).join("\n");
    expect(steps).toContain("Delegate=cpu cpuset io memory pids");
    expect(steps).toContain("user@1000.service");
  });
  it("has no cause when every limit is enforced", () => {
    expect(
      limitCause({
        cgroupManager: "systemd",
        cgroupVersion: "v2",
        cgroupControllers: ["cpu", "memory", "pids"],
      }),
    ).toBeUndefined();
  });
});

describe("restartNeeded", () => {
  it("is yes when the running server read other ports than service.env lists", () => {
    expect(restartNeeded(new Set(), new Set([22]))).toBe("yes");
    expect(restartNeeded(new Set([22]), new Set())).toBe("yes");
  });
  it("is no for the same ports in any order", () => {
    expect(restartNeeded(new Set([22, 443]), new Set([443, 22]))).toBe("no");
  });
  it("is unknown when the running environment cannot be read", () => {
    expect(restartNeeded(undefined, new Set([22]))).toBe("unknown");
  });
});

describe("mergeHostPorts", () => {
  it("appends the missing ports and keeps what is listed", () => {
    expect(mergeHostPorts("443, 8080", [22])).toBe("443,8080,22");
    expect(mergeHostPorts(undefined, [22, 22])).toBe("22");
  });
  it("is undefined when everything is listed already", () => {
    expect(mergeHostPorts("22,443", [22])).toBeUndefined();
  });
});

describe("/proc parsing", () => {
  it("reads the listening sockets' inodes", () => {
    const text = [
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12345 1 0 100 0 0 10 0",
      "   1: 0100007F:0CEA 00000000:0000 01 00000000:00000000 00:00000000 00000000     0        0 999 1 0 100 0 0 10 0",
    ].join("\n");
    expect([...listenInodesOf(text)]).toEqual([[22, "12345"]]);
  });
  it("reads a value out of an environ text", () => {
    expect(
      valueInEnviron("A=1\0T3CODE_SANDBOX_HOST_PORTS=22\0B=2", "T3CODE_SANDBOX_HOST_PORTS"),
    ).toBe("22");
    expect(valueInEnviron("A=1\0", "T3CODE_SANDBOX_HOST_PORTS")).toBeUndefined();
  });
});
