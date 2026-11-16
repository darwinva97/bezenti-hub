/**
 * Spec 5 ticket 04: the one place that turns a Thread's effective set into one process's secrets.
 * `plan` names the set (no value read); `resolve` reads the values only when a process starts.
 * Who receives them is decided here, on the Hub. docs/internals/secrets.md, «Delivery».
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a sync hash of names and value ids, never of values.
import * as NodeCrypto from "node:crypto";
import {
  EnvironmentId,
  HUB_MACHINE_ENVIRONMENT_ID,
  NO_SECRETS_FINGERPRINT,
  SECRET_ENV_CONTRACT_VERSION,
  type SecretEnv,
  SecretDeliveryError,
  SecretProviderReadError,
  type SpaceId,
  type ThreadId,
  UserId,
  VaultError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { machineNameOf } from "../environments/machineName.ts";
import { threadTurnOwner } from "../orchestration-v2/threadTurnOwner.ts";
import { servesSpace } from "../sandboxes/sandboxSpace.ts";
import * as DeliveredValueId from "./deliveredValueId.ts";
import * as EffectiveVaults from "./EffectiveVaults.ts";
import * as ProviderReads from "./ProviderReads.ts";
import * as SecretMasker from "./SecretMasker.ts";

type ProviderRead = { readonly name: string; readonly ref: ProviderReads.ProviderRef };

/**
 * The failure of a set's Provider entries: the first provider and class that failed, with every
 * entry that failed alike. Names only.
 */
const readFailureOf = (
  reads: ReadonlyArray<ProviderRead>,
  outcomes: ReadonlyArray<ProviderReads.ProviderOutcome>,
): SecretProviderReadError | undefined => {
  const first = outcomes.find(
    (outcome): outcome is Extract<ProviderReads.ProviderOutcome, { readonly _tag: "error" }> =>
      outcome._tag === "error",
  );
  if (first === undefined) return undefined;
  const entries = reads.flatMap((read, index) => {
    const outcome = outcomes[index];
    return outcome?._tag === "error" &&
      outcome.label === first.label &&
      outcome.error === first.error
      ? [read.name]
      : [];
  });
  return new SecretProviderReadError({
    reason: first.error,
    provider: first.label,
    scope: null,
    entries,
  });
};

/** The machine a process starts on: the Thread's Active environment, and its executor contract. */
export interface SecretTarget {
  readonly environmentId: EnvironmentId;
  readonly contractVersion: number;
}

/** What a process would receive, by name and value id: no value is read to make one. */
export interface SecretPlan {
  readonly fingerprint: string;
  readonly target: SecretTarget;
  /** The Thread whose process receives it: what it receives is masked there (ticket 05). */
  readonly threadId?: ThreadId;
  /**
   * `plain`: a Vault Variable, delivered as the others and never masked. `provider`: a Provider
   * entry, read again (through ProviderReads' cache) when the process starts; its `valueId` is
   * the delivered value's (`delivered:<HMAC>`), so a rotation in the provider changes the plan.
   */
  readonly variables: ReadonlyArray<{
    readonly name: string;
    readonly valueId: string;
    readonly plain?: true;
    readonly provider?: ProviderReads.ProviderRef;
  }>;
  /**
   * A Provider entry that could not be read when planning: the start fails with it, whole
   * (decision 3). Its fingerprint differs from any set's, so a running process is not kept.
   */
  readonly failure?: SecretProviderReadError;
  /**
   * Spec 5 ticket 07: the Space the set was planned for (the Thread's, read by the same
   * `forThread`) and the User whose set it is; null when nothing was computed. A shell keeps them.
   */
  readonly spaceId: SpaceId | null;
  readonly userId: UserId | null;
}

export type SecretDeliveryFailure = VaultError | SecretDeliveryError | SecretProviderReadError;

export class SecretDelivery extends Context.Service<
  SecretDelivery,
  {
    /** Whose secrets the Thread's turns receive: its owner, or its root Thread's. */
    readonly turnOwner: (threadId: ThreadId) => Effect.Effect<Option.Option<UserId>, VaultError>;
    /**
     * What a process of the Thread receives when `actingUserId` starts it on `target`: nothing
     * without a User, for a Thread that is gone, or on a machine that does not serve its Space.
     */
    readonly plan: (input: {
      readonly threadId: ThreadId;
      readonly actingUserId: UserId | undefined;
      readonly target: SecretTarget;
    }) => Effect.Effect<SecretPlan, VaultError>;
    /** `plan` for the Thread's turns: its owner starts them. */
    readonly planTurn: (input: {
      readonly threadId: ThreadId;
      readonly target: SecretTarget;
    }) => Effect.Effect<SecretPlan, VaultError>;
    /**
     * The values, read now for a process about to start. A machine before contract 10 with a
     * non-empty plan is refused (`outdated-machine`).
     */
    readonly resolve: (plan: SecretPlan) => Effect.Effect<SecretEnv, SecretDeliveryFailure>;
    /**
     * Whether the Thread could receive any secret: one cheap query, a superset of the set (no
     * value nor effective set is read). Used to give such a Thread a provider process of its own.
     */
    readonly mayReceiveSecrets: (threadId: ThreadId) => Effect.Effect<boolean, VaultError>;
    /**
     * `list_secret_names` (spec 5 ticket 06): the names the Thread's turns receive, as `planTurn`
     * picks them (its owner's set, dangerous names only as the Owner set them), with each one's
     * description and winning Vault. Never a value or an id. Empty without an owner, for a Thread
     * that is gone, or for an owner who no longer works in its Space.
     */
    readonly turnNames: (threadId: ThreadId) => Effect.Effect<
      ReadonlyArray<{
        readonly name: string;
        readonly description: string | null;
        readonly vault: string;
      }>,
      VaultError
    >;
  }
>()("t3/vaults/SecretDelivery") {}

/**
 * The fingerprint of a set: its User, names and value ids (a replace writes a new id), and which
 * are Variables (a Secret's stays as before Variables existed).
 */
const fingerprintOf = (actingUserId: UserId, variables: SecretPlan["variables"]): string =>
  variables.length === 0
    ? NO_SECRETS_FINGERPRINT
    : NodeCrypto.createHash("sha256")
        .update(
          JSON.stringify([
            actingUserId,
            variables.map((v) =>
              v.plain === true ? [v.name, v.valueId, "plain"] : [v.name, v.valueId],
            ),
          ]),
        )
        .digest("hex")
        .slice(0, 32);

/** The plan of a process that gets no secret. */
export const emptyPlan = (
  target: SecretTarget,
  facts: { readonly spaceId: SpaceId | null; readonly userId: UserId | null } = {
    spaceId: null,
    userId: null,
  },
): SecretPlan => ({
  fingerprint: NO_SECRETS_FINGERPRINT,
  target,
  variables: [],
  ...facts,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const effective = yield* EffectiveVaults.EffectiveVaults;
  const values = yield* ServerSecretStore.VaultValueStore;
  const masker = yield* Effect.serviceOption(SecretMasker.SecretMasker);
  const providerReads = yield* Effect.serviceOption(ProviderReads.ProviderReads);
  const deliveredStore = yield* Effect.serviceOption(ServerSecretStore.DeliveredValueStore);
  const secretStore = yield* ServerSecretStore.ServerSecretStore;

  const storage = (what: string) => (cause: unknown) =>
    Effect.logError(`SecretDelivery: could not ${what}`, { cause }).pipe(
      Effect.andThen(
        Effect.fail(
          new VaultError({ reason: "storage", message: `Could not ${what}. Try again.` }),
        ),
      ),
    );

  // The HMAC key, read once (it never changes).
  const hmacKey = yield* Effect.cached(
    DeliveredValueId.fingerprintKey.pipe(
      Effect.provideService(ServerSecretStore.ServerSecretStore, secretStore),
      Effect.catch(storage("read the Hub's fingerprint key")),
    ),
  );

  /**
   * Provider entries' values, through ProviderReads' cache. Broken ones (provider gone) are left
   * out, like a broken link; a failure is the whole set's.
   */
  const readProviders = Effect.fn("SecretDelivery.readProviders")(function* (
    reads: ReadonlyArray<ProviderRead>,
  ) {
    if (reads.length === 0) return { values: new Map<string, string>(), failure: undefined };
    if (Option.isNone(providerReads)) {
      return { values: new Map<string, string>(), failure: undefined };
    }
    const outcomes = yield* providerReads.value.read(reads.map((read) => read.ref));
    const found = new Map<string, string>();
    reads.forEach((read, index) => {
      const outcome = outcomes[index];
      if (outcome?._tag === "value") found.set(read.name, outcome.value);
    });
    return { values: found, failure: readFailureOf(reads, outcomes) };
  });

  const turnOwner = Effect.fn("SecretDelivery.turnOwner")(function* (threadId: ThreadId) {
    return yield* threadTurnOwner(sql, threadId).pipe(
      Effect.catch(storage("read who owns the Thread")),
    );
  });

  /**
   * A name that changes how tools run reaches a process only as the Owner last set it: its value
   * (a link's is its original's), or a Provider entry's row. The entry ids of those trusted.
   */
  const ownerSet = Effect.fn("SecretDelivery.ownerSet")(function* (
    dangerous: ReadonlyArray<EffectiveVaults.EffectiveVariable>,
  ) {
    if (dangerous.length === 0) return new Set<string>();
    const valueIds = dangerous.flatMap((v) => (v.valueId === null ? [] : [v.valueId]));
    const entryIds = dangerous.flatMap((v) => (v.provider === null ? [] : [v.entryId]));
    const rows = yield* sql<{ readonly valueId: string | null; readonly entryId: string }>`
      SELECT e.value_id AS "valueId", e.entry_id AS "entryId" FROM vault_entries e
      JOIN users u ON u.user_id = e.updated_by AND u.is_owner = 1
      WHERE e.value_id IN ${sql.in(valueIds.length === 0 ? [""] : valueIds)}
        OR (e.kind = 'provider' AND e.entry_id IN ${sql.in(entryIds.length === 0 ? [""] : entryIds)})
    `.pipe(Effect.catch(storage("check who set the Thread's secrets")));
    const trustedValues = new Set(
      rows.flatMap((row) => (row.valueId === null ? [] : [row.valueId])),
    );
    const trustedEntries = new Set(rows.map((row) => row.entryId as string));
    return new Set(
      dangerous
        .filter((v) =>
          v.provider === null
            ? v.valueId !== null && trustedValues.has(v.valueId)
            : trustedEntries.has(v.entryId),
        )
        .map((v) => v.entryId as string),
    );
  });

  const machineName = (environmentId: EnvironmentId) => machineNameOf(sql, environmentId);

  const plan = Effect.fn("SecretDelivery.plan")(function* (input: {
    readonly threadId: ThreadId;
    readonly actingUserId: UserId | undefined;
    readonly target: SecretTarget;
  }) {
    if (input.actingUserId === undefined) return emptyPlan(input.target);
    const set = yield* effective
      .forThread({ threadId: input.threadId, actingUserId: input.actingUserId })
      .pipe(
        Effect.asSome,
        Effect.catchIf(
          (error) => error.reason === "not-found",
          () => Effect.succeedNone,
        ),
      );
    if (Option.isNone(set)) return emptyPlan(input.target);
    const facts = { spaceId: set.value.spaceId, userId: input.actingUserId };
    if (set.value.variables.length === 0) return emptyPlan(input.target, facts);
    // A machine that does not run this Space's Threads gets nothing (spec 3, ticket 12).
    if (input.target.environmentId !== HUB_MACHINE_ENVIRONMENT_ID) {
      const serves = yield* servesSpace(
        input.target.environmentId,
        set.value.spaceId,
        input.threadId,
      ).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.catch(storage("check the machine's Space")),
      );
      if (!serves) return emptyPlan(input.target, facts);
    }
    const trusted = yield* ownerSet(set.value.variables.filter((v) => v.dangerous));
    const chosen = set.value.variables.filter((v) => !v.dangerous || trusted.has(v.entryId));
    // Provider entries are read now, through the cache: their value names the set (HMAC).
    const reads = chosen.flatMap((v) =>
      v.provider === null ? [] : [{ name: v.name, ref: v.provider }],
    );
    const read = yield* readProviders(reads);
    const key = reads.length === 0 ? undefined : yield* hmacKey;
    const variables = chosen.flatMap((v): Array<SecretPlan["variables"][number]> => {
      if (v.provider !== null) {
        const value = read.values.get(v.name);
        if (value === undefined || key === undefined) return [];
        return [
          {
            name: v.name,
            valueId: DeliveredValueId.deliveredValueId(DeliveredValueId.deliveredIdOf(key, value)),
            provider: v.provider,
          },
        ];
      }
      if (v.valueId === null) return [];
      return [
        {
          name: v.name,
          valueId: v.valueId,
          ...(v.class === "variable" ? { plain: true as const } : {}),
        },
      ];
    });
    if (read.failure !== undefined) {
      return {
        fingerprint: `failed:${fingerprintOf(input.actingUserId, variables)}`,
        target: input.target,
        threadId: input.threadId,
        variables,
        failure: read.failure,
        ...facts,
      } satisfies SecretPlan;
    }
    return {
      fingerprint: fingerprintOf(input.actingUserId, variables),
      target: input.target,
      threadId: input.threadId,
      variables,
      ...facts,
    } satisfies SecretPlan;
  });

  const planTurn = Effect.fn("SecretDelivery.planTurn")(function* (input: {
    readonly threadId: ThreadId;
    readonly target: SecretTarget;
  }) {
    const owner = yield* turnOwner(input.threadId);
    return yield* plan({
      threadId: input.threadId,
      actingUserId: Option.getOrUndefined(owner),
      target: input.target,
    });
  });

  const turnNames = Effect.fn("SecretDelivery.turnNames")(function* (threadId: ThreadId) {
    const owner = yield* turnOwner(threadId);
    if (Option.isNone(owner)) return [];
    const set = yield* effective.forThread({ threadId, actingUserId: owner.value }).pipe(
      Effect.asSome,
      Effect.catchIf(
        (error) => error.reason === "not-found" || error.reason === "forbidden",
        () => Effect.succeedNone,
      ),
    );
    if (Option.isNone(set)) return [];
    // As `plan`: a machine that does not run this Space's Threads gets nothing, so lists nothing.
    const active = yield* sql<{ readonly environmentId: string | null }>`
      SELECT active_environment_id AS "environmentId"
      FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
    `.pipe(Effect.catch(storage("read the Thread's machine")));
    const environmentId = active[0]?.environmentId ?? null;
    if (environmentId !== null && environmentId !== HUB_MACHINE_ENVIRONMENT_ID) {
      const serves = yield* servesSpace(
        EnvironmentId.make(environmentId),
        set.value.spaceId,
        threadId,
      ).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.catch(storage("check the machine's Space")),
      );
      if (!serves) return [];
    }
    const trusted = yield* ownerSet(set.value.variables.filter((v) => v.dangerous));
    return set.value.variables
      .filter((v) => !v.dangerous || trusted.has(v.entryId))
      .map((v) => ({ name: v.name, description: v.description, vault: v.vaultName }));
  });

  const resolve = Effect.fn("SecretDelivery.resolve")(function* (planned: SecretPlan) {
    // A Provider entry that could not be read: nothing of the set goes (decision 3).
    if (planned.failure !== undefined) return yield* planned.failure;
    if (planned.variables.length === 0) {
      return { fingerprint: NO_SECRETS_FINGERPRINT, variables: [] } satisfies SecretEnv;
    }
    if (planned.target.contractVersion < SECRET_ENV_CONTRACT_VERSION) {
      const environmentName = yield* machineName(planned.target.environmentId);
      return yield* new SecretDeliveryError({
        reason: "outdated-machine",
        ...(environmentName === undefined ? {} : { environmentName }),
      });
    }
    // Provider entries again, through the cache (a hit since the plan, unless it expired).
    const reads = planned.variables.flatMap((variable) =>
      variable.provider === undefined ? [] : [{ name: variable.name, ref: variable.provider }],
    );
    const read = yield* readProviders(reads);
    if (read.failure !== undefined) return yield* read.failure;
    const key = reads.length === 0 ? undefined : yield* hmacKey;
    const delivered: Array<SecretMasker.DeliveredSecret & { readonly plain?: true }> = [];
    for (const variable of planned.variables) {
      if (variable.provider !== undefined) {
        const value = read.values.get(variable.name);
        // A provider gone since the plan (broken): left out, like a broken link.
        if (value === undefined || key === undefined) continue;
        const id = DeliveredValueId.deliveredIdOf(key, value);
        // Sealed first: masked in the Thread from its first byte, for the Thread's life.
        if (Option.isNone(deliveredStore)) {
          return yield* storage("keep a provider's value for masking")(
            "no delivered values' store on this machine",
          );
        }
        yield* deliveredStore.value
          .set(id, new TextEncoder().encode(value))
          .pipe(Effect.catch(storage("keep a provider's value for masking")));
        delivered.push({
          name: variable.name,
          value,
          valueId: DeliveredValueId.deliveredValueId(id),
        });
        continue;
      }
      const bytes = yield* values
        .get(variable.valueId)
        .pipe(Effect.catch(storage("read the Thread's secrets")));
      // A value gone from the store (a race with a delete) is left out, never sent empty.
      if (Option.isNone(bytes)) continue;
      delivered.push({
        name: variable.name,
        value: new TextDecoder().decode(bytes.value),
        valueId: variable.valueId,
        ...(variable.plain === true ? { plain: true as const } : {}),
      });
    }
    // Masked in the Thread before the process that gets them can print anything (ticket 05);
    // Variables never are.
    if (planned.threadId !== undefined && Option.isSome(masker)) {
      yield* masker.value.remember(
        planned.threadId,
        delivered.filter((secret) => secret.plain !== true),
      );
    }
    return {
      fingerprint: planned.fingerprint,
      variables: delivered.map(({ name, value, plain }) =>
        plain === true ? { name, value, plain } : { name, value },
      ),
    } satisfies SecretEnv;
  });

  const mayReceiveSecrets = Effect.fn("SecretDelivery.mayReceiveSecrets")(function* (
    threadId: ThreadId,
  ) {
    const rows = yield* sql<{ readonly found: number }>`
      WITH t AS (
        SELECT COALESCE(th.space_id, p.space_id,
            'personal:' || (SELECT user_id FROM users WHERE is_owner = 1)) AS space_id,
          COALESCE(th.owner_user_id, root.owner_user_id) AS owner_id
        FROM orchestration_v2_projection_threads th
        LEFT JOIN orchestration_v2_projection_threads root
          ON root.thread_id = json_extract(th.payload_json, '$.lineage.rootThreadId')
        LEFT JOIN projection_projects p ON p.project_id = th.project_id
        WHERE th.thread_id = ${threadId}
      )
      SELECT EXISTS (
        SELECT 1 FROM t, vaults v JOIN vault_entries e ON e.vault_id = v.vault_id
        WHERE t.owner_id IS NOT NULL AND v.archived_at IS NULL AND (
          (v.is_main = 1 AND t.space_id = 'personal:' || t.owner_id)
          OR v.space_id = t.space_id
          OR EXISTS (SELECT 1 FROM vault_allowances a WHERE a.vault_id = v.vault_id AND (
            (a.subject_kind = 'space' AND a.subject_id = t.space_id)
            OR (a.subject_kind = 'user' AND a.subject_id = t.owner_id)))
        )
      ) AS found
    `.pipe(Effect.catch(storage("check the Thread's Vaults")));
    return rows[0]?.found === 1;
  });

  return SecretDelivery.of({
    turnOwner,
    plan,
    planTurn,
    resolve,
    mayReceiveSecrets,
    turnNames,
  });
});

export const layer = Layer.effect(SecretDelivery, make);
