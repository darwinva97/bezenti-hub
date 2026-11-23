import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import type { HostSpace } from "../sandboxes/sandboxLimits.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as HubRepository from "./HubRepository.ts";
import * as HubRepositoryMaintenance from "./HubRepositoryMaintenance.ts";

const GIB = 1024 ** 3;

/** A Hub repository on disk with real git, and a checkout to make uploads from. */
const withHubRepository = <A, E>(
  space: () => HostSpace | null,
  body: (input: {
    readonly maintenance: HubRepositoryMaintenance.HubRepositoryMaintenance["Service"];
    readonly repository: string;
    readonly checkout: string;
    readonly git: (
      cwd: string,
      args: ReadonlyArray<string>,
      stdin?: string,
    ) => Effect.Effect<string>;
  }) => Effect.Effect<A, E, FileSystem.FileSystem | Scope.Scope>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const vcs = yield* VcsProcess.VcsProcess;
    const git = (cwd: string, args: ReadonlyArray<string>, stdin?: string) =>
      vcs
        .run({
          operation: "HubRepositoryMaintenance.test",
          command: "git",
          cwd,
          args: ["-c", "user.email=t@t", "-c", "user.name=T", ...args],
          ...(stdin === undefined ? {} : { stdin }),
          timeoutMs: 120_000,
        })
        .pipe(
          Effect.map((output) => output.stdout.trim()),
          Effect.orDie,
        );
    const context = yield* Layer.build(
      HubRepositoryMaintenance.layerWith({ diskSpace: () => Effect.sync(space) }).pipe(
        Layer.provideMerge(HubRepository.layer),
        Layer.provide(SqlitePersistence.layerMemory),
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-hub-maintenance-" })),
      ),
    );
    const repositories = Context.get(context, HubRepository.HubRepositories);
    const maintenance = Context.get(context, HubRepositoryMaintenance.HubRepositoryMaintenance);
    const repository = yield* repositories
      .ensure({ projectId: ProjectId.make("project:maintenance") })
      .pipe(Effect.orDie);
    const checkout = yield* fs.makeTempDirectoryScoped({ prefix: "t3-hub-maintenance-checkout-" });
    yield* git(checkout, ["init", "--quiet"]);
    return yield* body({ maintenance, repository, checkout, git });
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        VcsProcess.layer.pipe(Layer.provide(NodeServices.layer)),
        NodeServices.layer,
        NodeCrypto.layer,
      ),
    ),
  );

/** Bytes that do not compress (xorshift), so a pack is as large as the file. */
const noise = (length: number) => {
  const bytes = new Uint8Array(length);
  let state = 0x9e3779b9;
  for (let index = 0; index < length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[index] = state & 0xff;
  }
  return bytes;
};

const counts = (
  git: (cwd: string, args: ReadonlyArray<string>) => Effect.Effect<string>,
  repository: string,
) =>
  git(repository, ["--git-dir", repository, "count-objects", "-v"]).pipe(
    Effect.map((text) => {
      const value = (key: string) =>
        Number.parseInt(new RegExp(`^${key}: (\\d+)$`, "mu").exec(text)?.[1] ?? "0", 10);
      return { packs: value("packs"), packKiB: value("size-pack"), loose: value("count") };
    }),
  );

/**
 * Lands the checkout's `commit` in the repository as the Hub applies an upload: a pack of all it
 * reaches (what a machine sent when nothing it excluded marked its files as sent), indexed and moved
 * into `objects/pack`, then `ref` set, unless `ref` is undefined.
 */
const landFullCopy = Effect.fn(function* (
  git: (cwd: string, args: ReadonlyArray<string>, stdin?: string) => Effect.Effect<string>,
  input: {
    readonly checkout: string;
    readonly repository: string;
    readonly commit: string;
    readonly ref: string | undefined;
  },
) {
  const fs = yield* FileSystem.FileSystem;
  const staging = yield* fs
    .makeTempDirectoryScoped({ prefix: "t3-hub-maintenance-pack-" })
    .pipe(Effect.orDie);
  const hash = yield* git(
    input.checkout,
    ["pack-objects", "--revs", "--quiet", `${staging}/upload`],
    `${input.commit}\n`,
  );
  yield* git(input.repository, [
    "--git-dir",
    input.repository,
    "index-pack",
    "--strict",
    `${staging}/upload-${hash}.pack`,
  ]);
  for (const extension of ["pack", "idx"]) {
    yield* fs
      .rename(
        `${staging}/upload-${hash}.${extension}`,
        `${input.repository}/objects/pack/pack-${hash}.${extension}`,
      )
      .pipe(Effect.orDie);
  }
  if (input.ref !== undefined) {
    yield* git(input.repository, [
      "--git-dir",
      input.repository,
      "update-ref",
      input.ref,
      input.commit,
    ]);
  }
});

/** A checkpoint of the checkout's files with no parent, as with no commit yet: `big.bin` and `turn`. */
const checkpoint = Effect.fn(function* (
  git: (cwd: string, args: ReadonlyArray<string>, stdin?: string) => Effect.Effect<string>,
  checkout: string,
  turn: number,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(`${checkout}/turn.txt`, `turn ${turn}\n`).pipe(Effect.orDie);
  yield* git(checkout, ["add", "-A"]);
  const tree = yield* git(checkout, ["write-tree"]);
  return yield* git(checkout, ["commit-tree", tree, "-m", `checkpoint ${turn}`]);
});

const BIG = 512 * 1024;
const roomy = () => ({ freeBytes: 100 * GIB, totalBytes: 200 * GIB });

it.effect(
  "uploads that each carried the whole Project are compacted to one copy, every ref intact",
  () =>
    withHubRepository(roomy, ({ maintenance, repository, checkout, git }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFile(`${checkout}/big.bin`, noise(BIG)).pipe(Effect.orDie);
        const refs: Array<readonly [string, string]> = [];
        // Turns of several Threads, each upload a full copy: the incident's shape.
        for (let turn = 1; turn <= 8; turn += 1) {
          const commit = yield* checkpoint(git, checkout, turn);
          const ref = `refs/t3/threads/thread-${turn % 3}/turn/${turn}`;
          yield* landFullCopy(git, { checkout, repository, commit, ref });
          refs.push([ref, commit]);
        }
        const before = yield* counts(git, repository);
        assert.equal(before.packs, 8);
        assert.isAbove(before.packKiB * 1024, 7 * BIG);

        const outcome = yield* maintenance.compact(repository);
        assert.equal(outcome._tag, "compacted");
        const after = yield* counts(git, repository);
        assert.isAtMost(after.packs, 2);
        // One copy of the large file, not one per upload.
        assert.isBelow(after.packKiB * 1024, 2 * BIG);
        yield* git(repository, ["--git-dir", repository, "fsck", "--connectivity-only"]);
        for (const [ref, commit] of refs) {
          assert.equal(yield* git(repository, ["--git-dir", repository, "rev-parse", ref]), commit);
        }
        // Nothing more to do: the next compaction leaves it as it is.
        const again = yield* maintenance.compact(repository);
        assert.notEqual(again._tag, "noRoom");
        assert.equal((yield* counts(git, repository)).packs, after.packs);
      }),
    ),
);

it.effect("an upload landed but not yet referenced loses nothing to a compaction beside it", () =>
  withHubRepository(roomy, ({ maintenance, repository, checkout, git }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFile(`${checkout}/big.bin`, noise(BIG)).pipe(Effect.orDie);
      const first = yield* checkpoint(git, checkout, 1);
      yield* landFullCopy(git, { checkout, repository, commit: first, ref: "refs/t3/a" });
      // An apply between its index-pack and its update-ref: the pack is there, no ref yet.
      const second = yield* checkpoint(git, checkout, 2);
      yield* landFullCopy(git, { checkout, repository, commit: second, ref: undefined });
      // And loose objects of a push.
      yield* git(repository, ["--git-dir", repository, "hash-object", "-w", "--stdin"], "loose\n");

      assert.equal((yield* maintenance.compact(repository))._tag, "compacted");
      const after = yield* counts(git, repository);
      assert.equal(after.loose, 0);
      // The apply ends: its ref reaches only objects still there.
      yield* git(repository, ["--git-dir", repository, "update-ref", "refs/t3/b", second]);
      yield* git(repository, ["--git-dir", repository, "fsck", "--connectivity-only"]);
    }),
  ),
);

it.effect("with too little room for the result, nothing is compacted and nothing goes", () => {
  let space: HostSpace = roomy();
  return withHubRepository(
    () => space,
    ({ maintenance, repository, checkout, git }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFile(`${checkout}/big.bin`, noise(BIG)).pipe(Effect.orDie);
        for (let turn = 1; turn <= 3; turn += 1) {
          const commit = yield* checkpoint(git, checkout, turn);
          yield* landFullCopy(git, { checkout, repository, commit, ref: `refs/t3/${turn}` });
        }
        // Free: the floor the Hub keeps (512 MiB of 10 GiB), and less than one copy more.
        space = { freeBytes: 512 * 1024 * 1024 + 100 * 1024, totalBytes: 10 * GIB };
        const outcome = yield* maintenance.compact(repository);
        assert.equal(outcome._tag, "noRoom");
        assert.equal((yield* counts(git, repository)).packs, 3);
        // An upload that would take the floor waits too, until there is room.
        assert.include(
          (yield* maintenance.uploadRefusal(1024 * 1024)) ?? "",
          "The Hub's disk is almost full",
        );
        space = roomy();
        assert.isUndefined(yield* maintenance.uploadRefusal(1024));
        assert.equal((yield* maintenance.compact(repository))._tag, "compacted");
      }),
  );
});
