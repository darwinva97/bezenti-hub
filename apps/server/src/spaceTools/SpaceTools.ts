/**
 * A Space's own MCP servers and Skills (.scratch/mcps-and-skills). Everyone who sees the Space
 * reads names and state; its managers (`spaceTool.manage`) read and change the rest. A hidden
 * Space or tool answers like a missing one. No door returns a Vault value.
 */
import {
  type SpaceId,
  SpaceMcpConfig,
  SpaceMcpId,
  SpaceMcpSource,
  type SpaceMcp,
  type SpaceMcpGetInput,
  type SpaceMcpPutInput,
  type SpaceMcpSummary,
  type SpaceSkill,
  SpaceSkillFiles,
  type SpaceSkillGetInput,
  SpaceSkillId,
  type SpaceSkillPutInput,
  type SpaceSkillSummary,
  type SpaceToolDeleteInput,
  SpaceToolError,
  type SpaceToolErrorReason,
  type SpaceToolRef,
  type SpaceToolSetEnabledInput,
  type SpaceToolsList,
  type SpaceToolsListInput,
  type SpaceMcpConnection,
  type SpaceMcpLaunch,
  type SpaceSkillLaunch,
  type SpaceToolsThreadStatus,
  type SpaceToolsThreadStatusInput,
  SPACE_MCPS_CONTRACT_VERSION,
  type ThreadId,
  type UserId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as AuditLog from "../audit/AuditLog.ts";
import * as GrantEnding from "../grants/GrantEnding.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as SecretDelivery from "../vaults/SecretDelivery.ts";
import * as Vaults from "../vaults/Vaults.ts";
import {
  configProblem,
  decideSpaceMcps,
  expectsProblem,
  nameProblem,
  readSkill,
  referencesOf,
  type RuleProblem,
  secretLiteralIn,
  type SpaceMcpDecision,
} from "./spaceToolRules.ts";

/** What a session's provider reports of the MCP servers it started; empty once it stops. */
export type SpaceMcpConnectionsReader = Effect.Effect<
  ReadonlyArray<{ readonly name: string; readonly state: SpaceMcpConnection }>
>;

export class SpaceTools extends Context.Service<
  SpaceTools,
  {
    readonly list: (input: SpaceToolsListInput) => Effect.Effect<SpaceToolsList, SpaceToolError>;
    readonly getMcp: (input: SpaceMcpGetInput) => Effect.Effect<SpaceMcp, SpaceToolError>;
    readonly putMcp: (input: SpaceMcpPutInput) => Effect.Effect<SpaceMcp, SpaceToolError>;
    readonly getSkill: (input: SpaceSkillGetInput) => Effect.Effect<SpaceSkill, SpaceToolError>;
    readonly putSkill: (input: SpaceSkillPutInput) => Effect.Effect<SpaceSkill, SpaceToolError>;
    readonly setEnabled: (input: SpaceToolSetEnabledInput) => Effect.Effect<void, SpaceToolError>;
    readonly remove: (input: SpaceToolDeleteInput) => Effect.Effect<void, SpaceToolError>;
    /** `spaceTools.threadStatus`: the RPC guard has checked the Thread is visible. */
    readonly threadStatus: (
      input: SpaceToolsThreadStatusInput,
    ) => Effect.Effect<SpaceToolsThreadStatus, SpaceToolError>;
    /** Whether the Thread's Space has an enabled MCP or Skill: its Thread gets its own process. */
    readonly threadHasMcps: (threadId: ThreadId) => Effect.Effect<boolean, SpaceToolError>;
    /**
     * For a provider session about to open (the Hub's own call, no User's): the Thread's Space's
     * enabled MCPs, decided against what the session receives. `fingerprint` names the sent set.
     */
    readonly forSession: (input: {
      readonly threadId: ThreadId;
      readonly delivered: ReadonlySet<string>;
      readonly receivesSpaceMcps: boolean;
      readonly receivesSecretEnv: boolean;
      readonly receivesSpaceSkills: boolean;
      readonly contractVersion: number;
    }) => Effect.Effect<
      {
        readonly decisions: ReadonlyArray<SpaceMcpDecision>;
        readonly launches: ReadonlyArray<SpaceMcpLaunch>;
        readonly skills: ReadonlyArray<
          SpaceSkillLaunch & { readonly expects: ReadonlyArray<string> }
        >;
        readonly fingerprint: string;
      },
      SpaceToolError
    >;
    /** A provider session opened with these decisions: what `threadStatus` reports from now on. */
    readonly recordSession: (input: {
      readonly threadId: ThreadId;
      readonly decisions: ReadonlyArray<SpaceMcpDecision>;
      readonly connections?: SpaceMcpConnectionsReader | undefined;
    }) => Effect.Effect<void>;
  }
>()("t3/spaceTools/SpaceTools") {}

const NOT_FOUND = "That Space or tool does not exist.";

const fail = (reason: SpaceToolErrorReason, message: string) =>
  Effect.fail(new SpaceToolError({ reason, message }));
const refuse = (problem: RuleProblem) => fail(problem.reason, problem.message);
const storage = (what: string) => () => fail("storage", `Could not ${what}.`);

interface McpRow {
  readonly id: string;
  readonly spaceId: string;
  readonly name: string;
  readonly transport: "stdio" | "http";
  readonly configJson: string;
  readonly sourceJson: string | null;
  readonly enabled: number;
  readonly updatedAt: string;
  readonly grantId?: string | null;
  readonly lenderName?: string | null;
}

interface SkillRow {
  readonly id: string;
  readonly spaceId: string;
  readonly name: string;
  readonly description: string;
  readonly filesJson: string;
  readonly expectsJson: string;
  readonly enabled: number;
  readonly updatedAt: string;
  readonly grantId?: string | null;
  readonly lenderName?: string | null;
}

const encodeConfig = Schema.encodeSync(Schema.fromJsonString(SpaceMcpConfig));
const encodeFiles = Schema.encodeSync(Schema.fromJsonString(SpaceSkillFiles));
const encodeNames = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodeConfig = Schema.decodeUnknownSync(Schema.fromJsonString(SpaceMcpConfig));
const encodeSource = Schema.encodeSync(Schema.fromJsonString(SpaceMcpSource));
const decodeSource = Schema.decodeUnknownOption(Schema.fromJsonString(SpaceMcpSource));

const sourceOf = (row: McpRow) => {
  const source = row.sourceJson === null ? Option.none() : decodeSource(row.sourceJson);
  return Option.isSome(source) ? { source: source.value } : {};
};
const decodeFiles = Schema.decodeUnknownSync(Schema.fromJsonString(SpaceSkillFiles));
const decodeNames = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)));

const loanOf = (row: { readonly grantId?: string | null; readonly lenderName?: string | null }) =>
  row.grantId === undefined || row.grantId === null
    ? {}
    : { lent: { grantId: row.grantId, lenderName: row.lenderName ?? "" } };

const mcpSummary = (row: McpRow): SpaceMcpSummary => ({
  id: SpaceMcpId.make(row.id),
  spaceId: row.spaceId as SpaceId,
  name: row.name,
  transport: row.transport,
  enabled: row.enabled === 1,
  updatedAt: row.updatedAt,
  ...loanOf(row),
  ...sourceOf(row),
});

const mcpDetail = (row: McpRow): SpaceMcp => {
  const config = decodeConfig(row.configJson);
  const refs = referencesOf(config);
  return { ...mcpSummary(row), config, references: "names" in refs ? refs.names : [] };
};

const skillSummary = (row: SkillRow): SpaceSkillSummary => ({
  id: SpaceSkillId.make(row.id),
  spaceId: row.spaceId as SpaceId,
  name: row.name,
  description: row.description,
  enabled: row.enabled === 1,
  expects: decodeNames(row.expectsJson),
  updatedAt: row.updatedAt,
  ...loanOf(row),
});

const commandOf = (config: SpaceMcpConfig) =>
  config.transport === "stdio" ? { command: config.command } : {};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const spaces = yield* SpaceDirectory.SpaceDirectory;
  const audit = yield* AuditLog.AuditLog;
  const vaults = yield* Vaults.Vaults;
  const secretDelivery = yield* SecretDelivery.SecretDelivery;
  const random = yield* SecureRandom.SecureRandom;
  const newId = (prefix: string) =>
    random
      .randomBytes(12)
      .pipe(Effect.map((bytes) => `${prefix}_${Buffer.from(bytes).toString("hex")}`));

  const now = Effect.map(DateTime.now, DateTime.formatIso);

  const caller = Effect.gen(function* () {
    const found = yield* spaces.actingUser.pipe(
      Effect.catchTags({
        SpaceAccessDeniedError: () => fail("forbidden", "Sign in first."),
        SpaceDirectoryStorageError: storage("read who you are"),
      }),
    );
    if (Option.isNone(found)) return yield* fail("forbidden", "Sign in first.");
    const can = yield* spaces
      .authorizer(found.value)
      .pipe(Effect.catch(storage("check what you may do")));
    return { userId: found.value, can };
  });

  /** The Space, if the caller sees it and may do `action` there; otherwise not-found. */
  const spaceFor = Effect.fn("SpaceTools.spaceFor")(function* (
    spaceId: string,
    action: "spaceTool.view" | "spaceTool.manage",
  ) {
    const { userId, can } = yield* caller;
    const found = yield* spaces
      .spaceById(spaceId as SpaceId)
      .pipe(Effect.catch(storage("read the Space")));
    if (Option.isNone(found)) return yield* fail("not-found", NOT_FOUND);
    const space = found.value.resource;
    if (!can("spaceTool.view", space)) return yield* fail("not-found", NOT_FOUND);
    if (action === "spaceTool.manage" && !can("spaceTool.manage", space)) {
      return yield* fail(
        "forbidden",
        space.kind === "personal"
          ? "Only its User manages a Personal space's MCP servers and Skills."
          : "Only the Owner and the Organization's Admins manage its MCP servers and Skills.",
      );
    }
    return { userId, space, canManage: can("spaceTool.manage", space) };
  });

  const LENDER_NAME = `COALESCE(CASE g.lender_kind
      WHEN 'user' THEN (SELECT display_name FROM users WHERE user_id = g.lender_id)
      ELSE (SELECT name FROM spaces WHERE space_id = g.lender_id) END, g.lender_name)`;

  /** The Space's own MCPs and those lent to it by an active Grant: its own first, then by name. */
  const mcpsOfSpace = (spaceId: string, onlyEnabled: boolean) =>
    sql<McpRow>`
      SELECT m.mcp_id AS id, m.space_id AS "spaceId", m.name, m.transport,
        m.config_json AS "configJson", m.source_json AS "sourceJson", m.enabled, m.updated_at AS "updatedAt",
        g.grant_id AS "grantId", ${sql.literal(LENDER_NAME)} AS "lenderName"
      FROM space_mcps m
      LEFT JOIN grants g ON g.resource_kind = 'space-mcp' AND g.resource_id = m.mcp_id
        AND g.target_kind = 'space' AND g.target_id = ${spaceId} AND g.state = 'active'
      WHERE (m.space_id = ${spaceId} OR g.grant_id IS NOT NULL)
        AND (${onlyEnabled ? 0 : 1} = 1 OR m.enabled = 1)
      ORDER BY (g.grant_id IS NOT NULL), m.name
    `;

  const skillsOfSpace = (spaceId: string, onlyEnabled: boolean) =>
    sql<SkillRow>`
      SELECT k.skill_id AS id, k.space_id AS "spaceId", k.name, k.description,
        k.files_json AS "filesJson", k.expects_json AS "expectsJson", k.enabled,
        k.updated_at AS "updatedAt", g.grant_id AS "grantId",
        ${sql.literal(LENDER_NAME)} AS "lenderName"
      FROM space_skills k
      LEFT JOIN grants g ON g.resource_kind = 'space-skill' AND g.resource_id = k.skill_id
        AND g.target_kind = 'space' AND g.target_id = ${spaceId} AND g.state = 'active'
      WHERE (k.space_id = ${spaceId} OR g.grant_id IS NOT NULL)
        AND (${onlyEnabled ? 0 : 1} = 1 OR k.enabled = 1)
      ORDER BY (g.grant_id IS NOT NULL), k.name
    `;

  /** A Space's own wins a name it shares with a lent one. */
  const firstByName = <A extends { readonly name: string }>(rows: ReadonlyArray<A>) => {
    const seen = new Set<string>();
    return rows.filter((row) => {
      if (seen.has(row.name)) return false;
      seen.add(row.name);
      return true;
    });
  };

  const mcpRow = (id: string) =>
    sql<McpRow>`
      SELECT mcp_id AS id, space_id AS "spaceId", name, transport, config_json AS "configJson",
        source_json AS "sourceJson", enabled, updated_at AS "updatedAt"
      FROM space_mcps WHERE mcp_id = ${id}
    `.pipe(
      Effect.map((rows) => rows[0]),
      Effect.catch(storage("read the MCP server")),
    );

  const skillRow = (id: string) =>
    sql<SkillRow>`
      SELECT skill_id AS id, space_id AS "spaceId", name, description, files_json AS "filesJson",
        expects_json AS "expectsJson", enabled, updated_at AS "updatedAt"
      FROM space_skills WHERE skill_id = ${id}
    `.pipe(
      Effect.map((rows) => rows[0]),
      Effect.catch(storage("read the Skill")),
    );

  /** A tool the caller manages, by id: a hidden or missing one is not-found. */
  const managedRow = Effect.fn("SpaceTools.managedRow")(function* (tool: SpaceToolRef) {
    const row = tool.kind === "mcp" ? yield* mcpRow(tool.id) : yield* skillRow(tool.id);
    if (row === undefined) return yield* fail("not-found", NOT_FOUND);
    const { userId, space } = yield* spaceFor(row.spaceId, "spaceTool.manage");
    return { userId, space, row };
  });

  /**
   * Every name the Vault groups reaching the Space hold (its own and those lent to it, not
   * archived). The answer is the same for a name no group holds and one only another Space's has.
   */
  const unknownReference = Effect.fn("SpaceTools.unknownReference")(function* (
    spaceId: SpaceId,
    names: ReadonlyArray<string>,
  ) {
    if (names.length === 0) return undefined;
    const choices = yield* vaults
      .choices({ spaceId })
      .pipe(Effect.catch(storage("read the Space's Vaults")));
    const held = new Set(
      choices.allowed.filter((group) => !group.archived).flatMap((group) => group.names),
    );
    return names.find((name) => !held.has(name));
  });

  const record = (
    userId: UserId,
    spaceId: SpaceId,
    draft: Omit<AuditLog.AuditRecord, "actor" | "spaceId">,
  ) =>
    audit
      .record({ ...draft, actor: AuditLog.userActor(userId), spaceId } as AuditLog.AuditRecord)
      .pipe(Effect.catch(storage("write the audit log")));

  const list = Effect.fn("SpaceTools.list")(function* (input: SpaceToolsListInput) {
    const { space, canManage } = yield* spaceFor(input.spaceId, "spaceTool.view");
    const mcps = yield* mcpsOfSpace(space.id, false).pipe(
      Effect.catch(storage("read the MCP servers")),
    );
    const skills = yield* skillsOfSpace(space.id, false).pipe(
      Effect.catch(storage("read the Skills")),
    );
    return {
      spaceId: space.id,
      canManage,
      mcps: mcps.map(mcpSummary),
      skills: skills.map(skillSummary),
    } satisfies SpaceToolsList;
  });

  const getMcp = Effect.fn("SpaceTools.getMcp")(function* (input: SpaceMcpGetInput) {
    const { row } = yield* managedRow({ kind: "mcp", id: input.id });
    return mcpDetail(row as McpRow);
  });

  const putMcp = Effect.fn("SpaceTools.putMcp")(function* (input: SpaceMcpPutInput) {
    const { userId, space } = yield* spaceFor(input.spaceId, "spaceTool.manage");
    const problem =
      nameProblem(input.name) ?? configProblem(input.config) ?? secretLiteralIn(input.config);
    if (problem !== undefined) return yield* refuse(problem);
    const refs = referencesOf(input.config);
    if (!("names" in refs)) return yield* refuse(refs);
    const unknown = yield* unknownReference(space.id, refs.names);
    if (unknown !== undefined) {
      return yield* fail(
        "unknown-reference",
        `No Vault group this Space receives holds ${unknown}. Add it to one first.`,
      );
    }
    const existing = input.id === undefined ? undefined : yield* mcpRow(input.id);
    if (input.id !== undefined && (existing === undefined || existing.spaceId !== space.id)) {
      return yield* fail("not-found", NOT_FOUND);
    }
    const id = existing?.id ?? (yield* newId("mcp"));
    const at = yield* now;
    const configJson = encodeConfig(input.config);
    const sourceJson =
      existing === undefined && input.source !== undefined ? encodeSource(input.source) : null;
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const clash = yield* sql<{ readonly id: string }>`
            SELECT mcp_id AS id FROM space_mcps
            WHERE space_id = ${space.id} AND name = ${input.name} AND mcp_id <> ${id}
          `;
          if (clash.length > 0) {
            return yield* fail("name-taken", `This Space already has an MCP named ${input.name}.`);
          }
          if (existing === undefined) {
            yield* sql`
              INSERT INTO space_mcps (mcp_id, space_id, name, transport, config_json, source_json,
                enabled, created_by, created_at, updated_at)
              VALUES (${id}, ${space.id}, ${input.name}, ${input.config.transport}, ${configJson},
                ${sourceJson}, 1, ${userId}, ${at}, ${at})
            `;
          } else {
            yield* sql`
              UPDATE space_mcps SET name = ${input.name}, transport = ${input.config.transport},
                config_json = ${configJson}, updated_at = ${at}
              WHERE mcp_id = ${id}
            `;
          }
          yield* record(userId, space.id, {
            action: existing === undefined ? "space_mcp.create" : "space_mcp.update",
            target: { kind: "space_mcp", id, name: input.name },
            detail: {
              transport: input.config.transport,
              ...commandOf(input.config),
              references: refs.names.join(","),
              ...(sourceJson === null || input.source === undefined
                ? {}
                : { source: `${input.source.id}@${input.source.version}` }),
            },
          });
        }),
      )
      .pipe(Effect.catchTags({ SqlError: storage("save the MCP server") }));
    const saved = yield* mcpRow(id);
    if (saved === undefined) return yield* fail("not-found", NOT_FOUND);
    return mcpDetail(saved);
  });

  const getSkill = Effect.fn("SpaceTools.getSkill")(function* (input: SpaceSkillGetInput) {
    const { row } = yield* managedRow({ kind: "skill", id: input.id });
    const skill = row as SkillRow;
    return { ...skillSummary(skill), files: decodeFiles(skill.filesJson) } satisfies SpaceSkill;
  });

  const putSkill = Effect.fn("SpaceTools.putSkill")(function* (input: SpaceSkillPutInput) {
    const { userId, space } = yield* spaceFor(input.spaceId, "spaceTool.manage");
    const read = readSkill(input.files);
    if ("reason" in read) return yield* refuse(read);
    const problem = expectsProblem(input.expects);
    if (problem !== undefined) return yield* refuse(problem);
    const existing = input.id === undefined ? undefined : yield* skillRow(input.id);
    if (input.id !== undefined && (existing === undefined || existing.spaceId !== space.id)) {
      return yield* fail("not-found", NOT_FOUND);
    }
    const id = existing?.id ?? (yield* newId("skill"));
    const at = yield* now;
    const expects = [...new Set(input.expects)].toSorted();
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const clash = yield* sql<{ readonly id: string }>`
            SELECT skill_id AS id FROM space_skills
            WHERE space_id = ${space.id} AND name = ${read.name} AND skill_id <> ${id}
          `;
          if (clash.length > 0) {
            return yield* fail("name-taken", `This Space already has a Skill named ${read.name}.`);
          }
          const filesJson = encodeFiles(input.files);
          const expectsJson = encodeNames(expects);
          if (existing === undefined) {
            yield* sql`
              INSERT INTO space_skills (skill_id, space_id, name, description, files_json,
                expects_json, enabled, created_by, created_at, updated_at)
              VALUES (${id}, ${space.id}, ${read.name}, ${read.description}, ${filesJson},
                ${expectsJson}, 1, ${userId}, ${at}, ${at})
            `;
          } else {
            yield* sql`
              UPDATE space_skills SET name = ${read.name}, description = ${read.description},
                files_json = ${filesJson}, expects_json = ${expectsJson}, updated_at = ${at}
              WHERE skill_id = ${id}
            `;
          }
          yield* record(userId, space.id, {
            action: existing === undefined ? "space_skill.create" : "space_skill.update",
            target: { kind: "space_skill", id, name: read.name },
            detail: { files: Object.keys(input.files).length, expects: expects.join(",") },
          });
        }),
      )
      .pipe(Effect.catchTags({ SqlError: storage("save the Skill") }));
    const saved = yield* skillRow(id);
    if (saved === undefined) return yield* fail("not-found", NOT_FOUND);
    return { ...skillSummary(saved), files: decodeFiles(saved.filesJson) } satisfies SpaceSkill;
  });

  const setEnabled = Effect.fn("SpaceTools.setEnabled")(function* (
    input: SpaceToolSetEnabledInput,
  ) {
    const { userId, space, row } = yield* managedRow(input.tool);
    if ((row.enabled === 1) === input.enabled) return;
    const flag = input.enabled ? 1 : 0;
    const at = yield* now;
    const isMcp = input.tool.kind === "mcp";
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          if (isMcp) {
            yield* sql`UPDATE space_mcps SET enabled = ${flag}, updated_at = ${at}
              WHERE mcp_id = ${row.id}`;
          } else {
            yield* sql`UPDATE space_skills SET enabled = ${flag}, updated_at = ${at}
              WHERE skill_id = ${row.id}`;
          }
          yield* record(userId, space.id, {
            action: isMcp
              ? input.enabled
                ? "space_mcp.enable"
                : "space_mcp.disable"
              : input.enabled
                ? "space_skill.enable"
                : "space_skill.disable",
            target: { kind: isMcp ? "space_mcp" : "space_skill", id: row.id, name: row.name },
          });
        }),
      )
      .pipe(Effect.catchTags({ SqlError: storage("change it") }));
  });

  const remove = Effect.fn("SpaceTools.remove")(function* (input: SpaceToolDeleteInput) {
    const { userId, space, row } = yield* managedRow(input.tool);
    const isMcp = input.tool.kind === "mcp";
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          // Its loans end first, keeping its name for the borrowers' history.
          yield* GrantEnding.endGone(
            sql,
            AuditLog.userActor(userId),
            { resource: { kind: isMcp ? "space-mcp" : "space-skill", id: row.id } },
            isMcp ? "space_mcp.delete" : "space_skill.delete",
          ).pipe(
            Effect.mapError(
              () => new SpaceToolError({ reason: "storage", message: "Could not end its loans." }),
            ),
          );
          if (isMcp) yield* sql`DELETE FROM space_mcps WHERE mcp_id = ${row.id}`;
          else yield* sql`DELETE FROM space_skills WHERE skill_id = ${row.id}`;
          yield* record(userId, space.id, {
            action: isMcp ? "space_mcp.delete" : "space_skill.delete",
            target: { kind: isMcp ? "space_mcp" : "space_skill", id: row.id, name: row.name },
          });
        }),
      )
      .pipe(Effect.catchTags({ SqlError: storage("delete it") }));
  });

  /** The enabled MCPs of the Thread's Space; none for a Thread without one. */
  const enabledMcpsOf = Effect.fn("SpaceTools.enabledMcpsOf")(function* (threadId: ThreadId) {
    const placement = yield* spaces
      .placementOf(threadId)
      .pipe(Effect.catch(storage("read the Thread's Space")));
    if (Option.isNone(placement)) return [];
    const rows = yield* mcpsOfSpace(placement.value.space.id, true).pipe(
      Effect.catch(storage("read the Space's MCP servers")),
    );
    return firstByName(rows).map((row) => ({
      row,
      name: row.name,
      config: decodeConfig(row.configJson),
    }));
  });

  /** The enabled Skills of the Thread's Space. */
  const enabledSkillsOf = Effect.fn("SpaceTools.enabledSkillsOf")(function* (threadId: ThreadId) {
    const placement = yield* spaces
      .placementOf(threadId)
      .pipe(Effect.catch(storage("read the Thread's Space")));
    if (Option.isNone(placement)) return [];
    const rows = yield* skillsOfSpace(placement.value.space.id, true).pipe(
      Effect.catch(storage("read the Space's Skills")),
    );
    return firstByName(rows);
  });

  const forSession = Effect.fn("SpaceTools.forSession")(function* (input: {
    readonly threadId: ThreadId;
    readonly delivered: ReadonlySet<string>;
    readonly receivesSpaceMcps: boolean;
    readonly receivesSecretEnv: boolean;
    readonly receivesSpaceSkills: boolean;
    readonly contractVersion: number;
  }) {
    const mcps = yield* enabledMcpsOf(input.threadId);
    const decisions = decideSpaceMcps({ ...input, mcps });
    const sent = mcps.filter((_, index) => decisions[index]?.available === true);
    const skillRows =
      input.receivesSpaceSkills && input.contractVersion >= SPACE_MCPS_CONTRACT_VERSION
        ? yield* enabledSkillsOf(input.threadId)
        : [];
    return {
      decisions,
      launches: sent.map(({ name, config }) => ({ name, config })),
      skills: skillRows.map((row) => ({
        name: row.name,
        files: decodeFiles(row.filesJson),
        expects: decodeNames(row.expectsJson),
      })),
      fingerprint: [
        ...sent.map(({ row }) => `mcp:${row.id}@${row.updatedAt}`),
        ...skillRows.map((row) => `skill:${row.id}@${row.updatedAt}`),
      ].join(","),
    };
  });

  // In memory, as the sessions are: a restart forgets both.
  const sessions = new Map<
    ThreadId,
    {
      readonly decisions: ReadonlyMap<string, SpaceMcpDecision>;
      readonly connections: SpaceMcpConnectionsReader | undefined;
    }
  >();

  const recordSession = (input: {
    readonly threadId: ThreadId;
    readonly decisions: ReadonlyArray<SpaceMcpDecision>;
    readonly connections?: SpaceMcpConnectionsReader | undefined;
  }) =>
    Effect.sync(() => {
      sessions.set(input.threadId, {
        decisions: new Map(input.decisions.map((decision) => [decision.name, decision])),
        connections: input.connections,
      });
    });

  const threadStatus = Effect.fn("SpaceTools.threadStatus")(function* (
    input: SpaceToolsThreadStatusInput,
  ) {
    const names = yield* secretDelivery
      .turnNames(input.threadId)
      .pipe(Effect.catch(storage("read what the Thread receives")));
    // What the Vaults allow now; the provider and machine were decided when its session opened.
    const delivered = new Set(names.map((entry) => entry.name));
    const { decisions, skills } = yield* forSession({
      threadId: input.threadId,
      delivered,
      receivesSpaceMcps: true,
      receivesSecretEnv: true,
      receivesSpaceSkills: true,
      contractVersion: SPACE_MCPS_CONTRACT_VERSION,
    });
    const session = sessions.get(input.threadId);
    const connections = new Map(
      (session?.connections === undefined ? [] : yield* session.connections).map(
        ({ name, state }) => [name, state],
      ),
    );
    const decided = (current: SpaceMcpDecision): SpaceMcpDecision => {
      if (!current.available) return current;
      const opened = session?.decisions.get(current.name);
      return opened !== undefined &&
        JSON.stringify(opened.config) === JSON.stringify(current.config)
        ? opened
        : { ...current, available: false, reason: "not-in-session", missing: [] };
    };
    return {
      mcps: decisions.map(decided).map(({ name, transport, available, reason, missing }) => {
        const connection = available ? connections.get(name) : undefined;
        return {
          name,
          transport,
          available,
          ...(reason === undefined ? {} : { reason }),
          missing,
          ...(connection === undefined ? {} : { connection }),
        };
      }),
      skills: skills.map(({ name, expects }) => ({
        name,
        missing: expects.filter((expected) => !delivered.has(expected)),
      })),
    } satisfies SpaceToolsThreadStatus;
  });

  const threadHasMcps = Effect.fn("SpaceTools.threadHasMcps")(function* (threadId: ThreadId) {
    return (
      (yield* enabledMcpsOf(threadId)).length > 0 || (yield* enabledSkillsOf(threadId)).length > 0
    );
  });

  return SpaceTools.of({
    list,
    getMcp,
    putMcp,
    getSkill,
    putSkill,
    setEnabled,
    remove,
    threadStatus,
    forSession,
    recordSession,
    threadHasMcps,
  });
});

export const layer = Layer.effect(SpaceTools, make);
