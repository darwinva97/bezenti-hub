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
export const SpaceMcpSummary = Schema.Struct({
  id: SpaceMcpId,
  spaceId: SpaceId,
  name: Schema.String,
  transport: Schema.Literals(["stdio", "http"]),
  enabled: Schema.Boolean,
  updatedAt: IsoDateTime,
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
]);
export type SpaceMcpUnavailableReason = typeof SpaceMcpUnavailableReason.Type;

export const SpaceToolsThreadStatusInput = Schema.Struct({ threadId: ThreadId });
export type SpaceToolsThreadStatusInput = typeof SpaceToolsThreadStatusInput.Type;

/** What a Thread's next session gets of its Space's MCP servers, decided as at a session's open. */
export const SpaceToolsThreadStatus = Schema.Struct({
  mcps: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      transport: Schema.Literals(["stdio", "http"]),
      available: Schema.Boolean,
      reason: Schema.optionalKey(SpaceMcpUnavailableReason),
      /** For `not-delivered`: the names the Thread does not receive. */
      missing: Schema.Array(Schema.String),
    }),
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
]);
export type SpaceToolErrorReason = typeof SpaceToolErrorReason.Type;

/** Never carries a value. */
export class SpaceToolError extends Schema.TaggedError<SpaceToolError>()("SpaceToolError", {
  reason: SpaceToolErrorReason,
  message: Schema.String,
}) {}
