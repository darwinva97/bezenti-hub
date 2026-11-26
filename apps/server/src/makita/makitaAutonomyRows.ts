/**
 * Makita tickets 26–27, as the intake decides them inside its batch: an approver's bad-work label
 * on one of Makita's pull requests, an issue Makita closed being reopened on GitHub, and
 * `/makita reopen`. What each event becomes is acted on later by `MakitaCleanup`.
 */
import { MAKITA_GITHUB_HOST } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

import type { FeedComment } from "./makitaFeeds.ts";
import { plainIntentOf } from "./makitaPlainWords.ts";

/** Event details of what `MakitaCleanup` acts on once the batch is written. */
export const BAD_WORK = "bad-work";
export const REOPEN = "reopen";

/** A configuration as these decisions read it (a slice of the intake's `ListeningConfig`). */
interface DecidingConfig {
  readonly configId: string;
  readonly callerIds: ReadonlySet<number>;
  readonly ignore: ReadonlySet<string>;
  readonly active: boolean;
  /** Lower case; null: no bad-work label. */
  readonly badWorkLabel: string | null;
}

interface Actor {
  readonly login: string;
  readonly id: number;
  readonly type?: string | undefined;
}

/** An issue event as these decisions read it. */
interface IssueEventLike {
  readonly event: string;
  readonly actor: Actor | null;
  readonly label?: { readonly name: string } | undefined;
  readonly issue?: { readonly number: number; readonly pull_request?: unknown } | undefined;
}

type Outcome =
  | "command"
  | "ignored-bot"
  | "ignored-self"
  | "ignored-paused"
  | "ignored-edited"
  | "ignored-not-allowed";

export interface AutonomyDecision {
  readonly outcome: Outcome;
  readonly configId: string;
  readonly detail: string;
}

/** Makita itself, a ghost, a bot or an ignored login: what is never anyone's order. */
const notAPerson = (
  actor: Actor | null,
  makitaId: number,
  config: DecidingConfig,
): "ignored-bot" | "ignored-self" | undefined =>
  actor === null
    ? "ignored-bot"
    : actor.id === makitaId
      ? "ignored-self"
      : actor.type === "Bot" || config.ignore.has(actor.login.toLowerCase())
        ? "ignored-bot"
        : undefined;

/** `/makita reopen` as a comment's first line (any case, trimmed). */
export const isReopenCommand = (body: string) =>
  (body.split(/\r?\n/u)[0] ?? "").trim().toLowerCase() === "/makita reopen";

/** Ticket 29: `/makita reopen`, or «@makita reábrelo» in plain words (an issue: with the mention). */
export const isReopenOrder = (body: string, makitaLogin: string) =>
  isReopenCommand(body) ||
  plainIntentOf(body, { login: makitaLogin, addressed: "mention" }) === "reopen";

/**
 * Ticket 27: a label on a pull request that is the bad-work label of the configuration whose task
 * owns that pull request. Whether its author approves is read when it is acted on (`command`).
 */
export const decideBadWorkLabel = Effect.fn("makitaAutonomyRows.decideBadWorkLabel")(function* (
  sql: SqlClient.SqlClient,
  input: {
    readonly repo: string;
    readonly event: IssueEventLike;
    readonly configs: ReadonlyArray<DecidingConfig>;
    readonly makitaId: number;
  },
) {
  const { event } = input;
  if (event.event !== "labeled" || event.label === undefined) return undefined;
  if (event.issue === undefined || event.issue.pull_request === undefined) return undefined;
  const label = event.label.name.toLowerCase();
  if (!input.configs.some((config) => config.badWorkLabel === label)) return undefined;
  const [task] = yield* sql<{ readonly configId: string }>`
    SELECT config_id AS "configId" FROM makita_tasks
    WHERE host = ${MAKITA_GITHUB_HOST} AND repo = ${input.repo} AND pr_number = ${event.issue.number}
    ORDER BY created_at DESC, task_id DESC LIMIT 1
  `;
  const config = input.configs.find(
    (entry) => entry.configId === task?.configId && entry.badWorkLabel === label,
  );
  if (config === undefined) return undefined;
  const decided = (outcome: Outcome, detail = BAD_WORK): AutonomyDecision => ({
    outcome,
    configId: config.configId,
    detail,
  });
  const ignored = notAPerson(event.actor, input.makitaId, config);
  if (ignored !== undefined) return decided(ignored);
  if (!config.active) return decided("ignored-paused");
  return decided("command");
});

/** The configuration that closed this issue, while it stays closed by Makita. */
const closedByMakita = (sql: SqlClient.SqlClient, repo: string, number: number) =>
  sql<{ readonly configId: string }>`
    SELECT config_id AS "configId" FROM makita_issue_closes
    WHERE host = ${MAKITA_GITHUB_HOST} AND repo = ${repo} AND number = ${number}
      AND closed_at IS NOT NULL AND reopened_at IS NULL
  `.pipe(Effect.map((rows) => rows[0]));

/**
 * Ticket 26: an issue Makita closed, reopened on GitHub by someone its configuration answers,
 * is recorded as reopened (Makita never closes an issue twice anyway). Others are not stored.
 */
export const recordReopenWithin = Effect.fn("makitaAutonomyRows.recordReopenWithin")(function* (
  sql: SqlClient.SqlClient,
  input: {
    readonly repo: string;
    readonly event: IssueEventLike;
    readonly configs: ReadonlyArray<DecidingConfig>;
    readonly makitaId: number;
  },
) {
  const { event } = input;
  if (event.event !== "reopened" || event.issue === undefined) return undefined;
  if (event.issue.pull_request !== undefined) return undefined;
  const closed = yield* closedByMakita(sql, input.repo, event.issue.number);
  const config = input.configs.find((entry) => entry.configId === closed?.configId);
  const actor = event.actor;
  if (config === undefined || actor === null) return undefined;
  if (notAPerson(actor, input.makitaId, config) !== undefined) return undefined;
  if (!config.callerIds.has(actor.id)) return undefined;
  yield* sql`
    UPDATE makita_issue_closes SET reopened_at = ${DateTime.formatIso(yield* DateTime.now)},
      reopened_by_github_id = ${actor.id}, reopened_by_login = ${actor.login},
      reopened_via = 'github'
    WHERE host = ${MAKITA_GITHUB_HOST} AND repo = ${input.repo} AND number = ${event.issue.number}
      AND reopened_at IS NULL
  `;
  return { outcome: "command", configId: config.configId, detail: "reopened" } as AutonomyDecision;
});

/**
 * Ticket 26: `/makita reopen` (ticket 29: or its plain words) in a new comment on an issue Makita
 * closed. Undefined (decided like any comment) when Makita did not close it; strangers, bots and
 * edits are ignored silently.
 */
export const decideReopenComment = Effect.fn("makitaAutonomyRows.decideReopenComment")(function* (
  sql: SqlClient.SqlClient,
  input: {
    readonly repo: string;
    readonly comment: FeedComment;
    readonly configs: ReadonlyArray<DecidingConfig>;
    readonly makitaId: number;
    readonly makitaLogin: string;
  },
) {
  const { comment } = input;
  if (
    !isReopenOrder(comment.body, input.makitaLogin) ||
    !comment.eventKey.startsWith("gh:issue-comment:")
  ) {
    return undefined;
  }
  const closed = yield* closedByMakita(sql, input.repo, comment.number);
  const config = input.configs.find((entry) => entry.configId === closed?.configId);
  if (config === undefined) return undefined;
  const decided = (outcome: Outcome, detail = REOPEN): AutonomyDecision => ({
    outcome,
    configId: config.configId,
    detail,
  });
  const ignored = notAPerson(comment.author, input.makitaId, config);
  if (ignored !== undefined) return decided(ignored);
  if (comment.updatedAt !== comment.createdAt) return decided("ignored-edited");
  if (comment.author === null || !config.callerIds.has(comment.author.id)) {
    return decided("ignored-not-allowed");
  }
  if (!config.active) return decided("ignored-paused");
  return decided("command");
});
