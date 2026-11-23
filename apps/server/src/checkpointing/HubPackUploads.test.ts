import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, VcsProcessExitError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as HubPackUploads from "./HubPackUploads.ts";
import * as HubRepository from "./HubRepository.ts";
import * as HubRepositoryMaintenance from "./HubRepositoryMaintenance.ts";

const ok = (stdout: string): VcsProcess.VcsProcessOutput => ({
  exitCode: 0 as VcsProcess.VcsProcessOutput["exitCode"],
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const TIP = "a".repeat(40);
const OTHER_TIP = "b".repeat(40);

it.effect("applying an upload hands rev-list its tips as arguments, as git 2.39 needs", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const repository = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-hub-pack-" });
      const runs: Array<{ args: ReadonlyArray<string>; stdin: string | undefined }> = [];
      // Git before 2.40 rejects options (`--not`, `--all`) among the revisions on stdin.
      const fake = VcsProcess.VcsProcess.of({
        run: (input) =>
          Effect.suspend(() => {
            runs.push({ args: input.args, stdin: input.stdin });
            if (input.args.includes("index-pack")) {
              // Git writes the index beside the pack it was given.
              const pack = input.args.at(-1) ?? "";
              return fileSystem
                .writeFileString(pack.replace(/\.pack$/u, ".idx"), "index")
                .pipe(Effect.as(ok(`${"c".repeat(40)}\n`)), Effect.orDie);
            }
            if (
              input.args.includes("rev-list") &&
              input.args.includes("--stdin") &&
              (input.stdin ?? "").split("\n").some((line) => line.startsWith("--"))
            ) {
              return Effect.fail(
                new VcsProcessExitError({
                  operation: input.operation,
                  command: "git",
                  cwd: input.cwd,
                  exitCode: 128,
                  detail: "fatal: options not supported in --stdin mode",
                }),
              );
            }
            return Effect.succeed(ok(""));
          }),
      });
      const repositories = HubRepository.HubRepositories.of({
        root: repository,
        directoryOf: () => "project",
        ensure: () => Effect.succeed(repository),
      } as unknown as HubRepository.HubRepositories["Service"]);
      // Built in this test's scope: the apply runs on the layer's, which must outlive the call.
      const uploads = yield* Layer.build(
        HubPackUploads.layer.pipe(
          Layer.provide(HubRepositoryMaintenance.layer),
          Layer.provide(Layer.succeed(VcsProcess.VcsProcess, fake)),
          Layer.provide(Layer.succeed(HubRepository.HubRepositories, repositories)),
          Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-hub-packs-" })),
        ),
      ).pipe(Effect.map((context) => Context.get(context, HubPackUploads.HubPackUploads)));
      const owner = EnvironmentId.make("environment-pack-test");
      const key = { projectId: ProjectId.make("project-pack-test") };
      const uploadId = "d".repeat(32);
      const bytes = new TextEncoder().encode("pack bytes");
      yield* uploads.append(owner, key, uploadId, {
        offset: 0,
        body: Stream.make(bytes),
        maxBytes: 1_000_000,
      });
      const request = {
        size: bytes.length,
        updates: [
          { ref: "refs/heads/main", newOid: TIP },
          { ref: "refs/heads/other", newOid: OTHER_TIP },
        ],
      };
      // The apply releases its access once it has ended, however it went.
      const ended = yield* Deferred.make<void>();
      const access = {
        lost: Effect.never,
        release: Deferred.succeed(ended, undefined).pipe(Effect.asVoid),
      };
      const started = yield* uploads.apply(owner, key, uploadId, request, access);
      assert.strictEqual(started.state, "applying");
      yield* Deferred.await(ended);
      const status = yield* uploads.status(owner, key, uploadId);
      assert.deepStrictEqual(status.error, undefined);
      assert.strictEqual(status.state, "done");
      const revList = runs.find((run) => run.args.includes("rev-list"));
      assert.isDefined(revList);
      assert.deepStrictEqual(revList?.args.slice(-4), [TIP, OTHER_TIP, "--not", "--all"]);
      assert.notInclude(revList?.args ?? [], "--stdin");
      assert.isUndefined(revList?.stdin);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
