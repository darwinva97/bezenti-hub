// @effect-diagnostics nodeBuiltinImport:off -- drives the `podman` CLI and checks its user session.
/**
 * The Podman Sandbox runtime: a rootless container per Sandbox, named from its id, mounting only
 * its home, its Hub-written state (read-only) and its Hub socket's directory, unprivileged, in a network of its own without the
 * host's loopback. See docs/internals/sandboxes.md.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";

import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import { serveSandboxHubSocket } from "./SandboxHubSocket.ts";
import {
  ENVIRONMENT_CREDENTIAL_SECRET,
  writeJoinedHubState,
} from "../environments/joinedHubState.ts";
import { sandboxServerPaths } from "./sandboxHome.ts";
import { hostSpaceOf, measureWithDu, NO_LIMITS, type SandboxLimits } from "./sandboxLimits.ts";
import {
  type SandboxExit,
  SandboxHubAddress,
  type SandboxLimitSupport,
  SandboxRuntime,
  SandboxRuntimeError,
  type SandboxState,
} from "./SandboxRuntime.ts";

/** Where the Sandbox's home is mounted in its container: its server's base dir and `HOME`. */
export const SANDBOX_CONTAINER_HOME = "/home/sandbox";
/** Where the directory holding the Hub's socket is mounted in its container. */
export const SANDBOX_CONTAINER_HUB_DIR = "/run/t3-hub";
/**
 * The container's own loopback port that leads to the Hub's socket, so its server and git use a
 * plain `http://` Hub URL. It is the container's loopback, not the host's.
 */
export const SANDBOX_CONTAINER_HUB_PORT = 47_231;
export const SANDBOX_CONTAINER_HUB_URL = `http://127.0.0.1:${SANDBOX_CONTAINER_HUB_PORT}`;
/** The label every Sandbox container carries: its id. */
const SANDBOX_LABEL = "io.t3code.sandbox";
/** The label naming the Sandboxes root of the Hub that made it, so no Hub stops another's. */
const SANDBOX_ROOT_LABEL = "io.t3code.sandbox-root";
/** The labels recording a container's limits: `io.t3code.limit.<name>`, and `…limits-enforced`. */
const SANDBOX_LIMIT_LABEL = "io.t3code.limit";
/** The network: its own, with internet, without the host's loopback (also slirp4netns's default). */
const SANDBOX_NETWORK = "slirp4netns:allow_host_loopback=false";

const STOP_GRACE_SECONDS = 5;
/** A container log beyond this is rotated by Podman. */
const LOG_MAX_SIZE = "10mb";
/** How often a container checks its Hub still answers, and how many misses end it. */
const HUB_GONE_CHECK_MS = 10_000;
const HUB_GONE_CHECKS = 3;

/**
 * Runs inside the container as its first process, under the image's Node: forwards the container's
 * loopback port to the Hub's socket, starts the server with the arguments after it and passes on
 * its exit code. Kept here, not in the image, so any image with Node runs a Sandbox.
 */
const SANDBOX_ENTRY_SCRIPT = `
const net = require("node:net");
const childProcess = require("node:child_process");
const os = require("node:os");
const [socketPath, port, command, ...args] = process.argv.slice(1);
const forward = net.createServer((client) => {
  const hub = net.connect(socketPath);
  const end = () => { client.destroy(); hub.destroy(); };
  client.on("error", end); hub.on("error", end); client.on("close", end); hub.on("close", end);
  client.pipe(hub).pipe(client);
});
forward.on("error", (error) => { console.error("t3 sandbox: the Hub forward failed:", error); process.exit(70); });
forward.listen(Number(port), "127.0.0.1", () => {
  const child = childProcess.spawn(command, args, { stdio: "inherit" });
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
  child.on("error", (error) => { console.error("t3 sandbox: the server did not start:", error); process.exit(127); });
  child.on("exit", (code, signal) => process.exit(code ?? 128 + (os.constants.signals[signal] ?? 0)));
  // A Hub that died without stopping it (killed, crashed) no longer answers on its socket: the
  // Sandbox stops by itself after ${HUB_GONE_CHECKS} missed checks rather than run on unwatched.
  let missed = 0;
  setInterval(() => {
    const probe = net.connect(socketPath);
    probe.on("connect", () => { missed = 0; probe.destroy(); });
    probe.on("error", () => {
      if (++missed < ${HUB_GONE_CHECKS}) return;
      console.error("t3 sandbox: its Hub is gone; stopping.");
      child.kill("SIGTERM");
      setTimeout(() => process.exit(75), 5000);
    });
  }, ${HUB_GONE_CHECK_MS});
});
`;

/** On every image the Hub builds: its version, `<Hub version>-<UTC build time>`. */
export const SANDBOX_IMAGE_VERSION_LABEL = "io.t3code.image-version";

/** What an image is, as the Hub reads it: its id and, for one the Hub built, its version. */
export interface SandboxImageFound {
  readonly id: string;
  readonly version: string | null;
  readonly createdAt: string | null;
}

const PodmanImage = Schema.Struct({
  Id: Schema.String,
  Created: Schema.optional(Schema.String),
  Labels: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.String))),
});
const decodePodmanImages = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(PodmanImage)),
);

/** `podman image inspect`: the image `image` names now, or none. */
export const inspectSandboxImage = (image: string, podmanCommand?: string) =>
  runPodman(["image", "inspect", image], {
    ...(podmanCommand === undefined ? {} : { podmanCommand }),
    timeoutMs: 15_000,
  }).pipe(
    Effect.map((result): SandboxImageFound | null => {
      if (result.exitCode !== 0) return null;
      const [found] = Option.getOrElse(decodePodmanImages(result.stdout), () => []);
      if (found === undefined) return null;
      return {
        id: found.Id,
        version: found.Labels?.[SANDBOX_IMAGE_VERSION_LABEL] ?? null,
        createdAt: found.Created ?? null,
      };
    }),
  );

export interface PodmanSandboxRuntimeOptions {
  /**
   * The image's tag: the base image (apps/server/sandbox-image), or a dev image. Each start runs
   * the image the tag names then, so a Sandbox picks up a new build at its next start.
   */
  readonly image: string;
  /** Starts the T3 server in the image; `serve --base-dir …` is appended. Default `["t3"]`. */
  readonly serverCommand?: ReadonlyArray<string>;
  /**
   * Host directories mounted read-only at the same path: a dev Hub's checkout, so a dev image
   * runs the Hub's own source. Never in production, where the image carries the server.
   */
  readonly codeMounts?: ReadonlyArray<string>;
  /**
   * A dev Hub's own server, for an image the Hub did not build (a dev image of Node and git):
   * its command and code mounts. A base image runs its own `t3` and mounts no code.
   */
  readonly devServer?: {
    readonly serverCommand: ReadonlyArray<string>;
    readonly codeMounts: ReadonlyArray<string>;
  };
  /** A dev Hub's `--dev-url`, so its Sandboxes have the Replay provider too. */
  readonly devUrl?: string | undefined;
  /** Default: beside the Hub's home, `<Hub home>-sandboxes`, so no Sandbox is inside it. */
  readonly rootDir?: string;
  /** Prefixes every container name; default `t3-`. Tests use their own. */
  readonly namePrefix?: string;
  /** More labels on every container, such as a test run's. */
  readonly labels?: Readonly<Record<string, string>>;
  /** Default {@link SANDBOX_NETWORK}. */
  readonly network?: string;
  readonly podmanCommand?: string;
}

export interface PodmanResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Global flags for every `podman` call: cgroupfs when the systemd user session is out of reach,
 * as in a `wsl -e` session, where Podman would fall back to it anyway with a warning per call.
 */
export const podmanGlobalArgs = (): ReadonlyArray<string> => {
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  const bus = runtimeDir === undefined ? undefined : `${runtimeDir.replace(/\/$/u, "")}/bus`;
  return bus !== undefined && NodeFS.existsSync(bus) ? [] : ["--cgroup-manager=cgroupfs"];
};

export const runPodman = (
  args: ReadonlyArray<string>,
  options: { readonly podmanCommand?: string; readonly timeoutMs?: number } = {},
) =>
  Effect.callback<PodmanResult>((resume) => {
    const child = NodeChildProcess.execFile(
      options.podmanCommand ?? "podman",
      [...podmanGlobalArgs(), ...args],
      { timeout: options.timeoutMs ?? 120_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code =
          error === null ? 0 : typeof error.code === "number" ? (error.code as number) : null;
        resume(Effect.succeed({ exitCode: code, stdout, stderr }));
      },
    );
    return Effect.sync(() => child.kill("SIGKILL"));
  });

/** What `podman info` says of the cgroups its containers get. */
export interface PodmanCgroupInfo {
  readonly cgroupManager: string | undefined;
  readonly cgroupVersion: string | undefined;
  readonly cgroupControllers: ReadonlyArray<string>;
}

const NOT_ENFORCED = "CPU, memory and PIDs limits are not enforced on this host";

/**
 * Which limits rootless Podman enforces, from its cgroups: only a cgroup v2 host whose systemd
 * user session gives each container a cgroup of its own, with the controllers delegated to the
 * Hub's user. Under cgroupfs (no systemd user bus, as in a `wsl -e` session) a rootless container
 * shares its caller's cgroup, and a memory or PIDs flag makes `podman run` fail or is ignored.
 */
export const podmanLimitSupport = (info: PodmanCgroupInfo): SandboxLimitSupport => {
  const none = (note: string): SandboxLimitSupport => ({
    cpus: false,
    memory: false,
    pids: false,
    note,
  });
  if (info.cgroupVersion !== "v2") {
    return none(
      `Podman runs on cgroups ${info.cgroupVersion ?? "of an unknown version"} here, where rootless containers get no limits: ${NOT_ENFORCED}.`,
    );
  }
  if (info.cgroupManager !== "systemd") {
    return none(
      `Podman uses the ${info.cgroupManager ?? "unknown"} cgroup manager here because the Hub's systemd user session bus ($XDG_RUNTIME_DIR/bus) is not reachable (as in a \`wsl -e\` session), so rootless containers get no cgroup of their own: ${NOT_ENFORCED}. Run the Hub as a systemd user service, with dbus-user-session installed, to enforce them.`,
    );
  }
  const has = (controller: string) => info.cgroupControllers.includes(controller);
  const missing = ["cpu", "memory", "pids"].filter((controller) => !has(controller));
  return {
    cpus: has("cpu"),
    memory: has("memory"),
    pids: has("pids"),
    note:
      missing.length === 0
        ? null
        : `The Hub user's cgroup has no ${missing.join(", ")} controller delegated, so those limits are not enforced on this host. Delegate them (Delegate=cpu cpuset io memory pids for user@.service) to enforce them.`,
  };
};

/**
 * The `podman run` flags for the limits the host enforces; memory with no swap beyond it. The
 * others are left out, since under cgroupfs a memory or PIDs flag makes the run fail.
 */
export const podmanLimitArgs = (
  limits: SandboxLimits,
  support: SandboxLimitSupport,
): ReadonlyArray<string> => [
  ...(support.cpus && limits.cpus !== null ? [`--cpus=${limits.cpus}`] : []),
  ...(support.memory && limits.memoryBytes !== null
    ? [`--memory=${limits.memoryBytes}b`, `--memory-swap=${limits.memoryBytes}b`]
    : []),
  ...(support.pids && limits.pids !== null ? [`--pids-limit=${limits.pids}`] : []),
];

/** Labels recording the limits a container was started with, and which of them are enforced. */
export const podmanLimitLabels = (
  limits: SandboxLimits,
  support: SandboxLimitSupport,
): Readonly<Record<string, string>> => {
  const enforced = [
    ...(support.cpus ? ["cpus"] : []),
    ...(support.memory ? ["memory"] : []),
    ...(support.pids ? ["pids"] : []),
  ];
  return {
    [`${SANDBOX_LIMIT_LABEL}.cpus`]: String(limits.cpus ?? "none"),
    [`${SANDBOX_LIMIT_LABEL}.memory-bytes`]: String(limits.memoryBytes ?? "none"),
    [`${SANDBOX_LIMIT_LABEL}.pids`]: String(limits.pids ?? "none"),
    [`${SANDBOX_LIMIT_LABEL}s-enforced`]: enforced.length === 0 ? "none" : enforced.join(","),
  };
};

export const readCgroupInfo = (podmanCommand?: string) =>
  runPodman(["info", "--format", "json"], {
    ...(podmanCommand === undefined ? {} : { podmanCommand }),
    timeoutMs: 15_000,
  }).pipe(
    Effect.map((result): PodmanCgroupInfo => {
      try {
        const host = (JSON.parse(result.stdout) as { host?: Record<string, unknown> }).host ?? {};
        const controllers = host.cgroupControllers;
        return {
          cgroupManager: typeof host.cgroupManager === "string" ? host.cgroupManager : undefined,
          cgroupVersion: typeof host.cgroupVersion === "string" ? host.cgroupVersion : undefined,
          cgroupControllers: Array.isArray(controllers)
            ? controllers.filter((entry): entry is string => typeof entry === "string")
            : [],
        };
      } catch {
        return { cgroupManager: undefined, cgroupVersion: undefined, cgroupControllers: [] };
      }
    }),
  );

/** Whether `podman` runs here, rootless. */
export const detectRootlessPodman = (podmanCommand?: string) =>
  runPodman(["info", "--format", "{{.Host.Security.Rootless}}"], {
    ...(podmanCommand === undefined ? {} : { podmanCommand }),
    timeoutMs: 5_000,
  }).pipe(Effect.map((result) => result.exitCode === 0 && result.stdout.trim() === "true"));

interface Running {
  readonly scope: Scope.Closeable;
  /** What `podman run --detach` printed: every later call names the container by it. */
  readonly containerId: string;
  readonly startedAt: string;
  readonly exited: Deferred.Deferred<number | null>;
  /** The version of the base image it runs; null for a dev image. */
  readonly imageVersion: string | null;
  /** Set before its scope closes, so the end is not reported as a crash. */
  stopping: boolean;
}

/** `.env` files the walk finds under `dir`, not descending into `node_modules`. */
const envFilesUnder = (dir: string, found: Array<string> = [], depth = 0): Array<string> => {
  if (depth > 12 || found.length > 0) return found;
  let entries: Array<NodeFS.Dirent>;
  try {
    entries = NodeFS.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = `${dir}/${entry.name}`;
    if (/^\.env(\..*)?$/u.test(entry.name)) found.push(full);
    else if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".git") {
      envFilesUnder(full, found, depth + 1);
    }
  }
  return found;
};

/**
 * The first path the read-only mounts land on that is not what it must be (a directory, or a
 * regular file or nothing), relative to the home: a Sandbox could leave a link or a FIFO there.
 */
const unsafeMountTarget = (home: string) => {
  const checks: ReadonlyArray<readonly [string, "dir" | "file"]> = [
    ["userdata", "dir"],
    ["userdata/secrets", "dir"],
    ["userdata/joined-hub.json", "file"],
    [`userdata/secrets/${ENVIRONMENT_CREDENTIAL_SECRET}.bin`, "file"],
  ];
  for (const [relative, kind] of checks) {
    let stat: NodeFS.Stats;
    try {
      stat = NodeFS.lstatSync(`${home}/${relative}`);
    } catch {
      continue;
    }
    if (kind === "dir" ? !stat.isDirectory() : !stat.isFile()) return relative;
  }
  return undefined;
};

const isUnder = (parent: string, child: string) =>
  child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);

const make = Effect.fn("PodmanSandboxRuntime.make")(function* (
  options: PodmanSandboxRuntimeOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const address = yield* SandboxHubAddress;
  const rootDir =
    options.rootDir ??
    path.join(path.dirname(config.baseDir), `${path.basename(config.baseDir)}-sandboxes`);
  const namePrefix = options.namePrefix ?? "t3-";
  const podmanOptions =
    options.podmanCommand === undefined ? {} : { podmanCommand: options.podmanCommand };
  const runtimeScope = yield* Effect.scope;
  const running = new Map<string, Running>();
  const exits = yield* PubSub.unbounded<SandboxExit>();
  const lock = yield* Semaphore.make(1);
  // The Hub's loopback address, read once per start and by the socket on each request.
  let hubUrl = yield* address.loopbackUrl;
  const containerPaths = yield* sandboxServerPaths(SANDBOX_CONTAINER_HOME).pipe(
    Effect.provideService(Path.Path, path),
  );

  const homeOf = (sandboxId: string) => path.join(rootDir, sandboxId);
  const containerOf = (sandboxId: string) => `${namePrefix}${sandboxId}`;
  /**
   * The credential and `joined-hub.json`, which only the Hub writes: outside the home the
   * Sandbox can write, each mounted read-only over its path in the home.
   */
  const stateDirOf = (sandboxId: string) => path.join(rootDir, ".state", sandboxId);
  const credentialOf = (sandboxId: string) => path.join(stateDirOf(sandboxId), "credential");
  const joinedOf = (sandboxId: string) => path.join(stateDirOf(sandboxId), "joined-hub.json");
  // Short, since a UNIX socket path has ~107 bytes; beside the homes, never in one.
  const socketDirOf = (sandboxId: string) =>
    path.join(
      rootDir,
      ".hub",
      NodeCrypto.createHash("sha256").update(sandboxId).digest("hex").slice(0, 16),
    );
  const failure = (operation: string, sandboxId: string) => (cause: unknown) =>
    new SandboxRuntimeError({
      operation,
      sandboxId,
      detail: cause instanceof Error ? cause.message : String(cause),
    });
  const podman = (args: ReadonlyArray<string>, timeoutMs?: number) =>
    runPodman(args, { ...podmanOptions, ...(timeoutMs === undefined ? {} : { timeoutMs }) });

  /** Stops a container (SIGTERM, then SIGKILL after a grace) and removes it, by its id. */
  const removeContainer = (containerId: string) =>
    podman(["stop", "--time", String(STOP_GRACE_SECONDS), containerId]).pipe(
      Effect.andThen(podman(["rm", "--force", containerId])),
    );

  /** The ids of this Hub's containers (its root label), optionally of one Sandbox. */
  const containersOfThisHub = (sandboxId?: string) =>
    podman([
      "ps",
      "--all",
      "--filter",
      `label=${SANDBOX_ROOT_LABEL}=${rootDir}`,
      ...(sandboxId === undefined ? [] : ["--filter", `label=${SANDBOX_LABEL}=${sandboxId}`]),
      "--format",
      "{{.ID}}",
    ]).pipe(
      Effect.map((result) =>
        result.exitCode === 0
          ? result.stdout
              .split("\n")
              .map((line) => line.trim())
              .filter((line) => line !== "")
          : [],
      ),
    );

  /**
   * Before a start: removes what is left of the Sandbox's container (by id), and refuses when a
   * container of that name belongs to another Hub.
   */
  const removeLeftover = Effect.fn("PodmanSandboxRuntime.removeLeftover")(function* (
    sandboxId: string,
  ) {
    for (const id of yield* containersOfThisHub(sandboxId)) yield* removeContainer(id);
    const name = containerOf(sandboxId);
    const other = yield* podman(["container", "exists", name]);
    if (other.exitCode === 0) {
      return yield* failure(
        "start",
        sandboxId,
      )(`a container named ${name} exists that this Hub did not make.`);
    }
  });

  /**
   * A dev Hub's code mounts, checked once: none may hold the Hub's home, the Sandboxes or a
   * `.env` file, since a Sandbox reads everything mounted.
   */
  const codeMountsChecked = new Map<string, string | undefined>();
  const checkCodeMounts = (mounts: ReadonlyArray<string>) => {
    const key = mounts.join("\0");
    if (codeMountsChecked.has(key)) return codeMountsChecked.get(key);
    const refusal = (() => {
      for (const dir of mounts) {
        const real = NodeFS.realpathSync(dir);
        for (const secret of [rootDir, config.baseDir]) {
          const resolved = NodeFS.existsSync(secret) ? NodeFS.realpathSync(secret) : secret;
          if (isUnder(real, resolved) || isUnder(dir, secret)) {
            return `the code mount ${dir} holds ${secret}.`;
          }
        }
        const env = envFilesUnder(real);
        if (env.length > 0) return `the code mount ${dir} holds ${env[0]}.`;
      }
      return undefined;
    })();
    codeMountsChecked.set(key, refusal);
    return refusal;
  };

  /**
   * What a start runs: the image the tag names now (by id, so a build meanwhile changes nothing
   * mid-start), and its server. A base image runs its own `t3`; a dev Hub's dev image, its source.
   */
  const resolveImage = Effect.fn("PodmanSandboxRuntime.resolveImage")(function* (
    sandboxId: string,
  ) {
    const found = yield* inspectSandboxImage(options.image, options.podmanCommand);
    if (found === null) {
      return yield* failure(
        "start",
        sandboxId,
      )(`its image ${options.image} is not built; build it with \`t3 sandbox image build\`.`);
    }
    const dev = found.version === null ? options.devServer : undefined;
    return {
      imageId: found.id,
      version: found.version,
      serverCommand: options.serverCommand ?? dev?.serverCommand ?? ["t3"],
      codeMounts: options.codeMounts ?? dev?.codeMounts ?? [],
    };
  });

  const create: SandboxRuntime["Service"]["create"] = Effect.fn("PodmanSandboxRuntime.create")(
    function* (spec) {
      const home = homeOf(spec.sandboxId);
      // A new home gets the directories the read-only mounts land in, owned by the Hub's user;
      // an existing one is the Sandbox's and is never walked, so a link there leads nowhere.
      if (!NodeFS.existsSync(home)) {
        const paths = yield* sandboxServerPaths(home).pipe(Effect.provideService(Path.Path, path));
        yield* fs.makeDirectory(rootDir, { recursive: true, mode: 0o700 });
        yield* fs.makeDirectory(home, { mode: 0o700 });
        yield* fs.makeDirectory(paths.secretsDir, { recursive: true, mode: 0o700 });
      }
      const stateDir = stateDirOf(spec.sandboxId);
      yield* fs.makeDirectory(stateDir, { recursive: true, mode: 0o700 });
      yield* fs.writeFileString(credentialOf(spec.sandboxId), Redacted.value(spec.credential), {
        mode: 0o600,
      });
      yield* writeJoinedHubState(joinedOf(spec.sandboxId), {
        hubUrl: SANDBOX_CONTAINER_HUB_URL,
        hubEnvironmentId: spec.hubEnvironmentId,
        environmentId: spec.environmentId,
        name: spec.name,
        joinedAt: DateTime.formatIso(yield* DateTime.now),
        spaceId: spec.spaceId,
        sandboxed: true,
        sandboxRuntime: "podman",
      }).pipe(Effect.provideService(FileSystem.FileSystem, fs));
    },
    (effect, spec) => Effect.mapError(effect, failure("be created", spec.sandboxId)),
  );

  const runArgs = (
    sandboxId: string,
    socketDir: string,
    image: {
      readonly imageId: string;
      readonly serverCommand: ReadonlyArray<string>;
      readonly codeMounts: ReadonlyArray<string>;
    },
    limits: SandboxLimits,
  ) => {
    const [command, ...commandArgs] = image.serverCommand;
    return [
      "run",
      "--detach",
      "--name",
      containerOf(sandboxId),
      "--label",
      `${SANDBOX_LABEL}=${sandboxId}`,
      "--label",
      `${SANDBOX_ROOT_LABEL}=${rootDir}`,
      ...Object.entries(options.labels ?? {}).flatMap(([key, value]) => [
        "--label",
        `${key}=${value}`,
      ]),
      ...Object.entries(podmanLimitLabels(limits, limitSupport)).flatMap(([key, value]) => [
        "--label",
        `${key}=${value}`,
      ]),
      ...podmanLimitArgs(limits, limitSupport),
      "--hostname",
      "sandbox",
      // The Hub's user, mapped to itself, so the home it made is the server's; no root inside.
      "--userns=keep-id",
      "--cap-drop=all",
      "--security-opt=no-new-privileges",
      "--init",
      `--network=${options.network ?? SANDBOX_NETWORK}`,
      "--log-driver=k8s-file",
      `--log-opt=path=${path.join(rootDir, `${sandboxId}.log`)}`,
      `--log-opt=max-size=${LOG_MAX_SIZE}`,
      "--volume",
      `${homeOf(sandboxId)}:${SANDBOX_CONTAINER_HOME}:rw`,
      "--volume",
      `${credentialOf(sandboxId)}:${path.join(containerPaths.secretsDir, `${ENVIRONMENT_CREDENTIAL_SECRET}.bin`)}:ro`,
      "--volume",
      `${joinedOf(sandboxId)}:${containerPaths.joinedHubPath}:ro`,
      "--volume",
      `${socketDir}:${SANDBOX_CONTAINER_HUB_DIR}:ro`,
      ...image.codeMounts.flatMap((dir) => ["--volume", `${dir}:${dir}:ro`]),
      "--env",
      `HOME=${SANDBOX_CONTAINER_HOME}`,
      "--workdir",
      SANDBOX_CONTAINER_HOME,
      "--entrypoint",
      "node",
      image.imageId,
      "-e",
      SANDBOX_ENTRY_SCRIPT,
      `${SANDBOX_CONTAINER_HUB_DIR}/hub.sock`,
      String(SANDBOX_CONTAINER_HUB_PORT),
      command ?? "t3",
      ...commandArgs,
      "serve",
      "--base-dir",
      SANDBOX_CONTAINER_HOME,
      "--no-browser",
      ...(options.devUrl === undefined ? [] : ["--dev-url", options.devUrl]),
    ];
  };

  /** Ends a running entry: its scope (its container, by id, and its socket) first, then the entry. */
  const endEntry = (sandboxId: string, entry: Running) =>
    Effect.suspend(() => {
      entry.stopping = true;
      return Scope.close(entry.scope, Exit.void).pipe(
        Effect.andThen(
          Effect.sync(() => {
            if (running.get(sandboxId) === entry) running.delete(sandboxId);
          }),
        ),
      );
    });

  const stopLocked = (sandboxId: string) =>
    Effect.suspend(() => {
      const current = running.get(sandboxId);
      return current === undefined ? Effect.void : endEntry(sandboxId, current);
    });

  /**
   * Completes with the container's exit code once it has ended. A `podman wait` that fails is not
   * an exit: the container's state decides, and a running one is waited on again.
   */
  const waitFor = Effect.fn("PodmanSandboxRuntime.waitFor")(function* (
    containerId: string,
  ): Effect.fn.Return<number | null> {
    const waited = yield* podman(["wait", containerId], 0);
    const code = Number.parseInt(waited.stdout.trim(), 10);
    if (waited.exitCode === 0 && Number.isFinite(code)) return code;
    const state = yield* podman([
      "container",
      "inspect",
      "--format",
      "{{.State.Running}} {{.State.ExitCode}}",
      containerId,
    ]);
    if (state.exitCode !== 0) return null;
    const [isRunning, exitCode] = state.stdout.trim().split(" ");
    if (isRunning !== "true") return Number.parseInt(exitCode ?? "", 10) || null;
    yield* Effect.sleep("1 second");
    return yield* waitFor(containerId);
  });

  const start: SandboxRuntime["Service"]["start"] = Effect.fn("PodmanSandboxRuntime.start")(
    function* (sandboxId, startOptions) {
      const current = running.get(sandboxId);
      if (current !== undefined) {
        return { exited: Deferred.await(current.exited), imageVersion: current.imageVersion };
      }
      if (!NodeFS.existsSync(joinedOf(sandboxId)) || !NodeFS.existsSync(homeOf(sandboxId))) {
        return yield* failure("start", sandboxId)("it has no home; create it first.");
      }
      const image = yield* resolveImage(sandboxId);
      const refused = checkCodeMounts(image.codeMounts);
      if (refused !== undefined) return yield* failure("start", sandboxId)(refused);
      yield* removeLeftover(sandboxId);
      // With no container left, nothing changes the home while this looks (lstat: no link is
      // followed, nothing opened).
      const unsafe = unsafeMountTarget(homeOf(sandboxId));
      if (unsafe !== undefined) {
        return yield* failure(
          "start",
          sandboxId,
        )(
          `its home has a link or a special file at ${unsafe}, where the Hub mounts its credential.`,
        );
      }
      hubUrl = yield* address.loopbackUrl;
      const socketDir = socketDirOf(sandboxId);
      yield* fs
        .makeDirectory(socketDir, { recursive: true, mode: 0o700 })
        .pipe(Effect.mapError(failure("start", sandboxId)));
      const scope = yield* Scope.fork(runtimeScope);
      const containerId = yield* Effect.gen(function* () {
        yield* serveSandboxHubSocket({
          socketPath: path.join(socketDir, "hub.sock"),
          hubUrl: () => hubUrl,
        }).pipe(Effect.mapError(failure("start", sandboxId)));
        const ran = yield* podman(
          runArgs(sandboxId, socketDir, image, startOptions?.limits ?? NO_LIMITS),
        );
        const id = ran.stdout.trim().split("\n").at(-1)?.trim() ?? "";
        if (ran.exitCode !== 0 || id === "") {
          // A container made but not started still goes.
          yield* podman(["rm", "--force", containerOf(sandboxId)]);
          return yield* failure(
            "start",
            sandboxId,
          )(`podman run failed: ${ran.stderr.trim() || `exit code ${ran.exitCode}`}`);
        }
        yield* Scope.addFinalizer(scope, Effect.asVoid(removeContainer(id)));
        return id;
      }).pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.onError(() => Scope.close(scope, Exit.void)),
      );
      const entry: Running = {
        scope,
        containerId,
        startedAt: DateTime.formatIso(yield* DateTime.now),
        exited: yield* Deferred.make<number | null>(),
        imageVersion: image.version,
        stopping: false,
      };
      running.set(sandboxId, entry);
      yield* waitFor(containerId).pipe(
        Effect.flatMap((exitCode) =>
          Deferred.succeed(entry.exited, exitCode).pipe(
            Effect.andThen(
              lock.withPermits(1)(
                Effect.suspend(() =>
                  entry.stopping
                    ? Effect.void
                    : endEntry(sandboxId, entry).pipe(
                        Effect.andThen(PubSub.publish(exits, { sandboxId, exitCode })),
                      ),
                ),
              ),
            ),
          ),
        ),
        Effect.forkIn(runtimeScope),
      );
      return { exited: Deferred.await(entry.exited), imageVersion: entry.imageVersion };
    },
    (effect) => lock.withPermits(1)(effect),
  );

  const stop: SandboxRuntime["Service"]["stop"] = (sandboxId) =>
    lock.withPermits(1)(stopLocked(sandboxId)).pipe(Effect.withSpan("PodmanSandboxRuntime.stop"));

  const remove: SandboxRuntime["Service"]["delete"] = Effect.fn("PodmanSandboxRuntime.delete")(
    function* (sandboxId) {
      yield* lock
        .withPermits(1)(stopLocked(sandboxId).pipe(Effect.andThen(removeLeftover(sandboxId))))
        .pipe(Effect.mapError(failure("be deleted", sandboxId)));
      // Outside the lock: removing a home can take a while, and never follows its links.
      yield* fs
        .remove(homeOf(sandboxId), { recursive: true, force: true })
        .pipe(Effect.mapError(failure("be deleted", sandboxId)));
      for (const leftover of [stateDirOf(sandboxId), socketDirOf(sandboxId)]) {
        yield* fs.remove(leftover, { recursive: true, force: true }).pipe(Effect.ignore);
      }
      yield* fs.remove(path.join(rootDir, `${sandboxId}.log`), { force: true }).pipe(Effect.ignore);
    },
  );

  const inspect: SandboxRuntime["Service"]["inspect"] = (sandboxId) =>
    Effect.sync(() => {
      const homePath = homeOf(sandboxId);
      const current = running.get(sandboxId);
      // Without the Hub's own state (made by another runtime, or lost) it counts as missing, so
      // the next start creates it again with a new credential.
      const state: SandboxState =
        current !== undefined
          ? { _tag: "running", pid: null, startedAt: current.startedAt }
          : NodeFS.existsSync(joinedOf(sandboxId)) && NodeFS.existsSync(homePath)
            ? { _tag: "stopped" }
            : { _tag: "missing" };
      return { state, homePath };
    });

  /**
   * The container's processes as `podman top` sees them, summed: their resident memory and their
   * CPU averaged over each one's life. Read from the processes, not the cgroup, which a container
   * under cgroupfs shares with its caller.
   */
  const resourceUse: SandboxRuntime["Service"]["resourceUse"] = (sandboxId) =>
    Effect.suspend(() => {
      const current = running.get(sandboxId);
      if (current === undefined) return Effect.succeed(null);
      return podman(["top", current.containerId, "rss", "pcpu"], 15_000).pipe(
        Effect.map((result) => {
          if (result.exitCode !== 0) return null;
          let rssKib = 0;
          let cpu = 0;
          for (const line of result.stdout.split("\n").slice(1)) {
            const [rss, pcpu] = line.trim().split(/\s+/u);
            const rssValue = Number.parseFloat(rss ?? "");
            const cpuValue = Number.parseFloat(pcpu ?? "");
            if (Number.isFinite(rssValue)) rssKib += rssValue;
            if (Number.isFinite(cpuValue)) cpu += cpuValue;
          }
          return { cpuPercent: Math.round(cpu * 10) / 10, memoryBytes: rssKib * 1024 };
        }),
      );
    });

  // Asked once: the Hub's log and Settings say what is not enforced (`Sandboxes`).
  const limitSupport = podmanLimitSupport(yield* readCgroupInfo(options.podmanCommand));

  // A Hub that crashed left its containers: none of them is serving it any more.
  for (const id of yield* containersOfThisHub()) yield* removeContainer(id);

  // The Hub's containers end with it: a Sandbox left running would outlive what started it.
  yield* Effect.addFinalizer(() =>
    Effect.forEach([...running.keys()], stopLocked, { discard: true, concurrency: "unbounded" }),
  );

  return SandboxRuntime.of({
    kind: "podman",
    create,
    start,
    imageVersion: inspectSandboxImage(options.image, options.podmanCommand).pipe(
      Effect.map((found) => found?.version ?? null),
    ),
    stop,
    delete: remove,
    inspect,
    limitSupport: Effect.succeed(limitSupport),
    resourceUse,
    // As root of the Hub user's namespace (`podman unshare`): the container's own uids, so a
    // directory the Sandbox made unreadable to it is still read.
    measureHome: Effect.fn("PodmanSandboxRuntime.measureHome")(function* (sandboxId) {
      return yield* measureWithDu(options.podmanCommand ?? "podman", [
        ...podmanGlobalArgs(),
        "unshare",
        "du",
        "-s",
        "-k",
        "-x",
        homeOf(sandboxId),
      ]);
    }),
    hostSpace: Effect.sync(() => hostSpaceOf(rootDir)),
    exits: Stream.fromPubSub(exits),
  });
});

export const layer = (options: PodmanSandboxRuntimeOptions) =>
  Layer.effect(SandboxRuntime, make(options));
