/**
 * Makita's own GitHub REST client (Makita ticket 01), with Makita's token only (passed, or read here
 * from `MakitaTokenStore`): never Source Control's credential, whose request policy invalidates it
 * on a 401. No tracing of the HTTP client: no URL, query or header reaches a span.
 */
import { MAKITA_GITHUB_HOST } from "@t3tools/contracts";
import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import {
  gitHubApiUrls,
  isRateLimited,
} from "@t3tools/source-control-github/server/GitHubRequestPolicy";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { withEnvironmentCredential } from "../checkpointing/HubRepository.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

/** The one entry of `MakitaTokenStore`. */
export const MAKITA_TOKEN_ID = "makita";
const REQUEST_HEADERS = {
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "t3code",
};
const TIMEOUT = Duration.seconds(30);
/** Ticket 12: a CI log is streamed whole to keep its tail, so it may take longer. */
const TAIL_TIMEOUT = Duration.seconds(120);
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
/** GitHub's secondary limits penalize bursts: Makita keeps few requests in flight. */
const CONCURRENCY = 4;

export interface MakitaGitHubAnswer {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: string;
}

/** Why a request to GitHub failed; never the token or a header. */
export class MakitaGitHubError extends Schema.TaggedError<MakitaGitHubError>()(
  "MakitaGitHubError",
  {
    reason: Schema.Literals([
      /** No token registered yet. */
      "no-token",
      /** 401: GitHub refused the token. */
      "unauthorized",
      /** 403 that is not a rate limit: the token may not do this here. */
      "forbidden",
      /** 404: not there, or the token cannot see it. */
      "not-found",
      "rate-limited",
      /** The request did not reach GitHub, or no answer came in time. */
      "unreachable",
      /** Any other answer. */
      "failed",
    ]),
    status: Schema.optionalKey(Schema.Number),
    /** When a rate limit ends, epoch milliseconds, when GitHub said. */
    retryAt: Schema.optionalKey(Schema.Number),
    /** GitHub's own message for a failed request (never echoes the token). */
    detail: Schema.optionalKey(Schema.String),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "no-token":
        return "Makita's GitHub account is not registered.";
      case "unauthorized":
        return "GitHub refused Makita's token.";
      case "forbidden":
        return "Makita's token may not do this on GitHub.";
      case "not-found":
        return "GitHub could not find it, or Makita's token cannot see it.";
      case "rate-limited":
        return "GitHub's rate limit for Makita's token is spent for now.";
      case "unreachable":
        return "Could not reach GitHub.";
      case "failed":
        return this.detail === undefined
          ? `GitHub answered HTTP ${this.status ?? 0}.`
          : `GitHub answered: ${this.detail}`;
    }
  }
}

/** What `GET /user` says of a token. */
export interface MakitaTokenCheck {
  readonly login: string;
  readonly id: number;
  /** `User`, `Organization` or `Bot`; Makita works only as a `User`. */
  readonly type: string;
  /** A classic token's `X-OAuth-Scopes`; null when GitHub sends none (a fine-grained token). */
  readonly scopes: ReadonlyArray<string> | null;
  /** From `github-authentication-token-expiration`, ISO; null when GitHub says none. */
  readonly expiresAt: string | null;
}

export interface MakitaRestInput {
  /** A short name of what the request is for, for its span. */
  readonly operation: string;
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Relative to the API root, with its query string. */
  readonly path: string;
  readonly body?: unknown;
  /** Revalidate a cached answer: a 304 answers without spending the token's quota. */
  readonly ifNoneMatch?: string;
}

/** Ticket 12: a GET whose answer only matters by its end. */
interface MakitaTailInput {
  readonly operation: string;
  readonly path: string;
  readonly maxBytes: number;
}

/** Ticket 12: the end of a long answer. */
export interface MakitaGitHubTail {
  readonly text: string;
  /** Whether more came before what was kept. */
  readonly truncated: boolean;
}

/**
 * Makita ticket 10: where Makita's git commands reach GitHub, by URL. Tests point it at a folder of
 * local bare repositories.
 */
export const MakitaGitRemote = Context.Reference<{ readonly urlOf: (repo: string) => string }>(
  "t3/makita/MakitaGitHub/MakitaGitRemote",
  { defaultValue: () => ({ urlOf: (repo) => `https://${MAKITA_GITHUB_HOST}/${repo}.git` }) },
);

export interface MakitaFetchInput {
  /** `owner/name`. */
  readonly repo: string;
  /** The Hub's bare repository the commit lands in. */
  readonly gitDir: string;
  /** Null: GitHub's default branch. */
  readonly branch: string | null;
  /** Where the commit is kept in `gitDir` (replaced). */
  readonly ref: string;
}

export interface MakitaPushInput {
  readonly repo: string;
  readonly gitDir: string;
  /** A commit of `gitDir`. */
  readonly sha: string;
  /** The `makita/…` branch: built by the Hub, never by the agent. */
  readonly branch: string;
}

export class MakitaGitHub extends Context.Service<
  MakitaGitHub,
  {
    /** `GET /user` with a token being registered (not stored yet). */
    readonly check: (
      token: Redacted.Redacted<string>,
    ) => Effect.Effect<MakitaTokenCheck, MakitaGitHubError>;
    /** `GET /user` with the stored token («Check now»); a 401 marks the account `token-invalid`. */
    readonly checkStored: Effect.Effect<MakitaTokenCheck, MakitaGitHubError>;
    /**
     * One request with the stored token. 2xx (and a 304 to `ifNoneMatch`) answer; anything else
     * fails. A 401 marks the account `token-invalid`.
     */
    readonly rest: (input: MakitaRestInput) => Effect.Effect<MakitaGitHubAnswer, MakitaGitHubError>;
    /**
     * Ticket 10: fetches a branch of the repository into a ref of a Hub repository, with the
     * stored token; the commit it is at.
     */
    readonly fetchBranch: (input: MakitaFetchInput) => Effect.Effect<string, MakitaGitHubError>;
    /**
     * Ticket 10: pushes a commit to a branch of the repository with the stored token, never
     * forced. `rejected`: GitHub has commits there the push does not build on.
     */
    readonly pushBranch: (
      input: MakitaPushInput,
    ) => Effect.Effect<"pushed" | "rejected", MakitaGitHubError>;
    /** Ticket 10: the commit a branch of the repository is at on GitHub, or null without one. */
    readonly branchTip: (
      input: Omit<MakitaPushInput, "sha">,
    ) => Effect.Effect<string | null, MakitaGitHubError>;
    /**
     * Ticket 12: one GET with the stored token whose answer is read to its end, keeping only its
     * last `maxBytes` (a CI job's log, behind GitHub's redirect).
     */
    readonly tail: (input: MakitaTailInput) => Effect.Effect<MakitaGitHubTail, MakitaGitHubError>;
  }
>()("t3/makita/MakitaGitHub") {}

/** Text with the shape of a token, wherever git's words are passed on. */
const TOKEN_SHAPE =
  /(?:t3gk_|t3ak_|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/gu;
const REJECTED =
  /\[rejected\]|non-fast-forward|fetch first|\(stale info\)|failed to push some refs/iu;
const AUTH_FAILED = /authentication failed|invalid username or password|returned error: 401/iu;
const DENIED = /permission to .* denied|returned error: 403|refusing to allow|workflow/iu;
const NOT_FOUND = /repository not found|returned error: 404|couldn't find remote ref/iu;
const UNREACHABLE =
  /could not resolve host|failed to connect|timed out|connection (refused|reset)/iu;
const GIT_TIMEOUT_MS = 5 * 60_000;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;

const decodeUser = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ login: Schema.String, id: Schema.Number, type: Schema.String }),
  ),
);
const decodeMessage = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ message: Schema.optional(Schema.String) })),
);

/** `X-OAuth-Scopes: repo, read:org` → `["repo", "read:org"]`; none sent → null. */
const scopesOf = (header: string | undefined): ReadonlyArray<string> | null =>
  header === undefined
    ? null
    : header
        .split(",")
        .map((scope) => scope.trim())
        .filter((scope) => scope.length > 0);

/**
 * `github-authentication-token-expiration` (`2026-12-24 10:00:00 UTC`, or with an offset such as
 * `-0500`) as an ISO instant; anything else, null.
 */
const expiryOf = (header: string | undefined): string | null => {
  if (header === undefined) return null;
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*(UTC|Z|[+-]\d{2}:?\d{2})?$/u.exec(
    header.trim(),
  );
  if (match === null) return null;
  const zone = match[3];
  const offset =
    zone === undefined || zone === "UTC" || zone === "Z"
      ? "Z"
      : `${zone.slice(0, 3)}:${zone.slice(-2)}`;
  const parsed = DateTime.make(`${match[1]}T${match[2]}${offset}`);
  return Option.isSome(parsed) ? DateTime.formatIso(DateTime.toUtc(parsed.value)) : null;
};

const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const tokens = yield* ServerSecretStore.MakitaTokenStore;
  const sql = yield* SqlClient.SqlClient;
  const slots = yield* Semaphore.make(CONCURRENCY);
  const rest = gitHubApiUrls(MAKITA_GITHUB_HOST).rest;
  const gitRemote = yield* MakitaGitRemote;
  const vcs = yield* VcsProcess.VcsProcess;

  const requestOf = (token: Redacted.Redacted<string>, input: MakitaRestInput) => {
    const url = `${rest}/${input.path.replace(/^\/+/u, "")}`;
    const base = HttpClientRequest.make(input.method ?? "GET")(url).pipe(
      HttpClientRequest.setHeaders({
        ...REQUEST_HEADERS,
        authorization: `Bearer ${Redacted.value(token)}`,
        ...(input.ifNoneMatch === undefined ? {} : { "if-none-match": input.ifNoneMatch }),
      }),
    );
    return input.body === undefined
      ? base
      : base.pipe(HttpClientRequest.bodyJsonUnsafe(input.body));
  };

  /** One request as `token`; the answer whatever its status, or `unreachable`. */
  const send = Effect.fn("MakitaGitHub.send")(function* (
    token: Redacted.Redacted<string>,
    input: MakitaRestInput,
  ) {
    yield* Effect.annotateCurrentSpan({ "makita.github.operation": input.operation });
    const request = requestOf(token, input);
    return yield* slots.withPermit(
      Effect.gen(function* () {
        const response = yield* httpClient
          .execute(request)
          .pipe(Effect.provideService(HttpClient.TracerDisabledWhen, () => true));
        const collected = yield* collectUint8StreamText({
          stream: response.stream,
          maxBytes: MAX_RESPONSE_BYTES,
        }).pipe(
          Effect.catchIf(
            (error) => error.reason._tag === "EmptyBodyError",
            () => Effect.succeed({ text: "", truncated: false, invalidUtf8: false }),
          ),
        );
        return {
          status: response.status,
          headers: response.headers as Readonly<Record<string, string | undefined>>,
          body: collected.text,
        } satisfies MakitaGitHubAnswer;
      }).pipe(
        Effect.timeoutOrElse({
          duration: TIMEOUT,
          orElse: () => Effect.fail(new MakitaGitHubError({ reason: "unreachable" })),
        }),
        // Nothing of the failure travels on: its cause could name the request.
        Effect.mapError((error) =>
          error._tag === "MakitaGitHubError"
            ? error
            : new MakitaGitHubError({ reason: "unreachable" }),
        ),
      ),
    );
  });

  /** A non-2xx answer as the failure it is. */
  const refusal = Effect.fn("MakitaGitHub.refusal")(function* (answer: MakitaGitHubAnswer) {
    const { status, headers, body } = answer;
    if (isRateLimited({ status, headers, body })) {
      const now = yield* Clock.currentTimeMillis;
      const retryAfter = Number(headers["retry-after"]);
      const reset = Number(headers["x-ratelimit-reset"]) * 1_000;
      const retryAt =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? now + retryAfter * 1_000
          : Number.isFinite(reset) && reset > now
            ? reset
            : undefined;
      return new MakitaGitHubError({
        reason: "rate-limited",
        status,
        ...(retryAt === undefined ? {} : { retryAt }),
      });
    }
    if (status === 401) return new MakitaGitHubError({ reason: "unauthorized", status });
    if (status === 403) return new MakitaGitHubError({ reason: "forbidden", status });
    if (status === 404) return new MakitaGitHubError({ reason: "not-found", status });
    const detail = Option.flatMap(decodeMessage(body), (decoded) =>
      Option.fromUndefinedOr(decoded.message),
    );
    return new MakitaGitHubError({
      reason: "failed",
      status,
      ...(Option.isSome(detail) ? { detail: detail.value.slice(0, 300) } : {}),
    });
  });

  const userOf = Effect.fn("MakitaGitHub.userOf")(function* (answer: MakitaGitHubAnswer) {
    if (answer.status !== 200) return yield* yield* refusal(answer);
    const user = decodeUser(answer.body);
    if (Option.isNone(user)) {
      return yield* new MakitaGitHubError({ reason: "failed", status: answer.status });
    }
    return {
      login: user.value.login,
      id: user.value.id,
      type: user.value.type,
      scopes: scopesOf(answer.headers["x-oauth-scopes"]),
      expiresAt: expiryOf(answer.headers["github-authentication-token-expiration"]),
    } satisfies MakitaTokenCheck;
  });

  /** The stored token, read here alone. */
  const storedToken = Effect.gen(function* () {
    const stored = yield* tokens
      .get(MAKITA_TOKEN_ID)
      .pipe(
        Effect.catch((cause) =>
          Effect.logError("MakitaGitHub: could not read Makita's token", { cause }).pipe(
            Effect.andThen(Effect.succeed(Option.none<Uint8Array>())),
          ),
        ),
      );
    if (Option.isNone(stored)) return yield* new MakitaGitHubError({ reason: "no-token" });
    return Redacted.make(new TextDecoder().decode(stored.value));
  });

  /** A 401 to the stored token: the Owner is told at once (Platform → Makita). */
  const markInvalid = Effect.gen(function* () {
    const at = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      UPDATE makita_account SET status = 'token-invalid', checked_at = ${at}, updated_at = ${at}
      WHERE account_id = 'makita'
    `.pipe(
      Effect.catch((cause) =>
        Effect.logError("MakitaGitHub: could not mark Makita's token invalid", { cause }),
      ),
    );
  });

  const withStored = <A>(
    run: (token: Redacted.Redacted<string>) => Effect.Effect<A, MakitaGitHubError>,
  ) =>
    storedToken.pipe(
      Effect.flatMap(run),
      Effect.tapError((error) => (error.reason === "unauthorized" ? markInvalid : Effect.void)),
    );

  const checkWith = Effect.fn("MakitaGitHub.checkWith")(function* (
    token: Redacted.Redacted<string>,
  ) {
    return yield* userOf(yield* send(token, { operation: "check-token", path: "user" }));
  });

  const restWith = Effect.fn("MakitaGitHub.restWith")(function* (
    token: Redacted.Redacted<string>,
    input: MakitaRestInput,
  ) {
    const answer = yield* send(token, input);
    const ok =
      (answer.status >= 200 && answer.status < 300) ||
      (answer.status === 304 && input.ifNoneMatch !== undefined);
    if (!ok) return yield* yield* refusal(answer);
    return answer;
  });

  /** Ticket 12: the answer streamed to its end, only its last `maxBytes` kept. */
  const tailWith = Effect.fn("MakitaGitHub.tailWith")(function* (
    token: Redacted.Redacted<string>,
    input: MakitaTailInput,
  ) {
    yield* Effect.annotateCurrentSpan({ "makita.github.operation": input.operation });
    const request = requestOf(token, { operation: input.operation, path: input.path });
    return yield* slots.withPermit(
      Effect.gen(function* () {
        const response = yield* httpClient
          .execute(request)
          .pipe(Effect.provideService(HttpClient.TracerDisabledWhen, () => true));
        if (response.status < 200 || response.status >= 300) {
          const collected = yield* collectUint8StreamText({
            stream: response.stream,
            maxBytes: 64 * 1024,
          }).pipe(Effect.orElseSucceed(() => ({ text: "" })));
          return yield* yield* refusal({
            status: response.status,
            headers: response.headers as Readonly<Record<string, string | undefined>>,
            body: collected.text,
          });
        }
        const kept = yield* response.stream.pipe(
          Stream.runFold(
            () => ({ chunks: [] as Array<Uint8Array>, bytes: 0, dropped: false }),
            (state, chunk) => {
              state.chunks.push(chunk);
              let bytes = state.bytes + chunk.byteLength;
              let dropped = state.dropped;
              while (
                state.chunks.length > 1 &&
                bytes - state.chunks[0]!.byteLength >= input.maxBytes
              ) {
                bytes -= state.chunks.shift()!.byteLength;
                dropped = true;
              }
              return { chunks: state.chunks, bytes, dropped };
            },
          ),
        );
        const all = new Uint8Array(kept.bytes);
        let offset = 0;
        for (const chunk of kept.chunks) {
          all.set(chunk, offset);
          offset += chunk.byteLength;
        }
        const cut = all.byteLength > input.maxBytes;
        const text = new TextDecoder().decode(
          cut ? all.subarray(all.byteLength - input.maxBytes) : all,
        );
        return {
          // A cut may split a line or a character: what comes before the first line break goes.
          text: cut ? text.slice(text.indexOf("\n") + 1) : text,
          truncated: cut || kept.dropped,
        } satisfies MakitaGitHubTail;
      }).pipe(
        Effect.timeoutOrElse({
          duration: TAIL_TIMEOUT,
          orElse: () => Effect.fail(new MakitaGitHubError({ reason: "unreachable" })),
        }),
        // Nothing of the failure travels on: its cause could name the request.
        Effect.mapError((error) =>
          error._tag === "MakitaGitHubError"
            ? error
            : new MakitaGitHubError({ reason: "unreachable" }),
        ),
      ),
    );
  });

  /**
   * One git command in a Hub repository, naming GitHub by URL, with the stored token in the
   * environment of that process only (`withEnvironmentCredential`): never an argument, a URL or a
   * config file. Git's words come back scrubbed of anything token-shaped.
   */
  const gitWith = Effect.fn("MakitaGitHub.git")(function* (
    token: Redacted.Redacted<string>,
    input: {
      readonly operation: string;
      readonly repo: string;
      readonly gitDir: string;
      readonly args: (url: string) => ReadonlyArray<string>;
    },
  ) {
    yield* Effect.annotateCurrentSpan({ "makita.github.operation": input.operation });
    const accounts = yield* sql<{ readonly login: string }>`
      SELECT login FROM makita_account WHERE account_id = 'makita'
    `.pipe(Effect.orElseSucceed(() => []));
    const login = accounts[0]?.login ?? "";
    const url = gitRemote.urlOf(input.repo);
    const remote = withEnvironmentCredential(
      url,
      Redacted.value(token),
      /^[A-Za-z0-9-]{1,39}$/u.test(login) ? login : "makita",
    );
    const output = yield* vcs
      .run({
        operation: `MakitaGitHub.${input.operation}`,
        command: "git",
        cwd: input.gitDir,
        args: ["--git-dir", input.gitDir, "-c", "gc.auto=0", ...input.args(url)],
        ...(remote.env === undefined ? {} : { env: remote.env }),
        allowNonZeroExit: true,
        timeoutMs: GIT_TIMEOUT_MS,
      })
      // Nothing of the failure travels on: its cause names the process.
      .pipe(Effect.mapError(() => new MakitaGitHubError({ reason: "unreachable" })));
    return {
      exitCode: output.exitCode,
      words: `${output.stdout}\n${output.stderr}`.replace(TOKEN_SHAPE, "[token]"),
    };
  });

  /** A failed git command as the failure it is. */
  const gitFailure = (words: string) => {
    const detail = words
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(-3)
      .join(" ")
      .slice(0, 300);
    if (AUTH_FAILED.test(words)) return new MakitaGitHubError({ reason: "unauthorized" });
    if (DENIED.test(words)) {
      return new MakitaGitHubError({
        reason: "failed",
        detail: detail.length > 0 ? detail : "GitHub refused the push.",
      });
    }
    if (NOT_FOUND.test(words)) return new MakitaGitHubError({ reason: "not-found" });
    if (UNREACHABLE.test(words)) return new MakitaGitHubError({ reason: "unreachable" });
    return new MakitaGitHubError({
      reason: "failed",
      ...(detail.length > 0 ? { detail } : {}),
    });
  };

  const fetchWith = Effect.fn("MakitaGitHub.fetchWith")(function* (
    token: Redacted.Redacted<string>,
    input: MakitaFetchInput,
  ) {
    if (
      !input.ref.startsWith("refs/") ||
      (input.branch !== null && !SAFE_NAME.test(input.branch))
    ) {
      return yield* new MakitaGitHubError({ reason: "failed", detail: "Not a branch name." });
    }
    const source = input.branch === null ? "HEAD" : `refs/heads/${input.branch}`;
    const fetched = yield* gitWith(token, {
      operation: "fetch-branch",
      repo: input.repo,
      gitDir: input.gitDir,
      args: (url) => [
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        "--recurse-submodules=no",
        "--quiet",
        url,
        `+${source}:${input.ref}`,
      ],
    });
    if (fetched.exitCode !== 0) return yield* gitFailure(fetched.words);
    const read = yield* vcs
      .run({
        operation: "MakitaGitHub.fetch-branch",
        command: "git",
        cwd: input.gitDir,
        args: [
          "--git-dir",
          input.gitDir,
          "rev-parse",
          "--verify",
          "--quiet",
          `${input.ref}^{commit}`,
        ],
        allowNonZeroExit: true,
      })
      .pipe(Effect.mapError(() => new MakitaGitHubError({ reason: "failed" })));
    const sha = read.stdout.trim();
    if (read.exitCode !== 0 || !/^[0-9a-f]{40}$/u.test(sha)) {
      return yield* new MakitaGitHubError({ reason: "failed", detail: "No commit was fetched." });
    }
    return sha;
  });

  const pushWith = Effect.fn("MakitaGitHub.pushWith")(function* (
    token: Redacted.Redacted<string>,
    input: MakitaPushInput,
  ) {
    // Defense in depth: whatever the caller checked, only a commit to a `makita/` branch.
    if (
      !input.branch.startsWith("makita/") ||
      !SAFE_NAME.test(input.branch) ||
      !/^[0-9a-f]{40}$/u.test(input.sha)
    ) {
      return yield* new MakitaGitHubError({ reason: "failed", detail: "Not a Makita branch." });
    }
    const pushed = yield* gitWith(token, {
      operation: "push-branch",
      repo: input.repo,
      gitDir: input.gitDir,
      // No `+`, no `--force`: GitHub takes only a fast-forward.
      args: (url) => [
        "-c",
        "push.followTags=false",
        "push",
        "--no-verify",
        "--recurse-submodules=no",
        url,
        `${input.sha}:refs/heads/${input.branch}`,
      ],
    });
    if (pushed.exitCode === 0) return "pushed" as const;
    if (!AUTH_FAILED.test(pushed.words) && !DENIED.test(pushed.words)) {
      if (REJECTED.test(pushed.words)) return "rejected" as const;
    }
    return yield* gitFailure(pushed.words);
  });

  const tipWith = Effect.fn("MakitaGitHub.tipWith")(function* (
    token: Redacted.Redacted<string>,
    input: Omit<MakitaPushInput, "sha">,
  ) {
    if (!SAFE_NAME.test(input.branch)) {
      return yield* new MakitaGitHubError({ reason: "failed", detail: "Not a branch name." });
    }
    const listed = yield* gitWith(token, {
      operation: "branch-tip",
      repo: input.repo,
      gitDir: input.gitDir,
      args: (url) => ["ls-remote", url, `refs/heads/${input.branch}`],
    });
    if (listed.exitCode !== 0) return yield* gitFailure(listed.words);
    const line = listed.words
      .split("\n")
      .find((entry) => entry.endsWith(`\trefs/heads/${input.branch}`));
    const sha = line?.split("\t")[0]?.trim() ?? "";
    return /^[0-9a-f]{40}$/u.test(sha) ? sha : null;
  });

  return MakitaGitHub.of({
    check: checkWith,
    checkStored: withStored(checkWith),
    rest: Effect.fn("MakitaGitHub.rest")(function* (input: MakitaRestInput) {
      return yield* withStored((token) => restWith(token, input));
    }),
    fetchBranch: Effect.fn("MakitaGitHub.fetchBranch")(function* (input: MakitaFetchInput) {
      return yield* withStored((token) => fetchWith(token, input));
    }),
    pushBranch: Effect.fn("MakitaGitHub.pushBranch")(function* (input: MakitaPushInput) {
      return yield* withStored((token) => pushWith(token, input));
    }),
    branchTip: Effect.fn("MakitaGitHub.branchTip")(function* (input: Omit<MakitaPushInput, "sha">) {
      return yield* withStored((token) => tipWith(token, input));
    }),
    tail: Effect.fn("MakitaGitHub.tail")(function* (input: MakitaTailInput) {
      return yield* withStored((token) => tailWith(token, input));
    }),
  });
});

/** Over the Hub's `HttpClient`, its SQL, the sealed store and git (ticket 10). */
export const layer = Layer.effect(MakitaGitHub, make);
