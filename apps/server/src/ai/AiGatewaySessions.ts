/**
 * Spec 4 tickets 06 and 07: the one rule for a Hub provider session's AI account: the gateway and
 * its key for the turn owner, or (no base URL) a direct account's credential as one masked
 * variable. docs/internals/ai-gateway.md, «Agents through the gateway», «Direct credentials».
 */
import {
  AI_DIRECT_CONTRACT_VERSION,
  AI_DIRECT_DRIVERS,
  AI_GATEWAY_CONTRACT_VERSION,
  AI_GATEWAY_DRIVERS,
  type AiAccountId,
  type AiGatewayAccess,
  AiGatewaySessionError,
  aiDirectVariableOf,
  type EnvironmentId,
  HUB_MACHINE_ENVIRONMENT_ID,
  type ModelSelection,
  type ProviderDriverKind,
  type ProviderSessionAiAccount,
  type SecretEnvVariable,
  type SpaceId,
  type ThreadId,
  type UserId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";

import { machineNameOf } from "../environments/machineName.ts";
import { threadTurnOwner } from "../orchestration-v2/threadTurnOwner.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as SecretMasker from "../vaults/SecretMasker.ts";
import * as AiAccounts from "./AiAccounts.ts";
import * as AiGatewayActivity from "./AiGatewayActivity.ts";
import * as AiGatewayKeys from "./AiGatewayKeys.ts";
import { aiCredentialValueId } from "./aiCredentialValue.ts";
import * as AllowedAiAccounts from "./AllowedAiAccounts.ts";
import { chooseAiAccount, gatewayModelOf } from "./chooseAiAccount.ts";

/** The machine a session's process starts on, and its executor contract. */
export interface GatewayTarget {
  readonly environmentId: EnvironmentId;
  readonly contractVersion: number;
}

/**
 * What a session of the Thread gets now, decided once per open and without a key or credential:
 * off AI accounts, refused (never a fallback to a login), on the gateway for this owner and
 * account, or (ticket 07) with this direct account's credential under `variable`.
 */
export type GatewayPlan =
  | { readonly _tag: "off" }
  | { readonly _tag: "refused"; readonly error: AiGatewaySessionError }
  | {
      readonly _tag: "on";
      readonly ownerUserId: UserId;
      /** The Thread's Space the plan was made for (a move means another process). */
      readonly spaceId: SpaceId;
      readonly account: ProviderSessionAiAccount;
      /** Names who the process acts for and on what: a session with another is not reused. */
      readonly fingerprint: string;
    }
  | {
      readonly _tag: "direct";
      readonly ownerUserId: UserId;
      readonly spaceId: SpaceId;
      readonly account: ProviderSessionAiAccount;
      /** The variable the credential reaches the process under (`AI_DIRECT_DRIVERS`). */
      readonly variable: string;
      /** Owner, Space, account and credential id (a replaced credential is a new process). */
      readonly fingerprint: string;
    };

/** A session on the gateway: what its process gets, and the account the Thread shows. */
export interface GatewaySession {
  readonly access: AiGatewayAccess;
  readonly account: ProviderSessionAiAccount;
}

/** A session with a direct credential: the one variable its process gets, already masked. */
export interface DirectSession {
  readonly variable: SecretEnvVariable;
  readonly account: ProviderSessionAiAccount;
}

/** The fingerprint of a session off the gateway. */
export const NO_GATEWAY = "none";

export const fingerprintOf = (plan: GatewayPlan) =>
  plan._tag === "on" || plan._tag === "direct" ? plan.fingerprint : NO_GATEWAY;

export class AiGatewaySessions extends Context.Service<
  AiGatewaySessions,
  {
    /**
     * Whether `driver`'s sessions of the Thread run on AI accounts: a driver that takes a base URL
     * (the gateway) or one that takes a direct credential, on a Hub with a usable AI account, or
     * always in a Sandbox or dedicated machine (whose logins are no longer used). Such a Thread
     * gets a provider process of its own.
     */
    readonly applies: (input: {
      readonly driver: ProviderDriverKind;
      readonly environmentId?: EnvironmentId | undefined;
    }) => Effect.Effect<boolean>;
    /** What a session of the Thread gets now; unreadable state refuses (fails closed). */
    readonly plan: (input: {
      readonly threadId: ThreadId;
      readonly driver: ProviderDriverKind;
      readonly modelSelection: ModelSelection;
      readonly target: GatewayTarget;
    }) => Effect.Effect<GatewayPlan>;
    /** The key of a session about to start its process, for its plan's owner, revoked with it. */
    readonly issue: (input: {
      readonly threadId: ThreadId;
      readonly providerSessionId: string;
      readonly plan: Extract<GatewayPlan, { readonly _tag: "on" }>;
    }) => Effect.Effect<GatewaySession, AiGatewayKeys.AiGatewayKeyError>;
    /**
     * The direct credential of a session about to start its process, read now and masked in the
     * Thread before the process can print it. Fails (never an empty value) when it is gone.
     */
    readonly issueDirect: (input: {
      readonly threadId: ThreadId;
      readonly plan: Extract<GatewayPlan, { readonly _tag: "direct" }>;
    }) => Effect.Effect<DirectSession, AiGatewaySessionError>;
    /** Revokes a session's key: it closed, or never opened (its process never started). */
    readonly release: (
      providerSessionId: string,
      reason?: "session-closed" | "session-not-opened",
    ) => Effect.Effect<void>;
  }
>()("t3/ai/AiGatewaySessions") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const spaces = yield* SpaceDirectory.SpaceDirectory;
  const allowedAccounts = yield* AllowedAiAccounts.AllowedAiAccounts;
  const accounts = yield* AiAccounts.AiAccounts;
  const keys = yield* AiGatewayKeys.AiGatewayKeys;
  const activity = yield* Effect.serviceOption(AiGatewayActivity.AiGatewayActivity);
  const masker = yield* Effect.serviceOption(SecretMasker.SecretMasker);

  // No session survives a Hub restart (each machine drops what the Hub no longer knows): the keys
  // issued for them stop working now.
  yield* keys
    .revokeLiveThreadKeys("hub-restarted")
    .pipe(
      Effect.catch((cause) =>
        Effect.logWarning("AiGatewaySessions: could not revoke earlier sessions' keys", { cause }),
      ),
    );

  /** A Sandbox or a dedicated machine: its volume's logins are never used. */
  const isolatedMachine = Effect.fn("AiGatewaySessions.isolatedMachine")(function* (
    environmentId: EnvironmentId | undefined,
  ) {
    if (environmentId === undefined || environmentId === HUB_MACHINE_ENVIRONMENT_ID) return false;
    const rows = yield* sql<{ readonly isolated: number }>`
      SELECT (kind = 'sandbox' OR mode IN ('sandbox', 'dedicated')) AS isolated
      FROM environments WHERE environment_id = ${environmentId}
    `.pipe(Effect.orElseSucceed(() => [{ isolated: 1 }]));
    // Unknown or unreadable: the side that never runs on a login.
    return rows[0] === undefined || rows[0].isolated === 1;
  });

  /**
   * A usable AI account on the Hub (not deleted, not disabled), of any type: once the Owner set
   * one up, every Hub turn runs on AI accounts, never on a login of the machine.
   */
  const hasAccounts = sql<{ readonly found: number }>`
    SELECT EXISTS (
      SELECT 1 FROM ai_accounts WHERE deleted_at IS NULL AND disabled = 0
    ) AS found
  `.pipe(
    Effect.map((rows) => rows[0]?.found === 1),
    Effect.orElseSucceed(() => true),
  );

  const applies = Effect.fn("AiGatewaySessions.applies")(function* (input: {
    readonly driver: ProviderDriverKind;
    readonly environmentId?: EnvironmentId | undefined;
  }) {
    if (!AI_GATEWAY_DRIVERS.has(input.driver) && !AI_DIRECT_DRIVERS.has(input.driver)) {
      return false;
    }
    if (yield* hasAccounts) return true;
    return yield* isolatedMachine(input.environmentId);
  });

  const refused = (error: AiGatewaySessionError): GatewayPlan => ({ _tag: "refused", error });

  /** Ticket 07: a direct driver's plan, from the accounts allowed to the owner in the Space. */
  const planDirect = Effect.fn("AiGatewaySessions.planDirect")(function* (input: {
    readonly driver: ProviderDriverKind;
    readonly modelSelection: ModelSelection;
    readonly ownerUserId: UserId;
    readonly spaceId: SpaceId;
    readonly allowed: ReadonlyArray<AllowedAiAccounts.AllowedAiAccount>;
  }) {
    const choice = yield* chooseAiAccount({
      driver: input.driver,
      allowed: input.allowed,
      chosen: input.modelSelection.aiAccountId,
      model: input.modelSelection.model,
      modelsOf: () => Effect.succeedNone,
      atTheDoor: false,
    });
    if (choice._tag === "refused") {
      return refused(
        new AiGatewaySessionError({
          reason: choice.reason === "no-ai-account" ? "no-ai-account" : "not-allowed",
        }),
      );
    }
    const account = choice.account;
    const variable = aiDirectVariableOf(input.driver, account.provider);
    const rows = yield* sql<{ readonly credentialId: string | null }>`
      SELECT credential_id AS "credentialId" FROM ai_accounts
      WHERE account_id = ${account.id} AND deleted_at IS NULL AND disabled = 0 AND type = 'direct'
    `.pipe(Effect.orElseSucceed(() => []));
    const credentialId = rows[0]?.credentialId ?? null;
    if (variable === undefined || credentialId === null) {
      return refused(new AiGatewaySessionError({ reason: "no-ai-account" }));
    }
    const model = input.modelSelection.model.trim();
    return {
      _tag: "direct",
      ownerUserId: input.ownerUserId,
      spaceId: input.spaceId,
      account: {
        id: account.id,
        name: account.name,
        provider: account.provider,
        model: model.length > 0 ? model : null,
      },
      variable,
      fingerprint: `direct\u0000${input.ownerUserId}\u0000${input.spaceId}\u0000${account.id}\u0000${credentialId}`,
    } satisfies GatewayPlan;
  });

  const plan = Effect.fn("AiGatewaySessions.plan")(function* (input: {
    readonly threadId: ThreadId;
    readonly driver: ProviderDriverKind;
    readonly modelSelection: ModelSelection;
    readonly target: GatewayTarget;
  }) {
    if (!(yield* applies({ driver: input.driver, environmentId: input.target.environmentId }))) {
      return { _tag: "off" } satisfies GatewayPlan;
    }
    const direct = AI_DIRECT_DRIVERS.has(input.driver);
    // A machine too old for the gateway (or for a direct credential) gets nothing, and says why.
    if (
      input.target.contractVersion <
      (direct ? AI_DIRECT_CONTRACT_VERSION : AI_GATEWAY_CONTRACT_VERSION)
    ) {
      const environmentName = yield* machineNameOf(sql, input.target.environmentId);
      return refused(
        new AiGatewaySessionError({
          reason: "outdated-machine",
          ...(environmentName === undefined ? {} : { environmentName }),
        }),
      );
    }
    // The Thread's turn owner in its Space now: the User every request of the key acts for.
    const space = yield* spaces
      .spaceOf({ kind: "thread", id: input.threadId })
      .pipe(Effect.orElseSucceed(() => Option.none()));
    const owner = yield* threadTurnOwner(sql, input.threadId).pipe(
      Effect.orElseSucceed(() => Option.none()),
    );
    if (Option.isNone(space) || Option.isNone(owner)) {
      return refused(new AiGatewaySessionError({ reason: "no-ai-account" }));
    }
    const everyAllowed = yield* allowedAccounts
      .for(owner.value, space.value.id)
      .pipe(Effect.orElseSucceed(() => []));
    if (direct) {
      return yield* planDirect({
        driver: input.driver,
        modelSelection: input.modelSelection,
        ownerUserId: owner.value,
        spaceId: space.value.id,
        allowed: everyAllowed,
      });
    }
    // Through the gateway only, in AllowedAiAccounts' order: what the gateway itself routes to.
    const choice = yield* chooseAiAccount({
      driver: input.driver,
      allowed: everyAllowed,
      chosen: input.modelSelection.aiAccountId,
      model: input.modelSelection.model,
      modelsOf: (accountId) =>
        accounts.modelsOf(accountId).pipe(
          Effect.asSome,
          Effect.orElseSucceed(() => Option.some([] as ReadonlyArray<string>)),
        ),
      atTheDoor: false,
    });
    if (choice._tag === "refused") {
      return refused(
        choice.reason === "model-not-served"
          ? new AiGatewaySessionError({ reason: "model-not-served", model: choice.model ?? "" })
          : new AiGatewaySessionError({
              reason: choice.reason === "no-ai-account" ? "no-ai-account" : "not-allowed",
            }),
      );
    }
    const account = choice.account;
    const served =
      input.modelSelection.model.trim().length > 0
        ? gatewayModelOf(input.modelSelection.model)
        : null;
    return {
      _tag: "on",
      ownerUserId: owner.value,
      spaceId: space.value.id,
      account: {
        id: account.id,
        name: account.name,
        provider: account.provider,
        model: served,
      },
      fingerprint: `${owner.value}\u0000${space.value.id}\u0000${account.id}`,
    } satisfies GatewayPlan;
  });

  const issue = Effect.fn("AiGatewaySessions.issue")(function* (input: {
    readonly threadId: ThreadId;
    readonly providerSessionId: string;
    readonly plan: Extract<GatewayPlan, { readonly _tag: "on" }>;
  }) {
    const issued = yield* keys.issueForThread(input.threadId, {
      providerSessionId: input.providerSessionId,
    });
    const account = input.plan.account;
    if (Option.isSome(activity) && account.model !== null) {
      yield* activity.value.noteInUse({
        threadId: input.threadId,
        accountId: account.id,
        model: account.model,
        provider: account.provider,
      });
    }
    return {
      access: {
        key: Redacted.value(issued.key),
        aiAccountId: account.id,
        aiAccountName: account.name ?? "",
        provider: account.provider,
        model: account.model,
      },
      account,
    } satisfies GatewaySession;
  });

  const issueDirect = Effect.fn("AiGatewaySessions.issueDirect")(function* (input: {
    readonly threadId: ThreadId;
    readonly plan: Extract<GatewayPlan, { readonly _tag: "direct" }>;
  }) {
    const credential = yield* accounts
      .directCredential(input.plan.account.id as AiAccountId)
      .pipe(Effect.mapError(() => new AiGatewaySessionError({ reason: "no-ai-account" })));
    const value = Redacted.value(credential.value);
    // Masked in the Thread before the process that gets it can print anything (spec 5, 05).
    if (Option.isSome(masker)) {
      yield* masker.value.remember(input.threadId, [
        {
          name: input.plan.variable,
          value,
          valueId: aiCredentialValueId(credential.credentialId),
        },
      ]);
    }
    return {
      variable: { name: input.plan.variable, value },
      account: input.plan.account,
    } satisfies DirectSession;
  });

  const release = Effect.fn("AiGatewaySessions.release")(function* (
    providerSessionId: string,
    reason: "session-closed" | "session-not-opened" = "session-not-opened",
  ) {
    yield* keys
      .revokeSession(providerSessionId, reason)
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("AiGatewaySessions: could not revoke a session's key", { cause }),
        ),
      );
  });

  return AiGatewaySessions.of({ applies, plan, issue, issueDirect, release });
});

export const layer = Layer.effect(AiGatewaySessions, make);
