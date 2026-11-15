import {
  AuthAccessWriteScope,
  type AuthMcpApprovalDecision,
  type AuthMcpAuthorizationRequest,
  type AuthMcpAuthorizationServerMetadata,
  type AuthMcpClientRegistration,
  type AuthMcpProtectedResourceMetadata,
  AuthMcpRegistrationError,
  AuthMcpTokenError,
  type AuthMcpTokenRequest,
  type AuthMcpTokenResult,
  type AuthMcpClientAccess,
  type AuthEnvironmentScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  mcpClientScopes,
  withoutInstallationScopes,
  type RuntimeMode,
  type UserId,
} from "@t3tools/contracts";
import { hubLinkOrigin } from "@t3tools/shared/threadLinks";
import { encodeOAuthScope } from "@t3tools/shared/oauthScope";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as Schema from "effect/Schema";
import { HttpServerRequest } from "effect/http";

import { PublicHubUrl } from "../environment/PublicHubUrl.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as PayloadSigner from "./PayloadSigner.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as UserDirectory from "./UserDirectory.ts";
import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  deriveAuthClientMetadata,
  timingSafeEqualBase64Url,
} from "./utils.ts";
import { requestUrl } from "../requestUrl.ts";
import * as AuditLog from "../audit/AuditLog.ts";

// Request-derived origins support loopback, Tailscale and tunnels.
// Signed client metadata keeps unauthenticated registration stateless.

const SIGNING_SECRET_NAME = "mcp-oauth-signing-key";
const AUTHORIZATION_CODE_TTL_MS = 60_000;
const MAX_CLIENT_NAME_LENGTH = 100;
const MAX_REDIRECT_URIS = 5;
const MAX_REDIRECT_URI_LENGTH = 512;
const DEFAULT_CLIENT_NAME = "MCP client";
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
const CODE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

const MCP_OAUTH_SCOPES = [AuthOrchestrationReadScope, AuthOrchestrationOperateScope];

export interface McpOAuthUrls {
  readonly issuer: string;
  readonly resource: string;
}

export const requestUrls = (request: HttpServerRequest.HttpServerRequest): McpOAuthUrls => {
  const origin = Option.match(requestUrl(request), {
    onNone: () => "http://localhost",
    onSome: (url) => url.origin,
  });
  return { issuer: origin, resource: `${origin}/mcp` };
};

export const protectedResourceMetadata = (
  urls: McpOAuthUrls,
): AuthMcpProtectedResourceMetadata => ({
  resource: urls.resource,
  authorization_servers: [urls.issuer],
  scopes_supported: MCP_OAUTH_SCOPES,
  bearer_methods_supported: ["header"],
  resource_name: "T3 Code",
});

export const authorizationServerMetadata = (
  urls: McpOAuthUrls,
): AuthMcpAuthorizationServerMetadata => ({
  issuer: urls.issuer,
  authorization_endpoint: `${urls.issuer}/oauth/mcp/authorize`,
  token_endpoint: `${urls.issuer}/oauth/mcp/token`,
  registration_endpoint: `${urls.issuer}/oauth/mcp/register`,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
  scopes_supported: MCP_OAUTH_SCOPES,
  authorization_response_iss_parameter_supported: true,
});

const parseRedirect = (value: string): URL | undefined => {
  // URL.hash misses empty fragments, which RFC 6749 §3.1.2 also forbids.
  if (value.length > MAX_REDIRECT_URI_LENGTH || value.includes("#")) return undefined;
  try {
    const url = new URL(value);
    const allowed =
      url.protocol === "https:" ||
      (url.protocol === "http:" && LOOPBACK_HOSTNAMES.has(url.hostname));
    return allowed && url.username === "" && url.password === "" ? url : undefined;
  } catch {
    return undefined;
  }
};

/** Loopback redirects ignore port (RFC 8252 §7.3); HTTPS redirects match exactly. */
export const redirectMatches = (registered: string, presented: string): boolean => {
  const left = parseRedirect(registered);
  const right = parseRedirect(presented);
  if (left === undefined || right === undefined) return false;
  if (left.protocol === "https:" || right.protocol === "https:") return left.href === right.href;
  return (
    left.hostname === right.hostname &&
    left.pathname === right.pathname &&
    left.search === right.search
  );
};

const sameResource = (urls: McpOAuthUrls, presented: string | undefined): boolean => {
  if (presented === undefined) return true;
  // URL.hash misses empty fragments, which RFC 8707 §2 also forbids.
  if (presented.includes("#")) return false;
  try {
    const url = new URL(presented);
    return `${url.origin}${url.pathname.replace(/\/+$/u, "")}` === urls.resource;
  } catch {
    return false;
  }
};

const ClientIdPayload = Schema.Struct({
  v: Schema.Literal(1),
  n: Schema.String,
  r: Schema.Array(Schema.String),
  /** Registered as a Peer Link, before they were removed: such a client id is refused. */
  p: Schema.optionalKey(Schema.Literal(1)),
});

/** What a linking server registered with; Peer Links were removed, so it is refused. */
const RETIRED_PEER_LINK_SOFTWARE_ID = "t3code-peer-link";
const decodeClientIdPayload = Schema.decodeUnknownOption(Schema.fromJsonString(ClientIdPayload));

export interface McpOAuthClient {
  readonly clientId: string;
  readonly name: string;
  readonly redirectUris: ReadonlyArray<string>;
}

export class McpOAuthPageError extends Schema.TaggedError<McpOAuthPageError>()(
  "McpOAuthPageError",
  { description: Schema.String },
) {
  override get message(): string {
    return this.description;
  }
}

export class McpOAuthRedirectError extends Schema.TaggedError<McpOAuthRedirectError>()(
  "McpOAuthRedirectError",
  {
    error: Schema.Literals(["invalid_request", "unsupported_response_type", "invalid_target"]),
    description: Schema.String,
    redirectUri: Schema.String,
    state: Schema.optional(Schema.RedactedFromValue(Schema.String)),
  },
) {}

export interface AuthorizationRequest {
  readonly client: McpOAuthClient;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly state: Redacted.Redacted<string> | undefined;
  readonly resource: string;
  readonly issuer: string;
}

interface PendingCode {
  readonly clientId: string;
  readonly clientName: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly resource: string;
  readonly access: AuthMcpClientAccess;
  /** Who approved it, and so whom the issued client acts as. */
  readonly userId: UserId | undefined;
  readonly expiresAtMs: number;
}

/** The signed-in User approving on the consent page; the client will act as them. */
export interface ApprovingSession {
  readonly csrfToken: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly userId: UserId | undefined;
}

export type ApprovalDecision = Exclude<AuthMcpApprovalDecision, { readonly _tag: "deny" }>;

export class McpOAuth extends Context.Service<
  McpOAuth,
  {
    readonly register: (
      input: AuthMcpClientRegistration,
    ) => Effect.Effect<McpOAuthClient, AuthMcpRegistrationError>;
    /** Page errors must never redirect. */
    readonly validateAuthorization: (input: {
      readonly urls: McpOAuthUrls;
      readonly request: AuthMcpAuthorizationRequest;
    }) => Effect.Effect<AuthorizationRequest, McpOAuthPageError | McpOAuthRedirectError>;
    readonly approvingBrowserSession: (
      request: HttpServerRequest.HttpServerRequest,
      authorization: AuthorizationRequest,
    ) => Effect.Effect<ApprovingSession | undefined>;
    /**
     * The name of the User this browser is signed in as, whether or not the session may approve,
     * so the page can say who approves or why it cannot. None when signed out or unreadable.
     */
    readonly signedInName: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<string | undefined>;
    readonly approve: (input: {
      readonly request: HttpServerRequest.HttpServerRequest;
      readonly authorization: AuthorizationRequest;
      readonly decision: ApprovalDecision;
    }) => Effect.Effect<string, EnvironmentAuth.ServerAuthMcpApprovalCodeError | McpOAuthPageError>;
    readonly deny: (authorization: AuthorizationRequest) => string;
    /** A managed policy's runtime-mode ceiling, shown on the approval page. */
    readonly runtimeModeCeiling:
      | { readonly organization: string; readonly maxRuntimeMode: RuntimeMode }
      | undefined;
    readonly exchangeCode: (input: {
      readonly request: HttpServerRequest.HttpServerRequest;
      readonly urls: McpOAuthUrls;
      readonly token: AuthMcpTokenRequest;
    }) => Effect.Effect<AuthMcpTokenResult, AuthMcpTokenError>;
  }
>()("t3/auth/McpOAuth") {}

const redirectWith = (
  redirectUri: string,
  params: Record<string, string | Redacted.Redacted<string> | undefined>,
) => {
  const url = new URL(redirectUri);
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) {
      url.searchParams.set(name, Redacted.isRedacted(value) ? Redacted.value(value) : value);
    }
  }
  return url.toString();
};

export const redirectForError = (error: McpOAuthRedirectError, issuer: string) =>
  redirectWith(error.redirectUri, {
    error: error.error,
    error_description: error.description,
    state: error.state,
    iss: issuer,
  });

const make = Effect.gen(function* () {
  const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const userDirectory = yield* UserDirectory.UserDirectory;
  const audit = yield* AuditLog.AuditLog;
  const sql = yield* SqlClient.SqlClient;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const random = yield* SecureRandom.SecureRandom;
  const digester = yield* Digest.Digest;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const signer = yield* PayloadSigner.fromSecret(
    yield* secretStore.getOrCreateRandom(SIGNING_SECRET_NAME, 32).pipe(Effect.orDie),
  );
  const codes = yield* Ref.make<ReadonlyMap<string, PendingCode>>(new Map());

  const sign = (domain: string, payload: string) => signer.sign(`${domain}.${payload}`);

  const signClientId = (name: string, redirectUris: ReadonlyArray<string>) => {
    const body = base64UrlEncode(JSON.stringify({ v: 1, n: name, r: redirectUris }));
    return sign("mcp-client-id", body).pipe(Effect.map((signature) => `${body}.${signature}`));
  };

  // Untraced: only called inside the traced McpOAuth methods below.
  const parseClientId = Effect.fnUntraced(function* (
    clientId: string,
  ): Effect.fn.Return<McpOAuthClient | undefined> {
    const [body, signature, extra] = clientId.split(".");
    if (!body || !signature || extra !== undefined) return undefined;
    const verified = yield* signer.verify(`mcp-client-id.${body}`, signature);
    if (!verified) return undefined;
    const json = yield* Effect.try(() => base64UrlDecodeUtf8(body)).pipe(Effect.option);
    if (Option.isNone(json)) return undefined;
    return Option.getOrUndefined(
      decodeClientIdPayload(json.value).pipe(
        Option.filter((payload) => payload.p === undefined),
        Option.map((payload) => ({
          clientId,
          name: payload.n,
          redirectUris: payload.r,
        })),
      ),
    );
  });

  const pkceVerifies = (verifier: string, challenge: string) =>
    CODE_VERIFIER_PATTERN.test(verifier)
      ? digester.digest(Digest.sha256, new TextEncoder().encode(verifier)).pipe(
          Effect.orDie,
          Effect.map((digest) => timingSafeEqualBase64Url(base64UrlEncode(digest), challenge)),
        )
      : Effect.succeed(false);

  const csrfToken = (sessionId: string, authorization: AuthorizationRequest) =>
    sign(
      "mcp-csrf",
      JSON.stringify([
        sessionId,
        authorization.client.clientId,
        authorization.redirectUri,
        authorization.codeChallenge,
      ]),
    );

  const register: McpOAuth["Service"]["register"] = Effect.fn("McpOAuth.register")(
    function* (metadata) {
      const rawName = metadata.client_name?.trim() ?? "";
      const name = (rawName.length > 0 ? rawName : DEFAULT_CLIENT_NAME).slice(
        0,
        MAX_CLIENT_NAME_LENGTH,
      );
      const redirectUris = metadata.redirect_uris ?? [];
      if (redirectUris.length === 0 || redirectUris.length > MAX_REDIRECT_URIS) {
        return yield* new AuthMcpRegistrationError({
          error: "invalid_redirect_uri",
          error_description: `Register between 1 and ${MAX_REDIRECT_URIS} redirect URIs.`,
        });
      }
      if (!redirectUris.every((uri) => parseRedirect(uri) !== undefined)) {
        return yield* new AuthMcpRegistrationError({
          error: "invalid_redirect_uri",
          error_description:
            "Redirect URIs must be https, or http on localhost, 127.0.0.1 or [::1].",
        });
      }
      if (metadata.software_id === RETIRED_PEER_LINK_SOFTWARE_ID) {
        return yield* new AuthMcpRegistrationError({
          error: "invalid_client_metadata",
          error_description:
            "Peer Links were removed: servers reach each other only through their Hub.",
        });
      }
      // RFC 7591 allows ignoring unsupported registration options; all clients use public PKCE.
      return {
        clientId: yield* signClientId(name, redirectUris),
        name,
        redirectUris,
      };
    },
  );

  const validateAuthorization: McpOAuth["Service"]["validateAuthorization"] = Effect.fn(
    "McpOAuth.validateAuthorization",
  )(function* ({ urls, request }) {
    const client = yield* parseClientId(request.client_id ?? "");
    if (client === undefined) {
      return yield* new McpOAuthPageError({
        description: "This sign-in link names an unknown app. Start the sign-in again from it.",
      });
    }
    const redirectUri = request.redirect_uri;
    if (
      redirectUri === undefined ||
      !client.redirectUris.some((registered) => redirectMatches(registered, redirectUri))
    ) {
      return yield* new McpOAuthPageError({
        description: "This sign-in link sends you to an address the app did not register.",
      });
    }
    const state = request.state;
    const fail = (error: McpOAuthRedirectError["error"], description: string) =>
      new McpOAuthRedirectError({
        error,
        description,
        redirectUri,
        ...(state === undefined ? {} : { state }),
      });
    if (request.response_type !== "code") {
      return yield* fail("unsupported_response_type", "Only response_type=code is supported.");
    }
    const codeChallenge = request.code_challenge;
    if (
      request.code_challenge_method !== "S256" ||
      codeChallenge === undefined ||
      !CODE_CHALLENGE_PATTERN.test(codeChallenge)
    ) {
      return yield* fail("invalid_request", "PKCE with code_challenge_method=S256 is required.");
    }
    if (!sameResource(urls, request.resource)) {
      return yield* fail("invalid_target", `This server only issues tokens for ${urls.resource}.`);
    }
    return {
      client,
      redirectUri,
      codeChallenge,
      state,
      resource: urls.resource,
      issuer: urls.issuer,
    } satisfies AuthorizationRequest;
  });

  const approvingBrowserSession: McpOAuth["Service"]["approvingBrowserSession"] = (
    request,
    authorization,
  ) =>
    environmentAuth.authenticateBrowserSession(request).pipe(
      Effect.flatMap((session) =>
        // Approving manages access, and a session may only hand out scopes it holds.
        session.scopes.includes(AuthAccessWriteScope) &&
        session.scopes.includes(AuthOrchestrationReadScope)
          ? csrfToken(session.sessionId, authorization).pipe(
              Effect.map((token): ApprovingSession => ({
                csrfToken: token,
                scopes: session.scopes,
                userId: session.userId,
              })),
            )
          : Effect.undefined,
      ),
      Effect.orElseSucceed(() => undefined),
    );

  const signedInUser = (request: HttpServerRequest.HttpServerRequest) =>
    environmentAuth.authenticateBrowserSession(request).pipe(
      Effect.map((session) => session.userId),
      Effect.orElseSucceed(() => undefined),
    );

  const signedInName: McpOAuth["Service"]["signedInName"] = (request) =>
    signedInUser(request).pipe(
      Effect.flatMap((userId) =>
        userId === undefined
          ? Effect.undefined
          : userDirectory
              .findUser(userId)
              .pipe(Effect.map((user) => Option.getOrUndefined(user)?.displayName)),
      ),
      // Only a label: a failed read leaves it out rather than refusing the page.
      Effect.orElseSucceed(() => undefined),
    );

  const mintCode = Effect.fn("McpOAuth.mintCode")(function* (
    authorization: AuthorizationRequest,
    access: AuthMcpClientAccess,
    userId: UserId | undefined,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const code = Buffer.from(yield* random.randomBytes(32)).toString("base64url");
    yield* Ref.update(codes, (current) => {
      const next = new Map(Array.from(current).filter(([, pending]) => pending.expiresAtMs > now));
      next.set(code, {
        clientId: authorization.client.clientId,
        clientName: authorization.client.name,
        redirectUri: authorization.redirectUri,
        codeChallenge: authorization.codeChallenge,
        resource: authorization.resource,
        access,
        userId,
        expiresAtMs: now + AUTHORIZATION_CODE_TTL_MS,
      });
      return next;
    });
    return code;
  });

  const approve: McpOAuth["Service"]["approve"] = Effect.fn("McpOAuth.approve")(function* (input) {
    const { decision } = input;
    const notRecorded = (cause: unknown) =>
      Effect.logError("Could not record an MCP client approval.", { cause }).pipe(
        Effect.andThen(
          Effect.fail(
            new McpOAuthPageError({ description: "The approval could not be saved. Try again." }),
          ),
        ),
      );
    // Once an Owner exists every approver is a User; never fall back to the Owner silently.
    const requireNamed = Effect.fn("McpOAuth.requireNamed")(function* (
      approver: UserId | undefined,
    ) {
      if (approver !== undefined) return;
      const hasOwner = yield* userDirectory.hasOwner().pipe(Effect.orElseSucceed(() => true));
      if (hasOwner)
        return yield* new McpOAuthPageError({
          description: "This approval names no account. Sign in and try again.",
        });
    });
    // Before an Owner exists the approval names nobody; it is recorded against the client.
    const recordApproval = (approver: UserId | undefined) =>
      audit.record({
        actor: approver === undefined ? { source: "system" } : AuditLog.userActor(approver),
        action: "mcpClient.approve",
        target:
          approver === undefined
            ? {
                kind: "session",
                id: `mcp-client:${input.authorization.client.clientId}`,
                name: input.authorization.client.name,
              }
            : { kind: "user", id: approver },
        detail: {
          client: input.authorization.client.name,
          access: decision.access,
          method: decision._tag,
        },
      });
    // The client acts as whoever approved it: the signed-in User, or the User a code was issued to.
    let approver: UserId | undefined;
    if (decision._tag === "pairing-code") {
      // A signed-in browser approves as its User, so a code may only be that User's. Spending
      // the code and recording the approval commit together: a failed entry leaves the code.
      const asUser = yield* signedInUser(input.request);
      const granted = yield* sql
        .withTransaction(
          environmentAuth.consumeMcpApprovalCode(decision.code, decision.access, { asUser }).pipe(
            Effect.tap((spent) => requireNamed(spent.userId)),
            Effect.tap((spent) => recordApproval(spent.userId).pipe(Effect.catch(notRecorded))),
          ),
        )
        .pipe(
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (cause) =>
            Effect.logError("MCP approval code check failed.", { cause }).pipe(
              Effect.andThen(
                Effect.fail(
                  new McpOAuthPageError({
                    description: "The code could not be checked. Try again.",
                  }),
                ),
              ),
            ),
          ),
          Effect.catchTags({ SqlError: notRecorded }),
        );
      approver = granted.userId;
    } else {
      const session = yield* approvingBrowserSession(input.request, input.authorization);
      if (
        session === undefined ||
        !timingSafeEqualBase64Url(decision.csrfToken, session.csrfToken) ||
        // The Installation's own scopes are not asked of a Member: no MCP tool needs them.
        !withoutInstallationScopes(mcpClientScopes(decision.access)).every((scope) =>
          session.scopes.includes(scope),
        )
      ) {
        return yield* new McpOAuthPageError({
          description: "Your session cannot approve this request. Enter a pairing code instead.",
        });
      }
      approver = session.userId;
      yield* requireNamed(approver);
      // Recorded before the code exists: an approval the log missed never signs anyone in.
      yield* recordApproval(approver).pipe(Effect.catch(notRecorded));
    }
    const code = yield* mintCode(input.authorization, decision.access, approver);
    return redirectWith(input.authorization.redirectUri, {
      code,
      state: input.authorization.state,
      iss: input.authorization.issuer,
    });
  });

  const deny: McpOAuth["Service"]["deny"] = (authorization) =>
    redirectWith(authorization.redirectUri, {
      error: "access_denied",
      state: authorization.state,
      iss: authorization.issuer,
    });

  const exchangeCode: McpOAuth["Service"]["exchangeCode"] = Effect.fn("McpOAuth.exchangeCode")(
    function* ({ request, urls, token }) {
      const fail = (error: AuthMcpTokenError["error"], description: string) =>
        new AuthMcpTokenError({ error, error_description: description });
      if (token.grant_type !== "authorization_code") {
        return yield* fail("unsupported_grant_type", "Only authorization_code is supported.");
      }
      const { redirect_uri: redirectUri, client_id: clientId } = token;
      const code = token.code && Redacted.value(token.code);
      const verifier = token.code_verifier && Redacted.value(token.code_verifier);
      if (!code || !redirectUri || !clientId || !verifier) {
        return yield* fail(
          "invalid_request",
          "code, redirect_uri, client_id and code_verifier are required.",
        );
      }
      if ((yield* parseClientId(clientId)) === undefined) {
        return yield* fail("invalid_client", "The client is unknown.");
      }
      // A presented code is spent even when a later check fails (RFC 6749 §4.1.2).
      const pending = yield* Ref.modify(codes, (current) => {
        const found = current.get(code);
        if (found === undefined) return [undefined, current] as const;
        const next = new Map(current);
        next.delete(code);
        return [found, next] as const;
      });
      const now = yield* Clock.currentTimeMillis;
      if (
        pending === undefined ||
        pending.expiresAtMs <= now ||
        pending.clientId !== clientId ||
        pending.redirectUri !== redirectUri ||
        pending.resource !== urls.resource ||
        !sameResource(urls, token.resource) ||
        !(yield* pkceVerifies(verifier, pending.codeChallenge))
      ) {
        return yield* fail("invalid_grant", "The authorization code is invalid or expired.");
      }
      const issued = yield* environmentAuth
        .issueMcpClientSession({
          label: pending.clientName,
          access: pending.access,
          ...(pending.userId === undefined ? {} : { userId: pending.userId }),
          client: deriveAuthClientMetadata({ request }),
        })
        .pipe(
          Effect.catch((cause) =>
            Effect.logError("Could not issue an MCP client session.", { cause }).pipe(
              Effect.andThen(
                Effect.fail(fail("invalid_grant", "The session could not be issued.")),
              ),
            ),
          ),
        );
      return {
        access_token: issued.token,
        token_type: "Bearer",
        expires_in: Math.max(0, Math.floor((issued.expiresAt.epochMilliseconds - now) / 1000)),
        scope: encodeOAuthScope(mcpClientScopes(pending.access)),
      };
    },
  );

  const managedPolicy = serverSettings.managedPolicy;
  const maxRuntimeMode = managedPolicy?.limits?.maxRuntimeMode;
  return McpOAuth.of({
    runtimeModeCeiling:
      managedPolicy === undefined || maxRuntimeMode === undefined
        ? undefined
        : { organization: managedPolicy.organization, maxRuntimeMode },
    register,
    validateAuthorization,
    approvingBrowserSession,
    signedInName,
    approve,
    deny,
    exchangeCode,
  });
});

export const layer = Layer.effect(McpOAuth, make).pipe(Layer.provide(AuditLog.layer));

export const layerMcpClientAuthenticator = Layer.effect(
  McpHttpServer.McpClientAuthenticator,
  Effect.gen(function* () {
    const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const environment = yield* ServerEnvironment.ServerEnvironment;
    const environmentId = yield* environment.getEnvironmentId;
    const publicHubOrigin = yield* (yield* PublicHubUrl).publicHubOrigin;
    // Without a public URL, links open on the origin the client reached this Hub on.
    const outsideClientHubOrigin = (request: HttpServerRequest.HttpServerRequest) => {
      const hubOrigin = hubLinkOrigin({
        publicUrl: Option.getOrUndefined(publicHubOrigin),
        currentOrigin: Option.getOrUndefined(requestUrl(request))?.origin,
      });
      return hubOrigin === null ? {} : { hubOrigin };
    };
    return McpHttpServer.McpClientAuthenticator.of({
      authenticate: Effect.fn("McpHttpServer.McpClientAuthenticator.authenticate")(
        function (request) {
          return environmentAuth.authenticateMcpClient(request).pipe(
            Effect.flatMap((client) =>
              Clock.currentTimeMillis.pipe(
                Effect.map((issuedAt): McpInvocationContext.McpInvocationScope => ({
                  environmentId,
                  requestNamespace: `client:${client.sessionId}`,
                  thread: undefined,
                  // It reads and creates as the User who approved it, never as the Owner.
                  ...(client.userId === undefined ? {} : { userId: client.userId }),
                  client: {
                    sessionId: client.sessionId,
                    label: client.label,
                    access: client.access,
                    ...outsideClientHubOrigin(request),
                  },
                  capabilities: new Set<McpInvocationContext.McpCapability>([
                    "orchestration",
                    "worktree",
                    "pull-requests",
                  ]),
                  issuedAt,
                })),
              ),
            ),
            Effect.catch((error) =>
              (EnvironmentAuth.isServerAuthCredentialError(error)
                ? Effect.void
                : Effect.logWarning("MCP client authentication failed.", { cause: error })
              ).pipe(Effect.as(undefined)),
            ),
          );
        },
      ),
    });
  }),
);
