// @effect-diagnostics globalJsonInEffect:off - the stored worktree and GitHub's answers, with Schema.
/**
 * Makita ticket 28: a finished task's worktree removed from its machine once nothing needs it (its
 * pull request merged or closed, or 7 days after it ended without one), retried while the machine
 * is away; and the `makita/…` branch of a pull request a person merged or closed, deleted.
 */
import { EnvironmentId, ProjectId, SpaceId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as AuditLog from "../audit/AuditLog.ts";
import { movedWorktreeNames } from "../environment/MovedWorkspace.ts";
import { threadTurnsOf } from "../orchestration-v2/threadTurns.ts";
import { MakitaGitHub, type MakitaGitHubError } from "./MakitaGitHub.ts";
import { MakitaIntake } from "./MakitaIntake.ts";
import { MakitaMachines, type MakitaRemoval } from "./MakitaMachines.ts";
import { MakitaTaskWorkspace } from "./MakitaPushes.ts";

const MINUTE_MS = 60 * 1_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** A task that ended without a pull request keeps its worktree this long, for a person to look. */
export const WORKTREE_GRACE_MS = 7 * DAY_MS;
/** An ended task's pull request that still looks open is asked about at most this often. */
const PULL_LOOK_EVERY_MS = 6 * HOUR_MS;
/** A failed removal is tried again after this, doubling up to `RETRY_MAX_MS`. */
const RETRY_FIRST_MS = 10 * MINUTE_MS;
const RETRY_MAX_MS = 6 * HOUR_MS;
/** Failing this long (the machine away, or git refusing), the Hub gives up and says so. */
export const WORKTREE_GIVE_UP_MS = 14 * DAY_MS;
const SWEEP_EVERY_MS = 5 * MINUTE_MS;
const BATCH = 20;
const TRANSIENT = new Set(["unreachable", "rate-limited"]);

const decodeWorkspace = Schema.decodeUnknownOption(Schema.fromJsonString(MakitaTaskWorkspace));
const decodePull = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ state: Schema.String })),
);

interface WorktreeTask {
  readonly taskId: string;
  readonly configId: string;
  readonly spaceId: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly repo: string;
  readonly number: number;
  readonly prNumber: number | null;
  readonly prClosedAt: string | null;
  readonly landedSha: string | null;
  readonly workspaceJson: string;
  readonly failingSince: string | null;
}

interface BranchTask {
  readonly taskId: string;
  readonly configId: string;
  readonly spaceId: string;
  readonly repo: string;
  readonly number: number;
  readonly prNumber: number | null;
  readonly branch: string | null;
}

export class MakitaWorktrees extends Context.Service<
  MakitaWorktrees,
  {
    /** One pass now: branches to delete, then finished tasks' worktrees due for removal. */
    readonly sweep: Effect.Effect<void>;
    /** The pass when due (every 5 minutes), for the Scheduler. */
    readonly sweepDue: Effect.Effect<void>;
  }
>()("t3/makita/MakitaWorktrees") {}

/** The last folder names of a path, whatever separator the machine uses. */
const lastFolders = (path: string) => path.split(/[\\/]+/u).filter((part) => part.length > 0);

const oneLine = (text: string) => {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length > 300 ? `${line.slice(0, 299)}…` : line;
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const github = yield* MakitaGitHub;
  const machines = yield* MakitaMachines;
  const intake = yield* MakitaIntake;
  const lastSweep = yield* Ref.make(0);
  const nowMillis = Effect.map(DateTime.now, DateTime.toEpochMillis);
  const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));
  const millisOf = (value: string) => {
    const parsed = DateTime.make(value);
    return Option.isSome(parsed) ? DateTime.toEpochMillis(parsed.value) : undefined;
  };

  /** Whether GitHub may be asked now: a token it accepts, and no rate-limit hold. */
  const gitHubOpen = Effect.gen(function* () {
    const [bot] = yield* sql<{ readonly status: string }>`
      SELECT status FROM makita_account WHERE account_id = 'makita'
    `;
    if (bot === undefined || bot.status === "token-invalid") return false;
    return (yield* intake.heldUntil) <= (yield* nowMillis);
  });

  const auditTask = (
    task: { readonly taskId: string; readonly spaceId: string; readonly repo: string },
    action: "makita.task.remove_worktree" | "makita.github.delete_branch",
    detail: Readonly<Record<string, string | number>>,
  ) =>
    AuditLog.write(sql)({
      actor: { source: "system" },
      action,
      spaceId: SpaceId.make(task.spaceId),
      target: {
        kind: "makita_task",
        id: task.taskId,
        name: `${task.repo}#${String(detail.number)}`,
      },
      detail: { space: task.spaceId, repo: task.repo, ...detail },
    });

  /** A person's merge or close seen live: the task's `makita/…` branch, deleted (best effort). */
  const deleteBranch = Effect.fn("MakitaWorktrees.deleteBranch")(function* (task: BranchTask) {
    const mark = (to: "deleted" | "failed") => sql`
      UPDATE makita_tasks SET branch_cleanup = ${to} WHERE task_id = ${task.taskId}
    `;
    if (task.branch === null || !task.branch.startsWith("makita/")) return yield* mark("failed");
    const deleted = yield* github
      .rest({
        operation: "branch-delete",
        method: "DELETE",
        path: `repos/${task.repo}/git/refs/heads/${task.branch}`,
      })
      .pipe(Effect.result);
    if (deleted._tag === "Success") {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* mark("deleted");
          yield* auditTask(task, "makita.github.delete_branch", {
            number: task.number,
            makita: task.configId,
            pr: task.prNumber ?? 0,
            branch: task.branch!,
          });
        }),
      );
    }
    const error: MakitaGitHubError = deleted.failure;
    // Already gone (GitHub's own button, or a person): nothing left to do.
    if (error.reason === "not-found" || error.status === 422) return yield* mark("deleted");
    if (TRANSIENT.has(error.reason)) {
      if (error.reason === "rate-limited") yield* intake.holdForRateLimit(error.retryAt);
      return "stop" as const;
    }
    if (error.reason === "unauthorized" || error.reason === "no-token") return "stop" as const;
    yield* Effect.logWarning("Makita could not delete the branch of a closed pull request", {
      taskId: task.taskId,
      reason: error.reason,
    });
    return yield* mark("failed");
  });

  /** Ticket 28's GitHub look at an ended task's pull request: whether it is still open. */
  const pullStillOpen = Effect.fn("MakitaWorktrees.pullStillOpen")(function* (
    task: WorktreeTask,
    pr: number,
    now: number,
  ) {
    const read = yield* github
      .rest({ operation: "pull-request-read", path: `repos/${task.repo}/pulls/${pr}` })
      .pipe(Effect.result);
    const lookAgain = (after: number) => sql`
      UPDATE makita_tasks SET worktree_next_try_at = ${iso(now + after)}
      WHERE task_id = ${task.taskId}
    `;
    if (read._tag === "Failure") {
      const error = read.failure;
      if (error.reason === "rate-limited") yield* intake.holdForRateLimit(error.retryAt);
      // Gone from GitHub (the repository too): it can no longer be reopened.
      if (error.reason !== "not-found") {
        yield* lookAgain(TRANSIENT.has(error.reason) ? RETRY_FIRST_MS : PULL_LOOK_EVERY_MS);
        return true;
      }
    } else if (Option.getOrUndefined(decodePull(read.success.body))?.state === "open") {
      yield* lookAgain(PULL_LOOK_EVERY_MS);
      return true;
    }
    yield* sql`
      UPDATE makita_tasks SET pr_closed_at = ${iso(now)}
      WHERE task_id = ${task.taskId} AND pr_closed_at IS NULL
    `;
    return false;
  });

  /** One finished task's worktree: removed, or tried again later, or given up on. */
  const removeOne = Effect.fn("MakitaWorktrees.removeOne")(function* (
    task: WorktreeTask,
    canAskGitHub: boolean,
  ) {
    const now = yield* nowMillis;
    let why: "pr-closed" | "ended" = "ended";
    if (task.prClosedAt !== null || task.landedSha !== null) {
      why = "pr-closed";
    } else if (task.prNumber !== null) {
      // Its pull request may still get changes: kept while it is open.
      if (!canAskGitHub || (yield* pullStillOpen(task, task.prNumber, now))) return;
      why = "pr-closed";
    }
    const workspace = Option.getOrUndefined(decodeWorkspace(task.workspaceJson));
    const at = iso(now);
    const common = { number: task.number, makita: task.configId, why };
    const final = (outcome: "refused" | "gave-up", failure: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`
            UPDATE makita_tasks SET worktree_gave_up_at = ${at}, worktree_failure = ${failure},
              worktree_next_try_at = NULL
            WHERE task_id = ${task.taskId}
          `;
          yield* auditTask(task, "makita.task.remove_worktree", {
            ...common,
            environment: workspace?.environmentId ?? "",
            outcome,
            failure,
          });
        }),
      );
    // Only the folder the Hub made for this task's Project and Thread, never another path.
    const names = movedWorktreeNames(task.projectId, task.threadId);
    const folders = workspace === undefined ? [] : lastFolders(workspace.cwd);
    if (
      workspace === undefined ||
      folders.at(-1) !== names.thread ||
      folders.at(-2) !== names.project
    ) {
      return yield* final("refused", "refused: not the worktree the Hub made for this task");
    }
    const removal: MakitaRemoval = yield* machines.removeWorktree({
      environmentId: EnvironmentId.make(workspace.environmentId),
      projectId: ProjectId.make(task.projectId),
      threadId: ThreadId.make(task.threadId),
      cwd: workspace.cwd,
    });
    switch (removal._tag) {
      case "removed":
      case "absent":
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              UPDATE makita_tasks SET worktree_removed_at = ${at}, worktree_failure = NULL,
                worktree_failing_since = NULL, worktree_next_try_at = NULL
              WHERE task_id = ${task.taskId}
            `;
            yield* auditTask(task, "makita.task.remove_worktree", {
              ...common,
              environment: workspace.environmentId,
              outcome: removal._tag === "removed" ? "removed" : "gone",
            });
          }),
        );
      case "refused":
        return yield* final("refused", oneLine(`refused: ${removal.detail}`));
      // A machine that cannot take the call yet: looked at again, never given up for it.
      case "outdated":
        return yield* sql`
          UPDATE makita_tasks SET worktree_failure = 'outdated-machine',
            worktree_next_try_at = ${iso(now + RETRY_MAX_MS)}
          WHERE task_id = ${task.taskId}
        `;
      case "offline":
      case "failed": {
        const failure =
          removal._tag === "failed" ? oneLine(`failed: ${removal.detail}`) : "offline";
        const since = (task.failingSince === null ? undefined : millisOf(task.failingSince)) ?? now;
        if (now - since >= WORKTREE_GIVE_UP_MS) {
          yield* Effect.logWarning("Makita gave up removing a finished task's worktree", {
            taskId: task.taskId,
            failure,
          });
          return yield* final("gave-up", failure);
        }
        // Waits as long as it has been failing: 10 minutes, 20, 40… up to 6 hours.
        const wait = Math.min(RETRY_MAX_MS, Math.max(RETRY_FIRST_MS, now - since));
        return yield* sql`
          UPDATE makita_tasks SET worktree_failure = ${failure},
            worktree_failing_since = ${iso(since)}, worktree_next_try_at = ${iso(now + wait)}
          WHERE task_id = ${task.taskId}
        `;
      }
    }
  });

  const sweep = Effect.gen(function* () {
    const [bot] = yield* sql<{ readonly paused: string | null }>`
      SELECT global_paused_at AS paused FROM makita_account WHERE account_id = 'makita'
    `;
    // «Stop all»: Makita does nothing, this included.
    if (bot !== undefined && bot.paused !== null) return;
    let canAskGitHub = yield* gitHubOpen;
    if (canAskGitHub) {
      const branches = yield* sql<BranchTask>`
        SELECT task_id AS "taskId", config_id AS "configId", space_id AS "spaceId", repo, number,
          pr_number AS "prNumber", branch
        FROM makita_tasks WHERE branch_cleanup = 'pending'
        ORDER BY updated_at, task_id LIMIT ${BATCH}
      `;
      for (const task of branches) {
        const done = yield* deleteBranch(task).pipe(
          Effect.catch((cause) =>
            Effect.logError("Makita could not delete a closed pull request's branch", {
              taskId: task.taskId,
              cause,
            }),
          ),
        );
        if (done === "stop") {
          canAskGitHub = false;
          break;
        }
      }
    }
    const now = yield* nowMillis;
    const tasks = yield* sql<WorktreeTask>`
      SELECT task_id AS "taskId", config_id AS "configId", space_id AS "spaceId",
        project_id AS "projectId", thread_id AS "threadId", repo, number,
        pr_number AS "prNumber", pr_closed_at AS "prClosedAt", landed_sha AS "landedSha",
        workspace_json AS "workspaceJson", worktree_failing_since AS "failingSince"
      FROM makita_tasks
      WHERE workspace_json IS NOT NULL AND worktree_removed_at IS NULL
        AND worktree_gave_up_at IS NULL AND state IN ('done', 'stopped', 'failed')
        AND pending_push_json IS NULL
        AND (worktree_next_try_at IS NULL OR worktree_next_try_at <= ${iso(now)})
        AND (pr_number IS NOT NULL OR landed_sha IS NOT NULL OR pr_closed_at IS NOT NULL
          OR updated_at <= ${iso(now - WORKTREE_GRACE_MS)})
      ORDER BY CASE WHEN pr_number IS NULL OR landed_sha IS NOT NULL OR pr_closed_at IS NOT NULL
          THEN 0 ELSE 1 END, updated_at, task_id
      LIMIT ${BATCH}
    `;
    // A turn still going in its Thread (a person's, or the agent finishing): kept for now.
    const turns = yield* threadTurnsOf(
      sql,
      tasks.map((task) => task.threadId),
    );
    for (const task of tasks) {
      if (turns.get(task.threadId)?.going === true) continue;
      yield* removeOne(task, canAskGitHub).pipe(
        Effect.catch((cause) =>
          Effect.logError("Makita could not remove a finished task's worktree", {
            taskId: task.taskId,
            cause,
          }),
        ),
      );
      canAskGitHub = canAskGitHub && (yield* intake.heldUntil) <= (yield* nowMillis);
    }
  }).pipe(
    Effect.catch((cause) => Effect.logError("Makita's worktree cleanup failed", { cause })),
    Effect.withSpan("MakitaWorktrees.sweep"),
  );

  const sweepDue = Effect.gen(function* () {
    const now = yield* nowMillis;
    if (now - (yield* Ref.get(lastSweep)) < SWEEP_EVERY_MS) return;
    yield* Ref.set(lastSweep, now);
    yield* sweep;
  });

  return MakitaWorktrees.of({ sweep, sweepDue });
});

/** Over the machines, Makita's GitHub client, the database and the intake's rate-limit hold. */
export const layer = Layer.effect(MakitaWorktrees, make);
