import * as Schema from "effect/Schema";

import { IsoDateTime, makeEntityId, SpaceId, ThreadId } from "./baseSchemas.ts";

// Space MCPs and Space Skills (.scratch/mcps-and-skills): a Space's own third-party MCP servers
// and SKILL.md bundles. A value may name a Vault entry as `${NAME}`; a Secret's value is never
// stored here nor answered by any door.

export const SpaceMcpId = makeEntityId("SpaceMcpId");
export type SpaceMcpId = typeof SpaceMcpId.Type;
export const SpaceSkillId = makeEntityId("SpaceSkillId");
export type SpaceSkillId = typeof SpaceSkillId.Type;

/** What the provider sees as the server's key; `t3-code…` is the Hub's own. */
export const SPACE_TOOL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const SPACE_SKILL_MAX_BYTES = 256 * 1024;
export const SPACE_SKILL_MAX_FILES = 50;

const ToolName = Schema.String.check(Schema.isMaxLength(63));
const ConfigText = Schema.String.check(Schema.isMaxLength(4096));
const ConfigMap = Schema.Record(Schema.String.check(Schema.isMaxLength(128)), ConfigText);

export const SpaceMcpConfig = Schema.Union([
  Schema.Struct({
    transport: Schema.Literal("stdio"),
    command: ConfigText,
    args: Schema.Array(ConfigText).check(Schema.isMaxLength(64)),
    env: ConfigMap,
  }),
  Schema.Struct({
    transport: Schema.Literal("http"),
    url: ConfigText,
    headers: ConfigMap,
  }),
]);
export type SpaceMcpConfig = typeof SpaceMcpConfig.Type;

/** What everyone who sees the Space reads: never the configuration. */
/** One lent to the Space by another (read-only there): the loan and who lent it. */
export const SpaceToolLoan = Schema.Struct({ grantId: Schema.String, lenderName: Schema.String });
export type SpaceToolLoan = typeof SpaceToolLoan.Type;

/** Where a Space MCP was found, when it was added from a registry search. */
export const SpaceMcpSource = Schema.Struct({
  registry: Schema.Literal("mcp-registry"),
  id: Schema.String.check(Schema.isMaxLength(256)),
  version: Schema.String.check(Schema.isMaxLength(64)),
});
export type SpaceMcpSource = typeof SpaceMcpSource.Type;

export const SpaceMcpSummary = Schema.Struct({
  id: SpaceMcpId,
  spaceId: SpaceId,
  name: Schema.String,
  transport: Schema.Literals(["stdio", "http"]),
  enabled: Schema.Boolean,
  updatedAt: IsoDateTime,
  lent: Schema.optionalKey(SpaceToolLoan),
  source: Schema.optionalKey(SpaceMcpSource),
});
export type SpaceMcpSummary = typeof SpaceMcpSummary.Type;

/** For whoever manages the Space's tools: the configuration, with references, never values. */
export const SpaceMcp = Schema.Struct({
  ...SpaceMcpSummary.fields,
  config: SpaceMcpConfig,
  /** The Vault names its values reference. */
  references: Schema.Array(Schema.String),
});
export type SpaceMcp = typeof SpaceMcp.Type;

export const SpaceSkillSummary = Schema.Struct({
  id: SpaceSkillId,
  spaceId: SpaceId,
  name: Schema.String,
  description: Schema.String,
  enabled: Schema.Boolean,
  /** Vault names it says it needs: names only. */
  expects: Schema.Array(Schema.String),
  updatedAt: IsoDateTime,
  lent: Schema.optionalKey(SpaceToolLoan),
});
export type SpaceSkillSummary = typeof SpaceSkillSummary.Type;

/** Relative path → text. `SKILL.md`, with its frontmatter, is required. */
export const SpaceSkillFiles = Schema.Record(
  Schema.String.check(Schema.isMaxLength(256)),
  Schema.String.check(Schema.isMaxLength(SPACE_SKILL_MAX_BYTES)),
);
export type SpaceSkillFiles = typeof SpaceSkillFiles.Type;

export const SpaceSkill = Schema.Struct({
  ...SpaceSkillSummary.fields,
  files: SpaceSkillFiles,
});
export type SpaceSkill = typeof SpaceSkill.Type;

/**
 * One Space MCP sent to a provider session: its `${NAME}` references unresolved. The machine fills
 * them in from the session's `secretEnv`, never the Hub.
 */
export const SpaceMcpLaunch = Schema.Struct({ name: Schema.String, config: SpaceMcpConfig });
export type SpaceMcpLaunch = typeof SpaceMcpLaunch.Type;

/** One Space Skill sent to a provider session: its files, written on the machine for it alone. */
export const SpaceSkillLaunch = Schema.Struct({ name: Schema.String, files: SpaceSkillFiles });
export type SpaceSkillLaunch = typeof SpaceSkillLaunch.Type;

/** Why a Space MCP does not start in a Thread's session. */
export const SpaceMcpUnavailableReason = Schema.Literals([
  /** A referenced name the Thread does not receive (missing, not chosen, withheld, broken). */
  "not-delivered",
  /** The provider takes no MCP servers from the Hub. */
  "not-supported",
  /** The provider cannot put Vault values in its process. */
  "no-secrets",
  /** The Thread's machine runs an executor too old for Space MCPs. */
  "outdated-machine",
  /** Not in the Thread's session: it has none yet, or the server changed after it opened. */
  "not-in-session",
]);
export type SpaceMcpUnavailableReason = typeof SpaceMcpUnavailableReason.Type;

/** How a provider's process reports a Space MCP it started (Claude only). */
export const SpaceMcpConnection = Schema.Literals([
  "connected",
  "pending",
  "needs-auth",
  "failed",
  "disabled",
]);
export type SpaceMcpConnection = typeof SpaceMcpConnection.Type;

export const SpaceToolsThreadStatusInput = Schema.Struct({ threadId: ThreadId });
export type SpaceToolsThreadStatusInput = typeof SpaceToolsThreadStatusInput.Type;

/** What a Thread's current session got of its Space's MCP servers, as decided when it opened. */
export const SpaceToolsThreadStatus = Schema.Struct({
  mcps: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      transport: Schema.Literals(["stdio", "http"]),
      available: Schema.Boolean,
      reason: Schema.optionalKey(SpaceMcpUnavailableReason),
      /** For `not-delivered`: the names the Thread does not receive. */
      missing: Schema.Array(Schema.String),
      /** For an available one, when the provider reports it. */
      connection: Schema.optionalKey(SpaceMcpConnection),
    }),
  ),
  /** Its enabled Skills, and the Vault names each expects that the Thread does not receive. */
  skills: Schema.Array(
    Schema.Struct({ name: Schema.String, missing: Schema.Array(Schema.String) }),
  ),
});
export type SpaceToolsThreadStatus = typeof SpaceToolsThreadStatus.Type;

export const SpaceToolsListInput = Schema.Struct({ spaceId: SpaceId });
export type SpaceToolsListInput = typeof SpaceToolsListInput.Type;

export const SpaceToolsList = Schema.Struct({
  spaceId: SpaceId,
  /** The Owner, or an Admin of the Space (its User for a Personal space). */
  canManage: Schema.Boolean,
  mcps: Schema.Array(SpaceMcpSummary),
  skills: Schema.Array(SpaceSkillSummary),
});
export type SpaceToolsList = typeof SpaceToolsList.Type;

export const SpaceMcpGetInput = Schema.Struct({ id: SpaceMcpId });
export type SpaceMcpGetInput = typeof SpaceMcpGetInput.Type;

/** Without `id`, a new one. */
export const SpaceMcpPutInput = Schema.Struct({
  spaceId: SpaceId,
  id: Schema.optionalKey(SpaceMcpId),
  name: ToolName,
  config: SpaceMcpConfig,
  /** Only on a new one; an edit keeps where it came from. */
  source: Schema.optionalKey(SpaceMcpSource),
});
export type SpaceMcpPutInput = typeof SpaceMcpPutInput.Type;

export const SpaceSkillGetInput = Schema.Struct({ id: SpaceSkillId });
export type SpaceSkillGetInput = typeof SpaceSkillGetInput.Type;

/** Name and description come from `SKILL.md`'s frontmatter. */
export const SpaceSkillPutInput = Schema.Struct({
  spaceId: SpaceId,
  id: Schema.optionalKey(SpaceSkillId),
  files: SpaceSkillFiles,
  expects: Schema.Array(Schema.String.check(Schema.isMaxLength(128))).check(Schema.isMaxLength(50)),
});
export type SpaceSkillPutInput = typeof SpaceSkillPutInput.Type;

export const SpaceMcpSearchInput = Schema.Struct({
  spaceId: SpaceId,
  query: Schema.String.check(Schema.isMinLength(2), Schema.isMaxLength(100)),
});
export type SpaceMcpSearchInput = typeof SpaceMcpSearchInput.Type;

/**
 * One registry entry, checked and turned into a draft for the "Add MCP server" form. Nothing is
 * saved or run until a manager saves the draft; secret values are `${NAME}` references.
 */
export const SpaceMcpSearchResult = Schema.Struct({
  source: SpaceMcpSource,
  title: Schema.String,
  description: Schema.String,
  websiteUrl: Schema.optionalKey(Schema.String),
  /** A suggested name for the Space MCP. */
  name: Schema.String,
  config: SpaceMcpConfig,
  /** The Vault names the draft references, which the registry marks secret. */
  secrets: Schema.Array(Schema.String),
});
export type SpaceMcpSearchResult = typeof SpaceMcpSearchResult.Type;

export const SpaceMcpSearch = Schema.Struct({ results: Schema.Array(SpaceMcpSearchResult) });
export type SpaceMcpSearch = typeof SpaceMcpSearch.Type;

export const SpaceToolRef = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("mcp"), id: SpaceMcpId }),
  Schema.Struct({ kind: Schema.Literal("skill"), id: SpaceSkillId }),
]);
export type SpaceToolRef = typeof SpaceToolRef.Type;

export const SpaceToolSetEnabledInput = Schema.Struct({
  tool: SpaceToolRef,
  enabled: Schema.Boolean,
});
export type SpaceToolSetEnabledInput = typeof SpaceToolSetEnabledInput.Type;

export const SpaceToolDeleteInput = Schema.Struct({ tool: SpaceToolRef });
export type SpaceToolDeleteInput = typeof SpaceToolDeleteInput.Type;

export const SpaceToolErrorReason = Schema.Literals([
  "not-found",
  "forbidden",
  "invalid",
  "name-taken",
  /** A `${NAME}` no Vault group reaching the Space holds; never says whether another has it. */
  "unknown-reference",
  /** A credential-looking header or variable given as a literal instead of a reference. */
  "secret-literal",
  "storage",
  /** The MCP registry did not answer, answered nothing usable, or this Hub does not search it. */
  "registry-unavailable",
]);
export type SpaceToolErrorReason = typeof SpaceToolErrorReason.Type;

/** Never carries a value. */
export class SpaceToolError extends Schema.TaggedError<SpaceToolError>()("SpaceToolError", {
  reason: SpaceToolErrorReason,
  message: Schema.String,
}) {}
