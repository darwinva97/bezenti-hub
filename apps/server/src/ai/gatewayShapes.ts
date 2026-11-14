/**
 * The AI gateway's wire (spec 4 ticket 04), pure: the `/api/ai/*` paths, where keys and models
 * travel, how a request is pinned to an account, which headers cross, errors in each client's
 * shape, and the tap a streamed answer goes through.
 */
import {
  AI_GATEWAY_KEY_PREFIX,
  AI_GATEWAY_ROUTE_PREFIX,
  type AiAccountId,
  type AiAccountProvider,
  aiAccountPrefixOf,
} from "@t3tools/contracts";

import { filterGatewayLine } from "./gatewayLogFilter.ts";

export type GatewayShape = "openai" | "anthropic" | "gemini";

/** What a path of `/api/ai/*` is: a model list the Hub answers itself, or a call it proxies. */
export type GatewayRoute =
  | { readonly _tag: "models"; readonly shape: GatewayShape; readonly route: string }
  | {
      readonly _tag: "proxy";
      readonly shape: GatewayShape;
      /** The path as logged: fixed, never the client's (a Gemini model goes in `model`). */
      readonly route: string;
      /** CLIProxyAPI's path for one account's model. */
      readonly upstreamPath: (upstreamModel: string) => string;
      /** Gemini names its model in the path; the others in the body's `model`. */
      readonly pathModel: string | undefined;
      /** Whether the client asked for a stream by the route itself (Gemini). */
      readonly streams: boolean;
    }
  | { readonly _tag: "not-found"; readonly shape: GatewayShape }
  | { readonly _tag: "method-not-allowed"; readonly shape: GatewayShape };

const BODY_ROUTES: Readonly<Record<string, { shape: GatewayShape; upstream: string }>> = {
  "/openai/v1/chat/completions": { shape: "openai", upstream: "/v1/chat/completions" },
  "/openai/v1/responses": { shape: "openai", upstream: "/v1/responses" },
  "/anthropic/v1/messages": { shape: "anthropic", upstream: "/v1/messages" },
  "/anthropic/v1/messages/count_tokens": {
    shape: "anthropic",
    upstream: "/v1/messages/count_tokens",
  },
};

const MODEL_ROUTES: Readonly<Record<string, GatewayShape>> = {
  "/openai/v1/models": "openai",
  "/anthropic/v1/models": "anthropic",
  "/gemini/v1beta/models": "gemini",
};

/** A Gemini model in the path: a plain name, never a prefix, an encoding or a dot segment. */
const GEMINI_CALL =
  /^\/gemini\/v1beta\/models\/([A-Za-z0-9][A-Za-z0-9._-]{0,127}):(generateContent|streamGenerateContent)$/u;

const shapeOfPath = (rest: string): GatewayShape =>
  rest.startsWith("/anthropic/") ? "anthropic" : rest.startsWith("/gemini/") ? "gemini" : "openai";

/**
 * The route of `method pathname`. Only the paths listed here exist: anything else under
 * `/api/ai/` (CLIProxyAPI's management API, its other routes, a dot segment, an encoded slash)
 * is not found, and nothing but these fixed upstream paths is ever asked of CLIProxyAPI.
 */
export const matchGatewayRoute = (method: string, pathname: string): GatewayRoute => {
  const rest = pathname.startsWith(`${AI_GATEWAY_ROUTE_PREFIX}/`)
    ? pathname.slice(AI_GATEWAY_ROUTE_PREFIX.length)
    : "";
  const shape = shapeOfPath(rest);
  const models = MODEL_ROUTES[rest];
  if (models !== undefined) {
    return method === "GET"
      ? { _tag: "models", shape: models, route: `${AI_GATEWAY_ROUTE_PREFIX}${rest}` }
      : { _tag: "method-not-allowed", shape: models };
  }
  const body = BODY_ROUTES[rest];
  if (body !== undefined) {
    if (method !== "POST") return { _tag: "method-not-allowed", shape: body.shape };
    return {
      _tag: "proxy",
      shape: body.shape,
      route: `${AI_GATEWAY_ROUTE_PREFIX}${rest}`,
      upstreamPath: () => body.upstream,
      pathModel: undefined,
      streams: false,
    };
  }
  const gemini = GEMINI_CALL.exec(rest);
  if (gemini !== null) {
    if (method !== "POST") return { _tag: "method-not-allowed", shape: "gemini" };
    const action = gemini[2]!;
    return {
      _tag: "proxy",
      shape: "gemini",
      route: `${AI_GATEWAY_ROUTE_PREFIX}/gemini/v1beta/models/{model}:${action}`,
      upstreamPath: (upstreamModel) => `/v1beta/models/${upstreamModel}:${action}`,
      pathModel: gemini[1]!,
      streams: action === "streamGenerateContent",
    };
  }
  return { _tag: "not-found", shape };
};

/** A request's path and query, or undefined when it is not a URL. */
export const parseRequestPath = (target: string): URL | undefined => {
  try {
    return new URL(target, "http://hub.invalid");
  } catch {
    return undefined;
  }
};

/** JSON text parsed, or undefined. */
export const parseJsonText = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

/** A request body that is a JSON object, or undefined. */
export const parseJsonObject = (bytes: Uint8Array): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

/** Where each shape's clients send their key: a Bearer always, and the shape's own header. */
const KEY_HEADERS: Readonly<Record<GatewayShape, ReadonlyArray<string>>> = {
  openai: [],
  anthropic: ["x-api-key"],
  gemini: ["x-goog-api-key"],
};

export type GatewayKeyLookup =
  | { readonly _tag: "key"; readonly key: string }
  | { readonly _tag: "missing" }
  | { readonly _tag: "ambiguous" };

/**
 * The gateway key a request carries, by its shape's headers only (never a cookie, a query
 * parameter or another credential). Two different keys are refused, not chosen between.
 */
export const gatewayKeyOf = (
  shape: GatewayShape,
  headers: Readonly<Record<string, string | undefined>>,
): GatewayKeyLookup => {
  const found = new Set<string>();
  const authorization = headers.authorization;
  if (authorization !== undefined) {
    const bearer = /^bearer\s+(\S+)\s*$/iu.exec(authorization)?.[1];
    // Something else in Authorization (Basic, an Environment credential) is not a gateway key.
    found.add(bearer ?? "");
  }
  for (const name of KEY_HEADERS[shape]) {
    const value = headers[name]?.trim();
    if (value !== undefined) found.add(value);
  }
  if (found.size === 0) return { _tag: "missing" };
  if (found.size > 1) return { _tag: "ambiguous" };
  const key = [...found][0]!;
  return key.length === 0 ? { _tag: "missing" } : { _tag: "key", key };
};

/** A key of the right form: `t3gk_` and 43 base64url characters (32 bytes). */
export const isGatewayKeyShaped = (key: string) =>
  key.length === AI_GATEWAY_KEY_PREFIX.length + 43 &&
  key.startsWith(AI_GATEWAY_KEY_PREFIX) &&
  /^[A-Za-z0-9_-]+$/u.test(key.slice(AI_GATEWAY_KEY_PREFIX.length));

/** The model a client asked for: a plain name, or one pinned to an AI account by its prefix. */
export type RequestedModel =
  | { readonly _tag: "plain"; readonly model: string }
  | { readonly _tag: "pinned"; readonly accountId: string; readonly model: string }
  | { readonly _tag: "invalid"; readonly message: string };

const ACCOUNT_PREFIX = /^acct-([^/]+)\/(.+)$/iu;
const MAX_MODEL_LENGTH = 256;

export const parseRequestedModel = (raw: unknown): RequestedModel => {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { _tag: "invalid", message: "Name a model." };
  }
  if (raw.length > MAX_MODEL_LENGTH || /[\s\u0000-\u001f]/u.test(raw)) {
    return { _tag: "invalid", message: "That model name is not valid." };
  }
  const pinned = ACCOUNT_PREFIX.exec(raw);
  if (pinned !== null) {
    const model = pinned[2]!;
    // One prefix only: `acct-a/acct-b/m` would let CLIProxyAPI read the second one.
    if (/^acct-/iu.test(model))
      return { _tag: "invalid", message: "That model name is not valid." };
    return { _tag: "pinned", accountId: pinned[1]!, model };
  }
  if (/^acct-/iu.test(raw)) return { _tag: "invalid", message: "That model name is not valid." };
  return { _tag: "plain", model: raw };
};

/**
 * The upstream body for each account: written once with a marker for the model, so a failover
 * only fills in another model instead of encoding the whole body again.
 */
export const bodyTemplate = (json: Record<string, unknown>) => {
  const marker = "\u0000t3-gateway-model\u0000";
  const [before, after] = JSON.stringify({ ...json, model: marker }).split(JSON.stringify(marker));
  return (upstreamModel: string) =>
    Buffer.from(`${before}${JSON.stringify(upstreamModel)}${after}`, "utf8");
};

const asSystem = (items: unknown) =>
  Array.isArray(items)
    ? items.map((item: unknown) =>
        typeof item === "object" &&
        item !== null &&
        (item as { readonly role?: unknown }).role === "developer"
          ? { ...item, role: "system" }
          : item,
      )
    : items;

/**
 * An OpenAI body for an OpenAI-compatible upstream (DeepSeek, OpenRouter…): OpenAI's `developer`
 * role as `system`. Those upstreams know the Chat Completions roles only and refuse `developer`,
 * which Codex sends; CLIProxyAPI passes the role through. Chat `messages` and Responses `input`.
 */
export const systemForDeveloper = (json: Record<string, unknown>): Record<string, unknown> => ({
  ...json,
  ...(Array.isArray(json.messages) ? { messages: asSystem(json.messages) } : {}),
  ...(Array.isArray(json.input) ? { input: asSystem(json.input) } : {}),
});

/** What CLIProxyAPI is asked for: always one account's prefix, never the client's own text. */
export const upstreamModelOf = (accountId: AiAccountId, model: string) =>
  `${aiAccountPrefixOf(accountId)}/${model}`;

/** A Thread whose own AI account is not allowed in its Space now: every route says this. */
export const CHOSEN_NOT_ALLOWED =
  "This Thread's AI account is no longer allowed here. Switch AI account.";

/** An AI account a request may go to, first to last by the Installation's priority. */
export interface RoutableAccount {
  readonly id: AiAccountId;
  readonly name: string;
  readonly provider: AiAccountProvider;
}

export type RoutePlan =
  | {
      readonly _tag: "route";
      readonly model: string;
      /** The account to try first, then the failovers: same provider, same model, allowed. */
      readonly candidates: ReadonlyArray<RoutableAccount>;
    }
  | { readonly _tag: "refused"; readonly status: 400 | 403 | 404; readonly message: string };

/**
 * The allowed accounts for this request, in order: the pinned one, else the Thread's, else the
 * first allowed that serves the model; then failovers of that provider serving the same model, by
 * global priority. Never another provider, never an account outside `allowed` (decisions 5, 7, 8).
 */
export const planRoute = (input: {
  readonly allowed: ReadonlyArray<RoutableAccount>;
  readonly chosenAccountId: string | null;
  /** A Thread key routes only to its Thread's account; a User key may pin any allowed one. */
  readonly keyKind: "thread" | "user";
  readonly requested: RequestedModel;
  readonly serves: (accountId: AiAccountId, model: string) => boolean;
}): RoutePlan => {
  const { allowed, requested, serves } = input;
  if (requested._tag === "invalid") {
    return { _tag: "refused", status: 400, message: requested.message };
  }
  const model = requested.model;
  let first: RoutableAccount | undefined;
  if (requested._tag === "pinned" && input.keyKind === "thread") {
    // An agent never moves its Thread to another account by naming it (a prompt could ask it to).
    if (requested.accountId !== input.chosenAccountId) {
      return {
        _tag: "refused",
        status: 403,
        message: "This Thread uses its own AI account; switch AI account in the Thread.",
      };
    }
  }
  if (requested._tag === "pinned") {
    first = allowed.find((account) => account.id === requested.accountId);
    if (first === undefined) {
      return {
        _tag: "refused",
        status: 403,
        message: "That AI account is not allowed to you in this Space.",
      };
    }
  } else if (input.chosenAccountId !== null) {
    first = allowed.find((account) => account.id === input.chosenAccountId);
    if (first === undefined) {
      return {
        _tag: "refused",
        status: 403,
        message: CHOSEN_NOT_ALLOWED,
      };
    }
  } else {
    first = allowed.find((account) => serves(account.id, model));
    if (first === undefined) {
      return {
        _tag: "refused",
        status: 404,
        message: `No AI account allowed to you in this Space serves ${model}.`,
      };
    }
  }
  if (!serves(first.id, model)) {
    return { _tag: "refused", status: 404, message: `${first.name} does not serve ${model}.` };
  }
  const primary = first;
  const failovers = allowed.filter(
    (account) =>
      account.id !== primary.id &&
      account.provider === primary.provider &&
      serves(account.id, model),
  );
  return { _tag: "route", model, candidates: [primary, ...failovers] };
};

/** Request headers that reach CLIProxyAPI besides the Hub's own; everything else is dropped. */
export const FORWARDED_REQUEST_HEADERS: ReadonlyArray<string> = [
  "accept",
  "anthropic-version",
  "anthropic-beta",
  "user-agent",
];

/** A model list in the client's shape, plain names only (never another account's prefix). */
export const modelListBody = (shape: GatewayShape, models: ReadonlyArray<string>) => {
  const sorted = [...new Set(models)].toSorted();
  switch (shape) {
    case "openai":
      return {
        object: "list",
        data: sorted.map((id) => ({ id, object: "model", created: 0, owned_by: "t3code" })),
      };
    case "anthropic":
      return {
        data: sorted.map((id) => ({
          type: "model",
          id,
          display_name: id,
          created_at: "1970-01-01T00:00:00Z",
        })),
        has_more: false,
        first_id: sorted[0] ?? null,
        last_id: sorted.at(-1) ?? null,
      };
    case "gemini":
      return {
        models: sorted.map((id) => ({
          name: `models/${id}`,
          displayName: id,
          supportedGenerationMethods: ["generateContent", "streamGenerateContent"],
        })),
      };
  }
};

const anthropicErrorType = (status: number) =>
  status === 400
    ? "invalid_request_error"
    : status === 401
      ? "authentication_error"
      : status === 403
        ? "permission_error"
        : status === 404
          ? "not_found_error"
          : status === 413
            ? "request_too_large"
            : status === 429
              ? "rate_limit_error"
              : "api_error";

const googleStatus = (status: number) =>
  status === 400
    ? "INVALID_ARGUMENT"
    : status === 401
      ? "UNAUTHENTICATED"
      : status === 403
        ? "PERMISSION_DENIED"
        : status === 404
          ? "NOT_FOUND"
          : status === 429
            ? "RESOURCE_EXHAUSTED"
            : "INTERNAL";

const openaiErrorType = (status: number) =>
  status === 401
    ? "authentication_error"
    : status === 403
      ? "permission_error"
      : status === 429
        ? "rate_limit_error"
        : status >= 500
          ? "server_error"
          : "invalid_request_error";

/** An error as the client's own SDK expects it. */
export const errorBody = (shape: GatewayShape, status: number, message: string) => {
  switch (shape) {
    case "openai":
      return { error: { message, type: openaiErrorType(status), code: null } };
    case "anthropic":
      return { type: "error", error: { type: anthropicErrorType(status), message } };
    case "gemini":
      return { error: { code: status, message, status: googleStatus(status) } };
  }
};

/** The words a client sees when every allowed account of the provider is out of quota. */
export const noQuotaMessage = (provider: string) =>
  `No allowed AI account for ${provider} has quota left; switch AI account.`;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu;
const URL_TEXT = /\bhttps?:\/\/[^\s"'<>]+/giu;
const ANY_ACCOUNT_PREFIX = /\bacct-[A-Za-z0-9_-]+\//giu;

/**
 * Upstream words made safe for a client: no credential, token, email, address or account prefix
 * (filterGatewayLine, plus emails, URLs and `acct-…/`), at most 400 characters.
 */
export const sanitizeUpstreamText = (text: string, secrets: ReadonlyArray<string> = []) =>
  filterGatewayLine(
    text.replace(EMAIL, "[redacted]").replace(URL_TEXT, "[url]").replace(ANY_ACCOUNT_PREFIX, ""),
    secrets,
  );

/**
 * The message of an upstream error body, made safe: the provider's own words for a request it
 * could not take (4xx but auth and quota), else a fixed sentence that names no account.
 */
export const upstreamErrorMessage = (status: number, body: string) => {
  if (status === 401 || status === 403) {
    return "The AI account could not serve this request. Ask the Owner to check it.";
  }
  if (status === 429) return "The AI account is out of quota or rate limited.";
  if (status >= 500 || status < 400) return `The AI gateway failed (HTTP ${status}).`;
  let message: unknown;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const error = parsed.error as Record<string, unknown> | string | undefined;
    message =
      typeof error === "string"
        ? error
        : typeof error?.message === "string"
          ? error.message
          : parsed.message;
  } catch {
    message = undefined;
  }
  return typeof message === "string" && message.trim().length > 0
    ? sanitizeUpstreamText(message)
    : `The request was refused (HTTP ${status}).`;
};

/** Tokens of one request, as far as its answer said; null where it said nothing. */
export interface GatewayUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
}

export const EMPTY_USAGE: GatewayUsage = {
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
};

const numberAt = (value: unknown, ...path: ReadonlyArray<string>): number | null => {
  let at: unknown = value;
  for (const key of path) {
    if (at === null || typeof at !== "object") return null;
    at = (at as Record<string, unknown>)[key];
  }
  // Counts are whole and safe; anything else (a fraction, 1e300) is unknown, not stored.
  return typeof at === "number" && Number.isSafeInteger(at) && at >= 0 ? at : null;
};

const larger = (a: number | null, b: number | null) =>
  a === null ? b : b === null ? a : Math.max(a, b);

/**
 * Merges what one JSON value (a whole answer, or one SSE event) says about tokens: OpenAI chat and
 * responses, Claude messages (start and delta), Gemini `usageMetadata`. Counts only grow.
 */
export const mergeUsage = (usage: GatewayUsage, value: unknown): GatewayUsage => {
  if (value === null || typeof value !== "object") return usage;
  const record = value as Record<string, unknown>;
  const sources = [
    record.usage,
    (record.response as Record<string, unknown> | undefined)?.usage,
    (record.message as Record<string, unknown> | undefined)?.usage,
  ];
  let next = usage;
  for (const source of sources) {
    if (source === null || typeof source !== "object") continue;
    next = {
      inputTokens: larger(
        next.inputTokens,
        numberAt(source, "prompt_tokens") ?? numberAt(source, "input_tokens"),
      ),
      outputTokens: larger(
        next.outputTokens,
        numberAt(source, "completion_tokens") ?? numberAt(source, "output_tokens"),
      ),
      cacheReadTokens: larger(
        next.cacheReadTokens,
        numberAt(source, "cache_read_input_tokens") ??
          numberAt(source, "prompt_tokens_details", "cached_tokens") ??
          numberAt(source, "input_tokens_details", "cached_tokens"),
      ),
      cacheWriteTokens: larger(
        next.cacheWriteTokens,
        numberAt(source, "cache_creation_input_tokens"),
      ),
    };
  }
  const gemini = record.usageMetadata;
  if (gemini !== null && typeof gemini === "object") {
    next = {
      inputTokens: larger(next.inputTokens, numberAt(gemini, "promptTokenCount")),
      outputTokens: larger(next.outputTokens, numberAt(gemini, "candidatesTokenCount")),
      cacheReadTokens: larger(next.cacheReadTokens, numberAt(gemini, "cachedContentTokenCount")),
      cacheWriteTokens: next.cacheWriteTokens,
    };
  }
  return next;
};
