/**
 * The master key file and the startup that checks it against the store. `owner` (the Hub, or a CLI
 * holding the server's ownership lock) creates the key, seals entries left in clear and finishes a
 * rotation, after authenticating every entry; `client` (beside a running Hub) only reads. Steps,
 * names and crash behaviour: docs/internals/secrets.md.
 */
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import { IDENTITY_SIGNING_KEY_PREFIX } from "../identity/signingKeyNames.ts";
import { createExclusively, readIfPresent, TEMP_FILE, writeAtomically } from "./atomicFile.ts";
import { isReplayMarker, REPLAY_MARKER_MAX_AGE } from "./replayMarkerNames.ts";
import * as SecretCipher from "./SecretCipher.ts";

/** An entry sealed with the master key; `.bin` is one in clear (before encryption, or joined). */
export const SEALED_EXTENSION = ".sealed";
export const PLAIN_EXTENSION = ".bin";
/** Beside the entries, never one of them: no entry file ends in these. */
const KEY_CHECK_FILE = "master-key.check";
const BACKUP_RECORD_FILE = "master-key.backup";
const KEY_CHECK_TEXT = "t3code master key check";
/** Temporary files older than this belong to a write that stopped; newer ones may be in flight. */
const STALE_TEMP_MS = 60_000;

const RESTORE_HINT =
  "Restore the master key from your backup with `t3 secrets key import <file>`, or point T3CODE_MASTER_KEY_FILE at it.";

export class MasterKeyError extends Schema.TaggedError<MasterKeyError>()("MasterKeyError", {
  reason: Schema.Literals([
    "missing",
    "wrong-key",
    "permissions",
    "unreadable",
    "unknown-format",
    "damaged",
    "not-encrypted",
    "needs-hub",
    "proof",
    "io",
  ]),
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}

const fail = (reason: MasterKeyError["reason"], detail: string, cause?: unknown) =>
  Effect.fail(new MasterKeyError({ reason, detail, ...(cause === undefined ? {} : { cause }) }));

const io = (what: string) => (cause: unknown) => fail("io", `Could not ${what}.`, cause);

/**
 * Where the master key lives: `T3CODE_MASTER_KEY_FILE`, or beside the secrets folder
 * (`<stateDir>/master.key`).
 */
export const masterKeyPath = Effect.fn("MasterKeyFile.masterKeyPath")(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  return config.masterKeyFile ?? path.join(path.dirname(config.secretsDir), "master.key");
});

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The key file's own names in its folder: the key, `.next`, `.previous`, `.replaced-<id>`, and
 * the temporary files their writes leave. Nothing else that merely shares the prefix.
 */
const keyFileNamePattern = (keyName: string) =>
  new RegExp(
    `^${escapeRegExp(keyName)}(\\.next|\\.previous|\\.replaced-[0-9a-f]+)?(${TEMP_FILE.source.slice(0, -1)})?$`,
  );

const AllowLoosePermissions = Config.String("T3CODE_MASTER_KEY_ALLOW_LOOSE_PERMISSIONS").pipe(
  Config.option,
  Config.map(Option.exists((value) => ["1", "true", "yes"].includes(value.trim().toLowerCase()))),
);
/** An unreadable setting allows nothing. */
// @effect-diagnostics-next-line unnecessaryEffectGen:off - yields the Config to recover its error.
const allowLoosePermissions = Effect.gen(function* () {
  return yield* AllowLoosePermissions;
}).pipe(Effect.orElseSucceed(() => false));

/**
 * Owner-only passes; so does a root-owned file group and others cannot write (a 0440/0444 secret
 * mount an administrator placed). Anything else needs T3CODE_MASTER_KEY_ALLOW_LOOSE_PERMISSIONS=1,
 * which warns at every start. Why: docs/internals/secrets.md.
 */
/** The POSIX rule on the key file's mode and owner; see `checkPermissions`. */
export const keyFilePermissionsAcceptable = (mode: number, uid: number | undefined) =>
  (mode & 0o077) === 0 || (uid === 0 && (mode & 0o027) === 0);

const checkPermissions = Effect.fn("MasterKeyFile.checkPermissions")(function* (
  file: string,
  info: FileSystem.File.Info,
) {
  // On Windows mode bits mean nothing: the file inherits its folder's ACL (the user's profile).
  if ((yield* HostProcess.Platform) === "win32") return;
  const mode = info.mode & 0o777;
  if (keyFilePermissionsAcceptable(mode, Option.getOrUndefined(info.uid))) return;
  if (yield* allowLoosePermissions) {
    yield* Effect.logWarning(
      "The master key can be read by other users of this machine; T3CODE_MASTER_KEY_ALLOW_LOOSE_PERMISSIONS lets the Hub start anyway.",
      { keyFile: file, mode: mode.toString(8) },
    );
    return;
  }
  return yield* fail(
    "permissions",
    `The master key ${file} can be read or changed by other users of this machine (mode ${mode.toString(8)}). Run \`chmod 600 ${file}\` and start again; on a file system without permissions (drvfs, NFS) set T3CODE_MASTER_KEY_ALLOW_LOOSE_PERMISSIONS=1.`,
  );
});

const readEntry = (file: string, limit?: number) =>
  readIfPresent(file, limit).pipe(Effect.catch(io(`read ${file}`)));

const readKeyFile = Effect.fn("MasterKeyFile.readKeyFile")(function* (file: string) {
  const found = yield* readEntry(file);
  if (Option.isNone(found)) return Option.none<SecretCipher.MasterKey>();
  yield* checkPermissions(file, found.value.info);
  const key = SecretCipher.MasterKey.parse(new TextDecoder().decode(found.value.bytes));
  if (key === undefined) return yield* fail("unreadable", `${file} is not a T3 Code master key.`);
  return Option.some(key);
});

/**
 * The store's folders and what each one's entries are sealed for: the store's own, and a Vault's
 * values (`ServerSecretStore.VaultValueStore`). The folder, never the name, tells the purpose.
 */
export const STORE_NAMESPACES = [
  { dir: "", purpose: "server-secret" },
  { dir: "vault-values", purpose: "vault-value" },
  // AI accounts' credentials (spec 4), read only by AiAccounts.
  { dir: "ai-accounts", purpose: "ai-account-credential" },
  // Subscription AI accounts' OAuth tokens (spec 4 ticket 03), read only by AiAccounts.
  { dir: "ai-account-tokens", purpose: "ai-account-oauth-token" },
  // Values read from Secret providers and delivered to Threads, only to mask them there.
  { dir: "delivered-values", purpose: "delivered-value" },
] as const satisfies ReadonlyArray<{
  readonly dir: string;
  readonly purpose: SecretCipher.SealPurpose;
}>;
export type StoreNamespace = (typeof STORE_NAMESPACES)[number];
export const VAULT_VALUES_NAMESPACE: StoreNamespace = STORE_NAMESPACES[1];
export const AI_ACCOUNT_CREDENTIALS_NAMESPACE: StoreNamespace = STORE_NAMESPACES[2];
export const AI_ACCOUNT_TOKENS_NAMESPACE: StoreNamespace = STORE_NAMESPACES[3];
export const DELIVERED_VALUES_NAMESPACE: StoreNamespace = STORE_NAMESPACES[4];

interface Entry {
  /** Unique across folders: `<dir>/<name>`. */
  readonly key: string;
  /** The entry's name, its associated data. */
  readonly name: string;
  readonly file: string;
  readonly purpose: SecretCipher.SealPurpose;
}

/** Every folder's entries, told apart by name: sealed (`.sealed`) and in clear (`.bin`). */
const listEntries = Effect.fn("MasterKeyFile.listEntries")(function* (secretsDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sealed = new Map<string, Entry>();
  const plain = new Map<string, Entry>();
  for (const namespace of STORE_NAMESPACES) {
    const dir = namespace.dir === "" ? secretsDir : path.join(secretsDir, namespace.dir);
    const names =
      namespace.dir === ""
        ? yield* fs.readDirectory(dir).pipe(Effect.catch(io(`list ${dir}`)))
        : yield* fs.readDirectory(dir).pipe(
            Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])),
            Effect.catch(io(`list ${dir}`)),
          );
    for (const fileName of names.toSorted()) {
      for (const [extension, into] of [
        [SEALED_EXTENSION, sealed],
        [PLAIN_EXTENSION, plain],
      ] as const) {
        if (fileName.endsWith(extension) && fileName.length > extension.length) {
          const name = fileName.slice(0, -extension.length);
          const key = `${namespace.dir}/${name}`;
          into.set(key, { key, name, file: path.join(dir, fileName), purpose: namespace.purpose });
        }
      }
    }
  }
  return { sealed, plain };
});

const removeFile = (file: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.remove(file).pipe(
      Effect.catchReason("PlatformError", "NotFound", () => Effect.void),
      Effect.catch(io(`remove ${file}`)),
    ),
  );

const statOf = (file: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.stat(file).pipe(Effect.catch(io(`read ${file}`))),
  );

/** Removes temporary files matching `pattern` in `dir` that a stopped write left behind. */
const removeStaleTemps = Effect.fn("MasterKeyFile.removeStaleTemps")(function* (
  dir: string,
  pattern: RegExp,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const now = yield* Clock.currentTimeMillis;
  const names = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []));
  for (const name of names) {
    if (!TEMP_FILE.test(name) || !pattern.test(name)) continue;
    const file = path.join(dir, name);
    yield* fs.stat(file).pipe(
      Effect.flatMap((info) =>
        Option.exists(info.mtime, (mtime) => now - mtime.getTime() > STALE_TEMP_MS)
          ? fs.remove(file)
          : Effect.void,
      ),
      Effect.ignore,
    );
  }
});

const timesOf = (info: FileSystem.File.Info) =>
  Option.getOrUndefined(
    Option.map(info.mtime, (mtime) => ({
      atime: Option.getOrElse(info.atime, () => mtime),
      mtime,
    })),
  );

export interface Keyring {
  /** Seals every new value. */
  readonly current: SecretCipher.MasterKey;
  /** Open values: the current key and, kept until the Owner removes it, the previous one. */
  readonly keys: ReadonlyArray<SecretCipher.MasterKey>;
  readonly keyFile: string;
}

const keyFilesOf = Effect.fn("MasterKeyFile.keyFiles")(function* () {
  const keyFile = yield* masterKeyPath();
  return { keyFile, nextFile: `${keyFile}.next`, previousFile: `${keyFile}.previous` };
});

const isAlreadyExists = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "reason" in error &&
  (error as { readonly reason: { readonly _tag?: string } }).reason._tag === "AlreadyExists";

/** The check records the key file the Hub started with, so a CLI using another one is told. */
const checkText = (keyFile: string) => `${KEY_CHECK_TEXT}\n${keyFile}`;

const checkedKeyFile = (plaintext: Uint8Array) => {
  const [text, keyFile] = new TextDecoder().decode(plaintext).split("\n");
  return text === KEY_CHECK_TEXT ? Option.some(keyFile ?? "") : Option.none<string>();
};

/**
 * Opens the store's key. Writes nothing in `client` mode, which fails when the store needs the
 * Hub's startup. In `owner` mode every live entry is authenticated before anything is written.
 */
export const openKeyring = Effect.fn("MasterKeyFile.openKeyring")(function* (
  mode: "owner" | "client",
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const { keyFile, nextFile, previousFile } = yield* keyFilesOf();
  const secretsDir = config.secretsDir;
  const checkFile = path.join(secretsDir, KEY_CHECK_FILE);

  const found = yield* readKeyFile(keyFile);
  const next = yield* readKeyFile(nextFile);
  const previous = yield* readKeyFile(previousFile);
  const { sealed, plain } = yield* listEntries(secretsDir);
  const check = yield* readEntry(checkFile);

  let current: SecretCipher.MasterKey;
  if (Option.isSome(found)) {
    current = found.value;
  } else {
    if (sealed.size > 0 || Option.isSome(check) || Option.isSome(next) || Option.isSome(previous)) {
      return yield* fail(
        "missing",
        `The master key ${keyFile} is missing, but ${secretsDir} holds secrets encrypted with one${sealed.size > 0 ? ` (${sealed.size})` : ""}. The Hub does not start without it and never creates a new key over them. ${RESTORE_HINT}`,
      );
    }
    if (mode === "client") {
      return yield* fail(
        "needs-hub",
        `There is no master key at ${keyFile} yet. Start the Hub once (it creates it), or stop it and run this again.`,
      );
    }
    yield* fs
      .makeDirectory(path.dirname(keyFile), { recursive: true, mode: 0o700 })
      .pipe(Effect.catch(io(`create the folder of ${keyFile}`)));
    const created = SecretCipher.MasterKey.generate();
    current = yield* createExclusively(
      keyFile,
      new TextEncoder().encode(created.exportText()),
    ).pipe(
      Effect.as(created),
      Effect.catch((error) =>
        // Another process made it first: use theirs.
        isAlreadyExists(error)
          ? readKeyFile(keyFile).pipe(
              Effect.flatMap(
                Option.match({
                  onSome: Effect.succeed,
                  onNone: () => fail("io", `${keyFile} vanished while it was created.`),
                }),
              ),
            )
          : fail("io", `Could not create ${keyFile}.`, error),
      ),
    );
    yield* Effect.logInfo("Created the master key that encrypts the Hub's secrets.", {
      keyFile,
      keyId: current.id,
    });
  }
  const keys = [current, ...Option.toArray(next), ...Option.toArray(previous)];
  const target = Option.getOrElse(next, () => current);
  const markerCutoff = (yield* Clock.currentTimeMillis) - Duration.toMillis(REPLAY_MARKER_MAX_AGE);

  if (mode === "client") {
    // Beside a running Hub: names only (no entry is read), replay markers ignored (they are the
    // Hub's to prune); the key check tells a wrong key.
    if (Option.isSome(check)) {
      const opened = SecretCipher.open(keys, "key-check", KEY_CHECK_FILE, check.value.bytes);
      const checked = opened._tag === "opened" ? checkedKeyFile(opened.plaintext) : Option.none();
      if (Option.isNone(checked)) {
        return yield* fail(
          "wrong-key",
          `The master key ${keyFile} (id ${current.id}) does not open the key check ${checkFile}: it is not the key the Hub's secrets were encrypted with. ${RESTORE_HINT}`,
        );
      }
      if (checked.value !== keyFile) {
        yield* Effect.logWarning(
          `The Hub last started with the master key at ${checked.value}; this uses ${keyFile}. Check T3CODE_MASTER_KEY_FILE.`,
        );
      }
    }
    const inClear = [...plain.values()].filter(
      (entry) => !entry.key.startsWith("/") || !isReplayMarker(entry.name),
    ).length;
    if (inClear > 0 || Option.isSome(next)) {
      return yield* fail(
        "needs-hub",
        `The Hub's secrets in ${secretsDir} need its startup (${inClear} in clear${Option.isSome(next) ? ", a rotation to finish" : ""}). Start the Hub, or stop it and run this again.`,
      );
    }
    return { current, keys: [current, ...Option.toArray(previous)], keyFile } satisfies Keyring;
  }

  // Headers only: which key sealed each entry. Checked before anything is written.
  const sealedUnder = new Map<string, string>();
  // Removed while this ran (a replay marker pruned): nothing to do for them.
  const vanished = new Set<string>();
  for (const entry of sealed.values()) {
    const head = yield* readEntry(entry.file, SecretCipher.HEADER_BYTES);
    if (Option.isNone(head)) {
      vanished.add(entry.file);
      continue;
    }
    const header = SecretCipher.parseHeader(head.value.bytes);
    if (header._tag !== "sealed") {
      return yield* fail(
        "unknown-format",
        `${entry.file} was written by a newer T3 Code, or damaged; this version cannot read it.`,
      );
    }
    if (!keys.some((key) => key.id === header.keyId)) {
      return yield* fail(
        "wrong-key",
        `The master key ${keyFile} (id ${current.id}) is not the key that encrypted ${entry.file} (id ${header.keyId}). The Hub does not start and changed nothing. ${RESTORE_HINT}`,
      );
    }
    sealedUnder.set(entry.key, header.keyId);
  }
  let checkedPath = Option.none<string>();
  let checkUnder = Option.none<string>();
  if (Option.isSome(check)) {
    const opened = SecretCipher.open(keys, "key-check", KEY_CHECK_FILE, check.value.bytes);
    checkedPath = opened._tag === "opened" ? checkedKeyFile(opened.plaintext) : Option.none();
    if (Option.isNone(checkedPath)) {
      return yield* fail(
        "wrong-key",
        `The master key ${keyFile} (id ${current.id}) does not open the key check ${checkFile}: it is not the key these secrets were encrypted with. The Hub does not start and changed nothing. ${RESTORE_HINT}`,
      );
    }
    const header = SecretCipher.parseHeader(check.value.bytes);
    checkUnder = header._tag === "sealed" ? Option.some(header.keyId) : Option.none();
  }
  if (Option.exists(checkedPath, (hubKeyFile) => hubKeyFile !== keyFile)) {
    yield* Effect.logWarning(
      `The Hub last started with the master key at ${Option.getOrElse(checkedPath, () => "")}; this uses ${keyFile}. Check T3CODE_MASTER_KEY_FILE.`,
    );
  }

  // What a write would change: entries in clear, entries under another key, expired markers.
  const expired = new Set<string>();
  for (const entry of [...sealed.values(), ...plain.values()]) {
    if (!entry.key.startsWith("/") || !isReplayMarker(entry.name)) continue;
    const info = yield* statOf(entry.file);
    if (Option.exists(info.mtime, (mtime) => mtime.getTime() < markerCutoff)) {
      expired.add(entry.file);
    }
  }
  const toSeal = [...plain.values()].filter((entry) => !expired.has(entry.file));
  const toReseal = [...sealed.values()].filter(
    (entry) =>
      !expired.has(entry.file) &&
      !vanished.has(entry.file) &&
      sealedUnder.get(entry.key) !== target.id,
  );
  const pending =
    toSeal.length > 0 || toReseal.length > 0 || expired.size > 0 || Option.isSome(next);

  if (pending) {
    // Authenticate every live entry before writing anything: a damaged one stops here.
    const opened = new Map<string, Uint8Array>();
    for (const entry of sealed.values()) {
      if (expired.has(entry.file)) continue;
      const stored = yield* readEntry(entry.file);
      if (Option.isNone(stored)) continue;
      const result = SecretCipher.open(keys, entry.purpose, entry.name, stored.value.bytes);
      if (result._tag !== "opened") {
        return yield* fail(
          "damaged",
          `${entry.file} does not open with its key: it was altered or moved from another name. Nothing was written. Remove it, or restore it from a backup.`,
        );
      }
      opened.set(entry.key, result.plaintext);
    }
    for (const file of expired) yield* removeFile(file);
    let written = 0;
    for (const entry of toSeal) {
      const twin = sealed.get(entry.key);
      if (twin === undefined || expired.has(twin.file)) {
        const stored = yield* readEntry(entry.file);
        if (Option.isNone(stored)) continue;
        // The first encrypting build kept sealed values in `.bin`: one that opens (its tag
        // verifies under its name and purpose) is already sealed, never sealed a second time.
        const already = SecretCipher.open(keys, entry.purpose, entry.name, stored.value.bytes);
        const sealedPath = path.join(path.dirname(entry.file), `${entry.name}${SEALED_EXTENSION}`);
        const header = SecretCipher.parseHeader(stored.value.bytes);
        if (already._tag === "opened" && header._tag === "sealed" && header.keyId === target.id) {
          yield* fs.rename(entry.file, sealedPath).pipe(Effect.catch(io(`rename ${entry.file}`)));
          written += 1;
          continue;
        }
        const plaintext = already._tag === "opened" ? already.plaintext : stored.value.bytes;
        yield* writeAtomically(
          sealedPath,
          SecretCipher.seal(target, entry.purpose, entry.name, plaintext),
          timesOf(stored.value.info),
        ).pipe(Effect.catch(io(`encrypt ${entry.file}`)));
        written += 1;
      }
      // Sealed now, or by a start that stopped before removing it: the clear copy goes.
      yield* removeFile(entry.file);
    }
    for (const entry of toReseal) {
      const plaintext = opened.get(entry.key);
      if (plaintext === undefined) continue;
      const info = yield* statOf(entry.file);
      yield* writeAtomically(
        entry.file,
        SecretCipher.seal(target, entry.purpose, entry.name, plaintext),
        timesOf(info),
      ).pipe(Effect.catch(io(`re-encrypt ${entry.file}`)));
      written += 1;
    }
    yield* Effect.logInfo("Encrypted the Hub's secrets with its master key.", {
      sealed: written,
      droppedReplayMarkers: expired.size,
      keyId: target.id,
    });
  }

  if (
    Option.isNone(check) ||
    !Option.contains(checkUnder, target.id) ||
    !Option.contains(checkedPath, keyFile)
  ) {
    const checkSealed = SecretCipher.seal(
      target,
      "key-check",
      KEY_CHECK_FILE,
      new TextEncoder().encode(checkText(keyFile)),
    );
    yield* (
      Option.isNone(check)
        ? createExclusively(checkFile, checkSealed).pipe(
            Effect.catchIf(isAlreadyExists, () => Effect.void),
          )
        : writeAtomically(checkFile, checkSealed)
    ).pipe(Effect.catch(io(`write ${checkFile}`)));
  }

  if (Option.isSome(next)) {
    // A backup record of the old key is no backup of the new one.
    yield* removeFile(path.join(secretsDir, BACKUP_RECORD_FILE));
    // Every entry is under the new key: keep the old one, then put the new one in place.
    yield* writeAtomically(previousFile, new TextEncoder().encode(current.exportText())).pipe(
      Effect.catch(io(`write ${previousFile}`)),
    );
    yield* fs.rename(nextFile, keyFile).pipe(Effect.catch(io(`replace ${keyFile}`)));
    yield* Effect.logInfo("Finished rotating the master key.", {
      keyFile,
      keyId: target.id,
      previousKeyId: current.id,
    });
  }
  for (const namespace of STORE_NAMESPACES) {
    const dir = namespace.dir === "" ? secretsDir : path.join(secretsDir, namespace.dir);
    yield* removeStaleTemps(dir, /./);
  }
  yield* removeStaleTemps(path.dirname(keyFile), keyFileNamePattern(path.basename(keyFile)));

  const previousKey = Option.isSome(next) ? Option.some(current) : previous;
  return {
    current: target,
    keys: [target, ...Option.toArray(previousKey)],
    keyFile,
  } satisfies Keyring;
});

/**
 * Starts a rotation (the new key beside the old one) and runs the startup that finishes it. The
 * caller holds the server's ownership lock: a running Hub seals with the key it loaded.
 */
export const rotate = Effect.fn("MasterKeyFile.rotate")(function* () {
  const { nextFile } = yield* keyFilesOf();
  const before = yield* openKeyring("owner");
  const fresh = SecretCipher.MasterKey.generate();
  yield* writeAtomically(nextFile, new TextEncoder().encode(fresh.exportText())).pipe(
    Effect.catch(io(`write ${nextFile}`)),
  );
  const after = yield* openKeyring("owner");
  return { previousKeyId: before.current.id, keyId: after.current.id, keyFile: after.keyFile };
});

/** Whether this state directory belongs to a Hub that encrypts its secrets. */
export const holdsEncryptedSecrets = Effect.fn("MasterKeyFile.holdsEncryptedSecrets")(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const { keyFile } = yield* keyFilesOf();
  const listed = yield* listEntries(config.secretsDir).pipe(Effect.option);
  const present = (file: string) =>
    fs.stat(file).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
  return (
    Option.exists(listed, ({ sealed }) => sealed.size > 0) ||
    (yield* present(keyFile)) ||
    (yield* present(path.join(config.secretsDir, KEY_CHECK_FILE)))
  );
});

const BackupRecord = Schema.fromJsonString(
  Schema.Struct({ keyId: Schema.String, backedUpAt: Schema.String }),
);
const decodeBackupRecord = Schema.decodeOption(BackupRecord);
const encodeBackupRecord = Schema.encodeEffect(BackupRecord);

/** When this key was backed up; kept beside the entries, where no stored secret can set it. */
export const readBackupRecord = Effect.fn("MasterKeyFile.readBackupRecord")(function* (
  keyring: Keyring,
) {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const stored = yield* readEntry(path.join(config.secretsDir, BACKUP_RECORD_FILE));
  if (Option.isNone(stored)) return Option.none<string>();
  const opened = SecretCipher.open(
    keyring.keys,
    "backup-record",
    BACKUP_RECORD_FILE,
    stored.value.bytes,
  );
  if (opened._tag !== "opened") return Option.none<string>();
  return decodeBackupRecord(new TextDecoder().decode(opened.plaintext)).pipe(
    // A backup of a key since rotated away is no backup of this one.
    Option.filter((record) => record.keyId === keyring.current.id),
    Option.map((record) => record.backedUpAt),
  );
});

export const writeBackupRecord = Effect.fn("MasterKeyFile.writeBackupRecord")(function* (
  keyring: Keyring,
  backedUpAt: string,
) {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const text = yield* encodeBackupRecord({ keyId: keyring.current.id, backedUpAt }).pipe(
    Effect.orDie,
  );
  yield* writeAtomically(
    path.join(config.secretsDir, BACKUP_RECORD_FILE),
    SecretCipher.seal(
      keyring.current,
      "backup-record",
      BACKUP_RECORD_FILE,
      new TextEncoder().encode(text),
    ),
  ).pipe(Effect.catch(io("record the master key's backup")));
});

/**
 * A restore never brings back the workload identity signing keys (ticket 07): whoever holds an
 * old backup and a copy of the secrets could sign as this Hub. The Hub makes new ones; verifiers
 * fetch them from its JWKS.
 */
const dropIdentitySigningKeys = Effect.fn("MasterKeyFile.dropIdentitySigningKeys")(function* (
  secretsDir: string,
) {
  const { sealed } = yield* listEntries(secretsDir);
  for (const entry of sealed.values()) {
    if (entry.key === `/${entry.name}` && entry.name.startsWith(IDENTITY_SIGNING_KEY_PREFIX)) {
      yield* removeFile(entry.file);
    }
  }
});

/**
 * Puts a backed-up key in place; the caller holds the server's ownership lock. Refused when it
 * does not open every secret here; a key it replaces is kept beside it, never discarded.
 */
export const importKey = Effect.fn("MasterKeyFile.importKey")(function* (
  text: Redacted.Redacted<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const { keyFile, nextFile } = yield* keyFilesOf();
  const key = SecretCipher.MasterKey.parse(Redacted.value(text));
  if (key === undefined) {
    return yield* fail("unreadable", "That is not a T3 Code master key backup.");
  }
  if (Option.isSome(yield* readEntry(nextFile, 1))) {
    return yield* fail(
      "io",
      `A rotation of the master key has not finished (${nextFile}). Run \`t3 secrets key rotate\` or start the Hub once, then import.`,
    );
  }
  const current = yield* readKeyFile(keyFile).pipe(
    // A damaged or too-open key file is replaced like a missing one (it is kept beside).
    Effect.catchTags({
      MasterKeyError: (error) => (error.reason === "io" ? Effect.fail(error) : Effect.succeedNone),
    }),
  );
  if (Option.isSome(current) && current.value.id === key.id) {
    yield* dropIdentitySigningKeys(config.secretsDir);
    return { keyId: key.id, keyFile, replaced: false };
  }
  // Every sealed entry and the key check must open with it.
  const refuse = fail(
    "wrong-key",
    Option.isSome(current)
      ? `That master key (id ${key.id}) does not open the secrets in ${config.secretsDir}; the current one is ${current.value.id}. Nothing changed; \`t3 secrets key rotate\` changes keys.`
      : `That master key (id ${key.id}) does not open the secrets in ${config.secretsDir}. Nothing changed.`,
  );
  const { sealed } = yield* listEntries(config.secretsDir);
  for (const entry of sealed.values()) {
    const stored = yield* readEntry(entry.file);
    if (Option.isNone(stored)) continue;
    const opened = SecretCipher.open([key], entry.purpose, entry.name, stored.value.bytes);
    if (opened._tag !== "opened") return yield* refuse;
  }
  const check = yield* readEntry(path.join(config.secretsDir, KEY_CHECK_FILE));
  if (
    Option.isSome(check) &&
    SecretCipher.open([key], "key-check", KEY_CHECK_FILE, check.value.bytes)._tag !== "opened"
  ) {
    return yield* refuse;
  }
  yield* fs
    .makeDirectory(path.dirname(keyFile), { recursive: true, mode: 0o700 })
    .pipe(Effect.catch(io(`create the folder of ${keyFile}`)));
  const replaced = yield* readEntry(keyFile);
  if (Option.isSome(replaced)) {
    const keptAs = `${keyFile}.replaced-${Option.match(current, {
      onSome: (old) => old.id,
      onNone: () => SecretCipher.MasterKey.generate().id,
    })}`;
    yield* writeAtomically(keptAs, replaced.value.bytes).pipe(Effect.catch(io(`write ${keptAs}`)));
  }
  yield* writeAtomically(keyFile, new TextEncoder().encode(key.exportText())).pipe(
    Effect.catch(io(`write ${keyFile}`)),
  );
  yield* dropIdentitySigningKeys(config.secretsDir);
  return { keyId: key.id, keyFile, replaced: Option.isSome(replaced) };
});
