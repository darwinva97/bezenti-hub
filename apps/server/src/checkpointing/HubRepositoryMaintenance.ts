/**
 * Compacts the Hub repositories (each upload lands as a pack of its own, and git runs with
 * `gc.auto=0` here), and refuses uploads while the state volume is almost full.
 * See docs/internals/overview.md, «Hub repository».
 */
import { VcsProcessExitError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import { formatBytes, hostSpaceOf, type HostSpace } from "../sandboxes/sandboxLimits.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as HubRepository from "./HubRepository.ts";

const MIB = 1024 ** 2;
/** Room the Hub keeps free on its state volume: its database must always be able to write. */
const diskFloorOf = (totalBytes: number) => Math.max(512 * MIB, Math.floor(totalBytes * 0.05));
/** Used past this share, the sweep warns that the Hub's disk is filling. */
const DISK_WARN_SHARE = 0.8;
/** A repack of a large repository is read and written whole: more than a transfer's time. */
const REPACK_TIMEOUT_MS = 60 * 60_000;
/** Lines of `cat-file --batch-all-objects`, up to some millions of objects. */
const OBJECT_LIST_MAX_BYTES = 64 * MIB;

export type CompactionOutcome =
  | { readonly _tag: "notNeeded" }
  | { readonly _tag: "compacted"; readonly packsBefore: number; readonly packsAfter: number }
  /** Too little room on the state volume for the result: skipped, never started. */
  | { readonly _tag: "noRoom"; readonly neededBytes: number; readonly freeBytes: number };

export class HubRepositoryMaintenance extends Context.Service<
  HubRepositoryMaintenance,
  {
    /** Runs `effect` (an apply) with no compaction of `repository` beside it. */
    readonly exclusive: (
      repository: string,
    ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    /** Compacts the repository now, if it needs it and there is room. */
    readonly compact: (repository: string) => Effect.Effect<CompactionOutcome>;
    /** Compacts the repository a little later, off the caller's fiber; uploads close together share one. */
    readonly compactSoon: (repository: string) => Effect.Effect<void>;
    /** Why an upload of about `bytes` may not land now (the state volume is almost full), if so. */
    readonly uploadRefusal: (bytes: number) => Effect.Effect<string | undefined>;
  }
>()("t3/checkpointing/HubRepositoryMaintenance") {}

export interface MaintenanceOptions {
  /** The filesystem a path is on; null where it cannot be told (tests set it). */
  readonly diskSpace?: (path: string) => Effect.Effect<HostSpace | null>;
  /** How long after an upload its repository is compacted. */
  readonly soonAfter?: Duration.Input;
  /** The first sweep (every repository) after the Hub starts, then every `sweepEvery`. */
  readonly firstSweepAfter?: Duration.Input;
  readonly sweepEvery?: Duration.Input;
}

interface ObjectCounts {
  readonly packs: number;
  readonly loose: number;
  /** Bytes on disk of every pack and loose object, duplicates included. */
  readonly bytes: number;
}

/** `git count-objects -v`: its `key: value` lines, sizes in KiB. */
const parseCounts = (text: string): ObjectCounts => {
  const values = new Map(
    text
      .split("\n")
      .map((line) => line.split(":").map((part) => part.trim()))
      .filter((pair): pair is [string, string] => pair.length === 2)
      .map(([key, value]) => [key, Number.parseInt(value, 10) || 0] as const),
  );
  return {
    packs: values.get("packs") ?? 0,
    loose: values.get("count") ?? 0,
    bytes: ((values.get("size-pack") ?? 0) + (values.get("size") ?? 0)) * 1024,
  };
};

const make = Effect.fn("HubRepositoryMaintenance.make")(function* (
  options: MaintenanceOptions = {},
) {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcs = yield* VcsProcess.VcsProcess;
  const repositories = yield* HubRepository.HubRepositories;
  const scope = yield* Effect.scope;
  const diskSpace =
    options.diskSpace ?? ((target: string) => Effect.sync(() => hostSpaceOf(target)));

  const locks = new Map<string, Semaphore.Semaphore>();
  const lockOf = (repository: string) => {
    const existing = locks.get(repository);
    if (existing !== undefined) return existing;
    const made = Semaphore.makeUnsafe(1);
    locks.set(repository, made);
    return made;
  };
  const exclusive =
    (repository: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      lockOf(repository).withPermits(1)(effect);

  const git = (
    repository: string,
    args: ReadonlyArray<string>,
    options: { readonly maxOutputBytes?: number; readonly timeoutMs?: number } = {},
  ) =>
    vcs
      .run({
        operation: "HubRepositoryMaintenance.compact",
        command: "git",
        cwd: repositories.root,
        args: ["--git-dir", repository, "-c", "gc.auto=0", ...args],
        allowNonZeroExit: true,
        ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      })
      .pipe(
        Effect.filterOrFail(
          (output) => output.exitCode === 0,
          (output) =>
            new VcsProcessExitError({
              operation: "HubRepositoryMaintenance.compact",
              command: "git",
              cwd: repository,
              exitCode: output.exitCode,
              detail: output.stderr.trim().slice(0, 2_000) || "git failed.",
            }),
        ),
      );

  const countsOf = (repository: string) =>
    git(repository, ["count-objects", "-v"]).pipe(Effect.map((out) => parseCounts(out.stdout)));

  /** Bytes on disk of each object once: about what one pack of everything takes. */
  const uniqueBytesOf = (repository: string) =>
    git(repository, ["cat-file", "--batch-all-objects", "--batch-check=%(objectsize:disk)"], {
      maxOutputBytes: OBJECT_LIST_MAX_BYTES,
    }).pipe(
      Effect.map((out) =>
        out.stdoutTruncated
          ? null
          : out.stdout.split("\n").reduce((sum, line) => sum + (Number.parseInt(line, 10) || 0), 0),
      ),
    );

  const compactNow = Effect.fn("HubRepositoryMaintenance.compact")(function* (repository: string) {
    const before = yield* countsOf(repository);
    if (before.packs <= 1 && before.loose === 0) return { _tag: "notNeeded" } as const;
    // The new pack is written before the old ones go: the volume must hold it beside them.
    const space = yield* diskSpace(repository);
    if (space !== null) {
      const floor = diskFloorOf(space.totalBytes);
      if (space.freeBytes < before.bytes + floor) {
        const unique = (yield* uniqueBytesOf(repository)) ?? before.bytes;
        if (space.freeBytes < unique + floor) {
          return {
            _tag: "noRoom",
            neededBytes: unique + floor,
            freeBytes: space.freeBytes,
          } as const;
        }
      }
    }
    // Geometric: keeps every object of the packs it rolls up, reachable or not, and never touches
    // a pack that appears meanwhile, so a push or apply beside it loses nothing. One thread,
    // bounded memory, no delta search on large files (a checkpoint may hold a video).
    yield* git(
      repository,
      [
        "-c",
        "pack.threads=1",
        "-c",
        "pack.windowMemory=128m",
        "-c",
        "pack.deltaCacheSize=32m",
        "-c",
        "core.bigFileThreshold=32m",
        "-c",
        "repack.writeBitmaps=false",
        "repack",
        "-d",
        "-q",
        "--geometric=2",
      ],
      { timeoutMs: REPACK_TIMEOUT_MS },
    );
    const after = yield* countsOf(repository);
    return { _tag: "compacted", packsBefore: before.packs, packsAfter: after.packs } as const;
  });

  const compact = (repository: string) =>
    exclusive(repository)(compactNow(repository)).pipe(
      Effect.tap((outcome) =>
        outcome._tag === "noRoom"
          ? Effect.logWarning("A Hub repository is not compacted: its disk is almost full", {
              repository: path.basename(repository),
              neededBytes: outcome.neededBytes,
              freeBytes: outcome.freeBytes,
            })
          : Effect.void,
      ),
      Effect.catch((cause) =>
        Effect.logWarning("A Hub repository could not be compacted", {
          repository: path.basename(repository),
          cause,
        }).pipe(Effect.as({ _tag: "notNeeded" } as const)),
      ),
    );

  const soonAfter = options.soonAfter ?? Duration.seconds(30);
  const pending = new Set<string>();
  const compactSoon = (repository: string) =>
    Effect.suspend(() => {
      if (pending.has(repository)) return Effect.void;
      pending.add(repository);
      return Effect.sleep(soonAfter).pipe(
        Effect.andThen(Effect.sync(() => pending.delete(repository))),
        Effect.andThen(compact(repository)),
        Effect.ensuring(Effect.sync(() => pending.delete(repository))),
        Effect.forkIn(scope),
        Effect.asVoid,
      );
    });

  const uploadRefusal = Effect.fn("HubRepositoryMaintenance.uploadRefusal")(function* (
    bytes: number,
  ) {
    const space = yield* diskSpace(config.stateDir);
    if (space === null) return undefined;
    if (space.freeBytes - Math.max(0, bytes) >= diskFloorOf(space.totalBytes)) return undefined;
    return `The Hub's disk is almost full (${formatBytes(space.freeBytes)} free of ${formatBytes(space.totalBytes)}): uploads wait until there is room.`;
  });

  /** Every repository: the Projects' at the root, Threads' own under `threads/`. */
  const listRepositories = Effect.gen(function* () {
    const found: Array<string> = [];
    for (const folder of [repositories.root, path.join(repositories.root, "threads")]) {
      const names = yield* fileSystem
        .readDirectory(folder)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      for (const name of names.toSorted()) {
        if (name.endsWith(".git")) found.push(path.join(folder, name));
      }
    }
    return found;
  });

  const sweep = Effect.gen(function* () {
    const found = yield* listRepositories;
    // Only a Hub keeps repositories: a joined machine's disk is none of this.
    if (found.length === 0) return;
    const space = yield* diskSpace(config.stateDir);
    if (space !== null && space.totalBytes > 0) {
      const used = 1 - space.freeBytes / space.totalBytes;
      if (used > DISK_WARN_SHARE) {
        yield* Effect.logWarning("The Hub's disk is filling", {
          usedPercent: Math.round(used * 100),
          freeBytes: space.freeBytes,
          totalBytes: space.totalBytes,
        });
      }
    }
    for (const repository of found) {
      const outcome = yield* compact(repository);
      if (outcome._tag === "compacted" && outcome.packsBefore > outcome.packsAfter) {
        yield* Effect.logInfo("Compacted a Hub repository", {
          repository: path.basename(repository),
          packsBefore: outcome.packsBefore,
          packsAfter: outcome.packsAfter,
        });
      }
    }
  });
  yield* Effect.sleep(options.firstSweepAfter ?? Duration.minutes(1)).pipe(
    Effect.andThen(
      sweep.pipe(Effect.ignore, Effect.repeat(Schedule.spaced(options.sweepEvery ?? "1 hour"))),
    ),
    Effect.forkIn(scope),
  );

  return HubRepositoryMaintenance.of({ exclusive, compact, compactSoon, uploadRefusal });
});

export const layer = Layer.effect(HubRepositoryMaintenance, make());

/** For tests: the disk's space and the timings they choose. */
export const layerWith = (options: MaintenanceOptions) =>
  Layer.effect(HubRepositoryMaintenance, make(options));
