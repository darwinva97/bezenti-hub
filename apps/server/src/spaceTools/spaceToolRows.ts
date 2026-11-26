import { SpaceMcpConfig } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

import { referencesOf } from "./spaceToolRules.ts";

const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(SpaceMcpConfig));

/** For Grants: a Space MCP's or Skill's Space, name and Vault references (names only). */
export const toolForGrant = Effect.fn("SpaceToolRows.toolForGrant")(function* (
  sql: SqlClient.SqlClient,
  kind: "space-mcp" | "space-skill",
  toolId: string,
) {
  if (kind === "space-skill") {
    const [row] = yield* sql<{ readonly spaceId: string; readonly name: string }>`
      SELECT space_id AS "spaceId", name FROM space_skills WHERE skill_id = ${toolId}
    `;
    return row === undefined ? undefined : { ...row, references: [] as ReadonlyArray<string> };
  }
  const [row] = yield* sql<{
    readonly spaceId: string;
    readonly name: string;
    readonly configJson: string;
  }>`
    SELECT space_id AS "spaceId", name, config_json AS "configJson" FROM space_mcps
    WHERE mcp_id = ${toolId}
  `;
  if (row === undefined) return undefined;
  const refs = referencesOf(yield* decodeConfig(row.configJson));
  return {
    spaceId: row.spaceId,
    name: row.name,
    references: "names" in refs ? refs.names : ([] as ReadonlyArray<string>),
  };
});
