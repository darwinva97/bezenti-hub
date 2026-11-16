// @effect-diagnostics nodeBuiltinImport:off - lstat (no symlink followed) and the folder's name hash.
/**
 * Where the plaintext of a `file` answer of request_secret goes for the agent's own shell: an
 * owner-only folder in memory (`$XDG_RUNTIME_DIR`, else `/dev/shm`), never a symlink, never one
 * someone else made. Without one (macOS, Windows), `secrets/delivered/` on the disk, 0700, which
 * the Hub empties at every start. See docs/internals/secrets.md.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

/** A folder chosen by the caller (tests); otherwise one is found. */
export class SecretFilesDirectory extends Context.Service<
  SecretFilesDirectory,
  { readonly directory: string }
>()("t3/secrets/SecretFilesDirectory") {}

export interface SecretFilesFolder {
  readonly directory: string;
  /** False when it is on the disk: a platform without a folder in memory. */
  readonly inMemory: boolean;
}

/**
 * Makes `directory` (never through a symlink) and checks, without following links, that it is a
 * real folder of this user that nobody else may enter.
 */
export const ownFolder = (directory: string, uid: number | undefined, recursive: boolean) =>
  Effect.sync(() => {
    try {
      NodeFS.mkdirSync(directory, { mode: 0o700, recursive });
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") return false;
    }
    try {
      const info = NodeFS.lstatSync(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) return false;
      if (uid !== undefined && info.uid !== uid) return false;
      if ((info.mode & 0o077) !== 0) NodeFS.chmodSync(directory, 0o700);
      return uid === undefined || (NodeFS.lstatSync(directory).mode & 0o077) === 0;
    } catch {
      return false;
    }
  });

const isFolder = (base: string) =>
  Effect.sync(() => {
    try {
      return NodeFS.statSync(base).isDirectory();
    } catch {
      return false;
    }
  });

export const resolveSecretFilesDirectory = Effect.fn("SecretFilesDirectory.resolve")(function* (
  secretsDir: string,
) {
  const configured = yield* Effect.serviceOption(SecretFilesDirectory);
  if (Option.isSome(configured)) {
    return Option.some<SecretFilesFolder>({
      directory: configured.value.directory,
      inMemory: true,
    });
  }
  const path = yield* Path.Path;
  const environment = yield* HostProcess.Environment;
  const uid = yield* HostProcess.UserId;
  if (uid !== undefined) {
    // One folder per state directory, so two Hubs of one user never share answers.
    const hash = NodeCrypto.createHash("sha256").update(secretsDir).digest("hex").slice(0, 16);
    // `T3CODE_SHM_DIR` stands in for /dev/shm in tests and live passes only.
    for (const base of [environment.XDG_RUNTIME_DIR, environment.T3CODE_SHM_DIR ?? "/dev/shm"]) {
      if (base === undefined || base.length === 0 || !path.isAbsolute(base)) continue;
      if (!(yield* isFolder(base))) continue;
      const directory = path.join(base, `t3code-secret-files-${hash}`);
      // A planted symlink or someone else's folder under that name is never used.
      if (yield* ownFolder(directory, uid, false)) {
        return Option.some<SecretFilesFolder>({ directory, inMemory: true });
      }
    }
  }
  const onDisk = path.join(secretsDir, "delivered");
  if (yield* ownFolder(onDisk, uid, true)) {
    return Option.some<SecretFilesFolder>({ directory: onDisk, inMemory: false });
  }
  return Option.none<SecretFilesFolder>();
});
