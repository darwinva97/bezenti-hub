/**
 * Makita ticket 10: a pushing task's own worktree and `makita_push`. The agent commits in its
 * worktree; the Hub uploads it, validates the new commits and pushes them with Makita's token to
 * the task's `makita/…` branch, never forced. The agent names nothing: the destination is the task's.
 */
import {
  type EnvironmentId,
  MakitaError,
  type ProjectId,
  type ProviderInstanceId,
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
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as AuditLog from "../audit/AuditLog.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as SecretMasker from "../vaults/SecretMasker.ts";
import { holdForApproval, type MakitaReleased, makeReleaseApproved } from "./makitaApprovalFlow.ts";
import {
  makitaAuthorOf,
  makitaBaseRef,
  makitaPushRef,
  makitaWorktreeSetup,
} from "./makitaBranch.ts";
import { MakitaGitHub, type MakitaGitHubError } from "./MakitaGitHub.ts";
import { MakitaMachines } from "./MakitaMachines.ts";
import { makitaTaskOfThread } from "./makitaRows.ts";

/** At most this many new commits in one push: a Makita branch is a pull request. */
const MAX_PUSH_COMMITS = 100;
/** About this many bytes of new objects at most in one push. */
const MAX_PUSH_BYTES = 64 * 1024 * 1024;
/** At most this many pushes per task in 24 hours. */
const MAX_PUSHES_PER_DAY = 30;
/** The added lines and messages checked for secrets: more than this is refused. */
const MAX_CHECKED_BYTES = 32 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1_000;
const LIVE_STATES = ["running", "waiting-ci", "waiting-reply"];
const WORKFLOWS = /^\.github\/workflows(?:\/|$)/iu;
const OBJECT_ID = /^[0-9a-f]{40}$/u;
/** Text with the shape of a token never goes out, as `makita_comment` refuses it. */
const TOKEN_SHAPE =
  /(?:t3gk_|t3ak_|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/u;
export const SOMEONE_ELSE_PUSHED = "Someone else pushed to this branch.";

/** Where a pushing task's worktree is, and the commit it started from. */
export const MakitaTaskWorkspace = Schema.Struct({
  environmentId: Schema.String,
  cwd: Schema.String,
  startSha: Schema.String,
});
export type MakitaTaskWorkspace = typeof MakitaTaskWorkspace.Type;
const WorkspaceJson = Schema.fromJsonString(MakitaTaskWorkspace);
const decodeWorkspace = Schema.decodeUnknownOption(WorkspaceJson);
const encodeWorkspace = Schema.encodeSync(WorkspaceJson);

export interface MakitaPushResult {
  readonly pushed: boolean;
  readonly message: string;
  readonly branch: string | null;
  readonly sha: string | null;
  readonly commits: number;
}

export interface MakitaWorkspaceInput {
  readonly taskId: string;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly spaceId: SpaceId;
  readonly creator: UserId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly repo: string;
  readonly branch: string;
  /** Null: the repository's default branch. */
  readonly baseBranch: string | null;
  /** Ticket 15: the machine dedicated to the Space that its configuration chose; null, the Sandbox. */
  readonly machine: EnvironmentId | null;
}

export class MakitaPushes extends Context.Service<
  MakitaPushes,
  {
    /** Before a pushing task's launch: its own worktree, made once (a restart reuses it). */
    readonly prepareWorkspace: (
      input: MakitaWorkspaceInput,
    ) => Effect.Effect<MakitaTaskWorkspace, MakitaError>;
    /** `makita_push`: the calling Thread's task's worktree to its branch, checked on the Hub. */
    readonly pushForThread: (threadId: ThreadId) => Effect.Effect<MakitaPushResult, MakitaError>;
    /** Ticket 11: every approved waiting push sent (or refused), under its Thread's lock. */
    readonly releaseApproved: Effect.Effect<ReadonlyArray<MakitaReleased>>;
  }
>()("t3/makita/MakitaPushes") {}

interface PushTaskRow {
  readonly taskId: string;
  readonly configId: string;
  readonly spaceId: string;
  readonly projectId: string;
  readonly repo: string;
  readonly number: number;
  readonly state: string;
  readonly branch: string | null;
  readonly baseBranch: string | null;
  readonly headSha: string | null;
  readonly lastPushAt: string | null;
  readonly approvedThrough: string | null;
  readonly workspaceJson: string | null;
  readonly callerId: number;
  readonly createdBy: string;
  readonly capability: string;
  readonly approval: string;
  readonly approversJson: string;
  readonly configPausedAt: string | null;
  readonly configDeletedAt: string | null;
}

const fail = (reason: MakitaError["reason"], message: string) =>
  Effect.fail(new MakitaError({ reason, message }));

const notPushed = (message: string): MakitaPushResult => ({
  pushed: false,
  message,
  branch: null,
  sha: null,
  commits: 0,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const github = yield* MakitaGitHub;
  const machines = yield* MakitaMachines;
  const audit = yield* AuditLog.AuditLog;
  const masker = yield* SecretMasker.SecretMasker;
  const vcs = yield* VcsProcess.VcsProcess;
  /** One push per Thread (one task) at a time. */
  const locks = new Map<string, Semaphore.Semaphore>();
  const lockOf = (threadId: string) => {
    const existing = locks.get(threadId);
    if (existing !== undefined) return existing;
    const made = Semaphore.makeUnsafe(1);
    locks.set(threadId, made);
    return made;
  };

  const storage = (what: string) => (cause: unknown) =>
    Effect.logError(`MakitaPushes: could not ${what}`, { cause }).pipe(
      Effect.andThen(fail("storage", `Could not ${what}. Try again.`)),
    );
  const githubRefusal = (what: string) => (error: MakitaGitHubError) =>
    fail("github", `Could not ${what} on GitHub: ${error.message}`);

  const account = Effect.gen(function* () {
    const [row] = yield* sql<{
      readonly login: string;
      readonly id: number;
      readonly paused: string | null;
    }>`
      SELECT login, github_user_id AS id, global_paused_at AS paused
      FROM makita_account WHERE account_id = 'makita'
    `.pipe(Effect.catch(storage("read Makita's account")));
    return Option.fromUndefinedOr(row);
  });

  /** Git in the Hub's bare repository (never with the token): exit code and output. */
  const git = (gitDir: string, args: ReadonlyArray<string>, maxOutputBytes?: number) =>
    vcs
      .run({
        operation: "MakitaPushes.git",
        command: "git",
        cwd: gitDir,
        args: ["--git-dir", gitDir, ...args],
        allowNonZeroExit: true,
        ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
      })
      .pipe(Effect.catch(storage("read the pushed commits")));
  const gitText = (gitDir: string, args: ReadonlyArray<string>) =>
    Effect.map(git(gitDir, args), (output) =>
      output.exitCode === 0 ? output.stdout.trim() : null,
    );

  const prepareWorkspace = Effect.fn("MakitaPushes.prepareWorkspace")(function* (
    input: MakitaWorkspaceInput,
  ) {
    const [row] = yield* sql<{
      readonly workspaceJson: string | null;
      readonly removedAt: string | null;
    }>`
      SELECT workspace_json AS "workspaceJson", worktree_removed_at AS "removedAt"
      FROM makita_tasks WHERE task_id = ${input.taskId}
    `.pipe(Effect.catch(storage("read the task")));
    // Ticket 28: an ended task's worktree, once removed, is never made again.
    if (row !== undefined && row.removedAt !== null) {
      return yield* fail("forbidden", "This task's worktree was removed.");
    }
    const known = Option.flatMap(Option.fromNullishOr(row?.workspaceJson), decodeWorkspace);
    if (Option.isSome(known)) return known.value;
    const bot = yield* account;
    if (Option.isNone(bot)) return yield* fail("forbidden", "Makita's account is not registered.");
    const gitDir = yield* machines.hubRepository(input.projectId);
    const baseRef = makitaBaseRef(input.taskId);
    const startSha = yield* github
      .fetchBranch({ repo: input.repo, gitDir, branch: input.baseBranch, ref: baseRef })
      .pipe(Effect.catch(githubRefusal("read the base branch")));
    const setupCommand = makitaWorktreeSetup({
      branch: input.branch,
      baseRef,
      author: makitaAuthorOf(bot.value),
    });
    if (setupCommand === null) {
      return yield* fail("invalid", "The task's branch or Makita's login cannot be used here.");
    }
    const made = yield* machines.makeWorktree({
      threadId: input.threadId,
      projectId: input.projectId,
      spaceId: input.spaceId,
      creator: input.creator,
      providerInstanceId: input.providerInstanceId,
      machine: input.machine,
      baseRef,
      setupCommand,
    });
    const workspace: MakitaTaskWorkspace = {
      environmentId: made.environmentId,
      cwd: made.cwd,
      startSha,
    };
    const at = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      UPDATE makita_tasks SET workspace_json = ${encodeWorkspace(workspace)}, updated_at = ${at}
      WHERE task_id = ${input.taskId}
    `.pipe(Effect.catch(storage("record the task's worktree")));
    return workspace;
  });

  /** Whether the task may still push now (Makita, its configuration, its state, its capability). */
  const stillAllowed = (threadId: ThreadId) =>
    makitaTaskOfThread(sql, threadId).pipe(
      Effect.map((task) =>
        Option.isSome(task) && task.value.halted === null && task.value.capability === "push"
          ? null
          : "This Makita task was stopped: nothing was pushed.",
      ),
      Effect.catch(storage("read the task")),
    );

  /**
   * The new commits (`head` not reachable from `since` nor the base now), refused with the reason
   * when any rule fails: count, size, author, workflows, secrets.
   */
  const validate = Effect.fn("MakitaPushes.validate")(function* (input: {
    readonly gitDir: string;
    readonly head: string;
    readonly since: string;
    readonly baseNow: string;
    readonly email: string;
    readonly creator: UserId;
  }) {
    const { gitDir, head } = input;
    const range = [head, "--not", input.since, input.baseNow];
    const listed = yield* gitText(gitDir, ["log", "--format=%H%x09%P%x09%ae%x09%ce", ...range]);
    const commits = (listed ?? "")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => {
        const [sha = "", parents = "", author = "", committer = ""] = line.split("\t");
        return {
          sha,
          parents: parents.split(" ").filter((parent) => parent.length > 0),
          author,
          committer,
        };
      });
    if (commits.length === 0) {
      return {
        _tag: "refused",
        message: "Nothing new to push: commit your changes first.",
      } as const;
    }
    if (commits.length > MAX_PUSH_COMMITS) {
      return {
        _tag: "refused",
        message: `That is ${commits.length} new commits; Makita pushes at most ${MAX_PUSH_COMMITS} at a time.`,
      } as const;
    }
    const strangers = commits.filter(
      (commit) =>
        commit.author.toLowerCase() !== input.email.toLowerCase() ||
        commit.committer.toLowerCase() !== input.email.toLowerCase(),
    );
    if (strangers.length > 0) {
      return {
        _tag: "refused",
        message: `Every new commit must be Makita's (author and committer ${input.email}); ${strangers.length} ${strangers.length === 1 ? "is" : "are"} not. Fix it with: git rebase -r ${input.since} --exec "git commit --amend --no-edit --reset-author"`,
      } as const;
    }
    for (const commit of commits) {
      const how =
        commit.parents.length === 0 ? ["--root"] : commit.parents.length > 1 ? ["-c"] : [];
      const names = yield* gitText(gitDir, [
        "diff-tree",
        "-r",
        "--name-only",
        "--no-commit-id",
        ...how,
        commit.sha,
      ]);
      const touched = (names ?? "").split("\n").find((path) => WORKFLOWS.test(path.trim()));
      if (touched !== undefined) {
        return {
          _tag: "refused",
          message: `Makita never changes workflows, and commit ${commit.sha.slice(0, 12)} changes ${touched.trim()}. Nothing was pushed: take that change out of every new commit.`,
        } as const;
      }
    }
    const usage = yield* gitText(gitDir, ["rev-list", "--objects", "--disk-usage", ...range]);
    const bytes = usage === null ? Number.NaN : Number.parseInt(usage, 10);
    if (Number.isFinite(bytes) && bytes > MAX_PUSH_BYTES) {
      return {
        _tag: "refused",
        message: `The new commits hold about ${Math.ceil(bytes / 1024 / 1024)} MiB; Makita pushes at most ${MAX_PUSH_BYTES / 1024 / 1024} MiB at a time.`,
      } as const;
    }
    // What would become public: the new commits' messages and the lines they add.
    const messages = yield* git(gitDir, ["log", "--format=%B", ...range], MAX_CHECKED_BYTES);
    const patches = yield* git(
      gitDir,
      ["log", "-p", "--no-color", "--no-ext-diff", "--format=", ...range],
      MAX_CHECKED_BYTES,
    );
    if (
      messages.exitCode !== 0 ||
      patches.exitCode !== 0 ||
      messages.stdoutTruncated ||
      patches.stdoutTruncated
    ) {
      return {
        _tag: "refused",
        message: "The new commits are too large to check for secrets, so nothing was pushed.",
      } as const;
    }
    const added = patches.stdout
      .split("\n")
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
      .join("\n");
    const text = `${messages.stdout}\n${added}`;
    const secrets = yield* masker
      .forUser(input.creator)
      .pipe(
        Effect.catch(() =>
          fail("storage", "Could not check the new commits for secrets, so nothing was pushed."),
        ),
      );
    if (TOKEN_SHAPE.test(text) || secrets.mask(text) !== text) {
      return {
        _tag: "refused",
        message:
          "The new commits hold something shaped like a token or a key, or one of your secrets, so nothing was pushed. Take it out of every new commit.",
      } as const;
    }
    return { _tag: "valid", commits: commits.length } as const;
  });

  /** `+a −d in f files` of the change since `since`, for a push waiting for approval. */
  const changeStats = Effect.fn("MakitaPushes.changeStats")(function* (
    gitDir: string,
    since: string,
    head: string,
  ) {
    const numstat = yield* gitText(gitDir, ["diff", "--numstat", since, head]);
    let files = 0;
    let additions = 0;
    let deletions = 0;
    for (const line of (numstat ?? "").split("\n")) {
      const [plus, minus] = line.split("\t");
      if (plus === undefined || minus === undefined) continue;
      files += 1;
      additions += Number.parseInt(plus, 10) || 0;
      deletions += Number.parseInt(minus, 10) || 0;
    }
    return { files, additions, deletions };
  });

  const pushOnce = Effect.fn("MakitaPushes.pushOnce")(function* (
    threadId: ThreadId,
    task: PushTaskRow,
    workspace: MakitaTaskWorkspace,
    bot: { readonly login: string; readonly id: number },
  ) {
    const branch = task.branch!;
    const projectId = task.projectId as ProjectId;
    const creator = UserId.make(task.createdBy);
    const gitDir = yield* machines.hubRepository(projectId);
    const pushRef = makitaPushRef(threadId);
    yield* machines.uploadWorktree({
      threadId,
      projectId,
      environmentId: workspace.environmentId as EnvironmentId,
      cwd: workspace.cwd,
      ref: pushRef,
    });
    // The capture's parent is the agent's HEAD; the capture itself never leaves the Hub.
    const head = yield* gitText(gitDir, [
      "rev-parse",
      "--verify",
      "--quiet",
      `${pushRef}^1^{commit}`,
    ]);
    if (head === null || !OBJECT_ID.test(head)) {
      return notPushed("There is no commit to push: commit your changes first.");
    }
    const captured = yield* gitText(gitDir, [
      "rev-parse",
      "--verify",
      "--quiet",
      `${pushRef}^{tree}`,
    ]);
    const committed = yield* gitText(gitDir, [
      "rev-parse",
      "--verify",
      "--quiet",
      `${head}^{tree}`,
    ]);
    const uncommitted = captured !== committed;
    const since = task.headSha ?? workspace.startSha;
    if (head === since) {
      return notPushed("Nothing new to push: commit your changes first.");
    }
    const descends = yield* git(gitDir, ["merge-base", "--is-ancestor", since, head]);
    if (descends.exitCode !== 0) {
      return notPushed(
        task.headSha === null
          ? `Your branch must build on the base (${since.slice(0, 12)}). Nothing was pushed.`
          : `Makita never force-pushes: build on what it pushed last (${since.slice(0, 12)}). Nothing was pushed.`,
      );
    }
    const baseNow = yield* github
      .fetchBranch({
        repo: task.repo,
        gitDir,
        branch: task.baseBranch,
        ref: makitaBaseRef(task.taskId),
      })
      .pipe(Effect.catch(githubRefusal("read the base branch")));
    const checked = yield* validate({
      gitDir,
      head,
      since,
      baseNow,
      email: makitaAuthorOf(bot).email,
      creator,
    });
    if (checked._tag === "refused") return notPushed(checked.message);

    // Ticket 11: a push after an instruction no approval covers waits for an approver.
    const held = yield* holdForApproval(sql, github, {
      taskId: task.taskId,
      head,
      branch,
      commits: checked.commits,
      stats: changeStats(gitDir, since, head),
    });
    if (held !== null) return held;

    // GitHub's branch must be where Makita left it: absent before the first push.
    const remote = yield* github
      .branchTip({ repo: task.repo, gitDir, branch })
      .pipe(Effect.catch(githubRefusal("read the branch")));
    if (remote !== task.headSha) return notPushed(SOMEONE_ELSE_PUSHED);
    // A stop between the checks and here wins: nothing goes out.
    const stopped = yield* stillAllowed(threadId);
    if (stopped !== null) return yield* fail("forbidden", stopped);
    const pushed = yield* github
      .pushBranch({ repo: task.repo, gitDir, sha: head, branch })
      .pipe(Effect.catch(githubRefusal("push the branch")));
    if (pushed === "rejected") return notPushed(SOMEONE_ELSE_PUSHED);
    const done = DateTime.formatIso(yield* DateTime.now);
    // Ticket 12: with its pull request open, CI is watched on the new head from now on.
    yield* sql`
      UPDATE makita_tasks SET head_sha = ${head}, last_push_at = ${done},
        pending_push_json = NULL, updated_at = ${done},
        ci_sha = CASE WHEN pr_number IS NULL THEN ci_sha ELSE ${head} END,
        ci_state = CASE WHEN pr_number IS NULL THEN ci_state ELSE 'pending' END,
        ci_since = CASE WHEN pr_number IS NULL THEN ci_since ELSE ${done} END,
        ci_failing_json = CASE WHEN pr_number IS NULL THEN ci_failing_json ELSE NULL END,
        state = CASE WHEN pr_number IS NULL THEN state ELSE 'waiting-ci' END
      WHERE task_id = ${task.taskId}
    `.pipe(Effect.catch(storage("record the push")));
    yield* audit
      .record({
        actor: { source: "agent", userId: creator },
        action: "makita.github.push",
        spaceId: SpaceId.make(task.spaceId),
        target: { kind: "makita_task", id: task.taskId, name: `${task.repo}#${task.number}` },
        detail: {
          space: task.spaceId,
          repo: task.repo,
          number: task.number,
          makita: task.configId,
          branch,
          sha: head,
          commits: checked.commits,
        },
      })
      // The push already happened: it is said to the agent, and the missing entry logged.
      .pipe(
        Effect.catch((cause) =>
          Effect.logError("MakitaPushes: could not audit a push", {
            taskId: task.taskId,
            cause,
          }),
        ),
      );
    return {
      pushed: true,
      message: `Pushed ${checked.commits} commit${checked.commits === 1 ? "" : "s"} to ${branch} (${head.slice(0, 12)}).${
        uncommitted ? " Uncommitted changes in your worktree were not pushed." : ""
      }`,
      branch,
      sha: head,
      commits: checked.commits,
    } satisfies MakitaPushResult;
  });

  /** Everything read again under the Thread's lock: a push that waited sees the one before it. */
  const checkedPush = Effect.fn("MakitaPushes.checkedPush")(function* (threadId: ThreadId) {
    const [task] = yield* sql<PushTaskRow>`
      SELECT t.task_id AS "taskId", t.config_id AS "configId", t.space_id AS "spaceId",
        t.project_id AS "projectId", t.repo, t.number, t.state, t.branch,
        t.base_branch AS "baseBranch", t.head_sha AS "headSha", t.last_push_at AS "lastPushAt",
        t.approved_through AS "approvedThrough", t.workspace_json AS "workspaceJson",
        t.caller_github_id AS "callerId", c.created_by AS "createdBy", c.capability,
        c.approval, c.approvers_json AS "approversJson", c.paused_at AS "configPausedAt",
        c.deleted_at AS "configDeletedAt"
      FROM makita_tasks t JOIN makita_configs c ON c.config_id = t.config_id
      WHERE t.thread_id = ${threadId}
    `.pipe(Effect.catch(storage("read this Thread's Makita task")));
    if (task === undefined) return yield* fail("forbidden", "This Thread is not a Makita task's.");
    const bot = yield* account;
    if (Option.isNone(bot) || bot.value.paused !== null) {
      return yield* fail("forbidden", "Makita is stopped for now: nothing was pushed.");
    }
    if (task.configPausedAt !== null || task.configDeletedAt !== null) {
      return yield* fail("forbidden", "This Makita configuration is paused: nothing was pushed.");
    }
    if (!LIVE_STATES.includes(task.state)) {
      return yield* fail("forbidden", "This Makita task has ended: nothing was pushed.");
    }
    if (task.capability !== "push") {
      return yield* fail("forbidden", "This Makita configuration may only comment.");
    }
    const workspace = Option.flatMap(Option.fromNullishOr(task.workspaceJson), decodeWorkspace);
    if (task.branch === null || Option.isNone(workspace)) {
      return yield* fail("forbidden", "This Makita task has no worktree to push from.");
    }
    const since = DateTime.formatIso(
      DateTime.makeUnsafe(DateTime.toEpochMillis(yield* DateTime.now) - DAY_MS),
    );
    const [today] = yield* sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM audit_log
      WHERE action = 'makita.github.push' AND target_kind = 'makita_task'
        AND target_id = ${task.taskId} AND at >= ${since}
    `.pipe(Effect.catch(storage("count Makita's pushes")));
    if ((today?.n ?? 0) >= MAX_PUSHES_PER_DAY) {
      return notPushed(
        `Makita has pushed ${MAX_PUSHES_PER_DAY} times for this task in 24 hours; nothing more today.`,
      );
    }
    return yield* pushOnce(threadId, task, workspace.value, bot.value);
  });

  const pushForThread = Effect.fn("MakitaPushes.pushForThread")(function* (threadId: ThreadId) {
    return yield* lockOf(threadId).withPermits(1)(checkedPush(threadId));
  });

  const releaseApproved = makeReleaseApproved({
    sql,
    github,
    machines,
    hasCommit: (gitDir, sha) =>
      OBJECT_ID.test(sha)
        ? Effect.map(
            git(gitDir, ["cat-file", "-e", `${sha}^{commit}`]),
            (out) => out.exitCode === 0,
          )
        : Effect.succeed(false),
    locked: (threadId, effect) => lockOf(threadId).withPermits(1)(effect),
  });

  return MakitaPushes.of({ prepareWorkspace, pushForThread, releaseApproved });
});

/** Over Makita's GitHub client, the machines, the audit log, the masker and git. */
export const layer = Layer.effect(MakitaPushes, make);
