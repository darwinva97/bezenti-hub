/**
 * Whom each configuration answers now (Makita ticket 08), by numeric GitHub id: read from the
 * tables at every use, never kept, so unlinking, leaving a Space or being disabled counts at the
 * next event. `members`: the Space's active Admins and Members (or its Personal User) who linked.
 */
import { MakitaGitHubUser } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

import { linkedIdsOf } from "./GitHubIdentities.ts";

const decodeUsers = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(MakitaGitHubUser)),
);

/** A configuration as its callers are read. */
interface CallerRule {
  readonly configId: string;
  readonly spaceId: string;
  readonly createdBy: string;
  readonly callersMode: string;
  readonly callersJson: string;
}

/**
 * The GitHub ids each configuration answers: `creator`, the creator's linked account; `list`, the
 * list plus the creator's; `members`, the linked accounts of the Space's current Admins and
 * Members. Only active Users count. Anything else (`anyone` comes with ticket 16) answers nobody.
 */
export const allowedCallerIds = Effect.fn("makitaCallers.allowedCallerIds")(function* (
  sql: SqlClient.SqlClient,
  rules: ReadonlyArray<CallerRule>,
) {
  const memberSpaces = [
    ...new Set(rules.filter((rule) => rule.callersMode === "members").map((rule) => rule.spaceId)),
  ];
  const members =
    memberSpaces.length === 0
      ? []
      : [
          ...(yield* sql<{ readonly spaceId: string; readonly userId: string }>`
            SELECT space_id AS "spaceId", user_id AS "userId" FROM space_memberships
            WHERE role IN ('admin', 'member') AND ${sql.in("space_id", memberSpaces)}
          `),
          ...(yield* sql<{ readonly spaceId: string; readonly userId: string }>`
            SELECT space_id AS "spaceId", personal_owner_user_id AS "userId" FROM spaces
            WHERE kind = 'personal' AND personal_owner_user_id IS NOT NULL
              AND ${sql.in("space_id", memberSpaces)}
          `),
        ];
  const people = [
    ...new Set([...rules.map((rule) => rule.createdBy), ...members.map((m) => m.userId)]),
  ];
  const active =
    people.length === 0
      ? []
      : yield* sql<{ readonly userId: string }>`
          SELECT user_id AS "userId" FROM users
          WHERE disabled_at IS NULL AND removed_at IS NULL AND ${sql.in("user_id", people)}
        `;
  const linked = yield* linkedIdsOf(
    sql,
    active.map((row) => row.userId),
  );
  const linkedOf = (userId: string) => {
    const id = linked.get(userId);
    return id === undefined ? [] : [id];
  };
  return new Map(
    rules.map((rule) => {
      const ids = new Set<number>();
      if (rule.callersMode === "creator" || rule.callersMode === "list") {
        for (const id of linkedOf(rule.createdBy)) ids.add(id);
      }
      if (rule.callersMode === "list") {
        for (const user of Option.getOrElse(decodeUsers(rule.callersJson), () => [])) {
          ids.add(user.id);
        }
      }
      if (rule.callersMode === "members") {
        for (const member of members) {
          if (member.spaceId !== rule.spaceId) continue;
          for (const id of linkedOf(member.userId)) ids.add(id);
        }
      }
      return [rule.configId, ids as ReadonlySet<number>] as const;
    }),
  );
});
