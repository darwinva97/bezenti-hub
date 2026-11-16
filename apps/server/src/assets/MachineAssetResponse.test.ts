import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ThreadId, UserId } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import type { HttpServerResponse } from "effect/http";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import type { MachineFileAsset } from "./AssetAccess.ts";
import { machineAssetResponse } from "./MachineAssetResponse.ts";
import {
  MACHINE_ASSET_WINDOW_BYTES,
  type MachineAssetItem,
  type MachineAssetRoute,
  type MachineAssetSource,
  MachineAssetUnavailableError,
} from "./MachineAssets.ts";
import { LAPTOP, machineOver } from "./MachineAssets.testkit.ts";

const OWNER = UserId.make("owner");

const assetOf = (
  relativePath: string,
  extra: Partial<MachineFileAsset> = {},
): MachineFileAsset => ({
  kind: "machine-file",
  threadId: ThreadId.make("thread:laptop"),
  environmentId: LAPTOP,
  relativePath,
  fileName: relativePath.slice(relativePath.lastIndexOf("/") + 1),
  viewer: OWNER,
  ...extra,
});

const remote = (source: MachineAssetSource): MachineAssetRoute => ({ _tag: "remote", source });

const respond = (
  asset: MachineFileAsset,
  route: MachineAssetRoute,
  options: { readonly session?: UserId; readonly range?: string } = {},
) =>
  machineAssetResponse({
    asset,
    route,
    session: Option.fromNullishOr(options.session),
    rangeHeader: options.range,
    ifRangeHeader: undefined,
    method: "GET",
  });

class BodyBrokenError extends Data.TaggedError("BodyBrokenError")<{ readonly cause: unknown }> {}

/** The response's whole body, as a browser reads it; fails when the body breaks. */
const bodyOf = (
  response: HttpServerResponse.HttpServerResponse,
): Effect.Effect<string, BodyBrokenError> => {
  const body = response.body;
  if (body._tag === "Uint8Array") return Effect.succeed(Buffer.from(body.body).toString("utf8"));
  if (body._tag === "Stream") {
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off - a body stream's error is untyped.
    return Stream.runCollect(body.stream as Stream.Stream<Uint8Array, unknown>).pipe(
      Effect.map((chunks) =>
        Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"),
      ),
      Effect.mapError((cause) => new BodyBrokenError({ cause })),
    );
  }
  return Effect.succeed("");
};

const tempFolder = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-machine-asset-" });
  return { fileSystem, dir };
});

describe("MachineAssetResponse: a Thread's file served from its machine", () => {
  it.live("streams the file window by window, a range of it too", () =>
    Effect.gen(function* () {
      const { fileSystem, dir } = yield* tempFolder;
      // Two windows and a bit: the second one is asked for once the first is taken.
      const size = MACHINE_ASSET_WINDOW_BYTES + 1000;
      const bytes = new Uint8Array(size).map((_, index) => 97 + (index % 26));
      yield* fileSystem.writeFile(`${dir}/movie.mp4`, bytes);
      const response = yield* respond(assetOf("movie.mp4"), remote(machineOver(dir)));
      assert.equal(response.status, 200);
      assert.equal(response.headers["content-length"], String(size));
      assert.equal(response.headers["content-type"], "video/mp4");
      assert.equal(response.headers["cache-control"], "private, no-store");
      const body = yield* bodyOf(response);
      assert.equal(body.length, size);
      assert.equal(body, Buffer.from(bytes).toString("utf8"));

      const ranged = yield* respond(assetOf("movie.mp4"), remote(machineOver(dir)), {
        range: `bytes=${MACHINE_ASSET_WINDOW_BYTES - 2}-${MACHINE_ASSET_WINDOW_BYTES + 1}`,
      });
      assert.equal(ranged.status, 206);
      assert.equal(
        yield* bodyOf(ranged),
        Buffer.from(
          bytes.subarray(MACHINE_ASSET_WINDOW_BYTES - 2, MACHINE_ASSET_WINDOW_BYTES + 2),
        ).toString("utf8"),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("cuts the response when the machine sends more, less, or another file", () =>
    Effect.gen(function* () {
      const { fileSystem, dir } = yield* tempFolder;
      yield* fileSystem.writeFileString(`${dir}/report.pdf`, "%PDF the report");
      const extra = { _tag: "chunk", base64: Buffer.from("and more").toString("base64") } as const;
      const tampered: ReadonlyArray<
        readonly [
          string,
          (items: ReadonlyArray<MachineAssetItem>) => Stream.Stream<MachineAssetItem>,
        ]
      > = [
        ["more", (items) => Stream.fromIterable([...items, extra])],
        ["less", (items) => Stream.fromIterable(items.slice(0, -1))],
        [
          "another file",
          (items) =>
            Stream.fromIterable(
              items.map((item) =>
                item._tag === "head" ? { ...item, relativePath: "secret.pdf" } : item,
              ),
            ),
        ],
        ["no head", (items) => Stream.fromIterable(items.slice(1))],
      ];
      for (const [name, tamper] of tampered) {
        const response = yield* respond(
          assetOf("report.pdf"),
          remote(machineOver(dir, { tamper })),
        );
        // The head promised the whole file; its body never ends as if it were complete.
        assert.equal(response.headers["content-length"], String("%PDF the report".length), name);
        const read = yield* Effect.exit(bodyOf(response));
        assert.isTrue(Exit.isFailure(read), name);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("serves only the file the URL names, as signed", () =>
    Effect.gen(function* () {
      const { fileSystem, dir } = yield* tempFolder;
      yield* fileSystem.writeFileString(`${dir}/report.pdf`, "%PDF the report");
      const source = machineOver(dir);
      // The machine says the path leads elsewhere now (a link swapped in): nothing is served.
      const elsewhere = machineOver(dir, {
        inspect: (relativePath) =>
          Effect.map(source.inspect(relativePath), (file) => ({
            ...file,
            relativePath: "other.pdf",
          })),
      });
      assert.equal((yield* respond(assetOf("report.pdf"), remote(elsewhere))).status, 404);
      // A media URL pinned to a file that was replaced since.
      const pinned = assetOf("report.pdf", { identity: { device: "1", inode: "2" } });
      assert.equal((yield* respond(pinned, remote(source))).status, 404);
      // Another User signed in, the Thread on another machine or back on the Hub machine.
      const asked = assetOf("report.pdf");
      assert.equal(
        (yield* respond(asked, remote(source), { session: UserId.make("someone-else") })).status,
        404,
      );
      assert.equal((yield* respond(asked, remote(source), { session: OWNER })).status, 200);
      const desktop = { ...source, environmentId: "environment:desktop" } as MachineAssetSource;
      assert.equal((yield* respond(asked, remote(desktop))).status, 404);
      assert.equal((yield* respond(asked, { _tag: "local" })).status, 404);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("says the machine is offline at once, and gives up on one that does not answer", () =>
    Effect.gen(function* () {
      const asked = assetOf("report.pdf");
      const offline = yield* respond(asked, {
        _tag: "unavailable",
        reason: "environment_offline",
        detail: "Environment offline: Laptop is not connected.",
      });
      assert.equal(offline.status, 503);
      assert.include(yield* bodyOf(offline), "Environment offline");
      const dropped = machineOver("/nowhere", {
        inspect: () =>
          Effect.fail(
            new MachineAssetUnavailableError({
              reason: "environment_offline",
              detail: "Environment offline: Laptop is not connected.",
            }),
          ),
      });
      assert.equal((yield* respond(asked, remote(dropped))).status, 503);

      const silent = machineOver("/nowhere", { inspect: () => Effect.never });
      const waiting = yield* Effect.forkChild(respond(asked, remote(silent)));
      yield* TestClock.adjust("14 seconds");
      assert.isUndefined(waiting.pollUnsafe());
      yield* TestClock.adjust("1 second");
      const answered = yield* Fiber.join(waiting);
      assert.equal(answered.status, 504);
    }),
  );

  it.live("reads nothing from or to the Hub's own disk", () =>
    Effect.gen(function* () {
      const { fileSystem, dir } = yield* tempFolder;
      yield* fileSystem.writeFileString(`${dir}/notes.txt`, "notes\n");
      yield* fileSystem.writeFile(`${dir}/logo.png`, new Uint8Array([137, 80, 78, 71]));
      const touched: Array<string> = [];
      const noop = FileSystem.makeNoop({});
      const recording = new Proxy(noop, {
        get: (target, property, receiver) => {
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function"
            ? (...args: ReadonlyArray<unknown>) => {
                touched.push(String(property));
                return (value as (...args: ReadonlyArray<unknown>) => unknown)(...args);
              }
            : value;
        },
      });
      for (const name of ["notes.txt", "logo.png"]) {
        const response = yield* respond(
          assetOf(name, { download: true }),
          remote(machineOver(dir)),
        ).pipe(Effect.provideService(FileSystem.FileSystem, recording));
        assert.equal(response.status, 200, name);
        yield* bodyOf(response).pipe(Effect.provideService(FileSystem.FileSystem, recording));
      }
      assert.deepEqual(touched, []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
