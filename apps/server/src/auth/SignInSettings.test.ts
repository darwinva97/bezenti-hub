/**
 * The Owner's sign-in settings at the server's edge (Keycloak sign-in spec, ticket 01): the real
 * HTTP doors over SQLite in memory and a fake Keycloak realm, never the network. Only the Owner
 * reads or changes them, «Check» asks only the saved realm, and the client secret never comes
 * back out: no answer, log, span, audit entry or settings row holds it.
 */
import { UserId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Tracer from "effect/Tracer";

import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SignInSettings from "./SignInSettings.ts";
import { discoveryDocument, type FakeKeycloak, makeFakeKeycloak } from "./Keycloak.testkit.ts";
import {
  addMember,
  bootstrapOwner,
  joinOrganization,
  makeAuthenticator,
  type Server,
  serveAuthHttpWith,
  type TestSignInOptions,
} from "./UserAuth.testkit.ts";

const SETTINGS = "/api/installation/sign-in-settings";
const CHECK = "/api/installation/sign-in-settings/check";
/** Stands for the realm's client secret: it must never show up anywhere it is looked for. */
const SECRET = "kc-client-secret-6f1d0c9e-never-shown";

/** The Owner's Hub over a fake realm, with Acme and an Admin, a Member and a Guest of it. */
const hub = (options: { readonly signIn?: Omit<TestSignInOptions, "keycloakHttp"> } = {}) =>
  Effect.gen(function* () {
    const realm = yield* makeFakeKeycloak();
    const server = yield* serveAuthHttpWith({
      signIn: { ...options.signIn, keycloakHttp: realm.layer },
    });
    const { created } = yield* bootstrapOwner(server, yield* makeAuthenticator());
    const owner = created.cookie ?? "";
    const ownerId = UserId.make((created.body.user as { id: string }).id);
    const acme = yield* server.request("/api/spaces/organizations", {
      body: { name: "Acme" },
      cookie: owner,
    });
    const acmeId = acme.body.id as string;
    const inAcme = Effect.fn(function* (id: string, role: "admin" | "member" | "guest") {
      const cookie = yield* addMember(server, { id, displayName: id });
      yield* joinOrganization(server, acmeId, id, role);
      return cookie;
    });
    return {
      realm,
      server,
      owner,
      ownerId,
      admin: yield* inAcme("acme-admin", "admin"),
      member: yield* inAcme("acme-member", "member"),
      guest: yield* inAcme("acme-guest", "guest"),
      loner: yield* addMember(server, { id: "no-organization", displayName: "Loner" }),
    };
  });

const save = (server: Server, cookie: string, body: Record<string, unknown>) =>
  server.request(SETTINGS, { body, cookie });

/** Everything the Owner fills in for the fake realm, Keycloak still off. */
const configure = (server: Server, owner: string, realm: FakeKeycloak) =>
  save(server, owner, { issuer: realm.issuer, clientId: "t3-hub", clientSecret: SECRET });

const storedSecret = (server: Server) =>
  Context.get(server.services, ServerSecretStore.ServerSecretStore)
    .get(SignInSettings.CLIENT_SECRET_NAME)
    .pipe(Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes))));

const auditEntries = (server: Server, owner: string) =>
  server.request("/api/installation/audit?action=signIn.settings.update", { cookie: owner }).pipe(
    Effect.map(
      (page) =>
        page.body.entries as ReadonlyArray<{
          readonly action: string;
          readonly detail: Record<string, unknown>;
        }>,
    ),
  );

describe("sign-in settings (Keycloak 01)", () => {
  it.effect("the Owner fills in Keycloak, checks the realm and turns it on", () =>
    Effect.gen(function* () {
      const { server, owner, realm } = yield* hub();

      // An Installation starts as it is today: invitation only, local sign-in, no Keycloak.
      const fresh = yield* server.request(SETTINGS, { cookie: owner });
      assert.equal(fresh.status, 200);
      assert.deepInclude(fresh.body, {
        registrationMode: "invitation-only",
        localSignInForMembers: true,
        publicOrigin: null,
      });
      assert.deepInclude(fresh.body.keycloak as object, {
        enabled: false,
        issuer: null,
        clientSecretSet: false,
        groupsClaim: "groups",
      });

      const saved = yield* save(server, owner, {
        issuer: `${realm.issuer}/`,
        clientId: " t3-hub ",
        clientSecret: SECRET,
        registrationMode: "closed",
      });
      assert.equal(saved.status, 200);
      assert.deepInclude(saved.body.keycloak as object, {
        enabled: false,
        issuer: realm.issuer,
        clientId: "t3-hub",
        clientSecretSet: true,
      });
      assert.equal(saved.body.registrationMode, "closed");
      assert.equal(Option.getOrNull(yield* storedSecret(server)), SECRET);

      const checked = yield* server.request(CHECK, { body: {}, cookie: owner });
      assert.equal(checked.status, 200);
      assert.deepInclude(checked.body, { _tag: "ok", signingKeys: 1 });

      const on = yield* save(server, owner, { keycloakEnabled: true });
      assert.equal(on.status, 200);
      assert.equal((on.body.keycloak as { enabled: boolean }).enabled, true);

      // Ticket 02 signs in with this; no door returns it.
      const config = yield* Context.get(server.services, SignInSettings.SignInSettings)
        .keycloakConfig;
      assert.isTrue(Option.isSome(config));

      const entries = yield* auditEntries(server, owner);
      assert.equal(entries.length, 2);
      assert.deepInclude(entries[1]!.detail, {
        changed: "registrationMode, issuer, clientId, clientSecret",
        secretReplaced: true,
        issuer: realm.issuer,
      });
      assert.deepInclude(entries[0]!.detail, { changed: "keycloakEnabled", secretReplaced: false });
    }).pipe(Effect.scoped),
  );

  it.effect("anyone but the Owner gets the same 403 on every door", () =>
    Effect.gen(function* () {
      const { server, owner, ownerId, admin, member, guest, loner, realm } = yield* hub();
      yield* configure(server, owner, realm);
      const doors = [
        (cookie: string) => server.request(SETTINGS, { cookie }),
        (cookie: string) => save(server, cookie, { registrationMode: "open" }),
        (cookie: string) => save(server, cookie, { clientSecret: "attacker-secret" }),
        (cookie: string) => server.request(CHECK, { body: {}, cookie }),
      ];
      for (const [who, cookie] of [
        ["Admin", admin],
        ["Member", member],
        ["Guest", guest],
        ["a User in no Organization", loner],
      ] as const) {
        for (const door of doors) {
          const answer = yield* door(cookie);
          assert.equal(answer.status, 403, who);
          assert.deepEqual(
            answer.body,
            {
              _tag: "EnvironmentHttpForbiddenError",
              message: "Only the Owner manages the sign-in settings.",
            },
            who,
          );
        }
      }
      // Nothing they sent changed anything, and «Check» never went out for them.
      assert.equal(Option.getOrNull(yield* storedSecret(server)), SECRET);
      assert.deepEqual(realm.requests, []);
      const settings = yield* server.request(SETTINGS, { cookie: owner });
      assert.equal(settings.body.registrationMode, "invitation-only");

      // A session of the Owner's that only reads: it reads, and changes nothing.
      const readOnly = yield* server.environmentAuth.issueSession({
        userId: ownerId,
        scopes: ["access:read"],
      });
      const authorization = `Bearer ${readOnly.token}`;
      assert.equal((yield* server.request(SETTINGS, { authorization })).status, 200);
      const refused = yield* server.request(SETTINGS, {
        authorization,
        body: { registrationMode: "open" },
      });
      assert.equal(refused.status, 403);
      assert.equal(refused.body.code, "insufficient_scope");
      assert.equal(
        (yield* server.request(CHECK, { authorization, body: {} })).body.code,
        "insufficient_scope",
      );
      // Without a session at all.
      assert.equal((yield* server.request(SETTINGS, {})).status, 401);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "Keycloak only turns on past a passing Check, and a realm naming another issuer fails",
    () =>
      Effect.gen(function* () {
        const { server, owner, realm } = yield* hub();
        // Not before the issuer, client id and secret are all there.
        const early = yield* save(server, owner, { keycloakEnabled: true, issuer: realm.issuer });
        assert.equal(early.status, 400);
        assert.include(early.body.message as string, "client id and client secret");

        yield* configure(server, owner, realm);
        realm.serve(realm.discoveryUrl, {
          json: {
            ...discoveryDocument(realm.issuer),
            issuer: "https://keycloak.test/realms/other",
          },
        });
        const checked = yield* server.request(CHECK, { body: {}, cookie: owner });
        assert.deepInclude(checked.body, {
          _tag: "failed",
          step: "discovery",
          reason: "issuer-mismatch",
        });
        assert.include(checked.body.message as string, "https://keycloak.test/realms/other");

        const refused = yield* save(server, owner, {
          keycloakEnabled: true,
          registrationMode: "open",
        });
        assert.equal(refused.status, 400);
        assert.include(refused.body.message as string, "nothing was saved");
        const after = yield* server.request(SETTINGS, { cookie: owner });
        assert.equal((after.body.keycloak as { enabled: boolean }).enabled, false);
        assert.equal(after.body.registrationMode, "invitation-only");
        assert.equal((yield* auditEntries(server, owner)).length, 1);

        realm.serve(realm.discoveryUrl, { json: discoveryDocument(realm.issuer) });
        assert.equal((yield* save(server, owner, { keycloakEnabled: true })).status, 200);
        // Once on, the Owner can't move it to a realm that fails Check either.
        const moved = yield* save(server, owner, { issuer: "https://keycloak.test/realms/gone" });
        assert.equal(moved.status, 400);
        // Every request went to the configured issuer's host, nowhere else.
        assert.deepEqual(
          [...new Set(realm.requests.map((url) => new URL(url).host))],
          ["keycloak.test"],
        );
      }).pipe(Effect.scoped),
  );

  it.effect("the issuer must be https (http only on loopback); Check asks only the saved one", () =>
    Effect.gen(function* () {
      const { server, owner, realm } = yield* hub();
      const nothing = yield* server.request(CHECK, { body: {}, cookie: owner });
      assert.deepInclude(nothing.body, { _tag: "failed", reason: "not-configured" });
      for (const issuer of [
        "http://auth.example.com/realms/acme",
        "https://auth.example.com/realms/acme?kc_idp_hint=x",
        "not a url",
        "",
      ]) {
        const refused = yield* save(server, owner, { issuer });
        assert.equal(refused.status, 400, issuer);
      }
      assert.equal(
        (yield* save(server, owner, { issuer: "http://localhost:8080/realms/dev" })).status,
        200,
      );
      assert.deepEqual(realm.requests, []);
    }).pipe(Effect.scoped),
  );

  it.effect("local sign-in for others needs Keycloak on; turning Keycloak off brings it back", () =>
    Effect.gen(function* () {
      const { server, owner, realm } = yield* hub();
      const refused = yield* save(server, owner, { localSignInForMembers: false });
      assert.equal(refused.status, 400);
      yield* configure(server, owner, realm);
      const off = yield* save(server, owner, {
        keycloakEnabled: true,
        localSignInForMembers: false,
      });
      assert.equal(off.status, 200);
      assert.equal(off.body.localSignInForMembers, false);
      const keycloakOff = yield* save(server, owner, { keycloakEnabled: false });
      assert.equal(keycloakOff.body.localSignInForMembers, true);
      // Its configuration stays.
      assert.deepInclude(keycloakOff.body.keycloak as object, {
        issuer: realm.issuer,
        clientId: "t3-hub",
        clientSecretSet: true,
      });
    }).pipe(Effect.scoped),
  );

  it.effect("saving without a secret keeps the saved one; a new one replaces it", () =>
    Effect.gen(function* () {
      const { server, owner, realm } = yield* hub();
      yield* configure(server, owner, realm);
      yield* save(server, owner, { clientId: "t3-hub-2", strongAcr: ["critica", " critica "] });
      assert.equal(Option.getOrNull(yield* storedSecret(server)), SECRET);
      const read = yield* server.request(SETTINGS, { cookie: owner });
      assert.deepInclude(read.body.keycloak as object, {
        clientId: "t3-hub-2",
        clientSecretSet: true,
        strongAcr: ["critica"],
      });
      const replaced = yield* save(server, owner, { clientSecret: "kc-second-secret" });
      assert.equal(replaced.status, 200);
      assert.equal(Option.getOrNull(yield* storedSecret(server)), "kc-second-secret");
      for (const clientSecret of ["", "  ", " padded "]) {
        assert.equal((yield* save(server, owner, { clientSecret })).status, 400);
      }
      assert.equal(Option.getOrNull(yield* storedSecret(server)), "kc-second-secret");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "a secret the store refuses after the commit: the Owner is told, and it reads as missing",
    () => {
      let refuse = true;
      return Effect.gen(function* () {
        const { server, owner, realm } = yield* hub({
          signIn: {
            secretStore: (store) => ({
              ...store,
              set: (name, value) =>
                refuse && name === SignInSettings.CLIENT_SECRET_NAME
                  ? Effect.fail(
                      new ServerSecretStore.SecretStorePersistError({
                        resource: name,
                        cause: new Error("disk full"),
                      }),
                    )
                  : store.set(name, value),
            }),
          },
        });
        const failed = yield* configure(server, owner, realm);
        assert.equal(failed.status, 500);
        assert.equal(failed.body.reason, "sign_in_secret_not_stored");
        // The row and its audit entry are saved; the secret is not, and nothing says it is.
        const read = yield* server.request(SETTINGS, { cookie: owner });
        assert.deepInclude(read.body.keycloak as object, {
          issuer: realm.issuer,
          clientSecretSet: false,
          clientSecretUpdatedAt: null,
        });
        assert.isTrue(Option.isNone(yield* storedSecret(server)));
        // So Keycloak can't be turned on until a secret is stored.
        assert.equal((yield* save(server, owner, { keycloakEnabled: true })).status, 400);
        refuse = false;
        const again = yield* save(server, owner, { clientSecret: SECRET, keycloakEnabled: true });
        assert.equal(again.status, 200);
        assert.equal((again.body.keycloak as { clientSecretSet: boolean }).clientSecretSet, true);
      }).pipe(Effect.scoped);
    },
  );

  it.effect("the secret never comes back out: answers, logs, spans, audit and the table", () => {
    const recorded: Array<string> = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        const end = span.end.bind(span);
        span.end = (endTime, exit) => {
          recorded.push(
            span.name,
            ...Array.from(span.attributes.values(), (value) => String(value)),
            ...span.events.map((event) =>
              JSON.stringify(event, (_key, value) =>
                typeof value === "bigint" ? String(value) : value,
              ),
            ),
            String(exit),
          );
          end(endTime, exit);
        };
        return span;
      },
    });
    const logger = Logger.make((options) => {
      recorded.push(
        String(options.message),
        String(options.cause),
        JSON.stringify(options.fiber.getRef(References.CurrentLogAnnotations)),
      );
    });
    return Effect.gen(function* () {
      const { server, owner, realm } = yield* hub();
      const answers = [
        yield* configure(server, owner, realm),
        yield* server.request(SETTINGS, { cookie: owner }),
        yield* server.request(CHECK, { body: {}, cookie: owner }),
        yield* save(server, owner, { keycloakEnabled: true, clientSecret: SECRET }),
        // Refused with the secret in the request: bad input, then a failing Check.
        yield* save(server, owner, { clientSecret: SECRET, issuer: "http://nope.example" }),
        yield* save(server, owner, { clientSecret: ` ${SECRET}` }),
      ];
      realm.serve(realm.discoveryUrl, { status: 500 });
      answers.push(
        yield* server.request(CHECK, { body: {}, cookie: owner }),
        yield* save(server, owner, {
          clientSecret: SECRET,
          issuer: "https://keycloak.test/realms/other",
        }),
        yield* server.request("/api/installation/audit", { cookie: owner }),
      );
      assert.deepEqual(
        answers.map((answer) => answer.status),
        [200, 200, 200, 200, 400, 400, 200, 400, 200],
      );
      const rows = [
        ...(yield* server.sql`SELECT * FROM sign_in_settings`),
        ...(yield* server.sql`SELECT * FROM audit_log`),
      ];
      assert.isAbove(rows.length, 1);
      const seen = [
        ...answers.map((answer) => JSON.stringify(answer.body)),
        ...rows.map((row) => JSON.stringify(row)),
        ...recorded,
      ];
      assert.isAbove(recorded.length, 10, "the logger and tracer recorded the requests");
      assert.deepEqual(
        seen.filter((text) => text.includes(SECRET)),
        [],
        "the client secret came back out",
      );
      // Not vacuous: the Hub does hold it.
      assert.equal(Option.getOrNull(yield* storedSecret(server)), SECRET);
    }).pipe(
      Effect.scoped,
      Effect.withTracer(tracer),
      Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
      Effect.provideService(References.MinimumLogLevel, "All"),
    );
  });
});
