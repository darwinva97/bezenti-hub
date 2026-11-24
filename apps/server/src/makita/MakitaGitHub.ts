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
import { HttpClient, HttpClientRequest } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

/** The one entry of `MakitaTokenStore`. */
export const MAKITA_TOKEN_ID = "makita";
const REQUEST_HEADERS = {
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "t3code",
};
const TIMEOUT = Duration.seconds(30);
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
  }
>()("t3/makita/MakitaGitHub") {}

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

  /** One request as `token`; the answer whatever its status, or `unreachable`. */
  const send = Effect.fn("MakitaGitHub.send")(function* (
    token: Redacted.Redacted<string>,
    input: MakitaRestInput,
  ) {
    yield* Effect.annotateCurrentSpan({ "makita.github.operation": input.operation });
    const url = `${rest}/${input.path.replace(/^\/+/u, "")}`;
    const base = HttpClientRequest.make(input.method ?? "GET")(url).pipe(
      HttpClientRequest.setHeaders({
        ...REQUEST_HEADERS,
        authorization: `Bearer ${Redacted.value(token)}`,
        ...(input.ifNoneMatch === undefined ? {} : { "if-none-match": input.ifNoneMatch }),
      }),
    );
    const request =
      input.body === undefined ? base : base.pipe(HttpClientRequest.bodyJsonUnsafe(input.body));
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

  return MakitaGitHub.of({
    check: checkWith,
    checkStored: withStored(checkWith),
    rest: Effect.fn("MakitaGitHub.rest")(function* (input: MakitaRestInput) {
      return yield* withStored((token) => restWith(token, input));
    }),
  });
});

/** Over the Hub's `HttpClient`, its SQL and the sealed store. */
export const layer = Layer.effect(MakitaGitHub, make);
