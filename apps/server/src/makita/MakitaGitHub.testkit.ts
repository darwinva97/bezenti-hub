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
}

const API = "https://api.github.com/";

export const makeFakeGitHub = () => {
  const tokens = new Map<string, FakeGitHubToken>();
  const users = new Map<string, FakeGitHubUser>();
  /** `owner/name` → its labels. A repository not here answers 404. */
  const repos = new Map<string, Set<string>>();
  /** Repositories where creating a label is refused (403). */
  const labelsRefused = new Set<string>();
  const requests: Array<FakeGitHubRequest> = [];
  const state = { down: false, rateLimited: false };

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
    requests.push({ method: request.method, path, body: bodyOf(request), signed: !!held });
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
  };
};

export type FakeGitHub = ReturnType<typeof makeFakeGitHub>;
