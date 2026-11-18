/**
 * The Keycloak adapter's «Check» and key set (Keycloak sign-in spec, ticket 01) against the fake
 * realm: what each broken realm answers, and that the Hub never asks another host.
 */
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import * as KeycloakClient from "./KeycloakClient.ts";
import {
  discoveryDocument,
  type FakeAnswer,
  type FakeKeycloak,
  makeFakeKeycloak,
} from "./Keycloak.testkit.ts";

const clientOf = (realm: FakeKeycloak) => KeycloakClient.make.pipe(Effect.provide(realm.layer));

const hostsAsked = (realm: FakeKeycloak) => [
  ...new Set(realm.requests.map((url) => new URL(url).host)),
];

describe("KeycloakClient.normalizeIssuer", () => {
  it("takes the realm's https address, drops one trailing slash, refuses the rest", () => {
    const cases: ReadonlyArray<readonly [string, string | undefined]> = [
      ["https://auth.example.com/realms/acme", "https://auth.example.com/realms/acme"],
      ["  https://auth.example.com/realms/acme/ ", "https://auth.example.com/realms/acme"],
      ["https://AUTH.example.com:443/realms/acme", "https://auth.example.com/realms/acme"],
      ["http://localhost:8080/realms/dev", "http://localhost:8080/realms/dev"],
      ["http://127.0.0.1:8080/realms/dev", "http://127.0.0.1:8080/realms/dev"],
      ["http://[::1]:8080/realms/dev", "http://[::1]:8080/realms/dev"],
      // http leaves this machine: refused, as are users, queries, fragments and non-URLs.
      ["http://auth.example.com/realms/acme", undefined],
      ["http://192.168.1.10/realms/acme", undefined],
      ["https://user:pass@auth.example.com/realms/acme", undefined],
      ["https://auth.example.com/realms/acme?x=1", undefined],
      ["https://auth.example.com/realms/acme?", undefined],
      ["https://auth.example.com/realms/acme#top", undefined],
      ["ftp://auth.example.com/realms/acme", undefined],
      ["auth.example.com/realms/acme", undefined],
    ];
    for (const [input, expected] of cases) {
      assert.equal(KeycloakClient.normalizeIssuer(input), expected, input);
    }
  });
});

describe("KeycloakClient.check", () => {
  it.effect("a working realm: its keys, back-channel logout, offline access and acr values", () =>
    Effect.gen(function* () {
      const realm = yield* makeFakeKeycloak();
      const client = yield* clientOf(realm);
      const result = yield* client.check(realm.issuer);
      assert.deepEqual(result, {
        _tag: "ok",
        issuer: realm.issuer,
        signingKeys: 1,
        backchannelLogoutSupported: true,
        offlineAccessOffered: true,
        acrValuesSupported: ["0", "1", "basico", "critica"],
      });
      assert.deepEqual(realm.requests, [realm.discoveryUrl, realm.jwksUrl]);
    }),
  );

  // Each broken realm, the step it fails at and why; the Hub asked nothing but the issuer's host.
  const broken: ReadonlyArray<{
    readonly name: string;
    readonly answers: (realm: FakeKeycloak) => ReadonlyArray<readonly [string, FakeAnswer]>;
    readonly step: "discovery" | "keys";
    readonly reason: string;
    readonly says?: string;
  }> = [
    {
      name: "discovery names another issuer",
      answers: (realm) => [
        [
          realm.discoveryUrl,
          { json: { ...discoveryDocument(realm.issuer), issuer: `${realm.issuer}/` } },
        ],
      ],
      step: "discovery",
      reason: "issuer-mismatch",
      says: "https://keycloak.test/realms/hub/",
    },
    {
      name: "a redirect, even to the same host, is never followed",
      answers: (realm) => [
        [realm.discoveryUrl, { status: 302, headers: { location: "https://elsewhere.test/" } }],
      ],
      step: "discovery",
      reason: "redirect",
    },
    {
      name: "no realm there",
      answers: (realm) => [[realm.discoveryUrl, { status: 404 }]],
      step: "discovery",
      reason: "http-status",
      says: "404",
    },
    {
      name: "a server error",
      answers: (realm) => [[realm.discoveryUrl, { status: 503 }]],
      step: "discovery",
      reason: "http-status",
      says: "503",
    },
    {
      name: "a document over 128 KiB",
      answers: (realm) => [
        [
          realm.discoveryUrl,
          {
            json: {
              ...discoveryDocument(realm.issuer),
              padding: "x".repeat(KeycloakClient.MAX_DOCUMENT_BYTES),
            },
          },
        ],
      ],
      step: "discovery",
      reason: "too-large",
    },
    {
      name: "not JSON",
      answers: (realm) => [[realm.discoveryUrl, { body: "<html>Sign in</html>" }]],
      step: "discovery",
      reason: "invalid-document",
    },
    {
      name: "JSON but not a discovery document",
      answers: (realm) => [[realm.discoveryUrl, { json: { hello: "world" } }]],
      step: "discovery",
      reason: "invalid-document",
    },
    {
      name: "the key set on another host",
      answers: (realm) => [
        [
          realm.discoveryUrl,
          {
            json: {
              ...discoveryDocument(realm.issuer),
              jwks_uri: "https://metadata.test/latest/keys",
            },
          },
        ],
      ],
      step: "discovery",
      reason: "endpoint-off-issuer",
    },
    {
      name: "the token endpoint on another host",
      answers: (realm) => [
        [
          realm.discoveryUrl,
          {
            json: {
              ...discoveryDocument(realm.issuer),
              token_endpoint: "https://other.test/token",
            },
          },
        ],
      ],
      step: "discovery",
      reason: "endpoint-off-issuer",
    },
    {
      name: "the host is unreachable",
      answers: (realm) => [[realm.discoveryUrl, "unreachable"]],
      step: "discovery",
      reason: "unreachable",
    },
    {
      name: "the key set is missing",
      answers: (realm) => [[realm.jwksUrl, { status: 404 }]],
      step: "keys",
      reason: "http-status",
    },
    {
      name: "the key set has only an encryption key",
      answers: (realm) => [
        [
          realm.jwksUrl,
          {
            json: {
              keys: [
                {
                  kty: "RSA",
                  use: "enc",
                  kid: "enc",
                  n: "sXchDaQebHnPiGvyDOAT4saGEUetSyo9MKLOoWFsueri23bOdgWp4Dy1WlUzewbgBHod5pcM9H95GQRV3JDXboIRROSBigeC5yjU1hGzHHyXss8UDprecbAYxknTcQkhslANGRUZmdTOQ5qTRsLAt6BTYuyvVRdhS8exSZEy_c4gs_7svlJJQ4H9_NxsiIoLwAEk7-Q3UXERGYw_75IDrGA84-lA_-Ct4eTlXHBIY2EaV7t7LjJaynVJCpkv4LKjTTAumiGUIuQhrNhZLuF_RJLqHpM2kgWFLU7-VTdL1VbC2tejvcI2BlMkEpk1BzBZI0KQB0GaDWFLN-aEAw3vRw",
                  e: "AQAB",
                },
              ],
            },
          },
        ],
      ],
      step: "keys",
      reason: "no-usable-keys",
    },
    {
      name: "the key set is not a JWK set",
      answers: (realm) => [[realm.jwksUrl, { json: { keys: "none" } }]],
      step: "keys",
      reason: "invalid-document",
    },
  ];

  it.effect.each(broken)("fails at $step when $name", (testCase) =>
    Effect.gen(function* () {
      const realm = yield* makeFakeKeycloak();
      for (const [url, answer] of testCase.answers(realm)) realm.serve(url, answer);
      const client = yield* clientOf(realm);
      const result = yield* client.check(realm.issuer);
      assert.equal(result._tag, "failed");
      if (result._tag !== "failed") return;
      assert.equal(result.step, testCase.step);
      assert.equal(result.reason, testCase.reason);
      if (testCase.says !== undefined) assert.include(result.message, testCase.says);
      assert.deepEqual(hostsAsked(realm), ["keycloak.test"]);
    }),
  );

  it.effect("a realm that never answers fails after 5 seconds", () =>
    Effect.gen(function* () {
      const realm = yield* makeFakeKeycloak();
      realm.serve(realm.discoveryUrl, "hang");
      const client = yield* clientOf(realm);
      const fiber = yield* Effect.forkChild(client.check(realm.issuer));
      yield* TestClock.adjust("5 seconds");
      const result = yield* Fiber.join(fiber);
      assert.equal(result._tag, "failed");
      if (result._tag === "failed") assert.equal(result.reason, "timeout");
    }),
  );

  it.effect("an issuer it refuses is never fetched", () =>
    Effect.gen(function* () {
      const realm = yield* makeFakeKeycloak();
      const client = yield* clientOf(realm);
      const result = yield* client.check("http://keycloak.test/realms/hub");
      assert.equal(result._tag, "failed");
      if (result._tag === "failed") assert.equal(result.reason, "invalid-issuer");
      assert.deepEqual(realm.requests, []);
    }),
  );
});

describe("KeycloakClient.keySet", () => {
  it.effect.each(["https://keycloak.test/realms/hub", "http://127.0.0.1:8080/realms/dev"])(
    "resolves the realm's signing key by kid (%s)",
    (issuer) =>
      Effect.gen(function* () {
        const realm = yield* makeFakeKeycloak({ issuer });
        const client = yield* clientOf(realm);
        const discovery = yield* client.discover(issuer);
        const keys = yield* client.keySet(discovery);
        const key = yield* keys.resolve({ algorithm: "ES256", kid: "fake-realm-1" });
        assert.isDefined(key);
        const unknown = yield* Effect.flip(keys.resolve({ algorithm: "ES256", kid: "rotated" }));
        assert.equal(unknown.reason._tag, "KeyNotFound");
      }).pipe(Effect.scoped),
  );
});
