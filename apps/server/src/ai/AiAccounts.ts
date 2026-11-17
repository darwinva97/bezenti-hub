/**
 * AI accounts of API key (spec 4 ticket 02): rows in the database, credentials sealed in
 * `AiAccountCredentialStore` and never returned; the Owner manages (`aiAccount.manage`), others
 * list what AllowedAiAccounts allows. CLIProxyAPI gets them by its Management API, `acct-<id>`.
 */
import {
  type AiAccountAllowInput,
  type AiAccountCreateInput,
  type AiAccountDeleteInput,
  type AiAccountDeleteResult,
  AiAccountError,
  type AiAccountErrorReason,
  type AiAccountId,
  type AiAccountImportVertexInput,
  type AiAccountImportCliproxyInput,
  type AiAccountImportCliproxyFileResult,
  type AiAccountImportCliproxyResult,
  type AiAccountListResult,
  type AiAccountLoginCompleteInput,
  type AiAccountLoginStartInput,
  type AiAccountLoginStartResult,
  type AiAccountProvider,
  type AiAccountReorderInput,
  type AiAccountStatus,
  type AiAccountSummary,
  type AiAccountType,
  type AiAccountUpdateInput,
  type AiGatewayState,
  AI_CREDENTIAL_MAX_LENGTH,
  aiAccountPrefixOf,
  type AiApiKeyProvider,
  type AiSubscriptionProvider,
  isAiApiKeyProvider,
  isAiDirectProvider,
  type ServerProviderUsageLimits,
  type SpaceId,
  type UserId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as AuditLog from "../audit/AuditLog.ts";
import * as AccessPolicy from "../auth/AccessPolicy.ts";
import * as CommandActor from "../auth/CommandActor.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import { makeCliproxyApi } from "../usage/cliproxyApi.ts";
import { heldByThread, pruneAndListHeld } from "../vaults/ThreadSecretValues.ts";
import { AiGateway } from "./AiGateway.ts";
import { aiCredentialValueId, credentialIdOfValueId } from "./aiCredentialValue.ts";
import * as AiAccountChanges from "./AiAccountChanges.ts";
import * as AllowedAiAccounts from "./AllowedAiAccounts.ts";
import {
  type CliproxyIdentity,
  identityOf,
  importedNameOf,
  readCliproxyAuthFile,
  sameIdentity,
} from "./cliproxyImport.ts";
import {
  type CliproxyCredential,
  type CliproxyEndpoint,
  CliproxyManagementError,
  makeCliproxyManagement,
} from "./CliproxyManagement.ts";
import { type CliproxyApiKeyAccount, renderCliproxyApiKeys } from "./cliproxyConfig.ts";
import { filterGatewayLine } from "./gatewayLogFilter.ts";
import {
  CLIPROXY_PROVIDER,
  checkPastedRedirect,
  cliproxyTypeOf,
  httpsPageOf,
  isVertexServiceAccount,
  LOGIN_TTL_MS,
  newerToken,
  parseToken,
  parseTokenFileName,
  redirectUriOf,
  sealedTokenBytes,
  signedInAsOf,
  tokenFileNameOf,
  tokenForAccount,
} from "./subscriptionLogin.ts";

export class AiAccounts extends Context.Service<
  AiAccounts,
  {
    /** The Owner: every account and its details. Anyone else: what they may use, and where. */
    readonly list: Effect.Effect<AiAccountListResult, AiAccountError>;
    readonly create: (
      input: AiAccountCreateInput,
    ) => Effect.Effect<AiAccountSummary, AiAccountError>;
    readonly update: (
      input: AiAccountUpdateInput,
    ) => Effect.Effect<AiAccountSummary, AiAccountError>;
    readonly remove: (
      input: AiAccountDeleteInput,
    ) => Effect.Effect<AiAccountDeleteResult, AiAccountError>;
    readonly allow: (input: AiAccountAllowInput) => Effect.Effect<AiAccountSummary, AiAccountError>;
    readonly reorder: (
      input: AiAccountReorderInput,
    ) => Effect.Effect<AiAccountListResult, AiAccountError>;
    /**
     * The models an account serves through the gateway (its prefix's `/v1/models`, without the
     * prefix), cached a few minutes; empty while the gateway is not running.
     */
    readonly modelsOf: (
      accountId: AiAccountId,
    ) => Effect.Effect<ReadonlyArray<string>, AiAccountError>;
    /**
     * Ticket 16: the quota windows of the Hub's Claude and Codex subscriptions, read through the
     * gateway (the Owner's list's 5-minute cache), by account name: never an e-mail or anything
     * derived from the credential. Null for anyone but the Owner acting on the Installation, when
     * the Hub has no such subscription, and when unreadable (fails closed).
     */
    readonly ownerSubscriptionLimits: Effect.Effect<HubSubscriptionLimits | null>;
    /** Writes every enabled account into the running CLIProxyAPI now (the Hub does it itself). */
    readonly sync: Effect.Effect<void>;
    /**
     * «Add subscription» or «Sign in again»: the provider's sign-in page from CLIProxyAPI, for this
     * session only (`sessionId`), for 10 minutes; one sign-in at a time on the Hub.
     */
    readonly loginStart: (
      input: AiAccountLoginStartInput,
      sessionId: string,
    ) => Effect.Effect<AiAccountLoginStartResult, AiAccountError>;
    /**
     * Finishes it: the pasted address (checked against that sign-in, never fetched) to CLIProxyAPI,
     * then its token sealed in the store and handed back under the account's prefix.
     */
    readonly loginComplete: (
      input: AiAccountLoginCompleteInput,
      sessionId: string,
    ) => Effect.Effect<AiAccountSummary, AiAccountError>;
    /** A Vertex service account, imported through CLIProxyAPI and sealed like a sign-in. */
    readonly importVertex: (
      input: AiAccountImportVertexInput,
    ) => Effect.Effect<AiAccountSummary, AiAccountError>;
    /**
     * Spec 4 ticket 15: another CLIProxyAPI's auth files, each a subscription as a sign-in leaves
     * it (disabled until the Owner confirms who it is signed in as), once per identity.
     */
    readonly importCliproxy: (
      input: AiAccountImportCliproxyInput,
    ) => Effect.Effect<AiAccountImportCliproxyResult, AiAccountError>;
    /**
     * Spec 4 ticket 07: a direct account's credential, read for the one provider process about to
     * start with it (`AiGatewaySessions.issue`; no RPC reaches it). Its id names the value for the
     * Thread's masker (`ai-account:<credential id>`). Not found unless the account is direct,
     * enabled and not deleted.
     */
    readonly directCredential: (accountId: AiAccountId) => Effect.Effect<
      {
        readonly credentialId: string;
        readonly value: Redacted.Redacted<string>;
      },
      AiAccountError
    >;
    /**
     * Ticket 09: a provider instance's key as the Owner's account, allowed to their Personal space
     * only, in one transaction with its ledger row (`source`). No RPC reaches it. Already moved, or
     * the same key moved from elsewhere: no new account (`created: false`).
     */
    /** Ticket 09: whether that account exists and holds `key`; unreadable says no. */
    readonly holdsKey: (
      accountId: string,
      key: Redacted.Redacted<string>,
    ) => Effect.Effect<boolean>;
    readonly adoptProviderKey: (
      input: AdoptProviderKeyInput,
    ) => Effect.Effect<{ readonly accountId: string; readonly created: boolean }, AiAccountError>;
  }
>()("t3/ai/AiAccounts") {}

/** What the Usage dialog's Limits show of the Hub's subscriptions, for the Owner. */
export interface HubSubscriptionLimits {
  readonly gatewayRunning: boolean;
  readonly accounts: ReadonlyArray<{
    readonly name: string;
    readonly provider: "claude" | "codex";
    readonly usageLimits: ServerProviderUsageLimits;
  }>;
}

export interface AdoptProviderKeyInput {
  /** `env:<instance>:<VARIABLE>` or `field:<instance>:<field>`. */
  readonly source: string;
  readonly ownerId: UserId;
  readonly type: "api-key" | "direct";
  readonly provider: AiAccountProvider;
  /** Names to try, first free one wins (a number is added after the last). */
  readonly names: ReadonlyArray<string>;
  readonly key: Redacted.Redacted<string>;
}

const isAiAccountError = Schema.is(AiAccountError);

const fail = (reason: AiAccountErrorReason, message: string) =>
  Effect.fail(new AiAccountError({ reason, message }));

const NOT_FOUND = "That AI account does not exist.";
const OWNER_ONLY = "Only the Owner manages AI accounts.";
/** How long a gateway's model list stands for the picker and the gateway. */
const CATALOG_TTL_MS = 5 * 60_000;
/** After a write, how long the Hub waits for CLIProxyAPI's model list to show the accounts. */
const MODEL_LIST_ATTEMPTS = 20;
const MODEL_LIST_PAUSE = Duration.millis(250);
/** One change and its check, from reading the accounts to their status, within this. */
const PROVISION_DEADLINE = Duration.seconds(30);
/** After a change the gateway refused or missed, the Hub tries again, waiting longer each time. */
const RETRY_FIRST_MS = 10_000;
const RETRY_MAX_MS = 5 * 60_000;
const RETRY_TICK = Duration.seconds(1);
/** Gateway states with no CLIProxyAPI process: whatever it held is gone with it. */
const GONE_STATES: ReadonlySet<AiGatewayState> = new Set([
  "off",
  "unsupported",
  "restarting",
  "failed",
]);

interface AccountRow {
  readonly accountId: string;
  readonly name: string;
  readonly type: AiAccountType;
  readonly provider: AiAccountProvider;
  readonly priority: number;
  readonly status: AiAccountStatus;
  readonly statusMessage: string | null;
  readonly disabled: number;
  readonly credentialId: string | null;
  readonly keyHint: string | null;
  readonly baseUrl: string | null;
  readonly modelsJson: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

interface AllowanceRow {
  readonly accountId: string;
  readonly subjectKind: "space" | "user";
  readonly subjectId: string;
}

const ACCOUNT_COLUMNS = `
  account_id AS "accountId", name AS "name", type AS "type", provider AS "provider",
  priority AS "priority", status AS "status", status_message AS "statusMessage",
  disabled AS "disabled", credential_id AS "credentialId", key_hint AS "keyHint",
  base_url AS "baseUrl", models_json AS "modelsJson", created_at AS "createdAt",
  updated_at AS "updatedAt", deleted_at AS "deletedAt"
`;

const encodeModels = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

const modelsOfRow = (row: AccountRow): ReadonlyArray<string> => {
  try {
    const parsed: unknown = JSON.parse(row.modelsJson);
    return Array.isArray(parsed)
      ? parsed.filter((model): model is string => typeof model === "string")
      : [];
  } catch {
    return [];
  }
};

/**
 * Text without spaces or control characters, not empty, at most AI_CREDENTIAL_MAX_LENGTH. Says
 * why, never what.
 */
const credentialProblem = (value: string): string | undefined => {
  if (value.length === 0) return "An API key is needed.";
  if (value.length > AI_CREDENTIAL_MAX_LENGTH) {
    return `An API key is at most ${AI_CREDENTIAL_MAX_LENGTH / 1024} KiB.`;
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point.
  if (/[\s\u0000-\u001f\u007f]/u.test(value)) {
    return "An API key has no spaces, line breaks or control characters.";
  }
  // Zero-width and other invisible format characters (U+200B, U+FEFF…), often pasted along.
  if (/\p{Cf}/u.test(value)) {
    return "This API key has an invisible character in it, often copied along with it: type or paste it again.";
  }
  return undefined;
};

/** The last four characters, only of a key long enough that they give nothing away. */
const hintOf = (key: string) => (key.length >= 16 ? key.slice(-4) : null);

/** An `openai-compatible` base URL: http(s), no credentials, query or fragment in it. */
const baseUrlProblem = (value: string): string | undefined => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "The base URL is not a URL.";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return "The base URL starts with https:// or http://.";
  }
  if (url.username !== "" || url.password !== "") {
    return "The base URL carries no credentials: put the key in «API key».";
  }
  if (url.search !== "" || url.hash !== "") {
    return "The base URL has no query or fragment.";
  }
  return undefined;
};

/** Why CLIProxyAPI cannot take an account as it is stored; checked before anything is sent. */
const accountProblem = (row: AccountRow): string | undefined => {
  if (row.type !== "api-key") return "Not an API key account.";
  if (row.provider === "openai-compatible") {
    if (row.baseUrl === null) return "It needs a base URL.";
    const problem = baseUrlProblem(row.baseUrl);
    if (problem !== undefined) return problem;
    if (modelsOfRow(row).length === 0) return "It needs at least one model.";
    return undefined;
  }
  return row.baseUrl === null ? undefined : "Only an OpenAI-compatible account takes a base URL.";
};

/** What CLIProxyAPI holds of an account: a change of any part is a new entry for it. */
const fingerprintOf = (row: AccountRow) =>
  [row.credentialId, row.provider, row.baseUrl ?? "", row.modelsJson].join("|");

/** An enabled account as it goes to CLIProxyAPI. */
interface Desired {
  readonly row: AccountRow;
  readonly fingerprint: string;
  readonly account: CliproxyApiKeyAccount;
}

/** What the gateway says of a subscription, for the Owner: who it signed in as, its quota. */
interface SubscriptionExtras {
  readonly signedInAs: string | null;
  readonly usageLimits: ServerProviderUsageLimits | null;
}

interface ViewContext {
  readonly running: boolean;
  /** Accounts whose old key the gateway may still hold. */
  readonly stillLive: ReadonlySet<string>;
}

const statusOf = (
  row: AccountRow,
  context: ViewContext,
): Pick<AiAccountSummary, "status" | "statusMessage"> => {
  if (row.deletedAt !== null) {
    return {
      status: "removing",
      statusMessage:
        "Deleted, but its key is still live in the AI gateway, which has not taken the change yet. The Hub keeps trying.",
    };
  }
  if (row.disabled === 1) {
    return { status: "disabled", statusMessage: row.statusMessage ?? "Disabled by the Owner." };
  }
  // A direct credential never goes through the gateway: it works whatever the gateway does.
  if (row.type === "direct") return { status: "working", statusMessage: null };
  if (!context.running) {
    return { status: "pending", statusMessage: "The AI gateway is not running." };
  }
  if (context.stillLive.has(row.accountId)) {
    return {
      status: row.status,
      statusMessage:
        "Its old key is still live in the AI gateway, which has not taken the new one yet. The Hub keeps trying.",
    };
  }
  return { status: row.status, statusMessage: row.statusMessage };
};

/**
 * One account as a User sees it: the Owner with every detail but the credential (and only the
 * allowances to Spaces and Users that still exist), anyone else with where they may use it.
 */
const summaryOf = (
  row: AccountRow,
  context: ViewContext,
  view:
    | {
        readonly _tag: "owner";
        readonly allowances: ReadonlyArray<AllowanceRow>;
        readonly extras?: ReadonlyMap<string, SubscriptionExtras>;
      }
    | { readonly _tag: "user"; readonly usableIn: ReadonlyArray<SpaceId> },
): AiAccountSummary => {
  const extra = view._tag === "owner" ? view.extras?.get(row.accountId) : undefined;
  const mine =
    view._tag === "owner"
      ? view.allowances.filter((allowance) => allowance.accountId === row.accountId)
      : [];
  return {
    id: row.accountId as AiAccountId,
    name: row.name,
    type: row.type,
    provider: row.provider,
    priority: row.priority,
    ...statusOf(row, context),
    disabled: row.disabled === 1,
    usableIn: view._tag === "user" ? view.usableIn : [],
    details:
      view._tag === "user"
        ? null
        : {
            keyHint: row.keyHint,
            baseUrl: row.baseUrl,
            models: modelsOfRow(row),
            allowances: {
              spaceIds: mine
                .filter((allowance) => allowance.subjectKind === "space")
                .map((allowance) => allowance.subjectId as SpaceId),
              userIds: mine
                .filter((allowance) => allowance.subjectKind === "user")
                .map((allowance) => allowance.subjectId as UserId),
            },
            ...(row.type === "subscription"
              ? {
                  signedInAs: extra?.signedInAs ?? null,
                  usageLimits: extra?.usageLimits ?? null,
                }
              : {}),
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          },
  };
};

const UNAVAILABLE = new AiAccountError({
  reason: "unavailable",
  message: "AI accounts live on the Hub; this machine keeps none.",
});
const refuse = Effect.fn("AiAccounts.unavailable")(function* (_input: unknown) {
  return yield* UNAVAILABLE;
});

const holdsNothing = Effect.fn("AiAccounts.holdsNothing")(function* (
  _accountId: string,
  _key: Redacted.Redacted<string>,
) {
  return false;
});

/** A joined machine: no AI accounts, nothing written. */
const unavailable = AiAccounts.of({
  list: Effect.fail(UNAVAILABLE),
  create: refuse,
  update: refuse,
  remove: refuse,
  allow: refuse,
  reorder: refuse,
  modelsOf: refuse,
  ownerSubscriptionLimits: Effect.succeed(null),
  sync: Effect.void,
  loginStart: refuse,
  loginComplete: refuse,
  importVertex: refuse,
  importCliproxy: refuse,
  directCredential: refuse,
  adoptProviderKey: refuse,
  holdsKey: holdsNothing,
});

/** Options for tests: how often the Hub reads back refreshed tokens; how long a sign-in lasts. */
export interface AiAccountsOptions {
  readonly tokenPollMs?: number;
  readonly loginTtlMs?: number;
}

/** Without a folder in memory the Hub hands CLIProxyAPI no token: it would land on the disk. */
const NO_MEMORY_FOLDER =
  "This Hub has no folder in memory ($XDG_RUNTIME_DIR or /dev/shm) for the AI gateway, so subscriptions are not loaded: their tokens would sit in clear on the disk.";
/** How often the Hub reads back the tokens CLIProxyAPI refreshed, to seal them again. */
const TOKEN_POLL_MS = 10_000;
/** Even with no file changed, the tokens are read back this often (and while a sign-in is open). */
const TOKEN_FULL_PASS_MS = 5 * 60_000;
/** How long the Hub waits for CLIProxyAPI to finish a sign-in it was handed. */
const LOGIN_STATUS_ROUNDS = 60;
const DEVICE_STATUS_ROUNDS = 4;
const LOGIN_STATUS_PAUSE = Duration.millis(500);
/** How long quota windows read from the providers stand. */
const QUOTA_TTL_MS = 5 * 60_000;

/** Something CLIProxyAPI said of a credential, safe to show the Owner (no quoted value or token). */
const safeMessage = (text: string | null) =>
  text === null || text.length === 0
    ? null
    : filterGatewayLine(text.replace(/`[^`]*`|"[^"]*"|'[^']*'/gu, "…"), []).slice(0, 200);

/** A subscription's status as CLIProxyAPI reports its token. */
const tokenStatusOf = (
  entry: CliproxyCredential,
): { readonly status: AiAccountStatus; readonly message: string | null } => {
  if (entry.requiresSignIn) {
    return { status: "needs-sign-in", message: "The provider wants you to sign in again." };
  }
  if (entry.quotaBlocked) {
    return { status: "quota-exhausted", message: "Its quota is used up for now." };
  }
  if (entry.unavailable || entry.status === "error" || entry.status === "disabled") {
    return {
      status: "error",
      message: safeMessage(entry.statusMessage) ?? "The AI gateway cannot use it now.",
    };
  }
  return { status: "working", message: null };
};

/** Every token file the gateway lists and when it changed, to notice a refresh cheaply. */
const modtimesOf = (listed: ReadonlyArray<CliproxyCredential>) =>
  listed
    .map((entry) => `${entry.name}@${entry.modtime ?? ""}`)
    .toSorted()
    .join("|");

/** A new subscription waits for the Owner to check who it signed in as. */
const confirmMessageOf = (signedInAs: string | null) =>
  `Signed in as ${signedInAs ?? "an account the provider did not name"}. Check it is the right account, then turn it on.`;

/** A token a sign-in brought back, sealed under its own id. */
interface TakenToken {
  readonly tokenId: string;
  readonly token: Record<string, unknown>;
  readonly signedInAs: string | null;
}

/** A sign-in the Owner started and has not finished: one at a time on the Hub. */
interface PendingLogin {
  readonly loginId: string;
  readonly ownerId: UserId;
  readonly sessionId: string;
  readonly provider: AiSubscriptionProvider;
  readonly flow: "redirect" | "device";
  readonly state: string;
  readonly redirectUri: string | null;
  readonly expiresAt: number;
  readonly target:
    | { readonly _tag: "new"; readonly name: string }
    | { readonly _tag: "again"; readonly accountId: string };
  /** The gateway it was started on: a restarted one forgot it. */
  readonly baseUrl: string;
  /** Files CLIProxyAPI held before: the sign-in's token is a new one. */
  readonly before: ReadonlySet<string>;
  completing: boolean;
  /** «Sign in again» as another account: its token, held until the Owner confirms. */
  held?: (TakenToken & { readonly mismatch: string }) | undefined;
}

const make = Effect.fn("AiAccounts.make")(function* (options: AiAccountsOptions) {
  const sql = yield* SqlClient.SqlClient;
  const spaces = yield* SpaceDirectory.SpaceDirectory;
  const audit = yield* AuditLog.AuditLog;
  const credentials = yield* ServerSecretStore.AiAccountCredentialStore;
  const random = yield* SecureRandom.SecureRandom;
  const gateway = yield* AiGateway;
  const allowed = yield* AllowedAiAccounts.AllowedAiAccounts;
  const management = yield* makeCliproxyManagement;
  const tokens = yield* ServerSecretStore.AiAccountTokenStore;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const usageReader = yield* makeCliproxyApi;

  /** A stored credential to remove: an API key (`cred-…`) or a subscription's token (`tok-…`). */
  const isTokenId = (id: string) => id.startsWith("tok-");
  const storedRemove = (id: string) => (isTokenId(id) ? tokens.remove(id) : credentials.remove(id));

  /** Logs what failed (never a credential: none reaches these causes) and answers generically. */
  const storage = (what: string) => (cause: unknown) =>
    Effect.logError(`AiAccounts: could not ${what}`, { cause }).pipe(
      Effect.andThen(fail("storage", `Could not ${what}. Try again.`)),
    );
  const orStorage = (what: string) => (error: unknown) =>
    isAiAccountError(error) ? Effect.fail(error) : storage(what)(error);

  const now = Effect.map(DateTime.now, DateTime.formatIso);
  const newId = (bytes: number) =>
    random.randomBytes(bytes).pipe(Effect.map((value) => Buffer.from(value).toString("hex")));

  const actor = spaces.actingUser.pipe(
    Effect.catchTags({
      SpaceAccessDeniedError: () => fail("forbidden", "Sign in to see AI accounts."),
      SpaceDirectoryStorageError: storage("read who you are"),
    }),
    Effect.flatMap(
      Option.match({
        onNone: () => fail("forbidden", "Sign in to see AI accounts."),
        onSome: Effect.succeed,
      }),
    ),
  );

  /** The acting User and what they may do, decided once per request (spaceLimit included). */
  const caller = Effect.gen(function* () {
    const userId = yield* actor;
    const can = yield* spaces
      .authorizer(userId)
      .pipe(Effect.catch(storage("check what you may do")));
    return { userId, manages: can("aiAccount.manage", AccessPolicy.installation), can };
  });

  /** The Owner, acting on the Installation (never a session limited to one Space). */
  const manager = Effect.gen(function* () {
    const { userId, manages } = yield* caller;
    if (!manages) return yield* fail("forbidden", OWNER_ONLY);
    return userId;
  });

  /** One config change at a time: each reads the accounts afresh, so the last one is the latest. */
  const syncLock = yield* Semaphore.make(1);
  const layerScope = yield* Scope.Scope;
  /**
   * What the running CLIProxyAPI holds, as its last accepted change left it (each replaces the
   * whole `api-keys` section): account → credential and fingerprint. A fresh start holds nothing.
   * Forgotten when the process is gone.
   */
  let live:
    | {
        readonly baseUrl: string;
        readonly entries: ReadonlyMap<string, { credentialId: string; fingerprint: string }>;
      }
    | undefined;
  /** Accounts CLIProxyAPI refused, by gateway and fingerprint: not sent again unchanged. */
  const refusedBefore = new Map<string, string>();
  /** What the last attempt sent (for its status if it fails). */
  let attempted: ReadonlyArray<{ readonly id: string; readonly credentialId: string }> = [];
  let dirty = false;
  let retryDelayMs = RETRY_FIRST_MS;
  let nextRetryAt = 0;
  let catalog:
    | { readonly baseUrl: string; readonly at: number; readonly ids: ReadonlyArray<string> }
    | undefined;

  const enabledAccounts = sql<AccountRow>`
    SELECT ${sql.literal(ACCOUNT_COLUMNS)} FROM ai_accounts
    WHERE disabled = 0 AND deleted_at IS NULL AND type = 'api-key' AND credential_id IS NOT NULL
    ORDER BY priority, account_id
  `;

  /** Only while the row still holds that credential, enabled and not deleted (no raced write). */
  const setStatus = (
    accountId: string,
    credentialId: string,
    status: AiAccountStatus,
    message: string | null,
  ) =>
    sql`
      UPDATE ai_accounts SET status = ${status}, status_message = ${message}
      WHERE account_id = ${accountId} AND credential_id = ${credentialId}
        AND disabled = 0 AND deleted_at IS NULL
    `.pipe(Effect.ignore({ log: true }));

  /**
   * Retired keys (replaced, or of a deleted account) the gateway no longer holds: out of the
   * store, and a deleted account's row with its last one.
   */
  const cleanupRetired = Effect.fn("AiAccounts.cleanupRetired")(function* (
    liveCredentials: ReadonlySet<string>,
  ) {
    const retired = yield* sql<{ readonly credentialId: string }>`
      SELECT credential_id AS "credentialId" FROM ai_account_retired_credentials
    `;
    for (const { credentialId } of retired) {
      if (liveCredentials.has(credentialId)) continue;
      if (tokensUnknown && isTokenId(credentialId)) continue;
      // Ticket 07: a direct credential a Thread received stays sealed while that Thread lives, so
      // its masker still hides what the agent printed with it (spec 5, ticket 05).
      const held = yield* heldByThread(sql, aiCredentialValueId(credentialId));
      if (!held) yield* storedRemove(credentialId);
      yield* sql`DELETE FROM ai_account_retired_credentials WHERE credential_id = ${credentialId}`;
    }
    yield* sql`
      DELETE FROM ai_accounts WHERE deleted_at IS NOT NULL
        AND account_id NOT IN (SELECT account_id FROM ai_account_retired_credentials)
    `;
    const left = yield* sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM ai_account_retired_credentials
    `;
    return (left[0]?.n ?? 0) > 0;
  });

  const unreadable = () =>
    new CliproxyManagementError({
      message: "Could not read the AI accounts on the Hub; the AI gateway keeps what it has.",
    });

  /** Subscription accounts CLIProxyAPI should hold: enabled, signed in. */
  const subscriptionAccounts = sql<AccountRow>`
    SELECT ${sql.literal(ACCOUNT_COLUMNS)} FROM ai_accounts
    WHERE disabled = 0 AND deleted_at IS NULL AND type = 'subscription' AND credential_id IS NOT NULL
    ORDER BY priority, account_id
  `;
  /** Every subscription account that exists, enabled or not: whose newer token is still worth keeping. */
  const existingSubscriptions = sql<AccountRow>`
    SELECT ${sql.literal(ACCOUNT_COLUMNS)} FROM ai_accounts
    WHERE deleted_at IS NULL AND type = 'subscription' AND credential_id IS NOT NULL
  `;
  /** The sign-in in progress, if any: its token file must not be swept before it is captured. */
  let pendingLogin: PendingLogin | undefined;
  /** Token ids whose file the running CLIProxyAPI held at the last look. */
  let liveTokens: ReadonlySet<string> = new Set();
  /** The last token reconcile failed: which token files the gateway holds is not known. */
  let tokensUnknown = false;
  /** Our token files' times at the last look, so the poll reads tokens only when one changed. */
  let seenModtimes = "";

  /** What the Hub knows is live in the gateway: API keys it holds and token files it has. */
  const liveCredentialIds = () =>
    new Set([
      ...(live === undefined ? [] : [...live.entries.values()].map((entry) => entry.credentialId)),
      ...liveTokens,
    ]);

  /** The sign-in in progress, unless its time is over (then it is forgotten). */
  const activeLogin = Effect.gen(function* () {
    const login = pendingLogin;
    if (login === undefined) return undefined;
    if (!login.completing && (yield* Clock.currentTimeMillis) >= login.expiresAt) {
      pendingLogin = undefined;
      if (login.held !== undefined) {
        yield* tokens.remove(login.held.tokenId).pipe(Effect.ignore({ log: true }));
      }
      return undefined;
    }
    return login;
  });

  /**
   * Seals a copy of an account's current token when it is newer than the sealed one (CLIProxyAPI
   * refreshed it, and a refresh may rotate the refresh token, so the sealed one would die), and
   * never the other way round. Only a token of the account's provider. Under the lock.
   */
  const captureIfNewer = Effect.fn("AiAccounts.captureIfNewer")(function* (
    row: AccountRow,
    tokenId: string,
    inGateway: Record<string, unknown>,
  ) {
    if (inGateway.type !== cliproxyTypeOf(row.provider)) return false;
    const current = yield* tokens.get(tokenId).pipe(Effect.mapError(unreadable));
    const sealed = Option.isSome(current) ? parseToken(current.value) : undefined;
    if (sealed !== undefined && newerToken(sealed, inGateway) !== "gateway") return false;
    yield* tokens.set(tokenId, sealedTokenBytes(inGateway)).pipe(Effect.mapError(unreadable));
    yield* Effect.logInfo("AiAccounts: sealed a token the AI gateway refreshed", {
      accountId: row.accountId,
    });
    return true;
  });

  /**
   * Whether a token file stays in the gateway. The Hub's own (`acct-…-tok-….json`): only the
   * current token of an enabled account, with a folder in memory. Any other: only the new file of
   * the sign-in in progress (its provider's, not there when it started), on that gateway.
   */
  const keepFile = (
    entry: { readonly name: string; readonly provider: string | null },
    wanted: ReadonlyMap<string, string>,
    login: PendingLogin | undefined,
    baseUrl: string | undefined,
  ) => {
    const ours = parseTokenFileName(entry.name);
    if (ours !== undefined) return wanted.get(ours.accountId) === ours.tokenId;
    return (
      login !== undefined &&
      baseUrl !== undefined &&
      login.baseUrl === baseUrl &&
      entry.provider === CLIPROXY_PROVIDER[login.provider] &&
      !login.before.has(entry.name)
    );
  };

  /**
   * With no CLIProxyAPI answering (stopped, off, or about to launch): the memory folder's token
   * files read and removed directly. A newer copy of an existing account's current token is sealed
   * first; every file not wanted goes (the next launch must not load it). Answers the token ids
   * still in the folder. Under the lock.
   */
  const reconcileFolder = Effect.fn("AiAccounts.reconcileFolder")(function* () {
    const inMemory = (yield* gateway.status).credentialsInMemory;
    const rows = yield* subscriptionAccounts.pipe(Effect.mapError(unreadable));
    const existing = new Map(
      (yield* existingSubscriptions.pipe(Effect.mapError(unreadable))).map(
        (row) => [row.accountId, row] as const,
      ),
    );
    const wanted = new Map(
      inMemory ? rows.map((row) => [row.accountId, row.credentialId ?? ""] as const) : [],
    );
    const names = yield* fileSystem
      .readDirectory(gateway.authDir)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    const left = new Set<string>();
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(gateway.authDir, name);
      const ours = parseTokenFileName(name);
      if (ours !== undefined) {
        const row = existing.get(ours.accountId);
        if (row !== undefined && row.credentialId === ours.tokenId) {
          const bytes = yield* fileSystem.readFile(file).pipe(Effect.option);
          const token = Option.isSome(bytes) ? parseToken(bytes.value) : undefined;
          if (token !== undefined) yield* captureIfNewer(row, ours.tokenId, token);
        }
        if (wanted.get(ours.accountId) === ours.tokenId) {
          left.add(ours.tokenId);
          continue;
        }
      }
      // No sign-in survives its gateway: any other file goes too.
      const removed = yield* fileSystem.remove(file).pipe(
        Effect.as(true),
        Effect.catch((cause) =>
          Effect.logWarning("AiAccounts: could not remove a token file", { name, cause }).pipe(
            Effect.as(false),
          ),
        ),
      );
      if (!removed && ours !== undefined) left.add(ours.tokenId);
    }
    return left;
  });

  /**
   * Under the lock, by the management API: each account's newest token wins, wherever it is; a
   * file not kept (keepFile) goes, after its newer token is sealed. One account failing leaves the
   * others. Without a folder in memory none stays. Answers the token ids the gateway holds now.
   */
  const reconcileTokens = Effect.fn("AiAccounts.reconcileTokens")(function* (
    endpoint: CliproxyEndpoint,
  ) {
    const inMemory = (yield* gateway.status).credentialsInMemory;
    const rows = yield* subscriptionAccounts.pipe(Effect.mapError(unreadable));
    const existing = new Map(
      (yield* existingSubscriptions.pipe(Effect.mapError(unreadable))).map(
        (row) => [row.accountId, row] as const,
      ),
    );
    const wanted = new Map(
      inMemory ? rows.map((row) => [row.accountId, row.credentialId ?? ""] as const) : [],
    );
    const login = yield* activeLogin;
    const held = yield* management.credentials(endpoint);
    const oneAccount = (accountId: string) => (cause: unknown) =>
      Effect.logWarning("AiAccounts: could not reconcile a subscription's token", {
        accountId,
        cause,
      }).pipe(Effect.andThen(Effect.sync(() => (dirty = true))));
    for (const entry of held) {
      if (keepFile(entry, wanted, login, endpoint.baseUrl)) continue;
      const ours = parseTokenFileName(entry.name);
      yield* Effect.gen(function* () {
        // A refreshed token of an account that still exists is sealed before its file goes.
        const row = ours === undefined ? undefined : existing.get(ours.accountId);
        if (ours !== undefined && row !== undefined && row.credentialId === ours.tokenId) {
          const copy = yield* management.downloadCredential(endpoint, entry.name);
          const token = Option.isSome(copy) ? parseToken(copy.value) : undefined;
          if (token !== undefined) yield* captureIfNewer(row, ours.tokenId, token);
        }
        yield* management.deleteCredential(endpoint, entry.name);
      }).pipe(Effect.catch(oneAccount(ours?.accountId ?? entry.name)));
    }
    const names = new Set(held.map((entry) => entry.name));
    for (const row of inMemory ? rows : []) {
      const tokenId = row.credentialId ?? "";
      yield* Effect.gen(function* () {
        const stored = yield* tokens.get(tokenId).pipe(Effect.mapError(unreadable));
        const sealed = Option.isSome(stored) ? parseToken(stored.value) : undefined;
        if (sealed === undefined) {
          yield* setStatus(
            row.accountId,
            tokenId,
            "needs-sign-in",
            "Its sign-in is missing from the Hub's store: sign in again.",
          );
          return;
        }
        const name = tokenFileNameOf(row.accountId, tokenId);
        if (names.has(name)) {
          const copy = yield* management.downloadCredential(endpoint, name);
          const inGateway = Option.isSome(copy) ? parseToken(copy.value) : undefined;
          if (inGateway !== undefined) {
            if (yield* captureIfNewer(row, tokenId, inGateway)) return;
            if (newerToken(sealed, inGateway) !== "sealed") return;
          }
        }
        yield* management.uploadCredential(endpoint, name, tokenForAccount(sealed, row.accountId));
      }).pipe(Effect.catch(oneAccount(row.accountId)));
    }
    const now = yield* management.credentials(endpoint);
    const present = new Map(now.map((entry) => [entry.name, entry]));
    const holding = new Set<string>();
    for (const entry of now) {
      const ours = parseTokenFileName(entry.name);
      if (ours !== undefined) holding.add(ours.tokenId);
    }
    for (const row of rows) {
      const tokenId = row.credentialId ?? "";
      if (!inMemory) {
        yield* setStatus(row.accountId, tokenId, "error", NO_MEMORY_FOLDER);
        continue;
      }
      const entry = present.get(tokenFileNameOf(row.accountId, tokenId));
      if (entry === undefined) continue;
      const { status, message } = tokenStatusOf(entry);
      yield* setStatus(row.accountId, tokenId, status, message);
    }
    // Another set of tokens in the gateway: its quota windows are read again.
    if (holding.size !== liveTokens.size || [...holding].some((id) => !liveTokens.has(id))) {
      quotaCache = undefined;
    }
    liveTokens = holding;
    tokensUnknown = false;
    seenModtimes = modtimesOf(now);
    return holding;
  });

  /** The tokens alone, as CLIProxyAPI refreshes them: no change to its config. */
  const refreshTokens = Effect.gen(function* () {
    const endpoint = yield* gateway.endpoint;
    if (Option.isNone(endpoint)) return;
    yield* syncLock.withPermits(1)(
      reconcileTokens(endpoint.value).pipe(
        Effect.andThen(cleanupRetired(liveCredentialIds()).pipe(Effect.mapError(unreadable))),
        Effect.tap((left) => Effect.sync(() => (dirty = dirty || left))),
      ),
    );
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("AiAccounts: could not read back the AI gateway's tokens", {
        reason: error.message,
      }),
    ),
    Effect.withSpan("AiAccounts.refreshTokens"),
  );

  /** A cheap look (the list only): the tokens are read back when one of the Hub's files changed. */
  let lastFullPass = 0;
  const pollTokens = Effect.gen(function* () {
    const endpoint = yield* gateway.endpoint;
    if (Option.isNone(endpoint)) return;
    const at = yield* Clock.currentTimeMillis;
    const listed = yield* management.credentials(endpoint.value).pipe(Effect.option);
    if (
      Option.isSome(listed) &&
      modtimesOf(listed.value) === seenModtimes &&
      pendingLogin === undefined &&
      // A file that is not the Hub's own (a sign-in's) is looked at until it goes.
      listed.value.every((entry) => parseTokenFileName(entry.name) !== undefined) &&
      at - lastFullPass < TOKEN_FULL_PASS_MS
    ) {
      return;
    }
    lastFullPass = at;
    yield* refreshTokens;
  });

  /**
   * Under the lock: the enabled accounts that pass their own checks, with their keys from the
   * store, into `endpoint`. If CLIProxyAPI refuses them together, what it held before and then
   * each other account alone, first to last: only the one it refuses stays out, with its reason.
   * A key the store cannot read aborts it all and leaves the gateway as it is.
   */
  const commit = Effect.fn("AiAccounts.commit")(function* (endpoint: CliproxyEndpoint) {
    const rows = yield* enabledAccounts.pipe(Effect.mapError(unreadable));
    const desired: Array<Desired> = [];
    const bad: Array<{ readonly row: AccountRow; readonly reason: string }> = [];
    for (const row of rows) {
      const problem = accountProblem(row);
      if (problem !== undefined) {
        bad.push({ row, reason: problem });
        continue;
      }
      const stored = yield* credentials
        .get(row.credentialId ?? "")
        .pipe(Effect.mapError(unreadable));
      if (Option.isNone(stored)) {
        bad.push({ row, reason: "Its key is missing from the Hub's store: replace it." });
        continue;
      }
      desired.push({
        row,
        fingerprint: fingerprintOf(row),
        account: {
          id: row.accountId,
          provider: row.provider as AiApiKeyProvider,
          apiKey: new TextDecoder().decode(stored.value),
          baseUrl: row.baseUrl,
          models: modelsOfRow(row),
        },
      });
    }
    const secrets = desired.map((entry) => entry.account.apiKey);
    const refusalKey = (entry: Desired) => `${endpoint.baseUrl}|${entry.fingerprint}`;
    const sendable = desired.filter((entry) => {
      const reason = refusedBefore.get(refusalKey(entry));
      if (reason !== undefined) bad.push({ row: entry.row, reason });
      return reason === undefined;
    });
    // Every account this change tries to send, for its status if it all fails.
    attempted = sendable.map((entry) => ({
      id: entry.row.accountId,
      credentialId: entry.row.credentialId ?? "",
    }));
    const attempt = (set: ReadonlyArray<Desired>) =>
      management.setApiKeys(
        endpoint,
        renderCliproxyApiKeys(set.map((entry) => entry.account)),
        secrets,
      );
    let accepted: Array<Desired> = sendable;
    const together = yield* attempt(sendable);
    if (together._tag === "refused") {
      const before = live?.baseUrl === endpoint.baseUrl ? live.entries : new Map();
      let base = sendable.filter(
        (entry) => before.get(entry.row.accountId)?.fingerprint === entry.fingerprint,
      );
      if ((yield* attempt(base))._tag === "refused") {
        base = [];
        const empty = yield* attempt([]);
        if (empty._tag === "refused") {
          return yield* new CliproxyManagementError({
            message: `CLIProxyAPI refused even no AI accounts (HTTP ${empty.status}${empty.reason === "" ? "" : `: ${empty.reason}`}).`,
          });
        }
      }
      accepted = [...base];
      for (const entry of sendable) {
        if (accepted.includes(entry)) continue;
        const next = sendable.filter((other) => other === entry || accepted.includes(other));
        const answer = yield* attempt(next);
        if (answer._tag === "accepted") {
          accepted = next;
        } else {
          const reason = `The AI gateway refused it${answer.reason === "" ? "" : `: ${answer.reason}`}.`;
          refusedBefore.set(refusalKey(entry), reason);
          bad.push({ row: entry.row, reason });
        }
      }
      // The last change sent may be a refused one: send what stands, so it is what runs.
      if ((yield* attempt(accepted))._tag === "refused") {
        return yield* new CliproxyManagementError({
          message: "CLIProxyAPI refused AI accounts it had just taken.",
        });
      }
    }
    live = {
      baseUrl: endpoint.baseUrl,
      entries: new Map(
        accepted.map((entry) => [
          entry.row.accountId,
          { credentialId: entry.row.credentialId ?? "", fingerprint: entry.fingerprint },
        ]),
      ),
    };
    attempted = [];
    catalog = undefined;
    for (const { row, reason } of bad) {
      yield* setStatus(row.accountId, row.credentialId ?? "", "error", reason);
    }
    yield* reconcileTokens(endpoint).pipe(
      Effect.catch((error) =>
        Effect.logWarning("AiAccounts: could not reconcile the subscriptions' tokens", {
          reason: error.message,
        }).pipe(
          Effect.andThen(
            Effect.sync(() => {
              tokensUnknown = true;
            }),
          ),
        ),
      ),
    );
    const retiredLeft = yield* cleanupRetired(liveCredentialIds()).pipe(
      Effect.mapError(unreadable),
    );
    dirty = retiredLeft || tokensUnknown;
    retryDelayMs = RETRY_FIRST_MS;
    return accepted;
  });

  /**
   * Outside the lock: CLIProxyAPI applies a change by reloading its config, so its model list
   * catches up shortly. Each account sent is `working` once listed, `unverified` if the list
   * cannot be read, `error` if it never shows.
   */
  const verify = Effect.fn("AiAccounts.verify")(function* (
    endpoint: CliproxyEndpoint,
    accepted: ReadonlyArray<Desired>,
  ) {
    const expected = accepted.map((entry) => `${aiAccountPrefixOf(entry.row.accountId)}/`);
    let ids = yield* management.modelIds(endpoint).pipe(Effect.option);
    for (let round = 0; round < MODEL_LIST_ATTEMPTS; round += 1) {
      const listed = ids;
      if (
        Option.isSome(listed) &&
        expected.every((prefix) => listed.value.some((id) => id.startsWith(prefix)))
      ) {
        break;
      }
      yield* Effect.sleep(MODEL_LIST_PAUSE);
      ids = yield* management.modelIds(endpoint).pipe(Effect.option);
    }
    if (Option.isSome(ids)) {
      catalog = { baseUrl: endpoint.baseUrl, at: yield* Clock.currentTimeMillis, ids: ids.value };
    }
    for (const entry of accepted) {
      const prefix = `${aiAccountPrefixOf(entry.row.accountId)}/`;
      const credentialId = entry.row.credentialId ?? "";
      if (Option.isNone(ids)) {
        yield* setStatus(
          entry.row.accountId,
          credentialId,
          "unverified",
          "In the AI gateway, but its model list could not be read.",
        );
      } else if (ids.value.some((id) => id.startsWith(prefix))) {
        yield* setStatus(entry.row.accountId, credentialId, "working", null);
      } else {
        yield* setStatus(
          entry.row.accountId,
          credentialId,
          "error",
          "The AI gateway lists no models for this account.",
        );
      }
    }
  });

  /** A change, then its check, within one deadline. */
  const provision = Effect.fn("AiAccounts.provision")(function* (endpoint: CliproxyEndpoint) {
    const done = yield* Effect.gen(function* () {
      const accepted = yield* syncLock.withPermits(1)(commit(endpoint));
      yield* verify(endpoint, accepted);
    }).pipe(Effect.timeoutOption(PROVISION_DEADLINE));
    if (Option.isNone(done)) {
      return yield* new CliproxyManagementError({
        message: `The AI gateway did not take the AI accounts within ${Duration.toSeconds(PROVISION_DEADLINE)} s.`,
      });
    }
  });

  /**
   * The gateway did not take them: the accounts it was sent and does not hold are `error`, and
   * the Hub tries again, waiting longer each time (up to RETRY_MAX_MS). The gateway keeps running.
   */
  const failed = Effect.fn("AiAccounts.failed")(function* (error: CliproxyManagementError) {
    dirty = true;
    nextRetryAt = (yield* Clock.currentTimeMillis) + retryDelayMs;
    retryDelayMs = Math.min(retryDelayMs * 2, RETRY_MAX_MS);
    yield* Effect.logWarning("AiAccounts: the AI gateway did not take the AI accounts", {
      reason: error.message,
    });
    const sent = attempted;
    attempted = [];
    for (const { id, credentialId } of sent) {
      if (live?.entries.get(id)?.credentialId === credentialId) continue;
      yield* setStatus(id, credentialId, "error", `Not in the AI gateway yet: ${error.message}`);
    }
  });

  /** Under the lock, with no CLIProxyAPI answering: the memory folder's token files directly. */
  const folderNow = reconcileFolder().pipe(
    Effect.tap((left) =>
      Effect.sync(() => {
        liveTokens = left;
        tokensUnknown = false;
      }),
    ),
    Effect.catch((error) =>
      Effect.logWarning("AiAccounts: could not reconcile the gateway's token folder", {
        reason: error.message,
      }).pipe(
        Effect.andThen(
          Effect.sync(() => {
            tokensUnknown = true;
          }),
        ),
      ),
    ),
    Effect.asVoid,
  );

  /**
   * After a change to what the gateway holds: into the running gateway now. With none running,
   * no key is live anywhere, so retired ones go at once (`not-running`).
   */
  const syncNow = Effect.gen(function* () {
    const endpoint = yield* gateway.endpoint;
    if (Option.isNone(endpoint)) {
      yield* syncLock.withPermits(1)(
        Effect.gen(function* () {
          yield* folderNow;
          if (live !== undefined) {
            dirty = true;
            return;
          }
          dirty = yield* cleanupRetired(liveCredentialIds()).pipe(
            Effect.map((left) => left || tokensUnknown),
            Effect.orElseSucceed(() => true),
          );
        }),
      );
      return "not-running" as const;
    }
    return yield* provision(endpoint.value).pipe(
      Effect.as("applied" as const),
      Effect.catch((error) => failed(error).pipe(Effect.as("failed" as const))),
    );
  }).pipe(Effect.withSpan("AiAccounts.sync"));

  yield* gateway.setBeforeLaunch(() =>
    syncLock.withPermits(1)(
      Effect.gen(function* () {
        const login = pendingLogin;
        if (login !== undefined && !login.completing) {
          pendingLogin = undefined;
          yield* dropHeld(login);
        }
        yield* folderNow;
      }),
    ),
  );
  // At the Hub's stop, the tokens CLIProxyAPI refreshed since the last look are sealed first.
  yield* Effect.addFinalizer(() => refreshTokens);
  // Every start (a crash and its restart, an update, a roll back) gets the accounts before it
  // counts as running, its check forked; a start that raced this registration is caught below.
  yield* gateway.setProvisioner((endpoint) =>
    syncLock
      .withPermits(1)(commit(endpoint))
      .pipe(
        Effect.timeoutOption(PROVISION_DEADLINE),
        Effect.flatMap(
          Option.match({
            onNone: () => failed(new CliproxyManagementError({ message: "It took too long." })),
            onSome: (accepted) => verify(endpoint, accepted).pipe(Effect.forkIn(layerScope)),
          }),
        ),
        Effect.catch(failed),
        Effect.asVoid,
      ),
  );
  yield* gateway.changes.pipe(
    Stream.runForEach((status) =>
      Effect.gen(function* () {
        if (GONE_STATES.has(status.state)) {
          // Its process is gone, and what it held with it (token files stay in the memory folder
          // for the next start, which reconciles them before it counts as running).
          live = undefined;
          liveTokens = new Set();
          yield* syncNow;
          return;
        }
        if (status.state !== "running") return;
        const endpoint = yield* gateway.endpoint;
        if (Option.isSome(endpoint) && endpoint.value.baseUrl !== live?.baseUrl) yield* syncNow;
      }),
    ),
    Effect.forkScoped,
  );
  yield* Effect.gen(function* () {
    yield* Effect.sleep(RETRY_TICK);
    if (dirty && (yield* Clock.currentTimeMillis) >= nextRetryAt) yield* syncNow;
  }).pipe(Effect.forever, Effect.forkScoped);
  // CLIProxyAPI refreshes subscription tokens by itself: read them back and seal the newer ones.
  yield* Effect.gen(function* () {
    yield* Effect.sleep(Duration.millis(options.tokenPollMs ?? TOKEN_POLL_MS));
    yield* pollTokens;
  }).pipe(Effect.forever, Effect.forkScoped);

  const catalogIds = Effect.gen(function* () {
    const endpoint = yield* gateway.endpoint;
    if (Option.isNone(endpoint)) return [] as ReadonlyArray<string>;
    const cached = catalog;
    const at = yield* Clock.currentTimeMillis;
    if (
      cached !== undefined &&
      cached.baseUrl === endpoint.value.baseUrl &&
      at - cached.at < CATALOG_TTL_MS
    ) {
      return cached.ids;
    }
    const ids = yield* management
      .modelIds(endpoint.value)
      .pipe(Effect.catch(() => fail("unavailable", "The AI gateway did not list its models.")));
    catalog = { baseUrl: endpoint.value.baseUrl, at, ids };
    return ids;
  });

  const findRow = Effect.fn("AiAccounts.findRow")(function* (accountId: string) {
    const rows = yield* sql<AccountRow>`
      SELECT ${sql.literal(ACCOUNT_COLUMNS)} FROM ai_accounts WHERE account_id = ${accountId}
    `.pipe(Effect.catch(storage("read the AI account")));
    const row = rows[0];
    if (row === undefined) return yield* fail("not-found", NOT_FOUND);
    return row;
  });

  /** An account that is not being deleted. */
  const findAccount = Effect.fn("AiAccounts.findAccount")(function* (accountId: string) {
    const row = yield* findRow(accountId);
    if (row.deletedAt !== null) return yield* fail("not-found", NOT_FOUND);
    return row;
  });

  const allowancesOf = (accountIds: ReadonlyArray<string>) =>
    accountIds.length === 0
      ? Effect.succeed([] as ReadonlyArray<AllowanceRow>)
      : sql<AllowanceRow>`
          SELECT account_id AS "accountId", subject_kind AS "subjectKind", subject_id AS "subjectId"
          FROM ai_account_allowances WHERE ${sql.in("account_id", accountIds)}
          ORDER BY subject_kind, subject_id
        `.pipe(Effect.catch(storage("read who may use the AI accounts")));

  /** Accounts whose old key the gateway may still hold (replaced or deleted, not yet dropped). */
  const stillLive = sql<{ readonly accountId: string }>`
    SELECT DISTINCT account_id AS "accountId" FROM ai_account_retired_credentials
  `.pipe(
    Effect.map((rows) => new Set(rows.map((row) => row.accountId))),
    Effect.catch(storage("read the AI accounts")),
  );

  /** What the summaries need to know of the gateway now. */
  const viewContext = Effect.gen(function* () {
    return {
      running: Option.isSome(yield* gateway.endpoint),
      stillLive: yield* stillLive,
    } satisfies ViewContext;
  });

  /**
   * The Owner's existing Spaces and Users, in one read each: an allowance to a deleted Space or a
   * removed User is not shown and is dropped by the next `allow`.
   */
  const existingSubjects = Effect.fn("AiAccounts.existingSubjects")(function* (
    ownerId: UserId,
    spaceIds: ReadonlyArray<SpaceId>,
  ) {
    const known = yield* spaces.spacesById(spaceIds).pipe(Effect.catch(storage("read the Spaces")));
    const users = yield* spaces.listUsers(ownerId).pipe(Effect.catch(storage("read the Users")));
    return {
      spaces: new Set<string>(known.keys()),
      users: new Set<string>(
        users.filter((user) => user.status !== "removed").map((user) => user.id),
      ),
    };
  });

  /** Quota windows by token file, read from the providers through the gateway (5 min cache). */
  let quotaCache:
    | {
        readonly baseUrl: string;
        readonly at: number;
        readonly byName: ReadonlyMap<string, ServerProviderUsageLimits>;
      }
    | undefined;
  const quotaWindows = Effect.fn("AiAccounts.quotaWindows")(function* (endpoint: CliproxyEndpoint) {
    const at = yield* Clock.currentTimeMillis;
    const cached = quotaCache;
    if (
      cached !== undefined &&
      cached.baseUrl === endpoint.baseUrl &&
      at - cached.at < QUOTA_TTL_MS
    ) {
      return cached.byName;
    }
    // The existing reader (`usage/cliproxyApi.ts`), pointed at the gateway the Hub runs.
    const read = yield* usageReader
      .readAccounts({
        url: endpoint.baseUrl as never,
        managementKey: Redacted.value(endpoint.managementKey),
        api: "v8",
      })
      .pipe(
        Effect.timeoutOption(Duration.seconds(10)),
        Effect.map(Option.getOrElse(() => [])),
        // A credential list it cannot read (field names changed in a newer CLIProxyAPI) is said.
        Effect.tapError((error) =>
          Effect.logWarning("AiAccounts: could not read the subscriptions' quota windows", {
            reason: error.detail,
          }),
        ),
        Effect.orElseSucceed(() => []),
      );
    const byName = new Map(read.map((account) => [account.id, account.usageLimits] as const));
    quotaCache = { baseUrl: endpoint.baseUrl, at, byName };
    return byName;
  });

  /** For the Owner's list: each signed-in subscription's account and quota windows, fail-soft. */
  const subscriptionExtras = Effect.fn("AiAccounts.subscriptionExtras")(function* (
    rows: ReadonlyArray<AccountRow>,
  ) {
    const extras = new Map<string, SubscriptionExtras>();
    const signedIn = rows.filter(
      (row) => row.type === "subscription" && row.credentialId !== null && row.deletedAt === null,
    );
    if (signedIn.length === 0) return extras;
    const endpoint = yield* gateway.endpoint;
    if (Option.isNone(endpoint)) return extras;
    const held = yield* management
      .credentials(endpoint.value)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<CliproxyCredential> => []));
    const quotas = signedIn.some((row) => row.provider === "claude" || row.provider === "codex")
      ? yield* quotaWindows(endpoint.value)
      : new Map<string, ServerProviderUsageLimits>();
    for (const row of signedIn) {
      const name = tokenFileNameOf(row.accountId, row.credentialId ?? "");
      const entry = held.find((candidate) => candidate.name === name);
      const limits = quotas.get(name);
      extras.set(row.accountId, {
        signedInAs:
          signedInAsOf(entry?.email) ?? signedInAsOf((yield* sealedOf(row.credentialId))?.email),
        // Its windows only: nothing derived from the credential.
        usageLimits:
          limits === undefined
            ? null
            : {
                checkedAt: limits.checkedAt,
                windows: limits.windows,
                ...(limits.unavailable === undefined ? {} : { unavailable: limits.unavailable }),
              },
      });
    }
    return extras;
  });

  const ownerAccounts = Effect.fn("AiAccounts.ownerAccounts")(function* (
    ownerId: UserId,
    only?: string,
  ) {
    const rows =
      only === undefined
        ? yield* sql<AccountRow>`
          SELECT ${sql.literal(ACCOUNT_COLUMNS)} FROM ai_accounts ORDER BY priority, account_id
        `.pipe(Effect.catch(storage("read the AI accounts")))
        : [yield* findRow(only)];
    const allowances = yield* allowancesOf(rows.map((row) => row.accountId));
    const existing = yield* existingSubjects(
      ownerId,
      allowances.flatMap((allowance) =>
        allowance.subjectKind === "space" ? [allowance.subjectId as SpaceId] : [],
      ),
    );
    const shown = allowances.filter((allowance) =>
      allowance.subjectKind === "space"
        ? existing.spaces.has(allowance.subjectId)
        : existing.users.has(allowance.subjectId),
    );
    const context = yield* viewContext;
    const extras = yield* subscriptionExtras(rows);
    return rows.map((row) => summaryOf(row, context, { _tag: "owner", allowances: shown, extras }));
  });

  const ownerSummaryOf = Effect.fn("AiAccounts.ownerSummaryOf")(function* (
    ownerId: UserId,
    accountId: string,
  ) {
    const [summary] = yield* ownerAccounts(ownerId, accountId);
    if (summary === undefined) return yield* fail("not-found", NOT_FOUND);
    return summary;
  });

  /**
   * Anyone else: the accounts AllowedAiAccounts lets them use in the Spaces they may act in now
   * (a session limited to one Space: that one), with where; name, provider and status only.
   */
  const usableList = Effect.fn("AiAccounts.usableList")(function* (userId: UserId) {
    const limit = yield* CommandActor.spaceLimit;
    const viewable = yield* spaces
      .viewableSpaces(userId)
      .pipe(Effect.catch(storage("read your Spaces")));
    const candidates = limit !== undefined ? [limit] : viewable === "all" ? [] : [...viewable];
    // AllowedAiAccounts keeps to the Spaces the User works in (its one rule).
    const bySpace = yield* allowed
      .forSpaces(userId, candidates)
      .pipe(Effect.catch(storage("read the AI accounts you may use")));
    const usableIn = new Map<string, Array<SpaceId>>();
    for (const [spaceId, accounts] of bySpace) {
      for (const account of accounts) {
        const where = usableIn.get(account.id) ?? [];
        where.push(spaceId);
        usableIn.set(account.id, where);
      }
    }
    if (usableIn.size === 0) return [] as ReadonlyArray<AiAccountSummary>;
    const rows = yield* sql<AccountRow>`
      SELECT ${sql.literal(ACCOUNT_COLUMNS)} FROM ai_accounts
      WHERE ${sql.in("account_id", [...usableIn.keys()])} AND deleted_at IS NULL
      ORDER BY priority, account_id
    `.pipe(Effect.catch(storage("read the AI accounts")));
    const context = yield* viewContext;
    return rows.map((row) =>
      summaryOf(row, context, { _tag: "user", usableIn: usableIn.get(row.accountId) ?? [] }),
    );
  });

  const list = Effect.gen(function* () {
    const { userId, manages } = yield* caller;
    const accounts = manages ? yield* ownerAccounts(userId) : yield* usableList(userId);
    return { accounts, canManage: manages } satisfies AiAccountListResult;
  }).pipe(Effect.withSpan("AiAccounts.list"));

  const nameTaken = Effect.fn("AiAccounts.nameTaken")(function* (name: string, except?: string) {
    const rows = yield* sql<{ readonly accountId: string }>`
      SELECT account_id AS "accountId" FROM ai_accounts WHERE name = ${name} COLLATE NOCASE
    `.pipe(Effect.catch(storage("read the AI accounts")));
    if (rows.some((row) => row.accountId !== except)) {
      return yield* fail("duplicate-name", `There is already an AI account named ${name}.`);
    }
  });

  /** A new credential under a new id: no row points at it until its transaction commits. */
  const writeCredential = Effect.fn("AiAccounts.writeCredential")(function* (key: string) {
    const credentialId = `cred-${yield* newId(16)}`;
    yield* credentials
      .set(credentialId, new TextEncoder().encode(key))
      .pipe(Effect.catch(storage("store the API key")));
    return credentialId;
  });

  /** Removes a credential no row holds; one left behind by a failure is swept at the next start. */
  const removeCredential = Effect.fn("AiAccounts.removeCredential")(function* (
    credentialId: string | null,
  ) {
    if (credentialId === null) return;
    yield* credentials.remove(credentialId).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("AiAccounts: could not remove a credential; the next start removes it", {
          credentialId,
          cause,
        }),
      ),
    );
  });

  /**
   * Runs `write` (rows and audit) in one transaction after `key` is stored under a new id; on
   * failure that credential goes.
   */
  const withNewCredential = Effect.fn("AiAccounts.withNewCredential")(function* <A, E>(
    key: string | undefined,
    what: string,
    write: (credentialId: string | null) => Effect.Effect<A, E>,
  ) {
    const credentialId = key === undefined ? null : yield* writeCredential(key);
    return yield* sql
      .withTransaction(write(credentialId))
      .pipe(
        Effect.catch((error) =>
          removeCredential(credentialId).pipe(Effect.andThen(orStorage(what)(error))),
        ),
      );
  });

  const checkEndpoint = (
    provider: AiAccountProvider,
    baseUrl: string | undefined,
    models: ReadonlyArray<string> | undefined,
  ) => {
    if (provider !== "openai-compatible") {
      return baseUrl === undefined && models === undefined
        ? Effect.void
        : fail("invalid", "Only an OpenAI-compatible account takes a base URL and models.");
    }
    if (baseUrl !== undefined) {
      const problem = baseUrlProblem(baseUrl);
      if (problem !== undefined) return fail("invalid", problem);
    }
    if (models !== undefined && models.length === 0) {
      return fail("invalid", "List at least one model it serves.");
    }
    return Effect.void;
  };

  /** Whether the gateway still may hold one of the account's retired keys. */
  const keyStillLive = Effect.fn("AiAccounts.keyStillLive")(function* (accountId: string) {
    const rows = yield* sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM ai_account_retired_credentials WHERE account_id = ${accountId}
    `.pipe(Effect.catch(storage("read the AI account")));
    return (rows[0]?.n ?? 0) > 0;
  });

  const create = Effect.fn("AiAccounts.create")(function* (input: AiAccountCreateInput) {
    const userId = yield* manager;
    const key = Redacted.value(input.apiKey).trim();
    const problem = credentialProblem(key);
    if (problem !== undefined) return yield* fail("invalid", problem);
    const type = input.type ?? "api-key";
    // Ticket 07: a direct credential is an API key of a provider whose agent takes no base URL;
    // an API key the gateway uses is one of the gateway's providers. Never the other way round.
    if (
      type === "direct" ? !isAiDirectProvider(input.provider) : !isAiApiKeyProvider(input.provider)
    ) {
      return yield* fail(
        "invalid",
        type === "direct"
          ? "A direct credential is for Gemini, Vertex AI, Cursor, Kiro, Fx, Meta, Devin or xAI."
          : "That provider takes a direct credential: choose «Direct credential».",
      );
    }
    if (type === "direct" && (input.baseUrl !== undefined || input.models !== undefined)) {
      return yield* fail("invalid", "A direct credential takes no base URL or models.");
    }
    // A Vertex service account is a file, never handed to an agent: a Vertex AI express key only.
    if (type === "direct" && key.startsWith("{")) {
      return yield* fail(
        "invalid",
        "A direct credential is an API key. A Vertex AI service account goes through the AI gateway («Import Vertex service account»).",
      );
    }
    yield* checkEndpoint(input.provider, input.baseUrl, input.models);
    if (
      input.provider === "openai-compatible" &&
      (input.baseUrl === undefined || input.models === undefined)
    ) {
      return yield* fail("invalid", "An OpenAI-compatible account needs its base URL and models.");
    }
    yield* nameTaken(input.name);
    const accountId = yield* newId(8);
    const at = yield* now;
    const models = [...new Set(input.models ?? [])];
    yield* withNewCredential(key, "add the AI account", (credentialId) =>
      Effect.gen(function* () {
        const last = yield* sql<{ readonly top: number | null }>`
          SELECT MAX(priority) AS top FROM ai_accounts
        `;
        yield* sql`
          INSERT INTO ai_accounts (account_id, name, type, provider, priority, status, disabled,
            credential_id, key_hint, base_url, models_json, created_at, updated_at, created_by)
          VALUES (${accountId}, ${input.name}, ${type}, ${input.provider}, ${(last[0]?.top ?? 0) + 1},
            ${type === "direct" ? "working" : "pending"}, 0, ${credentialId}, ${hintOf(key)},
            ${input.baseUrl ?? null}, ${encodeModels(models)}, ${at}, ${at}, ${userId})
        `;
        yield* audit.record({
          actor: AuditLog.userActor(userId),
          action: "ai_account.create",
          target: { kind: "ai_account", id: accountId, name: input.name },
          detail: { provider: input.provider, type },
        });
      }),
    ).pipe(
      Effect.catch((error) =>
        // A name taken meanwhile says so; anything else stays as it was.
        nameTaken(input.name).pipe(Effect.andThen(Effect.fail(error))),
      ),
    );
    yield* syncNow;
    return yield* ownerSummaryOf(userId, accountId);
  });

  /**
   * Rename, disable or enable, «Replace credential», or an OpenAI-compatible account's URL and
   * models. Only what the gateway holds (not the name) changes the gateway. A replaced key stays
   * retired until the gateway confirms it dropped it; until then the call says it is still live.
   */
  const update = Effect.fn("AiAccounts.update")(function* (input: AiAccountUpdateInput) {
    const userId = yield* manager;
    const row = yield* findAccount(input.accountId);
    const key = input.apiKey === undefined ? undefined : Redacted.value(input.apiKey).trim();
    if (key !== undefined && row.type === "subscription") {
      return yield* fail("invalid", "A subscription takes no API key: use «Sign in again».");
    }
    if (key !== undefined) {
      const problem = credentialProblem(key);
      if (problem !== undefined) return yield* fail("invalid", problem);
      if (row.type === "direct" && key.startsWith("{")) {
        return yield* fail("invalid", "A direct credential is an API key.");
      }
    }
    yield* checkEndpoint(row.provider, input.baseUrl, input.models);
    const renamed = input.name !== undefined && input.name !== row.name;
    if (renamed) yield* nameTaken(input.name ?? "", row.accountId);
    const disabledNow = input.disabled === undefined ? row.disabled === 1 : input.disabled;
    const toggled = disabledNow !== (row.disabled === 1);
    const models = input.models === undefined ? undefined : [...new Set(input.models)];
    const endpointChanged =
      (input.baseUrl !== undefined && input.baseUrl !== row.baseUrl) ||
      (models !== undefined && encodeModels(models) !== row.modelsJson);
    if (!renamed && !toggled && key === undefined && !endpointChanged) {
      return yield* ownerSummaryOf(userId, row.accountId);
    }
    const gatewayChanges = toggled || key !== undefined || endpointChanged;
    const at = yield* now;
    yield* withNewCredential(key, "change the AI account", (credentialId) =>
      Effect.gen(function* () {
        const current = yield* sql<{ readonly credentialId: string | null }>`
          SELECT credential_id AS "credentialId" FROM ai_accounts
          WHERE account_id = ${row.accountId} AND deleted_at IS NULL
        `;
        const before = current[0];
        if (before === undefined) return yield* fail("not-found", NOT_FOUND);
        if (credentialId !== null && before.credentialId !== null) {
          yield* sql`
            INSERT INTO ai_account_retired_credentials (credential_id, account_id, retired_at)
            VALUES (${before.credentialId}, ${row.accountId}, ${at})
          `;
        }
        yield* sql`
          UPDATE ai_accounts SET
            name = ${input.name ?? row.name},
            disabled = ${disabledNow ? 1 : 0},
            credential_id = ${credentialId ?? before.credentialId},
            key_hint = ${key === undefined ? row.keyHint : hintOf(key)},
            base_url = ${input.baseUrl ?? row.baseUrl},
            models_json = ${models === undefined ? row.modelsJson : encodeModels(models)},
            status = ${gatewayChanges ? "pending" : row.status},
            status_message = ${gatewayChanges ? null : row.statusMessage},
            updated_at = ${at}
          WHERE account_id = ${row.accountId}
        `;
        yield* audit.record({
          actor: AuditLog.userActor(userId),
          action: "ai_account.update",
          target: { kind: "ai_account", id: row.accountId, name: input.name ?? row.name },
          detail: {
            provider: row.provider,
            ...(renamed ? { from: row.name, to: input.name ?? row.name } : {}),
            ...(toggled ? { disabled: disabledNow } : {}),
            ...(key === undefined ? {} : { credential: "replaced" }),
            ...(endpointChanged ? { endpoint: true } : {}),
          },
        });
      }),
    );
    if (gatewayChanges) yield* syncNow;
    if (key !== undefined && (yield* keyStillLive(row.accountId))) {
      return yield* fail(
        "still-live",
        "The new key is saved, but the AI gateway has not taken it yet and the old key is still live there. The Hub keeps trying.",
      );
    }
    return yield* ownerSummaryOf(userId, row.accountId);
  });

  /**
   * Deleted at once for everyone (no allowance, not in the gateway's next change); its key stays
   * retired until the gateway confirms it dropped it, and its row with it. Until then the call says
   * the key is still live; with no gateway running it is live nowhere, and goes at once.
   */
  const remove = Effect.fn("AiAccounts.remove")(function* (input: AiAccountDeleteInput) {
    const userId = yield* manager;
    const row = yield* findRow(input.accountId);
    if (row.deletedAt === null) {
      const at = yield* now;
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM ai_account_allowances WHERE account_id = ${row.accountId}`;
            // Ticket 09: a key moved into it and saved again later is moved again, never lost.
            yield* sql`DELETE FROM ai_account_migrated_keys WHERE account_id = ${row.accountId}`;
            if (row.credentialId !== null) {
              yield* sql`
                INSERT INTO ai_account_retired_credentials (credential_id, account_id, retired_at)
                VALUES (${row.credentialId}, ${row.accountId}, ${at})
              `;
            }
            yield* sql`
              UPDATE ai_accounts SET deleted_at = ${at}, credential_id = NULL, status = 'removing',
                status_message = NULL, updated_at = ${at}
              WHERE account_id = ${row.accountId}
            `;
            yield* audit.record({
              actor: AuditLog.userActor(userId),
              action: "ai_account.delete",
              target: { kind: "ai_account", id: row.accountId, name: row.name },
              detail: { provider: row.provider },
            });
          }),
        )
        .pipe(Effect.catch(orStorage("delete the AI account")));
    }
    const outcome = yield* syncNow;
    if (yield* keyStillLive(row.accountId)) {
      return yield* fail(
        "still-live",
        "Deleted, but its key is still live in the AI gateway, which has not taken the change yet. The Hub keeps trying to remove it.",
      );
    }
    return {
      deleted: true,
      gateway: outcome === "not-running" ? "not-running" : "removed",
    } satisfies AiAccountDeleteResult;
  });

  /** Replaces who may use it; Spaces and Users that no longer exist are dropped. */
  const allow = Effect.fn("AiAccounts.allow")(function* (input: AiAccountAllowInput) {
    const userId = yield* manager;
    const row = yield* findAccount(input.accountId);
    const existing = yield* existingSubjects(userId, [...new Set(input.spaceIds)]);
    const spaceIds = [...new Set(input.spaceIds)].filter((id) => existing.spaces.has(id));
    const userIds = [...new Set(input.userIds)].filter((id) => existing.users.has(id));
    const at = yield* now;
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const before = yield* sql<AllowanceRow>`
            SELECT account_id AS "accountId", subject_kind AS "subjectKind", subject_id AS "subjectId"
            FROM ai_account_allowances WHERE account_id = ${row.accountId}
          `;
          const next = new Set([
            ...spaceIds.map((id) => `space:${id}`),
            ...userIds.map((id) => `user:${id}`),
          ]);
          const had = new Set(
            before.map((allowance) => `${allowance.subjectKind}:${allowance.subjectId}`),
          );
          yield* sql`DELETE FROM ai_account_allowances WHERE account_id = ${row.accountId}`;
          for (const [kind, ids] of [
            ["space", spaceIds],
            ["user", userIds],
          ] as const) {
            for (const id of ids) {
              yield* sql`
                INSERT INTO ai_account_allowances (account_id, subject_kind, subject_id, created_at)
                VALUES (${row.accountId}, ${kind}, ${id}, ${at})
              `;
            }
          }
          yield* audit.record({
            actor: AuditLog.userActor(userId),
            action: "ai_account.allow",
            target: { kind: "ai_account", id: row.accountId, name: row.name },
            detail: {
              spaces: spaceIds.length,
              users: userIds.length,
              added: [...next].filter((subject) => !had.has(subject)).length,
              removed: [...had].filter((subject) => !next.has(subject)).length,
            },
          });
        }),
      )
      .pipe(Effect.catch(orStorage("change who may use the AI account")));
    return yield* ownerSummaryOf(userId, row.accountId);
  });

  /** The Installation's one order; the gateway does not hold it, so it is not touched. */
  const reorder = Effect.fn("AiAccounts.reorder")(function* (input: AiAccountReorderInput) {
    const userId = yield* manager;
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{
            readonly accountId: string;
            readonly name: string;
            readonly priority: number;
            readonly provider: string;
          }>`
            SELECT account_id AS "accountId", name AS "name", priority AS "priority", provider AS "provider"
            FROM ai_accounts WHERE deleted_at IS NULL
          `;
          const ordered = [...new Set(input.accountIds)];
          if (
            ordered.length !== rows.length ||
            !rows.every((row) => ordered.includes(row.accountId as AiAccountId))
          ) {
            return yield* fail("invalid", "List every AI account once, first to last.");
          }
          for (const [index, accountId] of ordered.entries()) {
            const row = rows.find((candidate) => candidate.accountId === accountId);
            if (row === undefined || row.priority === index + 1) continue;
            yield* sql`UPDATE ai_accounts SET priority = ${index + 1} WHERE account_id = ${accountId}`;
            yield* audit.record({
              actor: AuditLog.userActor(userId),
              action: "ai_account.update",
              target: { kind: "ai_account", id: accountId, name: row.name },
              detail: { provider: row.provider, priority: index + 1 },
            });
          }
        }),
      )
      .pipe(Effect.catch(orStorage("change the order of the AI accounts")));
    return {
      accounts: yield* ownerAccounts(userId),
      canManage: true,
    } satisfies AiAccountListResult;
  });

  const modelsOf = Effect.fn("AiAccounts.modelsOf")(function* (accountId: AiAccountId) {
    const row = yield* findAccount(accountId);
    if (row.disabled === 1) return [] as ReadonlyArray<string>;
    const prefix = `${aiAccountPrefixOf(row.accountId)}/`;
    const ids = yield* catalogIds;
    return ids.filter((id) => id.startsWith(prefix)).map((id) => id.slice(prefix.length));
  });

  // Subscription AI accounts (spec 4 ticket 03): signed in through CLIProxyAPI's OAuth, by the
  // Owner, from the session that started it; the token sealed in its own store.

  const LOGIN_GONE = "No sign-in with that id is open for this session. Start it again.";

  /** The gateway a subscription can go into: running, with its credentials in memory. */
  const subscriptionGateway = Effect.gen(function* () {
    if (!(yield* gateway.status).credentialsInMemory) {
      return yield* fail("unavailable", NO_MEMORY_FOLDER);
    }
    const endpoint = yield* gateway.endpoint;
    if (Option.isNone(endpoint)) {
      return yield* fail(
        "unavailable",
        "The AI gateway is not running. Turn it on in Settings → AI gateway.",
      );
    }
    return endpoint.value;
  });

  const loginAudit = (
    userId: UserId,
    target: { readonly id: string; readonly name: string },
    detail: {
      readonly provider: string;
      readonly kind: "new" | "again" | "import";
      readonly outcome: "signed-in" | "failed";
      readonly reason?: string;
    },
  ) =>
    audit
      .record({
        actor: AuditLog.userActor(userId),
        action: "ai_account.login",
        target: { kind: "ai_account", ...target },
        detail,
      })
      .pipe(Effect.ignore({ log: true }));

  const loginStart = Effect.fn("AiAccounts.loginStart")(function* (
    input: AiAccountLoginStartInput,
    sessionId: string,
  ) {
    const userId = yield* manager;
    let target: PendingLogin["target"];
    if (input.accountId !== undefined) {
      const row = yield* findAccount(input.accountId);
      if (row.type !== "subscription" || row.provider !== input.provider) {
        return yield* fail("invalid", "Only a subscription signs in again, to the same provider.");
      }
      target = { _tag: "again", accountId: row.accountId };
    } else {
      if (input.name === undefined) return yield* fail("invalid", "Name the new AI account.");
      yield* nameTaken(input.name);
      target = { _tag: "new", name: input.name };
    }
    const endpoint = yield* subscriptionGateway;
    const before = yield* management
      .credentials(endpoint)
      .pipe(Effect.catch(() => fail("unavailable", "The AI gateway did not answer. Try again.")));
    const started = yield* management
      .oauthStart(endpoint, CLIPROXY_PROVIDER[input.provider])
      .pipe(
        Effect.catch(() =>
          fail("sign-in-failed", "The AI gateway could not start a sign-in for that provider."),
        ),
      );
    // The Owner opens it: only a provider's https page, never another scheme.
    const page = httpsPageOf(started.url);
    if (page === undefined) {
      return yield* fail("sign-in-failed", "The AI gateway gave no usable sign-in page.");
    }
    const redirectUri = started.flow === "redirect" ? redirectUriOf(started.url) : undefined;
    if (started.flow === "redirect" && redirectUri === undefined) {
      return yield* fail("sign-in-failed", "The sign-in page names no address to return to.");
    }
    const loginId = `login-${yield* newId(16)}`;
    const expiresAt = (yield* Clock.currentTimeMillis) + (options.loginTtlMs ?? LOGIN_TTL_MS);
    // One sign-in at a time: a new one replaces the one before.
    yield* dropHeld(pendingLogin);
    pendingLogin = {
      loginId,
      ownerId: userId,
      sessionId,
      provider: input.provider,
      flow: started.flow,
      state: started.state,
      redirectUri: redirectUri ?? null,
      expiresAt,
      target,
      baseUrl: endpoint.baseUrl,
      before: new Set(before.map((entry) => entry.name)),
      completing: false,
    };
    return {
      loginId,
      provider: input.provider,
      flow: started.flow,
      url: page,
      userCode: started.userCode,
      expiresAt: DateTime.formatIso(DateTime.makeUnsafe(expiresAt)),
    } satisfies AiAccountLoginStartResult;
  });

  /**
   * Under the lock: the one token file a sign-in or import just left in the gateway (of its
   * provider, not held before), checked to be of that provider and sealed under a new token id; the
   * file CLIProxyAPI named goes. Anything else (none, several, another type) is refused.
   */
  const takeToken = Effect.fn("AiAccounts.takeToken")(function* (input: {
    readonly endpoint: CliproxyEndpoint;
    readonly cliproxyProvider: string;
    readonly before: ReadonlySet<string>;
  }) {
    const { endpoint } = input;
    let found: ReadonlyArray<CliproxyCredential> = [];
    for (let round = 0; round < 10 && found.length === 0; round += 1) {
      if (round > 0) yield* Effect.sleep(Duration.millis(300));
      const held = yield* management
        .credentials(endpoint)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<CliproxyCredential> => []));
      found = held.filter(
        (entry) =>
          parseTokenFileName(entry.name) === undefined &&
          !input.before.has(entry.name) &&
          entry.provider === input.cliproxyProvider,
      );
    }
    const dropRaw = Effect.forEach(
      found,
      (entry) =>
        management.deleteCredential(endpoint, entry.name).pipe(Effect.ignore({ log: true })),
      { discard: true },
    );
    const only = found[0];
    if (only === undefined) {
      return yield* fail("sign-in-failed", "The AI gateway signed in but kept no credential.");
    }
    if (found.length > 1) {
      yield* dropRaw;
      return yield* fail(
        "sign-in-failed",
        "More than one new sign-in came back from the AI gateway. Start it again.",
      );
    }
    const copy = yield* management
      .downloadCredential(endpoint, only.name)
      .pipe(Effect.orElseSucceed(() => Option.none<Uint8Array>()));
    const token = Option.isSome(copy) ? parseToken(copy.value) : undefined;
    if (token === undefined || token.type !== input.cliproxyProvider) {
      yield* dropRaw;
      return yield* fail("sign-in-failed", "The AI gateway kept a credential the Hub cannot use.");
    }
    const tokenId = `tok-${yield* newId(16)}`;
    yield* tokens
      .set(tokenId, sealedTokenBytes(token))
      .pipe(
        Effect.catch((error) => dropRaw.pipe(Effect.andThen(storage("store the sign-in")(error)))),
      );
    yield* dropRaw;
    return { tokenId, token, signedInAs: signedInAsOf(token.email) };
  });

  /** The sealed token of an account, when the store has one the Hub can read. */
  const sealedOf = (tokenId: string | null) =>
    tokenId === null
      ? Effect.succeed(undefined)
      : tokens.get(tokenId).pipe(
          Effect.map((stored) => (Option.isSome(stored) ? parseToken(stored.value) : undefined)),
          Effect.orElseSucceed(() => undefined),
        );

  /**
   * Under the lock: a taken token onto its account. A new account starts disabled, with who it
   * signed in as, until the Owner checks it and turns it on; «Sign in again» swaps the token under
   * the account's allowances and retires the old one. Then the token goes into the gateway.
   */
  const attach = Effect.fn("AiAccounts.attach")(function* (input: {
    readonly endpoint: CliproxyEndpoint;
    readonly userId: UserId;
    readonly provider: AiAccountProvider;
    readonly target: PendingLogin["target"];
    readonly kind: "new" | "again" | "import";
    readonly taken: TakenToken;
  }) {
    const { tokenId, token, signedInAs } = input.taken;
    const at = yield* now;
    const target = input.target;
    const written = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          if (target._tag === "again") {
            const accountId = target.accountId;
            const rows = yield* sql<{
              readonly name: string;
              readonly credentialId: string | null;
            }>`
              SELECT name AS "name", credential_id AS "credentialId" FROM ai_accounts
              WHERE account_id = ${accountId} AND deleted_at IS NULL
            `;
            const before = rows[0];
            if (before === undefined) return yield* fail("not-found", NOT_FOUND);
            if (before.credentialId !== null) {
              yield* sql`
                INSERT INTO ai_account_retired_credentials (credential_id, account_id, retired_at)
                VALUES (${before.credentialId}, ${accountId}, ${at})
              `;
            }
            yield* sql`
              UPDATE ai_accounts SET credential_id = ${tokenId}, status = 'pending',
                status_message = NULL, updated_at = ${at}
              WHERE account_id = ${accountId}
            `;
            yield* loginAudit(
              input.userId,
              { id: accountId, name: before.name },
              { provider: input.provider, kind: input.kind, outcome: "signed-in" },
            );
            return accountId;
          }
          const accountId = yield* newId(8);
          const last = yield* sql<{ readonly top: number | null }>`
            SELECT MAX(priority) AS top FROM ai_accounts
          `;
          yield* sql`
            INSERT INTO ai_accounts (account_id, name, type, provider, priority, status, disabled,
              status_message, credential_id, key_hint, base_url, models_json, created_at,
              updated_at, created_by)
            VALUES (${accountId}, ${target.name}, 'subscription', ${input.provider},
              ${(last[0]?.top ?? 0) + 1}, 'pending', 1, ${confirmMessageOf(signedInAs)}, ${tokenId},
              NULL, NULL, '[]', ${at}, ${at}, ${input.userId})
          `;
          yield* audit.record({
            actor: AuditLog.userActor(input.userId),
            action: "ai_account.create",
            target: { kind: "ai_account", id: accountId, name: target.name },
            detail: { provider: input.provider, type: "subscription" },
          });
          yield* loginAudit(
            input.userId,
            { id: accountId, name: target.name },
            { provider: input.provider, kind: input.kind, outcome: "signed-in" },
          );
          return accountId;
        }),
      )
      .pipe(
        Effect.catch((error) =>
          tokens
            .remove(tokenId)
            .pipe(
              Effect.ignore({ log: true }),
              Effect.andThen(orStorage("save the sign-in")(error)),
            ),
        ),
      );
    // «Sign in again»: into the gateway under the account's own name and prefix now. A new
    // account goes in once the Owner turns it on.
    if (target._tag === "again") {
      yield* management
        .uploadCredential(
          input.endpoint,
          tokenFileNameOf(written, tokenId),
          tokenForAccount(token, written),
        )
        .pipe(Effect.ignore({ log: true }));
    }
    return written;
  });

  /** A token taken but held back for the Owner's confirmation goes from the store. */
  const dropHeld = (login: PendingLogin | undefined) =>
    login?.held === undefined
      ? Effect.void
      : tokens.remove(login.held.tokenId).pipe(Effect.ignore({ log: true }));

  const loginComplete = Effect.fn("AiAccounts.loginComplete")(function* (
    input: AiAccountLoginCompleteInput,
    sessionId: string,
  ) {
    const userId = yield* manager;
    const login = pendingLogin;
    if (
      login === undefined ||
      login.loginId !== input.loginId ||
      login.ownerId !== userId ||
      login.sessionId !== sessionId
    ) {
      return yield* fail("expired", LOGIN_GONE);
    }
    // Claimed before anything else yields: a second call at once is refused, never run twice.
    if (login.completing) return yield* fail("pending", "That sign-in is being finished.");
    login.completing = true;
    return yield* completeLogin(input, login, userId).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          login.completing = false;
        }),
      ),
    );
  });

  const completeLogin = Effect.fn("AiAccounts.completeLogin")(function* (
    input: AiAccountLoginCompleteInput,
    login: PendingLogin,
    userId: UserId,
  ) {
    const forget = Effect.suspend(() => {
      if (pendingLogin !== login) return Effect.void;
      pendingLogin = undefined;
      return dropHeld(login);
    });
    if ((yield* Clock.currentTimeMillis) >= login.expiresAt) {
      yield* forget;
      return yield* fail("expired", "That sign-in is over (10 minutes). Start it again.");
    }
    const endpoint = yield* gateway.endpoint;
    if (Option.isNone(endpoint) || endpoint.value.baseUrl !== login.baseUrl) {
      yield* forget;
      return yield* fail("expired", "The AI gateway restarted since. Start the sign-in again.");
    }
    const finish = (taken: TakenToken) =>
      syncLock
        .withPermits(1)(
          attach({
            endpoint: endpoint.value,
            userId,
            provider: login.provider,
            target: login.target,
            kind: login.target._tag,
            taken,
          }),
        )
        .pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              if (pendingLogin === login) pendingLogin = undefined;
            }),
          ),
          Effect.flatMap((accountId) =>
            syncNow.pipe(Effect.andThen(ownerSummaryOf(userId, accountId))),
          ),
        );
    // «Sign in again» as another account, held for the Owner's word.
    if (login.held !== undefined) {
      if (input.confirmIdentity !== true) {
        return yield* fail("identity-mismatch", login.held.mismatch);
      }
      const taken = login.held;
      login.held = undefined;
      return yield* finish(taken);
    }
    const auditTarget =
      login.target._tag === "new"
        ? { id: "new", name: login.target.name }
        : { id: login.target.accountId, name: login.target.accountId };
    const failed = (message: string, reason: string) =>
      forget.pipe(
        Effect.andThen(
          loginAudit(userId, auditTarget, {
            provider: login.provider,
            kind: login.target._tag,
            outcome: "failed",
            reason,
          }),
        ),
        Effect.andThen(fail("sign-in-failed", message)),
      );
    const cliproxyProvider = CLIPROXY_PROVIDER[login.provider];
    if (login.flow === "redirect") {
      if (input.redirectUrl === undefined) {
        return yield* fail("invalid", "Paste the address the browser landed on after signing in.");
      }
      // Checked against this sign-in, never fetched; CLIProxyAPI gets an address rebuilt from it.
      const checked = checkPastedRedirect(Redacted.value(input.redirectUrl), {
        redirectUri: login.redirectUri ?? "",
        state: login.state,
      });
      if (checked._tag === "refused") return yield* fail("invalid", checked.problem.message);
      const handed = yield* management
        .oauthCallback(endpoint.value, cliproxyProvider, checked.redirectUrl)
        .pipe(Effect.orElseSucceed(() => false));
      if (!handed) {
        return yield* failed(
          "The AI gateway did not take that sign-in. Start it again.",
          "callback",
        );
      }
    }
    const rounds = login.flow === "redirect" ? LOGIN_STATUS_ROUNDS : DEVICE_STATUS_ROUNDS;
    let outcome: "ok" | "wait" | "error" = "wait";
    for (let round = 0; round < rounds && outcome === "wait"; round += 1) {
      if (round > 0) yield* Effect.sleep(LOGIN_STATUS_PAUSE);
      outcome = yield* management
        .oauthStatus(endpoint.value, login.state)
        .pipe(Effect.orElseSucceed(() => "wait" as const));
    }
    if (outcome === "wait") {
      if (login.flow === "device") {
        return yield* fail(
          "pending",
          "Not signed in yet: finish on the provider's page, then try again.",
        );
      }
      return yield* failed(
        "The provider did not finish the sign-in in time. Start it again.",
        "timeout",
      );
    }
    if (outcome === "error") {
      return yield* failed("The provider did not sign you in. Start it again.", "refused");
    }
    const taken = yield* syncLock
      .withPermits(1)(
        takeToken({ endpoint: endpoint.value, cliproxyProvider, before: login.before }),
      )
      .pipe(Effect.tapError(() => forget));
    if (login.target._tag === "again") {
      const accountId = login.target.accountId;
      const rows = yield* sql<{ readonly name: string; readonly credentialId: string | null }>`
        SELECT name AS "name", credential_id AS "credentialId" FROM ai_accounts
        WHERE account_id = ${accountId}
      `.pipe(Effect.catch(storage("read the AI account")));
      const before = yield* sealedOf(rows[0]?.credentialId ?? null);
      const was = signedInAsOf(before?.email);
      if (was !== taken.signedInAs) {
        login.held = {
          ...taken,
          mismatch: `This sign-in is ${taken.signedInAs ?? "an account the provider did not name"}, not ${was ?? "an account the provider did not name"} as before. Confirm to use it for ${rows[0]?.name ?? "this AI account"}.`,
        };
        return yield* fail("identity-mismatch", login.held.mismatch);
      }
    }
    return yield* finish(taken);
  });

  const importVertex = Effect.fn("AiAccounts.importVertex")(function* (
    input: AiAccountImportVertexInput,
  ) {
    const userId = yield* manager;
    const text = Redacted.value(input.serviceAccount).trim();
    if (!isVertexServiceAccount(text)) {
      return yield* fail("invalid", "That is not a Vertex service account key (its JSON file).");
    }
    yield* nameTaken(input.name);
    const endpoint = yield* subscriptionGateway;
    const accountId = yield* syncLock.withPermits(1)(
      Effect.gen(function* () {
        const before = yield* management
          .credentials(endpoint)
          .pipe(
            Effect.catch(() => fail("unavailable", "The AI gateway did not answer. Try again.")),
          );
        const answer = yield* management
          .importVertex(endpoint, new TextEncoder().encode(text))
          .pipe(
            Effect.catch(() => fail("unavailable", "The AI gateway did not answer. Try again.")),
          );
        if (answer._tag === "refused") {
          return yield* fail(
            "invalid",
            `The AI gateway refused it${answer.reason === "" ? "" : `: ${answer.reason}`}.`,
          );
        }
        const taken = yield* takeToken({
          endpoint,
          cliproxyProvider: "vertex",
          before: new Set(before.map((entry) => entry.name)),
        });
        return yield* attach({
          endpoint,
          userId,
          provider: "vertex",
          target: { _tag: "new", name: input.name },
          kind: "import",
          taken,
        });
      }),
    );
    yield* syncNow;
    return yield* ownerSummaryOf(userId, accountId);
  });

  /**
   * Ticket 15: another CLIProxyAPI's auth files, each sealed and disabled as a sign-in leaves it,
   * allowed to the Owner's Personal space; an identity already held is skipped. No gateway call.
   */
  const importCliproxy = Effect.fn("AiAccounts.importCliproxy")(function* (
    input: AiAccountImportCliproxyInput,
  ) {
    const userId = yield* manager;
    const personal = SpaceDirectory.personalSpaceIdOf(userId);
    return yield* syncLock.withPermits(1)(
      Effect.gen(function* () {
        const existing = yield* sql<{
          readonly name: string;
          readonly provider: AiAccountProvider;
          readonly credentialId: string;
        }>`
          SELECT name, provider, credential_id AS "credentialId" FROM ai_accounts
          WHERE type = 'subscription' AND deleted_at IS NULL AND credential_id IS NOT NULL
        `.pipe(Effect.catch(storage("read the AI accounts")));
        const held: Array<{ readonly identity: CliproxyIdentity; readonly name: string }> = [];
        for (const row of existing) {
          const sealed = yield* sealedOf(row.credentialId);
          if (sealed !== undefined)
            held.push({ identity: identityOf(row.provider, sealed), name: row.name });
        }
        const names = new Set(
          (yield* sql<{ readonly name: string }>`SELECT name FROM ai_accounts`.pipe(
            Effect.catch(storage("read the AI accounts")),
          )).map((row) => row.name.toLowerCase()),
        );
        const results: Array<AiAccountImportCliproxyFileResult> = [];
        const skipped = (fileName: string, reason: string) =>
          results.push({
            fileName,
            outcome: "skipped",
            accountId: null,
            name: null,
            signedInAs: null,
            reason,
          });
        for (const file of input.files) {
          const read = readCliproxyAuthFile(Redacted.value(file.contents));
          if (read._tag === "skipped") {
            skipped(file.fileName, read.reason);
            continue;
          }
          const identity = identityOf(read.provider, read.token);
          const holder = held.find((one) => sameIdentity(one.identity, identity));
          if (holder !== undefined) {
            skipped(file.fileName, `Already an AI account: «${holder.name}».`);
            continue;
          }
          const base = importedNameOf(read.provider, read.signedInAs);
          const name = [base, ...Array.from({ length: 50 }, (_, n) => `${base} ${n + 2}`)].find(
            (candidate) => !names.has(candidate.toLowerCase()),
          );
          if (name === undefined) {
            skipped(file.fileName, "No free name for it. Rename an AI account and try again.");
            continue;
          }
          const tokenId = `tok-${yield* newId(16)}`;
          const accountId = yield* newId(8);
          const at = yield* now;
          yield* tokens
            .set(tokenId, sealedTokenBytes(read.token))
            .pipe(Effect.catch(storage("seal the imported sign-in")));
          yield* sql
            .withTransaction(
              Effect.gen(function* () {
                const last = yield* sql<{ readonly top: number | null }>`
                  SELECT MAX(priority) AS top FROM ai_accounts
                `;
                yield* sql`
                  INSERT INTO ai_accounts (account_id, name, type, provider, priority, status,
                    disabled, status_message, credential_id, key_hint, base_url, models_json,
                    created_at, updated_at, created_by)
                  VALUES (${accountId}, ${name}, 'subscription', ${read.provider},
                    ${(last[0]?.top ?? 0) + 1}, 'pending', 1, ${confirmMessageOf(read.signedInAs)},
                    ${tokenId}, NULL, NULL, '[]', ${at}, ${at}, ${userId})
                `;
                yield* sql`
                  INSERT INTO ai_account_allowances (account_id, subject_kind, subject_id, created_at)
                  VALUES (${accountId}, 'space', ${personal}, ${at})
                `;
                yield* audit.record({
                  actor: AuditLog.userActor(userId),
                  action: "ai_account.create",
                  target: { kind: "ai_account", id: accountId, name },
                  detail: { provider: read.provider, type: "subscription", via: "import" },
                });
              }),
            )
            .pipe(
              Effect.catch((error) =>
                tokens
                  .remove(tokenId)
                  .pipe(
                    Effect.ignore({ log: true }),
                    Effect.andThen(orStorage("save the imported sign-in")(error)),
                  ),
              ),
            );
          held.push({ identity, name });
          names.add(name.toLowerCase());
          results.push({
            fileName: file.fileName,
            outcome: "imported",
            accountId: accountId as AiAccountId,
            name,
            signedInAs: read.signedInAs,
            reason: null,
          });
        }
        return { files: results } satisfies AiAccountImportCliproxyResult;
      }),
    );
  });

  const directCredential = Effect.fn("AiAccounts.directCredential")(function* (
    accountId: AiAccountId,
  ) {
    const row = yield* findAccount(accountId);
    if (row.type !== "direct" || row.disabled === 1 || row.credentialId === null) {
      return yield* fail("not-found", NOT_FOUND);
    }
    const credentialId = row.credentialId;
    const bytes = yield* credentials
      .get(credentialId)
      .pipe(Effect.catch(storage("read the AI account's credential")));
    if (Option.isNone(bytes)) return yield* fail("not-found", NOT_FOUND);
    return { credentialId, value: Redacted.make(new TextDecoder().decode(bytes.value)) };
  });

  /** Ticket 09: an account of that provider and type holding `key`, if one of the moved does. */
  const movedHolding = Effect.fn("AiAccounts.movedHolding")(function* (
    provider: AiAccountProvider,
    type: AiAccountType,
    key: string,
    accountIds: ReadonlyArray<string>,
  ) {
    if (accountIds.length === 0) return undefined;
    const rows = yield* sql<{ readonly accountId: string; readonly credentialId: string | null }>`
      SELECT account_id AS "accountId", credential_id AS "credentialId" FROM ai_accounts
      WHERE deleted_at IS NULL AND provider = ${provider} AND type = ${type}
        AND ${sql.in("account_id", accountIds)}
    `.pipe(Effect.catch(storage("read the AI accounts")));
    for (const row of rows) {
      if (row.credentialId === null) continue;
      const stored = yield* credentials
        .get(row.credentialId)
        .pipe(Effect.catch(storage("read an AI account's key")));
      if (Option.isSome(stored) && new TextDecoder().decode(stored.value) === key) {
        return row.accountId;
      }
    }
    return undefined;
  });

  const adoptProviderKey = Effect.fn("AiAccounts.adoptProviderKey")(function* (
    input: AdoptProviderKeyInput,
  ) {
    const key = Redacted.value(input.key).trim();
    const problem = credentialProblem(key);
    if (problem !== undefined) return yield* fail("invalid", problem);
    if (
      input.type === "direct"
        ? !isAiDirectProvider(input.provider) || key.startsWith("{")
        : !isAiApiKeyProvider(input.provider) || input.provider === "openai-compatible"
    ) {
      return yield* fail("invalid", "That key cannot become an AI account of that kind.");
    }
    const moved = yield* sql<{ readonly source: string; readonly accountId: string }>`
      SELECT source, account_id AS "accountId" FROM ai_account_migrated_keys
    `.pipe(Effect.catch(storage("read the moved keys")));
    const at = yield* now;
    const ledger = (accountId: string) => sql`
      INSERT INTO ai_account_migrated_keys (source, account_id, migrated_at)
      VALUES (${input.source}, ${accountId}, ${at})
      ON CONFLICT (source) DO UPDATE SET account_id = excluded.account_id,
        migrated_at = excluded.migrated_at
    `;
    const earlier = moved.find((row) => row.source === input.source);
    // Moved before and still holding this key: the instance's copy only goes. An account the Owner
    // deleted since cannot say which key it held, so the key becomes an account again, never lost.
    if (earlier !== undefined) {
      const same = yield* movedHolding(input.provider, input.type, key, [earlier.accountId]);
      if (same !== undefined) return { accountId: same, created: false };
    }
    const twin = yield* movedHolding(
      input.provider,
      input.type,
      key,
      moved.map((row) => row.accountId),
    );
    if (twin !== undefined) {
      yield* ledger(twin).pipe(Effect.catch(storage("record the moved key")));
      return { accountId: twin, created: false };
    }
    const taken = new Set(
      (yield* sql<{ readonly name: string }>`SELECT name FROM ai_accounts`.pipe(
        Effect.catch(storage("read the AI accounts")),
      )).map((row) => row.name.toLowerCase()),
    );
    const last = input.names.at(-1) ?? "Migrated key";
    const candidates = [
      ...input.names,
      ...Array.from({ length: 50 }, (_, n) => `${last} ${n + 2}`),
    ];
    const name = candidates.find((candidate) => !taken.has(candidate.toLowerCase()));
    if (name === undefined) return yield* fail("duplicate-name", "No free name for the key.");
    const accountId = yield* newId(8);
    const spaceId = SpaceDirectory.personalSpaceIdOf(input.ownerId);
    yield* withNewCredential(key, "move a provider key into an AI account", (credentialId) =>
      Effect.gen(function* () {
        const top = yield* sql<{ readonly top: number | null }>`
          SELECT MAX(priority) AS top FROM ai_accounts
        `;
        yield* sql`
          INSERT INTO ai_accounts (account_id, name, type, provider, priority, status, disabled,
            credential_id, key_hint, base_url, models_json, created_at, updated_at, created_by)
          VALUES (${accountId}, ${name}, ${input.type}, ${input.provider}, ${(top[0]?.top ?? 0) + 1},
            ${input.type === "direct" ? "working" : "pending"}, 0, ${credentialId}, ${hintOf(key)},
            NULL, ${encodeModels([])}, ${at}, ${at}, ${input.ownerId})
        `;
        yield* sql`
          INSERT INTO ai_account_allowances (account_id, subject_kind, subject_id, created_at)
          VALUES (${accountId}, 'space', ${spaceId}, ${at})
        `;
        yield* ledger(accountId);
        yield* audit.record({
          actor: { source: "system" },
          action: "ai_account.create",
          target: { kind: "ai_account", id: accountId, name },
          detail: { provider: input.provider, type: input.type, via: "migration" },
        });
      }),
    );
    if (input.type === "api-key") yield* syncNow;
    return { accountId, created: true };
  });

  const holdsKey = Effect.fn("AiAccounts.holdsKey")(
    function* (accountId: string, key: Redacted.Redacted<string>) {
      const rows = yield* sql<{
        readonly provider: AiAccountProvider;
        readonly type: AiAccountType;
      }>`
      SELECT provider, type FROM ai_accounts WHERE account_id = ${accountId} AND deleted_at IS NULL
    `;
      const row = rows[0];
      if (row === undefined) return false;
      const holder = yield* movedHolding(row.provider, row.type, Redacted.value(key).trim(), [
        accountId,
      ]);
      return holder !== undefined;
    },
    Effect.orElseSucceed(() => false),
  );

  const ownerSubscriptionLimits = Effect.gen(function* () {
    const { manages } = yield* caller;
    if (!manages) return null;
    const rows = yield* sql<{
      readonly accountId: string;
      readonly name: string;
      readonly provider: "claude" | "codex";
      readonly credentialId: string;
    }>`
      SELECT account_id AS "accountId", name, provider, credential_id AS "credentialId"
      FROM ai_accounts
      WHERE deleted_at IS NULL AND disabled = 0 AND type = 'subscription'
        AND provider IN ('claude', 'codex') AND credential_id IS NOT NULL
      ORDER BY priority, account_id
    `;
    // No subscription with windows to read: nothing to say.
    if (rows.length === 0) return null;
    const endpoint = yield* gateway.endpoint;
    if (Option.isNone(endpoint)) return { gatewayRunning: false, accounts: [] };
    const quotas = yield* quotaWindows(endpoint.value);
    return {
      gatewayRunning: true,
      accounts: rows.flatMap((row) => {
        const limits = quotas.get(tokenFileNameOf(row.accountId, row.credentialId));
        return limits === undefined
          ? []
          : [{ name: row.name, provider: row.provider, usageLimits: limits }];
      }),
    } satisfies HubSubscriptionLimits;
  }).pipe(
    // Fails closed: anything unreadable shows nothing rather than another User's windows.
    Effect.catchCause((cause) =>
      Effect.logWarning("AiAccounts: could not read the Hub's subscription limits", { cause }).pipe(
        Effect.as(null),
      ),
    ),
    Effect.withSpan("AiAccounts.ownerSubscriptionLimits"),
  );

  return AiAccounts.of({
    list,
    create,
    update,
    remove,
    allow,
    reorder,
    modelsOf,
    ownerSubscriptionLimits,
    sync: Effect.asVoid(syncNow),
    loginStart,
    loginComplete,
    importVertex,
    importCliproxy,
    directCredential,
    adoptProviderKey,
    holdsKey,
  });
});

/**
 * At the Hub's start no CLIProxyAPI holds a key yet: retired keys and deleted accounts go, and
 * credentials no account holds (a write that stopped half-way, an older database restored).
 */
const sweepCredentials = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const credentials = yield* ServerSecretStore.AiAccountCredentialStore;
  yield* sql`DELETE FROM ai_account_retired_credentials`;
  yield* sql`DELETE FROM ai_account_allowances WHERE account_id IN (SELECT account_id FROM ai_accounts WHERE deleted_at IS NOT NULL)`;
  yield* sql`DELETE FROM ai_accounts WHERE deleted_at IS NOT NULL`;
  const stored = yield* credentials.list;
  const held = new Set(
    (yield* sql<{ readonly credentialId: string }>`
      SELECT credential_id AS "credentialId" FROM ai_accounts WHERE credential_id IS NOT NULL
    `).map((row) => row.credentialId),
  );
  // Direct credentials a living Thread received stay for its masker (ticket 07).
  for (const valueId of yield* pruneAndListHeld(sql)) {
    const credentialId = credentialIdOfValueId(valueId);
    if (credentialId !== undefined) held.add(credentialId);
  }
  let removed = 0;
  for (const credentialId of stored) {
    if (held.has(credentialId)) continue;
    yield* credentials.remove(credentialId).pipe(Effect.ignore);
    removed += 1;
  }
  const tokens = yield* ServerSecretStore.AiAccountTokenStore;
  for (const tokenId of yield* tokens.list) {
    if (held.has(tokenId)) continue;
    yield* tokens.remove(tokenId).pipe(Effect.ignore);
    removed += 1;
  }
  if (removed > 0) {
    yield* Effect.logInfo("AiAccounts: removed credentials no AI account holds", { removed });
  }
});

/**
 * The Hub's AI accounts: the start sweeps retired and orphaned credentials, then hands the
 * gateway what it writes into every CLIProxyAPI it starts. A joined machine keeps none.
 */
export const layerWith = (options: AiAccountsOptions) =>
  Layer.effect(
    AiAccounts,
    Effect.gen(function* () {
      const { keyring } = yield* ServerSecretStore.MasterKeyring;
      if (Option.isNone(keyring)) return unavailable;
      yield* sweepCredentials.pipe(
        Effect.catch((cause) =>
          Effect.logWarning("AiAccounts: could not sweep credentials no AI account holds", {
            cause,
          }),
        ),
      );
      const accounts = yield* make(options);
      // Who may use an account may have changed: live processes are checked again (ticket 11).
      const changes = yield* AiAccountChanges.AiAccountChanges;
      return AiAccounts.of({
        ...accounts,
        update: Effect.fn("AiAccounts.update")(function* (
          input: Parameters<typeof accounts.update>[0],
        ) {
          const updated = yield* accounts.update(input);
          yield* changes.changed;
          return updated;
        }),
        remove: Effect.fn("AiAccounts.remove")(function* (
          input: Parameters<typeof accounts.remove>[0],
        ) {
          const removed = yield* accounts.remove(input);
          yield* changes.changed;
          return removed;
        }),
        allow: Effect.fn("AiAccounts.allow")(function* (
          input: Parameters<typeof accounts.allow>[0],
        ) {
          const allowed = yield* accounts.allow(input);
          yield* changes.changed;
          return allowed;
        }),
      });
    }),
  ).pipe(Layer.provideMerge(AllowedAiAccounts.layer), Layer.provideMerge(AiAccountChanges.layer));

export const layer = layerWith({});
