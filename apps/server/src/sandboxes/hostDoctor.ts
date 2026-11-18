/**
 * What `t3 sandbox doctor` tells the Owner of a machine that lends its Sandbox: the logic, with no
 * I/O of its own. What is exposed and enforced is the Hub's (`hostExposure`, `hostReportOf`,
 * `podmanLimitSupport`); this turns it into advice, plain words and the exact steps that need
 * root, which are printed and never run. See docs/internals/sandboxes.md.
 */
import type { PodmanCgroupInfo } from "./PodmanSandboxRuntime.ts";

export type PortKind = "sshd" | "llmnr" | "mdns" | "unknown";

const WELL_KNOWN: Readonly<Record<number, PortKind>> = { 22: "sshd", 5355: "llmnr", 5353: "mdns" };

/** What a listening port is: by its owning process when it is known, else by its number. */
export const classifyPort = (port: number, processName?: string): PortKind => {
  const name = processName?.toLowerCase();
  if (name !== undefined) {
    if (name === "sshd" || name.startsWith("sshd")) return "sshd";
    if (name === "systemd-resolve" || name === "systemd-resolved") {
      return port === 5353 ? "mdns" : "llmnr";
    }
    if (name === "avahi-daemon") return "mdns";
  }
  return processName === undefined ? (WELL_KNOWN[port] ?? "unknown") : "unknown";
};

export type PasswordAuth = "no" | "yes" | "unknown";

const PASSWORD_AUTH_LINE = /^\s*PasswordAuthentication\s+(\S+)/iu;
const INCLUDE_LINE = /^\s*Include\s+(.+)$/iu;
const MATCH_LINE = /^\s*Match\s/iu;

/**
 * Whether sshd accepts passwords, from its config as sshd reads it: the first value of the global
 * section wins, an `Include` is read where it stands, a `Match` ends the global section, and with
 * nothing set the answer is yes. `readInclude` gives the texts a pattern matches, in order; with
 * no config at all (`undefined`) the answer is unknown.
 */
export const sshPasswordAuth = (
  config: string | undefined,
  readInclude: (pattern: string) => ReadonlyArray<string>,
): PasswordAuth => {
  if (config === undefined) return "unknown";
  const found = (text: string, depth: number): PasswordAuth | "open" | "ended" => {
    for (const line of text.split("\n")) {
      const trimmed = line.replace(/#.*$/u, "");
      if (MATCH_LINE.test(trimmed)) return "ended";
      const value = PASSWORD_AUTH_LINE.exec(trimmed)?.[1]?.toLowerCase();
      if (value !== undefined) return value === "no" ? "no" : "yes";
      const include = INCLUDE_LINE.exec(trimmed)?.[1];
      if (include !== undefined && depth < 4) {
        for (const pattern of include.trim().split(/\s+/u)) {
          for (const included of readInclude(pattern)) {
            const inner = found(included, depth + 1);
            if (inner !== "open") return inner;
          }
        }
      }
    }
    return "open";
  };
  const result = found(config, 0);
  return result === "open" || result === "ended" ? "yes" : result;
};

export interface PortFinding {
  readonly port: number;
  readonly addresses: ReadonlyArray<string>;
  /** The process that listens, when this user could read it. */
  readonly process: string | undefined;
  readonly kind: PortKind;
}

/** The ports the Owner has not allowed, one finding each with every address it listens on. */
export const findPorts = (
  listeners: ReadonlyArray<{ readonly address: string; readonly port: number }>,
  owners: ReadonlyMap<number, string>,
): ReadonlyArray<PortFinding> => {
  const byPort = new Map<number, Set<string>>();
  for (const { address, port } of listeners) {
    byPort.set(port, (byPort.get(port) ?? new Set()).add(address));
  }
  return [...byPort.entries()]
    .toSorted(([a], [b]) => a - b)
    .map(([port, addresses]) => ({
      port,
      addresses: [...addresses],
      process: owners.get(port),
      kind: classifyPort(port, owners.get(port)),
    }));
};

export interface PortAdvice {
  readonly finding: PortFinding;
  /** Plain words: what it is and what to do. */
  readonly lines: ReadonlyArray<string>;
  /** Whether `--fix` may let Sandboxes reach it: only what is safe to reach and needs no root. */
  readonly allowable: boolean;
  /** Commands for root, printed for the Owner to run. */
  readonly rootSteps: ReadonlyArray<string>;
}

const OPTIONS_FOR_UNKNOWN = (port: number) => [
  `Two ways to deal with it, and which one is right depends on what the service is for:`,
  `  - Bind it to 127.0.0.1 in its own configuration, so no container can reach it.`,
  `  - Allow it: add ${port} to T3CODE_SANDBOX_HOST_PORTS, if a Sandbox may safely reach it.`,
];

const RESOLVED_RESTART = "systemctl restart systemd-resolved";

/** What to say and do for one open port. `passwordAuth` is what sshd's config says. */
export const adviceFor = (finding: PortFinding, passwordAuth: PasswordAuth): PortAdvice => {
  const { port } = finding;
  switch (finding.kind) {
    case "sshd":
      if (passwordAuth === "no") {
        return {
          finding,
          allowable: true,
          rootSteps: [],
          lines: [
            `sshd accepts keys only here (PasswordAuthentication no), so a Sandbox reaching it cannot log in with a guessed password.`,
            `Allow it: add ${port} to T3CODE_SANDBOX_HOST_PORTS (\`--fix\` does it).`,
          ],
        };
      }
      return {
        finding,
        allowable: false,
        rootSteps: [],
        lines: [
          passwordAuth === "yes"
            ? `sshd accepts passwords here. Not allowed automatically: a Sandbox could try to guess one.`
            : `Could not read sshd's configuration, so it is not known whether it accepts passwords. Not allowed automatically.`,
          `Set PasswordAuthentication no in /etc/ssh/sshd_config (as root, then reload sshd) and run this again, or bind sshd to 127.0.0.1 with ListenAddress.`,
        ],
      };
    case "llmnr":
      return {
        finding,
        allowable: false,
        rootSteps: [
          `mkdir -p /etc/systemd/resolved.conf.d`,
          `printf '[Resolve]\\nLLMNR=no\\n' > /etc/systemd/resolved.conf.d/t3-no-llmnr.conf`,
          RESOLVED_RESTART,
        ],
        lines: [
          `LLMNR (systemd-resolved's name lookup on the local network) is rarely used on a server.`,
          `Turn it off with the root commands below; this tool never runs them.`,
        ],
      };
    case "mdns":
      return {
        finding,
        allowable: false,
        rootSteps: [
          `mkdir -p /etc/systemd/resolved.conf.d`,
          `printf '[Resolve]\\nMulticastDNS=no\\n' > /etc/systemd/resolved.conf.d/t3-no-mdns.conf`,
          RESOLVED_RESTART,
        ],
        lines: [
          `mDNS (local network name discovery) is rarely used on a server. If avahi-daemon is what listens, stop it instead: systemctl disable --now avahi-daemon.socket avahi-daemon.service`,
          `For systemd-resolved, turn it off with the root commands below; this tool never runs them.`,
        ],
      };
    case "unknown":
      return {
        finding,
        allowable: false,
        rootSteps: [],
        lines: [
          finding.process === undefined
            ? `Could not tell which service listens on ${port} (its process is not readable without root).`
            : `${finding.process} listens on ${port}.`,
          ...OPTIONS_FOR_UNKNOWN(port),
        ],
      };
  }
};

export type LimitCause =
  | { readonly kind: "cgroup-version"; readonly version: string }
  | { readonly kind: "no-user-bus" }
  | { readonly kind: "controllers"; readonly missing: ReadonlyArray<string> };

/** Why limits are not enforced, from the same `podman info` that `podmanLimitSupport` reads. */
export const limitCause = (info: PodmanCgroupInfo): LimitCause | undefined => {
  if (info.cgroupVersion !== "v2") {
    return { kind: "cgroup-version", version: info.cgroupVersion ?? "unknown" };
  }
  if (info.cgroupManager !== "systemd") return { kind: "no-user-bus" };
  const missing = ["cpu", "memory", "pids"].filter(
    (controller) => !info.cgroupControllers.includes(controller),
  );
  return missing.length === 0 ? undefined : { kind: "controllers", missing };
};

/** The root steps for a cause, printed and never run. `user` is the Hub's account. */
export const limitRootSteps = (
  cause: LimitCause,
  user: { readonly name: string; readonly uid: number },
): ReadonlyArray<string> => {
  switch (cause.kind) {
    case "cgroup-version":
      return [];
    case "no-user-bus":
      return [
        `apt install dbus-user-session    # Debian and Ubuntu; other systems have an equivalent package`,
        `loginctl enable-linger ${user.name}`,
        `Then run the Hub as a systemd user service (\`t3 service install\`) and restart it.`,
      ];
    case "controllers":
      return [
        `mkdir -p /etc/systemd/system/user@.service.d`,
        `printf '[Service]\\nDelegate=cpu cpuset io memory pids\\n' > /etc/systemd/system/user@.service.d/delegate.conf`,
        `systemctl daemon-reload`,
        `systemctl restart user@${user.uid}.service    # ends ${user.name}'s login sessions; a reboot does the same`,
      ];
  }
};

/**
 * Whether the running server must restart to read `service.env`'s allowed ports, which it reads
 * only when it starts. `running` is the ports its own environment lists (undefined when that
 * could not be read), `file` those `service.env` lists.
 */
export const restartNeeded = (
  running: ReadonlySet<number> | undefined,
  file: ReadonlySet<number>,
): "yes" | "no" | "unknown" => {
  if (running === undefined) return "unknown";
  if (running.size !== file.size) return "yes";
  for (const port of file) if (!running.has(port)) return "yes";
  return "no";
};

/** The value of `name` in a `/proc/<pid>/environ` text (NUL-separated `KEY=value`). */
export const valueInEnviron = (environ: string, name: string): string | undefined => {
  for (const entry of environ.split("\0")) {
    if (entry.startsWith(`${name}=`)) return entry.slice(name.length + 1);
  }
  return undefined;
};

/**
 * The new value of `T3CODE_SANDBOX_HOST_PORTS`: what the file lists now, as written, then the
 * ports `add` names that it does not list yet. Undefined when it lists them all already.
 */
export const mergeHostPorts = (
  existing: string | undefined,
  add: ReadonlyArray<number>,
): string | undefined => {
  const tokens = (existing ?? "")
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token !== "");
  const listed = new Set(tokens.map((token) => Number.parseInt(token, 10)));
  const missing = [...new Set(add)].filter((port) => !listed.has(port)).toSorted((a, b) => a - b);
  return missing.length === 0 ? undefined : [...tokens, ...missing.map(String)].join(",");
};

/** The socket inode of each port `/proc/net/tcp` (or `tcp6`) text lists as listening. */
export const listenInodesOf = (text: string): ReadonlyMap<number, string> => {
  const found = new Map<number, string>();
  for (const line of text.split("\n").slice(1)) {
    const columns = line.trim().split(/\s+/u);
    const local = columns[1];
    if (local === undefined || columns[3] !== "0A") continue;
    const inode = columns[9];
    const port = Number.parseInt(local.split(":")[1] ?? "", 16);
    if (inode !== undefined && inode !== "0" && Number.isFinite(port)) found.set(port, inode);
  }
  return found;
};

/** Bytes as the Hub's dialog says them. */
export const formatBytes = (bytes: number): string =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GiB`
    : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MiB`;
