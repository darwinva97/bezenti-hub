/**
 * Spec 5 ticket 05: a checkout's file served by URL (large text, downloads, previews) goes to the
 * User who asks (the request's session; the URL's own User for sessionless embeds) masked with
 * their values when it is text that holds one. Media and binary files stream as they are. The
 * same rules hold for a file a Thread's machine serves (ticket 15), read through the Hub.
 */
import type { UserId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { HttpServerResponse } from "effect/http";
import * as Mime from "effect/http/Mime";
import * as Option from "effect/Option";

import * as SecretMasker from "./SecretMasker.ts";

/** The largest text file read whole to be masked. */
const MAX_MASKED_TEXT_BYTES = 16 * 1024 * 1024;
/** How much of a file is read to tell text from binary. */
export const SNIFF_BYTES = 8192;
const NOT_STORED: Record<string, string> = {
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
};

/**
 * Binary media and archives, served as they are, by extension: never by a MIME table, which calls
 * TypeScript (`.ts`, `.mts`) video and SVG an image. Everything else is sniffed.
 */
const MEDIA_EXTENSIONS = new Set(
  [
    "png jpg jpeg gif webp avif bmp ico tif tiff heic",
    "mp3 wav ogg oga flac aac m4a opus",
    "mp4 m4v mov webm mkv avi ogv",
    "zip gz tgz tar bz2 xz 7z rar zst",
    "pdf woff woff2 ttf otf wasm",
  ].flatMap((group) => group.split(" ")),
);

const isMedia = (filePath: string) =>
  MEDIA_EXTENSIONS.has(filePath.slice(filePath.lastIndexOf(".") + 1).toLowerCase());

/** Masked files, by file, revision and User: a range request reads them once. */
const maskedCache = new Map<string, Uint8Array>();
const MAX_CACHED = 32;

const rangeOf = (header: string | undefined, size: number) => {
  const match = header === undefined ? null : /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null || (match[1] === "" && match[2] === "")) return undefined;
  const start = match[1] === "" ? Math.max(0, size - Number(match[2])) : Number(match[1]);
  const end = match[1] === "" || match[2] === "" ? size - 1 : Math.min(size - 1, Number(match[2]));
  return start > end || start >= size ? undefined : { start, end };
};

/** A file to serve masked: on the Hub machine's disk, or read from a Thread's machine. */
export interface MaskableAsset {
  /** Its name or path, whose extension tells its type. */
  readonly name: string;
  readonly size: number;
  /**
   * Its key among masked files kept for range requests (path, revision); none: never kept, as a
   * file read from another machine is not.
   */
  readonly cacheKey: string | undefined;
  /** Its first bytes, at most `SNIFF_BYTES`; none when it cannot be read. */
  readonly head: Effect.Effect<Option.Option<Uint8Array>>;
  /** All of it (asked only up to `MAX_MASKED_TEXT_BYTES`); none when it cannot be read. */
  readonly bytes: Effect.Effect<Option.Option<Uint8Array>>;
}

/**
 * The masked response, or undefined: serve the file as it is (media, binary, or nothing of the
 * User's in it). `user` is who asks; none (no session, a URL without a User) refuses text.
 */
export const maskedAssetResponse = Effect.fn("SecretMasker.maskedAssetResponse")(function* (
  asset: MaskableAsset,
  user: Option.Option<UserId>,
  rangeHeader?: string,
  /** A download: served as an attachment under this name. */
  downloadName?: string,
) {
  const masker = yield* Effect.serviceOption(SecretMasker.SecretMasker);
  if (Option.isNone(masker)) return undefined;
  if (isMedia(asset.name)) return undefined;
  // Served as text: its own type, unless a MIME table would call it media.
  const known = Option.getOrElse(Mime.getType(asset.name), () => "text/plain");
  const contentType = /^(video|audio|image)\//.test(known) ? "text/plain" : known;
  // Binary (a NUL in its start): as it is, never read whole.
  const head = yield* asset.head;
  if (Option.isSome(head) && head.value.includes(0)) return undefined;
  if (Option.isNone(user)) {
    return HttpServerResponse.text("Open this file from T3 Code.", {
      status: 403,
      headers: NOT_STORED,
    });
  }
  const found = yield* Effect.option(masker.value.forUser(user.value));
  if (Option.isNone(found)) {
    return HttpServerResponse.text("[content hidden: secrets could not be loaded]", {
      status: 503,
      headers: NOT_STORED,
    });
  }
  if (found.value.isEmpty) return undefined;
  if (asset.size > MAX_MASKED_TEXT_BYTES) {
    return HttpServerResponse.text("This file is too large to check for secrets.", {
      status: 413,
      headers: NOT_STORED,
    });
  }
  const key = asset.cacheKey === undefined ? undefined : `${asset.cacheKey}\u0000${user.value}`;
  let body = key === undefined ? undefined : maskedCache.get(key);
  if (body === undefined) {
    const bytes = yield* asset.bytes;
    if (Option.isNone(bytes)) return undefined;
    const text = new TextDecoder().decode(bytes.value);
    const masked = found.value.mask(text);
    if (masked === text) return undefined;
    body = new TextEncoder().encode(masked);
    if (key !== undefined) {
      maskedCache.set(key, body);
      if (maskedCache.size > MAX_CACHED) {
        const oldest = maskedCache.keys().next().value;
        if (oldest !== undefined) maskedCache.delete(oldest);
      }
    }
  }
  // The original type: a masked script or stylesheet still runs in a preview.
  const type = contentType.startsWith("text/") ? `${contentType}; charset=utf-8` : contentType;
  const headers = {
    ...NOT_STORED,
    "accept-ranges": "bytes",
    ...(downloadName === undefined
      ? {}
      : { "content-disposition": `attachment; filename="${encodeURIComponent(downloadName)}"` }),
  };
  const range = rangeOf(rangeHeader, body.byteLength);
  if (range !== undefined) {
    return HttpServerResponse.uint8Array(body.subarray(range.start, range.end + 1), {
      status: 206,
      contentType: type,
      headers: {
        ...headers,
        "content-range": `bytes ${range.start}-${range.end}/${body.byteLength}`,
      },
    });
  }
  return HttpServerResponse.uint8Array(body, {
    contentType: type,
    headers,
  });
});

/** A checkout's file on the Hub machine's disk, served masked (see `maskedAssetResponse`). */
export const maskedAssetText = Effect.fn("SecretMasker.maskedAssetText")(function* (
  filePath: string,
  user: Option.Option<UserId>,
  rangeHeader?: string,
  downloadName?: string,
) {
  if (Option.isNone(yield* Effect.serviceOption(SecretMasker.SecretMasker))) return undefined;
  if (isMedia(filePath)) return undefined;
  const fileSystem = yield* FileSystem.FileSystem;
  const info = yield* Effect.option(fileSystem.stat(filePath));
  if (Option.isNone(info)) return undefined;
  const mtime = Option.getOrUndefined(info.value.mtime)?.getTime() ?? 0;
  return yield* maskedAssetResponse(
    {
      name: filePath,
      size: Number(info.value.size),
      cacheKey: `${filePath}\u0000${mtime}\u0000${info.value.size}`,
      head: Effect.scoped(
        Effect.flatMap(fileSystem.open(filePath), (file) => file.readAlloc(SNIFF_BYTES as never)),
      ).pipe(Effect.orElseSucceed(() => Option.none<Uint8Array>())),
      bytes: Effect.option(fileSystem.readFile(filePath)),
    },
    user,
    rangeHeader,
    downloadName,
  );
});
