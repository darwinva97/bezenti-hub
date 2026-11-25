// @effect-diagnostics nodeBuiltinImport:off -- a new Project's id, synchronous and small.
/**
 * Makita ticket 21: a GitHub repository cloned as a new Project of a named Space, for a User, by
 * the Hub's own clone path (`ProjectCloneTracker`, the hooks of WS `projectClone.start`), into a
 * new folder of the Hub's Projects folder. Never with Makita's token: the Hub's own git access.
 */
import * as NodeCrypto from "node:crypto";

import {
  type OrchestrationDispatchCommandError,
  ProjectId,
  type SourceControlRepositoryError,
  type SpaceId,
  type UserId,
} from "@t3tools/contracts";
import { newProjectFolderName } from "@t3tools/shared/path";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as CommandActor from "../auth/CommandActor.ts";
import type * as ProjectCloneTracker from "./ProjectCloneTracker.ts";
import { type ProjectCloneHookDeps, projectCloneHooks } from "./projectCloneHooks.ts";

/** At most this many `-n` suffixes are tried for a free folder name. */
const MAX_SUFFIX = 50;

/** Why no Project could be started, in words for the person. */
class CloneIntoSpaceError extends Schema.TaggedError<CloneIntoSpaceError>()("CloneIntoSpaceError", {
  message: Schema.String,
}) {}

/** Any failure of a clone into a Space, said in one line for the person. */
export const cloneFailureMessage = (
  error: CloneIntoSpaceError | SourceControlRepositoryError | OrchestrationDispatchCommandError,
) => (error._tag === "SourceControlRepositoryError" ? error.detail : error.message);

interface CloneIntoSpaceInput {
  readonly spaceId: SpaceId;
  readonly actorUserId: UserId;
  /** `owner/name`, as GitHub spells it. */
  readonly repo: string;
}

interface ClonedIntoSpace {
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  /** Where its clone stands now: running, done, failed or cancelled; null once forgotten. */
  readonly phase: Effect.Effect<string | null>;
}

export const cloneIntoSpace = Effect.fn("cloneIntoSpace")(function* (
  deps: {
    readonly tracker: ProjectCloneTracker.ProjectCloneTracker["Service"];
    readonly hooks: ProjectCloneHookDeps;
    readonly projectsRoot: string;
    /** Where this User may root a new Project (`requireCloneDestination`, as a Project). */
    readonly requireDestination: (
      destinationPath: string,
    ) => Effect.Effect<void, SourceControlRepositoryError>;
  },
  input: CloneIntoSpaceInput,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const name = input.repo.split("/").at(-1) ?? input.repo;
  const base = newProjectFolderName(name);
  let destination: string | undefined;
  for (let n = 1; n <= MAX_SUFFIX && destination === undefined; n += 1) {
    const candidate = path.join(deps.projectsRoot, n === 1 ? base : `${base}-${n}`);
    if (!(yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => true)))) {
      destination = candidate;
    }
  }
  if (destination === undefined) {
    return yield* new CloneIntoSpaceError({
      message: `No free folder for ${name} in the Hub's Projects folder.`,
    });
  }
  yield* deps.requireDestination(destination);
  const projectId = ProjectId.make(NodeCrypto.randomUUID());
  const started = yield* deps.tracker
    .start(
      {
        projectId,
        title: name,
        createdAt: DateTime.formatIso(yield* DateTime.now),
        remoteUrl: `https://github.com/${input.repo}.git`,
        destinationPath: destination,
        protocol: "https",
      },
      projectCloneHooks(
        { ...deps.hooks, verifyDestination: deps.requireDestination },
        { spaceId: input.spaceId, actorUserId: input.actorUserId },
      ),
      input.actorUserId,
    )
    .pipe(CommandActor.actAsResolved({ _tag: "User", userId: input.actorUserId }));
  return {
    projectId,
    workspaceRoot: started.cwd,
    phase: deps.tracker
      .get(projectId)
      .pipe(Effect.map((snapshot) => (snapshot === null ? null : snapshot.phase))),
  } satisfies ClonedIntoSpace;
});
