import * as Mime from "effect/http/Mime";
import {
  AI_GATEWAY_ROUTE_PREFIX,
  AuthOrchestrationOperateScope,
  AuthDiagnosticsReadScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  UserId,
} from "@t3tools/contracts";
import { isDevProxiedPath } from "@t3tools/shared/devProxy";
import { injectMcpAppCookieBootstrap, injectMcpAppThemeBootstrap } from "@t3tools/shared/mcpApp";
import { decodeOtlpTraceRecords } from "@t3tools/shared/observability";
import * as ByteSize from "effect/ByteSize";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { cast, pipe } from "effect/Function";
import {
  HttpClient,
  HttpClientResponse,
  HttpMiddleware,
  HttpRouter,
  HttpServerResponse,
  HttpServerRequest,
  HttpServerRespondable,
} from "effect/http";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { OtlpTracer, OtlpSerialization } from "effect/observability";

import * as ServerConfig from "./config.ts";
import * as SpaceVisibility from "./spaces/SpaceVisibility.ts";
import { ASSET_ROUTE_PREFIX, readMcpAppHtml, resolveAsset } from "./assets/AssetAccess.ts";
import { sourceControlMediaResponse } from "./assets/sourceControlMediaResponse.ts";
import { machineAssetResponse } from "./assets/MachineAssetResponse.ts";
import * as ThreadWorkspace from "./environment/ThreadWorkspace.ts";
import { statMediaFile, streamMediaFile, type OpenMediaFile } from "./assets/MediaFile.ts";
import {
  ATTACHMENT_UPLOAD_ROUTE_PREFIX,
  storeAttachmentUpload,
  validateAttachmentUploadToken,
} from "./assets/AttachmentUpload.ts";
import * as BrowserTraceCollector from "./observability/BrowserTraceCollector.ts";
import { layerClientAdmission } from "./auth/clientAdmission.ts";
import { DEFAULT_TRUSTED_PROXIES } from "./auth/clientConnection.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentScopeRequired,
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
} from "./auth/http.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import { WEBHOOK_ROUTE_PREFIX } from "./scheduledTasks/ScheduledTaskService.ts";
import {
  browserApiCorsAllowedHeaders,
  browserApiCorsAllowedMethods,
  DESKTOP_RENDERER_ORIGINS,
} from "./httpCors.ts";
import { IDENTITY_DISCOVERY_PATH, IDENTITY_JWKS_PATH, identityResponse } from "./identity/http.ts";
import { requestUrl } from "./requestUrl.ts";
import { maskedAssetText } from "./vaults/maskAssets.ts";
import {
  assetByteRange,
  assetResponseHeaders,
  downloadContentDisposition,
} from "./assets/assetHeaders.ts";

export { assetResponseHeaders, downloadContentDisposition };

const OTLP_TRACES_PROXY_PATH = "/api/observability/v1/traces";
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);
export const assetFileResponse = Effect.fn("assetFileResponse")(function* (
  asset: {
    readonly path: string;
    readonly download?: boolean;
    readonly fileName?: string;
    readonly mimeType?: string;
    readonly file?: OpenMediaFile;
    readonly renderIntent?: "mcp-app";
  },
  rangeHeader?: string,
  ifRangeHeader?: string,
  method: "GET" | "HEAD" = "GET",
) {
  const headers = assetResponseHeaders(asset.path, asset);
  if (
    asset.renderIntent === "mcp-app" &&
    !asset.download &&
    headers["Content-Type"] === "text/html; charset=utf-8"
  ) {
    const bytes = yield* readMcpAppHtml(asset.path);
    if (bytes === null) {
      return HttpServerResponse.text("MCP app is too large to preview.", { status: 413 });
    }
    const body = pipe(
      new TextDecoder().decode(bytes),
      injectMcpAppThemeBootstrap,
      injectMcpAppCookieBootstrap,
      (html) => new TextEncoder().encode(html),
    );
    headers["Content-Length"] = String(body.byteLength);
    return method === "HEAD"
      ? HttpServerResponse.empty({ status: 200, headers })
      : HttpServerResponse.uint8Array(body, { headers });
  }
  const mediaFile = asset.file;
  const mediaInfo = mediaFile ? yield* statMediaFile(asset.path, mediaFile) : undefined;
  const isMedia = /^(?:audio|video)\//i.test(headers["Content-Type"] ?? "");
  if (isMedia) {
    // Without file identity, validators cannot guarantee byte equality; attachments must also expire with their URL.
    headers["Cache-Control"] = "private, no-store";
  }
  let status = 200;
  let offset = 0n;
  let bytesToRead: bigint | undefined;
  {
    headers["Accept-Ranges"] = "bytes";
    // If-Range requires a matching validator. A full response is safe when we cannot validate it.
    if (method === "GET" && rangeHeader && ifRangeHeader === undefined) {
      const fs = yield* FileSystem.FileSystem;
      const info = mediaInfo ?? (yield* fs.stat(asset.path));
      const range = assetByteRange(rangeHeader, info.size);
      if (range?._tag === "Unsatisfiable") {
        return HttpServerResponse.empty({
          status: 416,
          headers: { ...headers, "Content-Range": `bytes */${info.size}` },
        });
      }
      if (range?._tag === "Range") {
        status = 206;
        offset = range.offset;
        bytesToRead = range.bytesToRead;
        headers["Content-Range"] = range.contentRange;
      }
    }
  }
  if (mediaFile && mediaInfo) {
    const size = bytesToRead ?? mediaInfo.size;
    headers["Content-Type"] ??= Option.getOrElse(
      Mime.getType(asset.path),
      () => "application/octet-stream",
    );
    headers["Content-Length"] = String(size);
    if (!isMedia) {
      headers["Last-Modified"] = mediaInfo.mtime.toUTCString();
      headers.ETag = `W/"${mediaInfo.size.toString(16)}-${mediaInfo.mtimeMs.toString(16)}"`;
    }
    if (method === "HEAD" || size === 0n) {
      return HttpServerResponse.empty({ status, headers });
    }
    const body = streamMediaFile(mediaFile, offset, size);
    if (!body) {
      return HttpServerResponse.text("File is too large to preview.", { status: 413 });
    }
    return HttpServerResponse.stream(body, {
      status,
      headers,
    });
  }
  return yield* HttpServerResponse.file(asset.path, { status, offset, bytesToRead, headers });
});

export const layerClientConnection = Layer.unwrap(
  Effect.map(ServerConfig.ServerConfig, (config) =>
    layerClientAdmission(config.trustedProxies ?? DEFAULT_TRUSTED_PROXIES),
  ),
);

export const layerHttpCompression = HttpRouter.middleware(HttpMiddleware.compression(), {
  global: true,
});

export const layerBrowserApiCors = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const devOrigin = config.devUrl?.origin;
    // Credentialed dev requests need explicit Vite/Electron origins; packaged desktop uses the default wildcard.
    return HttpRouter.cors({
      ...(devOrigin
        ? {
            allowedOrigins: [devOrigin, ...DESKTOP_RENDERER_ORIGINS, ...config.devAllowedOrigins],
            credentials: true,
          }
        : {}),
      allowedMethods: browserApiCorsAllowedMethods,
      allowedHeaders: browserApiCorsAllowedHeaders,
      maxAge: 600,
    });
  }),
);

function isLoopbackHostname(hostname: string): boolean {
  const normalizedHostname = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  return LOOPBACK_HOSTNAMES.has(normalizedHostname);
}

function resolveDevRedirectUrl(devUrl: URL, requestUrl: URL): string {
  const redirectUrl = new URL(devUrl.toString());
  redirectUrl.pathname = requestUrl.pathname;
  redirectUrl.search = requestUrl.search;
  redirectUrl.hash = requestUrl.hash;
  return redirectUrl.toString();
}

const authenticateRawRouteWithScope =
  /* Request instrumentation already owns the span; keep this helper in that context. */
  Effect.fnUntraced(function* (
    scope: typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope,
  ) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
      Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
        failEnvironmentAuthInvalid(
          EnvironmentAuth.serverAuthCredentialReason(error),
          EnvironmentAuth.serverAuthDpopFailureReason(error),
        ),
      ),
      Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
        failEnvironmentInternal("internal_error", error),
      ),
    );
    if (!session.scopes.includes(scope)) {
      return yield* failEnvironmentScopeRequired(scope);
    }
    return session;
  });

// A browser's traces go to the Installation's collector, which only its Owner reads.
const OTLP_TRACES_MAX_BYTES = 4 * 1024 * 1024;

export const layerServerEnvironmentHttpApi = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "metadata",
  Effect.fnUntraced(function* (handlers) {
    const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
    return handlers.handle(
      "descriptor",
      Effect.fn("environment.metadata.descriptor")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        return yield* serverEnvironment.getDescriptor;
      }),
    );
  }),
);

class DecodeOtlpTraceRecordsError extends Data.TaggedError("DecodeOtlpTraceRecordsError")<{
  readonly cause: unknown;
}> {}

// Tracing once-per-second renderer exports would create more spans than it forwards.
export const layerOtlpTracesProxyRoute = HttpRouter.add(
  "POST",
  OTLP_TRACES_PROXY_PATH,
  Effect.gen(function* () {
    const session = yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    // The rule of reading those traces back (`server.getTraceDiagnostics`, the Installation's):
    // the Owner's own session, judged by who it is, not only by its scopes. Anyone else's traces
    // are dropped quietly, so their exporters do not retry, and so is anything too large.
    const ownersClient =
      session.scopes.includes(AuthDiagnosticsReadScope) &&
      (yield* (yield* SpaceVisibility.SpaceVisibility).ofSession(session)).all;
    // A declared length over the cap is dropped before reading; chunked bodies hit the reader cap.
    const length = Number(request.headers["content-length"] ?? 0);
    if (!ownersClient || length > OTLP_TRACES_MAX_BYTES) {
      return HttpServerResponse.empty({ status: 204 });
    }
    const config = yield* ServerConfig.ServerConfig;
    const otlpTracesUrl = config.otlpTracesUrl;
    const otlpHeaders = config.otlpTracesExport.headers;
    const browserTraceCollector = yield* BrowserTraceCollector.BrowserTraceCollector;
    const httpClient = yield* HttpClient.HttpClient;
    const serialization = yield* OtlpSerialization.OtlpSerialization;
    const body = yield* request.json.pipe(
      Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(OTLP_TRACES_MAX_BYTES)),
      Effect.option,
    );
    if (Option.isNone(body)) return HttpServerResponse.empty({ status: 204 });
    const bodyJson = cast<unknown, OtlpTracer.TraceData>(body.value);

    yield* Effect.try({
      try: () => decodeOtlpTraceRecords(bodyJson),
      catch: (cause) => new DecodeOtlpTraceRecordsError({ cause }),
    }).pipe(
      Effect.flatMap((records) => browserTraceCollector.record(records)),
      Effect.catch((cause) => Effect.logWarning("Failed to decode browser OTLP traces", { cause })),
    );

    if (otlpTracesUrl === undefined) {
      return HttpServerResponse.empty({ status: 204 });
    }

    return yield* httpClient
      .post(otlpTracesUrl, {
        body: serialization.traces(bodyJson),
        headers: otlpHeaders,
      })
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.as(HttpServerResponse.empty({ status: 204 })),
        Effect.tapError((cause) =>
          Effect.logWarning("Failed to export browser OTLP traces", {
            cause,
            otlpTracesUrl,
          }),
        ),
        Effect.orElseSucceed(() =>
          HttpServerResponse.text("Trace export failed.", { status: 502 }),
        ),
      );
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
    Effect.withTracerEnabled(false),
  ),
);

const UNTRACED_REQUEST_PATHS: ReadonlySet<string> = new Set([OTLP_TRACES_PROXY_PATH]);

// HttpRouter.serve builds routes privately; provide the server-wide TracerDisabledWhen to the served layer.
const layerUntracedRequests = Layer.succeed(HttpMiddleware.TracerDisabledWhen)((request) => {
  const queryIndex = request.url.indexOf("?");
  const path = queryIndex === -1 ? request.url : request.url.slice(0, queryIndex);
  // Signed URLs carry bearer tokens in the path, so they never reach a trace.
  return (
    UNTRACED_REQUEST_PATHS.has(path) ||
    path.startsWith(`${WEBHOOK_ROUTE_PREFIX}/`) ||
    path.startsWith(`${ASSET_ROUTE_PREFIX}/`) ||
    path.startsWith(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/`) ||
    // The AI gateway traces its own requests (AiGateway.request): a client could put a key in
    // the address, which this span would keep.
    path.startsWith(`${AI_GATEWAY_ROUTE_PREFIX}/`)
  );
});

export const withUntracedRequests = Layer.provide(layerUntracedRequests);

export const layerAssetRoute = HttpRouter.add(
  "GET",
  `${ASSET_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = requestUrl(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const suffix = url.value.pathname.slice(`${ASSET_ROUTE_PREFIX}/`.length);
    const separatorIndex = suffix.indexOf("/");
    if (separatorIndex <= 0) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    const asset = yield* resolveAsset(
      suffix.slice(0, separatorIndex),
      suffix.slice(separatorIndex + 1),
    );
    if (!asset) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    if (asset.kind === "bytes") {
      return HttpServerResponse.uint8Array(asset.bytes, {
        contentType: asset.mimeType,
        headers: { "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff" },
      });
    }
    if (asset.kind === "source-control-media") {
      return yield* sourceControlMediaResponse(asset, request.headers).pipe(
        Effect.tapError((cause) =>
          // The URL can carry a token in its query string, and the error keeps the request it
          // failed on; the host and the failure kind are enough to diagnose.
          Effect.logWarning("Failed to fetch source control media.", {
            host: URL.canParse(asset.url) ? new URL(asset.url).host : undefined,
            reason: cause.reason._tag,
          }),
        ),
        Effect.orElseSucceed(() =>
          HttpServerResponse.empty({
            status: 502,
            headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
          }),
        ),
      );
    }
    const sessionUser = EnvironmentAuth.EnvironmentAuth.pipe(
      Effect.flatMap((auth) => auth.authenticateHttpRequest(request)),
      Effect.map((found) => Option.fromNullishOr(found.userId)),
      Effect.orElseSucceed(() => Option.none<UserId>()),
    );
    // Ticket 15: a file of a Thread on another machine, read from that machine now.
    if (asset.kind === "machine-file") {
      const threadWorkspace = yield* Effect.serviceOption(ThreadWorkspace.ThreadWorkspace);
      if (Option.isNone(threadWorkspace)) {
        return HttpServerResponse.text("Not Found", { status: 404 });
      }
      const route = yield* threadWorkspace.value.machineAsset(asset.threadId, {
        userId: asset.viewer === undefined ? undefined : UserId.make(asset.viewer),
      });
      return yield* machineAssetResponse({
        asset,
        route,
        session: yield* sessionUser,
        rangeHeader: request.headers.range,
        ifRangeHeader: request.headers["if-range"],
        method: request.method === "HEAD" ? "HEAD" : "GET",
      }).pipe(
        Effect.orElseSucceed(() =>
          HttpServerResponse.text("Internal Server Error", { status: 500 }),
        ),
      );
    }
    // Spec 5 ticket 05: a checkout's text file, masked for the User who asks (the session's;
    // the URL's own User for an embed without one). A URL with neither serves no text.
    if (asset.kind === "file" && "checkout" in asset && asset.checkout === true) {
      const session = yield* sessionUser;
      const tokenViewer =
        "viewer" in asset && typeof asset.viewer === "string"
          ? Option.some(UserId.make(asset.viewer))
          : Option.none<UserId>();
      const masked = yield* maskedAssetText(
        asset.path,
        Option.orElse(session, () => tokenViewer),
        request.method === "GET" ? request.headers.range : undefined,
        "download" in asset && asset.download === true ? asset.fileName : undefined,
      );
      if (masked !== undefined) return masked;
    }
    return yield* assetFileResponse(
      asset,
      request.method === "GET" ? request.headers.range : undefined,
      request.headers["if-range"],
      request.method === "HEAD" ? "HEAD" : "GET",
    ).pipe(
      Effect.orElseSucceed(() => HttpServerResponse.text("Internal Server Error", { status: 500 })),
    );
  }),
);

export const layerAttachmentUploadRoute = HttpRouter.add(
  "POST",
  `${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = requestUrl(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const token = url.value.pathname.slice(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/`.length);
    if (!token) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    const claims = yield* validateAttachmentUploadToken(token);
    if (!claims) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    const contentLengthHeader = request.headers["content-length"];
    if (
      contentLengthHeader !== undefined &&
      (!Number.isInteger(Number(contentLengthHeader)) ||
        Number(contentLengthHeader) !== claims.sizeBytes)
    ) {
      return HttpServerResponse.text("Content-Length must match the upload size.", {
        status: 400,
      });
    }

    // Keep the request stream in the route scope until the response is sent.
    const bodyPull = yield* Stream.toPull(request.stream);
    const stored = yield* storeAttachmentUpload(claims, Stream.fromPull(Effect.succeed(bodyPull)));
    return stored.ok
      ? HttpServerResponse.empty({ status: 204 })
      : HttpServerResponse.text(stored.detail, { status: stored.status });
  }),
);

const decodeBuildManifest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        file: Schema.String,
        css: Schema.optional(Schema.Array(Schema.String)),
        assets: Schema.optional(Schema.Array(Schema.String)),
      }),
    ),
  ),
);

const loadImmutableBuildAssets = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const staticDir =
    config.staticDir ?? (config.devUrl ? yield* ServerConfig.resolveStaticDir() : undefined);
  if (!staticDir) return new Set<string>();
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fileSystem.readFileString(path.join(staticDir, ".vite", "manifest.json")).pipe(
    Effect.flatMap(decodeBuildManifest),
    Effect.map(
      (manifest) =>
        new Set(
          Object.values(manifest).flatMap((entry) => [
            entry.file,
            ...(entry.css ?? []),
            ...(entry.assets ?? []),
          ]),
        ),
    ),
    Effect.orElseSucceed(() => new Set<string>()),
  );
});

const openStaticFile = Effect.fn("openStaticFile")(function* (filePath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const pathInfo = yield* fileSystem.stat(filePath).pipe(Effect.orElseSucceed(() => null));
  if (pathInfo?.type !== "File") return null;
  const file = yield* fileSystem.open(filePath, { flag: "r" }).pipe(
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(error),
    }),
  );
  // Electron asar can stat and read files even when opening a handle returns NotFound.
  // Refresh path metadata because the file may have been replaced since the first stat.
  const info = yield* file === null ? fileSystem.stat(filePath) : file.stat;
  return info.type === "File" ? { file, info } : null;
});

const streamStaticFile = (file: FileSystem.File, size: bigint) =>
  Stream.unfold(
    0n,
    Effect.fnUntraced(function* (offset: bigint) {
      if (offset >= size) return;
      const remaining = size - offset;
      const bytes = yield* file.readAlloc(Number(remaining < 65_536n ? remaining : 65_536n));
      if (Option.isNone(bytes)) return;
      return [bytes.value, offset + BigInt(bytes.value.byteLength)] as const;
    }),
  );

const CONSENT_PAGE_PATHS: ReadonlySet<string> = new Set([
  "/app-sign-in",
  "/connect-agent",
  "/register-environment",
]);

const handleStaticAndDevRequest = Effect.fn("handleStaticAndDevRequest")(
  function* (immutableBuildAssets: ReadonlySet<string>) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = requestUrl(request);

    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const config = yield* ServerConfig.ServerConfig;
    if (config.devUrl && isDevProxiedPath(url.value.pathname)) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    if (config.devUrl && isLoopbackHostname(url.value.hostname)) {
      return HttpServerResponse.redirect(resolveDevRedirectUrl(config.devUrl, url.value), {
        status: 302,
      });
    }

    const staticDir =
      config.staticDir ?? (config.devUrl ? yield* ServerConfig.resolveStaticDir() : undefined);
    if (!staticDir && config.devUrl) {
      // `vp run dev --share --built` prints the pairing URL before its first
      // web build lands in apps/web/dist. Reload until it does.
      return HttpServerResponse.text(
        '<!doctype html><meta http-equiv="refresh" content="2"><p>Waiting for the first web build. This page reloads by itself.</p>',
        { status: 503, contentType: "text/html", headers: { "Retry-After": "2" } },
      );
    }
    if (!staticDir) {
      return HttpServerResponse.text("No static directory configured and no dev URL set.", {
        status: 503,
      });
    }

    const path = yield* Path.Path;
    const staticRoot = path.resolve(staticDir);
    const staticRequestPath = url.value.pathname === "/" ? "/index.html" : url.value.pathname;
    const rawStaticRelativePath = staticRequestPath.replace(/^[/\\]+/, "");
    const hasRawLeadingParentSegment = rawStaticRelativePath.startsWith("..");
    const staticRelativePath = path.normalize(rawStaticRelativePath).replace(/^[/\\]+/, "");
    const hasPathTraversalSegment = staticRelativePath.startsWith("..");
    if (
      staticRelativePath.length === 0 ||
      hasRawLeadingParentSegment ||
      hasPathTraversalSegment ||
      staticRelativePath.includes("\0")
    ) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const isWithinStaticRoot = (candidate: string) =>
      candidate === staticRoot ||
      candidate.startsWith(staticRoot.endsWith(path.sep) ? staticRoot : `${staticRoot}${path.sep}`);

    let filePath = path.resolve(staticRoot, staticRelativePath);
    if (!isWithinStaticRoot(filePath)) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const ext = path.extname(filePath);
    if (!ext) {
      filePath = path.resolve(filePath, "index.html");
      if (!isWithinStaticRoot(filePath)) {
        return HttpServerResponse.text("Invalid static file path", { status: 400 });
      }
    }

    let opened = yield* openStaticFile(filePath);
    if (!opened) {
      filePath = path.resolve(staticRoot, "index.html");
      opened = yield* openStaticFile(filePath);
      if (!opened) {
        return HttpServerResponse.text("Not Found", { status: 404 });
      }
    }
    const fileInfo = opened.info;
    const mimeType = Option.getOrElse(Mime.getType(filePath), () => "application/octet-stream");
    const isHtml = mimeType === "text/html";

    // A hash-like name is not enough: custom static files can use the same naming pattern.
    const relativePath = path.relative(staticRoot, filePath).replaceAll("\\", "/");
    const immutable =
      !isHtml &&
      /^assets\/.+-[\w-]{8}\.[^/]+$/.test(relativePath) &&
      immutableBuildAssets.has(relativePath);
    const cacheControl = immutable ? "public, max-age=31536000, immutable" : "no-cache";
    const validators = (info: FileSystem.File.Info) => {
      // Deployments can preserve HTML size and mtime while changing its bundle URLs.
      const modifiedAt = isHtml ? undefined : Option.getOrUndefined(info.mtime);
      return modifiedAt
        ? {
            ETag: `W/"${info.size.toString(16)}-${modifiedAt.getTime().toString(16)}"`,
            "Last-Modified": modifiedAt.toUTCString(),
          }
        : {};
    };
    const headers: Record<string, string> = {
      "Cache-Control": cacheControl,
      ...validators(fileInfo),
    };
    const etag = headers.ETag;
    const lastModified = headers["Last-Modified"];

    // If-None-Match precedes dates and uses weak GET/HEAD comparison even across compression.
    const ifNoneMatch = request.headers["if-none-match"];
    const ifModifiedSince = request.headers["if-modified-since"];
    const unchanged =
      ifNoneMatch !== undefined
        ? ifNoneMatch.split(",").some((value) => {
            const candidate = value.trim();
            return (
              candidate === "*" ||
              (etag !== undefined && candidate.replace(/^W\//i, "") === etag.slice(2))
            );
          })
        : ifModifiedSince !== undefined &&
          lastModified !== undefined &&
          Date.parse(lastModified) <= Date.parse(ifModifiedSince);
    if (!isHtml && unchanged) {
      return HttpServerResponse.empty({
        status: 304,
        headers: { ...headers, Vary: "Accept-Encoding" },
      });
    }

    const contentType = isHtml ? "text/html; charset=utf-8" : mimeType;
    // Pages that approve access must not be framed by another site (clickjacking the consent).
    // With previews on their own origin no page is framed by another: a preview subdomain is
    // same-site, so a frame there would carry the Hub's SameSite=Lax session.
    const frameHeaders: Record<string, string> =
      isHtml && CONSENT_PAGE_PATHS.has(url.value.pathname.replace(/\/+$/u, ""))
        ? { "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'" }
        : isHtml && config.previewOrigin !== undefined
          ? { "X-Frame-Options": "SAMEORIGIN", "Content-Security-Policy": "frame-ancestors 'self'" }
          : {};
    Object.assign(headers, frameHeaders);
    if (opened.file === null && request.method !== "HEAD") {
      const fileSystem = yield* FileSystem.FileSystem;
      // Complete fallback reads before success headers; stream errors arrive too late for a 500.
      const bytes = yield* fileSystem.readFile(filePath);
      const info = yield* fileSystem.stat(filePath);
      return HttpServerResponse.uint8Array(bytes, {
        headers: {
          "Cache-Control": cacheControl,
          ...validators({ ...info, size: ByteSize.bytes(bytes.byteLength) }),
          ...frameHeaders,
        },
        contentType,
      });
    }
    // The request scope closes the handle for GET, HEAD, 304, errors, and cancellation.
    // HEAD still passes through compression, which selects headers without reading the stream.
    return HttpServerResponse.stream(
      opened.file === null ? Stream.empty : streamStaticFile(opened.file, fileInfo.size),
      {
        headers,
        contentType,
        contentLength: Number(fileInfo.size),
      },
    );
  },
  Effect.catchTags({
    PlatformError: () =>
      Effect.succeed(HttpServerResponse.text("Internal Server Error", { status: 500 })),
  }),
);

/**
 * The issuer's documents (Vaults ticket 07). Until workload identity is in use they answer what
 * the static handler answers any other path: the same handler, so the same response.
 */
const identityOrStatic = Effect.fn("identityOrStatic")(function* (
  immutableBuildAssets: ReadonlySet<string>,
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = requestUrl(request);
  const identity = Option.isNone(url) ? Option.none() : yield* identityResponse(url.value);
  return Option.isSome(identity)
    ? identity.value
    : yield* handleStaticAndDevRequest(immutableBuildAssets);
});

export const layerIdentityRoutes = Layer.unwrap(
  loadImmutableBuildAssets.pipe(
    Effect.map((assets) =>
      Layer.mergeAll(
        HttpRouter.add("GET", IDENTITY_DISCOVERY_PATH, identityOrStatic(assets)),
        HttpRouter.add("GET", IDENTITY_JWKS_PATH, identityOrStatic(assets)),
      ),
    ),
  ),
);

export const layerStaticAndDevRoute = Layer.unwrap(
  loadImmutableBuildAssets.pipe(
    Effect.map((assets) => HttpRouter.add("GET", "*", handleStaticAndDevRequest(assets))),
  ),
);
