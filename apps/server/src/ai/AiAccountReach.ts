/**
 * Spec 4 ticket 11: what a Thread loses of the AI accounts when its Project moves to another
 * Space, and what a removal drops. The rule is still AllowedAiAccounts (turn owner, the Thread's
 * Space now): this keeps the records agreeing with it, in the transaction that ends the reach.
 * docs/internals/ai-gateway.md, «Moving a Project and removals».
 */
import {
  AI_DIRECT_DRIVERS,
  AI_GATEWAY_DRIVERS,
  type AiAccountId,
  type AiAccountProvider,
  type ModelSelection,
  type ProjectId,
  type ProviderDriverKind,
  type SpaceId,
  type ThreadId,
  UserId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { threadTurnOwner } from "../orchestration-v2/threadTurnOwner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AuditLog from "../audit/AuditLog.ts";
import * as AiAccounts from "./AiAccounts.ts";
import * as AiGatewayKeys from "./AiGatewayKeys.ts";
import * as AllowedAiAccounts from "./AllowedAiAccounts.ts";
import { chooseAiAccount, gatewayModelOf } from "./chooseAiAccount.ts";

export class AiAccountReachError extends Schema.TaggedError<AiAccountReachError>()(
  "AiAccountReachError",
  { message: Schema.String },
) {}

/** An account the Project's Threads lose by moving (`aiAccountsLost` of the move plan). */
export interface AiAccountLost {
  readonly aiAccountId: AiAccountId;
  readonly provider: AiAccountProvider;
  /**
   * Only for an account its viewers see in the Space it leaves: allowed to it, or owned by its
   * owner (owned-resources 10).
   */
  readonly name: string | null;
  readonly threads: number;
}

/** What one Thread is about to move with: its selection and what its driver is known as. */
export interface ThreadToMove {
  readonly threadId: ThreadId;
  readonly modelSelection: ModelSelection;
  /** Its sessions' driver, when one was ever opened; else read from the instance. */
  readonly driver: ProviderDriverKind | undefined;
}

/** Catalogs read before a move's transactions, so none waits on the gateway while writing. */
export type Catalogs = ReadonlyMap<AiAccountId, ReadonlyArray<string>>;

export class AiAccountReach extends Context.Service<
  AiAccountReach,
  {
    /** The accounts the Project's Threads chose that their owners may not use in `to`. */
    readonly projectMoveLoss: (input: {
      readonly projectId: ProjectId;
      readonly from: SpaceId;
      readonly to: SpaceId;
    }) => Effect.Effect<ReadonlyArray<AiAccountLost>, AiAccountReachError>;
    /** The catalogs of every account that may be a default in `spaceId` for these Threads. */
    readonly catalogsFor: (input: {
      readonly threadIds: ReadonlyArray<ThreadId>;
      readonly spaceId: SpaceId;
    }) => Effect.Effect<Catalogs>;
    /**
     * Run inside the Thread's move transaction: revokes its gateway keys (`thread-moved`) and
     * answers its selection in `spaceId`: its account if still allowed to its turn owner there,
     * else the first allowed one its driver takes (and that serves the model, when known), else
     * none («needs an AI account»).
     */
    readonly moveThread: (input: {
      readonly thread: ThreadToMove;
      readonly spaceId: SpaceId;
      readonly catalogs: Catalogs;
    }) => Effect.Effect<ModelSelection, AiAccountReachError>;
  }
>()("t3/ai/AiAccountReach") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const allowedAccounts = yield* AllowedAiAccounts.AllowedAiAccounts;
  // Absent on a host without the gateway: no catalog, the first compatible account is the default.
  const accounts = yield* Effect.serviceOption(AiAccounts.AiAccounts);
  const settings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);

  const failed = (what: string) => (cause: unknown) =>
    Effect.logError(`AiAccountReach: could not ${what}`, { cause }).pipe(
      Effect.andThen(Effect.fail(new AiAccountReachError({ message: `Could not ${what}.` }))),
    );

  /** The driver of a Thread's instance: its sessions', the Hub's settings, or a default id. */
  const driverOf = Effect.fn("AiAccountReach.driverOf")(function* (thread: ThreadToMove) {
    if (thread.driver !== undefined) return Option.some(thread.driver);
    const instanceId = thread.modelSelection.instanceId;
    if (Option.isSome(settings)) {
      const current = yield* settings.value.getSettings.pipe(Effect.option);
      const configured = Option.isSome(current)
        ? current.value.providerInstances[instanceId]
        : undefined;
      if (configured !== undefined) return Option.some(configured.driver);
    }
    return AI_GATEWAY_DRIVERS.has(instanceId) || AI_DIRECT_DRIVERS.has(instanceId)
      ? Option.some(instanceId as unknown as ProviderDriverKind)
      : Option.none<ProviderDriverKind>();
  });

  const ownerOf = (threadId: ThreadId) =>
    threadTurnOwner(sql, threadId).pipe(Effect.catch(failed("read the Thread's owner")));

  /** Each listed Thread's turn owner and chosen account. */
  const chosenOf = (threadIds: ReadonlyArray<ThreadId>) =>
    threadIds.length === 0
      ? Effect.succeed([])
      : sql<{
          readonly threadId: ThreadId;
          readonly ownerUserId: string | null;
          readonly chosen: string | null;
        }>`
          SELECT t.thread_id AS "threadId",
            COALESCE(t.owner_user_id, root.owner_user_id) AS "ownerUserId",
            json_extract(t.payload_json, '$.modelSelection.aiAccountId') AS "chosen"
          FROM orchestration_v2_projection_threads t
          LEFT JOIN orchestration_v2_projection_threads root
            ON root.thread_id = json_extract(t.payload_json, '$.lineage.rootThreadId')
          WHERE ${sql.in("t.thread_id", threadIds)}
        `.pipe(Effect.catch(failed("read the Threads' AI accounts")));

  const projectMoveLoss = Effect.fn("AiAccountReach.projectMoveLoss")(function* (input: {
    readonly projectId: ProjectId;
    readonly from: SpaceId;
    readonly to: SpaceId;
  }) {
    if (input.from === input.to) return [] as ReadonlyArray<AiAccountLost>;
    const threads = yield* sql<{ readonly threadId: ThreadId }>`
      SELECT thread_id AS "threadId" FROM orchestration_v2_projection_threads
      WHERE project_id = ${input.projectId} AND deleted_at IS NULL
    `.pipe(Effect.catch(failed("read the Project's Threads")));
    const rows = yield* chosenOf(threads.map((thread) => thread.threadId));
    const byOwner = new Map<string, Set<string>>();
    const lost = new Map<string, number>();
    for (const row of rows) {
      if (row.chosen === null || row.ownerUserId === null) continue;
      let allowed = byOwner.get(row.ownerUserId);
      if (allowed === undefined) {
        const answer = yield* allowedAccounts
          .for(UserId.make(row.ownerUserId), input.to)
          .pipe(Effect.catch(failed("read the AI accounts allowed there")));
        allowed = new Set(answer.map((account) => account.id));
        byOwner.set(row.ownerUserId, allowed);
      }
      if (!allowed.has(row.chosen)) lost.set(row.chosen, (lost.get(row.chosen) ?? 0) + 1);
    }
    if (lost.size === 0) return [] as ReadonlyArray<AiAccountLost>;
    const ids = [...lost.keys()];
    const described = yield* sql<{
      readonly accountId: AiAccountId;
      readonly name: string;
      readonly provider: AiAccountProvider;
      readonly priority: number;
      readonly shown: number;
    }>`
      SELECT a.account_id AS "accountId", a.name AS "name", a.provider AS "provider",
        a.priority AS "priority",
        (EXISTS (
          SELECT 1 FROM ai_account_allowances l
          WHERE l.account_id = a.account_id AND l.subject_kind = 'space'
            AND l.subject_id = ${input.from}
        ) OR (a.owner_kind = 'organization' AND a.owner_id = ${input.from})
          OR (a.owner_kind = 'user' AND 'personal:' || a.owner_id = ${input.from})) AS "shown"
      FROM ai_accounts a WHERE ${sql.in("a.account_id", ids)}
      ORDER BY a.priority, a.account_id
    `.pipe(Effect.catch(failed("read the AI accounts")));
    return described.map((account): AiAccountLost => ({
      aiAccountId: account.accountId,
      provider: account.provider,
      name: account.shown === 1 ? account.name : null,
      threads: lost.get(account.accountId) ?? 0,
    }));
  });

  const catalogsFor = Effect.fn("AiAccountReach.catalogsFor")(function* (input: {
    readonly threadIds: ReadonlyArray<ThreadId>;
    readonly spaceId: SpaceId;
  }) {
    const catalogs = new Map<AiAccountId, ReadonlyArray<string>>();
    if (Option.isNone(accounts)) return catalogs as Catalogs;
    const rows = yield* chosenOf(input.threadIds).pipe(Effect.orElseSucceed(() => []));
    const owners = new Set(
      rows.flatMap((row) => (row.ownerUserId === null ? [] : [row.ownerUserId])),
    );
    for (const owner of owners) {
      const allowed = yield* allowedAccounts
        .for(UserId.make(owner), input.spaceId)
        .pipe(Effect.orElseSucceed(() => []));
      for (const account of allowed) {
        if (account.type === "direct" || catalogs.has(account.id)) continue;
        const models = yield* accounts.value.modelsOf(account.id).pipe(Effect.option);
        if (Option.isSome(models)) catalogs.set(account.id, models.value);
      }
    }
    return catalogs as Catalogs;
  });

  const moveThread = Effect.fn("AiAccountReach.moveThread")(function* (input: {
    readonly thread: ThreadToMove;
    readonly spaceId: SpaceId;
    readonly catalogs: Catalogs;
  }) {
    const { thread } = input;
    // Its keys were for the Space it leaves: over for good, whoever holds one.
    yield* AiGatewayKeys.revokeWithin(
      sql,
      AuditLog.cliActor,
      { threadId: thread.threadId },
      "thread-moved",
    ).pipe(Effect.catch(failed("revoke the Thread's AI gateway keys")));
    const owner = yield* ownerOf(thread.threadId);
    const { aiAccountId: chosen, ...rest } = thread.modelSelection;
    if (Option.isNone(owner)) return rest as ModelSelection;
    // Read in the transaction: an allowance taken back meanwhile is seen, or waits for it.
    const allowed = yield* allowedAccounts
      .for(owner.value, input.spaceId)
      .pipe(Effect.catch(failed("read the AI accounts allowed there")));
    if (chosen !== undefined && allowed.some((account) => account.id === chosen)) {
      return thread.modelSelection;
    }
    const modelsOf = (accountId: AiAccountId) =>
      Effect.succeed(Option.fromNullishOr(input.catalogs.get(accountId)));
    const driver = yield* driverOf(thread);
    if (Option.isSome(driver)) {
      const choice = yield* chooseAiAccount({
        driver: driver.value,
        allowed,
        chosen: undefined,
        model: thread.modelSelection.model,
        modelsOf,
        atTheDoor: true,
      });
      return choice._tag === "chosen"
        ? ({ ...rest, aiAccountId: choice.account.id } as ModelSelection)
        : (rest as ModelSelection);
    }
    // An instance no longer known: an account of the kind it had (direct: the same provider),
    // the first that serves its model when that can be read.
    if (chosen === undefined) return rest as ModelSelection;
    const previous = yield* kindOf(chosen);
    const model = gatewayModelOf(thread.modelSelection.model.trim());
    let fallback: AiAccountId | undefined;
    for (const account of allowed) {
      if (previous === undefined || (account.type === "direct") !== (previous.type === "direct")) {
        continue;
      }
      if (account.type === "direct") {
        if (account.provider !== previous.provider) continue;
        return { ...rest, aiAccountId: account.id } as ModelSelection;
      }
      const models = input.catalogs.get(account.id);
      if (models === undefined) fallback ??= account.id;
      else if (model.length === 0 || models.includes(model)) {
        return { ...rest, aiAccountId: account.id } as ModelSelection;
      }
    }
    return fallback === undefined
      ? (rest as ModelSelection)
      : ({ ...rest, aiAccountId: fallback } as ModelSelection);
  });

  const kindOf = (accountId: AiAccountId) =>
    sql<{ readonly type: string; readonly provider: AiAccountProvider }>`
      SELECT type AS "type", provider AS "provider" FROM ai_accounts WHERE account_id = ${accountId}
    `.pipe(
      Effect.map((rows) => rows[0]),
      Effect.catch(failed("read the Thread's AI account")),
    );

  return AiAccountReach.of({ projectMoveLoss, catalogsFor, moveThread });
});

export const layer = Layer.effect(AiAccountReach, make);
