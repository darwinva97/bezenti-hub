/**
 * Ticket 15: a URL of a file on a Thread's machine, served while it still leads there (same User,
 * same Thread, same machine). Bytes stream in windows, never written on the Hub; a window that
 * breaks (unannounced bytes, another file, the machine gone) breaks the response.
 */
import type { UserId } from "@t3tools/contracts";
import { hostPreviewMimeTypeFromExtension } from "@t3tools/shared/filePreview";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { HttpServerResponse } from "effect/http";
import * as Mime from "effect/http/Mime";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

import { maskedAssetResponse, SNIFF_BYTES } from "../vaults/maskAssets.ts";
import type { MachineFileAsset } from "./AssetAccess.ts";
import { assetByteRange, assetResponseHeaders } from "./assetHeaders.ts";
import {
  MACHINE_ASSET_WINDOW_BYTES,
  MAX_MACHINE_ASSET_BYTES,
  type MachineAssetInspection,
  type MachineAssetRoute,
  type MachineAssetSource,
} from "./MachineAssets.ts";

/** How long the machine has to say what the file is now. */
const MACHINE_ASSET_ANSWER_TIMEOUT = "15 seconds";
/** How long a window may go without a byte before the response is cut. */
const MACHINE_ASSET_IDLE_TIMEOUT = "30 seconds";

const NOT_STORED: Record<string, string> = {
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
};
const refused = (status: number, text: string) =>
  HttpServerResponse.text(text, { status, headers: NOT_STORED });
const notFound = () => refused(404, "Not Found");

/** A window the machine answered with something else than the bytes it was asked for. */
export class MachineAssetBrokenError extends Data.TaggedError("MachineAssetBrokenError")<{
  readonly detail: string;
}> {}

const sameIdentity = (
  left: MachineAssetInspection["identity"],
  right: MachineAssetInspection["identity"],
) => left.device === right.device && left.inode === right.inode;

/**
 * Bytes `[offset, offset + length)` of the inspected file, window by window. Each window must be
 * the inspected file (path, identity, size) and carry exactly the bytes asked for.
 */
const readMachineRange = (
  source: MachineAssetSource,
  file: MachineAssetInspection,
  offset: number,
  length: number,
): Stream.Stream<Uint8Array, MachineAssetBrokenError> => {
  const windows: Array<{ readonly offset: number; readonly length: number }> = [];
  for (let position = offset; position < offset + length; position += MACHINE_ASSET_WINDOW_BYTES) {
    windows.push({
      offset: position,
      length: Math.min(MACHINE_ASSET_WINDOW_BYTES, offset + length - position),
    });
  }
  const broken = (detail: string) => new MachineAssetBrokenError({ detail });
  const readWindow = (window: { readonly offset: number; readonly length: number }) =>
    Stream.suspend(() => {
      let head = false;
      let received = 0;
      return source
        .read({
          relativePath: file.relativePath,
          identity: file.identity,
          offset: window.offset,
          length: window.length,
        })
        .pipe(
          Stream.mapError((error) => broken(error.message)),
          Stream.timeoutOrElse({
            duration: MACHINE_ASSET_IDLE_TIMEOUT,
            orElse: () => Stream.fail(broken(`${source.name} stopped sending the file.`)),
          }),
          Stream.flatMap((item): Stream.Stream<Uint8Array, MachineAssetBrokenError> => {
            if (item._tag === "head") {
              if (
                head ||
                item.relativePath !== file.relativePath ||
                item.size !== file.size ||
                !sameIdentity(item.identity, file.identity)
              ) {
                return Stream.fail(broken("The machine sent another file."));
              }
              head = true;
              return Stream.empty;
            }
            if (!head) return Stream.fail(broken("The machine sent bytes before the file."));
            const bytes = new Uint8Array(Buffer.from(item.base64, "base64"));
            received += bytes.byteLength;
            if (received > window.length) {
              return Stream.fail(broken("The machine sent more than it was asked for."));
            }
            return Stream.make(bytes);
          }),
          Stream.concat(
            Stream.suspend(() =>
              head && received === window.length
                ? Stream.empty
                : Stream.fail(broken("The machine sent less than it was asked for.")),
            ),
          ),
        );
    });
  return Stream.fromIterable(windows).pipe(
    Stream.flatMap(readWindow, { concurrency: 1 }),
    Stream.tapError((error) =>
      Effect.logWarning("A Thread's file from its machine was cut short", {
        environmentId: source.environmentId,
        detail: error.detail,
      }),
    ),
  );
};

const collect = (stream: Stream.Stream<Uint8Array, MachineAssetBrokenError>) =>
  Stream.runCollect(stream).pipe(
    Effect.map((chunks) => {
      const all = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
      let position = 0;
      for (const chunk of chunks) {
        all.set(chunk, position);
        position += chunk.byteLength;
      }
      return all;
    }),
    Effect.option,
  );

/**
 * The file masked for `user` (see `maskedAssetResponse`), or undefined: serve it as it is. Read
 * from the machine as any window is, and never kept: neither on disk nor among masked files.
 */
export const maskedMachineAsset = (
  source: MachineAssetSource,
  file: MachineAssetInspection,
  user: Option.Option<UserId>,
  rangeHeader?: string,
  downloadName?: string,
) =>
  maskedAssetResponse(
    {
      name: file.relativePath,
      size: file.size,
      cacheKey: undefined,
      head: collect(readMachineRange(source, file, 0, Math.min(SNIFF_BYTES, file.size))),
      bytes: collect(readMachineRange(source, file, 0, file.size)),
    },
    user,
    rangeHeader,
    downloadName,
  );

const posixExtname = (relativePath: string) => {
  const name = relativePath.slice(relativePath.lastIndexOf("/") + 1);
  const index = name.lastIndexOf(".");
  return index <= 0 ? "" : name.slice(index);
};

export const machineAssetResponse = Effect.fn("MachineAssetResponse")(function* (input: {
  readonly asset: MachineFileAsset;
  /** Where the URL's Thread is read now, for the URL's own User. */
  readonly route: MachineAssetRoute;
  /** The request's signed-in User, if it has a session. */
  readonly session: Option.Option<UserId>;
  readonly rangeHeader: string | undefined;
  readonly ifRangeHeader: string | undefined;
  readonly method: "GET" | "HEAD";
}) {
  const { asset, route } = input;
  // Issued to one User: another one signed in never gets it. An embed without a session (an HTML
  // preview's own requests) is the URL's User, as for the Hub machine's files.
  if (
    Option.isSome(input.session) &&
    asset.viewer !== undefined &&
    input.session.value !== asset.viewer
  ) {
    return notFound();
  }
  // The Thread moved (to the Hub machine too): the URL served its old machine's file only.
  if (route._tag === "local") return notFound();
  if (route._tag === "unavailable") {
    return route.reason === "outside_thread_workspace" ? notFound() : refused(503, route.detail);
  }
  const source = route.source;
  if (source.environmentId !== asset.environmentId) return notFound();
  const inspected = yield* source.inspect(asset.relativePath).pipe(
    Effect.timeoutOrElse({
      duration: MACHINE_ASSET_ANSWER_TIMEOUT,
      orElse: () => Effect.fail("timeout" as const),
    }),
    Effect.result,
  );
  if (Result.isFailure(inspected)) {
    const failure = inspected.failure;
    if (failure === "timeout") return refused(504, `${source.name} did not answer in time.`);
    return failure._tag === "MachineAssetUnavailableError"
      ? refused(503, failure.detail)
      : notFound();
  }
  const file = inspected.success;
  // The machine answers for the file the URL names (and, pinned, that very file), only for it.
  if (
    file.relativePath !== asset.relativePath ||
    (asset.identity !== undefined && !sameIdentity(file.identity, asset.identity))
  ) {
    return notFound();
  }
  if (file.size > MAX_MACHINE_ASSET_BYTES) {
    return refused(413, "This file is too large to open here.");
  }
  const previewType = hostPreviewMimeTypeFromExtension(posixExtname(asset.relativePath));
  const headers = assetResponseHeaders(
    asset.relativePath,
    asset.download === true
      ? { download: true, fileName: asset.fileName }
      : previewType === null
        ? {}
        : { mimeType: previewType },
  );

  // Spec 5: text with the User's values in it goes masked, as a Hub machine file does.
  const masked = yield* maskedMachineAsset(
    source,
    file,
    Option.orElse(input.session, () =>
      asset.viewer === undefined ? Option.none() : Option.some(asset.viewer as UserId),
    ),
    input.method === "GET" ? input.rangeHeader : undefined,
    asset.download === true ? asset.fileName : undefined,
  );
  if (masked !== undefined) return masked;

  const isMedia = /^(?:audio|video)\//i.test(headers["Content-Type"] ?? "");
  // As on the Hub machine: media is never stored by the browser beyond its URL.
  if (isMedia) headers["Cache-Control"] = "private, no-store";
  headers["Accept-Ranges"] = "bytes";
  let status = 200;
  let offset = 0;
  let length = file.size;
  // If-Range needs a validator this has not: the whole file is the safe answer.
  if (input.method === "GET" && input.rangeHeader && input.ifRangeHeader === undefined) {
    const range = assetByteRange(input.rangeHeader, BigInt(file.size));
    if (range?._tag === "Unsatisfiable") {
      return HttpServerResponse.empty({
        status: 416,
        headers: { ...headers, "Content-Range": `bytes */${file.size}` },
      });
    }
    if (range?._tag === "Range") {
      status = 206;
      offset = Number(range.offset);
      length = Number(range.bytesToRead);
      headers["Content-Range"] = range.contentRange;
    }
  }
  headers["Content-Type"] ??= Option.getOrElse(
    Mime.getType(asset.relativePath),
    () => "application/octet-stream",
  );
  // The length the machine announced: a body that ends short reads as broken to the client.
  headers["Content-Length"] = String(length);
  if (input.method === "HEAD" || length === 0) {
    return HttpServerResponse.empty({ status, headers });
  }
  return HttpServerResponse.stream(readMachineRange(source, file, offset, length), {
    status,
    headers,
  });
});
