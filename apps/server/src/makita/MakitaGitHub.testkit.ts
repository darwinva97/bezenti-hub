// @effect-diagnostics globalJsonInEffect:off - the fake answers JSON as GitHub does.
/**
 * A fake GitHub for Makita's tests (Makita ticket 01; ticket 04 adds the feeds, ETags and 304s):
 * an `HttpClient` that answers `GET /user`, `GET /users/{login}` and a repository's labels, knows
 * which tokens exist and what each may do, and records every request without its token. Tokens are
 * built at run time so no token-shaped text sits in the sources.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";

/** A classic token (`ghp_` + 36 characters) made of `seed`. */
export const classicToken = (seed: string) => ["ghp", seed.padEnd(36, "0").slice(0, 36)].join("_");
/** A fine-grained token (`github_pat_` + 82 characters) made of `seed`. */
export const fineGrainedToken = (seed: string) =>
  ["github", "pat", seed.padEnd(82, "1").slice(0, 82)].join("_");

export interface FakeGitHubUser {
  readonly login: string;
  readonly id: number;
  /** `User` unless said. */
  readonly type?: string;
}

export interface FakeGitHubToken {
  readonly user: FakeGitHubUser;
  /** `X-OAuth-Scopes`; null or absent: GitHub sends none (a fine-grained token). */
  readonly scopes?: ReadonlyArray<string> | null;
  /** `github-authentication-token-expiration`, as GitHub writes it. */
  readonly expiration?: string;
}

export interface FakeGitHubRequest {
  readonly method: string;
  /** The path after the API root, with its query. */
  readonly path: string;
  readonly body: unknown;
  /** Whether a known token signed it (never the token itself). */
  readonly signed: boolean;
  /** The `If-None-Match` it carried, if any (ticket 04). */
  readonly ifNoneMatch?: string;
}

/** One entry of `GET /repos/{o}/{r}/issues/events`, as GitHub writes it (ticket 04). */
export interface FakeIssueEvent {
  readonly id: number;
  readonly event: string;
  readonly actor: { readonly login: string; readonly id: number; readonly type: string } | null;
  readonly label?: { readonly name: string };
  readonly created_at: string;
  readonly issue: {
    readonly number: number;
    readonly title: string;
    readonly pull_request?: { readonly url: string };
  };
}

/** An issue and its comments (ticket 05). */
export interface FakeIssue {
  readonly number: number;
  title: string;
  body: string | null;
  readonly user: FakeGitHubUser;
  state: "open" | "closed";
  locked: boolean;
  readonly pull?: boolean;
}

export interface FakeComment {
  readonly id: number;
  readonly body: string;
  readonly user: FakeGitHubUser;
  readonly created_at: string;
  readonly updated_at: string;
}

const API = "https://api.github.com/";
const FEED_PAGE = 100;

export const makeFakeGitHub = () => {
  const tokens = new Map<string, FakeGitHubToken>();
  const users = new Map<string, FakeGitHubUser>();
  /** `owner/name` → its labels. A repository not here answers 404. */
  const repos = new Map<string, Set<string>>();
  /** Repositories where creating a label is refused (403). */
  const labelsRefused = new Set<string>();
  const requests: Array<FakeGitHubRequest> = [];
  const state = { down: false, rateLimited: false };
  /** `owner/name` → its issue events, oldest first (answered newest first, as GitHub does). */
  const issueEvents = new Map<string, Array<FakeIssueEvent>>();
  /** `owner/name` → how many times its feed changed: its ETag. */
  const feedVersions = new Map<string, number>();
  /** `owner/name` → `X-Poll-Interval` it answers with. */
  const pollIntervals = new Map<string, number>();
  /**
   * `owner/name` → the status every request about it answers: 401, 403, 404, 429, or
   * `secondary` (GitHub's secondary limit: a 403 with `retry-after`).
   */
  const failures = new Map<string, 401 | 403 | 404 | 429 | "secondary">();
  /** `owner/name#n` → the issue; `…#n` → its comments, oldest first. */
  const issues = new Map<string, FakeIssue>();
  const comments = new Map<string, Array<FakeComment>>();
  let nextEventId = 1_000;
  let nextCommentId = 5_000;
  /** What the fake stamps on events and comments it makes. */
  const clock = { now: "2026-11-24T10:00:00Z" };

  const touch = (repo: string) => feedVersions.set(repo, (feedVersions.get(repo) ?? 0) + 1);

  /** Adds one event to a repository's feed (an id larger than every earlier one). */
  const addEvent = (repo: string, event: Omit<FakeIssueEvent, "id" | "created_at">) => {
    nextEventId += 1;
    const full: FakeIssueEvent = { ...event, id: nextEventId, created_at: clock.now };
    issueEvents.set(repo, [...(issueEvents.get(repo) ?? []), full]);
    touch(repo);
    return full;
  };

  /** `actor` puts `label` on issue `number` (made if missing) of `repo`. */
  const label = (
    repo: string,
    number: number,
    labelName: string,
    actor: FakeGitHubUser,
    options: { readonly pull?: boolean; readonly title?: string; readonly body?: string } = {},
  ) => {
    const key = `${repo}#${number}`;
    if (!issues.has(key)) {
      issues.set(key, {
        number,
        title: options.title ?? `Issue ${number}`,
        body: options.body ?? "Something is broken.",
        user: actor,
        state: "open",
        locked: false,
        ...(options.pull === true ? { pull: true } : {}),
      });
    }
    return addEvent(repo, {
      event: "labeled",
      actor: { login: actor.login, id: actor.id, type: actor.type ?? "User" },
      label: { name: labelName },
      issue: {
        number,
        title: issues.get(key)!.title,
        ...(options.pull === true
          ? { pull_request: { url: `${API}repos/${repo}/pulls/${number}` } }
          : {}),
      },
    });
  };

  /** A comment by `user` on issue `number` of `repo`. */
  const comment = (repo: string, number: number, user: FakeGitHubUser, body: string) => {
    nextCommentId += 1;
    const made: FakeComment = {
      id: nextCommentId,
      body,
      user,
      created_at: clock.now,
      updated_at: clock.now,
    };
    const key = `${repo}#${number}`;
    comments.set(key, [...(comments.get(key) ?? []), made]);
    return made;
  };

  const json = (
    request: HttpClientRequest.HttpClientRequest,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    HttpClientResponse.fromWeb(
      request,
      new Response(body === null ? null : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...headers },
      }),
    );

  const bodyOf = (request: HttpClientRequest.HttpClientRequest): unknown => {
    const body = request.body as { readonly _tag: string; readonly body?: Uint8Array };
    if (body._tag !== "Uint8Array" || body.body === undefined) return null;
    try {
      return JSON.parse(new TextDecoder().decode(body.body));
    } catch {
      return null;
    }
  };

  const answer = (request: HttpClientRequest.HttpClientRequest) => {
    const path = request.url.startsWith(API) ? request.url.slice(API.length) : request.url;
    const auth = request.headers["authorization"] ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
    const held = tokens.get(token);
    const ifNoneMatch = request.headers["if-none-match"];
    requests.push({
      method: request.method,
      path,
      body: bodyOf(request),
      signed: !!held,
      ...(ifNoneMatch === undefined ? {} : { ifNoneMatch }),
    });
    if (state.rateLimited) {
      return json(
        request,
        403,
        { message: "API rate limit exceeded" },
        {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "4102444800",
        },
      );
    }
    if (held === undefined) return json(request, 401, { message: "Bad credentials" });
    const route = path.split("?")[0]!;
    if (request.method === "GET" && route === "user") {
      const headers: Record<string, string> = {};
      if (held.scopes !== undefined && held.scopes !== null) {
        headers["x-oauth-scopes"] = held.scopes.join(", ");
      }
      if (held.expiration !== undefined) {
        headers["github-authentication-token-expiration"] = held.expiration;
      }
      return json(
        request,
        200,
        { login: held.user.login, id: held.user.id, type: held.user.type ?? "User" },
        headers,
      );
    }
    const userMatch = /^users\/([^/]+)$/u.exec(route);
    if (request.method === "GET" && userMatch !== null) {
      const user = users.get(decodeURIComponent(userMatch[1]!).toLowerCase());
      return user === undefined
        ? json(request, 404, { message: "Not Found" })
        : json(request, 200, { login: user.login, id: user.id, type: user.type ?? "User" });
    }
    const repoMatch = /^repos\/([^/]+)\/([^/]+)(?:\/|$)/u.exec(route);
    const failure =
      repoMatch === null ? undefined : failures.get(`${repoMatch[1]}/${repoMatch[2]}`);
    if (failure !== undefined) {
      if (failure === "secondary") {
        return json(
          request,
          403,
          { message: "You have exceeded a secondary rate limit." },
          { "retry-after": "90" },
        );
      }
      if (failure === 429) {
        return json(request, 429, { message: "Too many requests" }, { "retry-after": "120" });
      }
      return json(request, failure, {
        message: failure === 401 ? "Bad credentials" : failure === 403 ? "Forbidden" : "Not Found",
      });
    }
    const feedMatch = /^repos\/([^/]+)\/([^/]+)\/issues\/events$/u.exec(route);
    if (request.method === "GET" && feedMatch !== null) {
      const repo = `${feedMatch[1]}/${feedMatch[2]}`;
      if (!repos.has(repo)) return json(request, 404, { message: "Not Found" });
      const etag = `W/"${repo}-${feedVersions.get(repo) ?? 0}"`;
      const headers: Record<string, string> = { etag };
      const interval = pollIntervals.get(repo);
      if (interval !== undefined) headers["x-poll-interval"] = String(interval);
      if (ifNoneMatch === etag) return json(request, 304, null, headers);
      const events = (issueEvents.get(repo) ?? []).toReversed().slice(0, FEED_PAGE);
      return json(request, 200, events, headers);
    }
    const issueMatch = /^repos\/([^/]+)\/([^/]+)\/issues\/(\d+)(\/comments)?$/u.exec(route);
    if (issueMatch !== null) {
      const key = `${issueMatch[1]}/${issueMatch[2]}#${issueMatch[3]}`;
      const issue = issues.get(key);
      if (issue === undefined) return json(request, 404, { message: "Not Found" });
      const userOf = (user: FakeGitHubUser) => ({
        login: user.login,
        id: user.id,
        type: user.type ?? "User",
      });
      if (request.method === "GET" && issueMatch[4] === undefined) {
        return json(request, 200, {
          number: issue.number,
          title: issue.title,
          body: issue.body,
          user: userOf(issue.user),
          state: issue.state,
          locked: issue.locked,
          ...(issue.pull === true
            ? { pull_request: { url: `${API}repos/${key.replace("#", "/pulls/")}` } }
            : {}),
        });
      }
      if (request.method === "GET" && issueMatch[4] !== undefined) {
        return json(
          request,
          200,
          (comments.get(key) ?? []).map((entry) => ({ ...entry, user: userOf(entry.user) })),
        );
      }
      if (request.method === "POST" && issueMatch[4] !== undefined) {
        if (issue.locked) return json(request, 403, { message: "Issue is locked" });
        const made = comment(
          `${issueMatch[1]}/${issueMatch[2]}`,
          issue.number,
          held.user,
          (bodyOf(request) as { readonly body?: string } | null)?.body ?? "",
        );
        return json(request, 201, { ...made, user: userOf(made.user) });
      }
    }
    const labelMatch = /^repos\/([^/]+)\/([^/]+)\/labels(?:\/([^/]+))?$/u.exec(route);
    if (labelMatch !== null) {
      const repo = `${labelMatch[1]}/${labelMatch[2]}`;
      const labels = repos.get(repo);
      if (labels === undefined) return json(request, 404, { message: "Not Found" });
      if (request.method === "GET" && labelMatch[3] !== undefined) {
        const name = decodeURIComponent(labelMatch[3]);
        return labels.has(name)
          ? json(request, 200, { name })
          : json(request, 404, { message: "Not Found" });
      }
      if (request.method === "POST" && labelMatch[3] === undefined) {
        if (labelsRefused.has(repo)) {
          return json(request, 403, { message: "Must have push access to repository" });
        }
        const name = (bodyOf(request) as { readonly name?: string } | null)?.name ?? "";
        labels.add(name);
        return json(request, 201, { name });
      }
    }
    return json(request, 404, { message: "Not Found" });
  };

  const client = HttpClient.make((request) =>
    state.down
      ? Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, description: "unreachable" }),
          }),
        )
      : Effect.sync(() => answer(request)),
  );

  return {
    layer: Layer.succeed(HttpClient.HttpClient, client),
    tokens,
    users,
    repos,
    labelsRefused,
    requests,
    state,
    issueEvents,
    pollIntervals,
    failures,
    issues,
    comments,
    clock,
    addEvent,
    label,
    comment,
    /** The comments a login wrote on an issue, as they read on GitHub. */
    commentsBy: (repo: string, number: number, login: string) =>
      (comments.get(`${repo}#${number}`) ?? [])
        .filter((entry) => entry.user.login === login)
        .map((entry) => entry.body),
  };
};

export type FakeGitHub = ReturnType<typeof makeFakeGitHub>;
