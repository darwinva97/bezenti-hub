/**
 * Makita ticket 23: one issue gets at most one Makita pull request. Before a task opens its own,
 * the Hub reads the open pull requests of the repository's other live Makita tasks: one opened by
 * Makita whose body closes this task's issue already covers it.
 */
import { MAKITA_GITHUB_HOST } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

import type { MakitaGitHub } from "./MakitaGitHub.ts";
import { closingIssues } from "./makitaTriageText.ts";

const LIVE_STATES = ["awaiting-approval", "running", "waiting-ci", "waiting-reply"];

const decodePull = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      number: Schema.Number,
      state: Schema.String,
      body: Schema.optional(Schema.NullOr(Schema.String)),
      user: Schema.optional(Schema.NullOr(Schema.Struct({ id: Schema.Number }))),
    }),
  ),
);

/**
 * The open Makita pull request of another live task of `repo` that closes `issue`, if any. A
 * GitHub read that fails fails the whole check: the caller refuses rather than open a second one.
 */
export const coveringPullRequest = Effect.fn("makitaCovering.coveringPullRequest")(function* (
  sql: SqlClient.SqlClient,
  github: MakitaGitHub["Service"],
  input: {
    readonly repo: string;
    readonly issue: number;
    readonly taskId: string;
    readonly botId: number;
  },
) {
  const others = yield* sql<{ readonly prNumber: number }>`
    SELECT pr_number AS "prNumber" FROM makita_tasks
    WHERE host = ${MAKITA_GITHUB_HOST} AND lower(repo) = ${input.repo.toLowerCase()}
      AND task_id <> ${input.taskId} AND pr_number IS NOT NULL
      AND ${sql.in("state", LIVE_STATES)}
    ORDER BY pr_number
  `;
  for (const other of others) {
    const answer = yield* github.rest({
      operation: "pull-request-read",
      path: `repos/${input.repo}/pulls/${other.prNumber}`,
    });
    const pull = decodePull(answer.body);
    if (
      Option.isSome(pull) &&
      pull.value.state === "open" &&
      pull.value.user?.id === input.botId &&
      closingIssues(pull.value.body ?? "").has(input.issue)
    ) {
      return Option.some(pull.value.number);
    }
  }
  return Option.none<number>();
});
