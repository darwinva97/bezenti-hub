// @effect-diagnostics nodeBuiltinImport:off -- reads /proc and sshd's config, which has no Effect API.
/**
 * `t3 sandbox doctor`: what keeps this machine from lending its Sandbox, in words, and `--fix` for
 * what needs no root. The report is the Hub's (`lentHostReport`); the steps for root are printed,
 * never run. See docs/internals/sandboxes.md and ticket 19.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

import * as Console from "effect/Console";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { Command, Flag, GlobalFlag, Prompt } from "effect/cli";
import * as CliError from "effect/cli/CliError";

import * as BootService from "../cloud/bootService.ts";
import * as ServerConfig from "../config.ts";
import { lentHostReport } from "../environments/LentSandboxHost.ts";
import { listenInodesOf, sshPasswordAuth, valueInEnviron } from "../sandboxes/hostDoctor.ts";
import {
  type Diagnosis,
  type DoctorInputs,
  diagnose,
  type FixPlan,
} from "../sandboxes/hostDoctorReport.ts";
import { listeningOutsideLoopback } from "../sandboxes/hostExposure.ts";
import { readCgroupInfo } from "../sandboxes/PodmanSandboxRuntime.ts";
import { SandboxRuntime } from "../sandboxes/SandboxRuntime.ts";
import { hostSpaceOf } from "../sandboxes/sandboxLimits.ts";
import {
  dedicatedRuntimeFromConfig,
  HOST_PORTS_SETTINGS,
  parseHostPorts,
  SANDBOX_HOST_PORTS_SETTING,
} from "../sandboxes/sandboxRuntimeFromConfig.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { authLocationFlags, resolveCliAuthConfig } from "./config.ts";
import * as CliService from "./service.ts";

const userError = (message: string) => new CliError.UserError({ cause: message });

const readText = (file: string): string | undefined => {
  try {
    return NodeFS.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
};

/** The process that listens on each port, for the processes this user may inspect. */
const portOwners = (): ReadonlyMap<number, string> => {
  const inodes = new Map<string, number>();
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    for (const [port, inode] of listenInodesOf(readText(file) ?? "")) inodes.set(inode, port);
  }
  const owners = new Map<number, string>();
  let pids: Array<string> = [];
  try {
    pids = NodeFS.readdirSync("/proc").filter((entry) => /^\d+$/u.test(entry));
  } catch {
    return owners;
  }
  for (const pid of pids) {
    let fds: Array<string>;
    try {
      fds = NodeFS.readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      let target: string;
      try {
        target = NodeFS.readlinkSync(`/proc/${pid}/fd/${fd}`);
      } catch {
        continue;
      }
      const inode = /^socket:\[(\d+)\]$/u.exec(target)?.[1];
      const port = inode === undefined ? undefined : inodes.get(inode);
      const name = readText(`/proc/${pid}/comm`)?.trim();
      if (port !== undefined && name !== undefined && name !== "") owners.set(port, name);
    }
  }
  return owners;
};

/** sshd's main config and a reader for what it includes, from `/etc/ssh`. */
const sshConfig = () => {
  const main = readText("/etc/ssh/sshd_config");
  const readInclude = (pattern: string): ReadonlyArray<string> => {
    const full = pattern.startsWith("/") ? pattern : `/etc/ssh/${pattern}`;
    const dir = full.slice(0, full.lastIndexOf("/"));
    const glob = full.slice(full.lastIndexOf("/") + 1);
    const matcher = new RegExp(
      `^${glob
        .replace(/[.+^${}()|[\]\\]/gu, "\\$&")
        .replace(/\*/gu, ".*")
        .replace(/\?/gu, ".")}$`,
      "u",
    );
    try {
      return NodeFS.readdirSync(dir)
        .filter((name) => matcher.test(name))
        .toSorted()
        .flatMap((name) => readText(`${dir}/${name}`) ?? []);
    } catch {
      return [];
    }
  };
  return { main, readInclude };
};

/** The allowed ports of an environment record: both names of the setting. */
const portsOfEnv = (env: Readonly<Record<string, string | undefined>>) =>
  parseHostPorts(HOST_PORTS_SETTINGS.map((name) => env[name] ?? "").join(","));

export interface FixActions<EW, ER, R> {
  readonly confirm: (message: string) => Effect.Effect<boolean, never, R>;
  /** Merges the value into `service.env`, keeping its other keys. */
  readonly write: (value: string) => Effect.Effect<void, EW, R>;
  readonly restart: Effect.Effect<"restarted" | "queued" | "skipped", ER, R>;
}

/**
 * What `--fix` does: only what needs no root, after the User confirms. Writes the allowed ports
 * into `service.env` and restarts the service, each only when it is needed, so it is idempotent.
 */
export const applyFix = Effect.fn("cli.sandbox.doctor.applyFix")(function* <EW, ER, R>(
  plan: FixPlan,
  actions: FixActions<EW, ER, R>,
) {
  if (plan.newValue === undefined && !plan.restart) {
    return yield* Console.log("\nNothing to fix without root.");
  }
  const steps = [
    ...(plan.newValue === undefined
      ? []
      : [
          `let Sandboxes reach port ${plan.allow.join(", ")} (T3CODE_SANDBOX_HOST_PORTS in service.env)`,
        ]),
    ...(plan.restart ? ["restart the T3 service (running agent turns stop)"] : []),
  ];
  if (!(yield* actions.confirm(`Apply: ${steps.join("; ")}?`))) {
    return yield* Console.log("\nNothing changed.");
  }
  if (plan.newValue !== undefined) {
    yield* actions.write(plan.newValue);
    yield* Console.log("\nUpdated service.env.");
  }
  if (plan.restart) {
    const outcome = yield* actions.restart;
    yield* Console.log(
      outcome === "queued"
        ? "Restart queued. This session will disconnect."
        : outcome === "skipped"
          ? "The installed service runs another T3 home, so it was not restarted. Pass its --base-dir."
          : "Restarted the T3 service.",
    );
  }
  if (plan.restartNote !== undefined) yield* Console.log(plan.restartNote);
});

/** Builds the Hub's report here, as the lent host would: the runtime when it can start. */
const hubReport = Effect.fn("cli.sandbox.doctor.report")(function* (
  config: ServerConfig.ServerConfig["Service"],
  rootDir: string,
) {
  const scope = yield* Effect.scope;
  const checked = yield* dedicatedRuntimeFromConfig(`http://127.0.0.1:${config.port}`, {
    rootDir,
  });
  if (Result.isFailure(checked)) {
    return yield* lentHostReport({ runtime: Option.none(), unavailable: checked.failure.message });
  }
  const built = yield* Layer.buildWithScope(checked.success, scope).pipe(Effect.result);
  if (Result.isFailure(built)) {
    return yield* lentHostReport({
      runtime: Option.none(),
      unavailable: "its Sandbox runtime could not start; see the server log.",
    });
  }
  return yield* lentHostReport({
    runtime: Option.some(Context.get(built.success, SandboxRuntime)),
    unavailable: undefined,
  });
});

const interactiveTerminal = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

const doctorFlags = {
  ...authLocationFlags,
  fix: Flag.Boolean("fix").pipe(
    Flag.withDescription(
      "Apply what needs no root: allow the safe ports in service.env and restart the service.",
    ),
    Flag.withDefault(false),
  ),
  yes: Flag.Boolean("yes").pipe(
    Flag.withDescription("With --fix, apply without asking."),
    Flag.withDefault(false),
  ),
};

type DoctorFlags = {
  readonly fix: boolean;
  readonly yes: boolean;
};

const runDoctorCommand = Effect.fn("cli.sandbox.doctor.run")(function* (
  resolved: ServerConfig.ServerConfig["Service"],
  flags: DoctorFlags,
) {
  const baseDir = resolved.baseDir;
  const state = yield* readPersistedServerRuntimeState(resolved.serverRuntimeStatePath).pipe(
    Effect.orElseSucceed(() => Option.none()),
  );
  // The running server's own port is the one its report leaves out.
  const config = {
    ...resolved,
    port: Option.match(state, { onNone: () => resolved.port, onSome: (s) => s.port }),
  };
  const serviceEnv = yield* CliService.readServiceEnv(baseDir);
  const environ = Option.isSome(state) ? readText(`/proc/${state.value.pid}/environ`) : undefined;
  const runningEnv =
    environ === undefined
      ? undefined
      : Object.fromEntries(
          HOST_PORTS_SETTINGS.map((name) => [name, valueInEnviron(environ, name)] as const),
        );
  // What the Hub sees is what the running server read; with none running, what service.env says.
  const env = Object.fromEntries(
    Object.entries(runningEnv ?? serviceEnv.entries).flatMap(([key, value]) =>
      value === undefined ? [] : [[key, value] as const],
    ),
  );
  const rootDir = `${baseDir}-lent-sandboxes`;
  const service = yield* BootService.BootService;
  const serviceStatus = yield* service.status.pipe(Effect.option);

  const report = yield* hubReport(config, rootDir).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.merge(
        ServerConfig.layer(config),
        ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
      ),
    ),
  );
  const listeners = listeningOutsideLoopback().filter((listener) => listener.port !== config.port);
  const ssh = sshConfig();
  const cgroupInfo = yield* readCgroupInfo().pipe(
    Effect.map((info) => (info.cgroupVersion === undefined ? undefined : info)),
    Effect.orElseSucceed(() => undefined),
  );
  const space = hostSpaceOf(rootDir);
  const inputs: DoctorInputs = {
    report,
    listeners,
    owners: portOwners(),
    passwordAuth: sshPasswordAuth(ssh.main, ssh.readInclude),
    cgroupInfo,
    user: { name: NodeOS.userInfo().username, uid: NodeOS.userInfo().uid },
    fileValue: serviceEnv.entries[SANDBOX_HOST_PORTS_SETTING],
    filePorts: portsOfEnv(serviceEnv.entries),
    runningPorts: runningEnv === undefined ? undefined : portsOfEnv(runningEnv),
    serviceInstalled: Option.isSome(serviceStatus) && serviceStatus.value.installed,
    disk:
      report.hostFreeBytes !== null && report.hostTotalBytes !== null
        ? { freeBytes: report.hostFreeBytes, totalBytes: report.hostTotalBytes }
        : space,
  };
  const diagnosis: Diagnosis = diagnose(inputs);
  yield* Console.log(diagnosis.lines.join("\n"));
  if (!flags.fix) {
    if (!diagnosis.ready) return yield* userError("This machine cannot lend its Sandbox yet.");
    return;
  }
  yield* applyFix(diagnosis.fix, {
    confirm: (message) =>
      flags.yes
        ? Effect.succeed(true)
        : interactiveTerminal()
          ? Prompt.run(Prompt.Confirm({ message, initial: false })).pipe(
              Effect.catchTags({ QuitError: () => Effect.succeed(false) }),
            )
          : Console.log("\nNot a terminal: pass --yes to apply without asking.").pipe(
              Effect.as(false),
            ),
    write: (value) => CliService.writeServiceEnv(baseDir, { [SANDBOX_HOST_PORTS_SETTING]: value }),
    restart: service.restart,
  }).pipe(Effect.mapError((error) => (error instanceof Error ? userError(error.message) : error)));
});

export const sandboxDoctorCommand = Command.make("doctor", doctorFlags).pipe(
  Command.withDescription(
    "Check whether this machine can lend its Sandbox, and what to change if not. Never uses root.",
  ),
  Command.withHandler(
    Effect.fn("cli.sandbox.doctor")(function* (flags) {
      const resolved = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel, {
        quietLogs: true,
      });
      return yield* runDoctorCommand(resolved, flags).pipe(
        Effect.provide(CliService.layer(resolved)),
      );
    }),
  ),
);
