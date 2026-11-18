/**
 * A fake Keycloak realm in process, where the Hub's `KeycloakHttp` goes instead of the network:
 * discovery and a key set (`signingKey`); `serve` changes an answer, `requests` lists what the Hub
 * asked. Its issuer is under `.test`, which never resolves. Tickets 02 and 07 add the token endpoint.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Jwk from "effect/jose/Jwk";

import { KeycloakHttp } from "./KeycloakClient.ts";

const TEST_ISSUER = "https://keycloak.test/realms/hub";

/** How the fake answers one address. */
export type FakeAnswer =
  | {
      readonly status?: number;
      /** A JSON body. */
      readonly json?: unknown;
      /** A raw body, for what is not JSON. */
      readonly body?: string | Uint8Array;
      readonly headers?: Record<string, string>;
    }
  /** Never answers: the Hub's timeout ends it. */
  | "hang"
  /** The connection fails, as an unknown host or a refused port. */
  | "unreachable";

/** Keycloak's discovery document for a realm, as Keycloak 26 writes it (the parts the Hub reads). */
export const discoveryDocument = (issuer: string) => ({
  issuer,
  authorization_endpoint: `${issuer}/protocol/openid-connect/auth`,
  token_endpoint: `${issuer}/protocol/openid-connect/token`,
  jwks_uri: `${issuer}/protocol/openid-connect/certs`,
  end_session_endpoint: `${issuer}/protocol/openid-connect/logout`,
  userinfo_endpoint: `${issuer}/protocol/openid-connect/userinfo`,
  backchannel_logout_supported: true,
  backchannel_logout_session_supported: true,
  scopes_supported: ["openid", "profile", "email", "offline_access", "roles"],
  acr_values_supported: ["0", "1", "basico", "critica"],
  id_token_signing_alg_values_supported: ["RS256", "PS256", "ES256", "EdDSA"],
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
});

const discoveryUrl = (issuer: string) => `${issuer}/.well-known/openid-configuration`;
const jwksUrl = (issuer: string) => `${issuer}/protocol/openid-connect/certs`;

/** A KeycloakHttp that refuses every request: the testkit Hub's default, so no test goes out. */
export const layerNoNetwork = Layer.succeed(
  KeycloakHttp,
  HttpClient.make((request) =>
    Effect.fail(
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({
          request,
          description: "tests never reach the network",
        }),
      }),
    ),
  ),
);

export const makeFakeKeycloak = Effect.fn("makeFakeKeycloak")(function* (
  options: { readonly issuer?: string } = {},
) {
  const issuer = options.issuer ?? TEST_ISSUER;
  const signingKey = yield* Jwk.generateKeyPair({ algorithm: "ES256", kid: "fake-realm-1" }).pipe(
    Effect.provide(NodeCrypto.layer),
  );
  const answers = new Map<string, FakeAnswer>([
    [discoveryUrl(issuer), { json: discoveryDocument(issuer) }],
    [jwksUrl(issuer), { json: { keys: [signingKey.publicKey] } }],
  ]);
  const requests: Array<string> = [];

  const client = HttpClient.make((request, url) => {
    requests.push(url.href);
    const answer = answers.get(url.href) ?? { status: 404, json: { error: "not found" } };
    if (answer === "hang") return Effect.never;
    if (answer === "unreachable") {
      return Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, description: "unreachable" }),
        }),
      );
    }
    const body =
      answer.body ?? (answer.json === undefined ? undefined : JSON.stringify(answer.json));
    const response = new Response(body ?? null, {
      status: answer.status ?? 200,
      headers: {
        ...(answer.json === undefined ? {} : { "content-type": "application/json" }),
        ...answer.headers,
      },
    });
    // fetch sets the address it answered from; a built Response has none.
    Object.defineProperty(response, "url", { value: url.href });
    return Effect.succeed(HttpClientResponse.fromWeb(request, response));
  });

  return {
    issuer,
    /** Put the fake where the Hub's Keycloak requests go. */
    layer: Layer.succeed(KeycloakHttp, client),
    /** The realm's signing key; its public half is in the served key set. */
    signingKey,
    /** Every address the Hub asked, in order. */
    requests,
    /** Answer `url` another way from now on. */
    serve: (url: string, answer: FakeAnswer) => {
      answers.set(url, answer);
    },
    discoveryUrl: discoveryUrl(issuer),
    jwksUrl: jwksUrl(issuer),
  };
});

export type FakeKeycloak = Effect.Success<ReturnType<typeof makeFakeKeycloak>>;
