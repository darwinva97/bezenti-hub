/**
 * The Hub's secrets, one file per name in `<stateDir>/secrets`, each sealed with the master key
 * without its callers knowing. A joined machine keeps the credential its Hub writes as written (a
 * Sandbox mounts it read-only): see docs/internals/secrets.md.
 */
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import { createExclusively, writeAtomically } from "./atomicFile.ts";
import * as MasterKeyFile from "./MasterKeyFile.ts";
import * as SecretCipher from "./SecretCipher.ts";

const secretStoreErrorContext = {
  resource: Schema.String,
  cause: Schema.Defect(),
};

export class SecretStoreSecureError extends Schema.TaggedError<SecretStoreSecureError>()(
  "SecretStoreSecureError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to secure ${this.resource}.`;
  }
}

export class SecretStoreReadError extends Schema.TaggedError<SecretStoreReadError>()(
  "SecretStoreReadError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to read ${this.resource}.`;
  }
}

export class SecretStoreTemporaryPathError extends Schema.TaggedError<SecretStoreTemporaryPathError>()(
  "SecretStoreTemporaryPathError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to create temporary path for ${this.resource}.`;
  }
}

export class SecretStorePersistError extends Schema.TaggedError<SecretStorePersistError>()(
  "SecretStorePersistError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to persist ${this.resource}.`;
  }
}

export class SecretStoreRandomGenerationError extends Schema.TaggedError<SecretStoreRandomGenerationError>()(
  "SecretStoreRandomGenerationError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to generate random bytes for ${this.resource}.`;
  }
}

export class SecretStoreConcurrentReadError extends Schema.TaggedError<SecretStoreConcurrentReadError>()(
  "SecretStoreConcurrentReadError",
  {
    resource: Schema.String,
  },
) {
  override get message(): string {
    return `Failed to read ${this.resource} after concurrent creation.`;
  }
}

export class SecretStoreRemoveError extends Schema.TaggedError<SecretStoreRemoveError>()(
  "SecretStoreRemoveError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to remove ${this.resource}.`;
  }
}

export class SecretStoreDecodeError extends Schema.TaggedError<SecretStoreDecodeError>()(
  "SecretStoreDecodeError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to decode ${this.resource}.`;
  }
}

export class SecretStoreEncodeError extends Schema.TaggedError<SecretStoreEncodeError>()(
  "SecretStoreEncodeError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to encode ${this.resource}.`;
  }
}

export const SecretStoreError = Schema.Union([
  SecretStoreSecureError,
  SecretStoreReadError,
  SecretStoreTemporaryPathError,
  SecretStorePersistError,
  SecretStoreRandomGenerationError,
  SecretStoreConcurrentReadError,
  SecretStoreRemoveError,
  SecretStoreDecodeError,
  SecretStoreEncodeError,
]);
export type SecretStoreError = typeof SecretStoreError.Type;
export const isSecretStoreError = Schema.is(SecretStoreError);

const isPlatformError = (value: unknown): value is PlatformError.PlatformError =>
  Predicate.isTagged(value, "PlatformError");

export const isSecretAlreadyExistsError = (error: SecretStoreError): boolean =>
  "cause" in error && isPlatformError(error.cause) && error.cause.reason._tag === "AlreadyExists";

export class ServerSecretStore extends Context.Service<
  ServerSecretStore,
  {
    readonly directory?: string;
    readonly get: (name: string) => Effect.Effect<Option.Option<Uint8Array>, SecretStoreError>;
    readonly set: (name: string, value: Uint8Array) => Effect.Effect<void, SecretStoreError>;
    readonly create: (name: string, value: Uint8Array) => Effect.Effect<void, SecretStoreError>;
    readonly getOrCreateRandom: (
      name: string,
      bytes: number,
    ) => Effect.Effect<Uint8Array, SecretStoreError>;
    readonly remove: (name: string) => Effect.Effect<void, SecretStoreError>;
  }
>()("t3/auth/ServerSecretStore") {}

/**
 * A Vault's values: their own folder of the store (`secrets/vault-values/`) and purpose, so no
 * other caller's name reaches one. Kept only where a master key seals them: on a joined machine
 * every operation fails rather than store a value in clear.
 */
export class VaultValueStore extends Context.Service<
  VaultValueStore,
  {
    readonly get: (id: string) => Effect.Effect<Option.Option<Uint8Array>, SecretStoreError>;
    readonly set: (id: string, value: Uint8Array) => Effect.Effect<void, SecretStoreError>;
    readonly remove: (id: string) => Effect.Effect<void, SecretStoreError>;
    /** The ids of every value stored, for the start's sweep of values no secret points at. */
    readonly list: Effect.Effect<ReadonlyArray<string>, SecretStoreError>;
  }
>()("t3/auth/ServerSecretStore/VaultValueStore") {}

/**
 * AI accounts' credentials (spec 4): their own folder of the store (`secrets/ai-accounts/`) and
 * purpose, like Vault values. Kept only where a master key seals them; never in clear.
 */
export class AiAccountCredentialStore extends Context.Service<
  AiAccountCredentialStore,
  {
    readonly get: (id: string) => Effect.Effect<Option.Option<Uint8Array>, SecretStoreError>;
    readonly set: (id: string, value: Uint8Array) => Effect.Effect<void, SecretStoreError>;
    readonly remove: (id: string) => Effect.Effect<void, SecretStoreError>;
    /** The ids of every credential stored, for the start's sweep of ones no account holds. */
    readonly list: Effect.Effect<ReadonlyArray<string>, SecretStoreError>;
  }
>()("t3/auth/ServerSecretStore/AiAccountCredentialStore") {}

/**
 * Subscription AI accounts' OAuth tokens (spec 4 ticket 03): their own folder
 * (`secrets/ai-account-tokens/`) and purpose. A token is re-sealed here each time CLIProxyAPI
 * refreshes it; it is in clear only in CLIProxyAPI's `auth-dir` in memory.
 */
export class AiAccountTokenStore extends Context.Service<
  AiAccountTokenStore,
  {
    readonly get: (id: string) => Effect.Effect<Option.Option<Uint8Array>, SecretStoreError>;
    readonly set: (id: string, value: Uint8Array) => Effect.Effect<void, SecretStoreError>;
    readonly remove: (id: string) => Effect.Effect<void, SecretStoreError>;
    /** The ids of every token stored, for the start's sweep of ones no account holds. */
    readonly list: Effect.Effect<ReadonlyArray<string>, SecretStoreError>;
  }
>()("t3/auth/ServerSecretStore/AiAccountTokenStore") {}

/**
 * Values read from Secret providers that a Thread received (its `delivered:<id>` values, see
 * vaults/DeliveredValues.ts): their own folder (`secrets/delivered-values/`) and purpose, kept only
 * to mask them in that Thread, and removed with it. Never revealed, never delivered from here.
 */
export class DeliveredValueStore extends Context.Service<
  DeliveredValueStore,
  {
    readonly get: (id: string) => Effect.Effect<Option.Option<Uint8Array>, SecretStoreError>;
    readonly set: (id: string, value: Uint8Array) => Effect.Effect<void, SecretStoreError>;
    readonly remove: (id: string) => Effect.Effect<void, SecretStoreError>;
    /** The ids of every value stored, for the start's sweep of ones no Thread holds. */
    readonly list: Effect.Effect<ReadonlyArray<string>, SecretStoreError>;
  }
>()("t3/auth/ServerSecretStore/DeliveredValueStore") {}

/** The master key the store opened with; none on a joined machine. */
export class MasterKeyring extends Context.Service<
  MasterKeyring,
  {
    readonly keyring: Option.Option<MasterKeyFile.Keyring>;
    /** Why a command beside a running server could not open it (the server's startup is due). */
    readonly unavailable: Option.Option<MasterKeyFile.MasterKeyError>;
  }
>()("t3/auth/ServerSecretStore/MasterKeyring") {}

/**
 * `owner`: a server (Hub or joined), which holds the ownership lock. `client`: a command beside
 * it, which takes the lock for its startup only when no server runs, and otherwise only reads.
 * `joined`: `t3 join`, about to make this machine a joined one.
 */
type StoreMode = "owner" | "client" | "joined";

const makeWith = Effect.fn("ServerSecretStore.make")(function* (mode: StoreMode) {
  const crypto = yield* SecureRandom.SecureRandom;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig.ServerConfig;

  yield* fileSystem.makeDirectory(serverConfig.secretsDir, { recursive: true });
  yield* fileSystem.chmod(serverConfig.secretsDir, 0o700).pipe(
    Effect.mapError(
      (cause) =>
        new SecretStoreSecureError({
          resource: `secrets directory ${serverConfig.secretsDir}`,
          cause,
        }),
    ),
  );

  const joinedMachine =
    mode === "joined" ||
    serverConfig.joinedHub !== undefined ||
    (yield* fileSystem.exists(serverConfig.joinedHubPath).pipe(Effect.orElseSucceed(() => false)));
  // A joined machine that was a Hub keeps its key: what that Hub sealed opens, and new values are
  // sealed too. One that never was keeps the credential its Hub writes in clear.
  const encrypted = !joinedMachine || (yield* MasterKeyFile.holdsEncryptedSecrets());
  /**
   * A command beside the Hub reads without the lock. Only when the store needs the Hub's startup
   * and no server is running (no runtime record of a lock holder with a live pid) does it take the lock,
   * briefly, to do that startup itself; a Hub starting meanwhile wins the lock instead.
   */
  const openAsClient = MasterKeyFile.openKeyring("client").pipe(
    Effect.catchIf(
      (error) => error.reason === "needs-hub",
      (needsHub) =>
        Effect.scoped(
          Effect.gen(function* () {
            // Loaded here: these modules reach much of the server, which reaches this store.
            const [ServerOwnership, ProcessRunner, RuntimeState] = yield* Effect.promise(() =>
              Promise.all([
                import("../serverOwnership.ts"),
                import("../processRunner.ts"),
                import("../serverRuntimeState.ts"),
              ]),
            );
            const record = yield* RuntimeState.readPersistedServerRuntimeState(
              serverConfig.serverRuntimeStatePath,
            ).pipe(Effect.orElseSucceed(() => Option.none()));
            // A server that holds the lock records its owner id; with a live pid, it runs.
            const running = Option.exists(
              record,
              (state) => state.ownerId !== undefined && RuntimeState.isProcessAlive(state.pid),
            );
            if (running) {
              return yield* needsHub;
            }
            const owned = yield* ServerOwnership.acquireServerOwnership(
              serverConfig.serverRuntimeStatePath,
            ).pipe(Effect.provide(ProcessRunner.layer), Effect.option);
            if (Option.isNone(owned)) return yield* needsHub;
            return yield* MasterKeyFile.openKeyring("owner");
          }),
        ),
    ),
  );
  // Beside a running server whose store needs its startup, a command still runs; only what reads
  // or writes a secret fails, saying so.
  const opened = !encrypted
    ? undefined
    : mode === "owner"
      ? yield* MasterKeyFile.openKeyring("owner").pipe(Effect.map(Result.succeed))
      : yield* openAsClient.pipe(
          Effect.map(Result.succeed),
          Effect.catchIf(
            (error) => error.reason === "needs-hub",
            (error) => Effect.succeed(Result.fail(error)),
          ),
        );
  const keyring = opened !== undefined && Result.isSuccess(opened) ? opened.success : undefined;
  const unavailable = opened !== undefined && Result.isFailure(opened) ? opened.failure : undefined;

  type Namespace = MasterKeyFile.StoreNamespace;
  const TOP: Namespace = MasterKeyFile.STORE_NAMESPACES[0];
  const VAULT: Namespace = MasterKeyFile.VAULT_VALUES_NAMESPACE;
  const AI_ACCOUNTS: Namespace = MasterKeyFile.AI_ACCOUNT_CREDENTIALS_NAMESPACE;
  const dirOf = (ns: Namespace) =>
    ns.dir === "" ? serverConfig.secretsDir : path.join(serverConfig.secretsDir, ns.dir);
  const sealedPath = (name: string, ns: Namespace = TOP) =>
    path.join(dirOf(ns), `${name}${MasterKeyFile.SEALED_EXTENSION}`);
  const plainPath = (name: string, ns: Namespace = TOP) =>
    path.join(dirOf(ns), `${name}${MasterKeyFile.PLAIN_EXTENSION}`);
  /** Where this store writes `name`: sealed on a Hub, in clear on a joined machine. */
  const entryPath = (name: string) => (keyring === undefined ? plainPath(name) : sealedPath(name));

  const notReadable = (name: string, cause: string) =>
    new SecretStoreDecodeError({ resource: `secret ${name}`, cause });

  const isPresent = (name: string, file: string) =>
    fileSystem.stat(file).pipe(
      Effect.as(true),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(false)),
      Effect.mapError((cause) => new SecretStoreReadError({ resource: `secret ${name}`, cause })),
    );

  const readOptional = (name: string, file: string) =>
    fileSystem.readFile(file).pipe(
      Effect.map((bytes) => Option.some(Uint8Array.from(bytes))),
      Effect.catch((cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeedNone
          : Effect.fail(new SecretStoreReadError({ resource: `secret ${name}`, cause })),
      ),
    );

  const getSealed = Effect.fn("ServerSecretStore.getSealed")(function* (
    current: MasterKeyFile.Keyring,
    name: string,
    ns: Namespace = TOP,
  ) {
    const stored = yield* readOptional(name, sealedPath(name, ns));
    if (Option.isNone(stored)) {
      // Never accepted: an entry in clear after the startup was planted, or is from before it.
      if (yield* isPresent(name, plainPath(name, ns))) {
        return yield* notReadable(name, "stored in clear; restart the Hub to encrypt it");
      }
      return Option.none<Uint8Array>();
    }
    const opened = SecretCipher.open(current.keys, ns.purpose, name, stored.value);
    switch (opened._tag) {
      case "opened":
        return Option.some(opened.plaintext);
      case "unknown-key":
        return yield* notReadable(name, `sealed by another master key (id ${opened.keyId})`);
      case "unknown-format":
        return yield* notReadable(name, "of a format this version cannot read");
      case "rejected":
        return yield* notReadable(name, "altered, or moved from another name");
    }
  });

  const getPlain = Effect.fn("ServerSecretStore.getPlain")(function* (name: string) {
    // Sealed bytes are never a value: without the key that sealed them, nothing comes back.
    if (yield* isPresent(name, sealedPath(name))) {
      return yield* notReadable(name, "sealed with a master key this machine no longer has");
    }
    return yield* readOptional(name, plainPath(name));
  });

  /** Every operation fails, saying why, while the store could not be opened beside a server. */
  const whenOpen = <A, E>(
    name: string,
    effect: Effect.Effect<A, E>,
  ): Effect.Effect<A, E | SecretStoreReadError> =>
    unavailable === undefined
      ? effect
      : Effect.fail(new SecretStoreReadError({ resource: `secret ${name}`, cause: unavailable }));

  /** A name is one file of the store's own folder: never a path into another namespace. */
  const validName = (name: string) =>
    /^[^/\\]+$/u.test(name) && name !== "." && name !== ".."
      ? Effect.void
      : Effect.fail(notReadable(name.slice(0, 40), "not a secret's name"));
  const named = <A, E>(name: string, effect: Effect.Effect<A, E>) =>
    Effect.andThen(validName(name), effect);

  const get: ServerSecretStore["Service"]["get"] = (name) =>
    named(
      name,
      whenOpen(name, keyring === undefined ? getPlain(name) : getSealed(keyring, name)),
    ).pipe(Effect.withSpan("ServerSecretStore.get"));

  const sealFor = (name: string, value: Uint8Array, ns: Namespace = TOP) =>
    keyring === undefined ? value : SecretCipher.seal(keyring.current, ns.purpose, name, value);

  const withFiles = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  const set: ServerSecretStore["Service"]["set"] = (name, value) =>
    named(
      name,
      whenOpen(name, withFiles(writeAtomically(entryPath(name), sealFor(name, value)))),
    ).pipe(
      Effect.mapError(
        (cause) => new SecretStorePersistError({ resource: `secret ${name}`, cause }),
      ),
      Effect.withSpan("ServerSecretStore.set"),
    );

  // `link` publishes the fully written temp file under the final name, or fails with
  // AlreadyExists, so a concurrent reader never observes a partially written secret.
  const create: ServerSecretStore["Service"]["create"] = (name, value) =>
    named(
      name,
      whenOpen(name, withFiles(createExclusively(entryPath(name), sealFor(name, value)))),
    ).pipe(
      Effect.mapError(
        (cause) => new SecretStorePersistError({ resource: `secret ${name}`, cause }),
      ),
      Effect.withSpan("ServerSecretStore.create"),
    );

  const getOrCreateRandom: ServerSecretStore["Service"]["getOrCreateRandom"] = (name, bytes) =>
    get(name).pipe(
      Effect.flatMap(
        Option.match({
          onSome: Effect.succeed,
          onNone: () =>
            crypto.randomBytes(bytes).pipe(
              Effect.mapError(
                (cause) =>
                  new SecretStoreRandomGenerationError({
                    resource: `secret ${name}`,
                    cause,
                  }),
              ),
              Effect.flatMap((generated) =>
                create(name, generated).pipe(
                  Effect.as(Uint8Array.from(generated)),
                  Effect.catchIf(isSecretStoreError, (error) =>
                    isSecretAlreadyExistsError(error)
                      ? get(name).pipe(
                          Effect.flatMap(
                            Option.match({
                              onSome: Effect.succeed,
                              onNone: () =>
                                Effect.fail(
                                  new SecretStoreConcurrentReadError({
                                    resource: `secret ${name}`,
                                  }),
                                ),
                            }),
                          ),
                        )
                      : Effect.fail(error),
                  ),
                ),
              ),
            ),
        }),
      ),
      Effect.withSpan("ServerSecretStore.getOrCreateRandom"),
    );

  const removeFile = (name: string, file: string) =>
    fileSystem
      .remove(file)
      .pipe(
        Effect.catch((cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.void
            : Effect.fail(new SecretStoreRemoveError({ resource: `secret ${name}`, cause })),
        ),
      );

  const remove: ServerSecretStore["Service"]["remove"] = (name) =>
    named(name, whenOpen(name, removeFile(name, sealedPath(name)))).pipe(
      Effect.andThen(removeFile(name, plainPath(name))),
      Effect.withSpan("ServerSecretStore.remove"),
    );

  /**
   * A store folder of its own (Vault values, AI accounts' credentials): only ever sealed, so
   * without a key (a joined machine) every operation fails rather than keep a value in clear.
   */
  const sealedOnly = (ns: Namespace, label: string, why: string) => {
    const sealedKeyring = (id: string) =>
      keyring === undefined
        ? Effect.fail(new SecretStorePersistError({ resource: `${label} ${id}`, cause: why }))
        : Effect.succeed(keyring);
    return {
      get: (id: string) =>
        named(
          id,
          whenOpen(
            id,
            Effect.flatMap(sealedKeyring(id), (current) => getSealed(current, id, ns)),
          ),
        ),
      set: (id: string, value: Uint8Array) =>
        named(
          id,
          whenOpen(
            id,
            Effect.flatMap(sealedKeyring(id), () =>
              fileSystem.makeDirectory(dirOf(ns), { recursive: true, mode: 0o700 }).pipe(
                Effect.andThen(
                  withFiles(writeAtomically(sealedPath(id, ns), sealFor(id, value, ns))),
                ),
                Effect.mapError(
                  (cause) => new SecretStorePersistError({ resource: `${label} ${id}`, cause }),
                ),
              ),
            ),
          ),
        ),
      remove: (id: string) =>
        named(id, whenOpen(id, removeFile(id, sealedPath(id, ns)))).pipe(
          Effect.andThen(removeFile(id, plainPath(id, ns))),
        ),
      list: fileSystem.readDirectory(dirOf(ns)).pipe(
        Effect.map((names) =>
          names.flatMap((file) => {
            for (const extension of [
              MasterKeyFile.SEALED_EXTENSION,
              MasterKeyFile.PLAIN_EXTENSION,
            ]) {
              if (file.endsWith(extension) && file.length > extension.length) {
                return [file.slice(0, -extension.length)];
              }
            }
            return [];
          }),
        ),
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])),
        Effect.mapError((cause) => new SecretStoreReadError({ resource: `${label}s`, cause })),
      ),
    };
  };
  const vaultStore = sealedOnly(
    VAULT,
    "vault value",
    "Vault values are kept only on a Hub, sealed with its master key.",
  );
  const vaultValues = VaultValueStore.of({
    get: Effect.fn("VaultValueStore.get")(vaultStore.get),
    set: Effect.fn("VaultValueStore.set")(vaultStore.set),
    remove: Effect.fn("VaultValueStore.remove")(vaultStore.remove),
    list: vaultStore.list,
  });
  const aiAccountStore = sealedOnly(
    AI_ACCOUNTS,
    "AI account credential",
    "AI accounts' credentials are kept only on a Hub, sealed with its master key.",
  );
  const aiAccountCredentials = AiAccountCredentialStore.of({
    get: Effect.fn("AiAccountCredentialStore.get")(aiAccountStore.get),
    set: Effect.fn("AiAccountCredentialStore.set")(aiAccountStore.set),
    remove: Effect.fn("AiAccountCredentialStore.remove")(aiAccountStore.remove),
    list: aiAccountStore.list,
  });
  const aiTokenStore = sealedOnly(
    MasterKeyFile.AI_ACCOUNT_TOKENS_NAMESPACE,
    "AI account token",
    "AI accounts' tokens are kept only on a Hub, sealed with its master key.",
  );
  const aiAccountTokens = AiAccountTokenStore.of({
    get: Effect.fn("AiAccountTokenStore.get")(aiTokenStore.get),
    set: Effect.fn("AiAccountTokenStore.set")(aiTokenStore.set),
    remove: Effect.fn("AiAccountTokenStore.remove")(aiTokenStore.remove),
    list: aiTokenStore.list,
  });
  const deliveredStore = sealedOnly(
    MasterKeyFile.DELIVERED_VALUES_NAMESPACE,
    "delivered value",
    "Values read from Secret providers are kept only on a Hub, sealed with its master key.",
  );
  const deliveredValues = DeliveredValueStore.of({
    get: Effect.fn("DeliveredValueStore.get")(deliveredStore.get),
    set: Effect.fn("DeliveredValueStore.set")(deliveredStore.set),
    remove: Effect.fn("DeliveredValueStore.remove")(deliveredStore.remove),
    list: deliveredStore.list,
  });

  return Context.make(
    ServerSecretStore,
    ServerSecretStore.of({
      directory: serverConfig.secretsDir,
      get,
      set,
      create,
      getOrCreateRandom,
      remove,
    }),
  ).pipe(
    Context.add(VaultValueStore, vaultValues),
    Context.add(AiAccountCredentialStore, aiAccountCredentials),
    Context.add(AiAccountTokenStore, aiAccountTokens),
    Context.add(DeliveredValueStore, deliveredValues),
    Context.add(
      MasterKeyring,
      MasterKeyring.of({
        keyring: Option.fromUndefinedOr(keyring),
        unavailable: Option.fromUndefinedOr(unavailable),
      }),
    ),
  );
});

/** @public */
export const make = Effect.map(makeWith("owner"), Context.get(ServerSecretStore));

/** The Hub's store; the Hub holds the server's ownership lock (server.ts). */
export const layer = Layer.effectContext(makeWith("owner"));

/** A command beside the Hub (`t3 ...`): opens read-only while a Hub runs. */
export const layerClient = Layer.effectContext(makeWith("client"));

/** `t3 join`: the credential is kept as the joined machine will keep it (see `makeWith`). */
export const layerJoinedMachine = Layer.effectContext(makeWith("joined"));
