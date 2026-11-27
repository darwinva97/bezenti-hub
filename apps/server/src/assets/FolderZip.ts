/**
 * Workspace folders and selections served as ZIPs that are read as they stream. Symlinks are never
 * followed, `.git` and `node_modules` are left out unless asked for, and checkout text is masked
 * for the User who asks (`maskAssets.ts`). What is left out is listed in `SKIPPED.txt`.
 */
import type { UserId } from "@t3tools/contracts";
import type { SecretPatterns } from "@t3tools/shared/secretMasking";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { HttpServerResponse } from "effect/http";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { isMedia, MAX_MASKED_TEXT_BYTES, SNIFF_BYTES } from "../vaults/maskAssets.ts";
import * as SecretMasker from "../vaults/SecretMasker.ts";
import { openMediaFile, readMediaFileHeader, streamMediaFile } from "./MediaFile.ts";
import { zipStream, type ZipEntry, type ZipFileBody } from "./zipWriter.ts";

const EXCLUDED_NAMES: ReadonlySet<string> = new Set([".git", "node_modules"]);
export const FOLDER_ZIP_SKIPPED_FILE = "SKIPPED.txt";
/** Folder ZIPs one User may stream at once, across their tabs and devices. */
const FOLDER_ZIP_MAX_CONCURRENT_PER_USER = 3;

const NOT_STORED = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" };

/** A top-level entry of an archive: a folder or file, symlink-resolved, and its name there. */
export interface ArchiveItem {
  readonly absolute: string;
  readonly name: string;
}

/** An archive path as its segments; archives list entries in this order. */
export type ArchiveKey = ReadonlyArray<string>;

export const compareArchiveKeys = (left: ArchiveKey, right: ArchiveKey): number => {
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const a = left[index]!;
    const b = right[index]!;
    if (a !== b) return a < b ? -1 : 1;
  }
  return left.length - right.length;
};

const isPrefix = (prefix: ArchiveKey, key: ArchiveKey) =>
  prefix.length <= key.length && prefix.every((segment, index) => segment === key[index]);

/** The part of an archive from `start` (inclusive) to `end` (exclusive); none: the whole. */
export interface ArchiveRange {
  readonly start?: ArchiveKey | undefined;
  readonly end?: ArchiveKey | undefined;
}

const inRange = (key: ArchiveKey, range: ArchiveRange) =>
  (range.start === undefined || compareArchiveKeys(key, range.start) >= 0) &&
  (range.end === undefined || compareArchiveKeys(key, range.end) < 0);

/** Whether nothing under the folder `key` can be in the range. */
const subtreeOutside = (key: ArchiveKey, range: ArchiveRange) =>
  (range.end !== undefined && compareArchiveKeys(key, range.end) >= 0) ||
  (range.start !== undefined &&
    compareArchiveKeys(key, range.start) < 0 &&
    !isPrefix(key, range.start));

type WalkNode =
  | { readonly kind: "directory"; readonly key: ArchiveKey; readonly modifiedAt: Date }
  | {
      readonly kind: "file";
      readonly key: ArchiveKey;
      readonly absolute: string;
      readonly size: number;
      readonly modifiedAt: Date;
    }
  | { readonly kind: "skipped"; readonly key: ArchiveKey; readonly reason: string };

interface WalkInput {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly items: ReadonlyArray<ArchiveItem>;
  /** Keep `.git` and `node_modules`. */
  readonly includeAll: boolean;
  readonly range: ArchiveRange;
}

/** Every entry of the archive in archive order, never through a symlink. */
const walk = (input: WalkInput): Stream.Stream<WalkNode> => {
  const { fileSystem, path, range } = input;
  const node = (absolute: string, key: ArchiveKey): Stream.Stream<WalkNode> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const base = key.at(-1) ?? "";
        const skip = (reason: string): Stream.Stream<WalkNode> =>
          inRange(key, range) ? Stream.succeed({ kind: "skipped", key, reason }) : Stream.empty;
        if (key.length > 1 && !input.includeAll && EXCLUDED_NAMES.has(base)) {
          return skip("left out");
        }
        if (subtreeOutside(key, range)) return Stream.empty;
        const info = yield* Effect.option(fileSystem.lstat(absolute));
        if (Option.isNone(info)) return skip("could not be read");
        const modifiedAt = Option.getOrElse(info.value.mtime, () => new Date(0));
        switch (info.value.type) {
          case "Directory": {
            const self: Stream.Stream<WalkNode> = inRange(key, range)
              ? Stream.succeed({ kind: "directory", key, modifiedAt })
              : Stream.empty;
            return self.pipe(Stream.concat(children(absolute, key)));
          }
          case "File":
            return inRange(key, range)
              ? Stream.succeed<WalkNode>({
                  kind: "file",
                  key,
                  absolute,
                  size: Number(info.value.size),
                  modifiedAt,
                })
              : Stream.empty;
          case "SymbolicLink":
            return skip("symbolic link, not followed");
          default:
            return skip("not a regular file");
        }
      }),
    );
  const children = (absolute: string, key: ArchiveKey): Stream.Stream<WalkNode> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const names = yield* Effect.option(fileSystem.readDirectory(absolute));
        if (Option.isNone(names)) {
          return inRange(key, range)
            ? Stream.succeed<WalkNode>({ kind: "skipped", key, reason: "folder could not be read" })
            : Stream.empty;
        }
        return Stream.fromIterable(names.value.toSorted()).pipe(
          Stream.flatMap((name) => node(path.join(absolute, name), [...key, name])),
        );
      }),
    );
  return Stream.fromIterable(
    input.items.toSorted((left, right) => compareArchiveKeys([left.name], [right.name])),
  ).pipe(Stream.flatMap((item) => node(item.absolute, [item.name])));
};

interface ArchivePart {
  /** The first file of the part; none for the first part. */
  readonly start: ArchiveKey | undefined;
  readonly bytes: number;
  readonly files: number;
}

interface ArchivePlan {
  readonly files: number;
  readonly bytes: number;
  readonly skipped: number;
  /** Greedy in archive order: a part holds files up to `partBytes`, a larger file alone. */
  readonly parts: ReadonlyArray<ArchivePart>;
  /** The walk stopped at `maxEntries`. */
  readonly truncated: boolean;
}

export const planArchive = Effect.fn("FolderZip.planArchive")(function* (
  input: Omit<WalkInput, "range"> & { readonly partBytes: number; readonly maxEntries: number },
) {
  let entries = 0;
  let files = 0;
  let bytes = 0;
  let skipped = 0;
  let truncated = false;
  let current = { start: undefined as ArchiveKey | undefined, bytes: 0, files: 0 };
  const parts = [current];
  yield* walk({ ...input, range: {} }).pipe(
    Stream.takeWhile(() => {
      entries++;
      if (entries > input.maxEntries) truncated = true;
      return !truncated;
    }),
    Stream.runForEach((walked) =>
      Effect.sync(() => {
        if (walked.kind === "skipped") skipped++;
        if (walked.kind !== "file") return;
        if (current.files > 0 && current.bytes + walked.size > input.partBytes) {
          current = { start: walked.key, bytes: 0, files: 0 };
          parts.push(current);
        }
        current.bytes += walked.size;
        current.files++;
        files++;
        bytes += walked.size;
      }),
    ),
  );
  return { files, bytes, skipped, parts, truncated } satisfies ArchivePlan;
});

export const folderZipStream = (
  input: WalkInput & {
    /** The asking User's values; none: served as they are. */
    readonly patterns: SecretPatterns | undefined;
    /** Archive paths that were asked for but are gone, listed as skipped. */
    readonly missing?: ReadonlyArray<string>;
  },
): Stream.Stream<Uint8Array> =>
  Stream.suspend(() => {
    const { patterns } = input;
    const skipped: Array<string> = (input.missing ?? []).map((name) => `${name}: no longer there`);

    const openFile = Effect.fnUntraced(function* (
      absolute: string,
      entryName: string,
    ): Effect.fn.Return<ZipFileBody<never> | null, never, Scope.Scope> {
      const file = yield* openMediaFile(absolute).pipe(Effect.orElseSucceed(() => null));
      if (file === null) {
        skipped.push(`${entryName}: could not be read`);
        return null;
      }
      const size = Number(file.info.size);
      const raw: ZipFileBody<never> = {
        size,
        body: (streamMediaFile(file, 0n, file.info.size) ?? Stream.empty).pipe(
          Stream.catchCause(() => {
            skipped.push(`${entryName}: failed while reading; the archive holds what was read`);
            return Stream.empty;
          }),
        ),
      };
      if (patterns === undefined || isMedia(entryName)) return raw;
      const head = yield* Effect.option(
        readMediaFileHeader(absolute, file, Math.min(size, SNIFF_BYTES)),
      );
      if (Option.isNone(head)) {
        skipped.push(`${entryName}: could not be read`);
        return null;
      }
      if (head.value.includes(0)) return raw;
      if (size > MAX_MASKED_TEXT_BYTES) {
        skipped.push(`${entryName}: too large to check for secrets`);
        return null;
      }
      const bytes = yield* Effect.option(readMediaFileHeader(absolute, file, size));
      if (Option.isNone(bytes)) {
        skipped.push(`${entryName}: could not be read`);
        return null;
      }
      const text = new TextDecoder().decode(bytes.value);
      const masked = patterns.mask(text);
      const body = masked === text ? bytes.value : new TextEncoder().encode(masked);
      return { size: body.byteLength, body: Stream.succeed(body) };
    });

    const entries = walk(input).pipe(
      Stream.flatMap((walked): Stream.Stream<ZipEntry<never>> => {
        const name = walked.key.join("/");
        switch (walked.kind) {
          case "skipped":
            skipped.push(`${name}: ${walked.reason}`);
            return Stream.empty;
          case "directory":
            return Stream.succeed({ kind: "directory", name, modifiedAt: walked.modifiedAt });
          case "file":
            return Stream.succeed({
              kind: "file",
              name,
              modifiedAt: walked.modifiedAt,
              open: openFile(walked.absolute, name),
            });
        }
      }),
    );

    const skippedList = Stream.suspend(() => {
      if (skipped.length === 0) return Stream.empty;
      const body = new TextEncoder().encode(
        `Not in this archive:\n\n${skipped.map((line) => `- ${line}`).join("\n")}\n`,
      );
      return Stream.succeed<ZipEntry<never>>({
        kind: "file",
        name: FOLDER_ZIP_SKIPPED_FILE,
        modifiedAt: new Date(),
        open: Effect.succeed({ size: body.byteLength, body: Stream.succeed(body) }),
      });
    });

    return zipStream(entries.pipe(Stream.concat(skippedList)));
  });

const contentDisposition = (fileName: string) =>
  `attachment; filename="${fileName.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;

const activeByUser = new Map<string, number>();

export const folderZipResponse = Effect.fn("FolderZip.folderZipResponse")(function* (
  input: Omit<WalkInput, "fileSystem" | "path"> & {
    readonly fileName: string;
    readonly missing: ReadonlyArray<string>;
    readonly user: Option.Option<UserId>;
    readonly method: "GET" | "HEAD";
  },
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const masker = yield* Effect.serviceOption(SecretMasker.SecretMasker);
  let patterns: SecretPatterns | undefined;
  if (Option.isSome(masker)) {
    if (Option.isNone(input.user)) {
      return HttpServerResponse.text("Open this folder from T3 Code.", {
        status: 403,
        headers: NOT_STORED,
      });
    }
    const found = yield* Effect.option(masker.value.forUser(input.user.value));
    if (Option.isNone(found)) {
      return HttpServerResponse.text("[content hidden: secrets could not be loaded]", {
        status: 503,
        headers: NOT_STORED,
      });
    }
    if (!found.value.isEmpty) patterns = found.value;
  }
  const headers = { ...NOT_STORED, "content-disposition": contentDisposition(input.fileName) };
  if (input.method === "HEAD") {
    return HttpServerResponse.empty({ headers: { ...headers, "content-type": "application/zip" } });
  }
  const userKey = Option.getOrElse(input.user, () => "");
  if ((activeByUser.get(userKey) ?? 0) >= FOLDER_ZIP_MAX_CONCURRENT_PER_USER) {
    return HttpServerResponse.text(
      `At most ${FOLDER_ZIP_MAX_CONCURRENT_PER_USER} folder downloads can run at once. Wait for one to finish.`,
      { status: 429, headers: NOT_STORED },
    );
  }
  // Counted only while the body streams: a response never sent holds no slot.
  const counted = Stream.suspend(() => {
    activeByUser.set(userKey, (activeByUser.get(userKey) ?? 0) + 1);
    return folderZipStream({ ...input, fileSystem, path, patterns });
  }).pipe(
    Stream.ensuring(
      Effect.sync(() => {
        const left = (activeByUser.get(userKey) ?? 1) - 1;
        if (left <= 0) activeByUser.delete(userKey);
        else activeByUser.set(userKey, left);
      }),
    ),
  );
  return HttpServerResponse.stream(counted, { contentType: "application/zip", headers });
});
