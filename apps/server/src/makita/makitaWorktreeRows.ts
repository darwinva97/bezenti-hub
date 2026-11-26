/**
 * Makita ticket 28: what the intake records when a person merges or closes Makita's pull request
 * on GitHub: seen closed, and its `makita/…` branch due for deletion by `MakitaWorktrees`.
 */
import { MAKITA_GITHUB_HOST } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

/**
 * Makita's own closes and merges (27's sweep, a landing) are not a person's: they already deleted
 * the branch, and a branch a person restored afterwards must stay.
 */
export const notePullClosedWithin = (
  sql: SqlClient.SqlClient,
  input: {
    readonly repo: string;
    readonly number: number;
    readonly actorId: number | null;
    readonly makitaId: number;
    readonly at: string;
  },
) =>
  input.actorId === input.makitaId
    ? Effect.void
    : sql`
        UPDATE makita_tasks SET pr_closed_at = ${input.at},
          branch_cleanup = CASE WHEN branch LIKE 'makita/%' THEN 'pending' ELSE branch_cleanup END
        WHERE host = ${MAKITA_GITHUB_HOST} AND repo = ${input.repo} AND pr_number = ${input.number}
          AND pr_closed_at IS NULL AND landed_sha IS NULL
      `.pipe(Effect.asVoid);
