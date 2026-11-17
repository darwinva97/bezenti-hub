/**
 * AI accounts: subscriptions and API keys kept on the Hub, each a User's or an Organization's. A
 * credential enters only in `create`/`update` (Redacted) and never leaves the Hub: no RPC returns
 * it, not to its owner either, who sees its last four characters at most.
 */
import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  makeEntityId,
  SpaceId,
  ThreadId,
  TrimmedNonEmptyString,
  UserId,
} from "./baseSchemas.ts";
import { GrantCapState } from "./grantCaps.ts";
import { ResourceOwner } from "./ownership.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { ServerProviderUsageLimits } from "./providerUsageLimits.ts";

export const AiAccountId = makeEntityId("AiAccountId");
export type AiAccountId = typeof AiAccountId.Type;

/**
 * `subscription`: an OAuth login in CLIProxyAPI (ticket 03). `api-key`: an API key the gateway
 * uses, which never enters a Sandbox. `direct`: a revocable credential handed to an agent whose
 * provider takes no base URL (ticket 07).
 */
export const AiAccountType = Schema.Literals(["subscription", "api-key", "direct"]);
export type AiAccountType = typeof AiAccountType.Type;

export const AiAccountProvider = Schema.Literals([
  "claude",
  "codex",
  "antigravity",
  "kimi",
  "xai",
  "devin",
  "meta",
  "gemini",
  "vertex",
  "openai-compatible",
  "cursor",
  "kiro",
  "fx",
]);
export type AiAccountProvider = typeof AiAccountProvider.Type;

/** The providers an API-key AI account is for, each with its own block in CLIProxyAPI. */
const AI_API_KEY_PROVIDERS = [
  "claude",
  "codex",
  "gemini",
  "vertex",
  "xai",
  "meta",
  "openai-compatible",
] as const satisfies ReadonlyArray<AiAccountProvider>;
export const AiApiKeyProvider = Schema.Literals(AI_API_KEY_PROVIDERS);
export type AiApiKeyProvider = typeof AiApiKeyProvider.Type;

/**
 * The providers a direct AI account is for (ticket 07): an API key handed to an agent whose CLI
 * takes no base URL (`AI_DIRECT_DRIVERS` names which agent gets it, under which variable). Never a
 * subscription login.
 */
const AI_DIRECT_PROVIDERS = [
  "gemini",
  "vertex",
  "cursor",
  "kiro",
  "fx",
  "meta",
  "devin",
  "xai",
] as const satisfies ReadonlyArray<AiAccountProvider>;
export const AiDirectProvider = Schema.Literals(AI_DIRECT_PROVIDERS);
export type AiDirectProvider = typeof AiDirectProvider.Type;
export const isAiDirectProvider = Schema.is(AiDirectProvider);
export const isAiApiKeyProvider = Schema.is(AiApiKeyProvider);

/**
 * The providers a subscription AI account signs in to through CLIProxyAPI (OAuth), plus Vertex,
 * whose service account is imported (ticket 03).
 */
const AI_SUBSCRIPTION_PROVIDERS = [
  "claude",
  "codex",
  "antigravity",
  "kimi",
  "xai",
  "devin",
  "meta",
] as const satisfies ReadonlyArray<AiAccountProvider>;
export const AiSubscriptionProvider = Schema.Literals(AI_SUBSCRIPTION_PROVIDERS);
export type AiSubscriptionProvider = typeof AiSubscriptionProvider.Type;

/**
 * `unverified`: in the gateway, model list unreadable. `removing`: deleted, its key maybe still
 * live in the gateway. `needs-sign-in` and `quota-exhausted`: subscriptions (ticket 03).
 */
export const AiAccountStatus = Schema.Literals([
  "pending",
  "working",
  "unverified",
  "error",
  "disabled",
  "removing",
  "needs-sign-in",
  "quota-exhausted",
]);
export type AiAccountStatus = typeof AiAccountStatus.Type;

/** Who an AI account is allowed to: the Users who work in a Space, or one User. */
export const AiAccountAllowances = Schema.Struct({
  spaceIds: Schema.Array(SpaceId),
  userIds: Schema.Array(UserId),
});
export type AiAccountAllowances = typeof AiAccountAllowances.Type;

/** Its manager's view (its owner, or an Organization's Admins): everything but the credential. */
export const AiAccountDetails = Schema.Struct({
  /** The last four characters of the key; null when it is too short to show any. */
  keyHint: Schema.NullOr(Schema.String),
  /** `openai-compatible`: where the provider answers. */
  baseUrl: Schema.NullOr(Schema.String),
  /** `openai-compatible`: the models the Owner listed. */
  models: Schema.Array(Schema.String),
  allowances: AiAccountAllowances,
  /** A subscription: the account the provider says it signed in as (an email), when it says. */
  signedInAs: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** A Claude or Codex subscription: its quota windows, when the provider reports them. */
  usageLimits: Schema.optionalKey(Schema.NullOr(ServerProviderUsageLimits)),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type AiAccountDetails = typeof AiAccountDetails.Type;

/**
 * An AI account as a User sees it. Everyone sees the name, provider and status of the accounts
 * they may use in their Spaces (`usableIn`); whoever manages it also gets `details`; the Owner
 * sees every other account's name, provider, owner and status, never its details.
 */
export const AiAccountSummary = Schema.Struct({
  id: AiAccountId,
  name: Schema.String,
  type: AiAccountType,
  provider: AiAccountProvider,
  /** 1 is tried first, among its owner's accounts (owned-resources 08). */
  priority: Schema.Number,
  status: AiAccountStatus,
  statusMessage: Schema.NullOr(Schema.String),
  disabled: Schema.Boolean,
  /** The Spaces where this User may use it (not filled in for the Owner's full list). */
  usableIn: Schema.Array(SpaceId),
  details: Schema.NullOr(AiAccountDetails),
  /** Whose it is: a User's or an Organization's. Absent from older Hubs (then the Owner's). */
  owner: Schema.optionalKey(ResourceOwner),
  /** Whether the viewer renames, disables, replaces, orders and deletes it. Absent from older Hubs. */
  canManage: Schema.optionalKey(Schema.Boolean),
});
export type AiAccountSummary = typeof AiAccountSummary.Type;

/** An owner the viewer may add AI accounts for: themselves, or an Organization they run. */
export const AiAccountOwnerOption = Schema.Struct({
  owner: ResourceOwner,
  name: Schema.String,
});
export type AiAccountOwnerOption = typeof AiAccountOwnerOption.Type;

export const AiAccountListInput = Schema.Struct({});
export type AiAccountListInput = typeof AiAccountListInput.Type;
export const AiAccountListResult = Schema.Struct({
  accounts: Schema.Array(AiAccountSummary),
  /**
   * Whether this session runs the Installation's AI gateway (the Owner, not limited to one Space):
   * allowances, imports and the gateway itself. Each account says whether it is the viewer's to
   * manage (`canManage`).
   */
  canManage: Schema.Boolean,
  /** Who the viewer may add AI accounts for, themselves first. Absent from older Hubs. */
  owners: Schema.optionalKey(Schema.Array(AiAccountOwnerOption)),
});
export type AiAccountListResult = typeof AiAccountListResult.Type;

const AiAccountName = TrimmedNonEmptyString.check(Schema.isMaxLength(80));
/** A credential going into the Hub: Redacted, so no log, span or error shows it. */
const AiCredentialInput = Schema.RedactedFromValue(Schema.String);
const AiBaseUrl = TrimmedNonEmptyString.check(Schema.isMaxLength(500));
const AiModelName = TrimmedNonEmptyString.check(Schema.isMaxLength(200));

/** A credential is UTF-8 text without spaces or control characters, at most this long. */
export const AI_CREDENTIAL_MAX_LENGTH = 8 * 1024;

export const AiAccountCreateInput = Schema.Struct({
  name: AiAccountName,
  /**
   * `api-key` (the default): used by the gateway, never enters a Sandbox. `direct`: handed to the
   * agent as an environment variable, so it is visible to it (ticket 07); `provider` must then be
   * an `AiDirectProvider`, and the credential an API key (never a subscription login).
   */
  type: Schema.optionalKey(Schema.Literals(["api-key", "direct"])),
  provider: Schema.Literals([...new Set([...AI_API_KEY_PROVIDERS, ...AI_DIRECT_PROVIDERS])]),
  apiKey: AiCredentialInput,
  /** Required for `openai-compatible`; its `/v1` base URL. */
  baseUrl: Schema.optionalKey(AiBaseUrl),
  /** Required for `openai-compatible`: the models it serves. */
  models: Schema.optionalKey(Schema.Array(AiModelName).check(Schema.isMaxLength(200))),
  /** Whose it becomes: the caller themselves when omitted, or an Organization they run. */
  owner: Schema.optionalKey(ResourceOwner),
});
export type AiAccountCreateInput = typeof AiAccountCreateInput.Type;

/** Rename, disable or enable, «Replace credential», or (`openai-compatible`) its URL and models. */
export const AiAccountUpdateInput = Schema.Struct({
  accountId: AiAccountId,
  name: Schema.optionalKey(AiAccountName),
  disabled: Schema.optionalKey(Schema.Boolean),
  apiKey: Schema.optionalKey(AiCredentialInput),
  baseUrl: Schema.optionalKey(AiBaseUrl),
  models: Schema.optionalKey(Schema.Array(AiModelName).check(Schema.isMaxLength(200))),
});
export type AiAccountUpdateInput = typeof AiAccountUpdateInput.Type;

export const AiAccountDeleteInput = Schema.Struct({ accountId: AiAccountId });
export type AiAccountDeleteInput = typeof AiAccountDeleteInput.Type;
/**
 * `removed`: the gateway confirmed it no longer holds the key. `not-running`: the gateway is not
 * running, so the key is live nowhere. Otherwise the call fails with `still-live`.
 */
export const AiAccountDeleteResult = Schema.Struct({
  deleted: Schema.Boolean,
  gateway: Schema.Literals(["removed", "not-running"]),
});
export type AiAccountDeleteResult = typeof AiAccountDeleteResult.Type;

/** Every AI account of one owner, first to last: that owner's order (owned-resources 08). */
export const AiAccountReorderInput = Schema.Struct({
  accountIds: Schema.Array(AiAccountId).check(Schema.isMaxLength(1000)),
  /** Whose accounts: the caller's own when omitted. */
  owner: Schema.optionalKey(ResourceOwner),
});
export type AiAccountReorderInput = typeof AiAccountReorderInput.Type;

/**
 * «Add subscription» or «Sign in again» (`accountId`): asks CLIProxyAPI for the provider's
 * sign-in page. One sign-in at a time; it lasts 10 minutes and only the session that started it
 * may complete it.
 */
export const AiAccountLoginStartInput = Schema.Struct({
  provider: AiSubscriptionProvider,
  /** A new account's name; omitted with `accountId`. */
  name: Schema.optionalKey(AiAccountName),
  /** «Sign in again» on this account. */
  accountId: Schema.optionalKey(AiAccountId),
  /** A new account's owner: the caller themselves when omitted, or an Organization they run. */
  owner: Schema.optionalKey(ResourceOwner),
});
export type AiAccountLoginStartInput = typeof AiAccountLoginStartInput.Type;

export const AiAccountLoginStartResult = Schema.Struct({
  loginId: Schema.String,
  provider: AiSubscriptionProvider,
  /**
   * `redirect`: the browser lands on a localhost address, which the Owner pastes back.
   * `device`: the Owner types `userCode` on the provider's page; nothing is pasted.
   */
  flow: Schema.Literals(["redirect", "device"]),
  /** The provider's sign-in page. */
  url: Schema.String,
  userCode: Schema.NullOr(Schema.String),
  expiresAt: Schema.String,
});
export type AiAccountLoginStartResult = typeof AiAccountLoginStartResult.Type;

/** The address the browser landed on holds a one-time code: Redacted, never logged. */
export const AI_LOGIN_REDIRECT_MAX_LENGTH = 4096;

export const AiAccountLoginCompleteInput = Schema.Struct({
  loginId: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  /** `redirect` flows: the address the browser landed on, pasted. */
  redirectUrl: Schema.optionalKey(Schema.RedactedFromValue(Schema.String)),
  /** «Sign in again» came back as another account: use it anyway. */
  confirmIdentity: Schema.optionalKey(Schema.Boolean),
});
export type AiAccountLoginCompleteInput = typeof AiAccountLoginCompleteInput.Type;

/** A Vertex service account (its JSON key), imported as a subscription AI account. */
export const AI_SERVICE_ACCOUNT_MAX_LENGTH = 16 * 1024;
export const AiAccountImportVertexInput = Schema.Struct({
  name: AiAccountName,
  serviceAccount: AiCredentialInput,
  /** Whose it becomes: the caller themselves when omitted, or an Organization they run. */
  owner: Schema.optionalKey(ResourceOwner),
});
export type AiAccountImportVertexInput = typeof AiAccountImportVertexInput.Type;

/**
 * Spec 4 ticket 15: auth files of another CLIProxyAPI (Claude, Codex, Antigravity sign-ins), each
 * becoming a subscription AI account as a sign-in would. Their contents travel Redacted.
 */
export const AI_CLIPROXY_IMPORT_MAX_FILES = 50;
export const AiAccountImportCliproxyInput = Schema.Struct({
  files: Schema.Array(
    Schema.Struct({
      fileName: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
      contents: AiCredentialInput,
    }),
  ).check(Schema.isMaxLength(AI_CLIPROXY_IMPORT_MAX_FILES)),
});
export type AiAccountImportCliproxyInput = typeof AiAccountImportCliproxyInput.Type;

/** What became of one file: never anything it held but who it is signed in as. */
export const AiAccountImportCliproxyFileResult = Schema.Struct({
  fileName: Schema.String,
  outcome: Schema.Literals(["imported", "skipped"]),
  accountId: Schema.NullOr(AiAccountId),
  name: Schema.NullOr(Schema.String),
  signedInAs: Schema.NullOr(Schema.String),
  /** Why it was skipped. */
  reason: Schema.NullOr(Schema.String),
});
export type AiAccountImportCliproxyFileResult = typeof AiAccountImportCliproxyFileResult.Type;

export const AiAccountImportCliproxyResult = Schema.Struct({
  files: Schema.Array(AiAccountImportCliproxyFileResult),
});
export type AiAccountImportCliproxyResult = typeof AiAccountImportCliproxyResult.Type;

export const AiAccountErrorReason = Schema.Literals([
  "not-found",
  "forbidden",
  "invalid",
  "duplicate-name",
  "storage",
  "unavailable",
  /** Saved on the Hub, but the gateway has not dropped the old key yet: the Hub keeps trying. */
  "still-live",
  /** No sign-in with that id for this session, or it is over (10 minutes, or the gateway restarted). */
  "expired",
  /** A device sign-in the Owner has not finished on the provider's page yet. */
  "pending",
  /** The provider or CLIProxyAPI refused the sign-in. */
  "sign-in-failed",
  /** «Sign in again» came back as another account: the Owner confirms before it replaces it. */
  "identity-mismatch",
]);
export type AiAccountErrorReason = typeof AiAccountErrorReason.Type;

/** Never carries a credential: messages name accounts, never what they hold. */
export class AiAccountError extends Schema.TaggedError<AiAccountError>()("AiAccountError", {
  reason: AiAccountErrorReason,
  message: Schema.String,
}) {}

/** The prefix CLIProxyAPI serves an account's models under (`acct-<id>/<model>`). */
export const aiAccountPrefixOf = (accountId: string) => `acct-${accountId}`;

/**
 * Spec 4 ticket 08: the AI accounts a User may pick for a Thread in one Space (AllowedAiAccounts),
 * with their models. `environmentId`: where the Thread runs (a Sandbox or dedicated machine always
 * runs on AI accounts).
 */
export const AiAccountPickerInput = Schema.Struct({
  spaceId: SpaceId,
  environmentId: Schema.optionalKey(EnvironmentId),
});
export type AiAccountPickerInput = typeof AiAccountPickerInput.Type;

export const AiAccountPickerAccount = Schema.Struct({
  id: AiAccountId,
  name: Schema.String,
  type: AiAccountType,
  provider: AiAccountProvider,
  priority: Schema.Number,
  /**
   * Gateway accounts: the models of its prefix. Null: a direct one (its agent's catalog), or a
   * gateway catalog the Hub could not read now (unknown, never "serves nothing").
   */
  models: Schema.NullOr(Schema.Array(Schema.String)),
  /**
   * Lent to the Space by a Grant: its id, the lender's name («from <lender>») and how much of its
   * caps is used now (Grants ticket 03; absent when it has none).
   */
  lentBy: Schema.optionalKey(
    Schema.Struct({
      grantId: Schema.String,
      name: Schema.String,
      caps: Schema.optionalKey(GrantCapState),
    }),
  ),
});
export type AiAccountPickerAccount = typeof AiAccountPickerAccount.Type;

export const AiAccountPickerResult = Schema.Struct({
  /**
   * Whether the Hub's turns there run on AI accounts (one is enabled on the Hub, or the machine is
   * a Sandbox or dedicated): then a provider is usable only with an allowed account, never with
   * the machine's own login.
   */
  applies: Schema.Boolean,
  /** The Space's name, when the User works there. */
  spaceName: Schema.NullOr(Schema.String),
  /** Allowed to the User in the Space, first to last by the Installation's priority. */
  accounts: Schema.Array(AiAccountPickerAccount),
});
export type AiAccountPickerResult = typeof AiAccountPickerResult.Type;

/**
 * Switch a Thread's AI account (`thread.continue`'s rule). Same provider instance: the gateway
 * routes the next request to it. Another instance: a provider switch with the context handoff.
 */
export const ThreadSetAiAccountInput = Schema.Struct({
  threadId: ThreadId,
  aiAccountId: AiAccountId,
  /** Another provider instance (a context handoff); omitted: the Thread's own. */
  instanceId: Schema.optionalKey(ProviderInstanceId),
  /** The model on that account; omitted: the Thread's current model. */
  model: Schema.optionalKey(TrimmedNonEmptyString),
});
export type ThreadSetAiAccountInput = typeof ThreadSetAiAccountInput.Type;

export const ThreadSetAiAccountResult = Schema.Struct({
  /** `routing`: same provider, next request. `handoff`: another provider, next turn. */
  change: Schema.Literals(["routing", "handoff", "unchanged"]),
});
export type ThreadSetAiAccountResult = typeof ThreadSetAiAccountResult.Type;

/** Why a Thread's AI account was refused at a door (never a substitute, never a login). */
export class AiAccountChoiceError extends Schema.TaggedError<AiAccountChoiceError>()(
  "AiAccountChoiceError",
  {
    reason: Schema.Literals(["not-allowed", "not-compatible", "model-not-served", "unavailable"]),
    message: Schema.String,
  },
) {}

/**
 * Spec 4 ticket 09: provider-instance variables that are AI credentials. Where AI accounts are in
 * use, the Hub moves them into AI accounts at its start and settings writes refuse them; each names
 * the provider of the account it becomes.
 */
const AI_ACCOUNT_CREDENTIAL_VARIABLES: ReadonlyMap<string, AiAccountProvider> = new Map<
  string,
  AiAccountProvider
>([
  ["ANTHROPIC_API_KEY", "claude"],
  ["ANTHROPIC_AUTH_TOKEN", "claude"],
  ["OPENAI_API_KEY", "codex"],
  ["GEMINI_API_KEY", "gemini"],
  ["XAI_API_KEY", "xai"],
  ["CURSOR_API_KEY", "cursor"],
  ["KIRO_API_KEY", "kiro"],
  ["META_API_KEY", "meta"],
  ["AI_GATEWAY_API_KEY", "fx"],
  ["DEVIN_TOKEN", "devin"],
]);

/** The provider of an AI credential variable, whatever its case (`openai_api_key` too). */
export const aiAccountCredentialProviderOf = (name: string): AiAccountProvider | undefined =>
  AI_ACCOUNT_CREDENTIAL_VARIABLES.get(name.toUpperCase());

/** Ticket 09: provider settings fields that are AI credentials, by driver. */
export const AI_ACCOUNT_CREDENTIAL_FIELDS: ReadonlyMap<string, ReadonlyArray<string>> = new Map([
  ["antigravity", ["apiKey"]],
]);
