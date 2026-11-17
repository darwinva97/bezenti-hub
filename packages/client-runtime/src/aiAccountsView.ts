/**
 * What a client shows of the Hub's AI accounts, as the Hub answered: the Owner's full list or a
 * User's narrowed one. Pure; no credential ever enters a row (the Hub sends none).
 */
import {
  type AiAccountDetails,
  type AiAccountListResult,
  type AiAccountStatus,
  type AiAccountId,
  type AiAccountSummary,
  type ModelSelection,
  sameResourceOwner,
  WS_METHODS,
} from "@t3tools/contracts";

import { AI_PROVIDER_LABEL } from "./aiAccountPicker.ts";

export const AI_ACCOUNT_STATUS_LABELS: Readonly<Record<AiAccountStatus, string>> = {
  pending: "Waiting for the AI gateway",
  working: "Working",
  unverified: "In the gateway, unverified",
  error: "Error",
  disabled: "Disabled",
  removing: "Still live in the gateway",
  "needs-sign-in": "Needs sign-in again",
  "quota-exhausted": "Quota exhausted",
};

/** A subscription's quota windows, as its provider reports them. */
export const quotaText = (details: AiAccountDetails | null | undefined): string | null =>
  details?.usageLimits == null || details.usageLimits.windows.length === 0
    ? null
    : `Quota: ${details.usageLimits.windows
        .map((window) => `${window.label} ${Math.round(window.usedPercent)}% used`)
        .join(", ")}.`;

export interface AiAccountRow {
  readonly id: string;
  readonly name: string;
  readonly providerLabel: string;
  readonly kindLabel: string;
  readonly priority: number;
  readonly status: AiAccountStatus;
  readonly statusLabel: string;
  readonly statusMessage: string | null;
  readonly disabled: boolean;
  readonly quota: string | null;
  readonly signedInAs: string | null;
}

const KIND_LABEL = {
  subscription: "Subscription",
  "api-key": "API key",
  direct: "Direct",
} as const;

/** The accounts first to last by their owner's priority, in words; read-only. */
export function accountRows(
  accounts: ReadonlyArray<AiAccountSummary>,
): ReadonlyArray<AiAccountRow> {
  return [...accounts]
    .sort((left, right) => left.priority - right.priority)
    .map((account) => ({
      id: account.id,
      name: account.name,
      providerLabel: AI_PROVIDER_LABEL[account.provider],
      kindLabel: KIND_LABEL[account.type],
      priority: account.priority,
      status: account.status,
      statusLabel: AI_ACCOUNT_STATUS_LABELS[account.status],
      statusMessage: account.statusMessage,
      disabled: account.disabled,
      quota: quotaText(account.details),
      signedInAs: account.details?.signedInAs ?? null,
    }));
}

export interface AiAccountSection {
  readonly title: string;
  readonly rows: ReadonlyArray<AiAccountRow>;
}

/**
 * The list by owner (owned-resources 08, 09): the viewer's own («Mine»), each Organization they
 * run, then what they may use of others', then (the Owner) everyone else's. Empty sections go.
 */
export function accountSections(
  list: Pick<AiAccountListResult, "accounts" | "owners">,
): ReadonlyArray<AiAccountSection> {
  const sections: Array<AiAccountSection> = [];
  const placed = new Set<string>();
  for (const option of list.owners ?? []) {
    const owned = list.accounts.filter(
      (account) =>
        account.canManage === true &&
        account.owner !== undefined &&
        sameResourceOwner(account.owner, option.owner),
    );
    for (const account of owned) placed.add(account.id);
    sections.push({
      title: option.owner.kind === "user" ? "Mine" : option.name,
      rows: accountRows(owned),
    });
  }
  const rest = list.accounts.filter((account) => !placed.has(account.id));
  sections.push({
    title: "You may use",
    rows: accountRows(rest.filter((account) => account.usableIn.length > 0)),
  });
  sections.push({
    title: "Other people's",
    rows: accountRows(rest.filter((account) => account.usableIn.length === 0)),
  });
  return sections.filter((section) => section.rows.length > 0);
}

/**
 * What the phone never calls: signing in, managing AI accounts and the gateway's update. They
 * stay on web and desktop (spec 4, «Clientes»); the Hub refuses them from a Member anyway.
 */
export const MOBILE_FORBIDDEN_AI_METHODS: ReadonlyArray<string> = [
  WS_METHODS.aiAccountsLoginStart,
  WS_METHODS.aiAccountsLoginComplete,
  WS_METHODS.aiAccountsImportVertex,
  WS_METHODS.aiAccountsImportCliproxy,
  WS_METHODS.aiAccountsCreate,
  WS_METHODS.aiAccountsUpdate,
  WS_METHODS.aiAccountsDelete,
  WS_METHODS.aiAccountsAllow,
  WS_METHODS.aiAccountsReorder,
  WS_METHODS.aiGatewayUpdate,
  WS_METHODS.aiGatewayRollback,
  WS_METHODS.aiGatewaySetEnabled,
];

/** The viewer's own keys: the Hub's list for the Owner holds everyone's, and Revoke is the Owner's there. */
export function ownKeys<K extends { readonly userId: string }>(
  keys: ReadonlyArray<K>,
  userId: string | null,
): ReadonlyArray<K> {
  return userId === null ? [] : keys.filter((key) => key.userId === userId);
}

/**
 * The selection the account strip reads. Mid-Thread the composer's draft selection (model, provider)
 * carries no account, so the account is the Thread's own; a new-task draft's selection stands.
 */
export function aiAccountSelection(input: {
  readonly isDraft: boolean;
  readonly thread: ModelSelection;
  readonly draft: ModelSelection | null | undefined;
}): ModelSelection {
  if (input.isDraft) return input.thread;
  const base = input.draft ?? input.thread;
  const { aiAccountId: _draftAccount, ...rest } = base;
  return input.thread.aiAccountId === undefined
    ? rest
    : { ...rest, aiAccountId: input.thread.aiAccountId };
}

export const withAiAccount = (
  selection: ModelSelection,
  aiAccountId: AiAccountId,
): ModelSelection => ({ ...selection, aiAccountId });
