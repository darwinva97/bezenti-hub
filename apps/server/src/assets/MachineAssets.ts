/**
 * Ticket 15: a Thread's file served by URL from the machine the Thread runs on. The Hub asks the
 * machine to look at the file (`files.inspectAsset`) when it signs the URL, and reads its bytes
 * in windows (`files.streamAsset`) each time the URL is fetched; the machine resolves the path
 * inside the Thread's workspace, symlinks followed, on every call.
 */
// @effect-diagnostics nodeBuiltinImport:off - the window is read from the validated descriptor.
import * as NodePath from "node:path";

import type { EnvironmentId } from "@t3tools/contracts";
import {
  IMAGE_DIMENSIONS_HEADER_BYTES,
  readImageDimensions,
} from "@t3tools/shared/imageDimensions";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";

import type { Workspace } from "../workspace/JoinedWorkspaceRoots.ts";
import { openMediaFile, readMediaFileHeader } from "./MediaFile.ts";

/** One stream item's bytes at most, small enough for one frame. */
const MACHINE_ASSET_CHUNK_BYTES = 64 * 1024;
/** One read's bytes at most: the Hub asks for the next window once the client took this one. */
export const MACHINE_ASSET_WINDOW_BYTES = 8 * 1024 * 1024;
/** The largest file served from a machine. */
export const MAX_MACHINE_ASSET_BYTES = 512 * 1024 * 1024;

const HEADER_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

export const MachineAssetIdentity = Schema.Struct({ device: Schema.String, inode: Schema.String });
export type MachineAssetIdentity = typeof MachineAssetIdentity.Type;

export const MachineAssetInspectInput = Schema.Struct({
  /** The Thread's workspace root on the machine. */
  root: Schema.String,
  /** The file, relative to the root. */
  relativePath: Schema.String,
});

export const MachineAssetInspection = Schema.Struct({
  /** Where the file is, symlinks resolved: relative to the root, `/`-separated. */
  relativePath: Schema.String,
  size: Schema.Number,
  identity: MachineAssetIdentity,
  /** Changes when the file's bytes may have. */
  revision: Schema.String,
  imageDimensions: Schema.optionalKey(
    Schema.Struct({ width: Schema.Number, height: Schema.Number }),
  ),
});
export type MachineAssetInspection = typeof MachineAssetInspection.Type;

export const MachineAssetReadInput = Schema.Struct({
  root: Schema.String,
  relativePath: Schema.String,
  /** The file the Hub inspected: another one at the path (replaced since) is refused. */
  identity: MachineAssetIdentity,
  offset: Schema.Number,
  length: Schema.Number,
});
export type MachineAssetReadInput = typeof MachineAssetReadInput.Type;

/** A window: the file it was read from first, then its bytes. */
export const MachineAssetItem = Schema.Union([
  Schema.TaggedStruct("head", {
    relativePath: Schema.String,
    size: Schema.Number,
    identity: MachineAssetIdentity,
  }),
  Schema.TaggedStruct("chunk", { base64: Schema.String }),
]);
export type MachineAssetItem = typeof MachineAssetItem.Type;

export class MachineAssetError extends Schema.TaggedError<MachineAssetError>()(
  "MachineAssetError",
  {
    reason: Schema.Literals(["outside", "not_found", "changed", "invalid"]),
    relativePath: Schema.String,
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "outside":
        return "That is outside this Thread's workspace.";
      case "not_found":
        return "The file was not found.";
      case "changed":
        return "The file changed.";
      case "invalid":
        return "That read cannot be served.";
    }
  }
}

/** The Thread's machine is offline, or needs an update, for a Thread's file. */
export class MachineAssetUnavailableError extends Schema.TaggedError<MachineAssetUnavailableError>()(
  "MachineAssetUnavailableError",
  {
    reason: Schema.Literals(["environment_offline", "machine_outdated"]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

/** A Thread's files on its machine, as the Hub reaches them. */
export interface MachineAssetSource {
  readonly environmentId: EnvironmentId;
  readonly name: string;
  /**
   * A path a client sent (absolute, in the workspace as the Hub or the machine records it, or
   * relative to it) relative to the Thread's root on the machine; undefined when it leaves it.
   */
  readonly toRelative: (path: string) => string | undefined;
  readonly inspect: (
    relativePath: string,
  ) => Effect.Effect<MachineAssetInspection, MachineAssetError | MachineAssetUnavailableError>;
  readonly read: (
    input: Omit<MachineAssetReadInput, "root">,
  ) => Stream.Stream<MachineAssetItem, MachineAssetError | MachineAssetUnavailableError>;
}

/** Where a Thread's file is read: the Hub machine's own files, its machine, or nowhere now. */
export type MachineAssetRoute =
  | { readonly _tag: "local" }
  | { readonly _tag: "remote"; readonly source: MachineAssetSource }
  | {
      readonly _tag: "unavailable";
      readonly reason: "environment_offline" | "machine_outdated" | "outside_thread_workspace";
      readonly detail: string;
    };

/** The file a workspace call names, inside the root (symlinks followed), or why not. */
const resolveOnMachine = Effect.fn("MachineAssets.resolve")(function* (
  workspace: Workspace,
  relativePath: string,
  isServerInternalPath: (path: string) => Effect.Effect<boolean>,
) {
  const outside = new MachineAssetError({ reason: "outside", relativePath });
  const real = yield* workspace.inside(relativePath).pipe(Effect.mapError(() => outside));
  const relative = NodePath.relative(workspace.root, real);
  if (relative === "" || relative.startsWith("..") || NodePath.isAbsolute(relative)) {
    return yield* outside;
  }
  // The machine's own state (its credential, secrets) is never served, inside a workspace or not.
  if (yield* isServerInternalPath(real)) {
    return yield* new MachineAssetError({ reason: "not_found", relativePath });
  }
  return { real, relative: relative.split(NodePath.sep).join("/") };
});

/** `files.inspectAsset`, on the machine: the file as it is now, or why it cannot be served. */
export const inspectOnMachine = Effect.fn("MachineAssets.inspect")(function* (
  workspace: Workspace,
  relativePath: string,
  isServerInternalPath: (path: string) => Effect.Effect<boolean>,
) {
  const { real, relative } = yield* resolveOnMachine(workspace, relativePath, isServerInternalPath);
  const notFound = new MachineAssetError({ reason: "not_found", relativePath });
  return yield* Effect.scoped(
    Effect.gen(function* () {
      // Non-blocking and without following a link swapped in since: a FIFO never hangs this.
      const file = yield* openMediaFile(real).pipe(Effect.mapError(() => notFound));
      if (file === null) return yield* notFound;
      const dimensions = HEADER_IMAGE_EXTENSIONS.has(NodePath.extname(real).toLowerCase())
        ? yield* readMediaFileHeader(real, file, IMAGE_DIMENSIONS_HEADER_BYTES).pipe(
            Effect.map(readImageDimensions),
            Effect.orElseSucceed(() => null),
          )
        : null;
      const { info } = file;
      return {
        relativePath: relative,
        size: Number(info.size),
        identity: { device: info.dev.toString(), inode: info.ino.toString() },
        revision: `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`,
        ...(dimensions === null
          ? {}
          : { imageDimensions: { width: dimensions.width, height: dimensions.height } }),
      } satisfies MachineAssetInspection;
    }),
  );
});

/**
 * `files.streamAsset`, on the machine: one window of the file the Hub inspected, its head first.
 * The path is resolved again and the file must be the one inspected (not replaced since).
 */
export const readOnMachine = Effect.fn("MachineAssets.read")(function* (
  workspace: Workspace,
  input: Omit<MachineAssetReadInput, "root">,
  isServerInternalPath: (path: string) => Effect.Effect<boolean>,
) {
  const relativePath = input.relativePath;
  if (
    !Number.isSafeInteger(input.offset) ||
    !Number.isSafeInteger(input.length) ||
    input.offset < 0 ||
    input.length < 0 ||
    input.length > MACHINE_ASSET_WINDOW_BYTES
  ) {
    return yield* new MachineAssetError({ reason: "invalid", relativePath });
  }
  const { real, relative } = yield* resolveOnMachine(workspace, relativePath, isServerInternalPath);
  const changed = new MachineAssetError({ reason: "changed", relativePath });
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* openMediaFile(real, input.identity).pipe(Effect.mapError(() => changed));
      if (file === null) return yield* changed;
      const size = Number(file.info.size);
      if (input.offset > size)
        return yield* new MachineAssetError({ reason: "invalid", relativePath });
      const end = Math.min(size, input.offset + input.length);
      const items: Array<MachineAssetItem> = [
        { _tag: "head", relativePath: relative, size, identity: input.identity },
      ];
      let position = input.offset;
      while (position < end) {
        const wanted = Math.min(MACHINE_ASSET_CHUNK_BYTES, end - position);
        const buffer = new Uint8Array(wanted);
        const { bytesRead } = yield* Effect.tryPromise({
          try: () => file.handle.read(buffer, 0, wanted, position),
          catch: () => changed,
        });
        // Shorter than it said: it changed under the read.
        if (bytesRead === 0) return yield* changed;
        items.push({
          _tag: "chunk",
          base64: Buffer.from(buffer.subarray(0, bytesRead)).toString("base64"),
        });
        position += bytesRead;
      }
      return items;
    }),
  );
});
