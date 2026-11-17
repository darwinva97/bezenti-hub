// Answers stay in the secret store behind one-use refs; orchestration records only request status.
// Consuming tools keep values out of transcripts, projections, clients and model context.
// A `file` request instead moves its value to an owner-only file in memory for the agent's shell.
// A secret the user pasted in chat goes straight to such a file, with no card.
import {
  CommandId,
  SECRET_MASK_MIN_LENGTH,
  SecretRef,
  SecretRequestError,
  type ProjectId,
  type SecretRequestAnswerInput,
  type SecretRequestVaultTargets,
  type ThreadId,
  type VaultError,
} from "@t3tools/contracts";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Mac from "effect/crypto/Mac";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as Metrics from "../observability/Metrics.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { writeAtomically } from "../auth/atomicFile.ts";
import { SEALED_EXTENSION } from "../auth/MasterKeyFile.ts";
import * as SecretCipher from "../auth/SecretCipher.ts";
import * as Vaults from "../vaults/Vaults.ts";
import { resolveSecretFilesDirectory } from "./SecretFilesDirectory.ts";

const SECRET_REF_PREFIX = "secret-ref:";
const storeName = (ref: SecretRef) => `secret-request-${ref.slice(SECRET_REF_PREFIX.length)}`;
const REF_PATTERN = /^secret-ref:[0-9a-f]{32}$/;
const SECRET_REF_TTL_MS = 24 * 60 * 60 * 1000;
const STORE_NAME_PATTERN = /^(secret-request-(?:vault-)?[0-9a-f]{32})\.(bin|sealed)$/;
/** What this card already wrote to a Vault: a keyed digest of its Vault, name and value. */
const vaultMarkerName = (ref: SecretRef) =>
  `secret-request-vault-${ref.slice(SECRET_REF_PREFIX.length)}`;
const FILE_NAME_PATTERN = /^[0-9a-f]{32}(\.partial)?$/;
const SEALED_FILE_PATTERN = /^[0-9a-f]{32}\.sealed$/;

const StoredSecret = Schema.fromJsonString(
  Schema.Struct({ projectId: Schema.String, value: Schema.String, savedAt: Schema.Number }),
);
const encodeStored = Schema.encodeEffect(StoredSecret);
const decodeStored = Schema.decodeUnknownOption(StoredSecret);

export class SecretRequests extends Context.Service<
  SecretRequests,
  {
    readonly answer: (input: SecretRequestAnswerInput) => Effect.Effect<void, SecretRequestError>;
    /**
     * `secrets.vaultTargets`: the Vaults the caller, who may answer the Thread's cards, may also
     * save an answer in (Vaults.saveTargets). Empty for whoever may not edit any of them.
     */
    readonly vaultTargets: (input: {
      readonly threadId: ThreadId;
    }) => Effect.Effect<SecretRequestVaultTargets, SecretRequestError>;
    readonly savedRef: (input: {
      readonly threadId: ThreadId;
      readonly turnItemId: string;
    }) => Effect.Effect<Option.Option<SecretRef>>;
    readonly consume: (input: {
      readonly ref: SecretRef;
      readonly projectId: ProjectId;
    }) => Effect.Effect<string, SecretRequestError>;
    /** Moves a saved `file` request's value to an owner-only file and returns its path. */
    readonly saveToFile: (input: {
      readonly threadId: ThreadId;
      readonly turnItemId: string;
    }) => Effect.Effect<string, SecretRequestError>;
    /** Writes a secret the user pasted in chat to an owner-only file and returns its path. */
    readonly savePasted: (input: {
      readonly threadId: ThreadId;
      /** The provider session's namespace, so two sessions' keys never share a file. */
      readonly requestNamespace: string;
      readonly requestKey: string;
      readonly value: string;
    }) => Effect.Effect<string, SecretRequestError>;
  }
>()("t3/secrets/SecretRequests") {}

const make = Effect.gen(function* () {
  const store = yield* ServerSecretStore.ServerSecretStore;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  // Where the agent's shell reads an answer: in memory, else (macOS, Windows) on the disk.
  const filesFolder =
    store.directory === undefined
      ? undefined
      : Option.getOrUndefined(yield* resolveSecretFilesDirectory(store.directory));
  const filesDir = filesFolder?.directory;
  if (filesFolder !== undefined && !filesFolder.inMemory) {
    yield* Effect.logWarning(
      "request_secret file answers are written to the disk on this platform (no folder in memory); each is removed when it expires and at every start.",
      { directory: filesFolder.directory },
    );
  }
  const noFilesDir = new SecretRequestError({
    reason: store.directory === undefined ? "store_failed" : "file_delivery_unavailable",
  });

  const mac = yield* Mac.Mac;
  // Keyed by the salt's hex text, as refs saved by earlier versions were.
  const refKey = yield* Mac.key(
    Mac.hmacSha256,
    new TextEncoder().encode(
      Hex.encode(yield* store.getOrCreateRandom("secret-request-salt", 32).pipe(Effect.orDie)),
    ),
  ).pipe(Effect.orDie);
  const refFor = (threadId: ThreadId, turnItemId: string) =>
    mac.sign(refKey, new TextEncoder().encode(`${threadId}\u0000${turnItemId}`)).pipe(
      Effect.orDie,
      Effect.map((tag) => SecretRef.make(`${SECRET_REF_PREFIX}${Hex.encode(tag).slice(0, 32)}`)),
    );

  // Vaults live on the Hub; without them (a joined machine, a narrow test) nothing is a target.
  const vaults = yield* Effect.serviceOption(Vaults.Vaults);
  const mayAnswer = (threadId: ThreadId) =>
    threadManagement.authorizeThread(threadId, "thread.continue").pipe(
      Effect.mapError(
        (cause) =>
          new SecretRequestError({
            reason: cause._tag === "SpaceAccessDeniedError" ? "not_permitted" : "not_found",
            cause,
          }),
      ),
    );
  const targetsOf = (threadId: ThreadId) =>
    Option.isNone(vaults)
      ? Effect.succeed([])
      : vaults.value
          .saveTargets({ threadId })
          .pipe(
            Effect.mapError(
              (cause) => new SecretRequestError({ reason: "vault_save_failed", cause }),
            ),
          );

  const vaultTargets: SecretRequests["Service"]["vaultTargets"] = Effect.fn(
    "SecretRequests.vaultTargets",
  )(function* (input) {
    yield* mayAnswer(input.threadId);
    const targets = yield* targetsOf(input.threadId);
    return {
      vaults: targets.map((vault) => ({
        id: vault.id,
        name: vault.name,
        ownerName: vault.ownerName,
      })),
    };
  });

  const vaultFailure = (cause: VaultError) =>
    new SecretRequestError({
      reason:
        cause.reason === "duplicate-name"
          ? "vault_name_taken"
          : cause.reason === "invalid-name" ||
              cause.reason === "reserved-name" ||
              cause.reason === "dangerous-name" ||
              cause.reason === "confirm-dangerous"
            ? "vault_name_invalid"
            : cause.reason === "forbidden" || cause.reason === "not-found"
              ? "vault_not_permitted"
              : "vault_save_failed",
      cause,
    });

  /** A keyed digest of what this card saves to a Vault, so a retry can tell its own entry. */
  const vaultMarkerOf = (
    threadId: ThreadId,
    turnItemId: string,
    target: { readonly vaultId: string; readonly name: string },
    value: string,
  ) =>
    mac
      .sign(
        refKey,
        new TextEncoder().encode(
          ["vault", threadId, turnItemId, target.vaultId, target.name, value].join("\u0000"),
        ),
      )
      .pipe(Effect.orDie, Effect.map(Hex.encode));

  // One answer at a time: a second answer to a card waits, then finds it answered.
  const answerLock = yield* Semaphore.make(1);

  const answerOnce = Effect.fn("SecretRequests.answer")(function* (
    input: SecretRequestAnswerInput,
  ) {
    yield* Effect.annotateCurrentSpan({
      "orchestration_v2.thread_id": input.threadId,
      "secret_request.answer": input.answer.type,
      "secret_request.save_to_vault":
        input.answer.type === "save" && input.answer.saveToVault !== undefined,
    });
    // Before anything is stored: a refused answer must not write, or clear, the Thread's secret.
    yield* mayAnswer(input.threadId);
    const records = yield* threadManagement
      .getThreadRecords(input.threadId, ["runs", "turnItems"], {
        turnItemTypes: ["secret_request"],
        messageRoles: [],
      })
      .pipe(Effect.mapError((cause) => new SecretRequestError({ reason: "load_failed", cause })));
    const item = records.turnItems.find((candidate) => candidate.id === input.turnItemId);
    if (item?.type !== "secret_request" || item.runId === null || item.nodeId === null) {
      return yield* new SecretRequestError({ reason: "not_found" });
    }
    if (item.secretStatus !== "pending") {
      return yield* new SecretRequestError({ reason: "already_answered" });
    }
    const run = records.runs.find((candidate) => candidate.id === item.runId);
    if (run === undefined || ThreadManagementService.isTerminalRunStatus(run.status)) {
      return yield* new SecretRequestError({ reason: "agent_stopped" });
    }
    // «Also save to Vault»: only a Vault the one rule offers for this Thread, then as the caller
    // through Vaults (policy, names, audit `secret.edit` again). Before the one-use ref: a refused
    // save stores nothing and leaves the card pending.
    if (input.answer.type === "save" && input.answer.saveToVault !== undefined) {
      const target = input.answer.saveToVault;
      const targets = yield* targetsOf(input.threadId);
      if (Option.isNone(vaults) || !targets.some((vault) => vault.id === target.vaultId)) {
        return yield* new SecretRequestError({ reason: "vault_not_permitted" });
      }
      // A short value would reach the Space's Threads but never be masked: not from a card.
      if ([...input.answer.secret].length < SECRET_MASK_MIN_LENGTH) {
        return yield* new SecretRequestError({ reason: "vault_value_short" });
      }
      const ref = yield* refFor(input.threadId, item.id);
      const marker = yield* vaultMarkerOf(input.threadId, item.id, target, input.answer.secret);
      const savedBefore = yield* store.get(vaultMarkerName(ref)).pipe(
        Effect.map((stored) =>
          Option.exists(
            Option.flatMap(stored, (bytes) => decodeStored(new TextDecoder().decode(bytes))),
            (decoded) => decoded.value === marker,
          ),
        ),
        Effect.orElseSucceed(() => false),
      );
      yield* vaults.value
        .putEntry({
          vaultId: target.vaultId,
          name: target.name,
          description: item.label,
          value: Redacted.make(input.answer.secret),
        })
        .pipe(
          // A retry of this same answer after a later step failed: the entry is this card's.
          Effect.catchIf(
            (error) => error.reason === "duplicate-name" && savedBefore,
            () => Effect.void,
          ),
          Effect.mapError(vaultFailure),
        );
      if (!savedBefore) {
        const encodedMarker = yield* encodeStored({
          projectId: records.thread.projectId,
          value: marker,
          savedAt: yield* Clock.currentTimeMillis,
        }).pipe(Effect.orDie);
        yield* store
          .set(vaultMarkerName(ref), new TextEncoder().encode(encodedMarker))
          .pipe(Effect.ignore);
      }
    }
    // Create before recording so racing answers cannot overwrite values or show saved before storage.
    // Existing values on pending cards finish earlier saves whose recording failed.
    if (input.answer.type === "save") {
      const encoded = yield* encodeStored({
        projectId: records.thread.projectId,
        value: input.answer.secret,
        savedAt: yield* Clock.currentTimeMillis,
      }).pipe(Effect.orDie);
      yield* store
        .create(
          storeName(yield* refFor(input.threadId, item.id)),
          new TextEncoder().encode(encoded),
        )
        .pipe(
          Effect.catchIf(ServerSecretStore.isSecretAlreadyExistsError, () => Effect.void),
          Effect.mapError(
            (error) => new SecretRequestError({ reason: "store_failed", cause: error }),
          ),
        );
    }
    const secretStatus = input.answer.type === "save" ? "saved" : "declined";
    yield* threadManagement
      .dispatch({
        type: "secret_request.record",
        commandId: CommandId.make(`secret-request:${item.id}:${secretStatus}`),
        threadId: input.threadId,
        runId: item.runId,
        nodeId: item.nodeId,
        turnItemId: item.id,
        label: item.label,
        reason: item.reason,
        ...(item.placeholder === undefined ? {} : { placeholder: item.placeholder }),
        ...(item.delivery === undefined ? {} : { delivery: item.delivery }),
        ...(item.secretName === undefined ? {} : { secretName: item.secretName }),
        secretStatus,
      })
      .pipe(
        Effect.mapError((cause) => new SecretRequestError({ reason: "record_failed", cause })),
        // Clear failed saves so the pending card can be answered again.
        Effect.tapError(() =>
          input.answer.type === "save"
            ? refFor(input.threadId, item.id).pipe(
                Effect.flatMap((ref) => removeLogged(storeName(ref))),
              )
            : Effect.void,
        ),
      );
    if (input.answer.type !== "save") return;
    // The wait may have closed the card; delete unrecorded answers because no one receives their refs.
    const recorded = yield* threadManagement
      .getThreadRecords(input.threadId, ["turnItems"], {
        turnItemTypes: ["secret_request"],
        messageRoles: [],
      })
      .pipe(Effect.mapError((cause) => new SecretRequestError({ reason: "record_failed", cause })));
    const card = recorded.turnItems.find((candidate) => candidate.id === item.id);
    if (card?.type === "secret_request" && card.secretStatus !== "saved") {
      yield* removeLogged(storeName(yield* refFor(input.threadId, item.id)));
      return yield* new SecretRequestError({ reason: "agent_stopped" });
    }
  });

  const answer: SecretRequests["Service"]["answer"] = (input) =>
    answerOnce(input).pipe(answerLock.withPermits(1));

  const savedRef: SecretRequests["Service"]["savedRef"] = Effect.fn("SecretRequests.savedRef")(
    function* (input) {
      const ref = yield* refFor(input.threadId, input.turnItemId);
      const stored = yield* store.get(storeName(ref)).pipe(Effect.orElseSucceed(Option.none));
      return Option.map(stored, () => ref);
    },
  );

  const removeLogged = (name: string) =>
    store.remove(name).pipe(
      Effect.as(true),
      Effect.catch((error) =>
        Effect.logWarning("Could not delete a secret request value", {
          errorTag: error._tag,
        }).pipe(Effect.as(false)),
      ),
    );

  // Serialize get/remove so concurrent consumers cannot read the same one-use ref.
  const consumeLock = yield* Semaphore.make(1);
  const consume: SecretRequests["Service"]["consume"] = (input) =>
    consumeRef(input).pipe(
      consumeLock.withPermits(1),
      Effect.tap(() => Metrics.increment(Metrics.secretRefsConsumedTotal, { result: "used" })),
      Effect.tapError(() =>
        Metrics.increment(Metrics.secretRefsConsumedTotal, { result: "rejected" }),
      ),
      Effect.withSpan("SecretRequests.consume"),
    );

  /** A live ref's value, left in the store. */
  const readRef = Effect.fn("SecretRequests.readRef")(function* (input: {
    readonly ref: SecretRef;
    readonly projectId: ProjectId;
  }) {
    if (!REF_PATTERN.test(input.ref))
      return yield* new SecretRequestError({ reason: "invalid_ref" });
    const stored = yield* store
      .get(storeName(input.ref))
      .pipe(Effect.mapError((cause) => new SecretRequestError({ reason: "read_failed", cause })));
    const decoded = Option.flatMap(stored, (bytes) =>
      decodeStored(new TextDecoder().decode(bytes)),
    );
    if (Option.isNone(decoded) || decoded.value.projectId !== input.projectId) {
      return yield* new SecretRequestError({ reason: "ref_unavailable" });
    }
    if ((yield* Clock.currentTimeMillis) - decoded.value.savedAt > SECRET_REF_TTL_MS) {
      yield* removeLogged(storeName(input.ref));
      return yield* new SecretRequestError({ reason: "ref_expired" });
    }
    return decoded.value.value;
  });

  const consumeRef = Effect.fn("SecretRequests.consumeRef")(function* (input: {
    readonly ref: SecretRef;
    readonly projectId: ProjectId;
  }) {
    const value = yield* readRef(input);
    // One use: the value moves into whatever consumed it. If it cannot be
    // deleted, it is not handed out, so a ref is never used twice.
    if (!(yield* removeLogged(storeName(input.ref)))) {
      return yield* new SecretRequestError({ reason: "consume_failed" });
    }
    return value;
  });

  const writeSecretFile = (dir: string, file: string, value: string) => {
    const partial = `${file}.partial`;
    return fileSystem.makeDirectory(dir, { recursive: true, mode: 0o700 }).pipe(
      Effect.andThen(fileSystem.chmod(dir, 0o700)),
      Effect.andThen(fileSystem.remove(partial, { force: true })),
      // `wx` never follows or replaces an existing path.
      Effect.andThen(
        fileSystem.writeFile(partial, new TextEncoder().encode(value), {
          flag: "wx",
          mode: 0o600,
        }),
      ),
      Effect.andThen(fileSystem.rename(partial, file)),
      Effect.mapError((cause) => new SecretRequestError({ reason: "store_failed", cause })),
    );
  };

  // The copy at rest, sealed under its own purpose beside the store: it outlives a restart (the
  // folder in memory does not) and is never on the disk in clear. None on a store without a key.
  const keyring = Option.flatMap(
    yield* Effect.serviceOption(ServerSecretStore.MasterKeyring),
    (opened) => opened.keyring,
  );
  const sealedDir = store.directory === undefined ? undefined : path.join(store.directory, "files");
  const sealedFileOf = (dir: string, id: string) => path.join(dir, `${id}${SEALED_EXTENSION}`);
  const withFiles = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  const keepSealed = Effect.fn("SecretRequests.keepSealed")(
    function* (id: string, value: string, times?: { readonly atime: Date; readonly mtime: Date }) {
      if (Option.isNone(keyring) || sealedDir === undefined) return;
      yield* fileSystem.makeDirectory(sealedDir, { recursive: true, mode: 0o700 });
      yield* fileSystem.chmod(sealedDir, 0o700);
      yield* withFiles(
        writeAtomically(
          sealedFileOf(sealedDir, id),
          SecretCipher.seal(
            keyring.value.current,
            "secret-file",
            id,
            new TextEncoder().encode(value),
          ),
          times,
        ),
      );
    },
    Effect.mapError((cause) => new SecretRequestError({ reason: "store_failed", cause })),
  );

  const readSealed = Effect.fn("SecretRequests.readSealed")(function* (id: string) {
    if (Option.isNone(keyring) || sealedDir === undefined) return Option.none<string>();
    const stored = yield* fileSystem.readFile(sealedFileOf(sealedDir, id)).pipe(
      Effect.asSome,
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
      Effect.mapError((cause) => new SecretRequestError({ reason: "read_failed", cause })),
    );
    if (Option.isNone(stored)) return Option.none<string>();
    const opened = SecretCipher.open(keyring.value.keys, "secret-file", id, stored.value);
    if (opened._tag !== "opened") {
      return yield* new SecretRequestError({ reason: "read_failed", cause: opened._tag });
    }
    return Option.some(new TextDecoder().decode(opened.plaintext));
  });

  /** The file the agent reads: kept sealed at rest, written in clear only to the folder in memory. */
  const deliver = Effect.fn("SecretRequests.deliver")(function* (
    dir: string,
    id: string,
    value: Effect.Effect<string, SecretRequestError>,
  ) {
    const file = path.join(dir, id);
    if (yield* fileSystem.exists(file).pipe(Effect.orElseSucceed(() => false))) return file;
    const kept = yield* readSealed(id);
    if (Option.isSome(kept)) {
      // After a restart the folder in memory is empty: the sealed copy brings the same value back.
      yield* writeSecretFile(dir, file, kept.value);
      return file;
    }
    const fresh = yield* value;
    yield* keepSealed(id, fresh);
    yield* writeSecretFile(dir, file, fresh);
    return file;
  });

  const saveToFile: SecretRequests["Service"]["saveToFile"] = Effect.fn(
    "SecretRequests.saveToFile",
  )(function* (input) {
    const records = yield* threadManagement
      .getThreadRecords(input.threadId, ["turnItems"], {
        turnItemTypes: ["secret_request"],
        messageRoles: [],
      })
      .pipe(Effect.mapError((cause) => new SecretRequestError({ reason: "load_failed", cause })));
    const item = records.turnItems.find((candidate) => candidate.id === input.turnItemId);
    // Only a card that told the user the agent's commands can read the value may write it out.
    if (
      item?.type !== "secret_request" ||
      item.secretStatus !== "saved" ||
      item.delivery !== "file"
    ) {
      return yield* new SecretRequestError({ reason: "not_a_file_request" });
    }
    if (filesDir === undefined) return yield* noFilesDir;
    const ref = yield* refFor(input.threadId, item.id);
    return yield* Effect.gen(function* () {
      // The stored value goes only after the file is complete, so a failed write can retry. One
      // use: the file counts as delivered only once the stored copy is gone; a retry with the
      // same clientRequestId gets the same file and finishes that removal.
      const file = yield* deliver(
        filesDir,
        ref.slice(SECRET_REF_PREFIX.length),
        readRef({ ref, projectId: records.thread.projectId }),
      );
      if (!(yield* removeLogged(storeName(ref)))) {
        return yield* new SecretRequestError({ reason: "consume_failed" });
      }
      return file;
    }).pipe(consumeLock.withPermits(1));
  });

  const savePasted: SecretRequests["Service"]["savePasted"] = Effect.fn(
    "SecretRequests.savePasted",
  )(function* (input) {
    if (filesDir === undefined) return yield* noFilesDir;
    const ref = yield* refFor(
      input.threadId,
      `pasted\u0000${input.requestNamespace}\u0000${input.requestKey}`,
    );
    // A retry with the same clientRequestId gets the file the first call wrote, unchanged, so a
    // command already holding that path never reads another value.
    return yield* deliver(
      filesDir,
      ref.slice(SECRET_REF_PREFIX.length),
      Effect.succeed(input.value),
    ).pipe(consumeLock.withPermits(1));
  });

  const sweepExpired = Effect.gen(function* () {
    if (store.directory === undefined) return;
    const now = yield* Clock.currentTimeMillis;
    const names = (yield* fileSystem.readDirectory(store.directory)).flatMap((file) => {
      const match = STORE_NAME_PATTERN.exec(file);
      return match?.[1] === undefined ? [] : [match[1]];
    });
    let removed = 0;
    for (const name of names) {
      const stored = yield* store.get(name).pipe(Effect.orElseSucceed(Option.none));
      const decoded = Option.flatMap(stored, (bytes) =>
        decodeStored(new TextDecoder().decode(bytes)),
      );
      if (Option.isSome(decoded) && now - decoded.value.savedAt <= SECRET_REF_TTL_MS) continue;
      if (yield* removeLogged(name)) removed += 1;
    }
    yield* Effect.annotateCurrentSpan({ "secret_request.expired_removed": removed });
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Could not sweep expired secret refs", cause)),
    Effect.withSpan("SecretRequests.sweepExpired"),
  );
  /** Answers past their TTL go: the sealed copies and the files in memory. */
  const sweepExpiredFiles = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const expired = (file: string) =>
      fileSystem
        .stat(file)
        .pipe(
          Effect.map(({ mtime }) =>
            Option.exists(mtime, (time) => now - time.getTime() > SECRET_REF_TTL_MS),
          ),
        );
    let removed = 0;
    if (sealedDir !== undefined && sealedDir !== filesDir) {
      const sealedNames = yield* fileSystem
        .readDirectory(sealedDir)
        .pipe(Effect.orElseSucceed(() => []));
      for (const name of sealedNames) {
        if (!SEALED_FILE_PATTERN.test(name)) continue;
        const file = path.join(sealedDir, name);
        if (!(yield* expired(file))) continue;
        yield* fileSystem.remove(file);
        if (filesDir !== undefined) {
          yield* fileSystem.remove(path.join(filesDir, name.slice(0, -SEALED_EXTENSION.length)), {
            force: true,
          });
        }
        removed += 1;
      }
    }
    if (filesDir !== undefined && (yield* fileSystem.exists(filesDir))) {
      for (const name of yield* fileSystem.readDirectory(filesDir)) {
        if (!FILE_NAME_PATTERN.test(name)) continue;
        const file = path.join(filesDir, name);
        if (!(yield* expired(file))) continue;
        yield* fileSystem.remove(file);
        removed += 1;
      }
    }
    yield* Effect.annotateCurrentSpan({ "secret_request.expired_files_removed": removed });
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Could not sweep expired secret files", cause)),
    Effect.withSpan("SecretRequests.sweepExpiredFiles"),
  );

  // At startup no stale plaintext stays where the agent reads answers: on the disk, none at all
  // (each comes back from its sealed copy on demand); in memory, half-written files and answers
  // whose sealed copy is gone.
  const cleanFilesAtStart = Effect.gen(function* () {
    if (filesDir === undefined || filesDir === sealedDir) return;
    if (!(yield* fileSystem.exists(filesDir))) return;
    let removed = 0;
    for (const name of yield* fileSystem.readDirectory(filesDir)) {
      const stale =
        filesFolder?.inMemory !== true ||
        name.endsWith(".partial") ||
        sealedDir === undefined ||
        !(yield* fileSystem.exists(sealedFileOf(sealedDir, name)));
      if (!stale) continue;
      yield* fileSystem.remove(path.join(filesDir, name), { recursive: true });
      removed += 1;
    }
    yield* Effect.annotateCurrentSpan({ "secret_request.stale_files_removed": removed });
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Could not clean the secret files", cause)),
    Effect.withSpan("SecretRequests.cleanFilesAtStart"),
  );

  // Answers that versions before encryption wrote to `secrets/files/` in clear: each sealed in
  // place (keeping its age) while it lasts, then its clear copy goes. One that cannot be read (a
  // dangling symlink, no permission) is logged and removed; it never stops the others.
  const sealLegacyFile = Effect.fn("SecretRequests.sealLegacyFile")(function* (
    dir: string,
    name: string,
    now: number,
  ) {
    const file = path.join(dir, name);
    const { mtime } = yield* fileSystem.stat(file);
    const live =
      !name.endsWith(".partial") &&
      Option.exists(mtime, (time) => now - time.getTime() <= SECRET_REF_TTL_MS);
    if (live) {
      const value = yield* fileSystem.readFileString(file);
      if (Option.isSome(keyring)) {
        yield* keepSealed(
          name,
          value,
          Option.getOrUndefined(Option.map(mtime, (time) => ({ atime: time, mtime: time }))),
        );
      } else if (filesDir !== undefined && filesDir !== dir) {
        yield* writeSecretFile(filesDir, path.join(filesDir, name), value);
      }
    }
    return live;
  });
  const sealLegacyFiles = Effect.gen(function* () {
    if (sealedDir === undefined || sealedDir === filesDir) return;
    const names = yield* fileSystem.readDirectory(sealedDir).pipe(Effect.orElseSucceed(() => []));
    const now = yield* Clock.currentTimeMillis;
    let sealed = 0;
    for (const name of names) {
      if (!FILE_NAME_PATTERN.test(name)) continue;
      const kept = yield* sealLegacyFile(sealedDir, name, now).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not seal a secret file left in clear; removing it", {
            file: name,
            cause,
          }).pipe(Effect.as(false)),
        ),
      );
      if (kept) sealed += 1;
      // Sealed or not, the clear copy never stays.
      yield* fileSystem.remove(path.join(sealedDir, name), { recursive: true }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not remove a secret file left in clear", {
            file: name,
            cause,
          }),
        ),
      );
    }
    yield* Effect.annotateCurrentSpan({ "secret_request.legacy_files_sealed": sealed });
  }).pipe(Effect.withSpan("SecretRequests.sealLegacyFiles"));
  yield* sealLegacyFiles;
  yield* cleanFilesAtStart;
  const sweep = Effect.andThen(sweepExpired, sweepExpiredFiles);
  yield* sweep;
  yield* sweep.pipe(
    Effect.delay("1 hour"),
    Effect.repeat(Schedule.spaced("1 hour")),
    Effect.forkScoped,
  );

  return SecretRequests.of({ answer, vaultTargets, savedRef, consume, saveToFile, savePasted });
});

export const layer = Layer.effect(SecretRequests, make);
