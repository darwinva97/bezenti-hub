// @effect-diagnostics nodeBuiltinImport:off - the archive is read back with zlib's crc32.
import * as NodeZlib from "node:zlib";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { makeSecretPatterns } from "@t3tools/shared/secretMasking";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as yauzl from "yauzl";

import {
  type ArchiveItem,
  type ArchiveRange,
  compareArchiveKeys,
  FOLDER_ZIP_SKIPPED_FILE,
  folderZipStream,
  planArchive,
} from "./FolderZip.ts";

interface ReadEntry {
  readonly name: string;
  readonly bytes: Uint8Array;
}

const readZip = (archive: Uint8Array) =>
  Effect.promise(
    () =>
      new Promise<Array<ReadEntry>>((resolve, reject) => {
        yauzl.fromBuffer(Buffer.from(archive), { lazyEntries: true }, (error, zip) => {
          if (error) return reject(error);
          const entries: Array<ReadEntry> = [];
          zip.on("error", reject);
          zip.on("end", () => resolve(entries));
          zip.on("entry", (entry: yauzl.Entry) => {
            if (entry.fileName.endsWith("/")) {
              entries.push({ name: entry.fileName, bytes: new Uint8Array() });
              return zip.readEntry();
            }
            zip.openReadStream(entry, (streamError, stream) => {
              if (streamError) return reject(streamError);
              const chunks: Array<Buffer> = [];
              stream.on("data", (chunk: Buffer) => chunks.push(chunk));
              stream.on("end", () => {
                const bytes = new Uint8Array(Buffer.concat(chunks));
                if (NodeZlib.crc32(bytes) !== entry.crc32) {
                  return reject(new Error(`CRC mismatch for ${entry.fileName}`));
                }
                entries.push({ name: entry.fileName, bytes });
                zip.readEntry();
              });
            });
          });
          zip.readEntry();
        });
      }),
  );

const zipOf = (
  root: string,
  name: string,
  options: {
    readonly patterns?: ReturnType<typeof makeSecretPatterns>;
    readonly items?: ReadonlyArray<ArchiveItem>;
    readonly range?: ArchiveRange;
    readonly includeAll?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const chunks = yield* Stream.runCollect(
      folderZipStream({
        fileSystem,
        path,
        items: options.items ?? [{ absolute: root, name }],
        includeAll: options.includeAll ?? false,
        range: options.range ?? {},
        patterns: options.patterns,
      }),
    );
    const archive = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
    let at = 0;
    for (const chunk of chunks) {
      archive.set(chunk, at);
      at += chunk.byteLength;
    }
    return yield* readZip(archive);
  });

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("FolderZip", () => {
  it.effect("archives a folder under its own name, in path order, with UTF-8 names", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-folder-zip-" });
      yield* fileSystem.makeDirectory(path.join(root, "sub", "empty"), { recursive: true });
      yield* fileSystem.writeFileString(path.join(root, "b.txt"), "second");
      yield* fileSystem.writeFileString(path.join(root, "a.txt"), "first");
      yield* fileSystem.writeFileString(path.join(root, "sub", "ñandú 字.md"), "unicode");
      yield* fileSystem.writeFile(path.join(root, "sub", "blob.bin"), new Uint8Array([0, 1, 2]));
      yield* fileSystem.writeFileString(path.join(root, "sub", "zero"), "");

      const entries = yield* zipOf(root, "deliverables");
      expect(entries.map((entry) => entry.name)).toEqual([
        "deliverables/",
        "deliverables/a.txt",
        "deliverables/b.txt",
        "deliverables/sub/",
        "deliverables/sub/blob.bin",
        "deliverables/sub/empty/",
        "deliverables/sub/zero",
        "deliverables/sub/ñandú 字.md",
      ]);
      const byName = new Map(entries.map((entry) => [entry.name, entry.bytes]));
      expect(text(byName.get("deliverables/a.txt")!)).toBe("first");
      expect(text(byName.get("deliverables/sub/ñandú 字.md")!)).toBe("unicode");
      expect([...byName.get("deliverables/sub/blob.bin")!]).toEqual([0, 1, 2]);
      expect(byName.get("deliverables/sub/zero")!.byteLength).toBe(0);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("archives an empty folder as just its folder", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-folder-zip-" });
      expect((yield* zipOf(root, "empty")).map((entry) => entry.name)).toEqual(["empty/"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.skipIf(!symlinksSupported)("never follows a symlink and lists what it leaves out", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-folder-zip-" });
      const outside = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-folder-out-" });
      yield* fileSystem.writeFileString(path.join(outside, "secret.txt"), "outside");
      yield* fileSystem.symlink(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
      yield* fileSystem.symlink(outside, path.join(root, "linked-dir"));
      yield* fileSystem.makeDirectory(path.join(root, ".git"));
      yield* fileSystem.writeFileString(path.join(root, ".git", "HEAD"), "ref");
      yield* fileSystem.makeDirectory(path.join(root, "node_modules", "dep"), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(path.join(root, "kept.txt"), "kept");

      const entries = yield* zipOf(root, "repo");
      expect(entries.map((entry) => entry.name)).toEqual([
        "repo/",
        "repo/kept.txt",
        FOLDER_ZIP_SKIPPED_FILE,
      ]);
      expect(entries.some((entry) => text(entry.bytes).includes("outside"))).toBe(false);
      const skipped = text(entries.at(-1)!.bytes);
      expect(skipped).toContain("repo/.git: left out");
      expect(skipped).toContain("repo/node_modules: left out");
      expect(skipped).toContain("repo/link.txt: symbolic link, not followed");
      expect(skipped).toContain("repo/linked-dir: symbolic link, not followed");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("masks the asking User's values in text, never in binary files", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-folder-zip-" });
      const value = "sk-live-0123456789abcdef";
      yield* fileSystem.writeFileString(path.join(root, ".env"), `TOKEN=${value}\n`);
      const binary = new Uint8Array([0, ...new TextEncoder().encode(value)]);
      yield* fileSystem.writeFile(path.join(root, "data.bin"), binary);

      const entries = yield* zipOf(root, "app", {
        patterns: makeSecretPatterns([{ name: "TOKEN", value }]),
      });
      const byName = new Map(entries.map((entry) => [entry.name, entry.bytes]));
      const env = text(byName.get("app/.env")!);
      expect(env).toContain("TOKEN=");
      expect(env).not.toContain(value);
      expect([...byName.get("app/data.bin")!]).toEqual([...binary]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps .git and node_modules when asked", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-folder-zip-" });
      yield* fileSystem.makeDirectory(path.join(root, ".git"));
      yield* fileSystem.writeFileString(path.join(root, ".git", "HEAD"), "ref");
      const entries = yield* zipOf(root, "repo", { includeAll: true });
      expect(entries.map((entry) => entry.name)).toEqual(["repo/", "repo/.git/", "repo/.git/HEAD"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("archives a selection under each item's name", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-folder-zip-" });
      yield* fileSystem.makeDirectory(path.join(root, "docs"));
      yield* fileSystem.writeFileString(path.join(root, "docs", "a.md"), "a");
      yield* fileSystem.writeFileString(path.join(root, "notes.txt"), "n");
      const entries = yield* zipOf(root, "", {
        items: [
          { absolute: path.join(root, "notes.txt"), name: "notes.txt" },
          { absolute: path.join(root, "docs"), name: "docs" },
        ],
      });
      expect(entries.map((entry) => entry.name)).toEqual(["docs/", "docs/a.md", "notes.txt"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("orders archive paths segment by segment, as the walk lists them", () => {
    const keys = [["a-b"], ["a", "x"], ["a"], ["b"], ["a", "x", "y"]];
    expect(keys.toSorted(compareArchiveKeys)).toEqual([
      ["a"],
      ["a", "x"],
      ["a", "x", "y"],
      ["a-b"],
      ["b"],
    ]);
  });

  it.effect(
    "splits into parts of at most the part size, a larger file alone, every file once",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-folder-zip-" });
        yield* fileSystem.makeDirectory(path.join(root, "a", "nested"), { recursive: true });
        yield* fileSystem.makeDirectory(path.join(root, "empty"));
        const sizes: Record<string, number> = {
          "a/1.bin": 40,
          "a/nested/2.bin": 40,
          "a/nested/3.bin": 30,
          "big.bin": 250,
          "c.bin": 60,
          "d.bin": 50,
        };
        for (const [name, size] of Object.entries(sizes)) {
          yield* fileSystem.writeFile(path.join(root, name), new Uint8Array(size).fill(7));
        }
        const items = [{ absolute: root, name: "data" }];
        const plan = yield* planArchive({
          fileSystem,
          path,
          items,
          includeAll: false,
          partBytes: 100,
          maxEntries: 1000,
        });
        expect(plan).toMatchObject({ files: 6, bytes: 470, skipped: 0, truncated: false });
        expect(plan.parts.map((part) => [part.start?.join("/"), part.bytes, part.files])).toEqual([
          [undefined, 80, 2],
          ["data/a/nested/3.bin", 30, 1],
          ["data/big.bin", 250, 1],
          ["data/c.bin", 60, 1],
          ["data/d.bin", 50, 1],
        ]);

        const seen: Array<string> = [];
        for (const [index, part] of plan.parts.entries()) {
          const entries = yield* zipOf(root, "data", {
            items,
            range: { start: part.start, end: plan.parts[index + 1]?.start },
          });
          const files = entries.filter((entry) => !entry.name.endsWith("/"));
          expect(files.reduce((total, entry) => total + entry.bytes.byteLength, 0)).toBe(
            part.bytes,
          );
          seen.push(...entries.map((entry) => entry.name));
        }
        expect(seen.filter((name) => !name.endsWith("/")).toSorted()).toEqual(
          Object.keys(sizes).map((name) => `data/${name}`),
        );
        expect(seen).toContain("data/empty/");
        expect(new Set(seen).size).toBe(seen.length);

        const capped = yield* planArchive({
          fileSystem,
          path,
          items,
          includeAll: false,
          partBytes: 100,
          maxEntries: 3,
        });
        expect(capped.truncated).toBe(true);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
