// @effect-diagnostics globalJsonInEffect:off - the fake answers JSON as GitHub does.
/**
 * A fake GitHub for Makita's tests (Makita ticket 01; ticket 04 adds the feeds, ETags and 304s):
 * an `HttpClient` that answers `GET /user`, `GET /users/{login}` and a repository's labels, knows
 * which tokens exist and what each may do, and records every request without its token. Tokens are
 * built at run time so no token-shaped text sits in the sources.
 */
import * as DateTime from "effect/DateTime";
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
  /** Who was assigned, on an `assigned` event (ticket 09). */
  readonly assignee?: { readonly login: string; readonly id: number };
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

/** A reaction Makita put on a comment (ticket 09), and which feed the comment belongs to. */
export interface FakeReaction {
  readonly repo: string;
  readonly feed: "issues" | "pulls";
  readonly commentId: number;
  readonly content: string;
}

/** A pull request Makita opened (ticket 12). */
export interface FakePullRequest {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly head: string;
  readonly base: string;
  state: "open" | "closed";
  readonly user: FakeGitHubUser;
  /** The head commit when no branch tip is known (`hooks.branchTip`). */
  headSha: string;
}

/** A commit's CI as GitHub reports it (ticket 12). */
export interface FakeCi {
  readonly checkRuns: ReadonlyArray<{
    readonly id: number;
    readonly name: string;
    readonly status: string;
    readonly conclusion: string | null;
    readonly app?: string;
  }>;
  readonly statuses: ReadonlyArray<{ readonly context: string; readonly state: string }>;
}

const API = "https://api.github.com/";

const millisOf = (iso: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(iso));
/** A time as GitHub writes it: ISO, to the second (ticket 09). */
export const gitHubTime = (millis: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(millis)).replace(/\.\d{3}Z$/u, "Z");
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
  /** `owner/name#n` → a pull request's review comments, oldest first (ticket 09). */
  const reviewComments = new Map<string, Array<FakeComment>>();
  const reactions: Array<FakeReaction> = [];
  /** `owner/name` → how many times its comments changed: the comment feeds' ETag. */
  const commentVersions = new Map<string, number>();
  let nextEventId = 1_000;
  let nextCommentId = 5_000;
  /** What the fake stamps on events and comments it makes. */
  const clock = { now: "2026-11-24T10:00:00Z" };
  /** Ticket 12: `owner/name#n` → a pull request; a commit → its CI; a job id → its log. */
  const pulls = new Map<string, FakePullRequest>();
  const ci = new Map<string, FakeCi>();
  const jobLogs = new Map<number, string>();
  /** Where a branch is on GitHub's git side (the push testkit's remote), for a PR's head. */
  const hooks: { branchTip: (repo: string, branch: string) => string | null } = {
    branchTip: () => null,
  };
  let nextPullNumber = 40;

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
    commentVersions.set(repo, (commentVersions.get(repo) ?? 0) + 1);
    return made;
  };

  /** An issue (made if missing) where `user` writes a comment: what a mention needs (ticket 09). */
  const commentOn = (
    repo: string,
    number: number,
    user: FakeGitHubUser,
    body: string,
    options: {
      readonly pull?: boolean;
      readonly title?: string;
      readonly author?: FakeGitHubUser;
    } = {},
  ) => {
    const key = `${repo}#${number}`;
    if (!issues.has(key)) {
      issues.set(key, {
        number,
        title: options.title ?? `Issue ${number}`,
        body: "Something is broken.",
        user: options.author ?? user,
        state: "open",
        locked: false,
        ...(options.pull === true ? { pull: true } : {}),
      });
    }
    return comment(repo, number, user, body);
  };

  /** A review comment by `user` on pull request `number` (made if missing) of `repo`. */
  const reviewComment = (repo: string, number: number, user: FakeGitHubUser, body: string) => {
    const key = `${repo}#${number}`;
    if (!issues.has(key)) {
      issues.set(key, {
        number,
        title: `Pull request ${number}`,
        body: "A change.",
        user,
        state: "open",
        locked: false,
        pull: true,
      });
    }
    nextCommentId += 1;
    const made: FakeComment = {
      id: nextCommentId,
      body,
      user,
      created_at: clock.now,
      updated_at: clock.now,
    };
    reviewComments.set(key, [...(reviewComments.get(key) ?? []), made]);
    commentVersions.set(repo, (commentVersions.get(repo) ?? 0) + 1);
    return made;
  };

  /** Edits a comment: a new body and a later `updated_at`, as GitHub does. */
  const editComment = (repo: string, id: number, body: string) => {
    for (const store of [comments, reviewComments]) {
      for (const [key, list] of store) {
        if (!key.startsWith(`${repo}#`)) continue;
        const index = list.findIndex((entry) => entry.id === id);
        if (index < 0) continue;
        const old = list[index]!;
        const later = Math.max(millisOf(old.updated_at), millisOf(clock.now)) + 60_000;
        const edited = { ...old, body, updated_at: gitHubTime(later) };
        store.set(key, list.toSpliced(index, 1, edited));
        commentVersions.set(repo, (commentVersions.get(repo) ?? 0) + 1);
        return edited;
      }
    }
    throw new Error(`no comment ${id} in ${repo}`);
  };

  /** `actor` assigns issue `number` (made if missing) of `repo` to `assignee` (ticket 09). */
  const assign = (
    repo: string,
    number: number,
    assignee: FakeGitHubUser,
    actor: FakeGitHubUser,
    options: { readonly pull?: boolean } = {},
  ) => {
    const key = `${repo}#${number}`;
    if (!issues.has(key)) {
      issues.set(key, {
        number,
        title: `Issue ${number}`,
        body: "Something is broken.",
        user: actor,
        state: "open",
        locked: false,
        ...(options.pull === true ? { pull: true } : {}),
      });
    }
    return addEvent(repo, {
      event: "assigned",
      actor: { login: actor.login, id: actor.id, type: actor.type ?? "User" },
      assignee: { login: assignee.login, id: assignee.id },
      issue: {
        number,
        title: issues.get(key)!.title,
        ...(options.pull === true
          ? { pull_request: { url: `${API}repos/${repo}/pulls/${number}` } }
          : {}),
      },
    });
  };

  /** Every comment of one feed of a repository, with what GitHub adds to each. */
  const feedComments = (repo: string, feed: "issues" | "pulls") => {
    const store = feed === "issues" ? comments : reviewComments;
    return [...store.entries()]
      .filter(([key]) => key.startsWith(`${repo}#`))
      .flatMap(([key, list]) => {
        const number = Number(key.slice(repo.length + 1));
        const pull = feed === "pulls" || issues.get(key)?.pull === true;
        return list.map((entry) => ({
          ...entry,
          user: { login: entry.user.login, id: entry.user.id, type: entry.user.type ?? "User" },
          html_url: `https://github.com/${repo}/${pull ? "pull" : "issues"}/${number}#comment-${entry.id}`,
          ...(feed === "issues"
            ? { issue_url: `${API}repos/${repo}/issues/${number}` }
            : { pull_request_url: `${API}repos/${repo}/pulls/${number}` }),
        }));
      });
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
    const query = new URLSearchParams(path.split("?")[1] ?? "");
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
      const page = Number(query.get("page") ?? "1");
      const events = (issueEvents.get(repo) ?? [])
        .toReversed()
        .slice((page - 1) * FEED_PAGE, page * FEED_PAGE);
      return json(request, 200, events, headers);
    }
    // Ticket 09: a repository's issue comments and review comments, oldest change first.
    const commentFeedMatch = /^repos\/([^/]+)\/([^/]+)\/(issues|pulls)\/comments$/u.exec(route);
    if (request.method === "GET" && commentFeedMatch !== null) {
      const repo = `${commentFeedMatch[1]}/${commentFeedMatch[2]}`;
      if (!repos.has(repo)) return json(request, 404, { message: "Not Found" });
      const feed = commentFeedMatch[3] as "issues" | "pulls";
      const etag = `W/"${repo}-${feed}-comments-${commentVersions.get(repo) ?? 0}-${query.toString()}"`;
      const headers: Record<string, string> = { etag };
      const interval = pollIntervals.get(repo);
      if (interval !== undefined) headers["x-poll-interval"] = String(interval);
      if (ifNoneMatch === etag) return json(request, 304, null, headers);
      const since = query.get("since");
      const perPage = Number(query.get("per_page") ?? "30");
      const page = Number(query.get("page") ?? "1");
      const ordered = feedComments(repo, feed)
        .filter((entry) => since === null || entry.updated_at >= since)
        .toSorted((a, b) =>
          a.updated_at === b.updated_at ? a.id - b.id : a.updated_at < b.updated_at ? -1 : 1,
        );
      const sorted = query.get("direction") === "desc" ? ordered.toReversed() : ordered;
      return json(request, 200, sorted.slice((page - 1) * perPage, page * perPage), headers);
    }
    const oneCommentMatch =
      /^repos\/([^/]+)\/([^/]+)\/(issues|pulls)\/comments\/(\d+)(\/reactions)?$/u.exec(route);
    if (oneCommentMatch !== null) {
      const repo = `${oneCommentMatch[1]}/${oneCommentMatch[2]}`;
      const feed = oneCommentMatch[3] as "issues" | "pulls";
      const id = Number(oneCommentMatch[4]);
      const found = feedComments(repo, feed).find((entry) => entry.id === id);
      if (found === undefined) return json(request, 404, { message: "Not Found" });
      if (request.method === "GET" && oneCommentMatch[5] === undefined) {
        return json(request, 200, found);
      }
      if (request.method === "POST" && oneCommentMatch[5] !== undefined) {
        const content = (bodyOf(request) as { readonly content?: string } | null)?.content ?? "";
        reactions.push({ repo, feed, commentId: id, content });
        return json(request, 201, { id: reactions.length, content });
      }
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
    // Ticket 12: the repository, its pull requests, a commit's CI and a job's log.
    const repoOnly = /^repos\/([^/]+)\/([^/]+)$/u.exec(route);
    if (request.method === "GET" && repoOnly !== null) {
      const repo = `${repoOnly[1]}/${repoOnly[2]}`;
      return repos.has(repo)
        ? json(request, 200, { full_name: repo, default_branch: "main" })
        : json(request, 404, { message: "Not Found" });
    }
    const pullOf = (repo: string, pr: FakePullRequest) => ({
      number: pr.number,
      title: pr.title,
      body: pr.body,
      state: pr.state,
      merged: false,
      html_url: `https://github.com/${repo}/pull/${pr.number}`,
      user: { login: pr.user.login, id: pr.user.id, type: pr.user.type ?? "User" },
      head: { ref: pr.head, sha: hooks.branchTip(repo, pr.head) ?? pr.headSha },
      base: { ref: pr.base },
    });
    const pullsMatch = /^repos\/([^/]+)\/([^/]+)\/pulls(?:\/(\d+))?$/u.exec(route);
    if (pullsMatch !== null) {
      const repo = `${pullsMatch[1]}/${pullsMatch[2]}`;
      if (!repos.has(repo)) return json(request, 404, { message: "Not Found" });
      const mine = [...pulls.entries()]
        .filter(([key]) => key.startsWith(`${repo}#`))
        .map(([, pr]) => pr);
      if (request.method === "GET" && pullsMatch[3] !== undefined) {
        const pr = pulls.get(`${repo}#${pullsMatch[3]}`);
        return pr === undefined
          ? json(request, 404, { message: "Not Found" })
          : json(request, 200, pullOf(repo, pr));
      }
      if (request.method === "GET") {
        const head = query.get("head")?.split(":")[1];
        const base = query.get("base");
        const state = query.get("state") ?? "open";
        return json(
          request,
          200,
          mine
            .filter(
              (pr) =>
                (state === "all" || pr.state === state) &&
                (head === undefined || pr.head === head) &&
                (base === null || pr.base === base),
            )
            .map((pr) => pullOf(repo, pr)),
        );
      }
      if (request.method === "POST" && pullsMatch[3] === undefined) {
        const input = (bodyOf(request) ?? {}) as {
          readonly title?: string;
          readonly body?: string;
          readonly head?: string;
          readonly base?: string;
        };
        if (mine.some((pr) => pr.state === "open" && pr.head === input.head)) {
          return json(request, 422, {
            message: "Validation Failed",
            errors: [{ message: `A pull request already exists for ${input.head}.` }],
          });
        }
        nextPullNumber += 1;
        const pr: FakePullRequest = {
          number: nextPullNumber,
          title: input.title ?? "",
          body: input.body ?? "",
          head: input.head ?? "",
          base: input.base ?? "",
          state: "open",
          user: held.user,
          headSha: "0".repeat(40),
        };
        pulls.set(`${repo}#${pr.number}`, pr);
        issues.set(`${repo}#${pr.number}`, {
          number: pr.number,
          title: pr.title,
          body: pr.body,
          user: held.user,
          state: "open",
          locked: false,
          pull: true,
        });
        return json(request, 201, pullOf(repo, pr));
      }
    }
    const ciMatch = /^repos\/([^/]+)\/([^/]+)\/commits\/([0-9a-f]+)\/(check-runs|status)$/u.exec(
      route,
    );
    if (request.method === "GET" && ciMatch !== null) {
      const known = ci.get(ciMatch[3]!) ?? { checkRuns: [], statuses: [] };
      if (ciMatch[4] === "check-runs") {
        return json(request, 200, {
          total_count: known.checkRuns.length,
          check_runs: known.checkRuns.map((run) => ({
            id: run.id,
            name: run.name,
            status: run.status,
            conclusion: run.conclusion,
            app: { slug: run.app ?? "github-actions" },
          })),
        });
      }
      const states = known.statuses.map((status) => status.state);
      return json(request, 200, {
        // GitHub answers `pending` when a commit has no status at all.
        state: states.some((state) => state === "failure" || state === "error")
          ? "failure"
          : states.every((state) => state === "success") && states.length > 0
            ? "success"
            : "pending",
        total_count: known.statuses.length,
        statuses: known.statuses,
      });
    }
    const logMatch = /^repos\/([^/]+)\/([^/]+)\/actions\/jobs\/(\d+)\/logs$/u.exec(route);
    if (request.method === "GET" && logMatch !== null) {
      const log = jobLogs.get(Number(logMatch[3]));
      return log === undefined
        ? json(request, 404, { message: "Not Found" })
        : HttpClientResponse.fromWeb(
            request,
            new Response(log, { status: 200, headers: { "content-type": "text/plain" } }),
          );
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
    reviewComments,
    reactions,
    clock,
    pulls,
    ci,
    jobLogs,
    hooks,
    addEvent,
    label,
    comment,
    commentOn,
    reviewComment,
    editComment,
    assign,
    /** The comments a login wrote on an issue, as they read on GitHub. */
    commentsBy: (repo: string, number: number, login: string) =>
      (comments.get(`${repo}#${number}`) ?? [])
        .filter((entry) => entry.user.login === login)
        .map((entry) => entry.body),
  };
};

export type FakeGitHub = ReturnType<typeof makeFakeGitHub>;
