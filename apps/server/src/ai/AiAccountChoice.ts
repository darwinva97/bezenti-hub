/**
 * Spec 4 ticket 08: the AI account of a Thread's selection at every door that creates or continues
 * it (`ThreadManagementService.dispatch`), and the composer's picker. A named account must pass
 * `chooseAiAccount` for the turn owner; none: the Thread's own, else the default. See
 * docs/internals/ai-gateway.md, «The AI account of a Thread».
 */
import {
  AI_DIRECT_DRIVERS,
  AI_GATEWAY_DRIVERS,
  AiAccountChoiceError,
  AiAccountError,
  type AiAccountId,
  type AiAccountPickerInput,
  type AiAccountPickerResult,
  type EnvironmentId,
  type ModelSelection,
  type OrchestrationV2ServerCommand,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type SpaceId,
  type ThreadId,
  type UserId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as CommandActor from "../auth/CommandActor.ts";
import { threadAccessOf } from "../orchestration-v2/commandAccess.ts";
import { threadTurnOwner } from "../orchestration-v2/threadTurnOwner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as AiAccounts from "./AiAccounts.ts";
import * as AiGatewaySessions from "./AiGatewaySessions.ts";
import * as AllowedAiAccounts from "./AllowedAiAccounts.ts";
import { chooseAiAccount, isCompatibleAccount } from "./chooseAiAccount.ts";
import * as GrantCaps from "./GrantCaps.ts";

export class AiAccountChoice extends Context.Service<
  AiAccountChoice,
  {
    /**
     * A command that creates or continues a Thread, with its selection's AI account checked and,
     * when omitted, filled in. Anything else passes unchanged.
     */
    readonly settle: (
      command: OrchestrationV2ServerCommand,
      /** The driver of an instance wherever it runs (a Sandbox's own included); none: unknown. */
      resolveDriver?: (
        instanceId: ProviderInstanceId,
        environmentId: EnvironmentId | undefined,
      ) => Effect.Effect<Option.Option<ProviderDriverKind>>,
    ) => Effect.Effect<
      OrchestrationV2ServerCommand,
      AiAccountChoiceError | SpaceDirectory.ItemAccessError
    >;
    /** The composer's picker for the session's User in one Space. */
    readonly picker: (
      input: AiAccountPickerInput,
    ) => Effect.Effect<AiAccountPickerResult, AiAccountError>;
  }
>()("t3/ai/AiAccountChoice") {}

/** Where a command's Thread runs and for whom: what its account is decided against. */
interface ThreadFacts {
  readonly ownerUserId: UserId;
  readonly spaceId: SpaceId;
  readonly environmentId: EnvironmentId | undefined;
  /** The Thread's provider instance and account now (absent for a new Thread). */
  readonly current:
    | { readonly instanceId: string; readonly aiAccountId: AiAccountId | undefined }
    | undefined;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const spaces = yield* SpaceDirectory.SpaceDirectory;
  const allowedAccounts = yield* AllowedAiAccounts.AllowedAiAccounts;
  const accounts = yield* AiAccounts.AiAccounts;
  const sessions = yield* AiGatewaySessions.AiGatewaySessions;
  const settings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
  // Grants ticket 03: how much of a lent account's caps is used, for the picker.
  const caps = yield* Effect.serviceOption(GrantCaps.GrantCaps);
  const capsOf = Effect.fn("AiAccountChoice.capsOf")(function* (
    via: Extract<AllowedAiAccounts.AllowedVia, { readonly kind: "grant" }>,
  ) {
    if (Option.isNone(caps) || (via.limits.tokens === null && via.limits.requests === null)) {
      return {};
    }
    const state = yield* caps.value.check(via.grantId, via.limits).pipe(Effect.option);
    if (Option.isNone(state)) return {};
    return { caps: { tokens: state.value.tokens, requests: state.value.requests } };
  });
  /**
   * The driver of a provider instance: where it runs (the routed registry), else the Hub's
   * settings; a default instance's id is its driver's.
   */
  const driverOf = Effect.fn("AiAccountChoice.driverOf")(function* (
    instanceId: ProviderInstanceId,
    environmentId: EnvironmentId | undefined,
    resolveDriver:
      | ((
          instanceId: ProviderInstanceId,
          environmentId: EnvironmentId | undefined,
        ) => Effect.Effect<Option.Option<ProviderDriverKind>>)
      | undefined,
  ) {
    if (resolveDriver !== undefined) {
      const resolved = yield* resolveDriver(instanceId, environmentId);
      if (Option.isSome(resolved)) return resolved;
    }
    if (Option.isSome(settings)) {
      const current = yield* settings.value.getSettings.pipe(Effect.option);
      const configured = Option.isSome(current)
        ? current.value.providerInstances[instanceId]
        : undefined;
      if (configured !== undefined) return Option.some(configured.driver);
    }
    // A default instance's id is its driver's.
    return AI_GATEWAY_DRIVERS.has(instanceId) || AI_DIRECT_DRIVERS.has(instanceId)
      ? Option.some(instanceId as unknown as ProviderDriverKind)
      : Option.none<ProviderDriverKind>();
  });

  const modelsOf = (accountId: AiAccountId) =>
    accounts.modelsOf(accountId).pipe(
      Effect.asSome,
      Effect.orElseSucceed(() => Option.none<ReadonlyArray<string>>()),
    );

  /** An existing Thread's turn owner, Space, machine and selection; none when not known. */
  const threadFacts = Effect.fn("AiAccountChoice.threadFacts")(function* (threadId: ThreadId) {
    const rows = yield* sql<{
      readonly instanceId: string | null;
      readonly aiAccountId: string | null;
      readonly environmentId: string | null;
    }>`
      SELECT json_extract(payload_json, '$.modelSelection.instanceId') AS "instanceId",
        json_extract(payload_json, '$.modelSelection.aiAccountId') AS "aiAccountId",
        json_extract(payload_json, '$.activeEnvironmentId') AS "environmentId"
      FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
    `;
    const row = rows[0];
    if (row === undefined) return Option.none<ThreadFacts>();
    const space = yield* spaces.spaceOf({ kind: "thread", id: threadId });
    const owner = yield* threadTurnOwner(sql, threadId);
    if (Option.isNone(space) || Option.isNone(owner)) return Option.none<ThreadFacts>();
    const current =
      row.instanceId === null
        ? undefined
        : {
            instanceId: row.instanceId,
            aiAccountId: (row.aiAccountId ?? undefined) as AiAccountId | undefined,
          };
    return Option.some<ThreadFacts>({
      ownerUserId: owner.value,
      spaceId: space.value.id,
      environmentId: (row.environmentId ?? undefined) as EnvironmentId | undefined,
      current,
    });
  });

  const refuse = (reason: AiAccountChoiceError["reason"], message: string) =>
    Effect.fail(new AiAccountChoiceError({ reason, message }));

  /** The selection a command goes on with, or why it is refused. */
  const settleSelection = Effect.fn("AiAccountChoice.settleSelection")(function* (
    selection: ModelSelection,
    facts: ThreadFacts,
    resolveDriver:
      | ((
          instanceId: ProviderInstanceId,
          environmentId: EnvironmentId | undefined,
        ) => Effect.Effect<Option.Option<ProviderDriverKind>>)
      | undefined,
  ) {
    const knownDriver = yield* driverOf(selection.instanceId, facts.environmentId, resolveDriver);
    if (Option.isNone(knownDriver)) {
      // Never skip the check for an instance nobody can describe now (its machine away).
      if (selection.aiAccountId === undefined) return selection;
      return yield* refuse(
        "unavailable",
        "Could not tell which provider this Thread uses. Try again once its machine is online.",
      );
    }
    const driver = knownDriver.value;
    const applies = yield* sessions.applies({
      driver,
      ...(facts.environmentId === undefined ? {} : { environmentId: facts.environmentId }),
    });
    if (!applies) return selection;
    const named = selection.aiAccountId;
    if (named === undefined) {
      // A client that names none goes on with the Thread's own account on the same provider;
      // the session plan refuses it there if it is no longer allowed («Switch AI account»).
      const kept = facts.current?.aiAccountId;
      if (kept !== undefined && facts.current?.instanceId === selection.instanceId) {
        return { ...selection, aiAccountId: kept };
      }
    }
    const allowed = yield* allowedAccounts
      .for(facts.ownerUserId, facts.spaceId)
      .pipe(
        Effect.catch(() =>
          named === undefined
            ? Effect.succeed([] as ReadonlyArray<AllowedAiAccounts.AllowedAiAccount>)
            : refuse("unavailable", "Could not read the AI accounts allowed here. Try again."),
        ),
      );
    const choice = yield* chooseAiAccount({
      driver,
      allowed,
      chosen: named,
      model: selection.model,
      modelsOf,
      atTheDoor: true,
    });
    if (choice._tag === "chosen") return { ...selection, aiAccountId: choice.account.id };
    // Nothing named and nothing to default to: the selection goes on as it is and the session
    // plan says why when a turn starts (the composer says it before sending).
    if (named === undefined) return selection;
    switch (choice.reason) {
      case "not-compatible":
        return yield* refuse("not-compatible", "This AI account cannot be used by this provider.");
      case "model-not-served":
        return yield* refuse(
          "model-not-served",
          `This AI account does not serve ${choice.model ?? "this model"}.`,
        );
      default:
        return yield* refuse(
          "not-allowed",
          "This AI account is not allowed for this Thread in its Space.",
        );
    }
  });

  const facts = Effect.fn("AiAccountChoice.facts")(function* (
    command: OrchestrationV2ServerCommand,
  ) {
    switch (command.type) {
      case "thread.create":
        // Claimed and placed before: the creator owns it, in the Project's Space.
        return command.ownerUserId === undefined || command.spaceId === undefined
          ? Option.none<ThreadFacts>()
          : Option.some<ThreadFacts>({
              ownerUserId: command.ownerUserId,
              spaceId: command.spaceId,
              environmentId: command.activeEnvironmentId,
              current: undefined,
            });
      case "message.dispatch":
      case "thread.model-selection.set":
      case "provider.switch":
        return yield* threadFacts(command.threadId);
      case "delegated_task.request": {
        // A child Thread runs for its parent's turn owner, in the parent's Space and machine.
        const parent = yield* threadFacts(command.parentThreadId);
        return Option.map(parent, (found) => ({ ...found, current: undefined }));
      }
      default:
        return Option.none<ThreadFacts>();
    }
  });

  const settle = Effect.fn("AiAccountChoice.settle")(function* (
    command: OrchestrationV2ServerCommand,
    resolveDriver?: (
      instanceId: ProviderInstanceId,
      environmentId: EnvironmentId | undefined,
    ) => Effect.Effect<Option.Option<ProviderDriverKind>>,
  ) {
    const selection =
      command.type === "thread.create" ||
      command.type === "thread.model-selection.set" ||
      command.type === "provider.switch" ||
      command.type === "delegated_task.request" ||
      command.type === "message.dispatch"
        ? command.modelSelection
        : undefined;
    if (selection === undefined) return command;
    const found = yield* facts(command).pipe(
      Effect.catch(() =>
        selection.aiAccountId === undefined
          ? Effect.succeed(Option.none<ThreadFacts>())
          : refuse("unavailable", "Could not read this Thread's Space. Try again."),
      ),
    );
    // No owner or Space known (server work, a host without Spaces): the session plan decides.
    if (Option.isNone(found)) return command;
    // The Role rules first (as the orchestrator applies them), so a User who may not continue
    // the Thread learns nothing about which accounts its owner may use.
    const actor = yield* CommandActor.current;
    if (actor !== undefined) {
      for (const access of threadAccessOf(command)) {
        yield* spaces.authorizeItem(actor, access.action, { kind: "thread", id: access.threadId });
      }
    }
    const settled = yield* settleSelection(selection, found.value, resolveDriver);
    return settled === selection
      ? command
      : ({ ...command, modelSelection: settled } as OrchestrationV2ServerCommand);
  });

  const picker = Effect.fn("AiAccountChoice.picker")(function* (input: AiAccountPickerInput) {
    const userId = yield* CommandActor.current;
    if (userId === undefined) {
      return yield* new AiAccountError({
        reason: "forbidden",
        message: "Sign in to pick an AI account.",
      });
    }
    const failed = () =>
      new AiAccountError({ reason: "unavailable", message: "Could not read your AI accounts." });
    const applies = yield* sessions.applies({
      driver: "claudeAgent" as ProviderDriverKind,
      ...(input.environmentId === undefined ? {} : { environmentId: input.environmentId }),
    });
    // A session limited to one Space sees nothing of another.
    const limit = yield* CommandActor.spaceLimit;
    if (limit !== undefined && limit !== input.spaceId) {
      return { applies, spaceName: null, accounts: [] } satisfies AiAccountPickerResult;
    }
    const working = yield* allowedAccounts
      .workingSpaces(userId, [input.spaceId])
      .pipe(Effect.mapError(failed));
    const space = working.get(input.spaceId);
    if (space === undefined) {
      return { applies, spaceName: null, accounts: [] } satisfies AiAccountPickerResult;
    }
    const allowed = yield* allowedAccounts.for(userId, input.spaceId).pipe(Effect.mapError(failed));
    const listed = yield* Effect.forEach(allowed, (account) =>
      Effect.gen(function* () {
        const gateway = isCompatibleAccount("claudeAgent" as ProviderDriverKind, account);
        // Unknown (catalog unreadable) is null like a direct one's: the client offers its
        // agent's own models then, and the Hub still checks at the door and per request.
        const models = gateway ? Option.getOrNull(yield* modelsOf(account.id)) : null;
        return {
          id: account.id,
          name: account.name,
          type: account.type,
          provider: account.provider,
          priority: account.priority,
          models,
          ...(account.via.kind === "grant"
            ? {
                lentBy: {
                  grantId: account.via.grantId,
                  name: account.via.lenderName,
                  ...(yield* capsOf(account.via)),
                },
              }
            : {}),
        };
      }),
    );
    return { applies, spaceName: space.name, accounts: listed } satisfies AiAccountPickerResult;
  });

  return AiAccountChoice.of({ settle, picker });
});

export const layer = Layer.effect(AiAccountChoice, make);
