/**
 * `t3 sandbox doctor`'s diagnosis: the Hub's own host report and the machine's state in, the words
 * to print and the fix that needs no root out. Pure; `cli/sandboxDoctor.ts` gathers the inputs.
 * It names ports, never the values of `service.env`.
 */
import type { SandboxHostReport } from "@t3tools/contracts";

import {
  adviceFor,
  findPorts,
  formatBytes,
  limitCause,
  limitRootSteps,
  mergeHostPorts,
  restartNeeded,
  type PasswordAuth,
  type PortAdvice,
} from "./hostDoctor.ts";
import type { HostListener } from "./hostExposure.ts";
import { unallowedListeners } from "./hostExposure.ts";
import type { PodmanCgroupInfo } from "./PodmanSandboxRuntime.ts";
import { podmanLimitSupport } from "./PodmanSandboxRuntime.ts";

export interface DoctorInputs {
  /** What the Hub sees (`lentHostReport`). */
  readonly report: SandboxHostReport;
  /** The host's non-loopback listeners, without this server's own port. */
  readonly listeners: ReadonlyArray<HostListener>;
  /** Owning process by port, for the ones this user can read. */
  readonly owners: ReadonlyMap<number, string>;
  readonly passwordAuth: PasswordAuth;
  /** `podman info`'s cgroups, or undefined without rootless Podman. */
  readonly cgroupInfo: PodmanCgroupInfo | undefined;
  readonly user: { readonly name: string; readonly uid: number };
  /** The `T3CODE_SANDBOX_HOST_PORTS` text of `service.env` (undefined when unset). */
  readonly fileValue: string | undefined;
  /** Every port `service.env` lists (that key and its older name). */
  readonly filePorts: ReadonlySet<number>;
  /** Every port the running server's environment lists, undefined when it cannot be read. */
  readonly runningPorts: ReadonlySet<number> | undefined;
  readonly serviceInstalled: boolean;
  /** Free and total bytes of the disk Sandboxes use, when known. */
  readonly disk: { readonly freeBytes: number; readonly totalBytes: number } | null;
}

export interface FixPlan {
  /** Ports `--fix` lets Sandboxes reach. */
  readonly allow: ReadonlyArray<number>;
  /** The new `T3CODE_SANDBOX_HOST_PORTS`, or undefined when `service.env` has it already. */
  readonly newValue: string | undefined;
  /** Whether the service must restart afterwards. */
  readonly restart: boolean;
  /** Why not, when the service cannot be restarted by this command. */
  readonly restartNote: string | undefined;
}

export interface Diagnosis {
  readonly lines: ReadonlyArray<string>;
  readonly fix: FixPlan;
  /** Whether the Hub accepts this machine now. */
  readonly ready: boolean;
}

const indent = (lines: ReadonlyArray<string>, by = "    ") => lines.map((line) => `${by}${line}`);
const asRoot = (steps: ReadonlyArray<string>) =>
  steps.length === 0 ? [] : ["As root, run:", ...indent(steps)];

const portLine = (advice: PortAdvice) => {
  const { finding } = advice;
  const owner =
    finding.process === undefined ? "owner not readable" : `owned by ${finding.process}`;
  return `  Port ${finding.port} on ${finding.addresses.join(", ")} (${owner})`;
};

export const diagnose = (input: DoctorInputs): Diagnosis => {
  const allowed = new Set(input.report.reachablePorts);
  const open = unallowedListeners(input.listeners, allowed);
  const advice = findPorts(open, input.owners).map((finding) =>
    adviceFor(finding, input.passwordAuth),
  );
  const lines: Array<string> = ["Sandbox host check", ""];

  lines.push("Ports Sandboxes could reach");
  if (advice.length === 0) {
    lines.push("  None: nothing of this machine listens beyond loopback, or you allowed it.");
  }
  for (const item of advice) {
    lines.push(portLine(item), ...indent(item.lines, "    "));
    lines.push(...indent(asRoot(item.rootSteps), "    "));
  }

  lines.push("", "Limits");
  const support = input.cgroupInfo === undefined ? undefined : podmanLimitSupport(input.cgroupInfo);
  if (support === undefined) {
    lines.push(`  ${input.report.limitSupport.note ?? "Unknown: no rootless Podman here."}`);
  } else {
    const word = (on: boolean) => (on ? "enforced" : "NOT enforced");
    lines.push(
      `  CPU: ${word(support.cpus)}. Memory: ${word(support.memory)}. Processes: ${word(support.pids)}.`,
    );
    if (support.note !== null) lines.push(`  ${support.note}`);
    const cause = input.cgroupInfo === undefined ? undefined : limitCause(input.cgroupInfo);
    const steps = cause === undefined ? [] : limitRootSteps(cause, input.user);
    lines.push(...indent(asRoot(steps), "  "));
  }

  lines.push("", "Disk");
  lines.push(
    input.disk === null
      ? "  Unknown."
      : `  ${formatBytes(input.disk.freeBytes)} free of ${formatBytes(input.disk.totalBytes)}.`,
  );

  const allow = advice.filter((item) => item.allowable).map((item) => item.finding.port);
  const newValue = mergeHostPorts(input.fileValue, allow);
  const afterFile = new Set([...input.filePorts, ...allow]);
  const pending = restartNeeded(input.runningPorts, afterFile);
  lines.push("", "Restart");
  if (input.runningPorts === undefined) {
    lines.push(
      "  No running server to compare with. The ports in service.env apply when the server starts.",
    );
  } else if (pending === "yes") {
    lines.push(
      "  The running server started with other allowed ports than service.env lists: restart it to apply them.",
    );
  } else {
    lines.push("  The running server uses the allowed ports service.env lists. No restart needed.");
  }
  const restart = pending === "yes";
  const restartNote =
    restart && !input.serviceInstalled
      ? "The T3 service is not installed here, so restart the server yourself."
      : undefined;

  lines.push("", input.report.ready ? "Ready: the Hub accepts this machine." : "Not ready yet.");
  if (!input.report.ready && input.report.reason !== null) {
    lines.push(`  The Hub says: ${input.report.reason}`);
  }
  if (allow.length > 0) {
    lines.push("", `Run \`t3 sandbox doctor --fix\` to allow ${allow.join(", ")} and restart.`);
  }
  return {
    lines,
    ready: input.report.ready,
    fix: { allow, newValue, restart: restart && input.serviceInstalled, restartNote },
  };
};
