/**
 * Makita ticket 11: a push waits for an approver (`holdForApproval`, inside `makita_push`), an
 * approver's `/makita ok` or the Owner's approval is recorded, and the approved commit, exactly
 * that one, is sent by the Hub (`makeReleaseApproved`), then said on GitHub and to the Thread.
 */
import {
  CommandId,
  MAKITA_GITHUB_HOST,
  MakitaError,
  MessageId,
  ProjectId,
  SpaceId,
  ThreadId,
  UserId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

import * as AuditLog from "../audit/AuditLog.ts";
import * as CommandActor from "../auth/CommandActor.ts";
import type * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import {
  type ApprovalRequestKind,
  approvalRequestKeysOf,
  approverIdsOf,
  approvesWaiting,
  decodePending,
  encodeApproval,
  encodePending,
  isApprovalOrder,
  isApproverNow,
  liveTaskOfItem,
  type MakitaApproval,
  type MakitaPendingPush,
  pushNeedsApproval,
  requestText,
} from "./makitaApprovers.ts";
import { commentOfKey, commentPath, decodeOneComment, mentions } from "./makitaFeeds.ts";
import type { MakitaGitHub } from "./MakitaGitHub.ts";
import type { MakitaMachines } from "./MakitaMachines.ts";
import type { MakitaPushResult } from "./MakitaPushes.ts";
import { makitaTaskOfThread } from "./makitaRows.ts";

/** Makita's comments in a row without a person in between (the loop guard of `makita_comment`). */
const MAX_REPLIES_IN_A_ROW = 5;
/** A `/makita ok` GitHub keeps failing to give back is dropped after this long. */
const GIVE_UP_MS = 30 * 60 * 1_000;
const LIVE = ["awaiting-approval", "running", "waiting-ci", "waiting-reply"];
const SOMEONE_ELSE = "Someone else pushed to this branch.";
/** At most this many approvers named in a request. */
const MAX_NAMED = 3;

const Posted = Schema.Struct({ id: Schema.Number, created_at: Schema.String });
const decodePosted = Schema.decodeUnknownOption(Schema.fromJsonString(Posted));
const Author = Schema.Struct({ login: Schema.String, id: Schema.Number });
const decodeIssueAuthor = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ user: Schema.NullOr(Author) })),
);
const decodeAuthors = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ user: Schema.NullOr(Author) }))),
);

type GitHub = typeof MakitaGitHub.Service;
const isMakitaError = Schema.is(MakitaError);
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const sizeOf = (pending: MakitaPendingPush) =>
  `+${pending.additions} −${pending.deletions} in ${plural(pending.files, "file")}`;

/** Any failure that is not already Makita's own, logged and said as a storage failure. */
const asMakitaError = (what: string) => (cause: unknown) =>
  isMakitaError(cause)
    ? Effect.fail(cause)
    : Effect.logError(`Makita could not ${what}`, { cause }).pipe(
        Effect.andThen(
          Effect.fail(
            new MakitaError({ reason: "storage", message: `Could not ${what}. Try again.` }),
          ),
        ),
      );

interface HubCommentTask {
  readonly taskId: string;
  readonly configId: string;
  readonly spaceId: string;
  readonly repo: string;
  readonly number: number;
}

/** A comment the Hub itself posts on the task's issue: counted by the loop guard, audited. */
const postAsHub = Effect.fn("makitaApprovalFlow.postAsHub")(function* (
  sql: SqlClient.SqlClient,
  github: GitHub,
  task: HubCommentTask,
  body: string,
) {
  const answer = yield* github.rest({
    operation: "issue-comment",
    method: "POST",
    path: `repos/${task.repo}/issues/${task.number}/comments`,
    body: { body },
  });
  const at = yield* nowIso;
  yield* sql`
    UPDATE makita_tasks SET replies_without_person = replies_without_person + 1, updated_at = ${at}
    WHERE task_id = ${task.taskId}
  `;
  yield* AuditLog.write(sql)({
    actor: { source: "system" },
    action: "makita.github.comment",
    spaceId: SpaceId.make(task.spaceId),
    target: { kind: "makita_task", id: task.taskId, name: `${task.repo}#${task.number}` },
    detail: {
      space: task.spaceId,
      repo: task.repo,
      number: task.number,
      makita: task.configId,
      by: "hub",
    },
  });
  return decodePosted(answer.body);
});

/**
 * The approvers who already wrote on the issue, by their login as GitHub shows it now (a login is
 * public there): nobody else is named. Empty when GitHub cannot be read.
 */
const approversOnIssue = Effect.fn("makitaApprovalFlow.approversOnIssue")(function* (
  sql: SqlClient.SqlClient,
  github: GitHub,
  task: HubCommentTask & { readonly createdBy: string; readonly approversJson: string },
) {
  const approvers = (yield* approverIdsOf(sql, [task])).get(task.configId) ?? new Set<number>();
  if (approvers.size === 0) return [] as ReadonlyArray<string>;
  const issue = yield* github
    .rest({ operation: "issue-read", path: `repos/${task.repo}/issues/${task.number}` })
    .pipe(Effect.option);
  const comments = yield* github
    .rest({
      operation: "issue-comments",
      path: `repos/${task.repo}/issues/${task.number}/comments?per_page=100`,
    })
    .pipe(Effect.option);
  const authors = [
    ...Option.toArray(
      Option.flatMap(issue, (answer) =>
        Option.flatMap(decodeIssueAuthor(answer.body), (read) => Option.fromNullishOr(read.user)),
      ),
    ),
    ...Option.getOrElse(
      Option.flatMap(comments, (answer) => decodeAuthors(answer.body)),
      () => [],
    ).flatMap((comment) => (comment.user === null ? [] : [comment.user])),
  ];
  const named = new Map<number, string>();
  for (const author of authors) {
    if (approvers.has(author.id) && !named.has(author.id)) named.set(author.id, author.login);
  }
  return [...named.values()].slice(0, MAX_NAMED);
});

interface MakitaHoldInput {
  readonly taskId: string;
  readonly head: string;
  readonly branch: string;
  readonly commits: number;
  /** The change's size, read only when the push waits. */
  readonly stats: Effect.Effect<
    { readonly files: number; readonly additions: number; readonly deletions: number },
    MakitaError
  >;
}

const hold = Effect.fn("makitaApprovalFlow.holdForApproval")(function* (
  sql: SqlClient.SqlClient,
  github: GitHub,
  input: MakitaHoldInput,
) {
  if (!(yield* pushNeedsApproval(sql, input.taskId))) return null;
  const [task] = yield* sql<
    HubCommentTask & {
      readonly pendingJson: string | null;
      readonly replies: number;
      readonly createdBy: string;
      readonly approversJson: string;
    }
  >`
      SELECT t.task_id AS "taskId", t.config_id AS "configId", t.space_id AS "spaceId", t.repo,
        t.number, t.pending_push_json AS "pendingJson", t.replies_without_person AS replies,
        c.created_by AS "createdBy", c.approvers_json AS "approversJson"
      FROM makita_tasks t JOIN makita_configs c ON c.config_id = t.config_id
      WHERE t.task_id = ${input.taskId}
    `;
  if (task === undefined) {
    return yield* new MakitaError({ reason: "forbidden", message: "This Makita task has ended." });
  }
  const waiting = (pending: MakitaPendingPush, then: string): MakitaPushResult => ({
    pushed: false,
    message: `This push needs an approver's approval on GitHub (in their own words, or \`/makita ok\`) before it reaches GitHub. Nothing was pushed; ${pending.branch} (${sizeOf(pending)}) waits. ${then}`,
    branch: pending.branch,
    sha: pending.sha,
    commits: pending.commits,
  });
  const asked =
    "Makita asked on the issue. Stop here: when an approver answers, the Hub pushes exactly this commit and tells you.";
  const current = decodePending(task.pendingJson);
  if (
    Option.isSome(current) &&
    current.value.sha === input.head &&
    current.value.request !== undefined
  ) {
    return waiting(current.value, asked);
  }
  const stats = yield* input.stats;
  const pending: MakitaPendingPush = {
    sha: input.head,
    branch: input.branch,
    commits: input.commits,
    ...stats,
    at: yield* nowIso,
  };
  const kept = encodePending(pending);
  yield* sql`
      UPDATE makita_tasks SET pending_push_json = ${kept}, updated_at = ${pending.at}
      WHERE task_id = ${task.taskId} AND state NOT IN ('done', 'stopped', 'failed')
    `;
  if (task.replies >= MAX_REPLIES_IN_A_ROW) {
    return waiting(
      pending,
      "Makita has commented too often without a person in between, so it did not ask on the issue. Stop here and wait for a person.",
    );
  }
  const who = yield* approversOnIssue(sql, github, task);
  const [bot] = yield* sql<{ readonly login: string }>`
    SELECT login FROM makita_account WHERE account_id = 'makita'
  `;
  const body = requestText({
    branch: pending.branch,
    size: sizeOf(pending),
    approvers: who,
    makitaLogin: bot?.login ?? "",
  });
  const posted = yield* postAsHub(sql, github, task, body).pipe(Effect.result);
  if (posted._tag === "Failure" || Option.isNone(posted.success)) {
    if (posted._tag === "Failure") {
      yield* Effect.logWarning("Makita could not ask for an approval", {
        taskId: task.taskId,
        reason: "reason" in posted.failure ? posted.failure.reason : "storage",
      });
    }
    return waiting(
      pending,
      "Makita could not ask on the issue for now; call makita_push again later to ask again.",
    );
  }
  const request = { commentId: posted.success.value.id, at: posted.success.value.created_at };
  yield* sql`
      UPDATE makita_tasks SET pending_push_json = ${encodePending({ ...pending, request })}
      WHERE task_id = ${task.taskId} AND pending_push_json = ${kept}
    `;
  return waiting(pending, asked);
});

/**
 * Inside `makita_push`, after its checks and before anything reaches GitHub: null when this push
 * may go out now; otherwise it is kept in `pending_push_json` and Makita asks once on the issue.
 */
export const holdForApproval = (sql: SqlClient.SqlClient, github: GitHub, input: MakitaHoldInput) =>
  hold(sql, github, input).pipe(Effect.catch(asMakitaError("keep the push for approval")));

interface ApprovedTask {
  readonly taskId: string;
  readonly configId: string;
  readonly spaceId: string;
  readonly repo: string;
  readonly number: number;
  /** The waiting push as it was read: only that one is approved. */
  readonly pendingJson: string | null;
}

/**
 * An approver's GitHub approval of the waiting push, inside the caller's transaction: only the push
 * that was pending when it was read (a newer one needs its own), audited `makita.task.approve`.
 */
const recordApprovalWithin = Effect.fn("makitaApprovalFlow.recordApprovalWithin")(function* (
  sql: SqlClient.SqlClient,
  input: {
    readonly task: ApprovedTask;
    readonly pending: MakitaPendingPush;
    readonly approval: MakitaApproval;
  },
) {
  const { task, approval } = input;
  const at = yield* nowIso;
  const updated = yield* sql<{ readonly id: string }>`
    UPDATE makita_tasks SET pending_push_json = ${encodePending({ ...input.pending, approval })},
      approved_through = ${encodeApproval(approval)}, replies_without_person = 0,
      updated_at = ${at}
    WHERE task_id = ${task.taskId} AND pending_push_json = ${task.pendingJson}
      AND state NOT IN ('done', 'stopped', 'failed')
    RETURNING task_id AS id
  `;
  if (updated.length === 0) return false;
  yield* AuditLog.write(sql)({
    actor: { source: "system" },
    action: "makita.task.approve",
    spaceId: SpaceId.make(task.spaceId),
    target: { kind: "makita_task", id: task.taskId, name: `${task.repo}#${task.number}` },
    detail: {
      space: task.spaceId,
      repo: task.repo,
      number: task.number,
      makita: task.configId,
      via: "github",
      login: approval.login,
      sha: input.pending.sha,
    },
  });
  return true;
});

/** A 👍 on the approving comment, audited; best effort. */
const thumbsUp = (sql: SqlClient.SqlClient, github: GitHub, task: ApprovedTask, path: string) =>
  github
    .rest({
      operation: "comment-reaction",
      method: "POST",
      path: `${path}/reactions`,
      body: { content: "+1" },
    })
    .pipe(
      Effect.andThen(
        AuditLog.write(sql)({
          actor: { source: "system" },
          action: "makita.github.reaction",
          spaceId: SpaceId.make(task.spaceId),
          target: { kind: "makita_task", id: task.taskId, name: `${task.repo}#${task.number}` },
          detail: {
            space: task.spaceId,
            repo: task.repo,
            number: task.number,
            makita: task.configId,
            content: "+1",
          },
        }),
      ),
      Effect.catch((error) =>
        Effect.logWarning("Makita could not react to an approval", {
          taskId: task.taskId,
          reason: "reason" in error ? error.reason : "storage",
        }),
      ),
    );

/** A queued `/makita ok`, as the tasks pass reads it from `makita_events`. */
interface MakitaApprovalEvent {
  readonly eventKey: string;
  readonly repo: string;
  readonly number: number;
  readonly actorId: number;
  readonly configId: string;
  readonly seenAt: string;
}

/**
 * A queued `/makita ok`, decided once: read again from GitHub by id and accepted only if it is
 * unedited, by the author the intake saw, an approver now, newer than Makita's request, and the
 * waiting push has no approval yet. Recorded with the event in one transaction; then a 👍.
 */
export const approveFromGitHub = Effect.fn("makitaApprovalFlow.approveFromGitHub")(function* (
  sql: SqlClient.SqlClient,
  github: GitHub,
  row: MakitaApprovalEvent,
) {
  const finish = (
    outcome:
      | "approval"
      | "ignored-not-approver"
      | "ignored-edited"
      | "ignored-self"
      | "ignored-paused"
      | "ignored-no-config"
      | "command",
    detail: string | null,
    taskId: string | null = null,
  ) => sql`
    UPDATE makita_events SET outcome = ${outcome}, detail = ${detail},
      task_id = COALESCE(${taskId}, task_id)
    WHERE event_key = ${row.eventKey} AND outcome = 'queued'
  `;
  const ref = commentOfKey(row.eventKey);
  if (ref === undefined || ref.feed !== "issue-comments") {
    return yield* finish("ignored-no-config", "not-an-issue-comment");
  }
  const read = yield* github
    .rest({ operation: "comment-read", path: commentPath(row.repo, ref.feed, ref.id) })
    .pipe(Effect.result);
  if (read._tag === "Failure") {
    const seen = Option.map(DateTime.make(row.seenAt), DateTime.toEpochMillis);
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const reason = read.failure.reason;
    if (
      reason === "not-found" ||
      reason === "forbidden" ||
      Option.isNone(seen) ||
      now - seen.value > GIVE_UP_MS
    ) {
      return yield* finish("ignored-no-config", "comment-unreadable");
    }
    // GitHub was slow or limited: the next pass reads it again.
    return;
  }
  const comment = decodeOneComment(ref.feed, read.success.body);
  if (comment === undefined) return yield* finish("ignored-no-config", "comment-unreadable");
  const author = comment.author;
  // Only creation counts, only from the person the intake saw.
  if (author === null || author.id !== row.actorId || comment.updatedAt !== comment.createdAt) {
    return yield* finish("ignored-edited", null);
  }
  const [account] = yield* sql<{
    readonly id: number;
    readonly login: string;
    readonly paused: string | null;
  }>`
    SELECT github_user_id AS id, login, global_paused_at AS paused FROM makita_account
    WHERE account_id = 'makita'
  `;
  if (account === undefined || account.paused !== null) {
    return yield* finish("ignored-paused", "makita-paused");
  }
  if (author.id === account.id) return yield* finish("ignored-self", null);
  const task = yield* liveTaskOfItem(sql, row.repo, comment.number);
  if (task === undefined || task.configId !== row.configId) {
    return yield* finish("command", "nothing-to-approve");
  }
  // Still the order itself: `/makita ok`, or its plain words (ticket 29).
  if (
    !isApprovalOrder(comment.body, {
      login: account.login,
      onOwnPull: comment.number !== task.number,
    })
  ) {
    return yield* finish("ignored-edited", null);
  }
  const [config] = yield* sql<{ readonly paused: string | null; readonly deleted: string | null }>`
    SELECT paused_at AS paused, deleted_at AS deleted FROM makita_configs
    WHERE config_id = ${task.configId}
  `;
  if (config === undefined || config.paused !== null || config.deleted !== null) {
    return yield* finish("ignored-paused", "config-paused", task.taskId);
  }
  if (!(yield* isApproverNow(sql, task.configId, author.id))) {
    return yield* finish("ignored-not-approver", null, task.taskId);
  }
  const pending = decodePending(task.pendingJson);
  if (Option.isNone(pending)) return yield* finish("command", "nothing-to-approve", task.taskId);
  const request = pending.value.request;
  // Comment ids only grow: an approval written before Makita asked approves nothing.
  if (request === undefined || ref.id <= request.commentId) {
    return yield* finish("command", "before-request", task.taskId);
  }
  if (pending.value.approval !== undefined) {
    return yield* finish("command", "already-approved", task.taskId);
  }
  const approval: MakitaApproval = {
    via: "github",
    at: comment.createdAt,
    login: author.login,
    commentId: ref.id,
  };
  const target = { ...task, repo: row.repo };
  const approved = yield* sql.withTransaction(
    Effect.gen(function* () {
      if (!(yield* recordApprovalWithin(sql, { task: target, pending: pending.value, approval }))) {
        yield* finish("command", "nothing-to-approve", task.taskId);
        return false;
      }
      yield* finish("approval", "approved", task.taskId);
      return true;
    }),
  );
  if (!approved) return;
  yield* thumbsUp(sql, github, target, commentPath(row.repo, ref.feed, ref.id));
});

/** What `makita_request_approval` answers the agent. */
export interface MakitaApprovalRequestResult {
  readonly approved: boolean;
  readonly message: string;
}

const notApproved = (message: string): MakitaApprovalRequestResult => ({
  approved: false,
  message: `${message} Nothing was approved.`,
});

const refuseRequest = (reason: MakitaError["reason"], message: string) =>
  Effect.fail(new MakitaError({ reason, message }));

/**
 * Ticket 29, `makita_request_approval`: nothing of the call is trusted but the comment's id. The
 * comment is read again on GitHub and must be an approver's, unedited, newer than Makita's request,
 * on the task's pull request (or a mention on its issue), the one that woke the current turn, and
 * unused. Then the waiting push is approved exactly as by `/makita ok`.
 */
const requestApproval = Effect.fn("makitaApprovalFlow.requestApproval")(function* (
  sql: SqlClient.SqlClient,
  github: GitHub,
  threadId: string,
  input: { readonly commentId: number; readonly kind: ApprovalRequestKind },
) {
  const [task] = yield* sql<{
    readonly taskId: string;
    readonly configId: string;
    readonly spaceId: string;
    readonly repo: string;
    readonly number: number;
    readonly prNumber: number | null;
    readonly state: string;
    readonly pendingJson: string | null;
    readonly capability: string;
    readonly configPausedAt: string | null;
    readonly configDeletedAt: string | null;
  }>`
    SELECT t.task_id AS "taskId", t.config_id AS "configId", t.space_id AS "spaceId", t.repo,
      t.number, t.pr_number AS "prNumber", t.state, t.pending_push_json AS "pendingJson",
      c.capability, c.paused_at AS "configPausedAt", c.deleted_at AS "configDeletedAt"
    FROM makita_tasks t JOIN makita_configs c ON c.config_id = t.config_id
    WHERE t.thread_id = ${threadId}
  `;
  if (task === undefined) {
    return yield* refuseRequest("forbidden", "This Thread is not a Makita task's.");
  }
  const [bot] = yield* sql<{
    readonly id: number;
    readonly login: string;
    readonly paused: string | null;
  }>`
    SELECT github_user_id AS id, login, global_paused_at AS paused FROM makita_account
    WHERE account_id = 'makita'
  `;
  // Anything stopped wins, a `/makita stop` already heard for its issue or pull request too.
  const numbers = task.prNumber === null ? [task.number] : [task.number, task.prNumber];
  const stops = yield* sql<{ readonly key: string }>`
    SELECT event_key AS key FROM makita_events
    WHERE outcome = 'queued' AND detail = 'stop' AND host = ${MAKITA_GITHUB_HOST}
      AND repo = ${task.repo} AND ${sql.in("number", numbers)}
  `;
  if (!LIVE.includes(task.state)) {
    return yield* refuseRequest("forbidden", "This Makita task has ended.");
  }
  if (
    bot === undefined ||
    bot.paused !== null ||
    task.configPausedAt !== null ||
    task.configDeletedAt !== null ||
    stops.length > 0
  ) {
    return yield* refuseRequest("forbidden", "Makita is stopped for this work.");
  }
  if (task.capability !== "push") {
    return yield* refuseRequest("forbidden", "This Makita configuration may not push.");
  }
  const pending = decodePending(task.pendingJson);
  if (Option.isNone(pending)) return notApproved("No push of yours waits for an approver.");
  if (pending.value.approval !== undefined) {
    return notApproved("Your waiting push is already approved: the Hub sends it on its next pass.");
  }
  const request = pending.value.request;
  if (request === undefined) {
    return notApproved(
      "Makita has not asked on GitHub for this push yet: call makita_push again so it asks.",
    );
  }
  if (input.kind === "review") {
    return notApproved(
      "A review cannot approve a push: GitHub keeps no record of whether its text was edited. The approver can say it in a comment.",
    );
  }
  if (!Number.isSafeInteger(input.commentId) || input.commentId <= 0) {
    return notApproved("That is not a comment id.");
  }
  const feed = input.kind === "issue-comment" ? "issue-comments" : "review-comments";
  const read = yield* github
    .rest({ operation: "comment-read", path: commentPath(task.repo, feed, input.commentId) })
    .pipe(Effect.result);
  if (read._tag === "Failure") {
    return read.failure.reason === "not-found"
      ? notApproved("There is no such comment in your task's repository.")
      : yield* refuseRequest(
          "github",
          `Could not read the comment on GitHub: ${read.failure.message}`,
        );
  }
  const comment = decodeOneComment(feed, read.success.body);
  if (comment === undefined) return notApproved("That is not a comment Makita can read.");
  const onPull = task.prNumber !== null && comment.number === task.prNumber;
  const mentionOnIssue =
    comment.number === task.number &&
    input.kind === "issue-comment" &&
    mentions(comment.body, bot.login);
  if (!onPull && !mentionOnIssue) {
    return notApproved(
      "That comment is neither on your pull request nor a mention of Makita on your issue.",
    );
  }
  const author = comment.author;
  if (author === null || author.id === bot.id) {
    return notApproved("That comment is not a person's: it cannot approve anything.");
  }
  if (comment.updatedAt !== comment.createdAt) {
    return notApproved("That comment was edited: an edited comment never approves.");
  }
  if (!approvesWaiting(task.pendingJson, { feed, id: comment.id, createdAt: comment.createdAt })) {
    return notApproved(
      "That comment was written before Makita asked for this push: only an approval given after it counts.",
    );
  }
  if (!(yield* isApproverNow(sql, task.configId, author.id))) {
    return notApproved(
      "Only an approver's comment can approve your push, and its author is not one.",
    );
  }
  const keys = approvalRequestKeysOf(input.kind, comment.id);
  const wakes = yield* sql<{
    readonly key: string;
    readonly actorId: number | null;
    readonly seenAt: string;
  }>`
    SELECT event_key AS key, actor_github_id AS "actorId", seen_at AS "seenAt"
    FROM makita_events WHERE task_id = ${task.taskId} AND outcome = 'started'
    ORDER BY seen_at DESC, rowid DESC
  `;
  const cited = wakes.find((wake) => wake.key === keys.event);
  if (cited === undefined || cited.actorId !== author.id || cited.seenAt !== wakes[0]?.seenAt) {
    return notApproved(
      "That comment did not wake your current turn: only the comment that woke you can approve.",
    );
  }
  const approval: MakitaApproval = {
    via: "github",
    at: comment.createdAt,
    login: author.login,
    commentId: comment.id,
  };
  const at = yield* nowIso;
  const outcome = yield* sql.withTransaction(
    Effect.gen(function* () {
      // One comment, one attempt: marked with the approval itself.
      const marked = yield* sql<{ readonly key: string }>`
        INSERT INTO makita_events (event_key, host, repo, number, kind, actor_github_id,
          actor_login, created_at_github, seen_at, config_id, outcome, detail, task_id)
        VALUES (${keys.used}, ${MAKITA_GITHUB_HOST}, ${task.repo}, ${comment.number},
          ${onPull ? "pull" : "issue"}, ${author.id}, ${author.login}, ${comment.createdAt},
          ${at}, ${task.configId}, 'approval', 'requested', ${task.taskId})
        ON CONFLICT (event_key) DO NOTHING
        RETURNING event_key AS key
      `;
      if (marked.length === 0) return "used" as const;
      const recorded = yield* recordApprovalWithin(sql, {
        task,
        pending: pending.value,
        approval,
      });
      return recorded ? ("approved" as const) : ("gone" as const);
    }),
  );
  if (outcome === "used") return notApproved("That comment was already used for an approval.");
  if (outcome === "gone") return notApproved("No push of yours waits for an approver any more.");
  yield* thumbsUp(sql, github, task, commentPath(task.repo, feed, comment.id));
  return {
    approved: true,
    message: `Approved by @${author.login}. The Hub pushes exactly ${pending.value.sha.slice(0, 12)} to ${pending.value.branch} on its next pass and tells you; stop here until then.`,
  } satisfies MakitaApprovalRequestResult;
});

/** `makita_request_approval` for the calling agent's own Thread; storage failures are said. */
export const requestApprovalForThread = (
  sql: SqlClient.SqlClient,
  github: GitHub,
  threadId: string,
  input: { readonly commentId: number; readonly kind: ApprovalRequestKind },
) =>
  requestApproval(sql, github, threadId, input).pipe(
    Effect.catch(asMakitaError("handle the approval request")),
  );

/**
 * The Owner's «Approve» on the Hub, inside the caller's transaction: the waiting push gets the
 * approval (the next tasks pass sends it), audited `makita.task.approve` with `via: hub`.
 */
export const approveFromHubWithin = Effect.fn("makitaApprovalFlow.approveFromHubWithin")(function* (
  sql: SqlClient.SqlClient,
  input: { readonly taskId: string; readonly actorUserId: UserId },
) {
  const [task] = yield* sql<{
    readonly configId: string;
    readonly spaceId: string;
    readonly repo: string;
    readonly number: number;
    readonly pendingJson: string | null;
  }>`
      SELECT config_id AS "configId", space_id AS "spaceId", repo, number,
        pending_push_json AS "pendingJson"
      FROM makita_tasks
      WHERE task_id = ${input.taskId} AND state NOT IN ('done', 'stopped', 'failed')
    `;
  const pending = decodePending(task?.pendingJson ?? null);
  if (task === undefined || Option.isNone(pending)) return "nothing-pending" as const;
  if (pending.value.approval !== undefined) return "already-approved" as const;
  const at = yield* nowIso;
  const approval: MakitaApproval = { via: "hub", at, login: null, commentId: null };
  const updated = yield* sql<{ readonly id: string }>`
      UPDATE makita_tasks SET pending_push_json = ${encodePending({ ...pending.value, approval })},
        approved_through = ${encodeApproval(approval)}, updated_at = ${at}
      WHERE task_id = ${input.taskId} AND pending_push_json = ${task.pendingJson}
      RETURNING task_id AS id
    `;
  if (updated.length === 0) return "nothing-pending" as const;
  yield* AuditLog.write(sql)({
    actor: AuditLog.userActor(input.actorUserId),
    action: "makita.task.approve",
    spaceId: SpaceId.make(task.spaceId),
    target: { kind: "makita_task", id: input.taskId, name: `${task.repo}#${task.number}` },
    detail: {
      space: task.spaceId,
      repo: task.repo,
      number: task.number,
      makita: task.configId,
      via: "hub",
      login: null,
      sha: pending.value.sha,
    },
  });
  return "approved" as const;
});

/** An approved push the Hub handled: sent, or refused and why. */
export interface MakitaReleased {
  readonly taskId: string;
  readonly threadId: string;
  readonly projectId: string;
  readonly configId: string;
  readonly spaceId: string;
  readonly repo: string;
  readonly number: number;
  readonly createdBy: string;
  readonly branch: string;
  readonly sha: string;
  readonly commits: number;
  readonly approval: MakitaApproval;
  /** Null when it reached GitHub; otherwise why not (the pending push is gone). */
  readonly refused: string | null;
}

interface ReleaseDeps {
  readonly sql: SqlClient.SqlClient;
  readonly github: GitHub;
  readonly machines: typeof MakitaMachines.Service;
  /** Whether the Hub's repository holds this commit. */
  readonly hasCommit: (gitDir: string, sha: string) => Effect.Effect<boolean, MakitaError>;
  /** The Thread's push lock: one push of a task at a time. */
  readonly locked: <A, E>(threadId: string, effect: Effect.Effect<A, E>) => Effect.Effect<A, E>;
}

/** GitHub failures worth another pass (anything else refuses the push). */
const TRANSIENT = new Set(["unreachable", "rate-limited"]);

/**
 * Sends every approved waiting push (for `MakitaPushes`): exactly the approved commit, under the
 * Thread's push lock, only while the task is live and may push, only where Makita left the branch
 * (or already there: a replay), never forced. Audited `makita.github.push` as the system.
 */
export const makeReleaseApproved = (deps: ReleaseDeps) => {
  const { sql, github } = deps;

  const releaseOne = Effect.fn("makitaApprovalFlow.releaseOne")(function* (taskId: string) {
    const [task] = yield* sql<{
      readonly taskId: string;
      readonly threadId: string;
      readonly projectId: string;
      readonly configId: string;
      readonly spaceId: string;
      readonly repo: string;
      readonly number: number;
      readonly state: string;
      readonly headSha: string | null;
      readonly pendingJson: string | null;
      readonly createdBy: string;
    }>`
      SELECT t.task_id AS "taskId", t.thread_id AS "threadId", t.project_id AS "projectId",
        t.config_id AS "configId", t.space_id AS "spaceId", t.repo, t.number, t.state,
        t.head_sha AS "headSha", t.pending_push_json AS "pendingJson", c.created_by AS "createdBy"
      FROM makita_tasks t JOIN makita_configs c ON c.config_id = t.config_id
      WHERE t.task_id = ${taskId}
    `;
    if (task === undefined || task.pendingJson === null || !LIVE.includes(task.state)) return;
    const pending = decodePending(task.pendingJson);
    if (Option.isNone(pending) || pending.value.approval === undefined) return;
    const { sha, branch, commits } = pending.value;
    const approval = pending.value.approval;
    const allowed = Effect.map(
      makitaTaskOfThread(sql, task.threadId),
      (found) =>
        Option.isSome(found) && found.value.halted === null && found.value.capability === "push",
    );
    // Paused, stopped or no longer pushing: nothing goes out (a stop clears it).
    if (!(yield* allowed)) return;
    const handled = (refused: string | null): MakitaReleased => ({
      taskId: task.taskId,
      threadId: task.threadId,
      projectId: task.projectId,
      configId: task.configId,
      spaceId: task.spaceId,
      repo: task.repo,
      number: task.number,
      createdBy: task.createdBy,
      branch,
      sha,
      commits,
      approval,
      refused,
    });
    const refuse = Effect.fn("makitaApprovalFlow.refuse")(function* (why: string) {
      const at = yield* nowIso;
      yield* sql`
        UPDATE makita_tasks SET pending_push_json = NULL, updated_at = ${at}
        WHERE task_id = ${task.taskId} AND pending_push_json = ${task.pendingJson}
      `;
      return handled(why);
    });
    const gitDir = yield* deps.machines.hubRepository(ProjectId.make(task.projectId));
    if (!(yield* deps.hasCommit(gitDir, sha))) {
      return yield* refuse("The approved commit is no longer on the Hub.");
    }
    const remote = yield* github.branchTip({ repo: task.repo, gitDir, branch }).pipe(Effect.result);
    if (remote._tag === "Failure") {
      if (TRANSIENT.has(remote.failure.reason)) return;
      return yield* refuse(`GitHub refused to show the branch: ${remote.failure.message}`);
    }
    // Already there: a pass that pushed and stopped before recording it.
    if (remote.success !== sha) {
      if (remote.success !== task.headSha) return yield* refuse(SOMEONE_ELSE);
      // A stop between the checks and here wins.
      if (!(yield* allowed)) return;
      const pushed = yield* github
        .pushBranch({ repo: task.repo, gitDir, sha, branch })
        .pipe(Effect.result);
      if (pushed._tag === "Failure") {
        if (TRANSIENT.has(pushed.failure.reason)) return;
        return yield* refuse(`GitHub refused the push: ${pushed.failure.message}`);
      }
      if (pushed.success === "rejected") return yield* refuse(SOMEONE_ELSE);
    }
    const done = yield* nowIso;
    // As `makita_push` (ticket 12): with its pull request open, CI is watched on the new head.
    yield* sql`
      UPDATE makita_tasks SET head_sha = ${sha}, last_push_at = ${done},
        pending_push_json = NULL, updated_at = ${done},
        ci_sha = CASE WHEN pr_number IS NULL THEN ci_sha ELSE ${sha} END,
        ci_state = CASE WHEN pr_number IS NULL THEN ci_state ELSE 'pending' END,
        ci_since = CASE WHEN pr_number IS NULL THEN ci_since ELSE ${done} END,
        ci_failing_json = CASE WHEN pr_number IS NULL THEN ci_failing_json ELSE NULL END,
        state = CASE WHEN pr_number IS NULL THEN state ELSE 'waiting-ci' END
      WHERE task_id = ${task.taskId}
    `;
    yield* AuditLog.write(sql)({
      actor: { source: "system" },
      action: "makita.github.push",
      spaceId: SpaceId.make(task.spaceId),
      target: { kind: "makita_task", id: task.taskId, name: `${task.repo}#${task.number}` },
      detail: {
        space: task.spaceId,
        repo: task.repo,
        number: task.number,
        makita: task.configId,
        branch,
        sha,
        commits,
      },
    }).pipe(
      // The push happened: it is still said; the missing entry is logged.
      Effect.catch((cause) =>
        Effect.logError("Makita could not audit an approved push", { taskId: task.taskId, cause }),
      ),
    );
    return handled(null);
  });

  return Effect.gen(function* () {
    const rows = yield* sql<{ readonly taskId: string; readonly threadId: string }>`
      SELECT task_id AS "taskId", thread_id AS "threadId" FROM makita_tasks
      WHERE host = ${MAKITA_GITHUB_HOST} AND pending_push_json IS NOT NULL
        AND state NOT IN ('done', 'stopped', 'failed')
    `;
    const handled: Array<MakitaReleased> = [];
    for (const row of rows) {
      const one = yield* deps.locked(row.threadId, releaseOne(row.taskId)).pipe(
        Effect.catch((cause) =>
          Effect.logError("Makita could not send an approved push", {
            taskId: row.taskId,
            cause,
          }).pipe(Effect.as(undefined)),
        ),
      );
      if (one !== undefined) handled.push(one);
    }
    return handled as ReadonlyArray<MakitaReleased>;
  }).pipe(
    Effect.catch((cause) =>
      Effect.logError("Makita could not read its approved pushes", { cause }).pipe(
        Effect.as([] as ReadonlyArray<MakitaReleased>),
      ),
    ),
  );
};

/**
 * After the Hub handled an approved push: one short line on the issue (what was pushed, and by
 * whose approval) and the task's Thread told, queued after any turn, as the creator.
 */
export const tellReleased = Effect.fn("makitaApprovalFlow.tellReleased")(function* (
  sql: SqlClient.SqlClient,
  github: GitHub,
  threads: typeof ThreadManagementService.ThreadManagementService.Service,
  released: MakitaReleased,
) {
  const by = released.approval.login === null ? "a maintainer" : `@${released.approval.login}`;
  const short = released.sha.slice(0, 12);
  const line =
    released.refused === null
      ? `Pushed \`${released.branch}\` (${short}, ${plural(released.commits, "commit")}), approved by ${by}.`
      : `Could not push \`${released.branch}\` after the approval: ${released.refused}`;
  yield* postAsHub(sql, github, released, line).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Makita could not say an approved push went out", {
        taskId: released.taskId,
        reason: "reason" in error ? error.reason : "storage",
      }),
    ),
  );
  const text =
    released.refused === null
      ? `An approver released your waiting push: ${released.branch} is at ${short} on GitHub (${plural(released.commits, "commit")}). Carry on with your task; a push after a new instruction from someone who is not an approver waits again.`
      : `Your approved push to ${released.branch} did not go out: ${released.refused} Commit on top of what Makita pushed last and call makita_push again.`;
  const sent = yield* threads
    .sendToThread({
      projectId: ProjectId.make(released.projectId),
      commandId: CommandId.make(`makita-approved:${released.taskId}:${released.sha}`),
      threadId: ThreadId.make(released.threadId),
      messageId: MessageId.make(`makita-approved-message:${released.taskId}:${released.sha}`),
      text,
      attachments: [],
      mode: "queue",
      createdBy: "system",
      creationSource: "server",
    })
    .pipe(
      CommandActor.actAsResolved({ _tag: "User", userId: UserId.make(released.createdBy) }),
      Effect.exit,
    );
  if (sent._tag === "Failure") {
    yield* Effect.logWarning("Makita could not tell a Thread its push went out", {
      taskId: released.taskId,
    });
  }
});
