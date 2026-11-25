// @effect-diagnostics globalJsonInEffect:off - GitHub's answers are read with Schema.
/**
 * Makita ticket 27: Makita's own pull requests closed by the Hub, never by the agent: those idle
 * for the days its configuration says, and, at once, one an approver labels as bad work. Both
 * delete its `makita/…` branch and end its task. Also runs ticket 26's `/makita reopen`.
 */
import { MAKITA_GITHUB_HOST, SpaceId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as AuditLog from "../audit/AuditLog.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import { isApproverNow } from "./makitaApprovers.ts";
import { storedAutonomyOf } from "./makitaAutonomy.ts";
import { BAD_WORK } from "./makitaAutonomyRows.ts";
import { MakitaGitHub } from "./MakitaGitHub.ts";
import { MakitaIntake } from "./MakitaIntake.ts";
import { MakitaIssueCloses } from "./MakitaIssueCloses.ts";
import { stopTasksWithin } from "./makitaRows.ts";

const DAY_MS = 24 * 60 * 60 * 1_000;
/** The idle sweep runs at most this often; a bad-work label is acted on every tick. */
const SWEEP_EVERY_MS = 10 * 60 * 1_000;
const SWEEP_BATCH = 20;
/** A label GitHub keeps failing to answer about is dropped after this long. */
const GIVE_UP_MS = 30 * 60 * 1_000;
const TRANSIENT = new Set(["unreachable", "rate-limited"]);

const PullRequest = Schema.Struct({
  number: Schema.Number,
  state: Schema.String,
  updated_at: Schema.optional(Schema.String),
  user: Schema.optional(Schema.NullOr(Schema.Struct({ id: Schema.Number }))),
  head: Schema.Struct({ ref: Schema.String }),
});
const decodePullRequest = Schema.decodeUnknownOption(Schema.fromJsonString(PullRequest));

/** What closing one of Makita's pull requests needs of its task. */
interface PullTask {
  readonly taskId: string;
  readonly configId: string;
  readonly spaceId: string;
  readonly repo: string;
  readonly number: number;
  readonly state: string;
  readonly branch: string | null;
  readonly prNumber: number;
  readonly pending: string | null;
}

const TASK_COLUMNS = `task_id AS "taskId", config_id AS "configId", space_id AS "spaceId", repo,
  number, state, branch, pr_number AS "prNumber", pending_push_json AS "pending"`;

export class MakitaCleanup extends Context.Service<
  MakitaCleanup,
  {
    /** Each bad-work label the intake accepted: an approver's closes its pull request now. */
    readonly badWorkQueued: Effect.Effect<void>;
    /** Makita's pull requests idle for their configuration's days, closed (every 10 minutes). */
    readonly sweepIdle: Effect.Effect<void>;
  }
>()("t3/makita/MakitaCleanup") {}

const millisOf = (value: string | null | undefined) => {
  if (value === null || value === undefined) return undefined;
  const parsed = DateTime.make(value);
  return Option.isSome(parsed) ? DateTime.toEpochMillis(parsed.value) : undefined;
};

/** The idle notice on the pull request: why, and that reopening is fine. */
export const idleCloseText = (days: number) =>
  `Closing this pull request: nothing happened here for ${days} days. Reopening it is fine (restore its branch first); Makita will not close it again.`;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const github = yield* MakitaGitHub;
  const spaces = yield* SpaceDirectory.SpaceDirectory;
  const intake = yield* MakitaIntake;
  const lastSweep = yield* Ref.make(0);
  const nowMillis = Effect.map(DateTime.now, DateTime.toEpochMillis);
  const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

  const account = sql<{
    readonly id: number;
    readonly status: string;
    readonly paused: string | null;
  }>`
    SELECT github_user_id AS id, status, global_paused_at AS paused
    FROM makita_account WHERE account_id = 'makita'
  `.pipe(Effect.map((rows) => rows[0]));

  /** Its pull request as GitHub has it now, with GitHub's own clock (`Date`). */
  const pullOf = Effect.fn("MakitaCleanup.pullOf")(function* (repo: string, pr: number) {
    const answer = yield* github.rest({
      operation: "pull-request-read",
      path: `repos/${repo}/pulls/${pr}`,
    });
    return {
      pull: Option.getOrUndefined(decodePullRequest(answer.body)),
      githubNow: millisOf(answer.headers["date"]),
    };
  });

  /** Whether GitHub's pull request is Makita's own, for this task's `makita/…` branch. */
  const isMakitas = (pull: typeof PullRequest.Type, task: PullTask, makitaId: number) =>
    pull.user?.id === makitaId &&
    task.branch !== null &&
    task.branch.startsWith("makita/") &&
    pull.head.ref === task.branch;

  /** Closes the pull request on GitHub, then deletes its branch (best effort). */
  const closeOnGitHub = Effect.fn("MakitaCleanup.closeOnGitHub")(function* (task: PullTask) {
    yield* github.rest({
      operation: "pull-request-close",
      method: "PATCH",
      path: `repos/${task.repo}/pulls/${task.prNumber}`,
      body: { state: "closed" },
    });
    if (task.branch === null || !task.branch.startsWith("makita/")) return;
    yield* github
      .rest({
        operation: "branch-delete",
        method: "DELETE",
        path: `repos/${task.repo}/git/refs/heads/${task.branch}`,
      })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("Makita could not delete the branch of a pull request it closed", {
            taskId: task.taskId,
            reason: error.reason,
          }),
        ),
      );
  });

  /** In one transaction: the PR seen closed, the task stopped, the close audited. */
  const recordClosed = Effect.fn("MakitaCleanup.recordClosed")(function* (
    task: PullTask,
    reason: "pr-idle" | "bad-work",
    detail: Readonly<Record<string, string | number | null>>,
  ) {
    const at = iso(yield* nowMillis);
    yield* sql`UPDATE makita_tasks SET pr_closed_at = ${at} WHERE task_id = ${task.taskId}`;
    yield* stopTasksWithin(sql, {
      actor: { source: "system" },
      scope: { taskId: task.taskId },
      reason,
    });
    yield* AuditLog.write(sql)({
      actor: { source: "system" },
      action: "makita.github.close_pull_request",
      spaceId: SpaceId.make(task.spaceId),
      target: { kind: "makita_task", id: task.taskId, name: `${task.repo}#${task.number}` },
      detail: {
        space: task.spaceId,
        repo: task.repo,
        number: task.number,
        makita: task.configId,
        pr: task.prNumber,
        branch: task.branch,
        reason: reason === "pr-idle" ? "idle" : "bad-work",
        ...detail,
      },
    });
  });

  const markSeenClosed = (taskId: string) =>
    Effect.flatMap(
      nowMillis,
      (now) => sql`UPDATE makita_tasks SET pr_closed_at = ${iso(now)} WHERE task_id = ${taskId}`,
    );

  /** A queued bad-work label, ended once with what came of it. */
  const finish = (eventKey: string, outcome: string, detail: string) => sql`
    UPDATE makita_events SET outcome = ${outcome}, detail = ${detail}
    WHERE event_key = ${eventKey} AND outcome = 'command' AND detail = ${BAD_WORK}
  `;

  const badWorkOne = Effect.fn("MakitaCleanup.badWorkOne")(function* (row: {
    readonly eventKey: string;
    readonly repo: string;
    readonly number: number;
    readonly actorId: number;
    readonly actorLogin: string;
    readonly configId: string;
    readonly seenAt: string;
  }) {
    const bot = yield* account;
    const [config] = yield* sql<{
      readonly pausedAt: string | null;
      readonly deletedAt: string | null;
      readonly autonomyJson: string;
    }>`
      SELECT paused_at AS "pausedAt", deleted_at AS "deletedAt", autonomy_json AS "autonomyJson"
      FROM makita_configs WHERE config_id = ${row.configId}
    `;
    if (bot === undefined || bot.paused !== null || config === undefined) {
      return yield* finish(row.eventKey, "ignored-paused", BAD_WORK);
    }
    if (config.pausedAt !== null || config.deletedAt !== null) {
      return yield* finish(row.eventKey, "ignored-paused", BAD_WORK);
    }
    // Turned off since: the label is only a label now.
    if (storedAutonomyOf(config.autonomyJson).badWorkLabel === null) {
      return yield* finish(row.eventKey, "ignored-no-config", BAD_WORK);
    }
    // Anyone else's label does nothing, and nothing is said.
    if (!(yield* isApproverNow(sql, row.configId, row.actorId))) {
      return yield* finish(row.eventKey, "ignored-not-approver", BAD_WORK);
    }
    const [task] = yield* sql<PullTask>`
      SELECT ${sql.literal(TASK_COLUMNS)} FROM makita_tasks
      WHERE host = ${MAKITA_GITHUB_HOST} AND repo = ${row.repo} AND pr_number = ${row.number}
        AND config_id = ${row.configId}
      ORDER BY created_at DESC, task_id DESC LIMIT 1
    `;
    if (task === undefined) return yield* finish(row.eventKey, "command", "bad-work:no-task");
    const read = yield* pullOf(row.repo, row.number).pipe(Effect.result);
    if (read._tag === "Failure") {
      const old = (yield* nowMillis) - (millisOf(row.seenAt) ?? 0) > GIVE_UP_MS;
      if (TRANSIENT.has(read.failure.reason) && !old) {
        if (read.failure.reason === "rate-limited") {
          yield* intake.holdForRateLimit(read.failure.retryAt);
        }
        return;
      }
      return yield* finish(row.eventKey, "command", "bad-work:unreadable");
    }
    const pull = read.success.pull;
    if (pull === undefined || !isMakitas(pull, task, bot.id)) {
      return yield* finish(row.eventKey, "command", "bad-work:not-makita");
    }
    if (pull.state !== "open") {
      yield* markSeenClosed(task.taskId);
      return yield* finish(row.eventKey, "command", "bad-work:not-open");
    }
    const closed = yield* closeOnGitHub(task).pipe(Effect.result);
    if (closed._tag === "Failure") {
      yield* Effect.logWarning("Makita could not close a pull request labelled bad work", {
        taskId: task.taskId,
        reason: closed.failure.reason,
      });
      if (TRANSIENT.has(closed.failure.reason)) return;
      return yield* finish(row.eventKey, "command", "bad-work:refused");
    }
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* recordClosed(task, "bad-work", { by: row.actorLogin, byId: row.actorId });
        yield* finish(row.eventKey, "command", "bad-work:closed");
      }),
    );
  });

  const badWorkQueued = Effect.gen(function* () {
    const rows = yield* sql<{
      readonly eventKey: string;
      readonly repo: string;
      readonly number: number;
      readonly actorId: number;
      readonly actorLogin: string;
      readonly configId: string;
      readonly seenAt: string;
    }>`
      SELECT event_key AS "eventKey", repo, number, actor_github_id AS "actorId",
        actor_login AS "actorLogin", config_id AS "configId", seen_at AS "seenAt"
      FROM makita_events
      WHERE outcome = 'command' AND detail = ${BAD_WORK} AND config_id IS NOT NULL
        AND actor_github_id IS NOT NULL
      ORDER BY seen_at, rowid LIMIT 20
    `;
    for (const row of rows) {
      yield* badWorkOne(row).pipe(
        Effect.catch((cause) =>
          Effect.logError("Makita could not act on a bad-work label", {
            eventKey: row.eventKey,
            cause,
          }),
        ),
      );
    }
  }).pipe(
    Effect.catch((cause) =>
      Effect.logError("Makita could not read its bad-work labels", { cause }),
    ),
    Effect.withSpan("MakitaCleanup.badWorkQueued"),
  );

  /** One idle candidate: closed when GitHub agrees nothing moved for `days`; `stop` on a limit. */
  const sweepOne = Effect.fn("MakitaCleanup.sweepOne")(function* (
    task: PullTask,
    days: number,
    makitaId: number,
  ) {
    const read = yield* pullOf(task.repo, task.prNumber).pipe(Effect.result);
    if (read._tag === "Failure") {
      if (read.failure.reason === "rate-limited") {
        yield* intake.holdForRateLimit(read.failure.retryAt);
        return "stop" as const;
      }
      if (read.failure.reason === "unauthorized" || read.failure.reason === "no-token") {
        return "stop" as const;
      }
      return "skip" as const;
    }
    const { pull, githubNow } = read.success;
    // Never another account's pull request, nor one that is not this task's branch.
    if (pull === undefined || !isMakitas(pull, task, makitaId)) return "skip" as const;
    if (pull.state !== "open") {
      yield* markSeenClosed(task.taskId);
      return "skip" as const;
    }
    // GitHub's clock against GitHub's `updated_at`: the Hub's clock is never mixed in.
    const now = githubNow ?? (yield* nowMillis);
    const updated = millisOf(pull.updated_at);
    if (updated === undefined || now - updated < days * DAY_MS) return "skip" as const;
    // Read again right before writing: a turn, an approval or a pause since wins.
    const [still] = yield* sql<
      PullTask & { readonly autonomyJson: string; readonly paused: string | null }
    >`
      SELECT ${sql.literal(TASK_COLUMNS)},
        (SELECT autonomy_json FROM makita_configs WHERE config_id = makita_tasks.config_id)
          AS "autonomyJson",
        (SELECT COALESCE(paused_at, deleted_at) FROM makita_configs
          WHERE config_id = makita_tasks.config_id) AS paused
      FROM makita_tasks WHERE task_id = ${task.taskId}
    `;
    const bot = yield* account;
    if (
      still === undefined ||
      bot === undefined ||
      bot.paused !== null ||
      still.paused !== null ||
      still.state === "running" ||
      still.state === "awaiting-approval" ||
      still.pending !== null ||
      storedAutonomyOf(still.autonomyJson).closeIdlePrsDays === null
    ) {
      return "skip" as const;
    }
    const posted = yield* github
      .rest({
        operation: "issue-comment",
        method: "POST",
        path: `repos/${task.repo}/issues/${task.prNumber}/comments`,
        body: { body: idleCloseText(days) },
      })
      .pipe(Effect.result);
    if (posted._tag === "Failure") return "skip" as const;
    const at = iso(yield* nowMillis);
    yield* sql`
      UPDATE makita_tasks SET replies_without_person = replies_without_person + 1,
        updated_at = ${at}
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
        number: task.prNumber,
        makita: task.configId,
        by: "hub",
      },
    });
    const closed = yield* closeOnGitHub(task).pipe(Effect.result);
    if (closed._tag === "Failure") {
      yield* Effect.logWarning("Makita could not close an idle pull request", {
        taskId: task.taskId,
        reason: closed.failure.reason,
      });
      return "skip" as const;
    }
    yield* sql.withTransaction(recordClosed(task, "pr-idle", { days }));
    return "closed" as const;
  });

  const sweepIdle = Effect.gen(function* () {
    const now = yield* nowMillis;
    if (now - (yield* Ref.get(lastSweep)) < SWEEP_EVERY_MS) return;
    const bot = yield* account;
    if (bot === undefined || bot.paused !== null || bot.status === "token-invalid") return;
    if ((yield* intake.heldUntil) > now) return;
    yield* Ref.set(lastSweep, now);
    const configs = yield* sql<{
      readonly configId: string;
      readonly spaceId: string;
      readonly autonomyJson: string;
    }>`
      SELECT config_id AS "configId", space_id AS "spaceId", autonomy_json AS "autonomyJson"
      FROM makita_configs WHERE deleted_at IS NULL AND paused_at IS NULL
      ORDER BY created_at, config_id
    `;
    const idle = configs.flatMap((config) => {
      const days = storedAutonomyOf(config.autonomyJson).closeIdlePrsDays;
      return days === null ? [] : [{ ...config, days }];
    });
    if (idle.length === 0) return;
    const found = yield* spaces.spacesById([
      ...new Set(idle.map((config) => SpaceId.make(config.spaceId))),
    ]);
    let left = SWEEP_BATCH;
    for (const config of idle) {
      const space = found.get(SpaceId.make(config.spaceId));
      if (space === undefined || space.resource.archived || space.resource.frozen) continue;
      const tasks = yield* sql<PullTask>`
        SELECT ${sql.literal(TASK_COLUMNS)} FROM makita_tasks
        WHERE config_id = ${config.configId} AND pr_number IS NOT NULL AND pr_closed_at IS NULL
          AND state NOT IN ('running', 'awaiting-approval', 'done')
          AND pending_push_json IS NULL AND updated_at < ${iso(now - config.days * DAY_MS)}
        ORDER BY updated_at, task_id LIMIT ${left}
      `;
      for (const task of tasks) {
        left -= 1;
        if ((yield* sweepOne(task, config.days, bot.id)) === "stop") return;
      }
      if (left <= 0) return;
    }
  }).pipe(
    Effect.catch((cause) => Effect.logError("Makita's idle pull request sweep failed", { cause })),
    Effect.withSpan("MakitaCleanup.sweepIdle"),
  );

  return MakitaCleanup.of({ badWorkQueued, sweepIdle });
});

/** Over Makita's GitHub client, the database, the Spaces and the intake's rate-limit hold. */
export const layer = Layer.effect(MakitaCleanup, make);

/**
 * On the Hub's Scheduler (`makita-cleanup`, every tick): `/makita reopen` orders and bad-work
 * labels the intake accepted, then the idle sweep when due.
 */
export const layerScheduled = Layer.effectDiscard(
  Effect.gen(function* () {
    const scheduler = yield* Scheduler.Scheduler;
    const cleanup = yield* MakitaCleanup;
    const closes = yield* MakitaIssueCloses;
    yield* scheduler.register(
      "makita-cleanup",
      closes.reopenQueued.pipe(
        Effect.andThen(cleanup.badWorkQueued),
        Effect.andThen(cleanup.sweepIdle),
      ),
    );
  }),
);
