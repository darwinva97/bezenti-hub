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

import { FOLDER_ZIP_SKIPPED_FILE, folderZipStream } from "./FolderZip.ts";

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

const zipOf = (root: string, name: string, patterns?: ReturnType<typeof makeSecretPatterns>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const chunks = yield* Stream.runCollect(
      folderZipStream({ fileSystem, path, root, name, patterns }),
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

      const entries = yield* zipOf(root, "app", makeSecretPatterns([{ name: "TOKEN", value }]));
      const byName = new Map(entries.map((entry) => [entry.name, entry.bytes]));
      const env = text(byName.get("app/.env")!);
      expect(env).toContain("TOKEN=");
      expect(env).not.toContain(value);
      expect([...byName.get("app/data.bin")!]).toEqual([...binary]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
