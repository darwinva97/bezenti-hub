// @effect-diagnostics nodeBuiltinImport:off -- a short hash of what an upload carries names it.
/**
 * A machine's side of a large upload to the Hub repository (`HubPackUploads`): the objects the
 * Hub lacks go into one pack file in the checkout's git folder, sent in parts no larger than a
 * proxy in front of the Hub accepts, then applied by the Hub. The pack's name comes from what it
 * carries, so an upload that failed resumes where the Hub is instead of starting over.
 */
import * as NodeCrypto from "node:crypto";

import { VcsProcessExitError } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as HubPackUploads from "./HubPackUploads.ts";
import * as HubRepository from "./HubRepository.ts";

/** A part's size to start with, and the least it shrinks to when a proxy refuses one. */
const DEFAULT_PART_BYTES = 32 * 1024 * 1024;
const MIN_PART_BYTES = 4 * 1024 * 1024;
/** Failed requests in a row (network, 5xx) before the upload fails and retries later. */
const MAX_REQUEST_FAILURES = 6;
/** How long an apply is followed before the upload counts as failed (the Hub may go on). */
const APPLY_WAIT = Duration.minutes(15);
const APPLY_POLL = Duration.seconds(2);
/** Rounds of «send the rest, apply» before giving up: the Hub restarted or lost bytes. */
const MAX_ROUNDS = 3;
/** Packs left from uploads that never finished are removed after this long. */
const STALE_PACK_MS = 24 * 60 * 60_000;
const UPLOADS_FOLDER = "t3-hub-uploads";

const decodeStatus = Schema.decodeUnknownEffect(HubPackUploads.PackUploadStatus);
const decodeKnown = Schema.decodeUnknownEffect(HubPackUploads.KnownTipsResponse);

const failure = (cwd: string, detail: string) =>
  new VcsProcessExitError({
    operation: "HubRepository.uploadInParts",
    command: "git",
    cwd,
    exitCode: 1,
    detail,
  });

const megabytes = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MiB`;

export interface PackUploaderOptions {
  readonly fileSystem: FileSystem.FileSystem;
  readonly joinPath: (...segments: ReadonlyArray<string>) => string;
  /** The first part's size (tests make it small). */
  readonly partBytes?: number;
  /** Above this many bytes an upload goes in parts (tests make it small). */
  readonly smartPushMaxBytes?: number;
  /** Above this many bytes `git push` would send again, an upload goes in parts (tests). */
  readonly resendMaxBytes?: number;
}

/** Large uploads in parts, for a machine that reaches its Hub over HTTP. */
export const makePackUploader = (options: PackUploaderOptions): HubRepository.PackUploader => {
  const { fileSystem, joinPath } = options;
  const http = Layer.mergeAll(
    FetchHttpClient.layer,
    // The credential goes to the Hub's own address only: no redirect is followed.
    Layer.succeed(FetchHttpClient.RequestInit, { redirect: "manual" }),
  );
  const upload = Effect.fn("HubRepository.uploadInParts")(function* (
    input: Parameters<HubRepository.PackUploader["upload"]>[0],
  ) {
    const vcs = yield* VcsProcess.VcsProcess;
    const { cwd, remote } = input;
    const credential = remote.credential;
    if (credential === undefined) {
      return yield* failure(cwd, "This machine has no credential for the Hub repository.");
    }
    const git = (args: ReadonlyArray<string>, stdin?: string) =>
      HubRepository.gitIn(vcs, {
        operation: "HubRepository.uploadInParts",
        cwd,
        args,
        ...(stdin === undefined ? {} : { stdin }),
      });

    // What each ref is now; a ref the checkout lacks fails as git's push would say.
    const listed = yield* git(["for-each-ref", "--format=%(objectname) %(refname)", ...input.refs]);
    const tips = new Map(
      listed.stdout
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => {
          const [oid, ref] = line.split(" ");
          return [ref ?? "", oid ?? ""] as const;
        }),
    );
    const missing = input.refs.find((ref) => !tips.has(ref));
    if (missing !== undefined) {
      return yield* failure(cwd, `error: src refspec ${missing} does not match any`);
    }
    const updates = input.refs.map((ref) => ({ ref, newOid: tips.get(ref)! }));

    const gitDir = (yield* git([
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ])).stdout.trim();
    const folder = joinPath(gitDir, UPLOADS_FOLDER);
    yield* fileSystem.makeDirectory(folder, { recursive: true });
    yield* removeStalePacks(fileSystem, joinPath, folder).pipe(Effect.ignore);

    const uploadId = NodeCrypto.createHash("sha256")
      .update(
        [
          remote.url,
          ...updates.map((update) => `${update.newOid} ${update.ref}`).toSorted(),
          "--not",
          ...[...input.remoteTips].toSorted(),
        ].join("\n"),
      )
      .digest("hex")
      .slice(0, 40);
    const packFile = joinPath(folder, `${uploadId}.pack`);
    if (!(yield* fileSystem.exists(packFile))) {
      // Not thin: the Hub indexes it as it is, with no objects of its own to complete it.
      // Only the pack is sent: no reverse index beside it. Nothing the Hub's tips reach goes,
      // their trees included.
      const written = yield* git(
        [
          "-c",
          "pack.writeReverseIndex=false",
          "pack-objects",
          "--revs",
          "--quiet",
          joinPath(folder, `${uploadId}-new`),
        ],
        HubRepository.revisionsInput(
          updates.map((update) => update.newOid),
          input.remoteTips,
        ),
      );
      const hash = written.stdout.trim().split(/\s+/u).at(-1) ?? "";
      const made = joinPath(folder, `${uploadId}-new-${hash}.pack`);
      yield* fileSystem.rename(made, packFile);
      for (const name of yield* fileSystem.readDirectory(folder)) {
        if (!name.startsWith(`${uploadId}-new-`)) continue;
        yield* fileSystem.remove(joinPath(folder, name), { force: true }).pipe(Effect.ignore);
      }
    }
    const size = Number((yield* fileSystem.stat(packFile)).size);
    yield* Effect.annotateCurrentSpan({ "hubRepository.uploadBytes": size });

    const base = `${remote.url.replace(/\/+$/u, "")}/${HubPackUploads.PACK_UPLOADS_SEGMENT}/${uploadId}`;
    const send = (request: HttpClientRequest.HttpClientRequest) =>
      HttpClient.HttpClient.pipe(
        Effect.flatMap((client) =>
          client.execute(HttpClientRequest.bearerToken(request, credential)),
        ),
        Effect.timeout(Duration.minutes(5)),
        Effect.provide(http),
        Effect.result,
      );
    /** The Hub's status from a response, or why there is none. */
    const statusOf = (response: HttpClientResponse.HttpClientResponse) =>
      response.json.pipe(Effect.flatMap(decodeStatus), Effect.option);
    const refused = (response: HttpClientResponse.HttpClientResponse, what: string) =>
      response.text.pipe(
        Effect.orElseSucceed(() => ""),
        Effect.flatMap((text) => {
          if (response.status === 404) {
            return failure(
              cwd,
              `The Hub must be updated to accept uploads over ${megabytes(HubRepository.SMART_PUSH_MAX_BYTES)} (this one is ${megabytes(size)}).`,
            );
          }
          if (response.status === 413) {
            return failure(
              cwd,
              `The Hub (or a proxy in front of it) refused ${what} with HTTP 413: this upload is ${megabytes(size)}, larger than the Hub accepts.`,
            );
          }
          const said = text.trim().slice(0, 500);
          return failure(
            cwd,
            `The Hub refused ${what}: HTTP ${response.status}${said.length === 0 ? "" : ` ${said}`}`,
          );
        }),
      );

    let failures = 0;
    /** A request failed without an answer, or with a 5xx: wait, and fail after too many. */
    const transientFailure = Effect.fn("HubRepository.uploadInParts.retry")(function* (
      detail: string,
    ) {
      failures += 1;
      if (failures >= MAX_REQUEST_FAILURES) {
        return yield* failure(cwd, `The upload to the Hub failed: ${detail}`);
      }
      yield* Effect.sleep(Duration.seconds(2 ** failures));
    });

    /** Where the Hub is, from its status of this upload. */
    const hubStatus = Effect.gen(function* () {
      while (true) {
        const answered = yield* send(HttpClientRequest.get(base));
        if (answered._tag === "Failure") {
          yield* transientFailure(String(answered.failure));
          continue;
        }
        const response = answered.success;
        if (response.status >= 500) {
          yield* transientFailure(`HTTP ${response.status}`);
          continue;
        }
        if (response.status !== 200) return yield* refused(response, "the upload's status");
        const status = yield* statusOf(response);
        if (status._tag === "None") return yield* failure(cwd, "The Hub's answer was not read.");
        failures = 0;
        return status.value;
      }
    });

    /** Sends the bytes from `offset` on, part by part; resolves when the Hub has them all. */
    let partBytes = options.partBytes ?? DEFAULT_PART_BYTES;
    const leastPartBytes = Math.min(MIN_PART_BYTES, partBytes);
    const sendRest = Effect.fn("HubRepository.uploadInParts.send")(function* (from: number) {
      let offset = from;
      while (offset < size) {
        const length = Math.min(partBytes, size - offset);
        const bytes = yield* Effect.scoped(
          Effect.gen(function* () {
            const file = yield* fileSystem.open(packFile, { flag: "r" });
            yield* file.seek(BigInt(offset), "start");
            const buffer = new Uint8Array(length);
            let read = 0;
            while (read < length) {
              const got = Number(yield* file.read(buffer.subarray(read)));
              if (got === 0) break;
              read += got;
            }
            return buffer.subarray(0, read);
          }),
        );
        const answered = yield* send(
          HttpClientRequest.post(`${base}?offset=${offset}`).pipe(
            HttpClientRequest.bodyUint8Array(bytes, "application/octet-stream"),
          ),
        );
        if (answered._tag === "Failure") {
          yield* transientFailure(String(answered.failure));
          continue;
        }
        const response = answered.success;
        if (response.status === 413) {
          if (partBytes <= leastPartBytes) {
            return yield* refused(response, `a ${megabytes(partBytes)} part`);
          }
          partBytes = Math.max(leastPartBytes, Math.floor(partBytes / 2));
          continue;
        }
        if (response.status >= 500) {
          yield* transientFailure(`HTTP ${response.status}`);
          continue;
        }
        if (response.status !== 200 && response.status !== 409) {
          return yield* refused(response, "a part of the upload");
        }
        const status = yield* statusOf(response);
        if (status._tag === "None") return yield* failure(cwd, "The Hub's answer was not read.");
        failures = 0;
        offset = status.value.size;
      }
    });

    /** Asks the Hub to apply the upload and follows it until it ends. */
    const applied = Effect.gen(function* () {
      while (true) {
        const answered = yield* send(
          HttpClientRequest.post(`${base}/apply`).pipe(
            HttpClientRequest.bodyJsonUnsafe({ size, updates }),
          ),
        );
        if (answered._tag === "Failure") {
          yield* transientFailure(String(answered.failure));
          continue;
        }
        const response = answered.success;
        if (response.status >= 500) {
          yield* transientFailure(`HTTP ${response.status}`);
          continue;
        }
        const status = yield* statusOf(response);
        if (response.status !== 200 && response.status !== 202) {
          if (status._tag === "Some" && status.value.error !== undefined) {
            return yield* failure(cwd, `The Hub refused the upload: ${status.value.error}`);
          }
          return yield* refused(response, "to apply the upload");
        }
        failures = 0;
        let current = status._tag === "Some" ? status.value : yield* hubStatus;
        while (current.state === "applying") {
          yield* Effect.sleep(APPLY_POLL);
          current = yield* hubStatus;
        }
        return current;
      }
    }).pipe(
      Effect.timeoutOrElse({
        duration: APPLY_WAIT,
        orElse: () =>
          Effect.fail(
            failure(cwd, "The Hub took too long to apply the upload; it is tried again."),
          ),
      }),
    );

    let status = yield* hubStatus;
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      if (status.state === "done") break;
      if (status.state === "failed") {
        return yield* failure(
          cwd,
          `The Hub could not apply the upload: ${status.error ?? "no reason given."}`,
        );
      }
      if (status.size < size) yield* sendRest(status.size);
      status = yield* applied;
    }
    if (status.state !== "done") {
      return yield* failure(
        cwd,
        status.state === "failed"
          ? `The Hub could not apply the upload: ${status.error ?? "no reason given."}`
          : "The Hub lost part of the upload; it is tried again.",
      );
    }
    yield* fileSystem.remove(packFile, { force: true }).pipe(Effect.ignore);
  });
  const knownTips: HubRepository.PackUploader["knownTips"] = ({ remote, candidates }) => {
    const credential = remote.credential;
    if (credential === undefined) return Effect.succeed(null);
    const asked = new Set(candidates.slice(0, HubPackUploads.KNOWN_TIPS_MAX));
    return HttpClient.HttpClient.pipe(
      Effect.flatMap((client) =>
        client.execute(
          HttpClientRequest.bearerToken(
            HttpClientRequest.post(
              `${remote.url.replace(/\/+$/u, "")}/${HubPackUploads.PACK_UPLOADS_SEGMENT}/${HubPackUploads.KNOWN_TIPS_SEGMENT}`,
            ).pipe(HttpClientRequest.bodyJsonUnsafe({ oids: [...asked] })),
            credential,
          ),
        ),
      ),
      // A Hub from before answers 404: it takes no parts either.
      Effect.flatMap((response) =>
        response.status === 200
          ? response.json.pipe(Effect.flatMap(decodeKnown))
          : Effect.succeed(null),
      ),
      Effect.map((answer) =>
        answer === null ? null : answer.known.filter((oid) => asked.has(oid)),
      ),
      Effect.timeout(Duration.minutes(1)),
      Effect.provide(http),
      Effect.orElseSucceed(() => null),
    );
  };
  return {
    smartPushMaxBytes: options.smartPushMaxBytes ?? HubRepository.SMART_PUSH_MAX_BYTES,
    resendMaxBytes: options.resendMaxBytes ?? HubRepository.RESEND_MAX_BYTES,
    knownTips,
    // A file this machine could not read or write fails the upload like git would.
    upload: (input) =>
      upload(input).pipe(
        Effect.catchTags({
          PlatformError: (error) =>
            Effect.fail(failure(input.cwd, `The upload to the Hub failed here: ${error.message}`)),
        }),
      ),
  };
};

/** Removes packs of uploads that never finished, a day after they were made. */
const removeStalePacks = Effect.fn("HubRepository.removeStalePacks")(function* (
  fileSystem: FileSystem.FileSystem,
  joinPath: (...segments: ReadonlyArray<string>) => string,
  folder: string,
) {
  const now = yield* Clock.currentTimeMillis;
  for (const name of yield* fileSystem.readDirectory(folder)) {
    const file = joinPath(folder, name);
    const info = yield* fileSystem.stat(file).pipe(Effect.option);
    if (info._tag === "None" || info.value.mtime._tag === "None") continue;
    if (now - info.value.mtime.value.getTime() > STALE_PACK_MS) {
      yield* fileSystem.remove(file, { force: true }).pipe(Effect.ignore);
    }
  }
});
