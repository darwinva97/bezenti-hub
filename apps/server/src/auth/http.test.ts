import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthTokenExchangeGrantType,
  AuthEnvironmentBootstrapTokenType,
  AuthAccessTokenType,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpRouter from "effect/http/HttpRouter";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as AppSignInHttp from "./appSignInHttp.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import { makeDpopKey } from "./dpop.testkit.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import { layerTestPeer, TEST_PEER_HEADER } from "./clientConnection.testkit.ts";
import * as AuthHttp from "./http.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { parsePreviewOrigin, type PreviewOriginPattern } from "../preview/PreviewOrigin.ts";

const DEV_TOKEN = "reusable-dev-auth-token-that-is-long-enough";
class AuthTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth) {}

const layerConfigWith = (previewOrigin?: PreviewOriginPattern) =>
  Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return {
        ...config,
        mode: "web",
        devUrl: new URL("http://127.0.0.1:5173"),
        devAuthToken: Redacted.make(DEV_TOKEN),
        ...(previewOrigin === undefined ? {} : { previewOrigin }),
      } satisfies ServerConfig.ServerConfig["Service"];
    }),
  ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-http-test-" })));

const layerRoutesWith = (layerConfig: ReturnType<typeof layerConfigWith>) => {
  const layerEnvironmentAuth = EnvironmentAuth.layer.pipe(
    Layer.provide(ManagedPolicy.layerTest()),
    Layer.provide(SqlitePersistence.layerMemory),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provide(layerConfig),
  );
  const layerRoutes = HttpApiBuilder.layer(AuthTestApi).pipe(
    Layer.provide(AuthHttp.layer),
    Layer.provide(AuthHttp.layerAuthenticatedAuth),
    Layer.provide(layerTestPeer),
    Layer.provideMerge(layerEnvironmentAuth),
    Layer.provide(layerConfig),
    Layer.provideMerge(
      HttpPlatform.layer.pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        Layer.provideMerge(Etag.layerWeak),
      ),
    ),
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
  return layerRoutes;
};
const layerRoutes = layerRoutesWith(layerConfigWith());

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const postJson = (path: string, body: unknown, headers?: Readonly<Record<string, string>>) =>
  new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: encodeJson(body),
  });

it.effect("sets the selected browser session cookies through the HTTP route", () =>
  Effect.gen(function* () {
    const random = yield* SecureRandom.SecureRandom;
    const unusedSecretStore = ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeedNone,
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.die("Not used by these routes."),
      remove: () => Effect.void,
    });
    const requestContext = Context.make(SecureRandom.SecureRandom, random).pipe(
      Context.add(ServerSecretStore.ServerSecretStore, unusedSecretStore),
    );
    return yield* Effect.acquireUseRelease(
      Effect.sync(
        () =>
          [
            HttpRouter.toWebHandler(layerRoutes, { disableLogger: true }),
            HttpRouter.toWebHandler(layerRoutes, { disableLogger: true }),
          ] as const,
      ),
      ([environmentA, environmentB]) =>
        Effect.tryPromise(async () => {
          const devResponse = await environmentA.handler(
            postJson("/api/auth/browser-session", { credential: DEV_TOKEN }),
            requestContext,
          );
          expect(devResponse.status).toBe(200);
          const retiredScopeResponse = await environmentA.handler(
            new Request("http://127.0.0.1/oauth/token", {
              method: "POST",
              body: new URLSearchParams({
                grant_type: AuthTokenExchangeGrantType,
                subject_token: DEV_TOKEN,
                subject_token_type: AuthEnvironmentBootstrapTokenType,
                requested_token_type: AuthAccessTokenType,
                scope: "review:write",
              }),
            }),
            requestContext,
          );
          expect(retiredScopeResponse.status).toBe(400);
          expect(await retiredScopeResponse.json()).toMatchObject({ reason: "invalid_scope" });

          const devCookies = devResponse.headers.getSetCookie();
          const devCookie = devCookies.find((cookie) => cookie.startsWith("t3_dev_session_"));
          expect(devCookie).toContain("HttpOnly");
          expect(devCookie).toContain(`=${DEV_TOKEN};`);
          expect(devCookies).toContainEqual(
            expect.stringMatching(/^t3_session_[^=]*=;.*Max-Age=0/),
          );
          const devCookieHeader = devCookie?.split(";", 1)[0] ?? "";
          const environmentBSession = await environmentB.handler(
            new Request("http://127.0.0.1/api/auth/session", {
              headers: { cookie: devCookieHeader },
            }),
            requestContext,
          );
          expect(environmentBSession.status).toBe(200);
          expect(await environmentBSession.json()).toMatchObject({ authenticated: true });

          // The reusable dev session outlives sign-out, so sign-out must not claim otherwise.
          const devSignOut = await environmentA.handler(
            postJson("/api/auth/sign-out", {}, { cookie: devCookieHeader }),
            requestContext,
          );
          expect(await devSignOut.json()).toEqual({ signedOut: false });

          const pairingResponse = await environmentA.handler(
            postJson(
              "/api/auth/pairing-token",
              { scopes: ["orchestration:read"] },
              { cookie: devCookieHeader },
            ),
            requestContext,
          );
          expect(pairingResponse.status).toBe(200);
          const pairing = (await pairingResponse.json()) as { credential: string };
          const restrictedResponse = await environmentA.handler(
            postJson("/api/auth/browser-session", { credential: pairing.credential }),
            requestContext,
          );
          expect(restrictedResponse.status).toBe(200);
          const restrictedCookies = restrictedResponse.headers.getSetCookie();
          expect(restrictedCookies).toHaveLength(1);
          expect(restrictedCookies[0]).toMatch(/^t3_session_/);
          expect(restrictedCookies[0]).not.toContain("t3_dev_session_");
        }),
      ([environmentA, environmentB]) =>
        Effect.promise(() => Promise.all([environmentA.dispose(), environmentB.dispose()])),
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "with previews on their own origin, the dev token's cookie is `__Host-` over HTTPS like the session's, and a bare one counts for nothing",
  () =>
    Effect.gen(function* () {
      const parsed = parsePreviewOrigin("https://*.preview.example.test");
      if (parsed._tag !== "Success") return yield* Effect.die(parsed);
      const random = yield* SecureRandom.SecureRandom;
      const unusedSecretStore = ServerSecretStore.ServerSecretStore.of({
        get: () => Effect.succeedNone,
        set: () => Effect.void,
        create: () => Effect.void,
        getOrCreateRandom: () => Effect.die("Not used by these routes."),
        remove: () => Effect.void,
      });
      const requestContext = Context.make(SecureRandom.SecureRandom, random).pipe(
        Context.add(ServerSecretStore.ServerSecretStore, unusedSecretStore),
      );
      const https = { "x-forwarded-proto": "https", "x-forwarded-for": "127.0.0.1" };
      return yield* Effect.acquireUseRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(layerRoutesWith(layerConfigWith(parsed.success)), {
            disableLogger: true,
          }),
        ),
        (environment) =>
          Effect.tryPromise(async () => {
            const signedIn = await environment.handler(
              postJson("/api/auth/browser-session", { credential: DEV_TOKEN }, https),
              requestContext,
            );
            expect(signedIn.status).toBe(200);
            const cookies = signedIn.headers.getSetCookie();
            const devCookie = cookies.find((cookie) => cookie.startsWith("__Host-t3_dev_session_"));
            expect(devCookie).toMatch(/; Secure/i);
            expect(devCookie).toMatch(/; Path=\//i);
            // The session cookie it replaces goes under both names it may be under.
            expect(cookies).toContainEqual(expect.stringMatching(/^t3_session_[^=]*=;.*Max-Age=0/));
            expect(cookies).toContainEqual(
              expect.stringMatching(/^__Host-t3_session_[^=]*=;.*Max-Age=0/),
            );
            const name = devCookie!.slice("__Host-".length, devCookie!.indexOf("="));
            const check = (cookie: string) =>
              environment
                .handler(
                  new Request("http://127.0.0.1/api/auth/session", {
                    headers: { cookie, ...https },
                  }),
                  requestContext,
                )
                .then((response) => response.json());
            expect(await check(`__Host-${name}=${DEV_TOKEN}`)).toMatchObject({
              authenticated: true,
            });
            // What a preview subdomain could set for the Hub's domain: the bare name.
            expect(await check(`${name}=${DEV_TOKEN}`)).toMatchObject({ authenticated: false });
          }),
        (environment) => Effect.promise(() => environment.dispose()),
      );
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

// Token requests are unauthenticated until their grant is checked, so their proofs are checked
// but never recorded: recording would let anyone write replay state to disk. Proofs need
// wall-clock time, as the web handler runs on its own runtime.
const recordingRequestContext = (random: SecureRandom.SecureRandom["Service"]) => {
  const written: Array<string> = [];
  const recordingSecretStore = ServerSecretStore.ServerSecretStore.of({
    get: () => Effect.succeedNone,
    set: () => Effect.void,
    create: (name) => Effect.sync(() => void written.push(name)),
    getOrCreateRandom: () => Effect.die("Not used by these routes."),
    remove: () => Effect.void,
  });
  const context = Context.make(SecureRandom.SecureRandom, random).pipe(
    Context.add(ServerSecretStore.ServerSecretStore, recordingSecretStore),
  );
  return { context, written };
};

it.live("checks token-endpoint DPoP proofs without writing replay state", () =>
  Effect.gen(function* () {
    const { context, written } = recordingRequestContext(yield* SecureRandom.SecureRandom);
    const url = "http://127.0.0.1/oauth/token";
    const key = makeDpopKey();
    const iat = Math.floor((yield* DateTime.now).epochMilliseconds / 1_000);
    const tokenRequest = (subjectToken: string, proof: string) =>
      new Request(url, {
        method: "POST",
        headers: { host: "127.0.0.1", dpop: proof },
        body: new URLSearchParams({
          grant_type: AuthTokenExchangeGrantType,
          subject_token: subjectToken,
          subject_token_type: AuthEnvironmentBootstrapTokenType,
          requested_token_type: AuthAccessTokenType,
        }),
      });
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(layerRoutes, { disableLogger: true })),
      (environment) =>
        Effect.promise(async () => {
          const unknownToken = await environment.handler(
            tokenRequest("not-a-pairing-token", key.sign({ method: "POST", url, token: "", iat })),
            context,
          );
          expect(unknownToken.status).toBe(401);
          expect(await unknownToken.json()).not.toHaveProperty("dpopFailureReason");

          const accepted = await environment.handler(
            tokenRequest(DEV_TOKEN, key.sign({ method: "POST", url, token: "", iat })),
            context,
          );
          expect(accepted.status).toBe(200);
          expect(await accepted.json()).toMatchObject({ token_type: "DPoP" });

          const badProof = await environment.handler(
            tokenRequest(DEV_TOKEN, "not-a-proof"),
            context,
          );
          expect(badProof.status).toBe(401);
          expect(badProof.headers.get("www-authenticate")).toBe("DPoP");
          expect(written).toEqual([]);
        }),
      (environment) => Effect.promise(() => environment.dispose()),
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

class AppSignInTestApi extends HttpApi.make("environment").add(
  EnvironmentHttpApi.groups.appSignIn,
) {}

it.live("checks app sign-in DPoP proofs without writing replay state", () =>
  Effect.gen(function* () {
    const { context, written } = recordingRequestContext(yield* SecureRandom.SecureRandom);
    const layerConfig = layerConfigWith();
    const layerAppSignInRoutes = HttpApiBuilder.layer(AppSignInTestApi).pipe(
      Layer.provide(AppSignInHttp.layer),
      Layer.provide(layerTestPeer),
      Layer.provideMerge(
        EnvironmentAuth.layer.pipe(
          Layer.provide(ManagedPolicy.layerTest()),
          Layer.provide(ServerSecretStore.layer),
          Layer.provide(ServerEnvironment.layerIdentity),
          Layer.provide(layerConfig),
        ),
      ),
      Layer.provide(SqlitePersistence.layerMemory),
      Layer.provide(layerConfig),
      Layer.provideMerge(
        HttpPlatform.layer.pipe(
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          Layer.provideMerge(Etag.layerWeak),
        ),
      ),
      Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    );
    const url = "http://127.0.0.1/api/auth/app-sign-in/token";
    const key = makeDpopKey();
    const iat = Math.floor((yield* DateTime.now).epochMilliseconds / 1_000);
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(layerAppSignInRoutes, { disableLogger: true })),
      (environment) =>
        Effect.promise(async () => {
          // A valid proof with a code nobody approved: refused, and nothing written.
          const madeUpCode = await environment.handler(
            new Request(url, {
              method: "POST",
              headers: {
                host: "127.0.0.1",
                dpop: key.sign({ method: "POST", url, token: "", iat }),
              },
              body: new URLSearchParams({
                grant_type: "authorization_code",
                code: "a-code-nobody-approved",
                code_verifier: "v".repeat(43),
                redirect_uri: "http://127.0.0.1:53111/callback",
              }),
            }),
            context,
          );
          expect(madeUpCode.status).toBe(401);
          expect(written).toEqual([]);
        }),
      (environment) => Effect.promise(() => environment.dispose()),
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect.each(["DPoP", "dpop"])("challenges a refused %s request with DPoP", (scheme) =>
  Effect.gen(function* () {
    const random = yield* SecureRandom.SecureRandom;
    const unusedSecretStore = ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeedNone,
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.die("Not used by these routes."),
      remove: () => Effect.void,
    });
    const requestContext = Context.make(SecureRandom.SecureRandom, random).pipe(
      Context.add(ServerSecretStore.ServerSecretStore, unusedSecretStore),
    );
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(layerRoutes, { disableLogger: true })),
      (environment) =>
        Effect.promise(async () => {
          const refused = await environment.handler(
            postJson(
              "/api/auth/pairing-token",
              { scopes: ["orchestration:read"] },
              { authorization: `${scheme} not-a-valid-token` },
            ),
            requestContext,
          );
          expect(refused.status).toBe(401);
          expect(refused.headers.get("www-authenticate")).toBe("DPoP");
        }),
      (environment) => Effect.promise(() => environment.dispose()),
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

// Behind a reverse proxy the cookies are `Secure` only when a trusted proxy (loopback by
// default, `T3CODE_TRUSTED_PROXIES`) says the client used HTTPS; from anyone else
// `X-Forwarded-Proto` is ignored.
it.effect("only a trusted proxy's X-Forwarded-Proto makes the session cookies Secure", () =>
  Effect.gen(function* () {
    const random = yield* SecureRandom.SecureRandom;
    const unusedSecretStore = ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeedNone,
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.die("Not used by these routes."),
      remove: () => Effect.void,
    });
    const requestContext = Context.make(SecureRandom.SecureRandom, random).pipe(
      Context.add(ServerSecretStore.ServerSecretStore, unusedSecretStore),
    );
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(layerRoutes, { disableLogger: true })),
      (environment) =>
        Effect.tryPromise(async () => {
          const signIn = (peer: string) =>
            environment
              .handler(
                postJson(
                  "/api/auth/browser-session",
                  { credential: DEV_TOKEN },
                  {
                    [TEST_PEER_HEADER]: peer,
                    "x-forwarded-proto": "https",
                    "x-forwarded-for": "192.168.1.77",
                  },
                ),
                requestContext,
              )
              .then((response) => {
                expect(response.status).toBe(200);
                const cookies = response.headers.getSetCookie();
                return cookies.find((cookie) => cookie.includes("t3_dev_session_"));
              });

          // From the local proxy: the client used HTTPS.
          const trusted = await signIn("127.0.0.1");
          expect(trusted).toMatch(/; Secure/i);
          expect(trusted).toMatch(/^__Host-/);

          // From a LAN peer that is not a trusted proxy: its headers count for nothing.
          const untrusted = await signIn("192.168.1.50");
          expect(untrusted).toBeDefined();
          expect(untrusted).not.toMatch(/; Secure/i);
          expect(untrusted).not.toMatch(/^__Host-/);
        }),
      (environment) => Effect.promise(() => environment.dispose()),
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);
