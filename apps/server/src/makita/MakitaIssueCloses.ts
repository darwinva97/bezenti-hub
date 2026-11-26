// @effect-diagnostics globalJsonInEffect:off - GitHub's answers are read with Schema.
/**
 * Makita ticket 26: a task's issue closed with a verdict, on the agent's request and the Hub's
 * checks (`makita_close_issue`), once per issue ever; and `/makita reopen` acted on. The only
 * writer of `makita_issue_closes` besides the intake's record of a reopening.
 */
import {
  MAKITA_GITHUB_HOST,
  MakitaError,
  SpaceId,
  type ThreadId,
  UserId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as AuditLog from "../audit/AuditLog.ts";
import * as SecretMasker from "../vaults/SecretMasker.ts";
import { storedAutonomyOf } from "./makitaAutonomy.ts";
import { isReopenOrder, REOPEN } from "./makitaAutonomyRows.ts";
import { allowedCallerIds } from "./makitaCallers.ts";
import {
  checkCloseInput,
  type CloseInput,
  closeCommentText,
  stateReasonOf,
} from "./makitaCloseRules.ts";
import { commentOfKey, commentPath, decodeOneComment } from "./makitaFeeds.ts";
import { MakitaGitHub, type MakitaGitHubError } from "./MakitaGitHub.ts";

const LIVE = ["running", "waiting-ci", "waiting-reply"];
const MAX_REPLIES_IN_A_ROW = 5;
const MAX_REPLIES_PER_DAY = 30;
const DAY_MS = 24 * 60 * 60 * 1_000;
/** A `/makita reopen` GitHub keeps failing to give back is dropped after this long. */
const GIVE_UP_MS = 30 * 60 * 1_000;
/** Text with the shape of a token never goes out, masked or not. */
const TOKEN_SHAPE =
  /(?:t3gk_|t3ak_|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/u;

const Issue = Schema.Struct({
  number: Schema.Number,
  state: Schema.String,
  locked: Schema.optional(Schema.Boolean),
  user: Schema.NullOr(Schema.Struct({ id: Schema.Number, login: Schema.String })),
  pull_request: Schema.optional(Schema.Unknown),
});
const decodeIssue = Schema.decodeUnknownOption(Schema.fromJsonString(Issue));

/** What `makita_close_issue` answers the agent. */
export interface MakitaCloseResult {
  readonly closed: boolean;
  readonly message: string;
}

export class MakitaIssueCloses extends Context.Service<
  MakitaIssueCloses,
  {
    /** `makita_close_issue`: the calling Thread's task's issue, closed only if every check passes. */
    readonly closeForThread: (
      threadId: ThreadId,
      input: CloseInput,
    ) => Effect.Effect<MakitaCloseResult, MakitaError>;
    /** Each `/makita reopen` the intake accepted, read again and acted on once. */
    readonly reopenQueued: Effect.Effect<void>;
  }
>()("t3/makita/MakitaIssueCloses") {}

interface CloseTask {
  readonly taskId: string;
  readonly configId: string;
  readonly spaceId: string;
  readonly repo: string;
  readonly number: number;
  readonly kind: string;
  readonly state: string;
  readonly callerId: number;
  readonly replies: number;
  readonly createdBy: string;
  readonly callersMode: string;
  readonly callersJson: string;
  readonly configPausedAt: string | null;
  readonly configDeletedAt: string | null;
  readonly autonomyJson: string;
  readonly makitaPaused: number;
  /** Ticket 29: the close comment says how to ask Makita to reopen it in words. */
  readonly makitaLogin: string;
}

const fail = (reason: MakitaError["reason"], message: string) =>
  Effect.fail(new MakitaError({ reason, message }));

const refused = (message: string): MakitaCloseResult => ({
  closed: false,
  message: `${message} Nothing was closed.`,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const github = yield* MakitaGitHub;
  const masker = yield* SecretMasker.SecretMasker;
  const nowMillis = Effect.map(DateTime.now, DateTime.toEpochMillis);
  const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

  const storage = (what: string) => (cause: unknown) =>
    Effect.logError(`MakitaIssueCloses: could not ${what}`, { cause }).pipe(
      Effect.andThen(fail("storage", `Could not ${what}. Try again.`)),
    );
  const githubRefusal = (what: string) => (error: MakitaGitHubError) =>
    fail("github", `Could not ${what} on GitHub: ${error.message}`);

  const readTask = (threadId: string) =>
    sql<CloseTask>`
      SELECT t.task_id AS "taskId", t.config_id AS "configId", t.space_id AS "spaceId", t.repo,
        t.number, t.kind, t.state, t.caller_github_id AS "callerId",
        t.replies_without_person AS replies, c.created_by AS "createdBy",
        c.callers_mode AS "callersMode", c.callers_json AS "callersJson",
        c.paused_at AS "configPausedAt", c.deleted_at AS "configDeletedAt",
        c.autonomy_json AS "autonomyJson",
        COALESCE((SELECT global_paused_at IS NOT NULL FROM makita_account
          WHERE account_id = 'makita'), 1) AS "makitaPaused",
        COALESCE((SELECT login FROM makita_account WHERE account_id = 'makita'), '')
          AS "makitaLogin"
      FROM makita_tasks t JOIN makita_configs c ON c.config_id = t.config_id
      WHERE t.thread_id = ${threadId}
    `.pipe(Effect.map((rows) => rows[0]));

  /** Why this task may not close now, or undefined while it may. */
  const haltOf = (task: CloseTask) =>
    task.makitaPaused
      ? "Makita is stopped for now."
      : task.configPausedAt !== null || task.configDeletedAt !== null
        ? "This Makita configuration is paused."
        : !LIVE.includes(task.state)
          ? "This Makita task has ended."
          : !storedAutonomyOf(task.autonomyJson).closeIssues
            ? "Closing issues is off for this configuration."
            : undefined;

  const closeForThread = Effect.fn("MakitaIssueCloses.closeForThread")(function* (
    threadId: ThreadId,
    input: CloseInput,
  ) {
    const task = yield* readTask(threadId).pipe(Effect.catch(storage("read this Thread's task")));
    if (task === undefined) return yield* fail("forbidden", "This Thread is not a Makita task's.");
    const halt = haltOf(task);
    if (halt !== undefined) return refused(halt);
    if (task.kind !== "issue") return refused("Your task is about a pull request, not an issue.");
    const checked = checkCloseInput(input, task.number);
    if (checked._tag === "refused") return refused(checked.message);
    const creator = UserId.make(task.createdBy);
    const reason = (yield* masker
      .forUser(creator)
      .pipe(Effect.catch(() => fail("storage", "Could not check the reason for secrets.")))).mask(
      checked.reason,
    );
    if (TOKEN_SHAPE.test(reason)) {
      return refused("The reason holds something shaped like a token or a key.");
    }
    const autonomy = storedAutonomyOf(task.autonomyJson);
    if (checked.confidence < autonomy.closeMinConfidence) {
      return refused(
        `Your confidence ${checked.confidence.toFixed(2)} is below this configuration's ${autonomy.closeMinConfidence.toFixed(2)}: comment your analysis instead and let a person decide.`,
      );
    }
    const now = yield* nowMillis;
    const [before] = yield* sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM makita_issue_closes
      WHERE (host = ${MAKITA_GITHUB_HOST} AND repo = ${task.repo} AND number = ${task.number})
        OR task_id = ${task.taskId}
    `.pipe(Effect.catch(storage("read Makita's closes")));
    if ((before?.n ?? 0) > 0) {
      return refused("Makita closes an issue once at most, and this one was closed before.");
    }
    const [today] = yield* sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM makita_issue_closes
      WHERE config_id = ${task.configId} AND claimed_at >= ${iso(now - DAY_MS)}
    `.pipe(Effect.catch(storage("count Makita's closes")));
    if ((today?.n ?? 0) >= autonomy.closePerDay) {
      return refused(
        `This configuration closed ${autonomy.closePerDay} issues in the last 24 hours, its limit.`,
      );
    }
    // The issue as it is now, and whose word put it in front of Makita.
    const issueAnswer = yield* github
      .rest({ operation: "issue-read", path: `repos/${task.repo}/issues/${task.number}` })
      .pipe(Effect.catch(githubRefusal("read the issue")));
    const issue = Option.getOrUndefined(decodeIssue(issueAnswer.body));
    if (issue === undefined || issue.pull_request !== undefined) {
      return refused("GitHub did not answer with an issue.");
    }
    if (issue.state !== "open") return refused("The issue is not open.");
    if (issue.locked === true) return refused("The issue is locked.");
    const allowed =
      (yield* allowedCallerIds(sql, [task]).pipe(
        Effect.catch(storage("read whom Makita answers")),
      )).get(task.configId) ?? new Set<number>();
    const authorAllowed = issue.user !== null && allowed.has(issue.user.id);
    if (!authorAllowed && !allowed.has(task.callerId)) {
      return refused(
        "Its author is not someone this configuration answers, and nobody it answers handed it to you.",
      );
    }
    if (checked.ref !== null) {
      const target = yield* github
        .rest({ operation: "issue-read", path: `repos/${task.repo}/issues/${checked.ref}` })
        .pipe(Effect.result);
      if (target._tag === "Failure") {
        if (target.failure.reason === "not-found") {
          return refused(`There is no #${checked.ref} in ${task.repo}.`);
        }
        return yield* githubRefusal(`read #${checked.ref}`)(target.failure);
      }
    }
    // The loop guard counts this comment like any other.
    const [comments] = yield* sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM audit_log
      WHERE action = 'makita.github.comment' AND target_kind = 'makita_task'
        AND target_id = ${task.taskId} AND at >= ${iso(now - DAY_MS)}
    `.pipe(Effect.catch(storage("count Makita's comments")));
    if ((comments?.n ?? 0) >= MAX_REPLIES_PER_DAY || task.replies >= MAX_REPLIES_IN_A_ROW) {
      return refused("Makita has commented too much here without a person in between.");
    }
    const stateReason = stateReasonOf(checked.verdict);
    const claimed = yield* sql<{ readonly taskId: string }>`
      INSERT INTO makita_issue_closes (host, repo, number, config_id, task_id, verdict,
        ref_number, confidence, state_reason, claimed_at)
      VALUES (${MAKITA_GITHUB_HOST}, ${task.repo}, ${task.number}, ${task.configId},
        ${task.taskId}, ${checked.verdict}, ${checked.ref}, ${checked.confidence}, ${stateReason},
        ${iso(now)})
      ON CONFLICT DO NOTHING
      RETURNING task_id AS "taskId"
    `.pipe(Effect.catch(storage("record the close")));
    if (claimed.length === 0) return refused("Another close of this issue came first.");
    const unclaim = sql`DELETE FROM makita_issue_closes WHERE task_id = ${task.taskId}`.pipe(
      Effect.catch(storage("forget the close")),
    );
    // Anything stopped since wins, right before GitHub hears of it.
    const again = yield* readTask(threadId).pipe(Effect.catch(storage("read the task again")));
    const haltNow = again === undefined ? "This Makita task has ended." : haltOf(again);
    if (haltNow !== undefined) {
      yield* unclaim;
      return refused(haltNow);
    }
    const body = closeCommentText({ ...checked, reason, makitaLogin: task.makitaLogin });
    const posted = yield* github
      .rest({
        operation: "issue-comment",
        method: "POST",
        path: `repos/${task.repo}/issues/${task.number}/comments`,
        body: { body },
      })
      .pipe(Effect.result);
    if (posted._tag === "Failure") {
      yield* unclaim;
      return yield* githubRefusal("post the verdict")(posted.failure);
    }
    const closed = yield* github
      .rest({
        operation: "issue-close",
        method: "PATCH",
        path: `repos/${task.repo}/issues/${task.number}`,
        body: { state: "closed", state_reason: stateReason },
      })
      .pipe(Effect.result);
    const at = iso(yield* nowMillis);
    const space = SpaceId.make(task.spaceId);
    const target = {
      kind: "makita_task" as const,
      id: task.taskId,
      name: `${task.repo}#${task.number}`,
    };
    const actor = { source: "agent" as const, userId: creator };
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
            UPDATE makita_tasks SET replies_without_person = replies_without_person + 1,
              updated_at = ${at}
            WHERE task_id = ${task.taskId}
          `;
          yield* AuditLog.write(sql)({
            actor,
            action: "makita.github.comment",
            spaceId: space,
            target,
            detail: {
              space,
              repo: task.repo,
              number: task.number,
              makita: task.configId,
              by: "agent",
            },
          });
          if (closed._tag === "Failure") {
            yield* sql`DELETE FROM makita_issue_closes WHERE task_id = ${task.taskId}`;
            return;
          }
          yield* sql`
            UPDATE makita_issue_closes SET closed_at = ${at} WHERE task_id = ${task.taskId}
          `;
          yield* sql`
            UPDATE makita_tasks SET state = 'done', pending_push_json = NULL, updated_at = ${at}
            WHERE task_id = ${task.taskId} AND state NOT IN ('done', 'stopped', 'failed')
          `;
          yield* AuditLog.write(sql)({
            actor,
            action: "makita.github.close_issue",
            spaceId: space,
            target,
            detail: {
              space,
              repo: task.repo,
              number: task.number,
              makita: task.configId,
              verdict: checked.verdict,
              ref: checked.ref,
              confidence: checked.confidence,
              stateReason,
            },
          });
        }),
      )
      .pipe(Effect.catch(storage("record the close")));
    if (closed._tag === "Failure") {
      return yield* githubRefusal("close the issue (the verdict comment is posted)")(
        closed.failure,
      );
    }
    return {
      closed: true,
      message: `Closed ${task.repo}#${task.number} as ${stateReason === "completed" ? "completed" : "not planned"}. Your task is done: end your turn without more comments.`,
    } satisfies MakitaCloseResult;
  });

  /** A queued `/makita reopen`, ended once: `outcome` and `detail` as it was decided. */
  const finish = (eventKey: string, outcome: string, detail: string) => sql`
    UPDATE makita_events SET outcome = ${outcome}, detail = ${detail}
    WHERE event_key = ${eventKey} AND outcome = 'command' AND detail = ${REOPEN}
  `;

  const reopenOne = Effect.fn("MakitaIssueCloses.reopenOne")(function* (row: {
    readonly eventKey: string;
    readonly repo: string;
    readonly number: number;
    readonly actorId: number;
    readonly configId: string;
    readonly seenAt: string;
  }) {
    const ref = commentOfKey(row.eventKey);
    if (ref === undefined) return yield* finish(row.eventKey, "command", "reopen:unreadable");
    const read = yield* github
      .rest({ operation: "comment-read", path: commentPath(row.repo, ref.feed, ref.id) })
      .pipe(Effect.result);
    if (read._tag === "Failure") {
      const seen = DateTime.make(row.seenAt);
      const old =
        Option.isNone(seen) || (yield* nowMillis) - DateTime.toEpochMillis(seen.value) > GIVE_UP_MS;
      if (read.failure.reason === "not-found" || read.failure.reason === "forbidden" || old) {
        return yield* finish(row.eventKey, "command", "reopen:unreadable");
      }
      return;
    }
    const comment = decodeOneComment(ref.feed, read.success.body);
    const [bot] = yield* sql<{ readonly login: string }>`
      SELECT login FROM makita_account WHERE account_id = 'makita'
    `;
    if (
      comment === undefined ||
      comment.author?.id !== row.actorId ||
      comment.updatedAt !== comment.createdAt ||
      !isReopenOrder(comment.body, bot?.login ?? "")
    ) {
      return yield* finish(row.eventKey, "ignored-edited", REOPEN);
    }
    const [config] = yield* sql<{
      readonly configId: string;
      readonly spaceId: string;
      readonly createdBy: string;
      readonly callersMode: string;
      readonly callersJson: string;
      readonly pausedAt: string | null;
      readonly deletedAt: string | null;
      readonly makitaPaused: number;
    }>`
      SELECT config_id AS "configId", space_id AS "spaceId", created_by AS "createdBy",
        callers_mode AS "callersMode", callers_json AS "callersJson", paused_at AS "pausedAt",
        deleted_at AS "deletedAt",
        COALESCE((SELECT global_paused_at IS NOT NULL FROM makita_account
          WHERE account_id = 'makita'), 1) AS "makitaPaused"
      FROM makita_configs WHERE config_id = ${row.configId}
    `;
    if (config === undefined || config.deletedAt !== null) {
      return yield* finish(row.eventKey, "ignored-no-config", REOPEN);
    }
    if (config.makitaPaused || config.pausedAt !== null) {
      return yield* finish(row.eventKey, "ignored-paused", REOPEN);
    }
    const allowed = (yield* allowedCallerIds(sql, [config])).get(config.configId);
    if (allowed?.has(row.actorId) !== true) {
      return yield* finish(row.eventKey, "ignored-not-allowed", REOPEN);
    }
    const [closed] = yield* sql<{ readonly reopenedAt: string | null }>`
      SELECT reopened_at AS "reopenedAt" FROM makita_issue_closes
      WHERE host = ${MAKITA_GITHUB_HOST} AND repo = ${row.repo} AND number = ${row.number}
        AND config_id = ${row.configId} AND closed_at IS NOT NULL
    `;
    if (closed === undefined || closed.reopenedAt !== null) {
      return yield* finish(row.eventKey, "command", "reopen:nothing-to-reopen");
    }
    const opened = yield* github
      .rest({
        operation: "issue-reopen",
        method: "PATCH",
        path: `repos/${row.repo}/issues/${row.number}`,
        body: { state: "open" },
      })
      .pipe(Effect.result);
    if (opened._tag === "Failure") {
      yield* Effect.logWarning("Makita could not reopen an issue it closed", {
        repo: row.repo,
        reason: opened.failure.reason,
      });
      if (opened.failure.reason === "rate-limited" || opened.failure.reason === "unreachable") {
        return;
      }
      return yield* finish(row.eventKey, "command", "reopen:refused");
    }
    const at = iso(yield* nowMillis);
    const space = SpaceId.make(config.spaceId);
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          UPDATE makita_issue_closes SET reopened_at = ${at},
            reopened_by_github_id = ${row.actorId}, reopened_by_login = ${comment.author?.login ?? null},
            reopened_via = 'command'
          WHERE host = ${MAKITA_GITHUB_HOST} AND repo = ${row.repo} AND number = ${row.number}
            AND reopened_at IS NULL
        `;
        yield* finish(row.eventKey, "command", "reopen:done");
        yield* AuditLog.write(sql)({
          actor: { source: "system" },
          action: "makita.github.reopen_issue",
          spaceId: space,
          target: { kind: "makita_config", id: config.configId },
          detail: {
            space,
            repo: row.repo,
            number: row.number,
            makita: config.configId,
            by: comment.author?.login ?? null,
          },
        });
      }),
    );
    // Heard: a reaction, no text (best effort).
    yield* github
      .rest({
        operation: "comment-reaction",
        method: "POST",
        path: `${commentPath(row.repo, ref.feed, ref.id)}/reactions`,
        body: { content: "+1" },
      })
      .pipe(
        Effect.andThen(
          AuditLog.write(sql)({
            actor: { source: "system" },
            action: "makita.github.reaction",
            spaceId: space,
            target: { kind: "makita_config", id: config.configId },
            detail: {
              space,
              repo: row.repo,
              number: row.number,
              makita: config.configId,
              content: "+1",
            },
          }),
        ),
        Effect.catch((error) =>
          Effect.logWarning("Makita could not react to /makita reopen", {
            repo: row.repo,
            reason: "reason" in error ? error.reason : "storage",
          }),
        ),
      );
  });

  const reopenQueued = Effect.gen(function* () {
    const rows = yield* sql<{
      readonly eventKey: string;
      readonly repo: string;
      readonly number: number;
      readonly actorId: number;
      readonly configId: string;
      readonly seenAt: string;
    }>`
      SELECT event_key AS "eventKey", repo, number, actor_github_id AS "actorId",
        config_id AS "configId", seen_at AS "seenAt"
      FROM makita_events
      WHERE outcome = 'command' AND detail = ${REOPEN} AND config_id IS NOT NULL
        AND actor_github_id IS NOT NULL
      ORDER BY seen_at, rowid LIMIT 20
    `;
    for (const row of rows) {
      yield* reopenOne(row).pipe(
        Effect.catch((cause) =>
          Effect.logError("Makita could not act on /makita reopen", {
            eventKey: row.eventKey,
            cause,
          }),
        ),
      );
    }
  }).pipe(
    Effect.catch((cause) => Effect.logError("Makita could not read its reopen orders", { cause })),
    Effect.withSpan("MakitaIssueCloses.reopenQueued"),
  );

  return MakitaIssueCloses.of({ closeForThread, reopenQueued });
});

/** Over Makita's GitHub client, the database and the secret masker. */
export const layer = Layer.effect(MakitaIssueCloses, make);
