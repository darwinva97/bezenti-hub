// @effect-diagnostics nodeBuiltinImport:off -- stages the build context and streams `podman build`.
/**
 * The Sandboxes' base image (apps/server/sandbox-image/Containerfile), built by the Hub one build
 * at a time from `t3 sandbox image build` or Settings, tagged with its version and audited. A
 * Sandbox runs the newest one from its next start. See docs/internals/sandboxes.md, «Base image».
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSea from "node:sea";

import {
  HUB_MACHINE_ENVIRONMENT_ID,
  type SandboxImageBuild,
  type SandboxImageInfo,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import packageJson from "../../package.json" with { type: "json" };
import * as AuditLog from "../audit/AuditLog.ts";
import {
  detectRootlessPodman,
  inspectSandboxImage,
  podmanGlobalArgs,
  runPodman,
  type SandboxImageFound,
} from "./PodmanSandboxRuntime.ts";

/** The image Sandboxes run; by default the one built for this Hub's version. */
const SANDBOX_IMAGE_SETTING = "T3CODE_SANDBOX_IMAGE";
const DEFAULT_SANDBOX_IMAGE = `localhost/t3code-sandbox:${packageJson.version}`;
/** On every image the Hub builds, so it removes only its own old ones. */
const SANDBOX_IMAGE_LABEL = "io.t3code.sandbox-image";
/** A first build downloads Debian, Node and the CLIs; later ones reuse those layers. */
const BUILD_TIMEOUT_MS = 60 * 60 * 1000;
const LOG_LINES_KEPT = 400;
/** Each line of the build's output is cut here, and all it keeps at most this many characters. */
const LINE_MAX_CHARS = 2_048;
const LOG_MAX_CHARS = 256 * 1024;

export const configuredSandboxImage = Config.String(SANDBOX_IMAGE_SETTING).pipe(
  Config.option,
  Effect.map(Option.getOrElse(() => DEFAULT_SANDBOX_IMAGE)),
  Effect.orElseSucceed(() => DEFAULT_SANDBOX_IMAGE),
);

/** The checkout a Hub run from source lives in: the nearest directory with the pnpm workspace. */
export const checkoutOf = (entry: string) => {
  let dir = NodePath.dirname(NodePath.resolve(entry));
  while (dir !== NodePath.dirname(dir)) {
    if (NodeFS.existsSync(NodePath.join(dir, "pnpm-workspace.yaml"))) return dir;
    dir = NodePath.dirname(dir);
  }
  return undefined;
};

export class SandboxImageBuildError extends Schema.TaggedError<SandboxImageBuildError>()(
  "SandboxImageBuildError",
  { detail: Schema.String },
) {
  override get message(): string {
    return `The Sandbox image could not be built: ${this.detail}`;
  }
}

/** `localhost/t3code-sandbox:0.1.7` → `localhost/t3code-sandbox`. */
const repositoryOf = (image: string) => {
  const slash = image.lastIndexOf("/");
  const colon = image.lastIndexOf(":");
  return colon > slash ? image.slice(0, colon) : image;
};

/** `<Hub version>-<UTC time>`: one per build, so a Sandbox's version tells which build it runs. */
const buildVersion = (now: DateTime.Utc) =>
  `${packageJson.version}-${DateTime.formatIso(now)
    .replace(/\.\d+Z$/u, "")
    .replace(/[-:T]/gu, "")}`;

/** Runs a command, handing each line of its output to `onLine`; fails on a non-zero exit. */
const streamCommand = (
  command: string,
  args: ReadonlyArray<string>,
  onLine: (line: string) => void,
  options: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly timeoutMs: number;
  },
) =>
  Effect.callback<void, SandboxImageBuildError>((resume) => {
    const child = NodeChildProcess.spawn(command, [...args], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (const stream of [child.stdout, child.stderr]) {
      // Progress bars redraw with a bare carriage return: each redraw is a line of its own.
      let pending = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        const parts = (pending + chunk).split(/\r\n|\r|\n/u);
        pending = (parts.pop() ?? "").slice(0, LINE_MAX_CHARS);
        for (const line of parts) onLine(line.slice(0, LINE_MAX_CHARS));
      });
      stream.on("end", () => {
        if (pending !== "") onLine(pending);
      });
    }
    child.on("error", (error) => {
      resume(Effect.fail(new SandboxImageBuildError({ detail: error.message })));
    });
    child.on("close", (code, signal) => {
      resume(
        code === 0
          ? Effect.void
          : Effect.fail(
              new SandboxImageBuildError({
                detail: `${NodePath.basename(command)} ${args[0] ?? ""} ${
                  signal === null ? `exited with code ${code}` : `was stopped (${signal})`
                }.`,
              }),
            ),
      );
    });
    return Effect.sync(() => child.kill("SIGKILL"));
  }).pipe(
    // Interrupted (the timeout, or the Hub stopping), the command is killed.
    Effect.timeoutOrElse({
      duration: options.timeoutMs,
      orElse: () =>
        Effect.fail(
          new SandboxImageBuildError({
            detail: `${NodePath.basename(command)} ${args[0] ?? ""} took too long.`,
          }),
        ),
    }),
  );

/**
 * The staging's environment: only what pnpm and vp need (a proxy and private CA to reach the
 * registry included, and the package managers' own settings), never the Hub's provider keys,
 * tokens or build settings. Its tools resolve `node` from PATH, the Hub's own first; in WSL the PATH the Hub
 * took from the login shell also lists Windows directories, whose `node` and `pnpm` cannot run.
 */
const STAGING_ENV_KEPT = [
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
];
/** Settings of npm and pnpm themselves (`npm_config_registry`, `PNPM_HOME`, …). */
const STAGING_ENV_PREFIXES = ["npm_config_", "NPM_CONFIG_", "PNPM_"];
export const stagingEnvironment = (env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
  const entries = (env.PATH ?? "").split(NodePath.delimiter).filter((entry) => entry !== "");
  const usable =
    env.WSL_DISTRO_NAME === undefined
      ? entries
      : entries.filter((entry) => !entry.startsWith("/mnt/"));
  const kept: NodeJS.ProcessEnv = {};
  for (const key of STAGING_ENV_KEPT) if (env[key] !== undefined) kept[key] = env[key];
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && STAGING_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      kept[key] = value;
    }
  }
  return {
    ...kept,
    PATH: [NodePath.dirname(process.execPath), ...usable].join(NodePath.delimiter),
  };
};

/**
 * What the build context takes of `sandbox-image/`, files and whole directories (the release
 * archive carries the same, scripts/build-cli-archive.ts).
 */
const SANDBOX_IMAGE_FILES = [
  "Containerfile",
  "clis/package.json",
  "clis/package-lock.json",
  "office/package.json",
  "office/package-lock.json",
  "office/requirements.txt",
  "skills",
];

/**
 * The context: the Containerfile, and the server of this Hub's version. A `t3` release runs from
 * its own tree, which is copied as it is; a Hub run from a checkout (source or its `dist`) stages
 * that checkout's server (scripts/stage-sandbox-server.ts).
 */
/**
 * Everything under the context readable by all (directories and executables searchable too), as
 * the image keeps these modes and its Sandbox runs as a plain user; whatever the umask the files
 * were made under. The context directory itself stays 0700: the Hub's alone on this machine.
 */
export const makeContextReadable = (contextDir: string) => {
  const walk = (dir: string) => {
    for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
      const path = NodePath.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      const mode = NodeFS.statSync(path).mode & 0o7777;
      if (entry.isDirectory()) {
        if ((mode & 0o555) !== 0o555) NodeFS.chmodSync(path, mode | 0o555);
        walk(path);
      } else {
        const wanted = mode | 0o444 | ((mode & 0o100) === 0 ? 0 : 0o111);
        if (wanted !== mode) NodeFS.chmodSync(path, wanted);
      }
    }
  };
  walk(contextDir);
};

const prepareContext = Effect.fn("SandboxImage.prepareContext")(function* (
  contextDir: string,
  onLine: (line: string) => void,
  fromCheckout: string | undefined,
) {
  const copy = (from: string, to: string) =>
    Effect.try({
      try: () => NodeFS.cpSync(from, to, { recursive: true, dereference: true }),
      catch: (cause) => new SandboxImageBuildError({ detail: String(cause) }),
    });
  /** The image's definition: its files only, whatever else lies in that directory. */
  const copyDefinition = (from: string) =>
    Effect.forEach(SANDBOX_IMAGE_FILES, (file) =>
      Effect.try({
        try: () => {
          NodeFS.mkdirSync(NodePath.dirname(NodePath.join(contextDir, file)), { recursive: true });
          NodeFS.cpSync(NodePath.join(from, file), NodePath.join(contextDir, file), {
            recursive: true,
          });
        },
        catch: (cause) => new SandboxImageBuildError({ detail: String(cause) }),
      }),
    );
  if (fromCheckout === undefined && NodeSea.isSea()) {
    const tree = NodePath.dirname(process.execPath);
    const definition = NodePath.join(tree, "sandbox-image");
    if (!NodeFS.existsSync(NodePath.join(definition, "Containerfile"))) {
      return yield* new SandboxImageBuildError({
        detail: `this installation has no ${definition}/Containerfile; install T3 Code again.`,
      });
    }
    onLine(`Copying the T3 server ${packageJson.version} from ${tree}...`);
    yield* copyDefinition(definition);
    for (const entry of NodeFS.readdirSync(tree)) {
      if (entry === "sandbox-image" || entry === "node_modules" || entry.startsWith(".")) continue;
      yield* copy(NodePath.join(tree, entry), NodePath.join(contextDir, "server", entry));
    }
    const modules = NodePath.join(tree, "node_modules");
    if (NodeFS.existsSync(modules)) yield* copy(modules, NodePath.join(contextDir, "modules"));
    for (const dir of ["server", "modules", "extras"]) {
      NodeFS.mkdirSync(NodePath.join(contextDir, dir), { recursive: true });
    }
    return;
  }
  const entry = process.argv[1];
  const checkout = fromCheckout ?? (entry === undefined ? undefined : checkoutOf(entry));
  if (checkout === undefined) {
    return yield* new SandboxImageBuildError({
      detail:
        "this t3 is neither a release install nor run from a checkout, so there is no server of its version to put in the image.",
    });
  }
  onLine(`Staging the T3 server ${packageJson.version} from ${checkout}...`);
  yield* streamCommand(
    process.execPath,
    [NodePath.join(checkout, "scripts", "stage-sandbox-server.ts"), "--output-dir", contextDir],
    onLine,
    { cwd: checkout, env: stagingEnvironment(), timeoutMs: 20 * 60 * 1000 },
  );
  // The Containerfile, the lockfiles and the skills.
  yield* copyDefinition(NodePath.join(checkout, "apps", "server", "sandbox-image"));
});

/**
 * Builds the image and tags it `image` and `<repository>:<version>`, then removes this Hub's older
 * builds of that repository that no container runs. Output goes to `onLine` as it comes.
 */
export const buildSandboxImage = Effect.fn("SandboxImage.build")(function* (input: {
  readonly image: string;
  readonly onLine: (line: string) => void;
  readonly podmanCommand?: string;
  /** Builds the server from this checkout, whatever this process runs from (tests). */
  readonly checkout?: string;
}) {
  const podmanCommand = input.podmanCommand ?? "podman";
  if (!(yield* detectRootlessPodman(input.podmanCommand))) {
    return yield* new SandboxImageBuildError({ detail: "rootless Podman is not available here." });
  }
  const version = buildVersion(yield* DateTime.now);
  const repository = repositoryOf(input.image);
  const contextDir = yield* Effect.acquireRelease(
    Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sandbox-image-"))),
    (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
  );
  yield* prepareContext(contextDir, input.onLine, input.checkout);
  yield* Effect.try({
    try: () => makeContextReadable(contextDir),
    catch: (cause) => new SandboxImageBuildError({ detail: String(cause) }),
  });
  input.onLine(`Building ${input.image} (${version})...`);
  yield* streamCommand(
    podmanCommand,
    [
      ...podmanGlobalArgs(),
      "build",
      "--file",
      NodePath.join(contextDir, "Containerfile"),
      "--tag",
      input.image,
      "--tag",
      `${repository}:${version}`,
      // The Containerfile labels the image with it, in a layer of its own per build.
      "--build-arg",
      `T3_IMAGE_VERSION=${version}`,
      contextDir,
    ],
    input.onLine,
    { timeoutMs: BUILD_TIMEOUT_MS },
  );
  const built = yield* inspectSandboxImage(input.image, input.podmanCommand);
  if (built === null || built.version !== version) {
    return yield* new SandboxImageBuildError({ detail: `${input.image} is not the new build.` });
  }
  // Older builds go once no container runs them; one a running Sandbox uses stays until the next.
  const tags = yield* runPodman(
    [
      "images",
      "--filter",
      `reference=${repository}`,
      "--filter",
      `label=${SANDBOX_IMAGE_LABEL}=1`,
      "--format",
      "{{.Repository}}:{{.Tag}}",
    ],
    { podmanCommand },
  );
  for (const tag of tags.stdout.split("\n").map((line) => line.trim())) {
    if (tag === input.image || tag === `${repository}:${version}`) continue;
    // Only a build's own tag, `<repository>:<version>-<time>`: never one someone else set.
    if (!tag.startsWith(`${repository}:`) || !/-\d{14}$/u.test(tag)) continue;
    yield* runPodman(["image", "rm", tag], { podmanCommand }).pipe(Effect.ignore);
  }
  input.onLine(`Built ${input.image} (${version}).`);
  return built;
}, Effect.scoped);

/**
 * How the Hub builds and reads the image: Podman's by default, a fake in tests that build none.
 */
export class SandboxImageBuilder extends Context.Service<
  SandboxImageBuilder,
  {
    /** Why this Hub cannot build it (no rootless Podman), or none. */
    readonly cannotBuildReason: Effect.Effect<string | null>;
    readonly inspect: (image: string) => Effect.Effect<SandboxImageFound | null>;
    readonly build: (input: {
      readonly image: string;
      readonly onLine: (line: string) => void;
    }) => Effect.Effect<SandboxImageFound, SandboxImageBuildError>;
  }
>()("t3/sandboxes/SandboxImage/SandboxImageBuilder") {}

const podmanBuilder = SandboxImageBuilder.of({
  cannotBuildReason: detectRootlessPodman().pipe(
    Effect.map((rootless) => (rootless ? null : "Rootless Podman is not available on the Hub.")),
  ),
  inspect: inspectSandboxImage,
  build: buildSandboxImage,
});

/** A Hub that builds nothing, as one without Podman: the testkit's default. */
export const unavailableBuilder = SandboxImageBuilder.of({
  cannotBuildReason: Effect.succeed("Rootless Podman is not available on the Hub."),
  inspect: Effect.fn("SandboxImageBuilder.inspect")(function* (_image: string) {
    yield* Effect.void;
    return null;
  }),
  build: Effect.fn("SandboxImageBuilder.build")(function* () {
    return yield* new SandboxImageBuildError({ detail: "rootless Podman is not available here." });
  }),
});

export class SandboxImageBuildInProgressError extends Schema.TaggedError<SandboxImageBuildInProgressError>()(
  "SandboxImageBuildInProgressError",
  {},
) {
  override get message(): string {
    return "The Sandbox image is already being built.";
  }
}

/** Where the request to build came from, as the audit log records it. */
export type SandboxImageBuildVia = "settings" | "cli";

/**
 * The Hub's builds of the image: one at a time, in the Hub's own scope (a client that stops
 * following it does not stop it), with its output kept for whoever follows.
 */
export class SandboxImageBuilds extends Context.Service<
  SandboxImageBuilds,
  {
    readonly image: string;
    /**
     * Why this Hub cannot build it. Asked until rootless Podman answers, then never again: a slow
     * `podman info` or a Podman set up after the Hub started is not kept as an answer.
     */
    readonly cannotBuildReason: Effect.Effect<string | null>;
    /** The image the tag names now, read again at most every few seconds and after each build. */
    readonly current: Effect.Effect<SandboxImageInfo>;
    /** The last (or current) build, with the lines of its output after `after` (a line count). */
    readonly lastBuild: (after?: number) => Effect.Effect<SandboxImageBuild>;
    /** Starts a build and answers at once; refused while one runs. */
    readonly start: (input: {
      readonly actor: AuditLog.AuditActor;
      readonly via: SandboxImageBuildVia;
    }) => Effect.Effect<void, SandboxImageBuildInProgressError>;
  }
>()("t3/sandboxes/SandboxImage/SandboxImageBuilds") {}

/** How long a «cannot build» answer stands before `podman info` is asked again. */
const CANNOT_BUILD_TTL_MS = 5_000;

/**
 * Why it cannot be done, asked once per `ttlMs` (concurrent askers share one check) until the
 * answer is none, which then stands for good: a slow `podman info` or a Podman set up after the
 * Hub started is not kept, nor asked on every poll.
 */
export const cachedUntilAvailable = Effect.fn("SandboxImage.cachedUntilAvailable")(function* (
  check: Effect.Effect<string | null>,
  ttlMs: number,
) {
  yield* Effect.void;
  let available = false;
  let current: { readonly at: number; readonly read: Effect.Effect<string | null> } | undefined;
  return Effect.gen(function* () {
    if (available) return null;
    const now = yield* Clock.currentTimeMillis;
    if (current === undefined || now - current.at >= ttlMs) {
      current = { at: now, read: yield* Effect.cached(check) };
    }
    const reason = yield* current.read;
    if (reason === null) available = true;
    return reason;
  });
});

/** How long a read of the image stands for the next ones (clients poll every second or so). */
const CURRENT_TTL_MS = 5_000;

const make = Effect.gen(function* () {
  const audit = yield* AuditLog.AuditLog;
  const builder = Option.getOrElse(
    yield* Effect.serviceOption(SandboxImageBuilder),
    () => podmanBuilder,
  );
  const image = yield* configuredSandboxImage;
  const scope = yield* Effect.scope;
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  let state: Omit<SandboxImageBuild, "log" | "logLines"> = {
    state: "idle",
    startedAt: null,
    finishedAt: null,
    error: null,
  };
  // The kept tail of its output: `log[0]` is line number `logLines - log.length`.
  let log: Array<string> = [];
  let logChars = 0;
  let logLines = 0;
  const onLine = (line: string) => {
    logLines += 1;
    log.push(line);
    logChars += line.length;
    while (log.length > LOG_LINES_KEPT || logChars > LOG_MAX_CHARS) {
      logChars -= log.shift()?.length ?? 0;
    }
  };

  const cannotBuildReason = yield* cachedUntilAvailable(
    builder.cannotBuildReason,
    CANNOT_BUILD_TTL_MS,
  );

  let currentRead: { readonly at: number; readonly value: SandboxImageInfo } | undefined;
  const readCurrent = builder.inspect(image).pipe(
    Effect.map((found): SandboxImageInfo => ({
      image,
      version: found?.version ?? null,
      builtAt: found === null || found.createdAt === null ? null : toIso(found.createdAt),
    })),
  );
  const current: SandboxImageBuilds["Service"]["current"] = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (currentRead !== undefined && now - currentRead.at < CURRENT_TTL_MS) {
      return currentRead.value;
    }
    const value = yield* readCurrent;
    currentRead = { at: now, value };
    return value;
  });

  // Every build is recorded on the Hub machine, whoever asked; the image tag is its name.
  const target = { kind: "environment", id: HUB_MACHINE_ENVIRONMENT_ID, name: image } as const;
  const record = (
    input: { readonly actor: AuditLog.AuditActor; readonly via: SandboxImageBuildVia },
    outcome: { readonly built: SandboxImageFound } | { readonly error: string },
  ) =>
    audit
      .record({
        actor: input.actor,
        action: "sandbox.image.update",
        target,
        detail:
          "built" in outcome
            ? { via: input.via, outcome: "built", version: outcome.built.version }
            : { via: input.via, outcome: "failed", reason: outcome.error.slice(0, 200) },
      })
      .pipe(Effect.ignore({ log: true }));
  const finish = Effect.fn("SandboxImageBuilds.finish")(function* (
    input: { readonly actor: AuditLog.AuditActor; readonly via: SandboxImageBuildVia },
    outcome: { readonly built: SandboxImageFound } | { readonly error: string },
  ) {
    if ("error" in outcome) onLine(`The build failed: ${outcome.error}`);
    currentRead = undefined;
    state = {
      ...state,
      state: "built" in outcome ? "succeeded" : "failed",
      finishedAt: yield* nowIso,
      error: "error" in outcome ? outcome.error : null,
    };
    yield* record(input, outcome);
  });

  const start: SandboxImageBuilds["Service"]["start"] = Effect.fn("SandboxImageBuilds.start")(
    function* (input) {
      const startedAt = yield* nowIso;
      // Checked and claimed in one step, with nothing between: two requests never both build.
      const claimed = yield* Effect.sync(() => {
        if (state.state === "building") return false;
        log = [];
        logChars = 0;
        logLines = 0;
        state = { state: "building", startedAt, finishedAt: null, error: null };
        return true;
      });
      if (!claimed) return yield* new SandboxImageBuildInProgressError({});
      yield* builder.build({ image, onLine }).pipe(
        Effect.matchEffect({
          onSuccess: (built) => finish(input, { built }),
          onFailure: (error) => finish(input, { error: error.detail }),
        }),
        Effect.catchCause((cause) =>
          Effect.logWarning("The Sandbox image build stopped", { cause }).pipe(
            Effect.andThen(finish(input, { error: "the build stopped unexpectedly." })),
          ),
        ),
        // The Hub stopping mid-build still leaves it recorded, as failed.
        Effect.onInterrupt(() => finish(input, { error: "the Hub stopped during the build." })),
        Effect.forkIn(scope),
      );
    },
  );

  return SandboxImageBuilds.of({
    image,
    cannotBuildReason,
    current,
    lastBuild: Effect.fn("SandboxImageBuilds.lastBuild")(function* (after = 0) {
      return yield* Effect.sync(() => {
        const first = logLines - log.length;
        return { ...state, log: log.slice(Math.max(0, after - first)), logLines };
      });
    }),
    start,
  });
});

/** Podman prints `2026-11-07 14:35:09.69 +0000 UTC` or ISO; clients get ISO. */
const toIso = (created: string) =>
  Option.getOrNull(
    Option.map(
      DateTime.make(created.replace(/ \+0000 UTC$/u, "Z").replace(" ", "T")),
      DateTime.formatIso,
    ),
  );

export const layer = Layer.effect(SandboxImageBuilds, make).pipe(Layer.provide(AuditLog.layer));
