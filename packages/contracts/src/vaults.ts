import * as Schema from "effect/Schema";

import {
  GrantId,
  IsoDateTime,
  makeEntityId,
  ProjectId,
  SpaceId,
  ThreadId,
  TrimmedNonEmptyString,
  UserId,
} from "./baseSchemas.ts";
import { AI_GATEWAY_ENV_NAMES } from "./aiGatewaySession.ts";
import { ResourceOwner } from "./ownership.ts";
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

// A value enters the Hub only in `put` (Redacted). A Secret's never leaves it through any door
// (ADR 0012); a Variable's is listed to whoever may read Variables.

/**
 * A group of a Vault (owned-resources 03): each owner (a User or an Organization) has one Vault
 * made of groups, a `default` one and named ones. Ids of groups made from the Vaults before are
 * those Vaults' ids. Fields keep the name `vaultId` on the wire.
 */
export const VaultGroupId = makeEntityId("VaultGroupId");
export type VaultGroupId = typeof VaultGroupId.Type;
export const VaultEntryId = makeEntityId("VaultEntryId");
export type VaultEntryId = typeof VaultEntryId.Type;

/** Every owner's group that is never deleted, renamed or archived. */
export const DEFAULT_VAULT_GROUP_NAME = "default";

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
 * `own`: a value of its own. `provider`: read from a Secret provider when a process starts; a sealed
 * Secret (ADR 0008). `template`: composed from entries of the same group (`vaultTemplates.ts`); its
 * text holds names. `identity`: a token the Hub signs (ticket 07). Secret links and copies became
 * `own` entries (owned-resources 03).
 */
/** A workload identity token's lifetime (ticket 07, question 7): 10 minutes unless set, 1 hour at most. */
export const IDENTITY_TTL_DEFAULT_SECONDS = 600;
export const IDENTITY_TTL_MIN_SECONDS = 60;
export const IDENTITY_TTL_MAX_SECONDS = 3600;

export const VaultEntryKind = Schema.Literals(["own", "provider", "template", "identity"]);

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
 * never masked. A Secret is never shown to anyone, the Owner included (owned-resources 01).
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

/** A group of a Vault as the viewer sees it, with what the viewer may do there. */
export const VaultGroupSummary = Schema.Struct({
  id: VaultGroupId,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  /** Whose Vault it is part of: a User's (the Owner's among them) or an Organization's. */
  owner: ResourceOwner,
  /** The owner's name; null once it is gone. */
  ownerName: Schema.NullOr(Schema.String),
  /** The owner's `default` group: never deleted, renamed or archived. */
  isDefault: Schema.Boolean,
  archived: Schema.Boolean,
  entryCount: Schema.Number,
  /** Add, replace and delete its entries: its owner's editors. */
  canEdit: Schema.Boolean,
  /** Rename, describe, archive and delete the group: its owner's managers, never on `default`. */
  canManage: Schema.Boolean,
  /** Deprecated: always empty (Grants ticket 07, allowances became Grants). Older clients decode it. */
  allowances: Schema.Array(VaultAllowance),
  /**
   * Grants ticket 07: lent by its owner to a Space the viewer works in, read-only there: its
   * Variables with their value, its Secrets by name.
   */
  borrowed: Schema.optionalKey(
    Schema.Struct({
      grantId: GrantId,
      spaceId: SpaceId,
      spaceName: Schema.String,
      lenderName: Schema.NullOr(Schema.String),
    }),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type VaultGroupSummary = typeof VaultGroupSummary.Type;

/** An entry's name and what it is. Never a Secret's value. */
export const VaultEntry = Schema.Struct({
  id: VaultEntryId,
  vaultId: VaultGroupId,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  kind: VaultEntryKind,
  class: VaultEntryClass,
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
  /** A workload identity entry's audience and lifetime (ticket 07): never a token. */
  identity: Schema.optionalKey(
    Schema.Struct({ audience: Schema.String, ttlSeconds: Schema.Number }),
  ),
  delivery: VaultEntryDelivery,
  /**
   * Shown, never delivered: a Provider entry whose provider is gone or cannot be read here, or a
   * template naming an entry its group no longer has.
   */
  broken: Schema.Boolean,
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
  /** An owner's `default` group is never deleted, renamed or archived. */
  "default-group",
  /** A name that changes how tools run: the Owner's alone. */
  "dangerous-name",
  /** The Owner's dangerous name, not yet confirmed (`confirmDangerous`). */
  "confirm-dangerous",
  /** A Vault not allowed to that Space or User (ticket 03). */
  "not-allowed",
  /** Vaults live on the Hub: a joined machine has none. */
  "unavailable",
  /** Making a Secret a Variable takes a new value in the same request: the old is never read. */
  "needs-new-value",
  /** A Provider entry's reference its provider does not read, or a path that leaves it. */
  "invalid-reference",
  /** A template's syntax, or a name that is not another, non-template entry of its Vault. */
  "invalid-template",
  /** Workload identity is off: the Hub has no issuer (`T3CODE_IDENTITY_ISSUER`, `T3CODE_PUBLIC_URL`). */
  "identity-no-issuer",
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

/**
 * An entry that was a Secret link and is an independent Secret since owned-resources 03: rotating
 * its original no longer changes it. Shown once to the Owner, until dismissed.
 */
export const VaultUnlinkedEntry = Schema.Struct({
  vaultId: VaultGroupId,
  vaultName: Schema.NullOr(Schema.String),
  entryId: VaultEntryId,
  name: Schema.String,
  /** The original's name, as it was. */
  originalName: Schema.NullOr(Schema.String),
});
export type VaultUnlinkedEntry = typeof VaultUnlinkedEntry.Type;

export const VaultGroupListInput = Schema.Struct({});
export const VaultGroupListResult = Schema.Struct({
  /** By owner (the viewer's own first), `default` first in each. */
  groups: Schema.Array(VaultGroupSummary),
  /** The owners the viewer may create groups for. */
  owners: Schema.Array(Schema.Struct({ owner: ResourceOwner, name: Schema.String })),
  /** For the Owner, until dismissed: the entries that were Secret links. */
  unlinked: Schema.Array(VaultUnlinkedEntry),
});
export type VaultGroupListResult = typeof VaultGroupListResult.Type;

export const VaultGroupCreateInput = Schema.Struct({
  name: VaultName,
  description: Schema.optionalKey(VaultDescription),
  /** Whose Vault it goes into: an Organization's, or a User's own. */
  owner: ResourceOwner,
});
export type VaultGroupCreateInput = typeof VaultGroupCreateInput.Type;

export const VaultGroupUpdateInput = Schema.Struct({
  vaultId: VaultGroupId,
  name: Schema.optionalKey(VaultName),
  description: Schema.optionalKey(Schema.NullOr(VaultDescription)),
  archived: Schema.optionalKey(Schema.Boolean),
});
export type VaultGroupUpdateInput = typeof VaultGroupUpdateInput.Type;

export const VaultGroupDeleteInput = Schema.Struct({ vaultId: VaultGroupId });
export type VaultGroupDeleteInput = typeof VaultGroupDeleteInput.Type;
export const VaultGroupDeleteResult = Schema.Struct({ deleted: Schema.Boolean });
export type VaultGroupDeleteResult = typeof VaultGroupDeleteResult.Type;

export const VaultEntriesListInput = Schema.Struct({ vaultId: VaultGroupId });
export type VaultEntriesListInput = typeof VaultEntriesListInput.Type;
export const VaultEntriesListResult = Schema.Struct({
  group: VaultGroupSummary,
  entries: Schema.Array(VaultEntry),
});
export type VaultEntriesListResult = typeof VaultEntriesListResult.Type;

/**
 * Adds an entry (no `entryId`, a value) or changes one: its name, description, value or class.
 * Making a Secret a Variable needs a new `value`; a Variable made a Secret keeps its value.
 */
export const VaultEntryPutInput = Schema.Struct({
  vaultId: VaultGroupId,
  entryId: Schema.optionalKey(VaultEntryId),
  name: SecretName,
  description: Schema.optionalKey(Schema.NullOr(VaultDescription)),
  value: Schema.optionalKey(SecretValueInput),
  class: Schema.optionalKey(VaultEntryClass),
  /**
   * A Provider entry (the Owner's, `vault.providerEntry`) instead of a `value`: where its value is
   * read. Always a sealed Secret.
   */
  provider: Schema.optionalKey(VaultProviderSource),
  /** A Template entry instead of a `value`: its text, naming entries of the same Vault only. */
  template: Schema.optionalKey(
    Schema.Struct({ text: Schema.String.check(Schema.isMaxLength(TEMPLATE_TEXT_MAX_LENGTH)) }),
  ),
  /**
   * A workload identity entry (ticket 07, the Owner's alone) instead of a `value`: a token the Hub
   * signs for one audience, always a sealed Secret file.
   */
  identity: Schema.optionalKey(
    Schema.Struct({
      audience: Schema.String.check(Schema.isMaxLength(256)),
      ttlSeconds: Schema.optionalKey(
        Schema.Number.check(
          Schema.isInt(),
          Schema.isBetween({
            minimum: IDENTITY_TTL_MIN_SECONDS,
            maximum: IDENTITY_TTL_MAX_SECONDS,
          }),
        ),
      ),
    }),
  ),
  /** `env` when omitted on an add; a template is never `none`; an identity entry is a `file`. */
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

export const VaultEntryDeleteInput = Schema.Struct({
  vaultId: VaultGroupId,
  entryId: VaultEntryId,
});
export type VaultEntryDeleteInput = typeof VaultEntryDeleteInput.Type;
export const VaultEntryDeleteResult = Schema.Struct({ deleted: Schema.Boolean });
export type VaultEntryDeleteResult = typeof VaultEntryDeleteResult.Type;

// Allowances, defaults and the effective set (spec 5 ticket 03): names only, never values.

/**
 * `vaults.unlinkedNotice.dismiss`: the Owner has read the list of entries that were Secret links.
 */
export const VaultUnlinkedDismissInput = Schema.Struct({});
export const VaultUnlinkedDismissResult = Schema.Struct({ dismissed: Schema.Number });
export type VaultUnlinkedDismissResult = typeof VaultUnlinkedDismissResult.Type;

/**
 * Where a Thread's Vault comes from, in the order that wins a name both define: the ones its
 * Project adds, then its Space's defaults. `user` (a group allowed to the acting User) is never
 * sent since allowances became Grants (Grants ticket 07); kept so older clients decode.
 */
export const VaultSource = Schema.Literals(["user", "project", "space"]);
export type VaultSource = typeof VaultSource.Type;

/** A Project's choice about one Vault allowed to its Space; `inherit` clears it. */
export const VaultProjectChoice = Schema.Literals(["add", "remove"]);
export type VaultProjectChoice = typeof VaultProjectChoice.Type;

/** A Vault allowed to a Space, as the Space's and its Projects' Vault pickers list it. */
export const VaultChoiceOption = Schema.Struct({
  vaultId: VaultGroupId,
  name: Schema.String,
  /** Its owner, and whether it is the owner's `default`. */
  owner: ResourceOwner,
  ownerName: Schema.NullOr(Schema.String),
  isDefault: Schema.Boolean,
  archived: Schema.Boolean,
  /** The secrets' names it holds (never values). */
  names: Schema.Array(Schema.String),
  /** Grants ticket 07: lent to the Space by its owner (`ownerName`). */
  lent: Schema.optionalKey(Schema.Struct({ grantId: GrantId })),
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
  defaults: Schema.Array(VaultGroupId),
  /** Fixed defaults nobody unsets: the `default` group of the Space's owner. */
  fixedDefaults: Schema.Array(VaultGroupId),
  projectChoices: Schema.Array(
    Schema.Struct({ vaultId: VaultGroupId, choice: VaultProjectChoice }),
  ),
});
export type VaultChoices = typeof VaultChoices.Type;

/** `vaults.spaceDefaults.set`: the Space's defaults in order (the first wins a shared name). */
export const VaultSpaceDefaultsSetInput = Schema.Struct({
  spaceId: SpaceId,
  vaultIds: Schema.Array(VaultGroupId).check(Schema.isMaxLength(200)),
});
export type VaultSpaceDefaultsSetInput = typeof VaultSpaceDefaultsSetInput.Type;

/** `vaults.projectChoices.set`: add or remove one allowed Vault for a Project, or inherit. */
export const VaultProjectChoiceSetInput = Schema.Struct({
  projectId: ProjectId,
  vaultId: VaultGroupId,
  choice: Schema.Literals(["add", "remove", "inherit"]),
});
export type VaultProjectChoiceSetInput = typeof VaultProjectChoiceSetInput.Type;

/** `vaults.threadEnvironment`: the names the caller's turns in a Thread receive. */
export const VaultThreadEnvironmentInput = Schema.Struct({ threadId: ThreadId });
export type VaultThreadEnvironmentInput = typeof VaultThreadEnvironmentInput.Type;

/** A Vault that also defines the name and lost to the winner. */
export const VaultShadowed = Schema.Struct({
  vaultId: VaultGroupId,
  vaultName: Schema.String,
  source: VaultSource,
});
export type VaultShadowed = typeof VaultShadowed.Type;

/** One variable a Thread receives: its name, which Vault wins it, and whom it beat. */
export const VaultThreadVariable = Schema.Struct({
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  vaultId: VaultGroupId,
  vaultName: Schema.String,
  source: VaultSource,
  class: VaultEntryClass,
  /**
   * A Variable's value (owned-resources 05), for whoever may read its group's Variables (Guests
   * never); a Secret's never.
   */
  value: Schema.optionalKey(Schema.String),
  /** Shorter than SECRET_MASK_MIN_LENGTH: delivered, never masked. */
  unmasked: Schema.Boolean,
  /** A name that changes how tools run, set by the Owner (`secretNameRisk`). */
  dangerous: Schema.Boolean,
  shadowed: Schema.Array(VaultShadowed),
});
export type VaultThreadVariable = typeof VaultThreadVariable.Type;

/**
 * Grants ticket 07: a name of a lent group the Thread's processes never receive: one that changes
 * how tools run (`lent-dangerous`), or any while the Thread runs on a machine lent to its Space
 * (`lent-machine`: that machine's owner could read it). Names only.
 */
export const VaultThreadWithheld = Schema.Struct({
  name: Schema.String,
  vaultId: VaultGroupId,
  vaultName: Schema.String,
  reason: Schema.Literals(["lent-dangerous", "lent-machine"]),
});
export type VaultThreadWithheld = typeof VaultThreadWithheld.Type;

export const VaultThreadEnvironment = Schema.Struct({
  threadId: ThreadId,
  spaceId: SpaceId,
  projectId: Schema.NullOr(ProjectId),
  /** The groups it receives, in the order that wins, each with its owner's name (03). */
  vaults: Schema.Array(
    Schema.Struct({
      vaultId: VaultGroupId,
      name: Schema.String,
      source: VaultSource,
      ownerName: Schema.optionalKey(Schema.NullOr(Schema.String)),
      /** Grants ticket 07: lent to the Thread's Space by its owner. */
      lent: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  variables: Schema.Array(VaultThreadVariable),
  withheld: Schema.optionalKey(Schema.Array(VaultThreadWithheld)),
  /**
   * Spec 4 ticket 07: the direct AI account credential the Thread's agent last received («AI
   * account credential»): the variable's and the account's names, never its value.
   */
  aiCredential: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ name: Schema.String, aiAccountName: Schema.String })),
  ),
});
export type VaultThreadEnvironment = typeof VaultThreadEnvironment.Type;
