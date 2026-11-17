/**
 * Spec 4 ticket 08: the one chooser of a Thread's AI account among those `AllowedAiAccounts`
 * gives its turn owner in its Space, shared by the session plan and the Thread doors: the
 * Thread's choice if allowed and compatible, else the first in AllowedAiAccounts' order. Never
 * another.
 */
import {
  AI_GATEWAY_DRIVERS,
  type AiAccountId,
  aiDirectVariableOf,
  type ProviderDriverKind,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { AllowedAiAccount } from "./AllowedAiAccounts.ts";

/** The model the gateway serves for a selection: without the gateway provider's `t3/`. */
export const gatewayModelOf = (model: string) => (model.startsWith("t3/") ? model.slice(3) : model);

/** Whether `driver`'s process can run on `account`: the gateway's, or a direct key it takes. */
export const isCompatibleAccount = (
  driver: ProviderDriverKind,
  account: Pick<AllowedAiAccount, "type" | "provider">,
): boolean =>
  AI_GATEWAY_DRIVERS.has(driver)
    ? account.type !== "direct"
    : account.type === "direct" && aiDirectVariableOf(driver, account.provider) !== undefined;

export type AiAccountChoiceRefusal =
  | "no-ai-account"
  | "not-allowed"
  | "not-compatible"
  | "model-not-served";

export type AiAccountChoiceResult =
  | { readonly _tag: "chosen"; readonly account: AllowedAiAccount; readonly defaulted: boolean }
  | {
      readonly _tag: "refused";
      readonly reason: AiAccountChoiceRefusal;
      readonly account?: AllowedAiAccount;
      readonly model?: string;
    };

export interface ChooseAiAccountInput {
  readonly driver: ProviderDriverKind;
  /** `AllowedAiAccounts.for(turn owner, Space)`, in its order (the Space owner's first). */
  readonly allowed: ReadonlyArray<AllowedAiAccount>;
  readonly chosen: AiAccountId | undefined;
  /** The selection's model; empty means "any". */
  readonly model: string;
  /** A gateway account's catalog; none when it cannot be read now. */
  readonly modelsOf: (
    accountId: AiAccountId,
  ) => Effect.Effect<Option.Option<ReadonlyArray<string>>>;
  /**
   * Also refuse a chosen gateway account whose (readable) catalog lacks the model, and default to
   * the first compatible account when no catalog can be read (the doors). The session plan keeps
   * its own stricter default (an unreadable catalog serves nothing).
   */
  readonly atTheDoor: boolean;
}

export const chooseAiAccount = Effect.fn("chooseAiAccount")(function* (
  input: ChooseAiAccountInput,
) {
  const gateway = AI_GATEWAY_DRIVERS.has(input.driver);
  const model = input.model.trim();
  const served = model.length === 0 ? null : gatewayModelOf(model);
  if (input.chosen !== undefined) {
    const account = input.allowed.find((candidate) => candidate.id === input.chosen);
    // Never another account in its place: the Thread chose this one.
    if (account === undefined) {
      return { _tag: "refused", reason: "not-allowed" } satisfies AiAccountChoiceResult;
    }
    if (!isCompatibleAccount(input.driver, account)) {
      return { _tag: "refused", reason: "not-compatible", account } satisfies AiAccountChoiceResult;
    }
    if (input.atTheDoor && gateway && served !== null) {
      const models = yield* input.modelsOf(account.id);
      if (Option.isSome(models) && !models.value.includes(served)) {
        return {
          _tag: "refused",
          reason: "model-not-served",
          account,
          model: served,
        } satisfies AiAccountChoiceResult;
      }
    }
    return { _tag: "chosen", account, defaulted: false } satisfies AiAccountChoiceResult;
  }
  const usable = input.allowed.filter((account) => isCompatibleAccount(input.driver, account));
  if (usable.length === 0) {
    return { _tag: "refused", reason: "no-ai-account" } satisfies AiAccountChoiceResult;
  }
  if (!gateway || served === null) {
    return { _tag: "chosen", account: usable[0]!, defaulted: true } satisfies AiAccountChoiceResult;
  }
  let unknown: AllowedAiAccount | undefined;
  for (const candidate of usable) {
    const models = yield* input.modelsOf(candidate.id);
    if (Option.isNone(models)) {
      unknown ??= candidate;
      continue;
    }
    if (models.value.includes(served)) {
      return {
        _tag: "chosen",
        account: candidate,
        defaulted: true,
      } satisfies AiAccountChoiceResult;
    }
  }
  if (input.atTheDoor && unknown !== undefined) {
    return { _tag: "chosen", account: unknown, defaulted: true } satisfies AiAccountChoiceResult;
  }
  return {
    _tag: "refused",
    reason: "model-not-served",
    model: served,
  } satisfies AiAccountChoiceResult;
});
