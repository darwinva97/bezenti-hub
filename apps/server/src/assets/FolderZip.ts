/**
 * A workspace folder served as a ZIP that is read as it streams. Symlinks are never followed,
 * `.git` and `node_modules` are left out, and checkout text is masked for the User who asks, as a
 * single file's download is (`maskAssets.ts`). What is left out is listed in `SKIPPED.txt`.
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

const FOLDER_ZIP_EXCLUDED_NAMES: ReadonlySet<string> = new Set([".git", "node_modules"]);
export const FOLDER_ZIP_SKIPPED_FILE = "SKIPPED.txt";

const NOT_STORED = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" };

export const folderZipStream = (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  /** The folder, symlink-resolved. */
  readonly root: string;
  /** The archive's top folder. */
  readonly name: string;
  /** The asking User's values; none: served as they are. */
  readonly patterns: SecretPatterns | undefined;
}): Stream.Stream<Uint8Array> =>
  Stream.suspend(() => {
    const { fileSystem, path, patterns } = input;
    const skipped: Array<string> = [];

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

    const childEntries = (
      absolute: string,
      entryName: string,
      base: string,
    ): Stream.Stream<ZipEntry<never>> =>
      Stream.unwrap(
        Effect.gen(function* () {
          if (FOLDER_ZIP_EXCLUDED_NAMES.has(base)) {
            skipped.push(`${entryName}: left out`);
            return Stream.empty;
          }
          const info = yield* Effect.option(fileSystem.lstat(absolute));
          if (Option.isNone(info)) {
            skipped.push(`${entryName}: could not be read`);
            return Stream.empty;
          }
          const modifiedAt = Option.getOrElse(info.value.mtime, () => new Date(0));
          switch (info.value.type) {
            case "Directory":
              return Stream.succeed<ZipEntry<never>>({
                kind: "directory",
                name: entryName,
                modifiedAt,
              }).pipe(Stream.concat(folderEntries(absolute, entryName)));
            case "File":
              return Stream.succeed<ZipEntry<never>>({
                kind: "file",
                name: entryName,
                modifiedAt,
                open: openFile(absolute, entryName),
              });
            case "SymbolicLink":
              skipped.push(`${entryName}: symbolic link, not followed`);
              return Stream.empty;
            default:
              skipped.push(`${entryName}: not a regular file`);
              return Stream.empty;
          }
        }),
      );

    const folderEntries = (absolute: string, entryName: string): Stream.Stream<ZipEntry<never>> =>
      Stream.unwrap(
        Effect.gen(function* () {
          const names = yield* Effect.option(fileSystem.readDirectory(absolute));
          if (Option.isNone(names)) {
            skipped.push(`${entryName}/: folder could not be read`);
            return Stream.empty;
          }
          return Stream.fromIterable(names.value.toSorted()).pipe(
            Stream.flatMap((child) =>
              childEntries(path.join(absolute, child), `${entryName}/${child}`, child),
            ),
          );
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

    return zipStream(
      Stream.succeed<ZipEntry<never>>({
        kind: "directory",
        name: input.name,
        modifiedAt: new Date(),
      }).pipe(Stream.concat(folderEntries(input.root, input.name)), Stream.concat(skippedList)),
    );
  });

const contentDisposition = (fileName: string) =>
  `attachment; filename="${fileName.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;

export const folderZipResponse = Effect.fn("FolderZip.folderZipResponse")(function* (input: {
  readonly root: string;
  readonly name: string;
  readonly fileName: string;
  readonly user: Option.Option<UserId>;
  readonly method: "GET" | "HEAD";
}) {
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
  return HttpServerResponse.stream(
    folderZipStream({ fileSystem, path, root: input.root, name: input.name, patterns }),
    { contentType: "application/zip", headers },
  );
});
