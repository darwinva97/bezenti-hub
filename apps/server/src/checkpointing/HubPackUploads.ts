/**
 * Uploads too large for one request (a proxy such as Cloudflare's caps bodies at 100 MB) come as a
 * pack in byte ranges at `/api/git/<repo>/packs/<id>`, appended only where the Hub is, then are
 * applied in the background (polled). `gitRoute` checks the refs; this stages and applies them.
 * See docs/internals/overview.md, «Hub repository».
 */
import type { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as HubRepository from "./HubRepository.ts";
import * as HubRepositoryMaintenance from "./HubRepositoryMaintenance.ts";

/** The path segment after a repository's: `/api/git/<repo>/packs/<uploadId>`. */
export const PACK_UPLOADS_SEGMENT = "packs";
/** The most one part may carry: under a proxy's request limit, with room to spare. */
const PACK_PART_MAX_BYTES = 64 * 1024 * 1024;
/** An upload's id: hex, chosen by the machine from what it uploads (so a retry resumes it). */
export const PACK_UPLOAD_ID = /^[0-9a-f]{32,64}$/u;
/** A staged upload untouched this long is dropped. */
const STAGED_IDLE_MS = 2 * 60 * 60_000;
/** An earlier upload of the repository this quiet gives way to a new one at once. */
const SUPERSEDED_IDLE_MS = 10 * 60_000;
/** How long the Hub remembers how an apply ended. */
const JOB_MEMORY_MS = 60 * 60_000;

export const PackUploadState = Schema.Literals(["receiving", "applying", "done", "failed"]);
export type PackUploadState = typeof PackUploadState.Type;

/** What the Hub has of an upload; `size`: the bytes it holds, where the next part starts. */
export const PackUploadStatus = Schema.Struct({
  state: PackUploadState,
  size: Schema.Number,
  error: Schema.optionalKey(Schema.String),
});
export type PackUploadStatus = typeof PackUploadStatus.Type;

export const PackRefUpdate = Schema.Struct({ ref: Schema.String, newOid: Schema.String });
export type PackRefUpdate = typeof PackRefUpdate.Type;

/** The apply request: the upload's full size and the refs to set to what it brings. */
export const PackApplyRequest = Schema.Struct({
  size: Schema.Number,
  updates: Schema.Array(PackRefUpdate),
});
export type PackApplyRequest = typeof PackApplyRequest.Type;

export type PackAppendResult =
  | { readonly _tag: "appended"; readonly size: number }
  /** The part does not start where the Hub is: the machine resumes from `size`. */
  | { readonly _tag: "offset"; readonly size: number }
  | { readonly _tag: "tooLarge" };

class PartTooLarge extends Schema.TaggedError<PartTooLarge>()("PartTooLarge", {}) {}

/** A part's body could not be read (the machine went away mid-part). */
export class PackBodyError extends Schema.TaggedError<PackBodyError>()("PackBodyError", {
  cause: Schema.Defect(),
}) {}

/** The apply may not go on: the Project moved to another Space. */
export class PackAccessLost extends Schema.TaggedError<PackAccessLost>()("PackAccessLost", {
  detail: Schema.String,
}) {
  override get message() {
    return this.detail;
  }
}

/** Why the Hub could not apply an upload: git's own words, or what was missing. */
export class PackApplyError extends Schema.TaggedError<PackApplyError>()("PackApplyError", {
  detail: Schema.String,
}) {
  override get message() {
    return this.detail;
  }
}

const detailOf = (error: unknown) =>
  typeof error === "object" && error !== null && "detail" in error
    ? String((error as { readonly detail: unknown }).detail)
    : error instanceof Error
      ? error.message
      : String(error);

/** While the apply may go on: it fails once the Project moves, and is released when it ends. */
export interface PackApplyAccess {
  readonly lost: Effect.Effect<never, PackAccessLost>;
  readonly release: Effect.Effect<void>;
}

export class HubPackUploads extends Context.Service<
  HubPackUploads,
  {
    readonly status: (
      owner: EnvironmentId,
      key: HubRepository.HubRepositoryKey,
      uploadId: string,
    ) => Effect.Effect<PackUploadStatus>;
    readonly append: (
      owner: EnvironmentId,
      key: HubRepository.HubRepositoryKey,
      uploadId: string,
      input: {
        readonly offset: number;
        readonly body: Stream.Stream<Uint8Array, PackBodyError>;
        /** The most the whole upload may hold. */
        readonly maxBytes: number;
      },
    ) => Effect.Effect<PackAppendResult, PackBodyError | PlatformError.PlatformError>;
    /**
     * Starts applying the staged upload (the route checked the updates), or says how far it is.
     * `access` ends with the apply; it is released at once when nothing starts.
     */
    readonly apply: (
      owner: EnvironmentId,
      key: HubRepository.HubRepositoryKey,
      uploadId: string,
      request: PackApplyRequest,
      access: PackApplyAccess,
    ) => Effect.Effect<PackUploadStatus>;
  }
>()("t3/checkpointing/HubPackUploads") {}

const safeName = (value: string) => value.replace(/[^A-Za-z0-9._-]+/gu, "_");

export const layer = Layer.effect(
  HubPackUploads,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const vcs = yield* VcsProcess.VcsProcess;
    const repositories = yield* HubRepository.HubRepositories;
    const maintenance = yield* HubRepositoryMaintenance.HubRepositoryMaintenance;
    const scope = yield* Effect.scope;
    const root = path.join(config.stateDir, "hub-repository-uploads");

    const folderOf = (owner: EnvironmentId) => path.join(root, safeName(owner));
    const prefixOf = (key: HubRepository.HubRepositoryKey) =>
      `${safeName(repositories.directoryOf(key))}.`;
    const fileOf = (owner: EnvironmentId, key: HubRepository.HubRepositoryKey, uploadId: string) =>
      path.join(folderOf(owner), `${prefixOf(key)}${uploadId}.pack`);
    const sizeOf = (file: string) =>
      fileSystem.stat(file).pipe(
        Effect.map((info) => Number(info.size)),
        Effect.orElseSucceed(() => 0),
      );

    // One request at a time per upload; how each apply went, for a while.
    const locks = new Map<string, Semaphore.Semaphore>();
    const lockOf = (file: string) => {
      const existing = locks.get(file);
      if (existing !== undefined) return existing;
      const made = Semaphore.makeUnsafe(1);
      locks.set(file, made);
      return made;
    };
    const jobs = new Map<
      string,
      { state: "applying" | "done" | "failed"; error?: string; endedAt?: number }
    >();

    const statusOf = Effect.fn("HubPackUploads.status")(function* (
      owner: EnvironmentId,
      key: HubRepository.HubRepositoryKey,
      uploadId: string,
    ) {
      const file = fileOf(owner, key, uploadId);
      const size = yield* sizeOf(file);
      const job = jobs.get(file);
      if (job === undefined) return { state: "receiving", size } satisfies PackUploadStatus;
      return {
        state: job.state,
        size,
        ...(job.error === undefined ? {} : { error: job.error }),
      } satisfies PackUploadStatus;
    });

    const append: HubPackUploads["Service"]["append"] = (owner, key, uploadId, input) => {
      const file = fileOf(owner, key, uploadId);
      return lockOf(file).withPermits(1)(
        Effect.gen(function* () {
          const size = yield* sizeOf(file);
          if (input.offset !== size) return { _tag: "offset", size } as const;
          if (jobs.get(file)?.state === "applying") return { _tag: "offset", size } as const;
          jobs.delete(file);
          yield* fileSystem.makeDirectory(folderOf(owner), { recursive: true });
          if (size === 0) {
            // A new upload to the repository supersedes the machine's earlier ones that went
            // quiet; one still receiving (a move's push beside an upload) stays.
            const nowMs = yield* Clock.currentTimeMillis;
            const others = yield* fileSystem
              .readDirectory(folderOf(owner))
              .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
            for (const name of others) {
              const other = path.join(folderOf(owner), name);
              if (!name.startsWith(prefixOf(key)) || other === file) continue;
              if (jobs.get(other)?.state === "applying") continue;
              const modified = Option.flatMap(
                yield* fileSystem.stat(other).pipe(Effect.option),
                (info) => info.mtime,
              );
              if (
                Option.isSome(modified) &&
                nowMs - modified.value.getTime() < SUPERSEDED_IDLE_MS
              ) {
                continue;
              }
              yield* fileSystem.remove(other, { force: true }).pipe(Effect.ignore);
            }
          }
          let written = 0;
          const outcome = yield* Effect.scoped(
            Effect.gen(function* () {
              const handle = yield* fileSystem.open(file, { flag: "a" });
              yield* Stream.runForEach(
                input.body,
                (chunk): Effect.Effect<void, PartTooLarge | PlatformError.PlatformError> => {
                  written += chunk.length;
                  return written > PACK_PART_MAX_BYTES || size + written > input.maxBytes
                    ? Effect.fail(new PartTooLarge())
                    : handle.writeAll(chunk);
                },
              );
            }),
          ).pipe(Effect.result);
          if (outcome._tag === "Failure") {
            if (outcome.failure._tag === "PartTooLarge") {
              // Whatever of it was written is a correct prefix; past the upload's limit, none is.
              if (size + written > input.maxBytes) {
                yield* fileSystem.remove(file, { force: true }).pipe(Effect.ignore);
              }
              return { _tag: "tooLarge" } as const;
            }
            return yield* outcome.failure;
          }
          return { _tag: "appended", size: yield* sizeOf(file) } as const;
        }),
      );
    };

    const fail = (detail: string) => new PackApplyError({ detail: detail.trim().slice(0, 2_000) });

    /** Indexes the staged pack into the repository, checks the refs' objects, sets the refs. */
    const applyStaged = Effect.fn("HubPackUploads.applyStaged")(function* (
      repository: string,
      file: string,
      updates: ReadonlyArray<PackRefUpdate>,
    ) {
      const inRepository = (args: ReadonlyArray<string>, stdin?: string) =>
        HubRepository.gitIn(vcs, {
          operation: "HubPackUploads.apply",
          cwd: repositories.root,
          args: ["--git-dir", repository, ...args],
          ...(stdin === undefined ? {} : { stdin }),
        }).pipe(Effect.mapError((error) => fail(detailOf(error))));
      // The pack and its index only: a reverse index would have to move with them.
      const indexed = yield* inRepository([
        "-c",
        "pack.writeReverseIndex=false",
        "index-pack",
        "--strict",
        file,
      ]);
      const hash = indexed.stdout.trim().split(/\s+/u).at(-1) ?? "";
      if (!/^[0-9a-f]{40,64}$/u.test(hash)) return yield* fail("git index-pack named no pack.");
      const packs = path.join(repository, "objects", "pack");
      yield* fileSystem.makeDirectory(packs, { recursive: true });
      // The pack before its index: git finds a pack by its index.
      const index = file.replace(/\.pack$/u, ".idx");
      yield* fileSystem.rename(file, path.join(packs, `pack-${hash}.pack`));
      yield* fileSystem.rename(index, path.join(packs, `pack-${hash}.idx`));
      // Every object the new refs reach is in the repository now.
      // The tips are arguments, not stdin: git before 2.40 refuses `--not` and `--all` among the
      // revisions read from stdin. They are hex (`gitRoute` checks them), so none reads as an
      // option, and the few refs of one upload fit any argument limit.
      yield* inRepository([
        "rev-list",
        "--objects",
        "--quiet",
        ...updates.map((update) => update.newOid),
        "--not",
        "--all",
      ]);
      yield* inRepository(
        ["update-ref", "--stdin"],
        `${updates
          .map((update) =>
            HubRepository.isCreateOnlyRef(update.ref)
              ? `create ${update.ref} ${update.newOid}`
              : `update ${update.ref} ${update.newOid}`,
          )
          .join("\n")}\n`,
      );
    });

    const apply: HubPackUploads["Service"]["apply"] = (owner, key, uploadId, request, access) => {
      const file = fileOf(owner, key, uploadId);
      return lockOf(file)
        .withPermits(1)(
          Effect.gen(function* () {
            const job = jobs.get(file);
            if (job?.state === "applying" || job?.state === "done") {
              yield* access.release;
              return yield* statusOf(owner, key, uploadId);
            }
            const repository = yield* repositories.ensure(key).pipe(Effect.orDie);
            // Already there (an apply that ended before the Hub restarted): nothing to do.
            const current = yield* HubRepository.gitIn(vcs, {
              operation: "HubPackUploads.apply",
              cwd: repositories.root,
              args: [
                "--git-dir",
                repository,
                "for-each-ref",
                "--format=%(objectname) %(refname)",
                ...request.updates.map((update) => update.ref),
              ],
            }).pipe(Effect.orElseSucceed(() => ({ stdout: "" })));
            const now = new Map(
              current.stdout
                .split("\n")
                .filter((line) => line.length > 0)
                .map((line) => {
                  const [oid, ref] = line.split(" ");
                  return [ref ?? "", oid ?? ""] as const;
                }),
            );
            if (request.updates.every((update) => now.get(update.ref) === update.newOid)) {
              yield* access.release;
              yield* fileSystem.remove(file, { force: true }).pipe(Effect.ignore);
              jobs.set(file, { state: "done", endedAt: yield* Clock.currentTimeMillis });
              return yield* statusOf(owner, key, uploadId);
            }
            const size = yield* sizeOf(file);
            if (size !== request.size) {
              yield* access.release;
              return { state: "receiving", size } satisfies PackUploadStatus;
            }
            const running = { state: "applying" as const };
            jobs.set(file, running);
            yield* Effect.raceFirst(
              maintenance.exclusive(repository)(applyStaged(repository, file, request.updates)),
              access.lost,
            ).pipe(
              Effect.exit,
              Effect.flatMap((exit) =>
                Effect.gen(function* () {
                  const endedAt = yield* Clock.currentTimeMillis;
                  if (Exit.isSuccess(exit)) {
                    jobs.set(file, { state: "done", endedAt });
                    yield* maintenance.compactSoon(repository);
                  } else {
                    const error = detailOf(Cause.squash(exit.cause));
                    jobs.set(file, { state: "failed", error, endedAt });
                    yield* Effect.logWarning("A pack upload to the Hub repository failed", {
                      owner,
                      projectId: key.projectId,
                      error,
                    });
                  }
                  // A failed apply starts over from the first byte; a done one keeps nothing.
                  yield* fileSystem.remove(file, { force: true }).pipe(Effect.ignore);
                  yield* fileSystem
                    .remove(file.replace(/\.pack$/u, ".idx"), { force: true })
                    .pipe(Effect.ignore);
                }),
              ),
              Effect.ensuring(access.release),
              Effect.forkIn(scope),
            );
            return { state: "applying", size } satisfies PackUploadStatus;
          }),
        )
        .pipe(Effect.onInterrupt(() => access.release));
    };

    // Drops staged uploads nobody finished, and old outcomes.
    const sweep = Effect.gen(function* () {
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      for (const [file, job] of jobs) {
        if (job.endedAt !== undefined && nowMs - job.endedAt > JOB_MEMORY_MS) jobs.delete(file);
      }
      const owners = yield* fileSystem
        .readDirectory(root)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      for (const owner of owners) {
        const folder = path.join(root, owner);
        const names = yield* fileSystem
          .readDirectory(folder)
          .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
        for (const name of names) {
          const file = path.join(folder, name);
          if (jobs.get(file)?.state === "applying") continue;
          const info = yield* fileSystem.stat(file).pipe(Effect.option);
          const modified = Option.flatMap(info, (stat) => stat.mtime);
          if (Option.isSome(modified) && nowMs - modified.value.getTime() > STAGED_IDLE_MS) {
            yield* fileSystem.remove(file, { force: true }).pipe(Effect.ignore);
            locks.delete(file);
          }
        }
      }
    });
    yield* sweep.pipe(
      Effect.ignore,
      Effect.repeat(Schedule.spaced("10 minutes")),
      Effect.forkIn(scope),
    );

    return HubPackUploads.of({ status: statusOf, append, apply });
  }),
);
