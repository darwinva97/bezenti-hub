/**
 * Spec 4 ticket 08: on a Hub whose turns run on AI accounts, a provider is usable only with an
 * account allowed to the User in the Thread's Space, never with the machine's own login. The
 * Hub decides and refuses on its own; this only shows the same rule in the picker.
 */
import {
  AI_DIRECT_DRIVERS,
  AI_GATEWAY_DRIVERS,
  type AiAccountId,
  type AiAccountPickerAccount,
  type AiAccountPickerResult,
  type AiAccountProvider,
  type ModelSelection,
  type ProviderSessionAiAccount,
  aiDirectVariableOf,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";

import type { ThreadStructure } from "./state/shell.ts";

/** Whether `driver`'s process can run on `account` (the Hub's `isCompatibleAccount`). */
function isAiAccountCompatible(
  driver: string,
  account: Pick<AiAccountPickerAccount, "type" | "provider">,
): boolean {
  return AI_GATEWAY_DRIVERS.has(driver)
    ? account.type !== "direct"
    : account.type === "direct" && aiDirectVariableOf(driver, account.provider) !== undefined;
}

/** Whether AI accounts decide `driver`'s availability here. */
export function aiAccountsDecide(
  driver: string,
  picker: AiAccountPickerResult | null | undefined,
): picker is AiAccountPickerResult {
  return (
    picker != null &&
    picker.applies &&
    (AI_GATEWAY_DRIVERS.has(driver) || AI_DIRECT_DRIVERS.has(driver))
  );
}

/** The accounts `driver` can use, first to last by the Installation's priority. */
export function aiAccountsFor(
  driver: string,
  picker: AiAccountPickerResult | null | undefined,
): ReadonlyArray<AiAccountPickerAccount> {
  if (!aiAccountsDecide(driver, picker)) return [];
  return picker.accounts.filter((account) => isAiAccountCompatible(driver, account));
}

/** The model the gateway serves for a selection: without the gateway provider's `t3/`. */
const servedModelOf = (model: string) => (model.startsWith("t3/") ? model.slice(3) : model);

/** Whether `account` serves `model` (a direct account: its agent's own catalog, so yes). */
export function aiAccountServes(account: AiAccountPickerAccount, model: string): boolean {
  return account.models === null || account.models.includes(servedModelOf(model));
}

/**
 * The account a selection runs on: `preferred` while it fits the driver and the model, else the
 * first allowed that does (what the Hub defaults to). Undefined: none.
 */
export function resolveAiAccount(input: {
  readonly driver: string;
  readonly model: string;
  readonly picker: AiAccountPickerResult | null | undefined;
  readonly preferred: AiAccountId | null | undefined;
}): AiAccountPickerAccount | undefined {
  const usable = aiAccountsFor(input.driver, input.picker);
  const preferred = usable.find((account) => account.id === input.preferred);
  if (preferred !== undefined && aiAccountServes(preferred, input.model)) return preferred;
  return usable.find((account) => aiAccountServes(account, input.model));
}

const FAMILY_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^claude/iu, "Claude"],
  [/^gemini/iu, "Gemini"],
  [/^(gpt|o\d|codex|chatgpt)/iu, "OpenAI"],
  [/^grok/iu, "xAI"],
  [/^kimi/iu, "Kimi"],
  [/^(deepseek)/iu, "DeepSeek"],
  [/^(muse|llama)/iu, "Meta"],
];

/** A model's family by its name ("Gemini" for `gemini-3-pro`); undefined when unknown. */
export function modelFamilyOf(model: string): string | undefined {
  const plain = servedModelOf(model).split("/").at(-1) ?? model;
  return FAMILY_PATTERNS.find(([pattern]) => pattern.test(plain))?.[1];
}

const NATIVE_FAMILY: Readonly<Record<string, string>> = {
  claudeAgent: "Claude",
  codex: "OpenAI",
};

export const AI_PROVIDER_LABEL: Readonly<Record<AiAccountProvider, string>> = {
  claude: "Claude",
  codex: "ChatGPT",
  antigravity: "Antigravity",
  kimi: "Kimi",
  xai: "xAI",
  devin: "Devin",
  meta: "Meta",
  gemini: "Gemini",
  vertex: "Vertex",
  "openai-compatible": "OpenAI-compatible",
  cursor: "Cursor",
  kiro: "Kiro",
  fx: "Fx",
};

/** How an account is named to someone who may not see its name. */
export function aiAccountFallbackName(provider: AiAccountProvider): string {
  return `${AI_PROVIDER_LABEL[provider]} account`;
}

/** The models a gateway provider offers here: every allowed account's, other families labeled. */
function gatewayModelsOf(
  provider: ServerProvider,
  accounts: ReadonlyArray<AiAccountPickerAccount>,
): ReadonlyArray<ServerProviderModel> {
  const known = new Map(provider.models.map((model) => [servedModelOf(model.slug), model]));
  const native = NATIVE_FAMILY[provider.driver];
  const seen = new Set<string>();
  const models: Array<ServerProviderModel> = [];
  // An account whose catalog the Hub could not read (null): the agent's own models stand in.
  if (accounts.some((account) => account.models === null)) {
    for (const model of provider.models) {
      seen.add(servedModelOf(model.slug));
      models.push(model);
    }
  }
  for (const account of accounts) {
    for (const slug of account.models ?? []) {
      if (seen.has(slug)) continue;
      seen.add(slug);
      const family = modelFamilyOf(slug);
      const existing = known.get(slug);
      const subProvider = family !== undefined && family !== native ? family : undefined;
      models.push(
        existing ?? {
          slug,
          name: slug,
          isCustom: false,
          capabilities: null,
          ...(subProvider === undefined ? {} : { subProvider }),
        },
      );
    }
  }
  return models;
}

/**
 * The providers as the composer offers them when AI accounts decide: ready with an allowed
 * account (its models for a gateway agent), else unusable with the reason; the machine's own
 * login (its auth status, sign-in prompts) never counts. An account does not put an agent on a
 * machine that lacks it (`providersOnEnvironment`).
 */
export function applyAiAccountsToProviders(
  providers: ReadonlyArray<ServerProvider>,
  picker: AiAccountPickerResult | null | undefined,
): ReadonlyArray<ServerProvider> {
  if (picker == null || !picker.applies) return providers;
  return providers.map((provider) => {
    if (
      !aiAccountsDecide(provider.driver, picker) ||
      !provider.enabled ||
      provider.availability === "unavailable"
    ) {
      return provider;
    }
    const accounts = aiAccountsFor(provider.driver, picker);
    const { setup: _setup, message: _message, ...withoutSetup } = provider;
    if (accounts.length === 0) {
      return {
        ...withoutSetup,
        status: "error",
        auth: { status: "unknown" },
        message: `No AI account is allowed for you in ${picker.spaceName ?? "this Space"}.`,
      };
    }
    const gateway = AI_GATEWAY_DRIVERS.has(provider.driver);
    return {
      ...withoutSetup,
      status: provider.installed ? "ready" : provider.status,
      availability: "available",
      auth: { status: "authenticated", label: "Hub AI accounts" },
      ...(provider.installed || provider.message === undefined
        ? {}
        : { message: provider.message }),
      models: gateway ? gatewayModelsOf(provider, accounts) : provider.models,
    };
  });
}

/**
 * The Hub AI account the Thread's live provider session runs on (spec 4 ticket 06): its latest
 * session of the Thread's provider instance, while it has not stopped.
 */
export function deriveThreadAiAccount(projection: ThreadStructure | null) {
  if (projection === null) return null;
  const session = projection.providerSessions.findLast(
    (candidate) => candidate.providerInstanceId === projection.thread.providerInstanceId,
  );
  if (session === undefined || session.status === "stopped") return null;
  return session.aiAccount ?? null;
}

/** The AI account the Thread's header shows: named only from the viewer's own picker. */
export interface ThreadAiAccountLabel {
  readonly id: string;
  readonly name: string;
  readonly provider: AiAccountProvider;
  readonly model: string | null;
}

/**
 * Spec 4 ticket 08: the account in use (its live session's, kept current after a failover), else
 * the one the Thread chose; its name from the accounts this viewer may use, else its provider's.
 */
export function nameThreadAiAccount(input: {
  readonly session: ProviderSessionAiAccount | null;
  readonly threadSelection: ModelSelection | null | undefined;
  readonly picker: AiAccountPickerResult | null | undefined;
}): ThreadAiAccountLabel | null {
  const known = (id: string) => input.picker?.accounts.find((account) => account.id === id);
  if (input.session !== null) {
    const account = known(input.session.id);
    return {
      id: input.session.id,
      name: account?.name ?? aiAccountFallbackName(input.session.provider),
      provider: input.session.provider,
      model: input.session.model,
    };
  }
  const chosen = input.threadSelection?.aiAccountId;
  const account = chosen === undefined ? undefined : known(chosen);
  if (account === undefined || input.threadSelection == null) return null;
  return {
    id: account.id,
    name: account.name,
    provider: account.provider,
    model: input.threadSelection.model,
  };
}
