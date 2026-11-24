import * as Schema from "effect/Schema";

import { AiAccountId } from "./aiAccounts.ts";
import { EnvironmentId, ProjectId, SpaceId, UserId } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

/**
 * Makita (spec `makita`): the GitHub bot teammate. A normal GitHub account the Owner registers
 * once; its token stays sealed in the Hub, never in an answer, a Vault, a machine or a Thread.
 * Only WS `makita.*`, for a person's own session; no agent, HTTP endpoint or MCP tool changes it.
 */

/** The only GitHub host this version speaks to (GHE is a later version; the rows keep `host`). */
export const MAKITA_GITHUB_HOST = "github.com";

/** Days before a token's expiry from which the Owner is warned. */
export const MAKITA_TOKEN_EXPIRY_WARNING_DAYS = 14;

/** A classic personal access token (`ghp_`) or a fine-grained one (`github_pat_`). */
export const MakitaTokenKind = Schema.Literals(["classic", "fine-grained"]);
export type MakitaTokenKind = typeof MakitaTokenKind.Type;

/** How the token stood at its last check with GitHub. */
export const MakitaAccountStatus = Schema.Literals([
  "ok",
  "token-invalid",
  "rate-limited",
  "unreachable",
]);
export type MakitaAccountStatus = typeof MakitaAccountStatus.Type;

/** What the Owner is warned about in Platform → Makita. */
export const MakitaAccountWarning = Schema.Literals([
  "token-invalid",
  "expires-soon",
  "expired",
  "no-repo-scope",
  "rate-limited",
  "unreachable",
]);
export type MakitaAccountWarning = typeof MakitaAccountWarning.Type;

/** Makita's account as the Owner sees it: never the token, only its last four characters. */
export const MakitaAccountView = Schema.Struct({
  host: Schema.String,
  login: Schema.String,
  githubUserId: Schema.Number,
  tokenKind: MakitaTokenKind,
  /** The token's last four characters, to tell one token from another. */
  hint: Schema.String,
  /** A classic token's scopes; null for a fine-grained token (GitHub does not list them). */
  scopes: Schema.NullOr(Schema.Array(Schema.String)),
  expiresAt: Schema.NullOr(Schema.String),
  status: MakitaAccountStatus,
  checkedAt: Schema.String,
  /** «Stop all Makita work»: when and by whom; null while Makita may work. */
  globalPausedAt: Schema.NullOr(Schema.String),
  globalPausedBy: Schema.NullOr(UserId),
  globalPausedByName: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
  warnings: Schema.Array(MakitaAccountWarning),
});
export type MakitaAccountView = typeof MakitaAccountView.Type;

export const MakitaAccountGetInput = Schema.Struct({
  /** «Check now»: ask GitHub again with the stored token before answering. */
  check: Schema.optionalKey(Schema.Boolean),
});
export type MakitaAccountGetInput = typeof MakitaAccountGetInput.Type;

export const MakitaAccountGetResult = Schema.Struct({
  /** Null until the Owner registers Makita's account. */
  account: Schema.NullOr(MakitaAccountView),
});
export type MakitaAccountGetResult = typeof MakitaAccountGetResult.Type;

/** Register or replace Makita's token: Redacted, so no log, span or error shows it. */
export const MakitaAccountSetInput = Schema.Struct({
  token: Schema.RedactedFromValue(Schema.String),
});
export type MakitaAccountSetInput = typeof MakitaAccountSetInput.Type;

/**
 * Why a «may use Makita» takes no effect now (Makita ticket 02): `ok` it does; its User left the
 * Organization or is only a Guest there, was disabled, or the Space is archived, frozen or gone.
 */
export const MakitaPermissionState = Schema.Literals([
  "ok",
  "not-a-member",
  "guest",
  "user-inactive",
  "space-archived",
  "space-frozen",
  "space-gone",
]);
export type MakitaPermissionState = typeof MakitaPermissionState.Type;

/** Where a User works in a Space, as the permission lists say it. */
export const MakitaSpaceRole = Schema.Literals(["admin", "member", "guest", "personal"]);
export type MakitaSpaceRole = typeof MakitaSpaceRole.Type;

/** One «may use Makita»: a User in a Space, given by the Owner. */
export const MakitaPermission = Schema.Struct({
  userId: UserId,
  userName: Schema.NullOr(Schema.String),
  spaceId: SpaceId,
  spaceName: Schema.NullOr(Schema.String),
  spaceKind: Schema.NullOr(Schema.Literals(["organization", "personal"])),
  /** Their Role there now; null when they are not in it any more. */
  role: Schema.NullOr(MakitaSpaceRole),
  grantedBy: UserId,
  grantedByName: Schema.NullOr(Schema.String),
  grantedAt: Schema.String,
  state: MakitaPermissionState,
});
export type MakitaPermission = typeof MakitaPermission.Type;

/** Someone the Owner may give «may use Makita», and the Spaces where it can be given. */
export const MakitaPermissionCandidate = Schema.Struct({
  userId: UserId,
  name: Schema.String,
  spaces: Schema.Array(
    Schema.Struct({
      spaceId: SpaceId,
      name: Schema.String,
      kind: Schema.Literals(["organization", "personal"]),
      role: MakitaSpaceRole,
    }),
  ),
});
export type MakitaPermissionCandidate = typeof MakitaPermissionCandidate.Type;

export const MakitaPermissionsListResult = Schema.Struct({
  permissions: Schema.Array(MakitaPermission),
  candidates: Schema.Array(MakitaPermissionCandidate),
});
export type MakitaPermissionsListResult = typeof MakitaPermissionsListResult.Type;

export const MakitaPermissionInput = Schema.Struct({ userId: UserId, spaceId: SpaceId });
export type MakitaPermissionInput = typeof MakitaPermissionInput.Type;

/** Live configurations one Space may hold (it bounds the polling, not the tokens). */
export const MAKITA_CONFIG_MAX_PER_SPACE = 20;
/** The label that triggers Makita unless a configuration names another. */
export const MAKITA_DEFAULT_LABEL = "makita";

/** The repositories a configuration listens to: all the Space's Projects with a GitHub remote, or these. */
export const MakitaRepos = Schema.Union([
  Schema.Struct({ all: Schema.Literal(true) }),
  Schema.Struct({ projects: Schema.Array(ProjectId) }),
]);
export type MakitaRepos = typeof MakitaRepos.Type;

/** What wakes Makita: the label on an issue, assigning it to Makita, mentioning it (ticket 09). */
export const MakitaTriggers = Schema.Struct({
  label: Schema.NullOr(Schema.String),
  assigned: Schema.Boolean,
  mention: Schema.Boolean,
});
export type MakitaTriggers = typeof MakitaTriggers.Type;

/** Whom it answers. Batch 1: only a list of GitHub users. */
export const MakitaCallersMode = Schema.Literals(["creator", "list", "members", "anyone"]);
export type MakitaCallersMode = typeof MakitaCallersMode.Type;

/** A GitHub user as a configuration keeps it: always compared by its numeric id. */
export const MakitaGitHubUser = Schema.Struct({ id: Schema.Number, login: Schema.String });
export type MakitaGitHubUser = typeof MakitaGitHubUser.Type;

export const MakitaCapability = Schema.Literals(["comment", "push"]);
export type MakitaCapability = typeof MakitaCapability.Type;
export const MakitaApproval = Schema.Literals(["others", "always", "never"]);
export type MakitaApproval = typeof MakitaApproval.Type;
export const MakitaStrangers = Schema.Literals(["ignore", "reply"]);
export type MakitaStrangers = typeof MakitaStrangers.Type;
export const MakitaPausedReason = Schema.Literals([
  "manual",
  "owner",
  "permission-revoked",
  "creator-disabled",
  "creator-left",
]);
export type MakitaPausedReason = typeof MakitaPausedReason.Type;

/**
 * How a Project's GitHub repository resolves (gh's rule over its checkout's remotes): `ok`, no
 * GitHub remote, two candidates and no `gh repo set-default` («Pick the GitHub remote»), gone.
 */
export const MakitaRepoState = Schema.Literals(["ok", "no-remote", "ambiguous", "gone"]);
export type MakitaRepoState = typeof MakitaRepoState.Type;

export const MakitaProjectRepo = Schema.Struct({
  projectId: ProjectId,
  /** Null for a Project that no longer exists. */
  title: Schema.NullOr(Schema.String),
  /** `owner/name`, when it resolves. */
  repo: Schema.NullOr(Schema.String),
  state: MakitaRepoState,
});
export type MakitaProjectRepo = typeof MakitaProjectRepo.Type;

/** What a configuration warns of now. */
export const MakitaConfigWarning = Schema.Literals(["ai-account-unavailable", "no-repository"]);
export type MakitaConfigWarning = typeof MakitaConfigWarning.Type;

/** A Makita configuration as whoever may see it does: never a token. */
export const MakitaConfig = Schema.Struct({
  configId: Schema.String,
  spaceId: SpaceId,
  spaceName: Schema.NullOr(Schema.String),
  name: Schema.String,
  createdBy: UserId,
  createdByName: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  repos: MakitaRepos,
  /** The Projects it listens to now, each with its repository or why none. */
  projects: Schema.Array(MakitaProjectRepo),
  triggers: MakitaTriggers,
  callersMode: MakitaCallersMode,
  callers: Schema.Array(MakitaGitHubUser),
  strangers: MakitaStrangers,
  modelSelection: ModelSelection,
  /** The AI account's name, when it still exists. */
  aiAccountName: Schema.NullOr(Schema.String),
  capability: MakitaCapability,
  mayLand: Schema.Boolean,
  approval: MakitaApproval,
  approvers: Schema.Array(MakitaGitHubUser),
  baseBranch: Schema.NullOr(Schema.String),
  /** Null: the Space's Sandbox. */
  environmentId: Schema.NullOr(EnvironmentId),
  pausedAt: Schema.NullOr(Schema.String),
  pausedBy: Schema.NullOr(UserId),
  pausedByName: Schema.NullOr(Schema.String),
  pausedReason: Schema.NullOr(MakitaPausedReason),
  warnings: Schema.Array(MakitaConfigWarning),
  /** What the viewer may do with it (the Hub decides again on each door). */
  canEdit: Schema.Boolean,
  canPause: Schema.Boolean,
  canResume: Schema.Boolean,
  canDelete: Schema.Boolean,
});
export type MakitaConfig = typeof MakitaConfig.Type;

/** What a configuration says, as its creator writes it (logins, resolved to ids on save). */
const MakitaConfigFields = {
  name: Schema.String,
  repos: MakitaRepos,
  triggers: MakitaTriggers,
  callersMode: MakitaCallersMode,
  /** GitHub logins; the Hub resolves each to its numeric id. */
  callers: Schema.Array(Schema.String),
  strangers: MakitaStrangers,
  modelSelection: ModelSelection,
  capability: MakitaCapability,
  mayLand: Schema.Boolean,
  approval: MakitaApproval,
  approvers: Schema.Array(Schema.String),
  baseBranch: Schema.NullOr(Schema.String),
  environmentId: Schema.NullOr(EnvironmentId),
};

export const MakitaConfigInput = Schema.Struct({ spaceId: SpaceId, ...MakitaConfigFields });
export type MakitaConfigInput = typeof MakitaConfigInput.Type;

export const MakitaConfigUpdateInput = Schema.Struct({
  configId: Schema.String,
  ...MakitaConfigFields,
});
export type MakitaConfigUpdateInput = typeof MakitaConfigUpdateInput.Type;

export const MakitaConfigRef = Schema.Struct({ configId: Schema.String });
export type MakitaConfigRef = typeof MakitaConfigRef.Type;

/** A saved configuration, with what the Hub could not do on GitHub (a label it could not make). */
export const MakitaConfigSaveResult = Schema.Struct({
  config: MakitaConfig,
  notes: Schema.Array(Schema.String),
});
export type MakitaConfigSaveResult = typeof MakitaConfigSaveResult.Type;

export const MakitaConfigsListInput = Schema.Struct({
  /** One Space's configurations. Without it: the Owner's view of every Space. */
  spaceId: Schema.optionalKey(SpaceId),
});
export type MakitaConfigsListInput = typeof MakitaConfigsListInput.Type;

/** An AI account the viewer may give a configuration here, with the models it serves. */
export const MakitaAiAccountOption = Schema.Struct({
  id: AiAccountId,
  name: Schema.String,
  type: Schema.String,
  provider: Schema.String,
  /** Null: its catalog cannot be read now. */
  models: Schema.NullOr(Schema.Array(Schema.String)),
});
export type MakitaAiAccountOption = typeof MakitaAiAccountOption.Type;

export const MakitaConfigsListResult = Schema.Struct({
  configs: Schema.Array(MakitaConfig),
  /** True for the Owner's list of every Space. */
  everyone: Schema.Boolean,
  /** For one Space's list: whether the viewer may make configurations, and the form's options. */
  space: Schema.NullOr(
    Schema.Struct({
      canCreate: Schema.Boolean,
      /** Whether Makita's GitHub account is registered (the form needs it to resolve logins). */
      accountReady: Schema.Boolean,
      projects: Schema.Array(MakitaProjectRepo),
      aiAccounts: Schema.Array(MakitaAiAccountOption),
      /** The provider instances that go through the AI gateway, for the agent of its Threads. */
      agents: Schema.Array(Schema.Struct({ instanceId: Schema.String, label: Schema.String })),
    }),
  ),
});
export type MakitaConfigsListResult = typeof MakitaConfigsListResult.Type;

/** Why a Makita door refused, in words for the person; never a token. */
export class MakitaError extends Schema.TaggedError<MakitaError>()("MakitaError", {
  reason: Schema.Literals(["forbidden", "not-found", "invalid", "limit", "github", "storage"]),
  message: Schema.String,
}) {}
