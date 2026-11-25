/**
 * Makita ticket 10: the machine side of a pushing task, through executor calls every machine
 * already serves (a Thread move uses them), so no machine needs anything new: the task's own
 * worktree on the Space's work place, and its upload to the Project's Hub repository. Nothing here
 * holds or passes Makita's token.
 */
import {
  CheckpointRef,
  type EnvironmentId,
  MakitaError,
  type ProjectId,
  type ProviderInstanceId,
  type SpaceId,
  type ThreadId,
  type UserId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as HubRepository from "../checkpointing/HubRepository.ts";
import * as EnvironmentExecutor from "../environment/EnvironmentExecutor.ts";
import * as EnvironmentRegistry from "../environments/EnvironmentRegistry.ts";

export interface MakitaWorktreeInput {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly spaceId: SpaceId;
  readonly creator: UserId;
  readonly providerInstanceId: ProviderInstanceId;
  /** Ticket 15: the machine dedicated to the Space its configuration chose; null, the Sandbox. */
  readonly machine: EnvironmentId | null;
  /** The base, in the Project's Hub repository (`makitaBaseRef`). */
  readonly baseRef: string;
  /** What the new worktree runs once made: the task's branch and the bot as author. */
  readonly setupCommand: string;
}

export interface MakitaWorktree {
  readonly environmentId: EnvironmentId;
  /** The worktree's path on that machine. */
  readonly cwd: string;
}

export interface MakitaUploadInput {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  /** Under the Thread's own prefix of the Hub repository (`makitaPushRef`). */
  readonly ref: string;
}

export class MakitaMachines extends Context.Service<
  MakitaMachines,
  {
    /** The Project's Hub repository (a bare one, on the Hub), made when missing. */
    readonly hubRepository: (projectId: ProjectId) => Effect.Effect<string, MakitaError>;
    /** Makes the task's own worktree where the Space's work runs. */
    readonly makeWorktree: (
      input: MakitaWorktreeInput,
    ) => Effect.Effect<MakitaWorktree, MakitaError>;
    /**
     * The Thread's machine captures its worktree into `ref` (a commit whose parent is its `HEAD`)
     * and uploads it to the Project's Hub repository, with the machine's own credential.
     */
    readonly uploadWorktree: (input: MakitaUploadInput) => Effect.Effect<void, MakitaError>;
  }
>()("t3/makita/MakitaMachines") {}

const fail = (reason: MakitaError["reason"], message: string) =>
  Effect.fail(new MakitaError({ reason, message }));

/** A failure's own words, one line, without anything that could be long. */
const why = (error: unknown) => {
  const text =
    typeof error === "object" && error !== null && "message" in error
      ? String((error as { readonly message: unknown }).message)
      : String(error);
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length > 300 ? `${line.slice(0, 299)}…` : line;
};

const make = Effect.gen(function* () {
  const repositories = yield* Effect.serviceOption(HubRepository.HubRepositories);
  const environments = yield* Effect.serviceOption(EnvironmentRegistry.EnvironmentRegistry);
  const executors = yield* Effect.serviceOption(EnvironmentExecutor.EnvironmentExecutorRegistry);
  const NOT_HERE = "This Hub keeps no repositories of its Projects, so Makita cannot push here.";

  const hubRepository = Effect.fn("MakitaMachines.hubRepository")(function* (projectId: ProjectId) {
    if (Option.isNone(repositories)) return yield* fail("invalid", NOT_HERE);
    return yield* repositories.value
      .ensure({ projectId })
      .pipe(
        Effect.catch((error) =>
          fail("storage", `Could not open the Project's Hub repository: ${why(error)}`),
        ),
      );
  });

  const executorOf = (environmentId: EnvironmentId) =>
    Option.isNone(executors)
      ? fail("invalid", NOT_HERE)
      : executors.value
          .get(environmentId)
          .pipe(
            Effect.catch(() =>
              fail(
                "github",
                "The machine where this task works is not connected. Try again later.",
              ),
            ),
          );

  const makeWorktree = Effect.fn("MakitaMachines.makeWorktree")(function* (
    input: MakitaWorktreeInput,
  ) {
    if (Option.isNone(environments)) return yield* fail("invalid", NOT_HERE);
    // «Where it works»: the Space's Sandbox, or (ticket 15) the machine dedicated to it that the
    // configuration chose; never a requested or preferred machine.
    const environmentId = yield* environments.value
      .chooseForThread({
        userId: input.creator,
        requested: undefined,
        projectId: input.projectId,
        providerInstanceId: input.providerInstanceId,
        spaceId: input.spaceId,
        spaceWorkOnly: true,
        ...(input.machine === null ? {} : { spaceWorkOn: input.machine }),
      })
      .pipe(
        Effect.catch((error) =>
          fail(
            "github",
            EnvironmentRegistry.environmentRefusalMessage(error) ??
              `No place to work: ${why(error)}`,
          ),
        ),
      );
    const executor = yield* executorOf(environmentId);
    const { move } = executor.workspace;
    const fetched = yield* move
      .fetch({ projectId: input.projectId, refs: [CheckpointRef.make(input.baseRef)] })
      .pipe(
        Effect.catch((error) => fail("github", `Could not bring the base there: ${why(error)}`)),
      );
    const prepared = yield* move
      .prepare({
        checkout: fetched.checkout,
        projectId: input.projectId,
        threadId: input.threadId,
        ref: null,
        branch: null,
        knownWorktree: null,
        setAsidePrefix: `${HubRepository.threadRefPrefixes(input.threadId)[1]}makita/`,
        setupScript: { name: "Makita workspace", command: input.setupCommand },
      })
      .pipe(
        Effect.catch((error) =>
          fail("github", `Could not make the task's worktree: ${why(error)}`),
        ),
      );
    // A worktree left half-made (a restart mid-way) is reused without the setup command: refused,
    // rather than a task on the wrong branch and author.
    if (prepared.setupScript.status !== "succeeded") {
      return yield* fail("github", "An earlier, unfinished worktree for this task is in the way.");
    }
    return { environmentId, cwd: prepared.cwd } satisfies MakitaWorktree;
  });

  const uploadWorktree = Effect.fn("MakitaMachines.uploadWorktree")(function* (
    input: MakitaUploadInput,
  ) {
    if (Option.isNone(executors)) return yield* fail("invalid", NOT_HERE);
    // Where the Thread runs now: a Makita Thread never moves, so anything else is refused.
    const active = yield* executors.value.activeEnvironment(input.threadId);
    if (active !== input.environmentId) {
      return yield* fail("forbidden", "This task's Thread no longer runs where its worktree is.");
    }
    const executor = yield* executorOf(input.environmentId);
    const ref = CheckpointRef.make(input.ref);
    yield* executor.workspace.checkpoints
      .captureCheckpoint({ cwd: input.cwd, checkpointRef: ref })
      .pipe(Effect.catch((error) => fail("github", `Could not read your worktree: ${why(error)}`)));
    yield* executor.workspace.hubRepository
      .push({ cwd: input.cwd, projectId: input.projectId, checkpointRefs: [ref] })
      .pipe(
        Effect.catch((error) =>
          fail("github", `Could not upload your worktree to the Hub: ${why(error)}`),
        ),
      );
  });

  return MakitaMachines.of({ hubRepository, makeWorktree, uploadWorktree });
});

/** Over the Hub's repositories, its Environments and their executors, where the Hub has them. */
export const layer = Layer.effect(MakitaMachines, make);
