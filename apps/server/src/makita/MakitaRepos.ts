/**
 * The GitHub repository of a Project (Makita ticket 03), with `gh`'s rule over the `github.com`
 * remotes of its checkout on the Hub: a remote marked by `gh repo set-default`, else
 * upstream/github/origin, else the only one. None: `no-remote`; a tie: `ambiguous`.
 */
import {
  gitHubApiHostForRemote,
  parseFetchRemotes,
  selectGitHubBaseRepository,
} from "@t3tools/source-control-github/server/gitHubRepositoryResolution";
import {
  MAKITA_GITHUB_HOST,
  type MakitaRepoState,
  type MakitaRepos,
  ProjectId,
  type SpaceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

import * as ProcessRunner from "../processRunner.ts";

export interface ResolvedRepo {
  readonly state: Exclude<MakitaRepoState, "gone">;
  /** `owner/name` when `ok`. */
  readonly repo: string | null;
}

const gitRead = (
  runner: ProcessRunner.ProcessRunner["Service"],
  cwd: string,
  args: Array<string>,
) =>
  runner
    .run({
      command: "git",
      args: ["-C", cwd, ...args],
      timeout: "5 seconds",
      timeoutBehavior: "timedOutResult",
      maxOutputBytes: 64 * 1024,
    })
    .pipe(
      Effect.map((output) => (output.code === 0 && !output.timedOut ? output.stdout : "")),
      Effect.orElseSucceed(() => ""),
    );

export const resolveProjectRepo = Effect.fn("MakitaRepos.resolveProjectRepo")(function* (
  workspaceRoot: string,
) {
  const runner = yield* ProcessRunner.ProcessRunner;
  const remotes = parseFetchRemotes(yield* gitRead(runner, workspaceRoot, ["remote", "-v"])).filter(
    (remote) => gitHubApiHostForRemote(remote.url) === MAKITA_GITHUB_HOST,
  );
  if (remotes.length === 0) return { state: "no-remote", repo: null } satisfies ResolvedRepo;
  const line = (remote: { readonly name: string; readonly url: string }) =>
    `${remote.name}\t${remote.url} (fetch)`;
  // Several remotes of one repository (origin and a mirror name) are that repository.
  const each = new Set(
    remotes.map((remote) => {
      const one = selectGitHubBaseRepository({
        remotes: line(remote),
        resolved: "",
        host: MAKITA_GITHUB_HOST,
      });
      return one === null ? "" : `${one.owner}/${one.name}`.toLowerCase();
    }),
  );
  const [only] = [...each];
  if (each.size === 1 && only !== undefined && only !== "") {
    const first = selectGitHubBaseRepository({
      remotes: line(remotes[0]!),
      resolved: "",
      host: MAKITA_GITHUB_HOST,
    })!;
    return { state: "ok", repo: `${first.owner}/${first.name}` } satisfies ResolvedRepo;
  }
  const resolved = yield* gitRead(runner, workspaceRoot, [
    "config",
    "--get-regexp",
    "^remote\\..*\\.gh-resolved$",
  ]);
  const selected = selectGitHubBaseRepository({
    remotes: remotes.map(line).join("\n"),
    resolved,
    host: MAKITA_GITHUB_HOST,
  });
  return selected === null
    ? ({ state: "ambiguous", repo: null } satisfies ResolvedRepo)
    : ({ state: "ok", repo: `${selected.owner}/${selected.name}` } satisfies ResolvedRepo);
});

/** A live Project of a Space and the GitHub repository its checkout resolves to. */
export interface SpaceProjectRepo extends ResolvedRepo {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
}

/**
 * Each live Project of a Space with its repository (tickets 04–05: what a configuration listens
 * to, and the Project a task's Thread lives in), read from its checkout on the Hub.
 */
export const spaceProjectRepos = Effect.fn("MakitaRepos.spaceProjectRepos")(function* (
  sql: SqlClient.SqlClient,
  spaceId: SpaceId,
) {
  const rows = yield* sql<{
    readonly projectId: string;
    readonly title: string;
    readonly workspaceRoot: string;
  }>`
    SELECT project_id AS "projectId", title, workspace_root AS "workspaceRoot"
    FROM projection_projects
    WHERE space_id = ${spaceId} AND deleted_at IS NULL
    ORDER BY title, project_id
  `;
  return yield* Effect.forEach(
    rows,
    (row) =>
      resolveProjectRepo(row.workspaceRoot).pipe(
        Effect.map((resolved): SpaceProjectRepo => ({
          ...resolved,
          projectId: ProjectId.make(row.projectId),
          title: row.title,
          workspaceRoot: row.workspaceRoot,
        })),
      ),
    { concurrency: 4 },
  );
});

/** The Projects a configuration's `repos_json` names, among its Space's, that resolve. */
export const listenedProjects = (
  repos: MakitaRepos,
  inSpace: ReadonlyArray<SpaceProjectRepo>,
): ReadonlyArray<SpaceProjectRepo & { readonly repo: string }> =>
  inSpace.filter(
    (project): project is SpaceProjectRepo & { readonly repo: string } =>
      project.state === "ok" &&
      project.repo !== null &&
      ("all" in repos || repos.projects.includes(project.projectId)),
  );
