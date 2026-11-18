/**
 * `/api/git/<projectId>` and `/api/git/thread/<threadId>`: the Hub repository over git smart HTTP
 * (`git http-backend`), and large uploads in parts under `packs/` (`HubPackUploads`). A machine
 * writes the refs of Threads it runs and reads the Hub's checkout copy (`refs/t3/project/`), in
 * Projects where its owner may start Threads (a Sandbox: its own Space); nobody deletes.
 */
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Config from "effect/Config";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Pull from "effect/Pull";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as RemoteEnvironments from "../environment/RemoteEnvironments.ts";
import * as HubPackUploads from "../checkpointing/HubPackUploads.ts";
import * as HubRepository from "../checkpointing/HubRepository.ts";
import { checkpointRefForScopeOrdinal } from "../orchestration-v2/CheckpointService.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { requestUrl } from "../requestUrl.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as SpaceVisibility from "../spaces/SpaceVisibility.ts";
import * as EnvironmentRegistry from "./EnvironmentRegistry.ts";
import { bearerOf, isSecureEnvironmentTransport } from "./http.ts";

const SERVICES = new Set(["git-upload-pack", "git-receive-pack"]);
/** A request or response that takes longer is cut off: git sees a failed transfer and retries. */
const REQUEST_TIMEOUT = "10 minutes";
const MAX_HEADER_BYTES = 64 * 1024;

class HubRepositoryHttpError extends Schema.TaggedError<HubRepositoryHttpError>()(
  "HubRepositoryHttpError",
  { detail: Schema.String },
) {}

/** The Environment credential: the password of Basic auth, as git's helper sends it, or a Bearer. */
const credentialOf = (authorization: string | undefined) => {
  const bearer = bearerOf(authorization);
  if (bearer !== undefined) return bearer;
  const basic = /^basic\s+(\S+)\s*$/iu.exec(authorization ?? "")?.[1];
  if (basic === undefined) return undefined;
  const decoded = Buffer.from(basic, "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  return separator === -1 ? undefined : decoded.slice(separator + 1);
};

const unauthorized = () =>
  HttpServerResponse.text("Unauthorized", {
    status: 401,
    headers: { "www-authenticate": 'Basic realm="T3 Code Hub", charset="UTF-8"' },
  });

/** A CGI response head: its status and headers. */
const parseCgiHead = (head: Buffer) => {
  let status = 200;
  const headers: Record<string, string> = {};
  for (const line of head.toString("latin1").split(/\r?\n/u)) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (name === "status") status = Number.parseInt(value, 10) || 500;
    else headers[name] = value;
  }
  return { status, headers };
};

const headEnd = (bytes: Buffer) => {
  const crlf = bytes.indexOf("\r\n\r\n");
  if (crlf !== -1) return { end: crlf, gap: 4 };
  const lf = bytes.indexOf("\n\n");
  return lf === -1 ? undefined : { end: lf, gap: 2 };
};

/** Git config for one request, by environment: nothing from the system or the user's own. */
const isolatedEnvironment = (
  nullDevice: string,
  entries: ReadonlyArray<readonly [string, string]>,
) => {
  const env: Record<string, string> = {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: nullDevice,
    GIT_CONFIG_COUNT: String(entries.length),
  };
  for (const key of ["PATH", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR", "LANG"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  entries.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
};

const ZERO_OID = /^0+$/u;

interface RefUpdate {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

/**
 * The ref updates at the start of a receive-pack request, in pkt-lines up to the flush packet:
 * `<old> <new> <ref>`, the first one followed by NUL and capabilities. `shallow` lines may come
 * before them; anything else (a signed push's certificate) is not accepted.
 */
const parseReceiveCommands = (
  bytes: Buffer,
):
  | { readonly _tag: "incomplete" }
  | { readonly _tag: "invalid" }
  | { readonly _tag: "parsed"; readonly updates: ReadonlyArray<RefUpdate> } => {
  const updates: Array<RefUpdate> = [];
  let offset = 0;
  while (true) {
    if (bytes.length < offset + 4) {
      return bytes.length > MAX_HEADER_BYTES ? { _tag: "invalid" } : { _tag: "incomplete" };
    }
    const length = Number.parseInt(bytes.subarray(offset, offset + 4).toString("latin1"), 16);
    if (!Number.isInteger(length) || (length !== 0 && length < 4)) return { _tag: "invalid" };
    if (length === 0) return { _tag: "parsed", updates };
    if (bytes.length < offset + length) {
      return bytes.length > MAX_HEADER_BYTES ? { _tag: "invalid" } : { _tag: "incomplete" };
    }
    const line = bytes
      .subarray(offset + 4, offset + length)
      .toString("utf8")
      .split("\0")[0]!
      .replace(/\n$/u, "");
    offset += length;
    if (line.startsWith("shallow ")) continue;
    const [oldOid, newOid, ref, ...extra] = line.split(" ");
    if (oldOid === undefined || newOid === undefined || ref === undefined || extra.length > 0) {
      return { _tag: "invalid" };
    }
    updates.push({ oldOid, newOid, ref });
  }
};

/** Every Thread's recovered and set-aside refs: created once, never updated or deleted. */
const RECOVERED_ROOT = "refs/t3/recovered/";
/** At most this much in a push a machine makes only with the Hub's grant (recovered changes). */
const GRANTED_PUSH_MAX_BYTES = 256 * 1024 * 1024;

/**
 * Why the machine may not make these updates (undefined when it may), and the grants they use.
 * Nobody deletes a ref; a recovered ref is only ever created, by whoever may write there. A
 * machine a Thread moved away from writes only the exact refs the Hub granted it.
 */
const checkUpdates = (
  updates: ReadonlyArray<RefUpdate>,
  rules: { readonly writable: ReadonlyArray<string>; readonly granted: ReadonlyArray<string> },
): { readonly refusal: string | undefined; readonly usedGrants: ReadonlyArray<string> } => {
  const usedGrants: Array<string> = [];
  const refuse = (refusal: string) => ({ refusal, usedGrants });
  for (const update of updates) {
    if (ZERO_OID.test(update.newOid)) return refuse(`Deleting ${update.ref} is not allowed.`);
    const writable = rules.writable.some((prefix) => update.ref.startsWith(prefix));
    if (update.ref.startsWith(RECOVERED_ROOT)) {
      if (!ZERO_OID.test(update.oldOid)) {
        return refuse(`${update.ref} already exists: recovered changes are never overwritten.`);
      }
      if (writable) continue;
      if (rules.granted.includes(update.ref)) {
        usedGrants.push(update.ref);
        continue;
      }
    } else if (writable) {
      continue;
    }
    return refuse(`${update.ref} is not a ref of a Thread this machine runs.`);
  }
  return { refusal: undefined, usedGrants };
};

// One span per request is enough; git's own work happens in the subprocess.
const makeHandler = Effect.fnUntraced(function* (deps: {
  readonly repositories: HubRepository.HubRepositories["Service"];
  readonly packUploads: Option.Option<HubPackUploads.HubPackUploads["Service"]>;
  readonly registry: EnvironmentRegistry.EnvironmentRegistry["Service"];
  readonly spaces: SpaceDirectory.SpaceDirectory["Service"];
  readonly visibility: SpaceVisibility.SpaceVisibility["Service"];
  readonly projects: ProjectStore.ProjectStoreV2["Service"];
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly sql: SqlClient.SqlClient;
  readonly digest: Digest.Digest["Service"];
  readonly maxRequestBytes: number;
  readonly nullDevice: string;
  readonly remote: Option.Option<RemoteEnvironments.RemoteEnvironments["Service"]>;
}) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = requestUrl(request);
  if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });
  const serviceOf = (endpoint: string) => {
    const service =
      endpoint === "info/refs" && request.method === "GET"
        ? url.value.searchParams.get("service")
        : request.method === "POST"
          ? endpoint
          : null;
    return service !== null && SERVICES.has(service) ? service : null;
  };
  // `packs/<uploadId>` (GET: its status; POST: a part) and `packs/<uploadId>/apply` (POST).
  const packOf = (endpoint: string) => {
    if (Option.isNone(deps.packUploads)) return null;
    const [segment, uploadId, action, ...extra] = endpoint.split("/");
    if (segment !== HubPackUploads.PACK_UPLOADS_SEGMENT || extra.length > 0) return null;
    if (uploadId === undefined || !HubPackUploads.PACK_UPLOAD_ID.test(uploadId)) return null;
    if (action === undefined) {
      return request.method === "GET"
        ? { uploadId, action: "status" as const }
        : request.method === "POST"
          ? { uploadId, action: "append" as const }
          : null;
    }
    return action === "apply" && request.method === "POST"
      ? { uploadId, action: "apply" as const }
      : null;
  };
  const isEndpoint = (endpoint: string) =>
    serviceOf(endpoint) !== null || packOf(endpoint) !== null;
  // `<projectId>/<endpoint>`, or `thread/<threadId>/<endpoint>` for a Thread's own repository.
  const segments = url.value.pathname
    .slice(HubRepository.HUB_REPOSITORY_ROUTE_PREFIX.length + 1)
    .split("/");
  const asThread =
    segments[0] === HubRepository.THREAD_REPOSITORY_SEGMENT &&
    segments.length >= 3 &&
    isEndpoint(segments.slice(2).join("/"));
  const [encodedId, ...rest] = asThread ? segments.slice(1) : segments;
  const endpoint = rest.join("/");
  const service = serviceOf(endpoint);
  const pack = packOf(endpoint);
  if (encodedId === undefined || encodedId.length === 0 || (service === null && pack === null)) {
    return HttpServerResponse.text("Not Found", { status: 404 });
  }
  if (!isSecureEnvironmentTransport(request)) {
    return HttpServerResponse.text("The Hub repository is served over HTTPS only.", {
      status: 403,
    });
  }
  const check = yield* deps.registry.checkCredential(credentialOf(request.headers.authorization));
  if (check._tag === "refused") return unauthorized();

  const contentLength = request.headers["content-length"];
  if (contentLength !== undefined && Number(contentLength) > deps.maxRequestBytes) {
    return HttpServerResponse.text("Payload Too Large", { status: 413 });
  }
  const decodedId = yield* Effect.try({
    try: () => decodeURIComponent(encodedId),
    catch: () => new HubRepositoryHttpError({ detail: "The repository name is not valid." }),
  }).pipe(Effect.option);
  if (Option.isNone(decodedId)) return HttpServerResponse.text("Not Found", { status: 404 });
  // A Thread's own repository is that of a Thread without a Project; a Project's is any other's.
  const { threads } = deps.repositories;
  const resolved = yield* Effect.result(
    asThread
      ? threads.repositoryOfThread(ThreadId.make(decodedId.value)).pipe(
          Effect.map((found) =>
            Option.filter(
              Option.map(found, (entry) => entry.key),
              (entry) => entry.scratchThreadId !== undefined,
            ),
          ),
        )
      : // The scratch Project's Threads each have their own repository, never a shared one.
        threads.isScratchProject(ProjectId.make(decodedId.value)).pipe(
          Effect.map((scratch) =>
            scratch
              ? Option.none<HubRepository.HubRepositoryKey>()
              : Option.some<HubRepository.HubRepositoryKey>({
                  projectId: ProjectId.make(decodedId.value),
                }),
          ),
        ),
  );
  // Which repository it is could not be read: the machine tries again, nothing goes elsewhere.
  if (resolved._tag === "Failure") {
    return HttpServerResponse.text("Service Unavailable", { status: 503 });
  }
  const key = resolved.success;
  if (Option.isNone(key)) return HttpServerResponse.text("Not Found", { status: 404 });
  const { projectId } = key.value;
  // Read before any check: a move of the Project that starts after it ends this request.
  const moveEpoch = yield* deps.spaces.projectMoveEpoch(projectId);
  const project = yield* deps.projects.get(projectId).pipe(Effect.orElseSucceed(Option.none));
  if (Option.isNone(project)) return HttpServerResponse.text("Not Found", { status: 404 });
  // A machine works for its owner only, in Spaces where they may start Threads; a Sandbox only in
  // its own Space, the repository's (a Thread's own repository is in the Thread's Space).
  const ownerUserId = check.ownerUserId;
  const allowed =
    ownerUserId === null
      ? yield* deps.spaces
          .spaceOf(
            key.value.scratchThreadId === undefined
              ? { kind: "project", id: projectId }
              : { kind: "thread", id: key.value.scratchThreadId },
          )
          .pipe(
            Effect.map((space) => Option.isSome(space) && space.value.id === check.spaceId),
            Effect.orElseSucceed(() => false),
          )
      : yield* deps.spaces
          .claimCreation({ action: "thread.create", actorUserId: ownerUserId, projectId })
          .pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
  if (!allowed) return HttpServerResponse.text("Forbidden", { status: 403 });

  const prefixes = yield* refPrefixesFor(deps, key.value, check.environmentId);
  // What the Hub asked this machine to hand over in this repository (changes it kept).
  const granted = Option.isNone(deps.remote)
    ? []
    : (yield* deps.remote.value.recoveryGrants(check.environmentId))
        .filter(
          (grant) =>
            grant.key.projectId === key.value.projectId &&
            grant.key.scratchThreadId === key.value.scratchThreadId,
        )
        .map((grant) => grant.ref);
  // A Thread's own repository is only for the machine that runs it (or the target of its move),
  // and a machine it left that the Hub asked for its changes.
  if (
    key.value.scratchThreadId !== undefined &&
    prefixes.readable.length === 0 &&
    granted.length === 0
  ) {
    return HttpServerResponse.text("Forbidden", { status: 403 });
  }
  yield* deps.repositories.ensure(key.value);
  if (pack !== null && Option.isSome(deps.packUploads)) {
    return yield* handlePack({
      uploads: deps.packUploads.value,
      spaces: deps.spaces,
      remote: deps.remote,
      maxRequestBytes: deps.maxRequestBytes,
      owner: check.environmentId,
      key: key.value,
      moveEpoch,
      writable: prefixes.writable,
      granted,
      pack,
    });
  }
  // A new checkout's fetch (only that: routine fetches never wait on it) first has the Hub copy
  // its own checkout of the Project, from the top of a repository today's rule trusts; from any
  // other, nothing. Every machine the Hub sends `fromHub` to sends the header (contract 9).
  if (
    key.value.scratchThreadId === undefined &&
    service === "git-upload-pack" &&
    request.method === "GET" &&
    request.headers[HubRepository.CHECKOUT_HEADER.toLowerCase()] !== undefined
  ) {
    const repository = yield* deps.visibility.trustedProjectRepository(projectId);
    if (Option.isSome(repository)) {
      yield* deps.repositories.mirrorCheckout(projectId, repository.value.top);
    }
  }
  const contentType = request.headers["content-type"];
  const contentEncoding = request.headers["content-encoding"];
  const env = {
    ...isolatedEnvironment(deps.nullDevice, [
      ["http.receivepack", "true"],
      ["core.hooksPath", deps.nullDevice],
      ["receive.denyDeletes", "true"],
      ["receive.denyDeleteCurrent", "true"],
      ["uploadpack.allowAnySHA1InWant", "false"],
      // Every ref is hidden from the machine, read and write, but those of Threads it runs.
      ["transfer.hideRefs", "refs/"],
      ["transfer.hideRefs", "HEAD"],
      ...prefixes.readable.map((prefix) => ["transfer.hideRefs", `!${prefix}`] as const),
      // A machine a Thread left creates only the refs it was granted, which do not exist yet:
      // nothing is advertised to it.
      ...granted.map((ref) => ["receive.hideRefs", `!${ref}`] as const),
    ]),
    GIT_PROJECT_ROOT: deps.repositories.root,
    GIT_HTTP_EXPORT_ALL: "1",
    PATH_INFO: `/${deps.repositories.directoryOf(key.value)}/${endpoint}`,
    REQUEST_METHOD: request.method,
    QUERY_STRING: url.value.search.slice(1),
    REMOTE_USER: check.environmentId,
    REMOTE_ADDR: "127.0.0.1",
    ...(contentType === undefined ? {} : { CONTENT_TYPE: contentType }),
    ...(contentEncoding === undefined ? {} : { HTTP_CONTENT_ENCODING: contentEncoding }),
    ...(contentLength === undefined ? {} : { CONTENT_LENGTH: contentLength }),
    // No GIT_PROTOCOL: version 2 serves any object a machine names by id, hidden refs or not,
    // so every machine speaks version 0, where only advertised tips are wanted.
  };

  // The child lives until the response body is sent, or the request fails before it starts.
  const scope = yield* Scope.make();
  // While the Project moves to another Space the machine is checked anew, once it settles; a
  // move that starts mid-request ends it (fetch, push, checkout copy alike), since what was
  // allowed may not be in the new Space.
  const held = yield* deps.spaces
    .holdProjectAccess(projectId, moveEpoch)
    .pipe(Effect.provideService(Scope.Scope, scope));
  if (Option.isNone(held)) {
    yield* Scope.close(scope, Exit.void);
    return HttpServerResponse.text("The Project is moving to another Space. Try again.", {
      status: 503,
    });
  }
  const projectMoved = held.value.pipe(
    Effect.andThen(
      Effect.fail(new HubRepositoryHttpError({ detail: "The Project moved to another Space." })),
    ),
  );
  return yield* Effect.gen(function* () {
    let received = 0;
    let limit = deps.maxRequestBytes;
    const counted = request.stream.pipe(
      Stream.mapEffect((chunk) => {
        received += chunk.length;
        return received > limit
          ? Effect.fail(new HubRepositoryHttpError({ detail: "The request is too large." }))
          : Effect.succeed(chunk);
      }),
    );
    let body: typeof counted = request.method === "POST" ? counted : Stream.empty;
    if (request.method === "POST" && service === "git-receive-pack") {
      // The ref updates come first, before the pack: each is checked before git sees any.
      if (contentEncoding !== undefined) {
        return HttpServerResponse.text("Unsupported Media Type", { status: 415 });
      }
      const pull = yield* Stream.toPull(counted);
      let buffered = Buffer.alloc(0);
      let commands = parseReceiveCommands(buffered);
      while (commands._tag === "incomplete") {
        const chunk = yield* pull.pipe(Pull.catchDone(() => Effect.succeed(undefined)));
        if (chunk === undefined) break;
        buffered = Buffer.concat([buffered, ...chunk]);
        commands = parseReceiveCommands(buffered);
      }
      const checked =
        commands._tag === "parsed"
          ? checkUpdates(commands.updates, { writable: prefixes.writable, granted })
          : { refusal: "The push could not be read.", usedGrants: [] };
      if (checked.refusal !== undefined) {
        return HttpServerResponse.text(checked.refusal, { status: 403 });
      }
      if (checked.usedGrants.length > 0) {
        // One push per grant, and a bounded one.
        for (const ref of checked.usedGrants) {
          const taken = Option.isSome(deps.remote)
            ? yield* deps.remote.value.takeRecoveryGrant(check.environmentId, ref)
            : false;
          if (!taken) {
            return HttpServerResponse.text(`${ref} was not asked for.`, { status: 403 });
          }
        }
        if (commands._tag === "parsed" && checked.usedGrants.length === commands.updates.length) {
          limit = Math.min(limit, GRANTED_PUSH_MAX_BYTES);
          if (received > limit) {
            return HttpServerResponse.text("Payload Too Large", { status: 413 });
          }
        }
      }
      body = Stream.concat(
        Stream.make(new Uint8Array(buffered)),
        Stream.fromPull(Effect.succeed(pull)),
      );
    }
    const child = yield* deps.spawner.spawn(
      ChildProcess.make("git", ["http-backend"], {
        cwd: deps.repositories.root,
        env,
        extendEnv: false,
      }),
    );
    yield* Stream.run(body, child.stdin).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Hub repository request body failed", { cause }),
      ),
      Effect.forkIn(scope),
    );
    yield* Stream.runDrain(child.stderr).pipe(Effect.ignore, Effect.forkIn(scope));
    const pull = yield* Stream.toPull(child.stdout);
    let buffered = Buffer.alloc(0);
    let found = headEnd(buffered);
    while (found === undefined) {
      const chunk = yield* pull.pipe(Pull.catchDone(() => Effect.succeed(undefined)));
      if (chunk === undefined || buffered.length > MAX_HEADER_BYTES) {
        const exitCode = yield* child.exitCode.pipe(Effect.orElseSucceed(() => -1));
        return yield* new HubRepositoryHttpError({
          detail: `git http-backend ended without a response (exit ${exitCode}).`,
        });
      }
      buffered = Buffer.concat([buffered, ...chunk]);
      found = headEnd(buffered);
    }
    const head = parseCgiHead(buffered.subarray(0, found.end));
    const leftover = new Uint8Array(buffered.subarray(found.end + found.gap));
    // A git that fails after its head was sent breaks the body, so the client sees a failure.
    const exited = child.exitCode.pipe(
      Effect.filterOrFail(
        (code) => code === 0,
        (code) => new HubRepositoryHttpError({ detail: `git http-backend exited with ${code}.` }),
      ),
    );
    const responseBody = Stream.concat(
      Stream.concat(
        leftover.length === 0 ? Stream.empty : Stream.make(leftover),
        Stream.fromPull(Effect.succeed(pull)),
      ),
      Stream.fromEffect(exited).pipe(Stream.drain),
    ).pipe(
      Stream.timeoutOrElse({
        duration: REQUEST_TIMEOUT,
        orElse: () =>
          Stream.fail(new HubRepositoryHttpError({ detail: "The Hub repository timed out." })),
      }),
      // Broken, never cut short as if complete: the machine sees the request fail.
      Stream.interruptWhen(projectMoved),
      Stream.ensuring(Scope.close(scope, Exit.void)),
    );
    const { "content-type": responseType, ...headers } = head.headers;
    return HttpServerResponse.stream(responseBody, {
      status: head.status,
      headers,
      ...(responseType === undefined ? {} : { contentType: responseType }),
    });
  }).pipe(
    (respond) => Effect.raceFirst(respond, projectMoved),
    Effect.provideService(Scope.Scope, scope),
    Effect.onError(() => Scope.close(scope, Exit.void)),
    Effect.timeout(REQUEST_TIMEOUT),
  );
});

const ZERO_OBJECT_ID = "0".repeat(40);
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const decodeApply = Schema.decodeUnknownEffect(HubPackUploads.PackApplyRequest);

/**
 * A large upload in parts (`HubPackUploads`): its status, a part, or applying it. The machine was
 * checked as for a push; the refs it sets are checked as a push's (`checkUpdates`) before any of
 * the pack reaches the repository.
 */
const handlePack = Effect.fnUntraced(function* (input: {
  readonly uploads: HubPackUploads.HubPackUploads["Service"];
  readonly spaces: SpaceDirectory.SpaceDirectory["Service"];
  readonly remote: Option.Option<RemoteEnvironments.RemoteEnvironments["Service"]>;
  readonly maxRequestBytes: number;
  readonly owner: EnvironmentId;
  readonly key: HubRepository.HubRepositoryKey;
  readonly moveEpoch: number;
  readonly writable: ReadonlyArray<string>;
  readonly granted: ReadonlyArray<string>;
  readonly pack: { readonly uploadId: string; readonly action: "status" | "append" | "apply" };
}) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const { uploads, owner, key, pack } = input;
  const json = (body: HubPackUploads.PackUploadStatus, status = 200) =>
    HttpServerResponse.json(body, { status });
  if (pack.action === "status") {
    return yield* json(yield* uploads.status(owner, key, pack.uploadId));
  }
  if (pack.action === "append") {
    const url = requestUrl(request);
    const offset = Number(Option.getOrUndefined(url)?.searchParams.get("offset") ?? Number.NaN);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }
    const appended = yield* uploads.append(owner, key, pack.uploadId, {
      offset,
      body: request.stream.pipe(
        Stream.mapError((cause) => new HubPackUploads.PackBodyError({ cause })),
      ),
      maxBytes: input.maxRequestBytes,
    });
    if (appended._tag === "tooLarge") {
      return HttpServerResponse.text("Payload Too Large", { status: 413 });
    }
    return yield* json(
      { state: "receiving", size: appended.size },
      appended._tag === "offset" ? 409 : 200,
    );
  }
  const body = yield* request.json.pipe(Effect.flatMap(decodeApply), Effect.option);
  if (
    Option.isNone(body) ||
    body.value.updates.length === 0 ||
    !Number.isSafeInteger(body.value.size) ||
    body.value.updates.some(
      (update) => !update.ref.startsWith("refs/") || !OBJECT_ID.test(update.newOid),
    )
  ) {
    return HttpServerResponse.text("Bad Request", { status: 400 });
  }
  const updates = body.value.updates;
  const checked = checkUpdates(
    updates.map((update) => ({ oldOid: ZERO_OBJECT_ID, newOid: update.newOid, ref: update.ref })),
    { writable: input.writable, granted: input.granted },
  );
  if (checked.refusal !== undefined) {
    return yield* json({ state: "failed", size: 0, error: checked.refusal }, 403);
  }
  if (checked.usedGrants.length > 0) {
    for (const ref of checked.usedGrants) {
      const taken = Option.isSome(input.remote)
        ? yield* input.remote.value.takeRecoveryGrant(owner, ref)
        : false;
      if (!taken) {
        return yield* json({ state: "failed", size: 0, error: `${ref} was not asked for.` }, 403);
      }
    }
    if (checked.usedGrants.length === updates.length && body.value.size > GRANTED_PUSH_MAX_BYTES) {
      return HttpServerResponse.text("Payload Too Large", { status: 413 });
    }
  }
  // While the Project moves to another Space nothing is applied; a move that starts during the
  // apply ends it, as it ends a push.
  const scope = yield* Scope.make();
  const held = yield* input.spaces
    .holdProjectAccess(key.projectId, input.moveEpoch)
    .pipe(Effect.provideService(Scope.Scope, scope));
  if (Option.isNone(held)) {
    yield* Scope.close(scope, Exit.void);
    return HttpServerResponse.text("The Project is moving to another Space. Try again.", {
      status: 503,
    });
  }
  const status = yield* uploads.apply(owner, key, pack.uploadId, body.value, {
    lost: held.value.pipe(
      Effect.andThen(
        Effect.fail(
          new HubPackUploads.PackAccessLost({ detail: "The Project moved to another Space." }),
        ),
      ),
    ),
    release: Scope.close(scope, Exit.void),
  });
  return yield* json(status, status.state === "applying" ? 202 : 200);
});

/**
 * The ref namespaces the machine may see and write in the Project's repository: those of the
 * Threads it is the Active environment of. The target of a Thread's running move may also read
 * them, to fetch what the Thread continues from, but writes none until the Thread is its own. In a
 * Project's repository (not a Thread's own) it also reads the copy of the Hub's checkout.
 */
const refPrefixesFor = Effect.fn("HubRepositoryHttp.refPrefixesFor")(function* (
  deps: { readonly sql: SqlClient.SqlClient; readonly digest: Digest.Digest["Service"] },
  key: HubRepository.HubRepositoryKey,
  environmentId: EnvironmentId,
) {
  // A Thread's own repository holds that Thread's refs only.
  const repositoryThreads =
    key.scratchThreadId === undefined
      ? deps.sql`thread.project_id = ${key.projectId}`
      : deps.sql`thread.thread_id = ${key.scratchThreadId}`;
  const rows = yield* deps.sql<{
    readonly threadId: string;
    readonly scopeId: string | null;
    readonly active: number;
  }>`
    SELECT thread.thread_id AS "threadId", scope.scope_id AS "scopeId",
      thread.active_environment_id IS ${environmentId} AS active
    FROM orchestration_v2_projection_threads thread
    LEFT JOIN orchestration_v2_projection_checkpoint_scopes scope
      ON scope.thread_id = thread.thread_id
    WHERE ${repositoryThreads}
      AND (
        thread.active_environment_id = ${environmentId}
        OR (
          json_extract(thread.payload_json, '$.move.status') = 'running'
          AND json_extract(thread.payload_json, '$.move.targetEnvironmentId') = ${environmentId}
        )
      )
  `;
  const readable = new Set<string>();
  const writable = new Set<string>();
  for (const row of rows) {
    const prefixes: Array<string> = [...HubRepository.threadRefPrefixes(row.threadId)];
    if (row.scopeId !== null) {
      const ref = yield* checkpointRefForScopeOrdinal({
        scopeId: row.scopeId as never,
        ordinalWithinScope: 0,
      }).pipe(Effect.provideService(Digest.Digest, deps.digest));
      prefixes.push(ref.slice(0, ref.length - "ordinal/0".length));
    }
    for (const prefix of prefixes) {
      readable.add(prefix);
      if (row.active === 1) writable.add(prefix);
    }
    // The target of a move uploads what it sets aside of its own before the Thread is its own.
    writable.add(HubRepository.threadRefPrefixes(row.threadId)[1]);
  }
  // The copy of the Project's checkout is for every machine that may work in it (the caller
  // checked that) to read, its new checkouts made from it; only the Hub writes it. A Thread's own
  // repository has none.
  if (key.scratchThreadId === undefined) {
    readable.add(HubRepository.PROJECT_REFS_PREFIX);
  }
  return { readable: [...readable], writable: [...writable] };
});

/** Registered where the server keeps Hub repositories; joined machines serve none. */
export const layer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const repositories = yield* Effect.serviceOption(HubRepository.HubRepositories);
    if (Option.isNone(repositories)) return;
    const handler = makeHandler({
      repositories: repositories.value,
      packUploads: yield* Effect.serviceOption(HubPackUploads.HubPackUploads),
      registry: yield* EnvironmentRegistry.EnvironmentRegistry,
      spaces: yield* SpaceDirectory.SpaceDirectory,
      visibility: yield* SpaceVisibility.SpaceVisibility,
      projects: yield* ProjectStore.ProjectStoreV2,
      spawner: yield* ChildProcessSpawner.ChildProcessSpawner,
      sql: yield* SqlClient.SqlClient,
      digest: yield* Digest.Digest,
      maxRequestBytes: yield* Config.Int("T3CODE_HUB_REPOSITORY_MAX_REQUEST_BYTES").pipe(
        Config.withDefault(2 * 1024 * 1024 * 1024),
      ),
      nullDevice: (yield* HostProcess.Platform) === "win32" ? "NUL" : "/dev/null",
      // Its grants let a machine a Thread left hand over the changes it kept.
      remote: yield* Effect.serviceOption(RemoteEnvironments.RemoteEnvironments),
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Hub repository request failed", { cause }).pipe(
          Effect.as(HttpServerResponse.text("Bad Gateway", { status: 502 })),
        ),
      ),
    );
    const path = `${HubRepository.HUB_REPOSITORY_ROUTE_PREFIX}/*`;
    yield* router.add("GET", path, handler);
    yield* router.add("POST", path, handler);
  }),
);
