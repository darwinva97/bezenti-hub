import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  makeEntityId,
  ProjectId,
  SpaceId,
  ThreadId,
  TrimmedNonEmptyString,
  UserId,
} from "./baseSchemas.ts";
import { AI_GATEWAY_ENV_NAMES } from "./aiGatewaySession.ts";
import { SecretProviderId } from "./secretReference.ts";
import { TEMPLATE_TEXT_MAX_LENGTH } from "./vaultTemplates.ts";
import { AuthReauth } from "./userAccounts.ts";

/** The master key that encrypts the Hub's secrets, as the Owner sees it in Settings. */
export const MasterKeyStatus = Schema.Struct({
  /** A fingerprint of the key, never the key. */
  keyId: Schema.String,
  /** Where the key file is on the Hub. */
  keyFile: Schema.String,
  /** When this key was last backed up; null until then (Settings warns). */
  backedUpAt: Schema.NullOr(Schema.String),
});
export type MasterKeyStatus = typeof MasterKeyStatus.Type;

/** «Download master key backup»: confirmed with the strong factor in the request. */
export const MasterKeyBackupRequest = Schema.Struct({ reauth: AuthReauth });
export type MasterKeyBackupRequest = typeof MasterKeyBackupRequest.Type;

/** Handed out, not yet a backup: the Owner confirms holding it (MasterKeyBackupConfirmRequest). */
export const MasterKeyBackupResult = Schema.Struct({
  /** The backup's text, as `t3 secrets key import` reads it. */
  key: Schema.String,
  keyId: Schema.String,
});
export type MasterKeyBackupResult = typeof MasterKeyBackupResult.Type;

/** The Owner saved it: the key's first 8 characters after `t3-master-key-v1:`. */
export const MasterKeyBackupConfirmRequest = Schema.Struct({
  keyId: Schema.String,
  proof: Schema.String.check(Schema.isMaxLength(64)),
});
export type MasterKeyBackupConfirmRequest = typeof MasterKeyBackupConfirmRequest.Type;

// A value enters the Hub only in `put` (Redacted) and leaves only through `vaults.reveal`.

export const VaultId = makeEntityId("VaultId");
export type VaultId = typeof VaultId.Type;
export const VaultEntryId = makeEntityId("VaultEntryId");
export type VaultEntryId = typeof VaultEntryId.Type;

/** The Main vault's fixed id: one per Hub, the Owner's, never deleted. */
export const MAIN_VAULT_ID = VaultId.make("vault-main");

/** An environment-variable name a Vault may hold. */
const SECRET_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/;
/** Values are UTF-8 text without NUL, at most this many bytes. */
export const SECRET_VALUE_MAX_BYTES = 64 * 1024;
/**
 * Below this many characters a value is accepted with a warning and never masked in the history
 * (masking it would hide ordinary text): the spec's open question 3, decided by the Owner.
 */
export const SECRET_MASK_MIN_LENGTH = 6;

// What the AI gateway (spec 4) sets in the agent's environment: a Vault never overrides it, not
// even the Owner's (the list both specs share, `AI_GATEWAY_ENV_NAMES`).
const GATEWAY_PREFIXES = ["T3_", "T3CODE_"] as const;

/**
 * Names that change how the agent's tools run or whom they trust: the process and its loaders,
 * interpreters' startup options, git and ssh hooks, proxies and CAs, home, temp and shell, and the
 * keys and base URLs AI providers read. Only the Owner sets one, after confirming; Admins never.
 */
const DANGEROUS_NAMES: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PWD",
  "TMPDIR",
  "TMP",
  "TEMP",
  "COMSPEC",
  "PATHEXT",
  "SYSTEMROOT",
  "WINDIR",
  "PSMODULEPATH",
  "BASH_ENV",
  "ENV",
  "IFS",
  "PS4",
  "PROMPT_COMMAND",
  "ZDOTDIR",
  "EDITOR",
  "VISUAL",
  "PAGER",
  "BROWSER",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_EXTRA_CA_CERTS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "PYTHONSTARTUP",
  "PYTHONPATH",
  "PYTHONHOME",
  "PYTHONHTTPSVERIFY",
  "PERL5OPT",
  "PERL5LIB",
  "PERLLIB",
  "RUBYOPT",
  "RUBYLIB",
  "JAVA_TOOL_OPTIONS",
  "_JAVA_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "CLASSPATH",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "CURL_CA_BUNDLE",
  "REQUESTS_CA_BUNDLE",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "FTP_PROXY",
]);
const DANGEROUS_PREFIXES = [
  "LD_",
  "DYLD_",
  "BASH_FUNC_",
  "GIT_",
  "SSH_",
  "XDG_",
  "NPM_CONFIG_",
  "YARN_",
  "PIP_",
  "CARGO_",
  "RUSTUP_",
  "GOFLAGS",
  "DOCKER_",
  // AI providers' keys and base URLs: a value here takes over the agent's model account.
  "ANTHROPIC_",
  "OPENAI_",
  "AZURE_OPENAI_",
  "GEMINI_",
  "GOOGLE_",
  "VERTEX_",
  "CLAUDE_",
  "CODEX_",
  "MISTRAL_",
  "GROQ_",
  "OPENROUTER_",
  "XAI_",
  "DEEPSEEK_",
  "CURSOR_",
  "OPENCODE_",
] as const;

/**
 * What a name is, for every door: `invalid` (not an environment variable), `gateway` (the Hub's
 * own: refused for everyone), `dangerous` (the Owner only, confirmed), or undefined. Compared
 * uppercased, as Windows reads environment names.
 */
export const secretNameRisk = (name: string): "invalid" | "gateway" | "dangerous" | undefined => {
  if (!SECRET_NAME_PATTERN.test(name)) return "invalid";
  const upper = name.toUpperCase();
  if (AI_GATEWAY_ENV_NAMES.has(upper) || GATEWAY_PREFIXES.some((p) => upper.startsWith(p))) {
    return "gateway";
  }
  if (DANGEROUS_NAMES.has(upper) || DANGEROUS_PREFIXES.some((p) => upper.startsWith(p))) {
    return "dangerous";
  }
  return undefined;
};

const CREDENTIAL_NAME = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|KEY|PAT)$/u;
const CREDENTIAL_PREFIXES = [
  "ghp_",
  "gho_",
  "ghs_",
  "github_pat_",
  "glpat-",
  "sk-",
  "xox",
  "AKIA",
  "-----BEGIN",
] as const;
const JWT = /^[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}$/u;
const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//iu;

/** Shannon entropy in bits per character. */
const entropy = (value: string): number => {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  const length = [...value].length;
  let bits = 0;
  for (const count of counts.values()) bits -= (count / length) * Math.log2(count / length);
  return bits;
};

/**
 * Whether a Variable's name or value looks like a credential: the `looks-like-credential`
 * warning, shown live in the form and returned by the save. Never blocks.
 */
export const looksLikeCredential = (name: string, value?: string): boolean => {
  if (CREDENTIAL_NAME.test(name.toUpperCase())) return true;
  if (value === undefined) return false;
  const text = value.trim();
  if (CREDENTIAL_PREFIXES.some((prefix) => text.startsWith(prefix))) return true;
  if (JWT.test(text)) return true;
  return [...text].length >= 20 && !/\s/u.test(text) && !URL_LIKE.test(text) && entropy(text) >= 4;
};

/**
 * `provider`: read from a Secret provider when a process starts; a sealed Secret (ADR 0008).
 * `template`: composed from entries of the same Vault (`vaultTemplates.ts`); its text holds names.
 */
export const VaultEntryKind = Schema.Literals(["own", "copy", "link", "provider", "template"]);

/**
 * How an entry reaches a process: an environment variable, a Secret file in memory whose path the
 * variable holds, or not at all (it only feeds a template of its Vault).
 */
export const VaultEntryDelivery = Schema.Literals(["env", "file", "none"]);
export type VaultEntryDelivery = typeof VaultEntryDelivery.Type;

/** Where a Provider entry reads its value: a provider of the Owner's settings and a reference. */
const VAULT_PROVIDER_REFERENCE_MAX_LENGTH = 1024;
export const VaultProviderSource = Schema.Struct({
  providerId: SecretProviderId,
  /**
   * The Provider scope it reads through (ticket 03): an Admin's always names one allowed to the
   * Vault; the Owner's may omit it («Direct»).
   */
  scopeId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  reference: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(VAULT_PROVIDER_REFERENCE_MAX_LENGTH),
  ),
});
export type VaultProviderSource = typeof VaultProviderSource.Type;

/**
 * A Variable is configuration: its value is shown to whoever sees its name (Guests excepted) and
 * never masked. A Secret is never shown, and revealed only while it is revealable.
 */
export const VaultEntryClass = Schema.Literals(["secret", "variable"]);
export type VaultEntryClass = typeof VaultEntryClass.Type;

/**
 * Whom the Owner allows a Vault to (ticket 03): a Space (its Threads may receive it) or a User
 * (their own turns, terminals and scripts, in any of their Spaces).
 */
export const VaultSubject = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("space"), spaceId: SpaceId }),
  Schema.Struct({ kind: Schema.Literal("user"), userId: UserId }),
]);
export type VaultSubject = typeof VaultSubject.Type;

/** One allowance, as the Owner sees it in Settings → Vaults. */
export const VaultAllowance = Schema.Struct({
  subject: VaultSubject,
  /** The Space's or the User's name; null once it is gone. */
  name: Schema.NullOr(Schema.String),
});
export type VaultAllowance = typeof VaultAllowance.Type;
export type VaultEntryKind = typeof VaultEntryKind.Type;

/** A Vault as the viewer sees it, with what the viewer may do there. */
export const VaultSummary = Schema.Struct({
  id: VaultId,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  /** The Organization whose Vault it is; null for the Owner's own (the Main vault among them). */
  spaceId: Schema.NullOr(SpaceId),
  spaceName: Schema.NullOr(Schema.String),
  isMain: Schema.Boolean,
  archived: Schema.Boolean,
  entryCount: Schema.Number,
  /** Add, replace and delete secrets: the Owner, and an Organization's Admins on its Vaults. */
  canEdit: Schema.Boolean,
  /** Rename, describe, archive and delete the Vault: the Owner. */
  canManage: Schema.Boolean,
  /** Reveal values: the Owner, with a strong factor. */
  canReveal: Schema.Boolean,
  /**
   * Whom the Owner allowed it to; empty for anyone who does not manage it. An Organization's
   * Vault reaches its own Organization without one; the Main vault only the Owner's Personal space.
   */
  allowances: Schema.Array(VaultAllowance),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type VaultSummary = typeof VaultSummary.Type;

/** An entry's name and what it is. Never a Secret's value. */
export const VaultEntry = Schema.Struct({
  id: VaultEntryId,
  vaultId: VaultId,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  kind: VaultEntryKind,
  /** A link's original's; a broken link is a sealed Secret. */
  class: VaultEntryClass,
  /** A Secret nobody reveals, not even the Owner: only replaced or deleted. */
  sealed: Schema.Boolean,
  /** A Variable's value, for whoever may read Variables (`vault.readVariables`): never a Secret's. */
  value: Schema.optionalKey(Schema.String),
  /**
   * A Provider entry's provider (its label; null once it is gone) and, for whoever edits the
   * Vault, its reference. Never a value: none is read to list it.
   */
  provider: Schema.optionalKey(
    Schema.Struct({
      label: Schema.NullOr(Schema.String),
      reference: Schema.NullOr(Schema.String),
      /** The scope it reads through (ticket 03), by label; null for the Owner's «Direct». */
      scope: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  ),
  /** A Template entry's text (names, never values), for whoever may read Variables; else null. */
  template: Schema.optionalKey(Schema.Struct({ text: Schema.NullOr(Schema.String) })),
  delivery: VaultEntryDelivery,
  /**
   * Shown, never delivered: a broken Secret link, a Provider entry whose provider is gone or cannot
   * be read here, or a template naming an entry its Vault no longer has.
   */
  broken: Schema.Boolean,
  /** A link's original, for whoever sees the Main vault (the Owner); null for anyone else. */
  linkedFrom: Schema.NullOr(Schema.Struct({ entryId: VaultEntryId, name: Schema.String })),
  /** Shorter than SECRET_MASK_MIN_LENGTH: kept, but never masked in the history. */
  unmasked: Schema.Boolean,
  version: Schema.Number,
  updatedAt: IsoDateTime,
  updatedBy: Schema.NullOr(UserId),
});
export type VaultEntry = typeof VaultEntry.Type;

/** `not-used-by-template`: a `none` entry no template of its Vault names, so nothing receives it. */
export const VaultWarning = Schema.Literals([
  "short-value",
  "looks-like-credential",
  "not-used-by-template",
]);
export type VaultWarning = typeof VaultWarning.Type;

export const VaultErrorReason = Schema.Literals([
  "not-found",
  "forbidden",
  "invalid-name",
  "reserved-name",
  "invalid-value",
  "duplicate-name",
  "main-vault",
  "not-linkable",
  /** A name that changes how tools run: the Owner's alone. */
  "dangerous-name",
  /** The Owner's dangerous name, not yet confirmed (`confirmDangerous`). */
  "confirm-dangerous",
  /** A Vault not allowed to that Space or User (ticket 03). */
  "not-allowed",
  /** Vaults live on the Hub: a joined machine has none. */
  "unavailable",
  /** A sealed Secret: nobody reveals it. */
  "sealed",
  /** Allowing reveal, or making a Secret a Variable, takes a new value in the same request. */
  "needs-new-value",
  /** A Provider entry's reference its provider does not read, or a path that leaves it. */
  "invalid-reference",
  /** A template's syntax, or a name that is not another, non-template entry of its Vault. */
  "invalid-template",
  "storage",
]);
export type VaultErrorReason = typeof VaultErrorReason.Type;

/** Never carries a value: messages name secrets, never what they hold. */
export class VaultError extends Schema.TaggedError<VaultError>()("VaultError", {
  reason: VaultErrorReason,
  message: Schema.String,
}) {}

const VaultName = TrimmedNonEmptyString.check(Schema.isMaxLength(80));
const VaultDescription = Schema.String.check(Schema.isMaxLength(500));
/** Checked on the Hub with `secretNameRisk`, which says why. */
const SecretName = Schema.String.check(Schema.isMaxLength(128));
/** A value going into the Hub: Redacted, so no log, span or error shows it. */
const SecretValueInput = Schema.RedactedFromValue(Schema.String);

export const VaultListInput = Schema.Struct({});
export const VaultListResult = Schema.Struct({ vaults: Schema.Array(VaultSummary) });
export type VaultListResult = typeof VaultListResult.Type;

export const VaultCreateInput = Schema.Struct({
  name: VaultName,
  description: Schema.optionalKey(VaultDescription),
  /** An Organization's Vault, or null for one of the Owner's own. */
  spaceId: Schema.NullOr(SpaceId),
});
export type VaultCreateInput = typeof VaultCreateInput.Type;

export const VaultUpdateInput = Schema.Struct({
  vaultId: VaultId,
  name: Schema.optionalKey(VaultName),
  description: Schema.optionalKey(Schema.NullOr(VaultDescription)),
  archived: Schema.optionalKey(Schema.Boolean),
});
export type VaultUpdateInput = typeof VaultUpdateInput.Type;

export const VaultDeleteInput = Schema.Struct({ vaultId: VaultId });
export type VaultDeleteInput = typeof VaultDeleteInput.Type;
export const VaultDeleteResult = Schema.Struct({ deleted: Schema.Boolean });
export type VaultDeleteResult = typeof VaultDeleteResult.Type;

export const VaultEntriesListInput = Schema.Struct({ vaultId: VaultId });
export type VaultEntriesListInput = typeof VaultEntriesListInput.Type;
export const VaultEntriesListResult = Schema.Struct({
  vault: VaultSummary,
  entries: Schema.Array(VaultEntry),
});
export type VaultEntriesListResult = typeof VaultEntriesListResult.Type;

/**
 * Adds an entry (no `entryId`, a value) or changes one: its name, description, value or class.
 * `allowReveal`: `false` seals a Secret (one way); `true` needs a new `value`, as does making a
 * Secret a Variable. A new Secret is sealed unless `allowReveal`.
 */
export const VaultEntryPutInput = Schema.Struct({
  vaultId: VaultId,
  entryId: Schema.optionalKey(VaultEntryId),
  name: SecretName,
  description: Schema.optionalKey(Schema.NullOr(VaultDescription)),
  value: Schema.optionalKey(SecretValueInput),
  class: Schema.optionalKey(VaultEntryClass),
  allowReveal: Schema.optionalKey(Schema.Boolean),
  /**
   * A Provider entry (the Owner's, `vault.providerEntry`) instead of a `value`: where its value is
   * read. Always a sealed Secret.
   */
  provider: Schema.optionalKey(VaultProviderSource),
  /** A Template entry instead of a `value`: its text, naming entries of the same Vault only. */
  template: Schema.optionalKey(
    Schema.Struct({ text: Schema.String.check(Schema.isMaxLength(TEMPLATE_TEXT_MAX_LENGTH)) }),
  ),
  /** `env` when omitted on an add; a template is never `none`. */
  delivery: Schema.optionalKey(VaultEntryDelivery),
  /** The Owner confirms a name that changes how tools run (`secretNameRisk`: dangerous). */
  confirmDangerous: Schema.optionalKey(Schema.Boolean),
});
export type VaultEntryPutInput = typeof VaultEntryPutInput.Type;

export const VaultEntryResult = Schema.Struct({
  entry: VaultEntry,
  warnings: Schema.Array(VaultWarning),
});
export type VaultEntryResult = typeof VaultEntryResult.Type;

/** A Secret link that breaks when its original goes: in which Vault, under which name. */
export const VaultBrokenLink = Schema.Struct({
  vaultId: VaultId,
  vaultName: Schema.String,
  entryId: VaultEntryId,
  name: Schema.String,
});
export type VaultBrokenLink = typeof VaultBrokenLink.Type;

/**
 * Deletes a secret. An original with Secret links goes only with `breakLinks`; without it nothing
 * changes and the answer lists the links that would break.
 */
export const VaultEntryDeleteInput = Schema.Struct({
  vaultId: VaultId,
  entryId: VaultEntryId,
  breakLinks: Schema.optionalKey(Schema.Boolean),
});
export type VaultEntryDeleteInput = typeof VaultEntryDeleteInput.Type;
export const VaultEntryDeleteResult = Schema.Struct({
  deleted: Schema.Boolean,
  brokenLinks: Schema.Array(VaultBrokenLink),
});
export type VaultEntryDeleteResult = typeof VaultEntryDeleteResult.Type;

/** A Secret link to, or a copy of, a secret of the Main vault: the Owner only. */
export const VaultEntryFromMainInput = Schema.Struct({
  vaultId: VaultId,
  sourceEntryId: VaultEntryId,
  /** The variable's name in this Vault; the original's when omitted. */
  name: Schema.optionalKey(SecretName),
  description: Schema.optionalKey(Schema.NullOr(VaultDescription)),
  confirmDangerous: Schema.optionalKey(Schema.Boolean),
});
export type VaultEntryFromMainInput = typeof VaultEntryFromMainInput.Type;

/** «Reveal»: the Owner, confirmed with the strong factor in the request. HTTP only. */
export const VaultRevealRequest = Schema.Struct({
  vaultId: VaultId,
  entryId: VaultEntryId,
  reauth: AuthReauth,
});
export type VaultRevealRequest = typeof VaultRevealRequest.Type;

export const VaultRevealResult = Schema.Struct({
  name: Schema.String,
  value: Schema.RedactedFromValue(Schema.String),
});
export type VaultRevealResult = typeof VaultRevealResult.Type;

// Allowances, defaults and the effective set (spec 5 ticket 03): names only, never values.

/** `vaults.allow`: the Owner allows a Vault to a Space or a User, or takes it back. */
export const VaultAllowInput = Schema.Struct({
  vaultId: VaultId,
  subject: VaultSubject,
  allowed: Schema.Boolean,
});
export type VaultAllowInput = typeof VaultAllowInput.Type;

/**
 * Where a Thread's Vault comes from, in the order that wins a name both define: the acting
 * User's own, then the ones its Project adds, then its Space's defaults.
 */
export const VaultSource = Schema.Literals(["user", "project", "space"]);
export type VaultSource = typeof VaultSource.Type;

/** A Project's choice about one Vault allowed to its Space; `inherit` clears it. */
export const VaultProjectChoice = Schema.Literals(["add", "remove"]);
export type VaultProjectChoice = typeof VaultProjectChoice.Type;

/** A Vault allowed to a Space, as the Space's and its Projects' Vault pickers list it. */
export const VaultChoiceOption = Schema.Struct({
  vaultId: VaultId,
  name: Schema.String,
  isMain: Schema.Boolean,
  archived: Schema.Boolean,
  /** The secrets' names it holds (never values). */
  names: Schema.Array(Schema.String),
});
export type VaultChoiceOption = typeof VaultChoiceOption.Type;

/** `vaults.choices`: a Space's defaults, and a Project's adds and removes when one is named. */
export const VaultChoicesInput = Schema.Struct({
  spaceId: SpaceId,
  projectId: Schema.optionalKey(ProjectId),
});
export type VaultChoicesInput = typeof VaultChoicesInput.Type;

export const VaultChoices = Schema.Struct({
  spaceId: SpaceId,
  projectId: Schema.NullOr(ProjectId),
  /** The Owner, or an Admin of the Space: they change the defaults and the Project's choices. */
  canChoose: Schema.Boolean,
  /** The Vaults allowed to the Space, in the Owner's order. */
  allowed: Schema.Array(VaultChoiceOption),
  /** The Space's defaults, the first winning a name they share. */
  defaults: Schema.Array(VaultId),
  /** Fixed defaults nobody unsets (the Main vault in the Owner's Personal space). */
  fixedDefaults: Schema.Array(VaultId),
  projectChoices: Schema.Array(Schema.Struct({ vaultId: VaultId, choice: VaultProjectChoice })),
});
export type VaultChoices = typeof VaultChoices.Type;

/** `vaults.spaceDefaults.set`: the Space's defaults in order (the first wins a shared name). */
export const VaultSpaceDefaultsSetInput = Schema.Struct({
  spaceId: SpaceId,
  vaultIds: Schema.Array(VaultId).check(Schema.isMaxLength(200)),
});
export type VaultSpaceDefaultsSetInput = typeof VaultSpaceDefaultsSetInput.Type;

/** `vaults.projectChoices.set`: add or remove one allowed Vault for a Project, or inherit. */
export const VaultProjectChoiceSetInput = Schema.Struct({
  projectId: ProjectId,
  vaultId: VaultId,
  choice: Schema.Literals(["add", "remove", "inherit"]),
});
export type VaultProjectChoiceSetInput = typeof VaultProjectChoiceSetInput.Type;

/** `vaults.threadEnvironment`: the names the caller's turns in a Thread receive. */
export const VaultThreadEnvironmentInput = Schema.Struct({ threadId: ThreadId });
export type VaultThreadEnvironmentInput = typeof VaultThreadEnvironmentInput.Type;

/** A Vault that also defines the name and lost to the winner. */
export const VaultShadowed = Schema.Struct({
  vaultId: VaultId,
  vaultName: Schema.String,
  source: VaultSource,
});
export type VaultShadowed = typeof VaultShadowed.Type;

/** One variable a Thread receives: its name, which Vault wins it, and whom it beat. */
export const VaultThreadVariable = Schema.Struct({
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  vaultId: VaultId,
  vaultName: Schema.String,
  source: VaultSource,
  /** Names only here: a Variable's value travels in `vaults.entries.list` alone. */
  class: VaultEntryClass,
  /** Shorter than SECRET_MASK_MIN_LENGTH: delivered, never masked. */
  unmasked: Schema.Boolean,
  /** A name that changes how tools run, set by the Owner (`secretNameRisk`). */
  dangerous: Schema.Boolean,
  shadowed: Schema.Array(VaultShadowed),
});
export type VaultThreadVariable = typeof VaultThreadVariable.Type;

export const VaultThreadEnvironment = Schema.Struct({
  threadId: ThreadId,
  spaceId: SpaceId,
  projectId: Schema.NullOr(ProjectId),
  /** The Vaults it receives, in the order that wins. */
  vaults: Schema.Array(
    Schema.Struct({ vaultId: VaultId, name: Schema.String, source: VaultSource }),
  ),
  variables: Schema.Array(VaultThreadVariable),
  /**
   * Spec 4 ticket 07: the direct AI account credential the Thread's agent last received («AI
   * account credential»): the variable's and the account's names, never its value.
   */
  aiCredential: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ name: Schema.String, aiAccountName: Schema.String })),
  ),
});
export type VaultThreadEnvironment = typeof VaultThreadEnvironment.Type;
