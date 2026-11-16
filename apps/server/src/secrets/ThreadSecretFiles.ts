// @effect-diagnostics nodeBuiltinImport:off - statfs, O_NOFOLLOW/O_EXCL writes and renames: synchronous on purpose.
/**
 * Secret files (executor contract 14): a folder per Thread root and User under one owner-only root
 * in memory (tmpfs or ramfs, by statfs), never on a disk. It goes with the last process holding it,
 * and the whole root at every start. docs/internals/secrets.md, «Secret files».
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  type SecretEnv,
  type SecretEnvFile,
  SECRET_FILE_MAX_BYTES,
  SECRET_FILES_MAX_TOTAL_BYTES,
  SecretFilesError,
  type SecretFilesRefreshInput,
  type SecretFilesRoot,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import { ownFolder } from "./SecretFilesDirectory.ts";

/** statfs magic numbers of the filesystems that live in memory. */
const TMPFS_MAGIC = 0x01021994;
const RAMFS_MAGIC = 0x858458f6;
const FOLDER = /^[0-9a-f]{32}$/;
const NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;

/** A machine with no folder in memory: it takes no Secret file. */
const NO_ROOT: SecretFilesRoot = { path: "", inMemory: false };

const inMemory = (path: string) => {
  try {
    const { type } = NodeFS.statfsSync(path);
    return type === TMPFS_MAGIC || type === RAMFS_MAGIC;
  } catch {
    return false;
  }
};

const isFolder = (path: string) => {
  try {
    return NodeFS.statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/**
 * This server's root for Secret files: `$XDG_RUNTIME_DIR`, else `/dev/shm` (`T3CODE_SHM_DIR` in
 * tests), when it is in memory; one per state directory, never a symlink or another user's.
 */
export const resolveSecretFilesRoot = Effect.fn("ThreadSecretFiles.resolveRoot")(function* (
  stateDir: string,
) {
  const environment = yield* HostProcess.Environment;
  const uid = yield* HostProcess.UserId;
  if (uid === undefined) return NO_ROOT;
  const hash = NodeCrypto.createHash("sha256").update(stateDir).digest("hex").slice(0, 16);
  for (const base of [environment.XDG_RUNTIME_DIR, environment.T3CODE_SHM_DIR ?? "/dev/shm"]) {
    if (base === undefined || base.length === 0 || !NodePath.isAbsolute(base)) continue;
    if (!isFolder(base) || !inMemory(base)) continue;
    const path = NodePath.join(base, `t3code-thread-files-${hash}`);
    if (yield* ownFolder(path, uid, false))
      return { path, inMemory: true } satisfies SecretFilesRoot;
  }
  return NO_ROOT;
});

export interface MaterializedSecrets {
  /** `secretEnv` without its files: each file's variable holds its path instead. */
  readonly secretEnv: SecretEnv;
  /** Lets the folder go; the last release removes it. Runs at most once. */
  readonly release: () => void;
}

export class ThreadSecretFiles extends Context.Service<
  ThreadSecretFiles,
  {
    /** Where this machine writes Secret files, as its hello says. */
    readonly root: SecretFilesRoot;
    /** Writes `secretEnv`'s files for one process about to start, held until `release`. */
    readonly materialize: (
      secretEnv: SecretEnv,
    ) => Effect.Effect<MaterializedSecrets, SecretFilesError>;
    /** `secrets.refreshFiles`: rewrites a held folder's files in place; nothing when none holds it. */
    readonly refresh: (
      input: SecretFilesRefreshInput,
    ) => Effect.Effect<"refreshed" | "not-held", SecretFilesError>;
  }
>()("t3/secrets/ThreadSecretFiles") {}

const refuse = (reason: SecretFilesError["reason"], detail: string) =>
  new SecretFilesError({ reason, detail });

/** Size and names, checked before anything is written. Names only in what it says. */
const checkFiles = (files: ReadonlyArray<SecretEnvFile>) => {
  let total = 0;
  for (const file of files) {
    const bytes = Buffer.byteLength(file.content, "utf8");
    total += bytes;
    if (!NAME.test(file.name))
      return refuse("invalid", "A Secret file's name is not a variable's.");
    if (bytes > SECRET_FILE_MAX_BYTES) {
      return refuse("invalid", `${file.name} is larger than a Secret file may be.`);
    }
  }
  return total > SECRET_FILES_MAX_TOTAL_BYTES
    ? refuse("invalid", "A process's Secret files are larger than 1 MiB together.")
    : undefined;
};

/**
 * Writes one file to a fresh name (never one that exists, never through a link) with exactly
 * `mode`, then renames it over `name`: a reader sees the old or the new content, whole.
 */
const writeFile = (directory: string, file: SecretEnvFile) => {
  const temporary = NodePath.join(
    directory,
    `.${file.name}.${NodeCrypto.randomBytes(8).toString("hex")}.tmp`,
  );
  const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = NodeFS.constants;
  const fd = NodeFS.openSync(temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, file.mode);
  try {
    NodeFS.fchmodSync(fd, file.mode);
    NodeFS.writeSync(fd, file.content);
  } finally {
    NodeFS.closeSync(fd);
  }
  try {
    NodeFS.renameSync(temporary, NodePath.join(directory, file.name));
  } catch (cause) {
    NodeFS.rmSync(temporary, { force: true });
    throw cause;
  }
};

/** Everything under the root goes: no Secret file outlives the server that wrote it. */
const sweep = (root: SecretFilesRoot) => {
  if (!root.inMemory) return 0;
  let removed = 0;
  for (const entry of NodeFS.readdirSync(root.path)) {
    NodeFS.rmSync(NodePath.join(root.path, entry), { recursive: true, force: true });
    removed += 1;
  }
  return removed;
};

/** The service over `root`, its folders held by count. */
export const make = Effect.fn("ThreadSecretFiles.make")(function* (root: SecretFilesRoot) {
  const uid = yield* HostProcess.UserId;
  const holds = new Map<string, number>();

  /** The folder, made or checked (a real folder of this user, nobody else's way in). */
  const folderOf = Effect.fn("ThreadSecretFiles.folderOf")(function* (filesFolder: string) {
    if (!root.inMemory) {
      return yield* refuse(
        "not-in-memory",
        "This machine has no folder in memory, so it takes no Secret file: they are never written to its disk.",
      );
    }
    if (!FOLDER.test(filesFolder)) return yield* refuse("invalid", "Not a Secret files folder.");
    // The root again: removed or replaced since the start, it is made or refused like then.
    if (!inMemory(root.path) || !(yield* ownFolder(root.path, uid, false))) {
      return yield* refuse(
        "unsafe-folder",
        "The folder for Secret files is not this server's own.",
      );
    }
    const directory = NodePath.join(root.path, filesFolder);
    if (!(yield* ownFolder(directory, uid, false))) {
      return yield* refuse(
        "unsafe-folder",
        "The folder for Secret files is not this server's own.",
      );
    }
    return directory;
  });

  const writeAll = (directory: string, files: ReadonlyArray<SecretEnvFile>) =>
    Effect.try({
      try: () => {
        for (const file of files) writeFile(directory, file);
      },
      catch: () => refuse("write-failed", "A Secret file could not be written."),
    });

  const materialize = Effect.fn("ThreadSecretFiles.materialize")(function* (secretEnv: SecretEnv) {
    const { files = [], filesFolder, ...rest } = secretEnv;
    if (files.length === 0)
      return { secretEnv: rest, release: () => {} } satisfies MaterializedSecrets;
    if (filesFolder === undefined)
      return yield* refuse("invalid", "Secret files without a folder.");
    const problem = checkFiles(files);
    if (problem !== undefined) return yield* problem;
    const directory = yield* folderOf(filesFolder);
    yield* writeAll(directory, files);
    holds.set(filesFolder, (holds.get(filesFolder) ?? 0) + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const left = (holds.get(filesFolder) ?? 1) - 1;
      if (left > 0) {
        holds.set(filesFolder, left);
        return;
      }
      holds.delete(filesFolder);
      NodeFS.rmSync(directory, { recursive: true, force: true });
    };
    const named = new Set(files.map((file) => file.name));
    return {
      secretEnv: {
        ...rest,
        variables: [
          ...(rest.variables ?? []).filter((variable) => !named.has(variable.name)),
          // A path is no secret: never masked.
          ...files.map((file) => ({
            name: file.name,
            value: NodePath.join(directory, file.name),
            plain: true as const,
          })),
        ],
      },
      release,
    } satisfies MaterializedSecrets;
  });

  const refresh = Effect.fn("ThreadSecretFiles.refresh")(function* (
    input: SecretFilesRefreshInput,
  ) {
    if (!holds.has(input.filesFolder)) return "not-held" as const;
    const problem = checkFiles(input.files);
    if (problem !== undefined) return yield* problem;
    const directory = yield* folderOf(input.filesFolder);
    yield* writeAll(directory, input.files);
    return "refreshed" as const;
  });

  return ThreadSecretFiles.of({ root, materialize, refresh });
});

/**
 * A process's secrets with their files written here, held for as long as the current scope (a
 * provider session's): the variables carry the paths. Without this service, files are refused.
 */
export const holdSecretFiles = Effect.fn("ThreadSecretFiles.hold")(function* (
  files: Option.Option<ThreadSecretFiles["Service"]>,
  secretEnv: SecretEnv | undefined,
) {
  if (secretEnv === undefined || (secretEnv.files?.length ?? 0) === 0) return secretEnv;
  if (Option.isNone(files)) {
    return yield* refuse("not-in-memory", "This machine takes no Secret file.");
  }
  const done = yield* files.value.materialize(secretEnv);
  yield* Effect.addFinalizer(() => Effect.sync(done.release));
  return done.secretEnv;
});

/** The machine's root, found and swept at the start. */
export const layer = Layer.effect(
  ThreadSecretFiles,
  Effect.gen(function* () {
    const { stateDir } = yield* ServerConfig.ServerConfig;
    const root = yield* resolveSecretFilesRoot(stateDir);
    const removed = yield* Effect.sync(() => {
      try {
        return sweep(root);
      } catch {
        return undefined;
      }
    });
    if (removed === undefined) {
      yield* Effect.logWarning("ThreadSecretFiles: could not sweep the Secret files folder");
    }
    if (removed !== undefined && removed > 0)
      yield* Effect.logInfo("ThreadSecretFiles: removed Secret files left behind", { removed });
    if (!root.inMemory) {
      yield* Effect.logInfo(
        "ThreadSecretFiles: no folder in memory ($XDG_RUNTIME_DIR or /dev/shm): this machine takes no Secret file",
      );
    }
    return yield* make(root);
  }),
);

/** Tests: a given root (a tmpfs folder, or one marked not in memory), swept first. */
export const layerAt = (root: SecretFilesRoot) =>
  Layer.effect(
    ThreadSecretFiles,
    Effect.gen(function* () {
      if (root.inMemory) sweep(root);
      return yield* make(root);
    }),
  );
