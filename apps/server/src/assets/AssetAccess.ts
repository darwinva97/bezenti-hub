import type { AssetResource } from "@t3tools/contracts";
import {
  AssetAttachmentNotFoundError,
  AssetDownloadLimitError,
  WORKSPACE_DOWNLOAD_MAX_BYTES,
  WORKSPACE_DOWNLOAD_MAX_ENTRIES,
  WORKSPACE_DOWNLOAD_PART_BYTES,
  AssetSourceControlMediaUrlValidationError,
  AssetPreviewTypeValidationError,
  AssetProjectFaviconInspectionError,
  AssetProjectFaviconNotFoundError,
  AssetProjectFaviconResolutionError,
  AssetRemoteEnvironmentError,
  AssetSigningKeyLoadError,
  AssetWorkspaceAssetInspectionError,
  AssetWorkspaceAssetNotFoundError,
  AssetWorkspaceContextNotFoundError,
  AssetWorkspacePathValidationError,
  AssetWorkspaceResolutionError,
  AssetWorkspaceRootNormalizationError,
  SOURCE_CONTROL_MEDIA_ASSET,
  ThreadId,
  UserId,
  ToolActivityNativeAppReference,
  TurnItemId,
} from "@t3tools/contracts";
import {
  hostPreviewMimeTypeFromExtension,
  isWorkspaceAudioPreviewPath,
  isWorkspacePreviewEntryPath,
  isWorkspaceVideoPreviewPath,
  WORKSPACE_BROWSER_PREVIEW_EXTENSIONS,
} from "@t3tools/shared/filePreview";
import {
  IMAGE_DIMENSIONS_HEADER_BYTES,
  readImageDimensions,
  type ImageDimensions,
} from "@t3tools/shared/imageDimensions";
import { MCP_APP_MAX_HTML_BYTES } from "@t3tools/shared/mcpApp";
import {
  isProjectFaviconPath,
  PROJECT_FAVICON_FALLBACK_MARKER,
} from "@t3tools/shared/projectFavicon";
import { isNetworkPath } from "@t3tools/shared/path";
import { MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH, toolOutputImages } from "@t3tools/shared/toolOutput";
import * as Clock from "effect/Clock";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { base64UrlDecodeUtf8, base64UrlEncode } from "../auth/utils.ts";
import * as AssetSigner from "./AssetSigner.ts";
import * as AuditLog from "../audit/AuditLog.ts";
import { makeIsServerInternalPath } from "../auth/serverInternalPaths.ts";
import { parseAttachmentFileExtension, resolveAttachmentPathById } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import { isWithinRoot } from "../workspace/KnownWorkspaces.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as NativeAppIconResolver from "./NativeAppIconResolver.ts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import { extractIcnsPng } from "./icns.ts";
import { openMediaFile, readMediaFileHeader, type OpenMediaFile } from "./MediaFile.ts";
import { planArchive, type ArchiveItem, type ArchiveRange } from "./FolderZip.ts";
import type { MachineAssetSource } from "./MachineAssets.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";

export const ASSET_ROUTE_PREFIX = "/api/assets";

/** The folders and files a ZIP URL was signed for, each still itself inside the same root. */
const resolveFolderZip = Effect.fnUntraced(function* (
  claims: Extract<AssetClaims, { kind: "workspace-folder-zip" }>,
  requestedName: string,
) {
  if (requestedName !== claims.fileName) return null;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const items: Array<ArchiveItem> = [];
  const missing: Array<string> = [];
  for (const item of claims.items) {
    const absolute = path.join(claims.workspaceRoot, item.relativePath);
    const canonical = yield* fileSystem.realPath(absolute).pipe(Effect.orElseSucceed(() => null));
    if (canonical === absolute && isWithinRoot(path, canonical, claims.workspaceRoot)) {
      items.push({ absolute, name: item.name });
    } else {
      missing.push(item.name);
    }
  }
  if (items.length === 0) return null;
  return {
    kind: "folder-zip",
    items,
    missing,
    includeAll: claims.includeAll === true,
    range: { start: claims.start, end: claims.end },
    fileName: claims.fileName,
    ...(claims.viewer === undefined ? {} : { viewer: claims.viewer }),
  } satisfies ResolvedAsset;
});

const signClaims = Effect.fnUntraced(function* (claims: AssetClaims, resource: AssetResource) {
  const encodedPayload = base64UrlEncode(encodeAssetClaims(claims));
  const signer = yield* AssetSigner.AssetSigner;
  const signature = yield* signer
    .sign(encodedPayload)
    .pipe(Effect.mapError((cause) => new AssetSigningKeyLoadError({ resource, cause })));
  return `${encodedPayload}.${signature}`;
});

const MAX_RELATIVE_URL_LENGTH = 4096;

/** Issue #24: who downloaded what. A failed write is logged, never a refused download. */
const recordDownload = Effect.fnUntraced(function* (input: {
  readonly resource: Extract<AssetResource, { _tag: "workspace-download" }>;
  readonly viewer: string | undefined;
  readonly detail: { readonly files?: number; readonly bytes?: number; readonly parts?: number };
}) {
  const auditLog = yield* Effect.serviceOption(AuditLog.AuditLog);
  if (Option.isNone(auditLog)) return;
  const actor =
    input.viewer === undefined
      ? yield* AuditLog.currentActor
      : AuditLog.userActor(UserId.make(input.viewer));
  const name = input.resource.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? input.resource.cwd;
  yield* auditLog.value
    .record({
      actor,
      action: "workspace.download",
      target: { kind: "workspace", id: input.resource.cwd, name },
      detail: {
        paths: input.resource.paths.join(", ").slice(0, 2000),
        ...input.detail,
        ...(input.resource.includeAll === true ? { includeAll: true } : {}),
      },
    })
    .pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Failed to audit a workspace download.", { cause }),
      ),
    );
});

/** Folders and selections: planned into parts, one signed ZIP URL each. */
const issueArchiveDownload = Effect.fnUntraced(function* (input: {
  readonly resource: Extract<AssetResource, { _tag: "workspace-download" }>;
  readonly workspaceRoot: string;
  readonly targets: ReadonlyArray<string>;
  readonly expiresAt: number;
  readonly viewer: string | undefined;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const used = new Set<string>();
  const items = input.targets.map((target) => {
    const base = path.basename(target) || "folder";
    let name = base;
    for (let copy = 2; used.has(name); copy++) name = `${base} (${copy})`;
    used.add(name);
    return { absolute: target, name, relativePath: path.relative(input.workspaceRoot, target) };
  });
  const includeAll = input.resource.includeAll === true;
  const plan = yield* planArchive({
    fileSystem,
    path,
    items,
    includeAll,
    partBytes: WORKSPACE_DOWNLOAD_PART_BYTES,
    maxEntries: WORKSPACE_DOWNLOAD_MAX_ENTRIES,
  });
  const limitError = (reason: AssetDownloadLimitError["reason"]) =>
    new AssetDownloadLimitError({ resource: input.resource, reason });
  if (plan.truncated) return yield* limitError("too-many-entries");
  if (plan.bytes > WORKSPACE_DOWNLOAD_MAX_BYTES) return yield* limitError("too-large");
  const baseName =
    items.length === 1
      ? items[0]!.name
      : `${path.basename(input.workspaceRoot) || "workspace"}-selection`;
  const count = plan.parts.length;
  const parts = [];
  for (const [index, part] of plan.parts.entries()) {
    const fileName =
      count === 1 ? `${baseName}.zip` : `${baseName}-part-${index + 1}-of-${count}.zip`;
    const end = plan.parts[index + 1]?.start;
    const token = yield* signClaims(
      {
        version: 1,
        kind: "workspace-folder-zip",
        workspaceRoot: input.workspaceRoot,
        items: items.map((item) => ({ relativePath: item.relativePath, name: item.name })),
        ...(includeAll ? { includeAll: true } : {}),
        ...(part.start === undefined ? {} : { start: [...part.start] }),
        ...(end === undefined ? {} : { end: [...end] }),
        fileName,
        expiresAt: input.expiresAt,
        ...(input.viewer === undefined ? {} : { viewer: input.viewer }),
      },
      input.resource,
    );
    const relativeUrl = `${ASSET_ROUTE_PREFIX}/${token}/${encodeURIComponent(fileName)}`;
    if (relativeUrl.length > MAX_RELATIVE_URL_LENGTH) {
      return yield* limitError("selection-too-long");
    }
    parts.push({ relativeUrl, fileName, bytes: part.bytes, files: part.files });
  }
  yield* recordDownload({
    resource: input.resource,
    viewer: input.viewer,
    detail: { files: plan.files, bytes: plan.bytes, parts: count },
  });
  return {
    relativeUrl: parts[0]!.relativeUrl,
    expiresAt: input.expiresAt,
    download: { files: plan.files, bytes: plan.bytes, skipped: plan.skipped, parts },
  };
});

const ASSET_TOKEN_TTL_MS = 60 * 60 * 1000;
const PROJECT_FAVICON_TOKEN_BUCKET_MS = 30 * 60 * 1000;
const HTML_ATTACHMENT_TOKEN_BUCKET_MS = 30 * 60 * 1000;
const PROJECT_FAVICON_VERSION_PREFIX = "v";
const PROJECT_FAVICON_ICNS_MIN_SIZE = 96;
const INLINE_VIDEO_MIME_TYPE_PATTERN = /^video\/[\w!#$&^.+-]+$/i;
// Use server-assigned attachment extensions, never client MIME types.
const INLINE_PREVIEW_MIME_TYPES: Record<string, string> = {
  svg: "image/svg+xml",
  pdf: "application/pdf",
  html: "text/html",
  htm: "text/html",
};
const inlinePreviewMimeTypeForExtension = (extension: string) =>
  INLINE_PREVIEW_MIME_TYPES[extension] ??
  hostPreviewMimeTypeFromExtension(`.${extension}`) ??
  undefined;
const PREVIEW_ASSET_EXTENSIONS = new Set([
  ...WORKSPACE_BROWSER_PREVIEW_EXTENSIONS,
  // Keep HTML dependency grants independent of newly supported file viewers.
  ".avif",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".webp",
  ".css",
  ".js",
  ".mjs",
  ".otf",
  ".ttf",
  ".woff",
  ".woff2",
]);

const AssetClaimsSchema = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("workspace-file"),
    workspaceRoot: Schema.String,
    baseRelativePath: Schema.String,
    expiresAt: Schema.Number,
    viewer: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("workspace-file-exact"),
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    expiresAt: Schema.Number,
    viewer: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("media-file-exact"),
    filePath: Schema.String,
    download: Schema.optionalKey(Schema.Boolean),
    device: Schema.String,
    inode: Schema.String,
    expiresAt: Schema.Number,
    viewer: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("attachment"),
    attachmentId: Schema.String,
    download: Schema.optionalKey(Schema.Boolean),
    fileName: Schema.optionalKey(Schema.String),
    mimeType: Schema.optionalKey(Schema.String),
    renderIntent: Schema.optionalKey(Schema.Literal("mcp-app")),
    expiresAt: Schema.Number,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("project-favicon"),
    workspaceRoot: Schema.String,
    relativePath: Schema.NullOr(Schema.String),
    expiresAt: Schema.Number,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("project-favicon-external"),
    filePath: Schema.String,
    expiresAt: Schema.Number,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("native-app-icon"),
    app: ToolActivityNativeAppReference,
    expiresAt: Schema.Number,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("tool-output-image"),
    threadId: ThreadId,
    itemId: TurnItemId,
    index: Schema.Number,
    expiresAt: Schema.Number,
  }),
  /**
   * Ticket 15: a file of a Thread that runs on another machine, read from that machine when the
   * URL is fetched. `exact`: `path` is the file; `html-base`: the folder an HTML file and its
   * assets are under. Paths are relative to the Thread's workspace there, never a Hub path.
   */
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("thread-machine-file"),
    threadId: ThreadId,
    environmentId: Schema.String,
    mode: Schema.Literals(["exact", "html-base"]),
    path: Schema.String,
    device: Schema.optionalKey(Schema.String),
    inode: Schema.optionalKey(Schema.String),
    download: Schema.optionalKey(Schema.Boolean),
    expiresAt: Schema.Number,
    viewer: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("workspace-folder-zip"),
    /** Symlink-resolved at mint time; each item is `relativePath` under it. */
    workspaceRoot: Schema.String,
    items: Schema.Array(Schema.Struct({ relativePath: Schema.String, name: Schema.String })),
    includeAll: Schema.optionalKey(Schema.Boolean),
    /** The part's range in archive order (`FolderZip.ts`); none: from the start, to the end. */
    start: Schema.optionalKey(Schema.Array(Schema.String)),
    end: Schema.optionalKey(Schema.Array(Schema.String)),
    fileName: Schema.String,
    expiresAt: Schema.Number,
    viewer: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal(SOURCE_CONTROL_MEDIA_ASSET),
    /** A host's `fetchUrl`, narrowed at mint time; the signature is what keeps it there. */
    url: Schema.String,
    cwd: Schema.String,
    expiresAt: Schema.Number,
  }),
]);
type AssetClaims = typeof AssetClaimsSchema.Type;

const AssetClaimsJson = Schema.fromJsonString(AssetClaimsSchema);
const decodeAssetClaims = Schema.decodeUnknownOption(AssetClaimsJson);
const encodeAssetClaims = Schema.encodeSync(AssetClaimsJson);

export type ResolvedAsset =
  | {
      readonly kind: "file";
      readonly path: string;
      readonly download?: boolean;
      readonly fileName?: string;
      readonly mimeType?: string;
      readonly file?: OpenMediaFile;
      readonly renderIntent?: "mcp-app";
      /** Spec 5: a file of a checkout (text in it is served masked for the User who asks). */
      readonly checkout?: boolean;
      /** Spec 5: the User the URL was issued to (who asks, for an embed without a session). */
      readonly viewer?: string;
    }
  | {
      readonly kind: "bytes";
      readonly bytes: Uint8Array;
      readonly mimeType: string;
    }
  | {
      readonly kind: "source-control-media";
      readonly url: string;
      readonly cwd: string;
      readonly expiresAt: number;
    }
  | {
      readonly kind: "folder-zip";
      readonly items: ReadonlyArray<ArchiveItem>;
      /** Names of items that are gone or no longer themselves. */
      readonly missing: ReadonlyArray<string>;
      readonly includeAll: boolean;
      readonly range: ArchiveRange;
      readonly fileName: string;
      readonly viewer?: string;
    }
  | MachineFileAsset;

/** Ticket 15: a Thread's file on the machine it runs on, which the Hub reads from there. */
export interface MachineFileAsset {
  readonly kind: "machine-file";
  readonly threadId: ThreadId;
  readonly environmentId: string;
  /** Relative to the Thread's workspace on that machine, `/`-separated. */
  readonly relativePath: string;
  /** The file the URL was signed for; another one at the path is refused. */
  readonly identity?: { readonly device: string; readonly inode: string };
  readonly download?: boolean;
  readonly fileName: string;
  /** The User the URL was issued to. */
  readonly viewer?: string;
}

const posixBasename = (relativePath: string) =>
  relativePath.slice(relativePath.lastIndexOf("/") + 1);
const posixDirname = (relativePath: string) => {
  const index = relativePath.lastIndexOf("/");
  return index < 0 ? "." : relativePath.slice(0, index);
};
const posixExtname = (relativePath: string) => {
  const name = posixBasename(relativePath);
  const index = name.lastIndexOf(".");
  return index <= 0 ? "" : name.slice(index);
};

/** A path an HTML preview asks for under its folder: no dot segments, a previewable type. */
const isPreviewSubPath = (decodedPath: string) => {
  const segments = decodedPath.split(/[\\/]/);
  return !(
    decodedPath.length === 0 ||
    decodedPath.includes("\0") ||
    segments.some((segment) => segment === "." || segment === ".." || segment.startsWith(".")) ||
    !PREVIEW_ASSET_EXTENSIONS.has(posixExtname(segments.join("/")).toLowerCase())
  );
};

function decodeClaims(encodedPayload: string): AssetClaims | null {
  try {
    return Option.getOrNull(decodeAssetClaims(base64UrlDecodeUtf8(encodedPayload)));
  } catch {
    return null;
  }
}

function decodeRelativePath(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export const readMcpAppHtml = Effect.fn("AssetAccess.readMcpAppHtml")(function* (filePath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  // Allow space for stored CSP tags, but bound reads if the attachment grows after minting.
  const limit = MCP_APP_MAX_HTML_BYTES + 128 * 1024;
  const chunks = yield* Stream.runCollect(fileSystem.stream(filePath, { bytesToRead: limit + 1 }));
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  if (size > limit) return null;
  const bytes = new Uint8Array(size);
  let position = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, position);
    position += chunk.byteLength;
  }
  return bytes;
});

const readToolOutputImage = Effect.fn("AssetAccess.readToolOutputImage")(function* (input: {
  readonly threadId: ThreadId;
  readonly itemId: TurnItemId;
  readonly index: number;
}) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const item = yield* orchestrator.getTurnItem(input);
  const image =
    item?.type === "dynamic_tool" ? toolOutputImages(item.output)[input.index] : undefined;
  return image?.data === undefined || image.data.length > MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH
    ? null
    : { mimeType: image.mimeType, bytes: Buffer.from(image.data, "base64") };
});

// Browsers cannot draw .icns; serve its embedded PNG.
const projectFaviconAsset = Effect.fn("AssetAccess.projectFaviconAsset")(function* (
  filePath: string,
) {
  if (!filePath.toLowerCase().endsWith(".icns")) {
    return { kind: "file", path: filePath } satisfies ResolvedAsset;
  }
  const fileSystem = yield* FileSystem.FileSystem;
  const bytes = yield* fileSystem.readFile(filePath).pipe(
    Effect.tapError((cause) =>
      Effect.logError("Failed to read project icon image.", { filePath, cause }),
    ),
    Effect.orElseSucceed(() => null),
  );
  const png = bytes ? extractIcnsPng(bytes, PROJECT_FAVICON_ICNS_MIN_SIZE) : null;
  return png
    ? ({ kind: "bytes", bytes: png, mimeType: "image/png" } satisfies ResolvedAsset)
    : null;
});

const resolveCanonicalFile = Effect.fn("AssetAccess.resolveCanonicalFile")(function* (
  filePath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const canonicalFile = yield* ProjectFaviconResolver.optionOnNotFound(
    fileSystem.realPath(filePath),
  );
  if (Option.isNone(canonicalFile)) return null;

  const info = yield* ProjectFaviconResolver.optionOnNotFound(fileSystem.stat(canonicalFile.value));
  if (Option.isNone(info) || info.value.type !== "File") return null;
  const isServerInternalPath = yield* makeIsServerInternalPath;
  return (yield* isServerInternalPath(canonicalFile.value)) ? null : canonicalFile.value;
});

const resolveCanonicalWorkspaceFile = Effect.fn("AssetAccess.resolveCanonicalWorkspaceFile")(
  function* (input: { readonly workspaceRoot: string; readonly relativePath: string }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
    const resolved = yield* workspacePaths.resolveRelativePathWithinRoot(input).pipe(
      Effect.asSome,
      Effect.catchTags({
        WorkspacePathOutsideRootError: () => Effect.succeedNone,
      }),
    );
    if (Option.isNone(resolved)) return null;

    const [canonicalRoot, canonicalFile] = yield* Effect.all([
      ProjectFaviconResolver.optionOnNotFound(fileSystem.realPath(input.workspaceRoot)),
      ProjectFaviconResolver.optionOnNotFound(fileSystem.realPath(resolved.value.absolutePath)),
    ]);
    if (Option.isNone(canonicalRoot) || Option.isNone(canonicalFile)) return null;

    const path = yield* Path.Path;
    const relative = path.relative(canonicalRoot.value, canonicalFile.value);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;

    const info = yield* ProjectFaviconResolver.optionOnNotFound(
      fileSystem.stat(canonicalFile.value),
    );
    if (Option.isNone(info) || info.value.type !== "File") return null;
    const isServerInternalPath = yield* makeIsServerInternalPath;
    return (yield* isServerInternalPath(canonicalFile.value)) ? null : canonicalFile.value;
  },
);

const resolveCanonicalWorkspaceFileForRequest = (input: {
  readonly workspaceRoot: string;
  readonly relativePath: string;
}) =>
  resolveCanonicalWorkspaceFile(input).pipe(
    Effect.tapError((cause) =>
      Effect.logError("Failed to resolve canonical asset path.", {
        workspaceRoot: input.workspaceRoot,
        relativePath: input.relativePath,
        cause,
      }),
    ),
    Effect.orElseSucceed(() => null),
  );

const HEADER_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

const readImageDimensionsFromOpenFile = (filePath: string, file: OpenMediaFile) =>
  readMediaFileHeader(filePath, file, IMAGE_DIMENSIONS_HEADER_BYTES).pipe(
    Effect.map(readImageDimensions),
    Effect.orElseSucceed((): ImageDimensions | null => null),
  );

// Non-blocking open prevents swapped-in FIFOs from hanging the request.
const readImageDimensionsFromHeader = (filePath: string) =>
  openMediaFile(filePath).pipe(
    Effect.flatMap((file) =>
      file === null ? Effect.succeed(null) : readImageDimensionsFromOpenFile(filePath, file),
    ),
    Effect.scoped,
    Effect.orElseSucceed((): ImageDimensions | null => null),
  );

const finalizeAbsoluteMediaFileAsset = Effect.fn("AssetAccess.finalizeAbsoluteMediaFileAsset")(
  function* (input: {
    readonly requestedPath: string;
    readonly expectedCanonicalPath?: string;
    readonly workspaceRoot: string | undefined;
    readonly resource: AssetResource;
    readonly expiresAt: number;
  }) {
    const path = yield* Path.Path;
    // Resolving a network path makes Windows sign in to its host with the
    // user's NTLM credentials, so only the thread's own project may be on a share.
    // Windows reads a `\\?\` path as written, `..` included, so the lookup gets
    // the resolved path this check approved.
    const requestedPath = path.resolve(input.requestedPath);
    if (
      isNetworkPath(input.requestedPath) &&
      (input.workspaceRoot === undefined ||
        !isWithinRoot(path, requestedPath, path.resolve(input.workspaceRoot)))
    ) {
      return yield* new AssetWorkspaceAssetNotFoundError({
        resource: input.resource,
        checkedPath: input.requestedPath,
      });
    }
    const canonicalFile = yield* resolveCanonicalFile(requestedPath).pipe(
      Effect.mapError(
        (cause) => new AssetWorkspaceAssetInspectionError({ resource: input.resource, cause }),
      ),
    );
    // The workspace caller pins its containment-checked path; never follow a
    // replacement symlink to a different file during this second resolution.
    if (
      !canonicalFile ||
      (input.expectedCanonicalPath !== undefined && canonicalFile !== input.expectedCanonicalPath)
    ) {
      return yield* new AssetWorkspaceAssetNotFoundError({
        resource: input.resource,
        checkedPath: input.requestedPath,
      });
    }
    const download =
      (input.resource._tag === "media-file" && input.resource.disposition === "attachment") ||
      input.resource._tag === "workspace-download";
    if (!download && hostPreviewMimeTypeFromExtension(path.extname(canonicalFile)) === null) {
      return yield* new AssetPreviewTypeValidationError({ resource: input.resource });
    }
    const wantsDimensions = HEADER_IMAGE_EXTENSIONS.has(path.extname(canonicalFile).toLowerCase());
    const opened = yield* openMediaFile(canonicalFile).pipe(
      Effect.flatMap((file) =>
        file === null
          ? Effect.succeed(null)
          : Effect.map(
              wantsDimensions
                ? readImageDimensionsFromOpenFile(canonicalFile, file)
                : Effect.succeed(null),
              (dimensions) => ({
                identity: { device: file.info.dev.toString(), inode: file.info.ino.toString() },
                fileRevision: `${file.info.dev}:${file.info.ino}:${file.info.size}:${file.info.mtimeNs}:${file.info.ctimeNs}`,
                dimensions,
              }),
            ),
      ),
      Effect.scoped,
      Effect.mapError(
        (cause) => new AssetWorkspaceAssetInspectionError({ resource: input.resource, cause }),
      ),
    );
    if (!opened) {
      return yield* new AssetWorkspaceAssetNotFoundError({
        resource: input.resource,
        checkedPath: input.requestedPath,
      });
    }
    return {
      claims: {
        version: 1 as const,
        kind: "media-file-exact" as const,
        filePath: canonicalFile,
        ...(download ? { download: true } : {}),
        ...opened.identity,
        expiresAt: input.expiresAt,
      },
      fileName: path.basename(canonicalFile),
      fileRevision: opened.fileRevision,
      imageDimensions: opened.dimensions,
    };
  },
);

const finalizeWorkspaceFileAsset = Effect.fn("AssetAccess.finalizeWorkspaceFileAsset")(
  function* (input: {
    readonly workspaceRoot: string;
    readonly requestedPath: string;
    readonly resource: AssetResource;
    readonly expiresAt: number;
  }) {
    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;
    const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
    const relativePath = path.isAbsolute(input.requestedPath)
      ? path.relative(input.workspaceRoot, input.requestedPath)
      : input.requestedPath;
    const resolved = yield* workspacePaths
      .resolveRelativePathWithinRoot({ workspaceRoot: input.workspaceRoot, relativePath })
      .pipe(
        Effect.mapError(
          (cause) =>
            new AssetWorkspacePathValidationError({
              resource: input.resource,
              cause,
            }),
        ),
      );
    const isDraftMedia =
      input.resource._tag === "draft-workspace-file" &&
      (isWorkspaceAudioPreviewPath(resolved.relativePath) ||
        isWorkspaceVideoPreviewPath(resolved.relativePath));
    if (!isDraftMedia && !isWorkspacePreviewEntryPath(resolved.relativePath)) {
      return yield* new AssetPreviewTypeValidationError({
        resource: input.resource,
      });
    }
    const canonicalFile = yield* resolveCanonicalWorkspaceFile({
      workspaceRoot: input.workspaceRoot,
      relativePath: resolved.relativePath,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new AssetWorkspaceAssetInspectionError({
            resource: input.resource,
            cause,
          }),
      ),
    );
    if (!canonicalFile) {
      return yield* new AssetWorkspaceAssetNotFoundError({
        resource: input.resource,
      });
    }
    if (isDraftMedia) {
      return yield* finalizeAbsoluteMediaFileAsset({
        ...input,
        requestedPath: canonicalFile,
        expectedCanonicalPath: canonicalFile,
      });
    }
    const canonicalWorkspaceRoot = yield* fileSystem.realPath(input.workspaceRoot).pipe(
      Effect.mapError(
        (cause) =>
          new AssetWorkspaceResolutionError({
            resource: input.resource,
            cause,
          }),
      ),
    );
    const imageDimensions = HEADER_IMAGE_EXTENSIONS.has(
      path.extname(resolved.relativePath).toLowerCase(),
    )
      ? yield* readImageDimensionsFromHeader(canonicalFile)
      : null;
    return {
      claims: !/\.html?$/i.test(resolved.relativePath)
        ? {
            version: 1 as const,
            kind: "workspace-file-exact" as const,
            workspaceRoot: canonicalWorkspaceRoot,
            relativePath: resolved.relativePath,
            expiresAt: input.expiresAt,
          }
        : {
            version: 1 as const,
            kind: "workspace-file" as const,
            workspaceRoot: canonicalWorkspaceRoot,
            baseRelativePath: path.dirname(resolved.relativePath),
            expiresAt: input.expiresAt,
          },
      fileName: path.basename(resolved.relativePath),
      imageDimensions,
      fileRevision: undefined,
    };
  },
);

export const issueAssetUrl = Effect.fn("AssetAccess.issueAssetUrl")(function* (input: {
  readonly resource: AssetResource;
  readonly workspaceRoot?: string;
  readonly projectFaviconPath?: string;
  /** Where a cloned project's checkout stands, while the clone tracker still knows it. */
  readonly projectCheckout?: "pending" | "cloned";
  /** Spec 5: the User asking; a checkout file is served to them masked with their values. */
  readonly viewer?: string | undefined;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  let expiresAt = (yield* Clock.currentTimeMillis) + ASSET_TOKEN_TTL_MS;
  let claims: AssetClaims;
  let fileName: string;
  let sourcePath: string | undefined;
  let imageDimensions: ImageDimensions | null = null;
  let fileRevision: string | undefined;

  switch (input.resource._tag) {
    case "media-file": {
      let requestedPath = expandHomePath(input.resource.path, yield* HostProcess.HomeDirectory);
      if (!path.isAbsolute(requestedPath)) {
        if (!input.workspaceRoot) {
          return yield* new AssetWorkspaceContextNotFoundError({ resource: input.resource });
        }
        const workspaceRoot = yield* workspacePaths
          .normalizeWorkspaceRoot(input.workspaceRoot)
          .pipe(
            Effect.mapError(
              (cause) =>
                new AssetWorkspaceRootNormalizationError({ resource: input.resource, cause }),
            ),
          );
        requestedPath = path.resolve(workspaceRoot, requestedPath);
      }
      const finalized = yield* finalizeAbsoluteMediaFileAsset({
        requestedPath,
        workspaceRoot: input.workspaceRoot,
        resource: input.resource,
        expiresAt,
      });
      claims = finalized.claims;
      fileName = finalized.fileName;
      imageDimensions = finalized.imageDimensions;
      fileRevision = finalized.fileRevision;
      break;
    }
    case "workspace-file": {
      if (!input.workspaceRoot) {
        return yield* new AssetWorkspaceContextNotFoundError({
          resource: input.resource,
        });
      }
      const workspaceRoot = yield* workspacePaths.normalizeWorkspaceRoot(input.workspaceRoot).pipe(
        Effect.mapError(
          (cause) =>
            new AssetWorkspaceRootNormalizationError({
              resource: input.resource,
              cause,
            }),
        ),
      );
      const finalized = yield* finalizeWorkspaceFileAsset({
        workspaceRoot,
        requestedPath: input.resource.path,
        resource: input.resource,
        expiresAt,
      });
      claims = finalized.claims;
      fileName = finalized.fileName;
      imageDimensions = finalized.imageDimensions;
      break;
    }
    case "draft-workspace-file": {
      const draftWorkspaceRoot = input.workspaceRoot ?? input.resource.cwd;
      const hostPath = input.resource.path.startsWith("~/")
        ? expandHomePath(input.resource.path, yield* HostProcess.HomeDirectory)
        : input.resource.path;
      if (path.isAbsolute(hostPath)) {
        const finalized = yield* finalizeAbsoluteMediaFileAsset({
          requestedPath: hostPath,
          workspaceRoot: draftWorkspaceRoot,
          resource: input.resource,
          expiresAt,
        });
        claims = finalized.claims;
        fileName = finalized.fileName;
        imageDimensions = finalized.imageDimensions;
        fileRevision = finalized.fileRevision;
        break;
      }
      const workspaceRoot = yield* workspacePaths.normalizeWorkspaceRoot(draftWorkspaceRoot).pipe(
        Effect.mapError(
          (cause) =>
            new AssetWorkspaceRootNormalizationError({
              resource: input.resource,
              cause,
            }),
        ),
      );
      const finalized = yield* finalizeWorkspaceFileAsset({
        workspaceRoot,
        requestedPath: input.resource.path,
        resource: input.resource,
        expiresAt,
      });
      claims = finalized.claims;
      fileName = finalized.fileName;
      imageDimensions = finalized.imageDimensions;
      fileRevision = finalized.fileRevision;
      break;
    }
    case "workspace-download": {
      const resource = input.resource;
      const workspaceRoot = yield* workspacePaths
        .normalizeWorkspaceRoot(resource.cwd)
        .pipe(
          Effect.mapError((cause) => new AssetWorkspaceRootNormalizationError({ resource, cause })),
        );
      const inspectionError = (cause: unknown) =>
        new AssetWorkspaceAssetInspectionError({ resource, cause });
      const canonicalRoot = yield* fileSystem
        .realPath(workspaceRoot)
        .pipe(Effect.mapError(inspectionError));
      const targets: Array<{ readonly path: string; readonly type: string }> = [];
      for (const relativePath of new Set(resource.paths)) {
        const resolved = yield* workspacePaths
          .resolveRelativePathWithinRoot({ workspaceRoot, relativePath })
          .pipe(
            Effect.mapError((cause) => new AssetWorkspacePathValidationError({ resource, cause })),
          );
        const canonical = yield* fileSystem
          .realPath(resolved.absolutePath)
          .pipe(Effect.orElseSucceed(() => null));
        const info =
          canonical !== null && isWithinRoot(path, canonical, canonicalRoot)
            ? yield* fileSystem.stat(canonical).pipe(Effect.mapError(inspectionError))
            : null;
        if (canonical === null || (info?.type !== "File" && info?.type !== "Directory")) {
          return yield* new AssetWorkspaceAssetNotFoundError({ resource });
        }
        targets.push({ path: canonical, type: info.type });
      }
      const [only] = targets;
      if (targets.length === 1 && only?.type === "File") {
        const finalized = yield* finalizeAbsoluteMediaFileAsset({
          requestedPath: only.path,
          expectedCanonicalPath: only.path,
          workspaceRoot,
          resource,
          expiresAt,
        });
        claims = finalized.claims;
        fileName = finalized.fileName;
        yield* recordDownload({ resource, viewer: input.viewer, detail: { files: 1 } });
        break;
      }
      return yield* issueArchiveDownload({
        resource,
        workspaceRoot: canonicalRoot,
        targets: targets.map((target) => target.path),
        expiresAt,
        viewer: input.viewer,
      });
    }
    case "attachment": {
      const config = yield* ServerConfig.ServerConfig;
      const attachmentPath = resolveAttachmentPathById({
        attachmentsDir: config.attachmentsDir,
        attachmentId: input.resource.attachmentId,
      });
      if (!attachmentPath) {
        return yield* new AssetAttachmentNotFoundError({
          resource: input.resource,
        });
      }
      const extension = parseAttachmentFileExtension(input.resource.attachmentId);
      const isGenericFile = extension !== null;
      const videoMimeType = input.resource.mimeType?.split(";", 1)[0]?.trim() ?? "";
      const isVideo = INLINE_VIDEO_MIME_TYPE_PATTERN.test(videoMimeType);
      const inlinePreviewMimeType =
        input.resource.disposition === "inline" && extension !== null
          ? inlinePreviewMimeTypeForExtension(extension)
          : undefined;
      if (!isGenericFile) {
        imageDimensions = yield* fileSystem.realPath(attachmentPath).pipe(
          Effect.flatMap(readImageDimensionsFromHeader),
          Effect.orElseSucceed(() => null),
        );
      }
      claims = {
        version: 1,
        kind: "attachment",
        attachmentId: input.resource.attachmentId,
        ...(isGenericFile && !isVideo && inlinePreviewMimeType === undefined
          ? { download: true }
          : {}),
        ...(input.resource.fileName !== undefined ? { fileName: input.resource.fileName } : {}),
        ...(inlinePreviewMimeType !== undefined
          ? { mimeType: inlinePreviewMimeType }
          : input.resource.mimeType !== undefined
            ? { mimeType: isVideo ? videoMimeType : input.resource.mimeType }
            : {}),
        ...(input.resource.renderIntent === "mcp-app" && inlinePreviewMimeType === "text/html"
          ? { renderIntent: "mcp-app" as const }
          : {}),
        expiresAt,
      };
      fileName = input.resource.fileName ?? path.basename(attachmentPath);
      break;
    }
    case "project-favicon": {
      const workspaceRoot = yield* workspacePaths.normalizeWorkspaceRoot(input.resource.cwd).pipe(
        Effect.mapError(
          (cause) =>
            new AssetWorkspaceRootNormalizationError({
              resource: input.resource,
              cause,
            }),
        ),
      );
      const faviconResolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
      // A lookup in a half-cloned checkout would cache a miss that outlives the clone.
      // Once it lands, a miss cached before (by enrichment) is stale too.
      if (input.projectCheckout === "cloned") yield* faviconResolver.invalidate(workspaceRoot);
      const faviconPath =
        input.projectCheckout === "pending"
          ? null
          : yield* faviconResolver
              .resolvePath(workspaceRoot, input.projectFaviconPath ?? undefined)
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new AssetProjectFaviconResolutionError({
                      resource: input.resource,
                      cause,
                    }),
                ),
              );
      const isExternalOverride =
        faviconPath !== null &&
        input.projectFaviconPath !== undefined &&
        path.isAbsolute(input.projectFaviconPath) &&
        path.normalize(faviconPath) === path.normalize(input.projectFaviconPath);
      const relativePath =
        faviconPath && !isExternalOverride ? path.relative(workspaceRoot, faviconPath) : null;
      const sourceFaviconPath = isExternalOverride ? faviconPath : relativePath;
      if (sourceFaviconPath && !isProjectFaviconPath(sourceFaviconPath)) {
        return yield* new AssetPreviewTypeValidationError({ resource: input.resource });
      }
      sourcePath = sourceFaviconPath ?? undefined;
      const canonicalFaviconPath = sourceFaviconPath
        ? yield* (
            isExternalOverride
              ? resolveCanonicalFile(sourceFaviconPath)
              : resolveCanonicalWorkspaceFile({ workspaceRoot, relativePath: sourceFaviconPath })
          ).pipe(
            Effect.mapError(
              (cause) =>
                new AssetProjectFaviconInspectionError({
                  resource: input.resource,
                  cause,
                }),
            ),
          )
        : null;
      if (sourceFaviconPath && !canonicalFaviconPath) {
        return yield* new AssetProjectFaviconNotFoundError({
          resource: input.resource,
        });
      }
      claims =
        isExternalOverride && canonicalFaviconPath
          ? {
              version: 1,
              kind: "project-favicon-external",
              filePath: canonicalFaviconPath,
              expiresAt,
            }
          : {
              version: 1,
              kind: "project-favicon",
              workspaceRoot: yield* fileSystem.realPath(workspaceRoot).pipe(
                Effect.mapError(
                  (cause) =>
                    new AssetWorkspaceResolutionError({
                      resource: input.resource,
                      cause,
                    }),
                ),
              ),
              relativePath,
              expiresAt,
            };
      if (sourceFaviconPath && canonicalFaviconPath) {
        const digest = yield* Digest.Digest;
        const faviconBytes = yield* fileSystem.readFile(canonicalFaviconPath).pipe(
          Effect.mapError(
            (cause) =>
              new AssetProjectFaviconInspectionError({
                resource: input.resource,
                cause,
              }),
          ),
        );
        const revision = yield* digest.digest(Digest.sha256, faviconBytes).pipe(
          Effect.map(Hex.encode),
          Effect.mapError(
            (cause) =>
              new AssetProjectFaviconInspectionError({
                resource: input.resource,
                cause,
              }),
          ),
        );
        fileName = `${PROJECT_FAVICON_VERSION_PREFIX}${revision}-${path.basename(sourceFaviconPath)}`;
      } else {
        fileName = PROJECT_FAVICON_FALLBACK_MARKER;
      }
      break;
    }
    case "tool-output-image": {
      const image = yield* readToolOutputImage(input.resource).pipe(
        Effect.mapError(
          (cause) => new AssetWorkspaceAssetInspectionError({ resource: input.resource, cause }),
        ),
      );
      if (image === null) {
        return yield* new AssetWorkspaceAssetNotFoundError({ resource: input.resource });
      }
      claims = {
        version: 1,
        kind: "tool-output-image",
        threadId: input.resource.threadId,
        itemId: input.resource.itemId,
        index: input.resource.index,
        expiresAt,
      };
      fileName = `image-${input.resource.index + 1}.${image.mimeType.slice("image/".length)}`;
      imageDimensions = readImageDimensions(image.bytes);
      break;
    }
    case "native-app-icon": {
      claims = {
        version: 1,
        kind: "native-app-icon",
        app: input.resource.app,
        expiresAt,
      };
      fileName = "native-app-icon.png";
      break;
    }
    case SOURCE_CONTROL_MEDIA_ASSET: {
      const media = sourceControlDefinitions.mediaUrl(input.resource.url);
      if (media === null) {
        return yield* new AssetSourceControlMediaUrlValidationError({});
      }
      claims = {
        version: 1,
        kind: SOURCE_CONTROL_MEDIA_ASSET,
        url: media.fetchUrl,
        cwd: input.resource.cwd,
        expiresAt,
      };
      fileName = media.fileName;
      break;
    }
  }

  if (claims.kind === "project-favicon" || claims.kind === "project-favicon-external") {
    const issuedAt = yield* Clock.currentTimeMillis;
    expiresAt =
      (Math.floor(issuedAt / PROJECT_FAVICON_TOKEN_BUCKET_MS) + 2) *
      PROJECT_FAVICON_TOKEN_BUCKET_MS;
    claims = { ...claims, expiresAt };
  }
  if (claims.kind === "attachment" && claims.mimeType === "text/html") {
    // Stable URLs let immutable HTML reloads hit the cache; image retries need fresh URLs.
    expiresAt =
      Math.ceil(expiresAt / HTML_ATTACHMENT_TOKEN_BUCKET_MS) * HTML_ATTACHMENT_TOKEN_BUCKET_MS;
    claims = { ...claims, expiresAt };
  }
  if (
    input.viewer !== undefined &&
    (claims.kind === "workspace-file" ||
      claims.kind === "workspace-file-exact" ||
      claims.kind === "media-file-exact")
  ) {
    claims = { ...claims, viewer: input.viewer };
  }
  const token = yield* signClaims(claims, input.resource);
  return {
    relativeUrl: `${ASSET_ROUTE_PREFIX}/${token}/${encodeURIComponent(fileName)}`,
    expiresAt,
    ...(sourcePath !== undefined ? { sourcePath } : {}),
    ...(imageDimensions !== null ? { imageDimensions } : {}),
    ...(fileRevision !== undefined ? { fileRevision } : {}),
  };
});

/**
 * Ticket 15: a URL for a file of a Thread that runs on another machine. The machine looks at the
 * file (inside the Thread's workspace, symlinks followed); the Hub applies the same preview types
 * as for its own files, to the path asked for and to where it leads.
 */
export const issueMachineAssetUrl = Effect.fn("AssetAccess.issueMachineAssetUrl")(
  function* (input: {
    readonly resource: Extract<AssetResource, { _tag: "workspace-file" | "media-file" }>;
    readonly source: MachineAssetSource;
    readonly viewer?: string | undefined;
  }) {
    const { resource, source } = input;
    const requested = source.toRelative(resource.path);
    if (requested === undefined || requested === ".") {
      return yield* new AssetRemoteEnvironmentError({
        resource,
        reason: "outside_thread_workspace",
        detail: `Only files in this Thread's workspace on ${source.name} can be opened.`,
      });
    }
    const download = resource._tag === "media-file" && resource.disposition === "attachment";
    const allowed = (relativePath: string) =>
      resource._tag === "workspace-file"
        ? isWorkspacePreviewEntryPath(relativePath)
        : download || hostPreviewMimeTypeFromExtension(posixExtname(relativePath)) !== null;
    if (!allowed(requested)) return yield* new AssetPreviewTypeValidationError({ resource });
    const inspection = yield* source.inspect(requested).pipe(
      Effect.catchTags({
        MachineAssetError: () => Effect.fail(new AssetWorkspaceAssetNotFoundError({ resource })),
        MachineAssetUnavailableError: (error) =>
          Effect.fail(
            new AssetRemoteEnvironmentError({
              resource,
              reason: error.reason,
              detail: error.detail,
            }),
          ),
      }),
    );
    // A link inside the workspace to a file of another type is judged as that file.
    if (!allowed(inspection.relativePath)) {
      return yield* new AssetPreviewTypeValidationError({ resource });
    }
    const html = resource._tag === "workspace-file" && /\.html?$/i.test(requested);
    const expiresAt = (yield* Clock.currentTimeMillis) + ASSET_TOKEN_TTL_MS;
    const claims: AssetClaims = {
      version: 1,
      kind: "thread-machine-file",
      threadId: resource.threadId,
      environmentId: source.environmentId,
      mode: html ? "html-base" : "exact",
      path: html ? posixDirname(requested) : inspection.relativePath,
      // A media file is pinned as on the Hub machine: replaced since, it needs a new URL.
      ...(resource._tag === "media-file" ? inspection.identity : {}),
      ...(download ? { download: true } : {}),
      expiresAt,
      ...(input.viewer === undefined ? {} : { viewer: input.viewer }),
    };
    const encodedPayload = base64UrlEncode(encodeAssetClaims(claims));
    const signer = yield* AssetSigner.AssetSigner;
    const signature = yield* signer
      .sign(encodedPayload)
      .pipe(Effect.mapError((cause) => new AssetSigningKeyLoadError({ resource, cause })));
    const fileName = posixBasename(html ? requested : inspection.relativePath);
    return {
      relativeUrl: `${ASSET_ROUTE_PREFIX}/${encodedPayload}.${signature}/${encodeURIComponent(fileName)}`,
      expiresAt,
      ...(inspection.imageDimensions === undefined
        ? {}
        : { imageDimensions: inspection.imageDimensions }),
      ...(resource._tag === "media-file" ? { fileRevision: inspection.revision } : {}),
    };
  },
);

export const resolveAsset = Effect.fn("AssetAccess.resolveAsset")(function* (
  token: string,
  relativePath: string,
) {
  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) return null;

  const signer = yield* AssetSigner.AssetSigner;
  const verified = yield* signer.verify(encodedPayload, signature).pipe(
    Effect.tapError((cause) => Effect.logError("Failed to load the asset signing key.", { cause })),
    Effect.orElseSucceed(() => false),
  );
  if (!verified) return null;

  const claims = decodeClaims(encodedPayload);
  if (!claims || claims.expiresAt <= (yield* Clock.currentTimeMillis)) return null;

  if (claims.kind === "attachment") {
    const config = yield* ServerConfig.ServerConfig;
    const attachmentPath = resolveAttachmentPathById({
      attachmentsDir: config.attachmentsDir,
      attachmentId: claims.attachmentId,
    });
    if (!attachmentPath) return null;
    const fileSystem = yield* FileSystem.FileSystem;
    const info = yield* ProjectFaviconResolver.optionOnNotFound(
      fileSystem.stat(attachmentPath),
    ).pipe(
      Effect.tapError((cause) =>
        Effect.logError("Failed to inspect attachment asset.", {
          attachmentId: claims.attachmentId,
          path: attachmentPath,
          cause,
        }),
      ),
      Effect.orElseSucceed(() => Option.none()),
    );
    return Option.isSome(info) && info.value.type === "File"
      ? ({
          kind: "file",
          path: attachmentPath,
          ...(claims.download ? { download: true } : {}),
          ...(claims.fileName !== undefined ? { fileName: claims.fileName } : {}),
          ...(claims.mimeType !== undefined ? { mimeType: claims.mimeType } : {}),
          ...(claims.renderIntent === "mcp-app" ? { renderIntent: "mcp-app" as const } : {}),
        } satisfies ResolvedAsset)
      : null;
  }

  if (claims.kind === "project-favicon") {
    if (claims.relativePath === null) return null;
    const faviconPath = yield* resolveCanonicalWorkspaceFileForRequest({
      workspaceRoot: claims.workspaceRoot,
      relativePath: claims.relativePath,
    });
    return faviconPath ? yield* projectFaviconAsset(faviconPath) : null;
  }

  if (claims.kind === "project-favicon-external") {
    const faviconPath = yield* resolveCanonicalFile(claims.filePath).pipe(
      Effect.tapError((cause) =>
        Effect.logError("Failed to resolve canonical asset path.", {
          filePath: claims.filePath,
          cause,
        }),
      ),
      Effect.orElseSucceed(() => null),
    );
    return faviconPath === claims.filePath ? yield* projectFaviconAsset(faviconPath) : null;
  }

  if (claims.kind === SOURCE_CONTROL_MEDIA_ASSET) {
    return {
      kind: "source-control-media",
      url: claims.url,
      cwd: claims.cwd,
      expiresAt: claims.expiresAt,
    } satisfies ResolvedAsset;
  }

  if (claims.kind === "tool-output-image") {
    const image = yield* readToolOutputImage(claims).pipe(
      Effect.tapError((cause) =>
        Effect.logError("Failed to read tool output image.", {
          threadId: claims.threadId,
          itemId: claims.itemId,
          cause,
        }),
      ),
      Effect.orElseSucceed(() => null),
    );
    return image ? ({ kind: "bytes", ...image } satisfies ResolvedAsset) : null;
  }

  if (claims.kind === "native-app-icon") {
    const nativeAppIconResolver = yield* NativeAppIconResolver.NativeAppIconResolver;
    const iconPath = yield* nativeAppIconResolver.resolve(claims.app);
    return iconPath ? ({ kind: "file", path: iconPath } satisfies ResolvedAsset) : null;
  }

  const decodedPath = decodeRelativePath(relativePath);
  if (decodedPath === null) return null;
  if (claims.kind === "workspace-folder-zip") {
    return yield* resolveFolderZip(claims, decodedPath);
  }
  if (claims.kind === "thread-machine-file") {
    let served: string;
    if (claims.mode === "exact") {
      if (decodedPath !== posixBasename(claims.path)) return null;
      served = claims.path;
    } else {
      if (!isPreviewSubPath(decodedPath)) return null;
      const sub = decodedPath
        .split(/[\\/]/)
        .filter((segment) => segment !== "")
        .join("/");
      served = claims.path === "." ? sub : `${claims.path}/${sub}`;
    }
    return {
      kind: "machine-file",
      threadId: claims.threadId,
      environmentId: claims.environmentId,
      relativePath: served,
      ...(claims.device !== undefined && claims.inode !== undefined
        ? { identity: { device: claims.device, inode: claims.inode } }
        : {}),
      ...(claims.download === true ? { download: true } : {}),
      fileName: posixBasename(served),
      ...(claims.viewer === undefined ? {} : { viewer: claims.viewer }),
    } satisfies ResolvedAsset;
  }
  const path = yield* Path.Path;
  if (claims.kind === "media-file-exact") {
    if (decodedPath !== path.basename(claims.filePath)) return null;
    const canonicalFile = yield* resolveCanonicalFile(claims.filePath).pipe(
      Effect.tapError((cause) =>
        Effect.logError("Failed to resolve canonical media path.", {
          filePath: claims.filePath,
          cause,
        }),
      ),
      Effect.orElseSucceed(() => null),
    );
    if (canonicalFile !== claims.filePath) return null;
    const mimeType = claims.download
      ? "application/octet-stream"
      : hostPreviewMimeTypeFromExtension(path.extname(canonicalFile));
    if (!mimeType) return null;
    const file = yield* openMediaFile(canonicalFile, claims).pipe(
      Effect.tapError((cause) =>
        Effect.logError("Failed to open canonical media file.", { filePath: canonicalFile, cause }),
      ),
      Effect.orElseSucceed(() => null),
    );
    return file
      ? ({
          kind: "file",
          path: canonicalFile,
          mimeType,
          file,
          ...(claims.download ? { download: true, fileName: path.basename(canonicalFile) } : {}),
          checkout: true,
          ...(claims.viewer === undefined ? {} : { viewer: claims.viewer }),
        } satisfies ResolvedAsset)
      : null;
  }
  if (claims.kind === "workspace-file-exact") {
    if (decodedPath !== path.basename(claims.relativePath)) return null;
    const exactWorkspaceFile = yield* resolveCanonicalWorkspaceFileForRequest({
      workspaceRoot: claims.workspaceRoot,
      relativePath: claims.relativePath,
    });
    return exactWorkspaceFile
      ? ({
          kind: "file",
          path: exactWorkspaceFile,
          checkout: true,
          ...(claims.viewer === undefined ? {} : { viewer: claims.viewer }),
        } satisfies ResolvedAsset)
      : null;
  }
  if (!isPreviewSubPath(decodedPath)) return null;
  const joinedRelativePath =
    claims.baseRelativePath === "." ? decodedPath : path.join(claims.baseRelativePath, decodedPath);
  const workspaceFile = yield* resolveCanonicalWorkspaceFileForRequest({
    workspaceRoot: claims.workspaceRoot,
    relativePath: joinedRelativePath,
  });
  return workspaceFile
    ? ({
        kind: "file",
        path: workspaceFile,
        checkout: true,
        ...(claims.viewer === undefined ? {} : { viewer: claims.viewer }),
      } satisfies ResolvedAsset)
    : null;
});
