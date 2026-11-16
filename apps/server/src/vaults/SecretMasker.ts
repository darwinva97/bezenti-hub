/**
 * Spec 5 ticket 05: a Thread's secret values as `[NAME]` in what the Hub stores or shows: what its
 * processes received (`thread_secret_values`, for the Thread's life) and its owner's effective set.
 * Never another User's values, and never unmasked when the set cannot be read. See `MaskedPaths.ts`.
 */
import {
  EnvironmentAuthenticatedPrincipal,
  type ProjectId,
  type SpaceId,
  type ThreadId,
  UserId,
  type VaultError,
} from "@t3tools/contracts";
import {
  type MaskableSecret,
  makeSecretPatterns,
  maskDeep,
  maskError,
  rememberKnownSecrets,
  type SecretPatterns,
} from "@t3tools/shared/secretMasking";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { credentialIdOfValueId } from "../ai/aiCredentialValue.ts";
import { storeIdOfValueId } from "./deliveredValueId.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { McpInvocationContext } from "../mcp/McpInvocationContext.ts";
import * as EffectiveVaults from "./EffectiveVaults.ts";

/** A Thread's masker: the patterns, and the same applied to every string of a value. */
export interface ThreadMasker extends SecretPatterns {
  readonly maskDeep: <A>(value: A) => A;
  /** An error (its fields, message and cause), keeping its class. */
  readonly maskError: <E>(error: E) => E;
}

export const threadMaskerOf = (patterns: SecretPatterns): ThreadMasker => ({
  ...patterns,
  maskDeep: (value) => (patterns.isEmpty ? value : maskDeep(value, patterns.mask)),
  maskError: (error) => (patterns.isEmpty ? error : maskError(error, patterns.mask)),
});

const maskerOf = (secrets: ReadonlyArray<MaskableSecret>) =>
  threadMaskerOf(makeSecretPatterns(secrets));

/** A masker that masks nothing: text that no Thread's values can be in. */
const noSecrets: ThreadMasker = maskerOf([]);

/** A Thread's values could not be read: what would have been stored or sent is not. */
export class SecretMaskingError extends Schema.TaggedError<SecretMaskingError>()(
  "SecretMaskingError",
  { threadId: Schema.optional(Schema.String), cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return "Could not read this Thread's secrets to hide them, so this was not stored or shown. Try again.";
  }
}

/** A value a process of the Thread received, as SecretDelivery hands it out. */
export interface DeliveredSecret {
  readonly name: string;
  readonly value: string;
  readonly valueId: string;
}

/** A Thread whose creation is being written: where it will be, and whose it is. */
export interface ThreadPlacementHint {
  readonly ownerUserId: UserId | undefined;
  readonly spaceId: SpaceId | undefined;
  readonly projectId: ProjectId | null;
}

export class SecretMasker extends Context.Service<
  SecretMasker,
  {
    /**
     * The masker of a Thread (its root's: a child Thread's tools run in its root's process). A
     * Thread not written yet uses `hint` (its owner's set where it will be), else masks nothing:
     * no process of it ran. Fails rather than mask with too little.
     */
    readonly forThread: (
      threadId: ThreadId | string,
      hint?: ThreadPlacementHint,
    ) => Effect.Effect<ThreadMasker, SecretMaskingError>;
    /**
     * A User's own values, for what they read interactively (files, search, diffs, Git output,
     * change requests): every value their own Threads hold (their owners' sets and what their
     * processes received). Never another User's: a guess would come back as `[NAME]`.
     */
    readonly forUser: (userId: UserId) => Effect.Effect<ThreadMasker, SecretMaskingError>;
    /** `forUser` for the User the current request is made for; a call no User makes masks nothing. */
    readonly forViewer: Effect.Effect<ThreadMasker, SecretMaskingError>;
    /** Values handed to a process of the Thread: masked from now on, for the Thread's life. */
    readonly remember: (
      threadId: ThreadId,
      secrets: ReadonlyArray<DeliveredSecret>,
    ) => Effect.Effect<void>;
  }
>()("t3/vaults/SecretMasker") {}

/** How long a Thread's set is reused before its owner's effective set is read again. */
const MASKER_TTL_MS = 30_000;
const MAX_CACHED = 2048;
/** A failed load (a busy database) is tried again twice, after 25 and 50 ms, before it fails. */
const LOAD_RETRY = { times: 2, schedule: Schedule.exponential("25 millis") } as const;

interface Entry {
  readonly loadedAt: number;
  /** In precedence order: the effective set's winners first, then what was delivered before. */
  readonly secrets: ReadonlyArray<MaskableSecret>;
  readonly masker: ThreadMasker;
}

const entryOf = (loadedAt: number, secrets: ReadonlyArray<MaskableSecret>): Entry => {
  // This process's own logs and spans mask them too (never what a client sees).
  rememberKnownSecrets(secrets);
  return { loadedAt, secrets, masker: maskerOf(secrets) };
};

const union = (
  first: ReadonlyArray<MaskableSecret>,
  second: ReadonlyArray<MaskableSecret>,
): ReadonlyArray<MaskableSecret> => [
  ...first,
  ...second.filter((secret) => !first.some((s) => s.value === secret.value)),
];

const setBounded = <K, V>(map: Map<K, V>, key: K, value: V) => {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_CACHED) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
};

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const effective = yield* Effect.serviceOption(EffectiveVaults.EffectiveVaults);
  const values = yield* Effect.serviceOption(ServerSecretStore.VaultValueStore);
  const aiCredentials = yield* Effect.serviceOption(ServerSecretStore.AiAccountCredentialStore);
  const deliveredValues = yield* Effect.serviceOption(ServerSecretStore.DeliveredValueStore);
  const cache = new Map<string, Entry>();
  const roots = new Map<string, string>();
  // A value id names one value for good (a replace writes a new id): read once.
  const decrypted = new Map<string, string>();
  const loading = new Map<string, Deferred.Deferred<Entry | undefined, SecretMaskingError>>();

  const failed = (threadId: string | undefined) => (cause: unknown) =>
    new SecretMaskingError({ ...(threadId === undefined ? {} : { threadId }), cause });

  /** The Thread's root, or undefined while it is not projected (never cached then). */
  const rootOf = Effect.fnUntraced(function* (threadId: string) {
    const known = roots.get(threadId);
    if (known !== undefined) return known;
    const rows = yield* sql<{ readonly root: string | null }>`
      SELECT json_extract(payload_json, '$.lineage.rootThreadId') AS root
      FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
    `;
    if (rows.length === 0) return undefined;
    const root = rows[0]?.root ?? threadId;
    setBounded(roots, threadId, root);
    return root;
  });

  const readValue = Effect.fnUntraced(function* (valueId: string) {
    const known = decrypted.get(valueId);
    if (known !== undefined) return Option.some(known);
    // Spec 4 ticket 07: a direct AI account's credential a process of the Thread received.
    const credentialId = credentialIdOfValueId(valueId);
    if (credentialId !== undefined) {
      if (Option.isNone(aiCredentials)) return Option.none<string>();
      const bytes = yield* aiCredentials.value.get(credentialId);
      if (Option.isNone(bytes)) return Option.none<string>();
      const value = new TextDecoder().decode(bytes.value);
      setBounded(decrypted, valueId, value);
      return Option.some(value);
    }
    // Ticket 02: a value read from a Secret provider that a process of the Thread received.
    const deliveredId = storeIdOfValueId(valueId);
    if (deliveredId !== undefined) {
      if (Option.isNone(deliveredValues)) return Option.none<string>();
      const bytes = yield* deliveredValues.value.get(deliveredId);
      if (Option.isNone(bytes)) return Option.none<string>();
      const value = new TextDecoder().decode(bytes.value);
      setBounded(decrypted, valueId, value);
      return Option.some(value);
    }
    if (Option.isNone(values)) return Option.none<string>();
    const bytes = yield* values.value.get(valueId);
    if (Option.isNone(bytes)) return Option.none<string>();
    const value = new TextDecoder().decode(bytes.value);
    setBounded(decrypted, valueId, value);
    return Option.some(value);
  });

  const valuesOf = Effect.fnUntraced(function* (
    variables: ReadonlyArray<{ readonly name: string; readonly valueId: string }>,
    into: Array<MaskableSecret>,
  ) {
    for (const variable of variables) {
      const value = yield* readValue(variable.valueId);
      if (Option.isSome(value) && !into.some((s) => s.value === value.value)) {
        into.push({ name: variable.name, value: value.value });
      }
    }
  });

  /** An owner's effective set: nothing for a User no longer in the Space; storage fails. */
  const effectiveSet = (compute: Effect.Effect<EffectiveVaults.EffectiveSet, VaultError>) =>
    compute.pipe(
      // A Variable is configuration, never masked; a short Secret neither (it would hide text).
      // A Provider entry's value is masked once delivered (its `delivered:` row), never before.
      Effect.map((set) =>
        set.variables.flatMap((variable) =>
          !variable.unmasked && variable.class === "secret" && variable.valueId !== null
            ? [{ name: variable.name, valueId: variable.valueId }]
            : [],
        ),
      ),
      Effect.catchIf(
        (error) => error.reason !== "storage",
        () => Effect.succeed([]),
      ),
    );

  /** What the root Thread's processes received, and its owner's effective set now. */
  const load = Effect.fnUntraced(function* (root: string) {
    const threads = yield* sql<{ readonly ownerUserId: string | null }>`
      SELECT owner_user_id AS "ownerUserId" FROM orchestration_v2_projection_threads
      WHERE thread_id = ${root}
    `;
    const secrets: Array<MaskableSecret> = [];
    const owner = threads[0]?.ownerUserId ?? null;
    if (owner !== null && Option.isSome(effective)) {
      const set = yield* effectiveSet(
        effective.value.forThread({
          threadId: root as ThreadId,
          actingUserId: UserId.make(owner),
        }),
      );
      yield* valuesOf(set, secrets);
    }
    // Delivered to the root or to a child of it (rows written before the child had a root).
    const remembered = yield* sql<{ readonly valueId: string; readonly name: string }>`
      SELECT value_id AS "valueId", name FROM thread_secret_values
      WHERE thread_id = ${root} OR thread_id IN (
        SELECT thread_id FROM orchestration_v2_projection_threads
        WHERE json_extract(payload_json, '$.lineage.rootThreadId') = ${root}
      )
      ORDER BY remembered_at DESC
    `;
    yield* valuesOf(remembered, secrets);
    return secrets;
  });

  /** One load per root at a time; the others wait for it. */
  const loadEntry = (root: string, now: number) =>
    Effect.suspend(() => {
      const running = loading.get(root);
      if (running !== undefined) return Deferred.await(running);
      return Effect.uninterruptible(
        Effect.gen(function* () {
          const done = yield* Deferred.make<Entry | undefined, SecretMaskingError>();
          loading.set(root, done);
          const exit = yield* Effect.exit(
            load(root).pipe(
              Effect.map((loaded) => {
                // What was delivered before (or while this loaded) stays.
                const entry = entryOf(now, union(loaded, cache.get(root)?.secrets ?? []));
                setBounded(cache, root, entry);
                return entry as Entry | undefined;
              }),
              Effect.mapError(failed(root)),
            ),
          );
          loading.delete(root);
          yield* Deferred.done(done, exit);
          return yield* exit;
        }),
      );
    });

  const secretsFor = Effect.fnUntraced(function* (
    threadId: string,
    hint: ThreadPlacementHint | undefined,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const root = yield* rootOf(threadId).pipe(Effect.mapError(failed(threadId)));
    if (root === undefined) {
      // Being created: its owner's set where it will be (its first message and title come now).
      const delivered = cache.get(threadId)?.secrets ?? [];
      if (hint?.ownerUserId === undefined || Option.isNone(effective)) return delivered;
      const set = yield* effectiveSet(
        effective.value.forPlacement({
          threadId: threadId as ThreadId,
          spaceId: hint.spaceId,
          projectId: hint.projectId,
          actingUserId: hint.ownerUserId,
        }),
      ).pipe(Effect.mapError(failed(threadId)));
      const secrets: Array<MaskableSecret> = [];
      yield* valuesOf(set, secrets).pipe(Effect.mapError(failed(threadId)));
      return union(secrets, delivered);
    }
    const cached = cache.get(root);
    if (cached !== undefined && now - cached.loadedAt < MASKER_TTL_MS) return cached.secrets;
    const loaded = yield* loadEntry(root, now).pipe(
      Effect.retry(LOAD_RETRY),
      // Fails closed: the Thread's own set read whole before (a little old), or nothing at all; a
      // set holding only what was delivered since is never enough.
      Effect.catch((error) =>
        cached === undefined || cached.loadedAt === 0
          ? Effect.fail(error)
          : Effect.logWarning("SecretMasker: using the Thread's last read secrets", {
              threadId,
              cause: error,
            }).pipe(Effect.as(cached)),
      ),
    );
    return loaded?.secrets ?? [];
  });

  const forThread = Effect.fnUntraced(function* (
    threadId: ThreadId | string,
    hint?: ThreadPlacementHint,
  ) {
    const root = roots.get(threadId);
    if (root !== undefined) {
      const cached = cache.get(root);
      const now = yield* Clock.currentTimeMillis;
      if (cached !== undefined && now - cached.loadedAt < MASKER_TTL_MS) return cached.masker;
    }
    const secrets = yield* secretsFor(threadId, hint);
    const fresh = cache.get(roots.get(threadId) ?? threadId);
    return fresh !== undefined && fresh.secrets === secrets ? fresh.masker : maskerOf(secrets);
  });

  /** A User's own values, read again after the TTL; one read per User at a time. */
  const users = new Map<string, { readonly loadedAt: number; readonly masker: ThreadMasker }>();
  const userLoads = new Map<string, Deferred.Deferred<ThreadMasker, SecretMaskingError>>();
  /** Bumped when a User's set grows (a value delivered): a load begun before stores nothing. */
  const userVersions = new Map<string, number>();

  const loadUser = Effect.fn("SecretMasker.loadUser")(function* (userId: UserId) {
    // Their roots, one per Project and Space (the effective set depends on those alone).
    const roots = yield* sql<{ readonly threadId: string }>`
      SELECT MIN(thread_id) AS "threadId" FROM orchestration_v2_projection_threads
      WHERE owner_user_id = ${userId} AND deleted_at IS NULL
        AND COALESCE(json_extract(payload_json, '$.lineage.rootThreadId'), thread_id) = thread_id
      GROUP BY project_id, json_extract(payload_json, '$.spaceId')
    `;
    const secrets: Array<MaskableSecret> = [];
    if (Option.isSome(effective)) {
      for (const { threadId } of roots) {
        const set = yield* effectiveSet(
          effective.value.forThread({ threadId: threadId as ThreadId, actingUserId: userId }),
        );
        yield* valuesOf(set, secrets);
      }
    }
    // What their Threads' processes received (rotated values too).
    const delivered = yield* sql<{ readonly valueId: string; readonly name: string }>`
      SELECT v.value_id AS "valueId", v.name FROM thread_secret_values v
      JOIN orchestration_v2_projection_threads t ON t.thread_id = v.thread_id
      WHERE t.owner_user_id = ${userId} AND t.deleted_at IS NULL
      ORDER BY v.remembered_at DESC
    `;
    yield* valuesOf(delivered, secrets);
    // Delivered in this process and not yet in a row.
    for (const root of new Set(roots.map((row) => row.threadId))) {
      for (const secret of cache.get(root)?.secrets ?? []) {
        if (!secrets.some((s) => s.value === secret.value)) secrets.push(secret);
      }
    }
    return secrets.length === 0 ? noSecrets : maskerOf(secrets);
  });

  // Untraced: every file read, search and change request view asks (its span would be most spans).
  const forUser = Effect.fnUntraced(function* (userId: UserId) {
    const now = yield* Clock.currentTimeMillis;
    const version = userVersions.get(userId) ?? 0;
    const cached = users.get(userId);
    if (cached !== undefined && now - cached.loadedAt < MASKER_TTL_MS) return cached.masker;
    const running = userLoads.get(userId);
    if (running !== undefined) return yield* Deferred.await(running);
    const done = yield* Deferred.make<ThreadMasker, SecretMaskingError>();
    userLoads.set(userId, done);
    const exit = yield* Effect.exit(
      loadUser(userId).pipe(
        Effect.mapError(failed(undefined)),
        Effect.retry(LOAD_RETRY),
        Effect.tap((masker) =>
          Effect.sync(() => {
            if ((userVersions.get(userId) ?? 0) === version) {
              setBounded(users, userId, { loadedAt: now, masker });
            }
          }),
        ),
      ),
    ).pipe(Effect.uninterruptible);
    if (userLoads.get(userId) === done) userLoads.delete(userId);
    yield* Deferred.done(done, exit);
    return yield* exit;
  });

  const forViewer = Effect.flatMap(
    requester,
    (userId): Effect.Effect<ThreadMasker, SecretMaskingError> =>
      Option.isNone(userId) ? Effect.succeed(noSecrets) : forUser(userId.value),
  );

  const remember = Effect.fn("SecretMasker.remember")(function* (
    threadId: ThreadId,
    delivered: ReadonlyArray<DeliveredSecret>,
  ) {
    if (delivered.length === 0) return;
    for (const secret of delivered) setBounded(decrypted, secret.valueId, secret.value);
    const root = (yield* rootOf(threadId).pipe(Effect.orElseSucceed(() => undefined))) ?? threadId;
    // Masked in memory first: output can arrive before the row is written. Without a read set
    // (loadedAt 0) the next use still reads the rest.
    const current = cache.get(root);
    const added = delivered.map(({ name, value }) => ({ name, value }));
    setBounded(cache, root, entryOf(current?.loadedAt ?? 0, union(added, current?.secrets ?? [])));
    // Its owner's own set grows too: read again at once, and no load begun before stores.
    const owners = yield* sql<{ readonly ownerUserId: string | null }>`
      SELECT owner_user_id AS "ownerUserId" FROM orchestration_v2_projection_threads
      WHERE thread_id = ${root}
    `.pipe(Effect.orElseSucceed(() => []));
    const owner = owners[0]?.ownerUserId ?? null;
    if (owner !== null) {
      userVersions.set(owner, (userVersions.get(owner) ?? 0) + 1);
      users.delete(owner);
      userLoads.delete(owner);
    }
    const at = DateTime.formatIso(yield* DateTime.now);
    yield* Effect.forEach(
      delivered,
      (secret) => sql`
        INSERT INTO thread_secret_values (thread_id, value_id, name, remembered_at)
        VALUES (${root}, ${secret.valueId}, ${secret.name}, ${at})
        ON CONFLICT (thread_id, value_id) DO UPDATE SET name = excluded.name
      `,
      { discard: true },
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("SecretMasker: could not record a Thread's secrets", {
          threadId,
          cause,
        }),
      ),
    );
  });

  // After a restart this process's own logs and spans mask every value at once (not only once a
  // Thread's masker is read). Never used for what a client sees.
  yield* Effect.gen(function* () {
    const rows = yield* sql<{ readonly name: string; readonly valueId: string }>`
      SELECT name, value_id AS "valueId" FROM vault_entries
      WHERE value_id IS NOT NULL AND unmasked = 0 AND class = 'secret'
      UNION SELECT name, value_id AS "valueId" FROM thread_secret_values
    `;
    const secrets: Array<MaskableSecret> = [];
    yield* valuesOf(rows, secrets);
    rememberKnownSecrets(secrets);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("SecretMasker: could not read the values for log masking", { cause }),
    ),
  );

  return SecretMasker.of({ forThread, forUser, forViewer, remember });
});

export const layer = Layer.effect(SecretMasker, make);

/**
 * The User a request is made for: a WS or HTTP session's principal, else the MCP caller's User
 * (an agent's tool call is its Thread owner's). None for internal work.
 */
export const requester: Effect.Effect<Option.Option<UserId>> = Effect.gen(function* () {
  const principal = yield* Effect.serviceOption(EnvironmentAuthenticatedPrincipal);
  if (Option.isSome(principal) && principal.value.userId !== undefined) {
    return Option.some(principal.value.userId);
  }
  const mcp = yield* Effect.serviceOption(McpInvocationContext);
  return Option.isSome(mcp) ? Option.fromNullishOr(mcp.value.userId) : Option.none();
});
