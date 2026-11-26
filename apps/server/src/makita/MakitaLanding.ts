// @effect-diagnostics globalJsonInEffect:off - GitHub's answers are read with Schema.
/**
 * Makita ticket 13: landing a task's pull request when an approver orders it. `land` is the Hub
 * operation the spec calls `makita_merge`: no MCP tool or RPC merges by itself. Its two callers are
 * a queued `/makita merge` comment and `makita_request_merge`, which only points at a comment.
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
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as AuditLog from "../audit/AuditLog.ts";
import * as CommandActor from "../auth/CommandActor.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { linkedUserOf } from "./GitHubIdentities.ts";
import { isApproverNow, liveTaskOfItem } from "./makitaApprovers.ts";
import { allowedCallerIds } from "./makitaCallers.ts";
import { ciVerdictOf } from "./makitaCi.ts";
import { commentOfKey, commentPath, decodeOneComment, mentions } from "./makitaFeeds.ts";
import { MakitaGitHub, type MakitaGitHubError } from "./MakitaGitHub.ts";
import {
  isMergeOrder,
  type MakitaLandRefusal,
  MERGE_DETAIL,
  type MergeRequestKind,
  mergeabilityOf,
  mergedText,
  ONLY_APPROVERS,
  orderUrlOf,
  refusalText,
  requestKeysOf,
  touchesWorkflows,
} from "./makitaLandingRules.ts";

const LIVE = ["awaiting-approval", "running", "waiting-ci", "waiting-reply"];
/** Makita's comments in a row without a person, and per issue in 24 hours (the loop guard). */
const MAX_REPLIES_IN_A_ROW = 5;
const MAX_REPLIES_PER_DAY = 30;
const DAY_MS = 24 * 60 * 60 * 1_000;
/** An order GitHub keeps failing to give back is dropped after this long. */
const GIVE_UP_MS = 30 * 60 * 1_000;
/** GitHub lists at most 3 000 files of a pull request, 100 a page. */
const FILES_PAGE = 100;
const MAX_FILE_PAGES = 30;
/** While GitHub still computes mergeability, read the pull request again this often. */
const MERGEABLE_RETRIES = 3;
const TRANSIENT = new Set(["unreachable", "rate-limited"]);

const PullRequest = Schema.Struct({
  number: Schema.Number,
  state: Schema.String,
  user: Schema.optional(Schema.NullOr(Schema.Struct({ id: Schema.Number }))),
  head: Schema.Struct({ ref: Schema.String, sha: Schema.String }),
  base: Schema.Struct({ ref: Schema.String }),
  mergeable: Schema.optional(Schema.NullOr(Schema.Boolean)),
  mergeable_state: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodePullRequest = Schema.decodeUnknownOption(Schema.fromJsonString(PullRequest));
const Repository = Schema.Struct({
  default_branch: Schema.String,
  allow_merge_commit: Schema.optional(Schema.Boolean),
  allow_squash_merge: Schema.optional(Schema.Boolean),
});
const decodeRepository = Schema.decodeUnknownOption(Schema.fromJsonString(Repository));
const PullFile = Schema.Struct({
  filename: Schema.String,
  previous_filename: Schema.optional(Schema.String),
});
const decodeFiles = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(PullFile)));
const decodeMerged = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ sha: Schema.String })),
);

/** What `makita_request_merge` answers the agent. */
export interface MakitaMergeRequestResult {
  readonly merged: boolean;
  readonly message: string;
  /** The commit GitHub made on the base, once merged. */
  readonly sha: string | null;
}

export class MakitaLanding extends Context.Service<
  MakitaLanding,
  {
    /** Each queued `/makita merge`, read again and decided once. Runs after the tasks pass. */
    readonly landQueued: Effect.Effect<void>;
    /** `makita_request_merge`: the calling Thread's task, an approver's comment it points at. */
    readonly requestForThread: (
      threadId: ThreadId,
      input: { readonly commentId: number; readonly kind: MergeRequestKind },
    ) => Effect.Effect<MakitaMergeRequestResult, MakitaError>;
  }
>()("t3/makita/MakitaLanding") {}

interface LandTask {
  readonly taskId: string;
  readonly configId: string;
  readonly spaceId: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly repo: string;
  readonly number: number;
  readonly state: string;
  readonly branch: string | null;
  readonly baseBranch: string | null;
  readonly headSha: string | null;
  readonly lastPushAt: string | null;
  readonly prNumber: number | null;
  readonly createdBy: string;
  readonly capability: string;
  readonly mayLand: number;
  readonly configPausedAt: string | null;
  readonly configDeletedAt: string | null;
  readonly callersMode: string;
  readonly callersJson: string;
}

const TASK_COLUMNS = `t.task_id AS "taskId", t.config_id AS "configId", t.space_id AS "spaceId",
  t.project_id AS "projectId", t.thread_id AS "threadId", t.repo, t.number, t.state, t.branch,
  t.base_branch AS "baseBranch", t.head_sha AS "headSha", t.last_push_at AS "lastPushAt",
  t.pr_number AS "prNumber", c.created_by AS "createdBy", c.capability, c.may_land AS "mayLand",
  c.paused_at AS "configPausedAt", c.deleted_at AS "configDeletedAt",
  c.callers_mode AS "callersMode", c.callers_json AS "callersJson"`;

/** An approver's order, as `land` acts on it. */
interface MergeOrder {
  /** The `makita_events` row that records it: the command's own, or the request's mark. */
  readonly eventKey: string;
  readonly commentId: number;
  /** The issue or pull request it was written on: refusals are said there. */
  readonly on: number;
  readonly url: string;
  readonly createdAt: string;
  readonly author: { readonly id: number; readonly login: string };
  readonly via: "command" | "request";
}

/** Why nothing is said or done: Makita, the configuration or the task stopped. */
type Halt = "makita-paused" | "config-paused" | "task-ended" | "stop-queued";

type LandResult =
  | { readonly _tag: "merged"; readonly sha: string; readonly base: string }
  | { readonly _tag: "refused"; readonly refusal: MakitaLandRefusal }
  | { readonly _tag: "halted"; readonly halt: Halt };

const millisOf = (iso: string | null) => {
  if (iso === null) return undefined;
  const parsed = DateTime.make(iso);
  return Option.isSome(parsed) ? DateTime.toEpochMillis(parsed.value) : undefined;
};

const fail = (reason: MakitaError["reason"], message: string) =>
  Effect.fail(new MakitaError({ reason, message }));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const github = yield* MakitaGitHub;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  /** One landing of a task at a time: a command and a request never race. */
  const locks = new Map<string, Semaphore.Semaphore>();
  const lockOf = (taskId: string) => {
    const existing = locks.get(taskId);
    if (existing !== undefined) return existing;
    const made = Semaphore.makeUnsafe(1);
    locks.set(taskId, made);
    return made;
  };

  const account = sql<{
    readonly id: number;
    readonly login: string;
    readonly paused: string | null;
  }>`
    SELECT github_user_id AS id, login, global_paused_at AS paused
    FROM makita_account WHERE account_id = 'makita'
  `.pipe(Effect.map((rows) => Option.fromUndefinedOr(rows[0])));

  const readTask = (where: { readonly taskId: string } | { readonly threadId: string }) =>
    ("taskId" in where
      ? sql<LandTask>`
          SELECT ${sql.literal(TASK_COLUMNS)}
          FROM makita_tasks t JOIN makita_configs c ON c.config_id = t.config_id
          WHERE t.task_id = ${where.taskId}
        `
      : sql<LandTask>`
          SELECT ${sql.literal(TASK_COLUMNS)}
          FROM makita_tasks t JOIN makita_configs c ON c.config_id = t.config_id
          WHERE t.thread_id = ${where.threadId}
        `
    ).pipe(Effect.map((rows) => rows[0]));

  /**
   * Whether the task may still land now, read again: anything stopped wins over any order, and a
   * `/makita stop` already queued for its issue or pull request counts as a stop.
   */
  const stillMay = Effect.fn("MakitaLanding.stillMay")(function* (taskId: string) {
    const task = yield* readTask({ taskId });
    if (task === undefined) return { halt: "task-ended" as Halt };
    const bot = yield* account;
    if (Option.isNone(bot) || bot.value.paused !== null) return { halt: "makita-paused" as Halt };
    if (task.configPausedAt !== null || task.configDeletedAt !== null) {
      return { halt: "config-paused" as Halt };
    }
    if (!LIVE.includes(task.state)) return { halt: "task-ended" as Halt };
    const numbers = task.prNumber === null ? [task.number] : [task.number, task.prNumber];
    const stops = yield* sql<{ readonly key: string }>`
      SELECT event_key AS key FROM makita_events
      WHERE outcome = 'queued' AND detail = 'stop' AND host = ${MAKITA_GITHUB_HOST}
        AND repo = ${task.repo} AND ${sql.in("number", numbers)}
    `;
    if (stops.length > 0) return { halt: "stop-queued" as Halt };
    return { halt: null, task, bot: bot.value };
  });

  /** A comment by the Hub on the task's issue or pull request, through the loop guard. */
  const say = Effect.fn("MakitaLanding.say")(function* (task: LandTask, on: number, text: string) {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const [today] = yield* sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM audit_log
      WHERE action = 'makita.github.comment' AND target_kind = 'makita_task'
        AND target_id = ${task.taskId}
        AND at >= ${DateTime.formatIso(DateTime.makeUnsafe(now - DAY_MS))}
    `;
    const [current] = yield* sql<{ readonly replies: number }>`
      SELECT replies_without_person AS replies FROM makita_tasks WHERE task_id = ${task.taskId}
    `;
    if ((today?.n ?? 0) >= MAX_REPLIES_PER_DAY || (current?.replies ?? 0) >= MAX_REPLIES_IN_A_ROW) {
      return false;
    }
    yield* github.rest({
      operation: "issue-comment",
      method: "POST",
      path: `repos/${task.repo}/issues/${on}/comments`,
      body: { body: text },
    });
    yield* sql`
      UPDATE makita_tasks SET replies_without_person = replies_without_person + 1,
        updated_at = ${yield* nowIso}
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
        number: on,
        makita: task.configId,
        by: "hub",
      },
    });
    return true;
  });

  const sayQuietly = (task: LandTask, on: number, text: string) =>
    say(task, on, text).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Makita could not say how a merge order ended", {
          taskId: task.taskId,
          reason: "reason" in error ? error.reason : "storage",
        }),
      ),
    );

  /** A person's valid order: the loop guard counts from zero again, as `/makita ok` does. */
  const personSpoke = (taskId: string) =>
    Effect.flatMap(
      nowIso,
      (at) => sql`
        UPDATE makita_tasks SET replies_without_person = 0, updated_at = ${at}
        WHERE task_id = ${taskId}
      `,
    );

  /** The order's event: `land` with how it ended (`merged` or the refusal's code). */
  const finishOrder = (eventKey: string, detail: string, taskId: string) => sql`
    UPDATE makita_events SET outcome = 'land', detail = ${detail}, task_id = ${taskId}
    WHERE event_key = ${eventKey} AND outcome IN ('queued', 'land')
  `;

  const asRefusal = (error: MakitaGitHubError): LandResult => ({
    _tag: "refused",
    refusal: { code: "github", message: error.message },
  });

  /** Every file of the pull request, or undefined at GitHub's cap (it cannot all be read). */
  const filesOf = Effect.fn("MakitaLanding.filesOf")(function* (repo: string, pr: number) {
    const files: Array<typeof PullFile.Type> = [];
    for (let page = 1; page <= MAX_FILE_PAGES; page++) {
      const answer = yield* github.rest({
        operation: "pull-request-files",
        path: `repos/${repo}/pulls/${pr}/files?per_page=${FILES_PAGE}&page=${page}`,
      });
      const listed = Option.getOrElse(decodeFiles(answer.body), () => []);
      files.push(...listed);
      if (listed.length < FILES_PAGE) return files as ReadonlyArray<typeof PullFile.Type>;
    }
    return undefined;
  });

  /** The pull request now, read again while GitHub still computes whether it merges. */
  const pullRequestNow = Effect.fn("MakitaLanding.pullRequestNow")(function* (
    repo: string,
    pr: number,
    settled: boolean,
  ) {
    for (let attempt = 0; ; attempt++) {
      const answer = yield* github.rest({
        operation: "pull-request-read",
        path: `repos/${repo}/pulls/${pr}`,
      });
      const read = decodePullRequest(answer.body);
      if (
        !settled ||
        Option.isNone(read) ||
        mergeabilityOf(read.value) !== "computing" ||
        attempt >= MERGEABLE_RETRIES
      ) {
        return read;
      }
      yield* Effect.sleep("2 seconds");
    }
  });

  /**
   * `makita_merge`: the spec's checks in its order, each read from GitHub now, then the merge with
   * the checked head (GitHub refuses a moved one), recorded and audited in one transaction.
   */
  const landNow = Effect.fn("MakitaLanding.landNow")(function* (taskId: string, order: MergeOrder) {
    const halted = (halt: Halt): LandResult => ({ _tag: "halted", halt });
    const refused = (refusal: MakitaLandRefusal): LandResult => ({ _tag: "refused", refusal });
    // 1. Nothing stopped; may land; its own open pull request from its branch into its base.
    const first = yield* stillMay(taskId);
    if (first.halt !== null) return halted(first.halt);
    const { task, bot } = first;
    if (task.capability !== "push" || task.mayLand !== 1) return refused({ code: "landing-off" });
    if (task.prNumber === null || task.branch === null || task.headSha === null) {
      return refused({ code: "no-pull-request" });
    }
    const prNumber = task.prNumber;
    const headSha = task.headSha;
    const repository = yield* github
      .rest({ operation: "repository-read", path: `repos/${task.repo}` })
      .pipe(
        Effect.map((answer) => decodeRepository(answer.body)),
        Effect.result,
      );
    if (repository._tag === "Failure") return asRefusal(repository.failure);
    if (Option.isNone(repository.success)) {
      return refused({
        code: "github",
        message: "its answer about the repository was unreadable.",
      });
    }
    const repo = repository.success.value;
    const base = task.baseBranch ?? repo.default_branch;
    const read = yield* pullRequestNow(task.repo, prNumber, false).pipe(Effect.result);
    if (read._tag === "Failure") return asRefusal(read.failure);
    if (Option.isNone(read.success) || read.success.value.state !== "open") {
      return refused({ code: "no-pull-request" });
    }
    const pr = read.success.value;
    if (
      pr.user?.id !== bot.id ||
      pr.head.ref !== task.branch ||
      !task.branch.startsWith("makita/")
    ) {
      return refused({ code: "not-makitas" });
    }
    if (pr.base.ref !== base) return refused({ code: "other-base", base });
    // 2. The head is what Makita pushed, and the order came after that push.
    if (pr.head.sha !== headSha) return refused({ code: "someone-pushed" });
    const ordered = millisOf(order.createdAt);
    const pushed = millisOf(task.lastPushAt);
    if (ordered === undefined || pushed === undefined || ordered <= pushed) {
      return refused({ code: "pushed-after-order", sha: headSha });
    }
    // 3. GREEN on that exact commit.
    const ci = yield* Effect.all([
      github.rest({
        operation: "ci-check-runs",
        path: `repos/${task.repo}/commits/${headSha}/check-runs?per_page=100`,
      }),
      github.rest({
        operation: "ci-status",
        path: `repos/${task.repo}/commits/${headSha}/status?per_page=100`,
      }),
    ]).pipe(
      Effect.map(([runs, status]) => ciVerdictOf(runs.body, status.body)),
      Effect.result,
    );
    if (ci._tag === "Failure") return asRefusal(ci.failure);
    const verdict = Option.getOrUndefined(ci.success)?.verdict ?? "none";
    if (verdict === "pending") return refused({ code: "ci-pending", sha: headSha });
    if (verdict === "red") return refused({ code: "ci-red", sha: headSha });
    if (verdict === "none") return refused({ code: "no-ci", sha: headSha });
    // 4. GitHub says it merges cleanly.
    const settled = yield* pullRequestNow(task.repo, prNumber, true).pipe(Effect.result);
    if (settled._tag === "Failure") return asRefusal(settled.failure);
    if (Option.isNone(settled.success)) return refused({ code: "no-pull-request" });
    if (settled.success.value.head.sha !== headSha) return refused({ code: "someone-pushed" });
    const mergeable = mergeabilityOf(settled.success.value);
    if (mergeable !== "clean") {
      return refused({
        code: "not-mergeable",
        state: mergeable === "computing" ? "unknown" : mergeable,
      });
    }
    // 5. No workflow file anywhere in the pull request.
    const files = yield* filesOf(task.repo, prNumber).pipe(Effect.result);
    if (files._tag === "Failure") return asRefusal(files.failure);
    if (files.success === undefined) return refused({ code: "too-many-files" });
    if (touchesWorkflows(files.success)) return refused({ code: "workflows" });
    const method =
      repo.allow_merge_commit !== false
        ? "merge"
        : repo.allow_squash_merge === true
          ? "squash"
          : undefined;
    if (method === undefined) return refused({ code: "rebase-only" });
    // 6. A stop since the first check wins, right before the write.
    const last = yield* stillMay(taskId);
    if (last.halt !== null) return halted(last.halt);
    if (last.task.capability !== "push" || last.task.mayLand !== 1) {
      return refused({ code: "landing-off" });
    }
    // 7. The merge, of exactly the checked head; never a push to the base.
    const mergeWith = (mergeMethod: "merge" | "squash") =>
      github
        .rest({
          operation: "pull-request-merge",
          method: "PUT",
          path: `repos/${task.repo}/pulls/${prNumber}/merge`,
          body: { sha: headSha, merge_method: mergeMethod },
        })
        .pipe(Effect.result);
    let merged = yield* mergeWith(method);
    // GitHub shows merge settings only to some tokens: when unknown, a refused merge commit squashes.
    if (
      merged._tag === "Failure" &&
      method === "merge" &&
      repo.allow_merge_commit === undefined &&
      repo.allow_squash_merge !== false &&
      merged.failure.status === 405
    ) {
      merged = yield* mergeWith("squash");
    }
    if (merged._tag === "Failure") return asRefusal(merged.failure);
    const landed = Option.getOrUndefined(decodeMerged(merged.success.body))?.sha ?? headSha;
    // 8. Recorded with who ordered it; the audit names the approver's public login and id.
    const linked = yield* linkedUserOf(sql, order.author.id);
    const at = yield* nowIso;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          UPDATE makita_tasks SET state = 'done', landed_sha = ${landed},
            pending_push_json = NULL, updated_at = ${at}
          WHERE task_id = ${task.taskId}
        `;
        yield* finishOrder(order.eventKey, "merged", task.taskId);
        yield* AuditLog.write(sql)({
          actor: { source: "system" },
          action: "makita.github.merge",
          spaceId: SpaceId.make(task.spaceId),
          target: { kind: "makita_task", id: task.taskId, name: `${task.repo}#${task.number}` },
          detail: {
            space: task.spaceId,
            repo: task.repo,
            number: task.number,
            makita: task.configId,
            pr: prNumber,
            base,
            sha: headSha,
            landedSha: landed,
            defaultBranch: base === repo.default_branch,
            orderedBy: order.author.login,
            orderedById: order.author.id,
            orderedByUser: Option.getOrNull(linked),
            orderComment: order.commentId,
            via: order.via,
          },
        });
      }),
    );
    return { _tag: "merged", sha: landed, base } satisfies LandResult;
  });

  /** After a landing: the branch deleted (best effort) and one line on the pull request. */
  const afterMerge = Effect.fn("MakitaLanding.afterMerge")(function* (
    taskId: string,
    order: MergeOrder,
    result: { readonly sha: string; readonly base: string },
  ) {
    const task = yield* readTask({ taskId });
    if (task === undefined) return;
    if (task.branch !== null && task.branch.startsWith("makita/")) {
      yield* github
        .rest({
          operation: "branch-delete",
          method: "DELETE",
          path: `repos/${task.repo}/git/refs/heads/${task.branch}`,
        })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("Makita could not delete its merged branch", {
              taskId,
              reason: error.reason,
            }),
          ),
        );
    }
    yield* sayQuietly(
      task,
      task.prNumber ?? order.on,
      mergedText({
        base: result.base,
        approver: order.author.login,
        orderUrl: order.url,
        sha: result.sha,
      }),
    );
  });

  const land = (taskId: string, order: MergeOrder) =>
    lockOf(taskId).withPermits(1)(
      Effect.gen(function* () {
        const result = yield* landNow(taskId, order);
        if (result._tag === "merged") yield* afterMerge(taskId, order, result);
        return result;
      }),
    );

  /** A refused command: its Thread hears it once, queued after any turn. */
  const tellRefused = Effect.fn("MakitaLanding.tellRefused")(function* (
    task: LandTask,
    order: MergeOrder,
    refusal: MakitaLandRefusal,
  ) {
    const sent = yield* threads
      .sendToThread({
        projectId: ProjectId.make(task.projectId),
        commandId: CommandId.make(`makita-land:${order.eventKey}`),
        threadId: ThreadId.make(task.threadId),
        messageId: MessageId.make(`makita-land-message:${order.eventKey}`),
        text: `Approver ${order.author.login} ordered a merge of your pull request on GitHub; the Hub did not merge it: ${refusalText(refusal)} Makita said so on GitHub. Do not try to merge another way; carry on only with what a person asks.`,
        attachments: [],
        mode: "queue",
        createdBy: "system",
        creationSource: "server",
      })
      .pipe(
        CommandActor.actAsResolved({ _tag: "User", userId: UserId.make(task.createdBy) }),
        Effect.exit,
      );
    if (sent._tag === "Failure") {
      yield* Effect.logWarning("Makita could not tell a Thread a merge was refused", {
        taskId: task.taskId,
      });
    }
  });

  /** A queued `/makita merge`, as `landQueued` reads it. */
  interface MergeEvent {
    readonly eventKey: string;
    readonly repo: string;
    readonly actorId: number;
    readonly configId: string;
    readonly seenAt: string;
  }

  /**
   * One queued `/makita merge`, decided once: read again by id (unedited, by the author the intake
   * saw, still the command, not Makita), then nothing while anything is stopped, then an approver
   * now (an allowed caller who is not one hears so; anyone else, silence), then `land`.
   */
  const orderFromCommand = Effect.fn("MakitaLanding.orderFromCommand")(function* (row: MergeEvent) {
    const finish = (outcome: string, detail: string | null, taskId: string | null = null) => sql`
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
      const seen = millisOf(row.seenAt);
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      if (!TRANSIENT.has(read.failure.reason) || seen === undefined || now - seen > GIVE_UP_MS) {
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
    const bot = yield* account;
    if (Option.isNone(bot) || bot.value.paused !== null) {
      return yield* finish("ignored-paused", "makita-paused");
    }
    if (author.id === bot.value.id) return yield* finish("ignored-self", null);
    const live = yield* liveTaskOfItem(sql, row.repo, comment.number);
    if (live === undefined || live.configId !== row.configId) {
      return yield* finish("command", "nothing-to-merge");
    }
    const task = yield* readTask({ taskId: live.taskId });
    if (task === undefined) return yield* finish("command", "nothing-to-merge");
    // Still the order itself: `/makita merge`, or its plain words (ticket 29).
    if (
      !isMergeOrder(comment.body, {
        login: bot.value.login,
        onOwnPull: comment.number === task.prNumber,
      })
    ) {
      return yield* finish("ignored-edited", null);
    }
    if (task.configPausedAt !== null || task.configDeletedAt !== null) {
      return yield* finish("ignored-paused", "config-paused", task.taskId);
    }
    if (!(yield* isApproverNow(sql, task.configId, author.id))) {
      const callers = (yield* allowedCallerIds(sql, [task])).get(task.configId);
      if (callers?.has(author.id) !== true) {
        return yield* finish("ignored-not-allowed", "merge", task.taskId);
      }
      yield* finish("ignored-not-approver", "merge", task.taskId);
      return yield* sayQuietly(task, comment.number, ONLY_APPROVERS);
    }
    yield* personSpoke(task.taskId);
    const order: MergeOrder = {
      eventKey: row.eventKey,
      commentId: comment.id,
      on: comment.number,
      url: orderUrlOf({ repo: row.repo, on: comment.number, id: comment.id, feed: ref.feed }),
      createdAt: comment.createdAt,
      author: { id: author.id, login: author.login },
      via: "command",
    };
    const result = yield* land(task.taskId, order);
    switch (result._tag) {
      case "merged":
        return;
      case "halted":
        return yield* finish("ignored-paused", result.halt, task.taskId);
      case "refused":
        yield* finishOrder(row.eventKey, result.refusal.code, task.taskId);
        if (result.refusal.code !== "landing-off") yield* tellRefused(task, order, result.refusal);
        return yield* sayQuietly(task, comment.number, refusalText(result.refusal));
    }
  });

  const landQueued = Effect.gen(function* () {
    const rows = yield* sql<MergeEvent>`
      SELECT event_key AS "eventKey", repo, actor_github_id AS "actorId",
        config_id AS "configId", seen_at AS "seenAt"
      FROM makita_events
      WHERE outcome = 'queued' AND detail = ${MERGE_DETAIL} AND config_id IS NOT NULL
        AND actor_github_id IS NOT NULL
      ORDER BY seen_at, rowid LIMIT 20
    `;
    for (const row of rows) {
      yield* orderFromCommand(row).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Makita could not handle a merge order", {
            eventKey: row.eventKey,
            cause,
          }),
        ),
      );
    }
  }).pipe(
    Effect.catch((cause) => Effect.logError("Makita could not read its merge orders", { cause })),
    Effect.withSpan("MakitaLanding.landQueued"),
  );

  const storage = (what: string) => (cause: unknown) =>
    Effect.logError(`MakitaLanding: could not ${what}`, { cause }).pipe(
      Effect.andThen(fail("storage", `Could not ${what}. Try again.`)),
    );
  const notMerged = (message: string): MakitaMergeRequestResult => ({
    merged: false,
    message,
    sha: null,
  });

  /**
   * `makita_request_merge`: nothing of the call is trusted but the comment's id. The comment is
   * read again on GitHub and must be an approver's, unedited, after the last push, on the task's
   * pull request (or a mention on its issue), the one that woke the current turn, and unused.
   */
  const request = Effect.fn("MakitaLanding.request")(function* (
    threadId: ThreadId,
    input: { readonly commentId: number; readonly kind: MergeRequestKind },
  ) {
    const found = yield* readTask({ threadId });
    if (found === undefined) return yield* fail("forbidden", "This Thread is not a Makita task's.");
    const may = yield* stillMay(found.taskId);
    if (may.halt !== null) {
      return yield* fail(
        "forbidden",
        may.halt === "task-ended"
          ? "This Makita task has ended."
          : "Makita is stopped for this work.",
      );
    }
    const { task, bot } = may;
    if (task.capability !== "push" || task.mayLand !== 1) {
      return yield* fail("forbidden", "This Makita configuration may not land pull requests.");
    }
    if (task.prNumber === null || task.lastPushAt === null) {
      return notMerged("Your task has no pull request to merge yet.");
    }
    if (input.kind === "review") {
      return notMerged(
        "A review cannot order a merge: GitHub keeps no record of whether its text was edited. The approver can say it in a comment (or write /makita merge).",
      );
    }
    if (!Number.isSafeInteger(input.commentId) || input.commentId <= 0) {
      return notMerged("That is not a comment id.");
    }
    const feed = input.kind === "issue-comment" ? "issue-comments" : "review-comments";
    const read = yield* github
      .rest({ operation: "comment-read", path: commentPath(task.repo, feed, input.commentId) })
      .pipe(Effect.result);
    if (read._tag === "Failure") {
      return read.failure.reason === "not-found"
        ? notMerged("There is no such comment in your task's repository.")
        : yield* fail("github", `Could not read the comment on GitHub: ${read.failure.message}`);
    }
    const comment = decodeOneComment(feed, read.success.body);
    if (comment === undefined) return notMerged("That is not a comment Makita can read.");
    const onPull = comment.number === task.prNumber;
    const mentionOnIssue =
      comment.number === task.number &&
      input.kind === "issue-comment" &&
      mentions(comment.body, bot.login);
    if (!onPull && !mentionOnIssue) {
      return notMerged(
        "That comment is neither on your pull request nor a mention of Makita on your issue.",
      );
    }
    const author = comment.author;
    if (author === null || author.id === bot.id) {
      return notMerged("That comment is not a person's: it cannot order a merge.");
    }
    if (comment.updatedAt !== comment.createdAt) {
      return notMerged("That comment was edited: an edited comment never orders a merge.");
    }
    const ordered = millisOf(comment.createdAt);
    const pushed = millisOf(task.lastPushAt);
    if (ordered === undefined || pushed === undefined || ordered <= pushed) {
      return notMerged(
        "That comment was written before your last push: only an order given after it counts.",
      );
    }
    if (!(yield* isApproverNow(sql, task.configId, author.id))) {
      return notMerged("Only an approver's comment can order a merge, and its author is not one.");
    }
    const keys = requestKeysOf(input.kind, input.commentId);
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
      return notMerged(
        "That comment did not wake your current turn: only the comment that woke you can order a merge.",
      );
    }
    // One comment, one attempt: marked before anything reaches GitHub.
    const marked = yield* sql<{ readonly key: string }>`
      INSERT INTO makita_events (event_key, host, repo, number, kind, actor_github_id,
        actor_login, created_at_github, seen_at, config_id, outcome, detail, task_id)
      VALUES (${keys.used}, ${MAKITA_GITHUB_HOST}, ${task.repo}, ${comment.number},
        ${onPull ? "pull" : "issue"}, ${author.id}, ${author.login}, ${comment.createdAt},
        ${yield* nowIso}, ${task.configId}, 'land', 'requested', ${task.taskId})
      ON CONFLICT (event_key) DO NOTHING
      RETURNING event_key AS key
    `;
    if (marked.length === 0) {
      return notMerged("That comment was already used for a merge request.");
    }
    yield* personSpoke(task.taskId);
    const order: MergeOrder = {
      eventKey: keys.used,
      commentId: comment.id,
      on: comment.number,
      url: orderUrlOf({ repo: task.repo, on: comment.number, id: comment.id, feed }),
      createdAt: comment.createdAt,
      author: { id: author.id, login: author.login },
      via: "request",
    };
    const result = yield* land(task.taskId, order);
    switch (result._tag) {
      case "merged":
        return {
          merged: true,
          message: `Merged pull request #${task.prNumber} into ${result.base} (${result.sha.slice(0, 12)}), ordered by @${author.login}. Your task is done; stop here.`,
          sha: result.sha,
        } satisfies MakitaMergeRequestResult;
      case "halted":
        yield* finishOrder(keys.used, result.halt, task.taskId);
        return yield* fail("forbidden", "Makita is stopped for this work.");
      case "refused":
        yield* finishOrder(keys.used, result.refusal.code, task.taskId);
        yield* sayQuietly(task, comment.number, refusalText(result.refusal));
        return notMerged(
          `The Hub did not merge: ${refusalText(result.refusal)} Makita said so on GitHub. Do not try to merge another way; wait for a person.`,
        );
    }
  });

  const requestForThread = (
    threadId: ThreadId,
    input: { readonly commentId: number; readonly kind: MergeRequestKind },
  ) =>
    request(threadId, input).pipe(
      Effect.catchIf((cause) => cause._tag !== "MakitaError", storage("handle the merge request")),
    );

  return MakitaLanding.of({ landQueued, requestForThread });
});

/** Over Makita's GitHub client, the database and the Thread commands. */
export const layer = Layer.effect(MakitaLanding, make);
