// @effect-diagnostics nodeBuiltinImport:off -- local git repositories stand in for GitHub and a machine.
/**
 * Makita ticket 10's seams: GitHub's git side as local bare repositories (`MakitaGitRemote`), a
 * machine with its own checkout and worktrees uploading to a local Hub repository
 * (`MakitaMachines`), and every git command the Hub runs, recorded with its environment.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { EnvironmentId, MakitaError } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { movedWorktreeNames } from "../environment/MovedWorkspace.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { MakitaGitRemote } from "./MakitaGitHub.ts";
import {
  MakitaMachines,
  type MakitaRemoval,
  type MakitaRemoveInput,
  type MakitaWorktreeInput,
} from "./MakitaMachines.ts";

const SANDBOX = EnvironmentId.make("env-sandbox");

/** A git command the Hub ran: its arguments and the environment it was given (not inherited). */
export interface RecordedGit {
  readonly operation: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export const makeGitWorld = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "makita-push-"));
  const github = NodePath.join(root, "github");
  const hub = NodePath.join(root, "hub");
  const machine = NodePath.join(root, "machine");
  /** The machine's home: nothing of Makita's ever lands here. */
  const home = NodePath.join(machine, "home");
  NodeFS.mkdirSync(home, { recursive: true });
  /** A fixed environment: no user or system git config, the machine's home. */
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: NodePath.join(home, ".gitconfig"),
    LC_ALL: "C",
  };
  const git = (cwd: string, args: ReadonlyArray<string>, extra: Record<string, string> = {}) =>
    NodeChildProcess.execFileSync("git", [...args], {
      cwd,
      env: { ...env, ...extra },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const write = (dir: string, files: Record<string, string>) => {
    for (const [file, text] of Object.entries(files)) {
      const target = NodePath.join(dir, file);
      NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
      NodeFS.writeFileSync(target, text);
    }
  };
  const remoteOf = (repo: string) => NodePath.join(github, `${repo}.git`);
  const person = { GIT_AUTHOR_NAME: "Ada", GIT_AUTHOR_EMAIL: "ada@example.test" };
  const asPerson = {
    ...person,
    GIT_COMMITTER_NAME: person.GIT_AUTHOR_NAME,
    GIT_COMMITTER_EMAIL: person.GIT_AUTHOR_EMAIL,
  };

  /** A repository on GitHub with `branches` (the first is its default), each one commit. */
  const seed = (repo: string, branches: ReadonlyArray<string> = ["main"]) => {
    const bare = remoteOf(repo);
    NodeFS.mkdirSync(bare, { recursive: true });
    git(bare, ["init", "--bare", "--quiet", `--initial-branch=${branches[0]}`]);
    const work = NodeFS.mkdtempSync(NodePath.join(root, "seed-"));
    git(work, ["init", "--quiet", `--initial-branch=${branches[0]}`]);
    write(work, { "README.md": "# Widgets\n", ".github/workflows/ci.yml": "on: push\n" });
    git(work, ["add", "-A"]);
    git(work, ["commit", "--quiet", "-m", "Initial"], asPerson);
    for (const branch of branches)
      git(work, ["push", "--quiet", bare, `HEAD:refs/heads/${branch}`]);
  };
  const tipOf = (repo: string, branch: string) => {
    try {
      return git(remoteOf(repo), ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    } catch {
      return null;
    }
  };
  const branchesOf = (repo: string) =>
    git(remoteOf(repo), ["for-each-ref", "--format=%(refname:strip=2)", "refs/heads/"])
      .split("\n")
      .filter((line) => line.length > 0)
      .toSorted();
  /** Someone else pushes a commit on top of `branch` on GitHub. */
  const pushAsSomeoneElse = (repo: string, branch: string) => {
    const work = NodeFS.mkdtempSync(NodePath.join(root, "other-"));
    git(work, ["init", "--quiet"]);
    git(work, ["fetch", "--quiet", remoteOf(repo), `refs/heads/${branch}:refs/heads/x`]);
    git(work, ["checkout", "--quiet", "x"]);
    write(work, { "OTHER.md": "someone else\n" });
    git(work, ["add", "-A"]);
    git(work, ["commit", "--quiet", "-m", "Theirs"], asPerson);
    git(work, ["push", "--quiet", remoteOf(repo), `HEAD:refs/heads/${branch}`]);
  };

  const hubRepositoryOf = (projectId: string) => {
    const bare = NodePath.join(hub, `${projectId}.git`);
    if (!NodeFS.existsSync(NodePath.join(bare, "HEAD"))) {
      NodeFS.mkdirSync(bare, { recursive: true });
      git(bare, ["init", "--bare", "--quiet"]);
    }
    return bare;
  };
  const checkoutOf = (projectId: string) => {
    const checkout = NodePath.join(machine, "checkouts", projectId);
    if (!NodeFS.existsSync(checkout)) {
      NodeFS.mkdirSync(checkout, { recursive: true });
      git(checkout, ["init", "--quiet"]);
    }
    return checkout;
  };
  const made: Array<MakitaWorktreeInput & { readonly cwd: string }> = [];
  const uploads: Array<{ readonly ref: string; readonly cwd: string }> = [];
  /** Ticket 28: every removal the Hub asked the machine for. */
  const removals: Array<MakitaRemoveInput> = [];
  /** Where `move.prepare` puts a Thread's worktree on this machine. */
  const worktreeOf = (projectId: string, threadId: string) => {
    const names = movedWorktreeNames(projectId, threadId);
    return NodePath.join(machine, "worktrees", names.project, names.thread);
  };
  /**
   * `gate`: while set, making a worktree waits for it (a slow first clone); `attempts` counts
   * every start of one, each also told to `started` (its number) when set. `removal`: how the
   * machine answers a removal (`removed`: the folder goes, or `absent` when already gone).
   */
  const state: {
    failWorktree: boolean;
    gate: Deferred.Deferred<void> | null;
    attempts: number;
    started: ((attempt: number) => Effect.Effect<void>) | null;
    removal: "removed" | "offline" | "outdated" | "failed";
  } = { failWorktree: false, gate: null, attempts: 0, started: null, removal: "removed" };

  const fail = (message: string) => Effect.fail(new MakitaError({ reason: "github", message }));
  const slow = Effect.suspend(() => {
    state.attempts += 1;
    return (state.started === null ? Effect.void : state.started(state.attempts)).pipe(
      Effect.andThen(state.gate === null ? Effect.void : Deferred.await(state.gate)),
    );
  });
  const machines = Layer.succeed(
    MakitaMachines,
    MakitaMachines.of({
      hubRepository: (projectId) => Effect.sync(() => hubRepositoryOf(projectId)),
      makeWorktree: (input) =>
        Effect.andThen(slow, () =>
          state.failWorktree
            ? fail("The machine is not connected.")
            : Effect.try({
                try: () => {
                  // `move.fetch`, then `move.prepare` with the Hub's setup command.
                  const checkout = checkoutOf(input.projectId);
                  const bare = hubRepositoryOf(input.projectId);
                  git(checkout, ["fetch", "--quiet", bare, `+${input.baseRef}:${input.baseRef}`]);
                  const cwd = worktreeOf(input.projectId, input.threadId);
                  git(checkout, ["worktree", "add", "--quiet", "--detach", cwd, input.baseRef]);
                  NodeChildProcess.execFileSync("sh", ["-c", input.setupCommand], {
                    cwd,
                    env,
                    stdio: ["ignore", "pipe", "pipe"],
                  });
                  made.push({ ...input, cwd });
                  return { environmentId: SANDBOX, cwd };
                },
                catch: (cause) => new MakitaError({ reason: "github", message: String(cause) }),
              }),
        ),
      uploadWorktree: (input) =>
        Effect.try({
          try: () => {
            // `captureCheckpoint` (a commit of the worktree whose parent is HEAD), then a push.
            const index = NodePath.join(root, `index-${uploads.length}`);
            const withIndex = { GIT_INDEX_FILE: index };
            git(input.cwd, ["read-tree", "HEAD"], withIndex);
            git(input.cwd, ["add", "-A"], withIndex);
            const tree = git(input.cwd, ["write-tree"], withIndex);
            const commit = git(input.cwd, ["commit-tree", tree, "-p", "HEAD", "-m", "capture"], {
              ...withIndex,
              ...asPerson,
            });
            git(input.cwd, ["update-ref", input.ref, commit]);
            git(input.cwd, [
              "push",
              "--quiet",
              hubRepositoryOf(input.projectId),
              `+${input.ref}:${input.ref}`,
            ]);
            uploads.push({ ref: input.ref, cwd: input.cwd });
          },
          catch: (cause) => new MakitaError({ reason: "github", message: String(cause) }),
        }),
      removeWorktree: (input) =>
        Effect.sync((): MakitaRemoval => {
          removals.push(input);
          if (state.removal === "failed") return { _tag: "failed", detail: "git said no" };
          if (state.removal !== "removed") return { _tag: state.removal };
          if (!NodeFS.existsSync(input.cwd)) return { _tag: "absent" };
          NodeFS.rmSync(input.cwd, { recursive: true, force: true });
          return { _tag: "removed" };
        }),
    }),
  );

  const remote = Layer.succeed(MakitaGitRemote, {
    urlOf: (repo: string) => `file://${remoteOf(repo)}`,
  });

  const gitRuns: Array<RecordedGit> = [];
  /** The real git runner, each command recorded with the environment the Hub gave it. */
  const vcs = Layer.effect(
    VcsProcess.VcsProcess,
    Effect.gen(function* () {
      const real = yield* VcsProcess.VcsProcess;
      return VcsProcess.VcsProcess.of({
        run: (input) => {
          gitRuns.push({
            operation: input.operation,
            args: input.args,
            env: { ...(input.env as Record<string, string | undefined>) },
          });
          return real.run(input);
        },
      });
    }),
  ).pipe(Layer.provide(VcsProcess.layer));

  /** The agent, in its worktree: write files and commit (as the worktree's configured author). */
  const commit = (
    cwd: string,
    files: Record<string, string>,
    options: { readonly message?: string; readonly as?: "person" } = {},
  ) => {
    write(cwd, files);
    git(cwd, ["add", "-A"]);
    git(
      cwd,
      ["commit", "--quiet", "-m", options.message ?? "Fix it"],
      options.as === "person" ? asPerson : {},
    );
    return git(cwd, ["rev-parse", "HEAD"]);
  };

  /** Every file under `dir`, read as text, joined: to look for a value that must not be there. */
  const everything = (dir: string): string => {
    if (!NodeFS.existsSync(dir)) return "";
    const parts: Array<string> = [];
    const walk = (current: string) => {
      for (const entry of NodeFS.readdirSync(current, { withFileTypes: true })) {
        const full = NodePath.join(current, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) parts.push(NodeFS.readFileSync(full).toString("latin1"));
      }
    };
    walk(dir);
    return parts.join("\n");
  };

  return {
    root,
    machine,
    home,
    hub,
    machines,
    remote,
    vcs,
    gitRuns,
    made,
    uploads,
    removals,
    worktreeOf,
    state,
    seed,
    tipOf,
    branchesOf,
    pushAsSomeoneElse,
    commit,
    write,
    git,
    everything,
    hubRepositoryOf,
    cleanup: () => NodeFS.rmSync(root, { recursive: true, force: true }),
  };
};

export type GitWorld = ReturnType<typeof makeGitWorld>;
