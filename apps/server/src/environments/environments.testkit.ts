import { formatEnvironmentCredential } from "@t3tools/shared/environmentJoin";
import { assert } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import {
  type Authenticator,
  bootstrapOwner,
  type CreationOptions,
  makeAuthenticator,
  passkeyReauth,
  type Server,
  serveAuthHttpWith,
} from "../auth/UserAuth.testkit.ts";
import * as EnvironmentRegistry from "./EnvironmentRegistry.ts";

const REDIRECT = "http://127.0.0.1:51234/callback";
const VERIFIER = "a-code-verifier-that-is-long-enough-for-pkce-0123456789";
const STATE = "state-0123456789abcdef";

const sha256 = (value: string) =>
  Effect.promise(async () =>
    Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).toString(
      "base64url",
    ),
  );

/** A Hub with its Owner signed in with a passkey; `listen` also serves a real port. */
export const hubWithOwner = (options: Parameters<typeof serveAuthHttpWith>[0] = {}) =>
  Effect.gen(function* () {
    const server = yield* serveAuthHttpWith(options);
    const authenticator = yield* makeAuthenticator();
    const { created } = yield* bootstrapOwner(server, authenticator);
    return { server, authenticator, owner: created.cookie ?? "" };
  });

/** What `t3 join` does first: a credential of its own, known to the Hub only by its hash. */
export const startJoin = Effect.fn(function* (
  server: Server,
  options: {
    readonly loopback?: boolean;
    /** `t3 join --dedicated <this>`. */
    readonly dedicatedSpace?: string;
  } = {},
) {
  const hubId = Context.get(server.services, EnvironmentRegistry.EnvironmentRegistry).hubId;
  const credential = formatEnvironmentCredential(
    hubId,
    Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"),
  );
  const started = yield* server.request("/api/environments/join/start", {
    body: {
      codeChallenge: yield* sha256(VERIFIER),
      codeChallengeMethod: "S256",
      credentialHash: yield* sha256(credential),
      name: "ada-laptop",
      os: "linux",
      hostname: "ada-laptop",
      ...(options.loopback === true ? { redirectUri: REDIRECT, state: STATE } : {}),
      ...(options.dedicatedSpace === undefined ? {} : { dedicatedSpace: options.dedicatedSpace }),
    },
  });
  assert.equal(started.status, 200);
  return { requestId: started.body.requestId as string, credential };
});

/** What the «Register this machine» page posts. */
export const approveJoin = Effect.fn(function* (
  server: Server,
  cookie: string,
  requestId: string,
  input: {
    readonly reauth?: unknown;
    readonly name?: string;
    /** Dedicates it to this Organization, as the Owner may choose on the page. */
    readonly dedicatedSpaceId?: string;
  } = {},
) {
  return yield* server.request("/api/environments/join/approve", {
    cookie,
    body: {
      requestId,
      name: input.name ?? "Laptop",
      ...(input.reauth === undefined ? {} : { reauth: input.reauth }),
      ...(input.dedicatedSpaceId === undefined ? {} : { dedicatedSpaceId: input.dedicatedSpaceId }),
    },
  });
});

export const joinStatus = (server: Server, requestId: string, codeVerifier = VERIFIER) =>
  server.request("/api/environments/join/status", { body: { requestId, codeVerifier } });

/** `t3 join` accepts (or refuses) the approver the Hub named, which registers the machine. */
export const confirmJoin = (
  server: Server,
  requestId: string,
  accept: boolean,
  codeVerifier = VERIFIER,
) =>
  server.request("/api/environments/join/confirm", {
    body: { requestId, codeVerifier, accept },
  });

/** The whole of `t3 join`, approved with a passkey and confirmed: the machine's credential and id. */
export const joinMachine = Effect.fn(function* (
  server: Server,
  authenticator: Authenticator,
  owner: string,
  name = "Laptop",
  /** `t3 join --dedicated`, approved by the Owner for this Organization. */
  dedicatedSpaceId?: string,
) {
  const { requestId, credential } = yield* startJoin(
    server,
    dedicatedSpaceId === undefined ? {} : { dedicatedSpace: dedicatedSpaceId },
  );
  const approved = yield* approveJoin(server, owner, requestId, {
    name,
    reauth: yield* passkeyReauth(server, authenticator),
    ...(dedicatedSpaceId === undefined ? {} : { dedicatedSpaceId }),
  });
  assert.equal(approved.status, 200);
  assert.equal((yield* joinStatus(server, requestId)).body.status, "awaiting-confirmation");
  const confirmed = yield* confirmJoin(server, requestId, true);
  assert.equal(confirmed.status, 200);
  const status = yield* joinStatus(server, requestId);
  assert.equal(status.body.status, "approved");
  return {
    requestId,
    credential,
    environmentId: status.body.environmentId as string,
    hubEnvironmentId: status.body.hubEnvironmentId as string,
    name: status.body.name as string,
  };
});

/**
 * A Member of an Organization (a new «Acme» unless one is named) who joined by Invitation with a
 * passkey of their own, so they can confirm a strong factor.
 */
export const memberWithPasskey = Effect.fn(function* (
  server: Server,
  owner: string,
  input: {
    readonly displayName: string;
    readonly spaceId?: string;
    readonly role?: "admin" | "member";
  },
) {
  const spaceId =
    input.spaceId ??
    ((yield* server.request("/api/spaces/organizations", { body: { name: "Acme" }, cookie: owner }))
      .body.id as string);
  const invitation = yield* server.request(`/api/spaces/${spaceId}/invitations`, {
    body: { role: input.role ?? "member" },
    cookie: owner,
  });
  const token = invitation.body.token as string;
  const authenticator = yield* makeAuthenticator();
  const ceremony = yield* server.request("/api/invitations/registration", {
    body: { token, displayName: input.displayName },
  });
  const response = yield* Effect.promise(() =>
    authenticator.create(ceremony.body.options as CreationOptions),
  );
  const accepted = yield* server.request("/api/invitations/accept", {
    body: { token, method: "passkey", ceremonyId: ceremony.body.ceremonyId, response },
  });
  assert.equal(accepted.status, 200);
  return {
    cookie: accepted.cookie ?? "",
    userId: accepted.body.userId as string,
    authenticator,
    spaceId,
  };
});

export const loopbackStateOf = (redirectTo: unknown) => {
  const url = new URL(String(redirectTo));
  assert.equal(`${url.origin}${url.pathname}`, REDIRECT);
  return url.searchParams.get("state");
};

export const listEnvironments = Effect.fn(function* (server: Server, cookie: string) {
  const listed = yield* server.request("/api/environments", { cookie });
  assert.equal(listed.status, 200);
  return listed.body.environments as ReadonlyArray<{
    id: string;
    name: string;
    kind: string;
    status: string;
    startError?: string | null;
    ownerUserId: string | null;
    mode: string;
    spaceId?: string | null;
    hostname: string | null;
    providers: ReadonlyArray<{ instanceId: string }>;
  }>;
});
