/**
 * The Hub's git repository of each Project, where every Environment uploads its checkpoint refs.
 * A Thread without a Project has one of its own, for its scratch workspace. Transfers name it by
 * URL or path, never by a remote of the checkout, so nothing reaches `origin`. See
 * docs/internals/overview.md, «Hub repository».
 */
import {
  type CheckpointRef,
  type ProjectId,
  type ThreadId,
  type VcsError,
  VcsProcessExitError,
  VcsUnsupportedOperationError,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import { makeScratchThreads, type ScratchThreads } from "../environment/ScratchWorkspace.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import type { VcsCheckpointOps } from "../vcs/VcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

export const HUB_REPOSITORY_ROUTE_PREFIX = "/api/git";
/** The user name the credential helper answers; the Hub reads only the password. */
const HUB_REPOSITORY_USERNAME = "t3-environment";
const CREDENTIAL_VARIABLE = "T3CODE_HUB_GIT_CREDENTIAL";
const TRANSFER_TIMEOUT_MS = 10 * 60_000;

/**
 * Where a Thread's own refs live in the Hub repository: its working branch and recovered changes.
 * The id is percent-encoded, as git refuses `:` in a ref name.
 */
export const threadRefPrefixes = (threadId: string) => {
  const key = encodeURIComponent(threadId);
  return [`refs/t3/threads/${key}/`, `refs/t3/recovered/${key}/`] as const;
};

/**
 * The Project's checkout as the Hub's own checkout of it has it, which new checkouts are made
 * from: its branches, `origin`'s tracking refs and its HEAD. Only the Hub writes here (a copy of
 * its checkout, `HubRepositories.mirrorCheckout`); every machine that may work in the Project reads
 * it; nothing of a Thread's is under it.
 */
export const PROJECT_REFS_PREFIX = "refs/t3/project/";
const PROJECT_BRANCHES_PREFIX = `${PROJECT_REFS_PREFIX}heads/`;
const PROJECT_REMOTES_PREFIX = `${PROJECT_REFS_PREFIX}remotes/origin/`;
/** The commit the Hub's checkout has checked out, as `<prefix>HEAD`. */
const PROJECT_HEAD_PREFIX = `${PROJECT_REFS_PREFIX}checkout/`;
/** Where a new checkout keeps that commit while it is made; removed once it is. */
const CHECKOUT_HEAD_PREFIX = "refs/t3/checkout/";
/**
 * The header a new checkout's fetch sends: the route brings the Hub checkout's refs in first.
 * Routine fetches (checkpoints) do not send it, and never wait on that copy.
 */
export const CHECKOUT_HEADER = "X-T3-Checkout";

/** A query parameter or URL user that is a credential, not a name. */
const SECRET_QUERY = /token|secret|password|passwd|auth|key|sig|credential/iu;
const TOKEN_USER = /^(gh[opsur]_|github_pat_|glpat-|xox[abp]-)|^[A-Za-z0-9_-]{32,}$/u;

/**
 * A remote URL as another machine's checkout names it: without the password the Hub's own checkout
 * may keep in it. The user stays unless it is itself a token; a query parameter stays unless its
 * name says it is a credential.
 */
export const remoteWithoutCredentials = (remoteUrl: string) => {
  try {
    const url = new URL(remoteUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "ssh:") {
      return remoteUrl;
    }
    let changed = false;
    if (url.password !== "") {
      url.password = "";
      changed = true;
    }
    if (url.username !== "" && isTokenUser(url.username)) {
      url.username = "";
      changed = true;
    }
    const secretNames = Array.from(url.searchParams.keys()).filter((name) =>
      SECRET_QUERY.test(name),
    );
    for (const name of secretNames) {
      url.searchParams.delete(name);
      changed = true;
    }
    return changed ? url.toString() : remoteUrl;
  } catch {
    // A path or an scp-like `user@host:path` has nothing secret in it; a URL that does not
    // parse keeps no user information at all.
    return URL_SCHEME.test(remoteUrl)
      ? remoteUrl.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/iu, "$1")
      : remoteUrl;
  }
};

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//iu;

/** A URL user that is a token; one that does not decode is treated as one. */
const isTokenUser = (user: string) => {
  try {
    return TOKEN_USER.test(decodeURIComponent(user));
  } catch {
    return true;
  }
};

/** Where a move of a Thread without a Project carries its folder's own branches and HEAD. */
export const scratchHistoryPrefix = (threadId: string, moveId: string) =>
  `${threadRefPrefixes(threadId)[0]}scratch/${encodeURIComponent(moveId)}/`;

/**
 * Which Hub repository: the Project's, or, for a Thread without a Project (one in the scratch
 * Project), that Thread's own, since its scratch workspace shares nothing with another's.
 */
export interface HubRepositoryKey {
  readonly projectId: ProjectId;
  readonly scratchThreadId?: ThreadId | undefined;
}

/** The segment of `/api/git/thread/<threadId>`, a Thread's own repository. */
export const THREAD_REPOSITORY_SEGMENT = "thread";

/** The key's path under `/api/git`: `<projectId>`, or `thread/<threadId>`. */
const repositoryPathOf = (key: HubRepositoryKey) =>
  key.scratchThreadId === undefined
    ? encodeURIComponent(key.projectId)
    : `${THREAD_REPOSITORY_SEGMENT}/${encodeURIComponent(key.scratchThreadId)}`;

export const hubRepositoryUrl = (hubUrl: string, key: HubRepositoryKey) =>
  new URL(`${HUB_REPOSITORY_ROUTE_PREFIX}/${repositoryPathOf(key)}`, hubUrl).toString();

/** A repository to push to or fetch from, and what a git process needs in its environment. */
export interface HubRemote {
  readonly url: string;
  readonly env?: Readonly<Record<string, string>>;
  /** The Environment credential, for requests `t3` makes itself (a large upload in parts). */
  readonly credential?: string;
}

const PROTOCOL_VARIABLE = "T3CODE_HUB_GIT_PROTOCOL";
const HOST_VARIABLE = "T3CODE_HUB_GIT_HOST";

// Answers `get` only for the Hub's own protocol and host:port, all read from the environment.
const CREDENTIAL_HELPER = [
  "!f() {",
  'test "$1" = get || exit 0; p=; h=;',
  "while IFS='=' read -r k v; do",
  'case "$k" in protocol) p=$v ;; host) h=$v ;; "") break ;; esac;',
  "done;",
  `test "$p" = "$${PROTOCOL_VARIABLE}" && test "$h" = "$${HOST_VARIABLE}" &&`,
  `printf 'username=${HUB_REPOSITORY_USERNAME}\\npassword=%s\\n' "$${CREDENTIAL_VARIABLE}";`,
  "}; f",
].join(" ");

/**
 * The Hub repository over HTTP, with `t3`'s credential helper: the credential stays in the process
 * environment, never on a command line. The empty helper first drops the user's own, so none is
 * asked or stores it; redirects are not followed, so it is never sent to another host.
 */
export const withEnvironmentCredential = (url: string, credential: string): HubRemote => {
  const target = new URL(url);
  return {
    url,
    credential,
    env: {
      // Git's own words, whatever the machine's locale: `classifyPushFailure` reads them.
      LC_ALL: "C",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "credential.helper",
      GIT_CONFIG_VALUE_1: CREDENTIAL_HELPER,
      GIT_CONFIG_KEY_2: "http.followRedirects",
      GIT_CONFIG_VALUE_2: "false",
      [PROTOCOL_VARIABLE]: target.protocol.slice(0, -1),
      [HOST_VARIABLE]: target.host,
      [CREDENTIAL_VARIABLE]: credential,
    },
  };
};

/**
 * A git query's trimmed output, or null when git answers "none" (exit 1 by default, or one of
 * `absent`); any other failure is git's error, never an empty answer.
 */
export const gitRead = (
  vcs: VcsProcess.VcsProcess["Service"],
  input: {
    readonly operation: string;
    readonly cwd: string;
    readonly args: ReadonlyArray<string>;
    readonly absent?: ReadonlyArray<number>;
    readonly stdin?: string;
  },
) =>
  vcs
    .run({
      operation: input.operation,
      command: "git",
      cwd: input.cwd,
      args: [...input.args],
      ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
      allowNonZeroExit: true,
    })
    .pipe(
      Effect.flatMap((output) => {
        if (output.exitCode === 0) {
          const text = output.stdout.trim();
          return Effect.succeed(text.length === 0 ? null : text);
        }
        if ((input.absent ?? [1]).includes(output.exitCode)) return Effect.succeed(null);
        return Effect.fail(
          new VcsProcessExitError({
            operation: input.operation,
            command: "git",
            cwd: input.cwd,
            exitCode: output.exitCode,
            detail: output.stderr.trim().slice(0, 2_000) || "git failed.",
          }),
        );
      }),
    );

/** Git with git's own message on failure; it names the URL, never the credential. */
export const gitIn = (
  vcs: VcsProcess.VcsProcess["Service"],
  input: {
    readonly operation: string;
    readonly cwd: string;
    readonly args: ReadonlyArray<string>;
    readonly remote?: HubRemote;
    readonly stdin?: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly maxOutputBytes?: number;
  },
) =>
  vcs
    .run({
      operation: input.operation,
      command: "git",
      cwd: input.cwd,
      args: ["-c", "gc.auto=0", ...input.args],
      ...(input.remote?.env === undefined && input.env === undefined
        ? {}
        : { env: { ...input.remote?.env, ...input.env } }),
      ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
      ...(input.maxOutputBytes === undefined ? {} : { maxOutputBytes: input.maxOutputBytes }),
      timeoutMs: TRANSFER_TIMEOUT_MS,
      allowNonZeroExit: true,
    })
    .pipe(
      Effect.filterOrFail(
        (output) => output.exitCode === 0,
        (output) =>
          new VcsProcessExitError({
            operation: input.operation,
            command: "git",
            cwd: input.cwd,
            exitCode: output.exitCode,
            detail: output.stderr.trim().slice(0, 2_000) || "git failed.",
          }),
      ),
    );

/** The refs among `refs` that the repository at `cwd` (or `gitDir`, a bare one) has. */
const existingRefs = Effect.fn("HubRepository.existingRefs")(function* (
  vcs: VcsProcess.VcsProcess["Service"],
  cwd: string,
  refs: ReadonlyArray<CheckpointRef>,
  gitDir?: string,
) {
  if (refs.length === 0) return new Set<string>();
  const listed = yield* gitIn(vcs, {
    operation: "HubRepository.existingRefs",
    cwd,
    args: [
      ...(gitDir === undefined ? [] : ["--git-dir", gitDir]),
      "for-each-ref",
      "--format=%(refname)",
      ...refs,
    ],
  });
  return new Set(listed.stdout.split("\n").filter((line) => line.length > 0));
});

/** Recovered and set-aside refs are created once and never forced over. */
export const isCreateOnlyRef = (ref: string) => ref.startsWith("refs/t3/recovered/");

/** One `git push` over smart HTTP (or to the repository on disk), every ref in one request. */
const smartPush = (
  vcs: VcsProcess.VcsProcess["Service"],
  input: { readonly cwd: string; readonly remote: HubRemote; readonly refs: ReadonlyArray<string> },
) =>
  gitIn(vcs, {
    operation: "HubRepository.push",
    cwd: input.cwd,
    remote: input.remote,
    args: [
      "-c",
      "push.followTags=false",
      "push",
      "--no-verify",
      "--recurse-submodules=no",
      "--quiet",
      input.remote.url,
      ...input.refs.map((ref) => (isCreateOnlyRef(ref) ? `${ref}:${ref}` : `+${ref}:${ref}`)),
    ],
  });

/**
 * Above this many bytes of new objects an upload goes in parts (`HubPackUpload`) instead of one
 * `git push`: a proxy in front of the Hub (Cloudflare's: 100 MB) refuses a larger request body.
 */
export const SMART_PUSH_MAX_BYTES = 64 * 1024 * 1024;

/** Uploads large pushes in parts; only a machine that reaches the Hub over HTTP has one. */
export interface PackUploader {
  /** Above this many bytes (estimated) an upload goes in parts: `SMART_PUSH_MAX_BYTES`. */
  readonly smartPushMaxBytes: number;
  readonly upload: (input: {
    readonly cwd: string;
    readonly remote: HubRemote;
    readonly refs: ReadonlyArray<string>;
    /** Commits the Hub advertised to this machine that it also has: what the upload leaves out. */
    readonly remoteTips: ReadonlyArray<string>;
  }) => Effect.Effect<void, VcsError, VcsProcess.VcsProcess>;
}

/**
 * The commits the Hub repository advertises to this machine that the checkout also has: what an
 * upload need not carry.
 */
const remoteTipsPresent = Effect.fn("HubRepository.remoteTipsPresent")(function* (
  vcs: VcsProcess.VcsProcess["Service"],
  cwd: string,
  remote: HubRemote,
) {
  const listed = yield* gitIn(vcs, {
    operation: "HubRepository.lsRemote",
    cwd,
    remote,
    args: ["ls-remote", remote.url],
  });
  const advertised = [
    ...new Set(
      listed.stdout
        .split("\n")
        .map((line) => line.split("\t")[0]?.trim() ?? "")
        .filter((oid) => OBJECT_ID.test(oid)),
    ),
  ];
  if (advertised.length === 0) return [];
  const checked = yield* gitIn(vcs, {
    operation: "HubRepository.lsRemote",
    cwd,
    args: ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
    stdin: `${advertised.join("\n")}\n`,
  });
  return checked.stdout
    .split("\n")
    .map((line) => line.trim().split(" "))
    .filter(([oid, type]) => oid !== undefined && OBJECT_ID.test(oid) && type !== "missing")
    .map(([oid]) => oid!);
});

const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

/** `git rev-list` arguments on stdin: the tips, then what to leave out. */
const revisionsInput = (tips: ReadonlyArray<string>, exclude: ReadonlyArray<string>) =>
  `${[...tips, ...(exclude.length === 0 ? [] : ["--not", ...exclude])].join("\n")}\n`;

/**
 * About how many bytes an upload of `refs` carries: the size on disk of the objects the Hub lacks.
 * Null when this git cannot say (before 2.31).
 */
const estimateUploadBytes = Effect.fn("HubRepository.estimateUploadBytes")(function* (
  vcs: VcsProcess.VcsProcess["Service"],
  cwd: string,
  refs: ReadonlyArray<string>,
  remoteTips: ReadonlyArray<string>,
) {
  const counted = yield* gitRead(vcs, {
    operation: "HubRepository.estimateUpload",
    cwd,
    args: ["rev-list", "--objects", "--disk-usage", "--stdin"],
    stdin: revisionsInput(refs, remoteTips),
    absent: [],
  }).pipe(Effect.orElseSucceed(() => null));
  const bytes = counted === null ? Number.NaN : Number.parseInt(counted, 10);
  return Number.isFinite(bytes) ? bytes : null;
});

/**
 * Uploads the refs, replacing what the repository had under the same names (recovered ones
 * excepted). Over HTTP with an uploader, one too large for a single request (estimated, or refused
 * as such) goes in parts.
 */
export const pushRefs = Effect.fn("HubRepository.pushRefs")(function* (input: {
  readonly cwd: string;
  readonly remote: HubRemote;
  readonly refs: ReadonlyArray<CheckpointRef>;
  readonly uploader?: PackUploader | undefined;
}) {
  if (input.refs.length === 0) return;
  const vcs = yield* VcsProcess.VcsProcess;
  const uploader = input.uploader;
  if (uploader === undefined || input.remote.credential === undefined) {
    return yield* smartPush(vcs, input);
  }
  const remoteTips = yield* remoteTipsPresent(vcs, input.cwd, input.remote);
  const estimated = yield* estimateUploadBytes(vcs, input.cwd, input.refs, remoteTips);
  yield* Effect.annotateCurrentSpan({ "hubRepository.estimatedBytes": estimated ?? -1 });
  const inParts = uploader.upload({
    cwd: input.cwd,
    remote: input.remote,
    refs: input.refs,
    remoteTips,
  });
  if (estimated !== null && estimated > uploader.smartPushMaxBytes) {
    yield* Effect.annotateCurrentSpan({ "hubRepository.transport": "parts" });
    return yield* inParts;
  }
  const pushed = yield* Effect.result(smartPush(vcs, input));
  if (pushed._tag === "Success") return;
  if (classifyPushFailure(pushed.failure) !== "tooLarge") return yield* pushed.failure;
  yield* Effect.annotateCurrentSpan({ "hubRepository.transport": "parts" });
  return yield* inParts;
});

/**
 * Why an upload failed, for how soon it is tried again: the machine was not there (`unavailable`),
 * the checkout lacks a ref (`missingRef`), too large for the Hub or a proxy (`tooLarge`), the Hub
 * said no (`refused`), or anything else: network, 5xx, a timeout (`transient`).
 */
export type HubPushFailure = "unavailable" | "missingRef" | "tooLarge" | "refused" | "transient";

const MISSING_REF_FAILURE =
  /src refspec\b.*\bdoes not match any|does not point to a valid object|unknown revision|bad revision|not a valid object name|invalid refspec/iu;
const TOO_LARGE_FAILURE =
  /\b413\b|payload too large|request entity too large|larger than the hub accepts/iu;
const REFUSED_FAILURE =
  /returned error: 40[134]\b|\b40[134] (unauthorized|forbidden|not found)|authentication failed|is not a ref of a thread|is not allowed|already exists: recovered|was not asked for|must be updated to accept/iu;

export const classifyPushFailure = (error: {
  readonly _tag: string;
  readonly detail?: string | undefined;
}): HubPushFailure => {
  if (error._tag === "EnvironmentExecutorUnavailableError") return "unavailable";
  const detail = error.detail ?? "";
  if (TOO_LARGE_FAILURE.test(detail)) return "tooLarge";
  if (MISSING_REF_FAILURE.test(detail)) return "missingRef";
  if (REFUSED_FAILURE.test(detail)) return "refused";
  return "transient";
};

/** Downloads the refs the repository at `cwd` lacks; the ones it has are left as they are. */
export const fetchMissingRefs = Effect.fn("HubRepository.fetchMissingRefs")(function* (input: {
  readonly cwd: string;
  readonly remote: HubRemote;
  readonly refs: ReadonlyArray<CheckpointRef>;
}) {
  const vcs = yield* VcsProcess.VcsProcess;
  const present = yield* existingRefs(vcs, input.cwd, input.refs);
  const missing = input.refs.filter((ref) => !present.has(ref));
  if (missing.length === 0) return;
  yield* gitIn(vcs, {
    operation: "HubRepository.fetch",
    cwd: input.cwd,
    remote: input.remote,
    args: [
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      "--recurse-submodules=no",
      "--quiet",
      input.remote.url,
      ...missing.map((ref) => `+${ref}:${ref}`),
    ],
  });
});

/** Downloads every ref under `prefix` (one that ends in `/`), replacing the local ones. */
const fetchRefPrefix = Effect.fn("HubRepository.fetchRefPrefix")(function* (input: {
  readonly cwd: string;
  readonly remote: HubRemote;
  readonly prefix: string;
}) {
  const vcs = yield* VcsProcess.VcsProcess;
  yield* gitIn(vcs, {
    operation: "HubRepository.fetchPrefix",
    cwd: input.cwd,
    remote: input.remote,
    args: [
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      "--recurse-submodules=no",
      "--quiet",
      input.remote.url,
      `+${input.prefix}*:${input.prefix}*`,
    ],
  });
});

/** A rename that another process (an indexer, an antivirus) briefly holds may succeed in a moment. */
const isTransientFileError = (error: PlatformError.PlatformError) =>
  error.reason._tag === "Busy" || error.reason._tag === "PermissionDenied";

/** A branch of the Hub's checkout whose upstream is `origin`'s `merge` (`branch.<b>.merge`). */
export interface HubUpstream {
  readonly branch: string;
  readonly merge: string;
}

/**
 * Makes `target` as the Hub's checkout is (`PROJECT_REFS_PREFIX`): branches, `origin`'s tracking
 * refs and the upstreams the Hub's branches have, `branch` checked out (else HEAD's commit,
 * detached; else main or master). Built in a sibling folder and renamed into place.
 */
export const cloneFromHub = Effect.fn("HubRepository.cloneFromHub")(function* (
  deps: {
    readonly vcs: VcsProcess.VcsProcess["Service"];
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Pick<Path.Path, "basename" | "dirname">;
  },
  input: {
    readonly target: string;
    readonly remote: HubRemote;
    readonly originUrl: string | null;
    readonly branch: string | undefined;
    readonly upstreams: ReadonlyArray<HubUpstream>;
  },
) {
  const { fileSystem, vcs } = deps;
  const operation = "HubRepository.cloneFromHub";
  const parent = deps.path.dirname(input.target);
  yield* fileSystem.makeDirectory(parent, { recursive: true });
  const staging = yield* fileSystem.makeTempDirectory({
    directory: parent,
    prefix: `.${deps.path.basename(input.target)}.clone-`,
  });
  const run = (args: ReadonlyArray<string>, remote?: HubRemote) =>
    gitIn(vcs, { operation, cwd: staging, args, ...(remote === undefined ? {} : { remote }) });
  const read = (args: ReadonlyArray<string>) => gitRead(vcs, { operation, cwd: staging, args });
  return yield* Effect.gen(function* () {
    yield* run(["init", "--quiet"]);
    yield* run(
      [
        "-c",
        `http.extraHeader=${CHECKOUT_HEADER}: 1`,
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        "--update-head-ok",
        "--recurse-submodules=no",
        "--quiet",
        input.remote.url,
        `+${PROJECT_BRANCHES_PREFIX}*:refs/heads/*`,
        `+${PROJECT_HEAD_PREFIX}*:${CHECKOUT_HEAD_PREFIX}*`,
        ...(input.originUrl === null ? [] : [`+${PROJECT_REMOTES_PREFIX}*:refs/remotes/origin/*`]),
      ],
      input.remote,
    );
    const branches = (
      (yield* read(["for-each-ref", "--format=%(refname:strip=2)", "refs/heads/"])) ?? ""
    )
      .split("\n")
      .filter((line) => line.length > 0);
    const head = yield* read(["rev-parse", "--verify", "--quiet", `${CHECKOUT_HEAD_PREFIX}HEAD`]);
    const branch =
      input.branch !== undefined && branches.includes(input.branch)
        ? input.branch
        : head !== null
          ? undefined
          : ["main", "master"].find((name) => branches.includes(name));
    if (branch === undefined && head === null) {
      return yield* new VcsProcessExitError({
        operation,
        command: "git",
        cwd: input.target,
        exitCode: 1,
        detail: NOTHING_TO_CHECK_OUT,
      });
    }
    if (branch === undefined) {
      yield* run(["update-ref", "--no-deref", "HEAD", head!]);
    } else {
      yield* run(["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
    }
    yield* run(["update-ref", "-d", `${CHECKOUT_HEAD_PREFIX}HEAD`]);
    if (input.originUrl !== null) {
      yield* run(["remote", "add", "--", "origin", input.originUrl]);
      // Each branch tracks what it tracks in the Hub's checkout, and nothing else.
      for (const upstream of input.upstreams) {
        if (!branches.includes(upstream.branch)) continue;
        yield* run(["config", `branch.${upstream.branch}.remote`, "origin"]);
        yield* run(["config", `branch.${upstream.branch}.merge`, upstream.merge]);
      }
    }
    yield* run(["reset", "--hard", "--quiet"]);
    yield* renameIntoPlace(fileSystem, staging, input.target);
  }).pipe(
    // On every path, made or not: once renamed, nothing is left under the staging name.
    Effect.ensuring(fileSystem.remove(staging, { recursive: true }).pipe(Effect.ignore)),
  );
});

/** Why a clone from the Hub failed for good: it has nothing of the Project to check out. */
const NOTHING_TO_CHECK_OUT = "The Hub's repository has nothing of the Project to check out.";

/**
 * Renames `staging` to `target`. Another session that made `target` meanwhile made the checkout:
 * that one stays. A rename another process briefly holds is tried again, a few times.
 */
const renameIntoPlace = Effect.fn("HubRepository.renameIntoPlace")(function* (
  fileSystem: FileSystem.FileSystem,
  staging: string,
  target: string,
) {
  for (let attempt = 0; ; attempt += 1) {
    const renamed = yield* Effect.result(fileSystem.rename(staging, target));
    if (renamed._tag === "Success") return;
    if (yield* fileSystem.exists(target).pipe(Effect.orElseSucceed(() => false))) return;
    if (attempt >= 5 || !isTransientFileError(renamed.failure)) {
      return yield* renamed.failure;
    }
    yield* Effect.sleep(100 * 2 ** attempt);
  }
});

/**
 * Whether a clone from the Hub may succeed if tried again: the network, the Hub answering 5xx, or
 * a timeout. A refusal (401, 403, 404), a Hub with nothing to check out or a local failure is not.
 */
export const isTransientHubFailure = (error: { readonly _tag: string; readonly detail?: string }) =>
  error._tag === "VcsProcessTimeoutError" ||
  (error._tag === "VcsProcessExitError" &&
    error.detail !== NOTHING_TO_CHECK_OUT &&
    TRANSIENT_GIT_FAILURE.test(error.detail ?? ""));

const TRANSIENT_GIT_FAILURE =
  /returned error: 5\d\d|could not resolve host|failed to connect|connection (refused|reset|timed out)|timed out|rpc failed|early eof|unexpected disconnect|empty reply|remote end hung up|operation too slow|(send|recv) failure|not closed cleanly/iu;

export interface CheckoutTransferInput extends HubRepositoryKey {
  /** A folder of the checkout (or scratch workspace) on this machine. */
  readonly cwd: string;
  readonly checkpointRefs: ReadonlyArray<CheckpointRef>;
}

/** The repository part of a transfer, without undefined keys (they cross the wire). */
export const keyOf = (input: HubRepositoryKey): HubRepositoryKey =>
  input.scratchThreadId === undefined
    ? { projectId: input.projectId }
    : { projectId: input.projectId, scratchThreadId: input.scratchThreadId };

/** A checkout's side of the Hub repository of a Project or of a Thread without one. */
export interface CheckoutTransfers {
  /** Uploads the refs from the checkout, replacing the Hub's refs of the same names. */
  readonly push: (input: CheckoutTransferInput) => Effect.Effect<void, VcsError>;
  /** Downloads into the checkout the refs it lacks. */
  readonly fetch: (input: CheckoutTransferInput) => Effect.Effect<void, VcsError>;
  /** Downloads every ref under `prefix`, as a moved scratch workspace's history. */
  readonly fetchPrefix: (
    input: HubRepositoryKey & { readonly cwd: string; readonly prefix: string },
  ) => Effect.Effect<void, VcsError>;
}

/**
 * Transfers from this machine's checkouts to the Hub repository `remoteOf` names: on disk for the
 * Hub machine, over HTTP with the credential for a joined one. Without one, each says why. One
 * transfer at a time per checkout: a request the Hub sends again (after a reconnect) waits for
 * the one still running instead of packing the same objects beside it.
 */
export const makeCheckoutTransfers = (input: {
  readonly vcs: VcsProcess.VcsProcess["Service"] | undefined;
  readonly remoteOf: ((key: HubRepositoryKey) => Effect.Effect<HubRemote, VcsError>) | undefined;
  readonly unavailable: string;
  /** Large uploads in parts, over HTTP; without one every upload is a single `git push`. */
  readonly uploader?: PackUploader | undefined;
}): CheckoutTransfers => {
  const locks = new Map<string, { readonly lock: Semaphore.Semaphore; users: number }>();
  const oneAtATime =
    (cwd: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      Effect.suspend(() => {
        const entry = locks.get(cwd) ?? { lock: Semaphore.makeUnsafe(1), users: 0 };
        locks.set(cwd, entry);
        entry.users += 1;
        return entry.lock
          .withPermits(1)(effect)
          .pipe(
            Effect.ensuring(
              Effect.sync(() => {
                entry.users -= 1;
                if (entry.users === 0 && locks.get(cwd) === entry) locks.delete(cwd);
              }),
            ),
          );
      });
  const transfer =
    (
      operation: string,
      run: (args: {
        readonly cwd: string;
        readonly remote: HubRemote;
        readonly refs: ReadonlyArray<CheckpointRef>;
      }) => Effect.Effect<void, VcsError, VcsProcess.VcsProcess>,
    ) =>
    (request: CheckoutTransferInput) => {
      const { vcs, remoteOf } = input;
      if (vcs === undefined || remoteOf === undefined) {
        return Effect.fail(
          new VcsUnsupportedOperationError({ operation, kind: "git", detail: input.unavailable }),
        );
      }
      return remoteOf(keyOf(request)).pipe(
        Effect.flatMap((remote) => run({ cwd: request.cwd, remote, refs: request.checkpointRefs })),
        oneAtATime(request.cwd),
        Effect.provideService(VcsProcess.VcsProcess, vcs),
      );
    };
  return {
    push: transfer("HubRepository.push", (args) => pushRefs({ ...args, uploader: input.uploader })),
    fetch: transfer("HubRepository.fetch", fetchMissingRefs),
    fetchPrefix: (request) => {
      const { vcs, remoteOf } = input;
      if (vcs === undefined || remoteOf === undefined) {
        return Effect.fail(
          new VcsUnsupportedOperationError({
            operation: "HubRepository.fetchPrefix",
            kind: "git",
            detail: input.unavailable,
          }),
        );
      }
      return remoteOf(keyOf(request)).pipe(
        Effect.flatMap((remote) =>
          fetchRefPrefix({ cwd: request.cwd, remote, prefix: request.prefix }),
        ),
        oneAtATime(request.cwd),
        Effect.provideService(VcsProcess.VcsProcess, vcs),
      );
    },
  };
};

/** A name for a repository folder: readable, and distinct for ids that read alike. */
const folderNameOf = (id: string) => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index += 1) {
    hash = Math.imul(hash ^ id.charCodeAt(index), 0x01000193) >>> 0;
  }
  const readable = id.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 64);
  return `${readable}-${hash.toString(16).padStart(8, "0")}.git`;
};

/** A Project's folder at the root; a Thread's own under `threads/`, where no Project's can be. */
const directoryNameOf = (key: HubRepositoryKey) =>
  key.scratchThreadId === undefined
    ? folderNameOf(key.projectId)
    : `threads/${folderNameOf(key.scratchThreadId)}`;

export class HubRepositories extends Context.Service<
  HubRepositories,
  {
    /** The folder holding every repository, as git http-backend's project root. */
    readonly root: string;
    /** The repository's folder, relative to `root`. */
    readonly directoryOf: (key: HubRepositoryKey) => string;
    /** Creates the bare repository when there is none; its absolute path. */
    readonly ensure: (key: HubRepositoryKey) => Effect.Effect<string, VcsError>;
    /**
     * Makes the Project's `PROJECT_REFS_PREFIX` a copy of the Hub's checkout at `checkout` (a
     * root today's rule trusts; the caller checks): its branches, `origin`'s tracking refs and
     * HEAD's commit, forced and pruned, as the Hub's checkout is authoritative. One at a time per
     * Project; clones asking together share one. Best effort: never fails its caller.
     */
    readonly mirrorCheckout: (projectId: ProjectId, checkout: string) => Effect.Effect<void>;
    /** Whether the repository has every one of the refs. */
    readonly hasRefs: (
      key: HubRepositoryKey,
      refs: ReadonlyArray<CheckpointRef>,
    ) => Effect.Effect<boolean>;
    /**
     * Where a Thread's checkpoints go (its own repository without a Project, else its Project's)
     * and its scratch folder: `ScratchWorkspace.makeScratchThreads`, the one place that decides.
     */
    readonly threads: ScratchThreads;
    /** Checkpoint reads (diffs, authored paths) run in a repository folder from `ensure`. */
    readonly checkpoints: VcsCheckpointOps;
  }
>()("t3/checkpointing/HubRepository/HubRepositories") {}

export const layer = Layer.effect(
  HubRepositories,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const vcs = yield* VcsProcess.VcsProcess;
    const sql = yield* SqlClient.SqlClient;
    // Git refuses to find a bare repository from its cwd where `safe.bareRepository` is
    // `explicit`, so every command in one names it.
    const inBareRepository = VcsProcess.VcsProcess.of({
      run: Effect.fn("HubRepositories.inBareRepository")((input) =>
        vcs.run({ ...input, env: { ...input.env, GIT_DIR: input.cwd } }),
      ),
    });
    const driver = yield* GitVcsDriver.makeVcsDriver.pipe(
      Effect.provideService(VcsProcess.VcsProcess, inBareRepository),
    );
    const root = path.join(config.stateDir, "hub-repositories");
    const pathOf = (key: HubRepositoryKey) => path.join(root, directoryNameOf(key));
    const initialized = (repository: string) =>
      fileSystem.exists(path.join(repository, "HEAD")).pipe(Effect.orElseSucceed(() => false));

    const threads = makeScratchThreads({ sql, path, baseDir: config.baseDir });

    const ensure = Effect.fn("HubRepositories.ensure")(function* (key: HubRepositoryKey) {
      // Threads without a Project each have their own; the scratch Project never has one.
      if (key.scratchThreadId === undefined) {
        const scratch = yield* threads.isScratchProject(key.projectId).pipe(
          Effect.mapError(
            (cause) =>
              new VcsUnsupportedOperationError({
                operation: "HubRepositories.ensure",
                kind: "git",
                detail: cause.message,
              }),
          ),
        );
        if (scratch) {
          return yield* new VcsUnsupportedOperationError({
            operation: "HubRepositories.ensure",
            kind: "git",
            detail: "Threads without a Project have no shared repository on the Hub.",
          });
        }
      }
      const repository = pathOf(key);
      if (yield* initialized(repository)) return repository;
      yield* fileSystem
        .makeDirectory(path.dirname(repository), { recursive: true })
        .pipe(Effect.ignore);
      // Initializing twice is harmless, so concurrent first uploads need no lock.
      yield* gitIn(vcs, {
        operation: "HubRepositories.init",
        cwd: root,
        args: ["init", "--bare", "--quiet", repository],
      });
      return repository;
    });

    // For each Project a copy is wanted for: the lock that runs one copy at a time, when the
    // latest successful copy started, and how many clones wait on it (none: the entry goes).
    const mirrors = new Map<
      ProjectId,
      { readonly lock: Semaphore.Semaphore; at: number; waiting: number }
    >();
    const copyCheckout = Effect.fn("HubRepositories.copyCheckout")(function* (
      projectId: ProjectId,
      checkout: string,
    ) {
      if (!(yield* fileSystem.exists(checkout).pipe(Effect.orElseSucceed(() => false)))) return;
      const repository = yield* ensure({ projectId });
      const head =
        (yield* gitRead(vcs, {
          operation: "HubRepositories.mirrorCheckout",
          cwd: checkout,
          args: ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
        })) !== null;
      const inRepository = (args: ReadonlyArray<string>) =>
        gitIn(vcs, {
          operation: "HubRepositories.mirrorCheckout",
          cwd: root,
          args: ["--git-dir", repository, ...args],
        });
      yield* inRepository([
        "fetch",
        "--prune",
        "--no-tags",
        "--no-write-fetch-head",
        "--recurse-submodules=no",
        "--quiet",
        checkout,
        `+refs/heads/*:${PROJECT_BRANCHES_PREFIX}*`,
        `+refs/remotes/origin/*:${PROJECT_REMOTES_PREFIX}*`,
        "^refs/remotes/origin/HEAD",
        ...(head ? [`+HEAD:${PROJECT_HEAD_PREFIX}HEAD`] : []),
      ]);
      if (!head) yield* inRepository(["update-ref", "-d", `${PROJECT_HEAD_PREFIX}HEAD`]);
    });
    const mirrorCheckout = Effect.fn("HubRepositories.mirrorCheckout")(
      function* (projectId: ProjectId, checkout: string) {
        const mirror = mirrors.get(projectId) ?? {
          lock: Semaphore.makeUnsafe(1),
          at: Number.NEGATIVE_INFINITY,
          waiting: 0,
        };
        mirrors.set(projectId, mirror);
        mirror.waiting += 1;
        const askedAt = yield* Clock.currentTimeMillis;
        // Clones that ask together share one copy: one that started after a clone asked, and
        // succeeded, is as fresh as a copy of its own would be. A failed one counts for nobody.
        yield* Effect.gen(function* () {
          if (mirror.at >= askedAt) return;
          const startedAt = yield* Clock.currentTimeMillis;
          yield* copyCheckout(projectId, checkout);
          mirror.at = startedAt;
        }).pipe(
          mirror.lock.withPermits(1),
          Effect.ensuring(
            Effect.sync(() => {
              mirror.waiting -= 1;
              if (mirror.waiting === 0 && mirrors.get(projectId) === mirror) {
                mirrors.delete(projectId);
              }
            }),
          ),
        );
      },
      Effect.catch((cause) =>
        Effect.logWarning("The Hub could not copy its checkout of the Project", { cause }),
      ),
    );

    return HubRepositories.of({
      root,
      directoryOf: directoryNameOf,
      ensure,
      mirrorCheckout,
      hasRefs: Effect.fn("HubRepositories.hasRefs")(function* (key, refs) {
        const repository = pathOf(key);
        if (!(yield* initialized(repository))) return false;
        const present = yield* existingRefs(vcs, root, refs, repository).pipe(
          Effect.orElseSucceed(() => new Set<string>()),
        );
        return refs.every((ref) => present.has(ref));
      }),
      threads,
      checkpoints: driver.checkpoints,
    });
  }),
);
