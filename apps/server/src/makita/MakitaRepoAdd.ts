/**
 * Makita ticket 21: a repository added to a Space by name, from a configuration's form. The
 * Space's Project with that GitHub remote is reused; otherwise, with `project.create` there and
 * Makita's token able to reach it, the WS door's clone path makes one as the person. A private
 * repository the person could not see answers exactly like a missing one.
 */
import {
  MakitaError,
  type MakitaProjectRepo,
  type MakitaRepoAddInput,
  type MakitaRepoAddResult,
  type ProjectId,
  type SpaceId,
  UserId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as AuditLog from "../audit/AuditLog.ts";
import * as AccessPolicy from "../auth/AccessPolicy.ts";
import * as CommandActor from "../auth/CommandActor.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import { linkedIdsOf } from "./GitHubIdentities.ts";
import { MakitaGitHub, type MakitaGitHubError } from "./MakitaGitHub.ts";
import { resolveProjectRepo, spaceProjectRepos } from "./MakitaRepos.ts";
import { permittedIn } from "./makitaRows.ts";

const NOT_YOURS = "Makita is set up by a person in Space settings, not by an agent.";
const NOT_A_REPO = "Write the repository as owner/name or paste its github.com address.";
/** One answer for missing, hidden and private-but-not-yours: nothing to tell them apart. */
const unreachable = (repo: string) =>
  `Makita can't reach ${repo}. Check the name and that Makita's GitHub account can read it; for a private repository, your linked GitHub account must be a collaborator too.`;
/** How long the answer waits for the new checkout's GitHub remote (the save needs it). */
const REMOTE_WAIT_STEPS = 80;
const REMOTE_WAIT_STEP = "250 millis";

/** A new Project cloned for a person, as the WS door's clone path makes it. */
interface MakitaClonedProject {
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  /** Its clone's phase now (`running`, `done`, `failed`, `cancelled`), null once forgotten. */
  readonly phase: Effect.Effect<string | null>;
}

/** The Hub's clone path for one session (WS hands it in: `project/cloneIntoSpace.ts`). */
export type MakitaProjectCloner = (input: {
  readonly spaceId: SpaceId;
  readonly actorUserId: UserId;
  readonly repo: string;
}) => Effect.Effect<MakitaClonedProject, MakitaError, FileSystem.FileSystem | Path.Path>;

const GitHubRepo = Schema.Struct({
  full_name: Schema.String,
  private: Schema.optional(Schema.Boolean),
  permissions: Schema.optional(Schema.Struct({ push: Schema.optional(Schema.Boolean) })),
});
const decodeRepo = Schema.decodeUnknownOption(Schema.fromJsonString(GitHubRepo));
const decodeLogin = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ login: Schema.String })),
);

const fail = (reason: MakitaError["reason"], message: string) =>
  Effect.fail(new MakitaError({ reason, message }));

const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}\/[A-Za-z0-9._-]{1,100}$/u;

/** `owner/name` out of what a person types or pastes; undefined when it is neither. */
export const parseRepo = (text: string): string | undefined => {
  const trimmed = text.trim();
  const bare = trimmed
    .replace(/^git@github\.com:/iu, "")
    .replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//iu, "");
  if (bare === trimmed && /[:@]|^https?:/iu.test(trimmed)) return undefined;
  const [owner, name] = bare.split(/[/?#]/u);
  if (owner === undefined || name === undefined) return undefined;
  const repo = `${owner}/${name.replace(/\.git$/iu, "")}`;
  return NAME.test(repo) && !repo.endsWith("/.") && !repo.endsWith("/..") ? repo : undefined;
};

export class MakitaRepoAdd extends Context.Service<
  MakitaRepoAdd,
  {
    readonly add: (
      input: MakitaRepoAddInput & { readonly actorUserId: UserId },
      cloner: MakitaProjectCloner,
    ) => Effect.Effect<MakitaRepoAddResult, MakitaError>;
    /** The same, for a person's own WS session only (never an agent, the shell or one Space). */
    readonly addForSession: (
      input: MakitaRepoAddInput,
      cloner: MakitaProjectCloner,
    ) => Effect.Effect<MakitaRepoAddResult, MakitaError>;
  }
>()("t3/makita/MakitaRepoAdd") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const spaces = yield* SpaceDirectory.SpaceDirectory;
  const audit = yield* AuditLog.AuditLog;
  const github = yield* MakitaGitHub;
  const processes = yield* ProcessRunner.ProcessRunner;
  const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  // One add at a time: two people adding one repository make one Project.
  const lock = yield* Semaphore.make(1);

  const storage = (what: string) => (cause: unknown) =>
    Effect.logError(`MakitaRepoAdd: could not ${what}`, { cause }).pipe(
      Effect.andThen(fail("storage", `Could not ${what}. Try again.`)),
    );

  const gitHubRefusal = (repo: string) => (error: MakitaGitHubError) =>
    error.reason === "not-found" || error.reason === "forbidden"
      ? fail("not-found", unreachable(repo))
      : error.reason === "no-token"
        ? fail(
            "invalid",
            "Makita's GitHub account is not registered yet: the Owner registers it in Platform → Makita.",
          )
        : fail("github", `Could not ask GitHub about ${repo}: ${error.message}`);

  const projectsOf = (spaceId: SpaceId) =>
    spaceProjectRepos(sql, spaceId).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, processes),
      Effect.catch(storage("read the Space's Projects")),
    );

  /** Whether a private repository is one the person may see: the Owner, or a collaborator. */
  const seesPrivate = Effect.fn("MakitaRepoAdd.seesPrivate")(function* (
    principal: AccessPolicy.Principal,
    repo: string,
  ) {
    if (principal.isOwner) return true;
    const linked = (yield* linkedIdsOf(sql, [principal.userId]).pipe(
      Effect.catch(storage("read your linked GitHub account")),
    )).get(principal.userId);
    if (linked === undefined) return false;
    const user = yield* github
      .rest({ operation: "user-by-id", path: `user/${linked}` })
      .pipe(Effect.option);
    const login = Option.flatMap(user, (answer) => decodeLogin(answer.body));
    if (Option.isNone(login)) return false;
    const collaborator = yield* github
      .rest({
        operation: "collaborator-check",
        path: `repos/${repo}/collaborators/${encodeURIComponent(login.value.login)}`,
      })
      .pipe(Effect.option);
    return Option.isSome(collaborator);
  });

  const recordAdd = (input: {
    readonly actorUserId: UserId;
    readonly spaceId: SpaceId;
    readonly repo: string;
    readonly project: ProjectId;
    readonly title: string;
    readonly created: boolean;
  }) =>
    audit
      .record({
        actor: AuditLog.userActor(input.actorUserId),
        action: "makita.repo.add",
        spaceId: input.spaceId,
        target: { kind: "project", id: input.project, name: input.title },
        detail: {
          space: input.spaceId,
          repo: input.repo,
          project: input.project,
          created: input.created,
        },
      })
      .pipe(Effect.catch(storage("audit the repository")));

  const addNow = Effect.fn("MakitaRepoAdd.add")(function* (
    input: MakitaRepoAddInput & { readonly actorUserId: UserId },
    cloner: MakitaProjectCloner,
  ) {
    // `makita.use` first: nobody else learns anything or spends a GitHub request.
    const principal = yield* spaces
      .principalOf(input.actorUserId)
      .pipe(Effect.catch(storage("read who you are")));
    const space = (yield* spaces
      .spacesById([input.spaceId])
      .pipe(Effect.catch(storage("read the Space")))).get(input.spaceId);
    const permitted = yield* permittedIn(sql, input.actorUserId, input.spaceId).pipe(
      Effect.catch(storage("read who may use Makita")),
    );
    if (
      space === undefined ||
      !AccessPolicy.isAllowed(
        AccessPolicy.decide(principal, "makita.use", {
          kind: "makita-space",
          space: space.resource,
          permitted,
        }),
      )
    ) {
      return yield* fail(
        "forbidden",
        "You cannot use Makita in this Space. The Owner gives that permission.",
      );
    }
    const wanted = parseRepo(input.repo);
    if (wanted === undefined) return yield* fail("invalid", NOT_A_REPO);

    // A Project of this Space with that repository already: it is the one.
    const reuse = (repo: string) =>
      projectsOf(input.spaceId).pipe(
        Effect.map((inSpace) =>
          inSpace.find(
            (project) =>
              project.state === "ok" && project.repo?.toLowerCase() === repo.toLowerCase(),
          ),
        ),
      );
    const existing = yield* reuse(wanted);
    if (existing !== undefined) {
      const notes: Array<string> = [];
      const reached = yield* github
        .rest({ operation: "repo-read", path: `repos/${existing.repo}` })
        .pipe(Effect.result);
      if (reached._tag === "Failure") notes.push(unreachable(existing.repo ?? wanted));
      yield* recordAdd({
        actorUserId: input.actorUserId,
        spaceId: input.spaceId,
        repo: existing.repo ?? wanted,
        project: existing.projectId,
        title: existing.title,
        created: false,
      });
      return {
        project: {
          projectId: existing.projectId,
          title: existing.title,
          repo: existing.repo,
          state: "ok",
        },
        created: false,
        notes,
      } satisfies MakitaRepoAddResult;
    }

    // A new Project needs what making one by hand needs, asked before GitHub.
    if (!AccessPolicy.isAllowed(AccessPolicy.decide(principal, "project.create", space.resource))) {
      return yield* fail(
        "forbidden",
        "You cannot add Projects to this Space, so Makita cannot add a repository here.",
      );
    }
    const answer = yield* github
      .rest({ operation: "repo-read", path: `repos/${wanted}` })
      .pipe(Effect.catch(gitHubRefusal(wanted)));
    const found = decodeRepo(answer.body);
    if (Option.isNone(found) || parseRepo(found.value.full_name) === undefined) {
      return yield* fail("github", `GitHub answered something unexpected for ${wanted}.`);
    }
    const repo = found.value.full_name;
    if (found.value.private === true && !(yield* seesPrivate(principal, repo))) {
      return yield* fail("not-found", unreachable(wanted));
    }
    // GitHub's own spelling may name a Project already here (a renamed or moved repository).
    const named = repo.toLowerCase() === wanted.toLowerCase() ? undefined : yield* reuse(repo);
    if (named !== undefined) {
      return {
        project: { projectId: named.projectId, title: named.title, repo: named.repo, state: "ok" },
        created: false,
        notes: [],
      } satisfies MakitaRepoAddResult;
    }
    const notes: Array<string> = [];
    if (found.value.permissions?.push !== true) {
      notes.push(
        `Makita can read ${repo} but not push to it: comments and labels need its account as a collaborator with Write.`,
      );
    }
    const cloned = yield* cloner({
      spaceId: input.spaceId,
      actorUserId: input.actorUserId,
      repo,
    }).pipe(Effect.provideContext(services));
    // The save reads the checkout's remote: wait for git to write it, or for the clone to end.
    let state: MakitaProjectRepo["state"] = "no-remote";
    for (let step = 0; step < REMOTE_WAIT_STEPS; step += 1) {
      const resolved = yield* resolveProjectRepo(cloned.workspaceRoot).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, processes),
      );
      if (resolved.state === "ok") {
        state = "ok";
        break;
      }
      const phase = yield* cloned.phase;
      if (phase === "failed" || phase === "cancelled") {
        notes.push(
          `The Hub could not clone ${repo}. Retry the clone from the Project, then choose it here.`,
        );
        break;
      }
      yield* Effect.sleep(REMOTE_WAIT_STEP);
    }
    const title = repo.split("/").at(-1) ?? repo;
    yield* recordAdd({
      actorUserId: input.actorUserId,
      spaceId: input.spaceId,
      repo,
      project: cloned.projectId,
      title,
      created: true,
    });
    return {
      project: { projectId: cloned.projectId, title, repo: state === "ok" ? repo : null, state },
      created: true,
      notes,
    } satisfies MakitaRepoAddResult;
  });

  const add = (
    input: MakitaRepoAddInput & { readonly actorUserId: UserId },
    cloner: MakitaProjectCloner,
  ) => lock.withPermits(1)(addNow(input, cloner));

  /** The person behind a WS session: never an agent, the Hub's shell or a one-Space session. */
  const sessionUser = Effect.gen(function* () {
    const actor = yield* CommandActor.resolve;
    if (actor._tag !== "User" || actor.via !== undefined || actor.spaceLimit !== undefined) {
      return yield* fail("forbidden", NOT_YOURS);
    }
    return UserId.make(actor.userId);
  });

  return MakitaRepoAdd.of({
    add,
    addForSession: Effect.fn("MakitaRepoAdd.addAsSession")(function* (
      input: MakitaRepoAddInput,
      cloner: MakitaProjectCloner,
    ) {
      return yield* add({ ...input, actorUserId: yield* sessionUser }, cloner);
    }),
  });
});

/** Needs Makita's GitHub client, a process runner (git, in each checkout) and the file system. */
export const layer = Layer.effect(MakitaRepoAdd, make);
