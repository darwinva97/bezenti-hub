/**
 * The configured realm's discovery document and key set (Keycloak sign-in spec), one at a time,
 * read again after REALM_TTL or for another issuer. Shared by the sign-in flows, the re-checks and
 * the back-channel logout (ticket 07), so all verify with the same keys. jose's remote key set keeps
 * its own cache and refetches for an unknown `kid`.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type * as Jwks from "effect/jose/Jwks";

import * as KeycloakClient from "./KeycloakClient.ts";

/** How long a realm's discovery document and key set are kept before being read again. */
const REALM_TTL = Duration.minutes(10);

export interface Realm {
  readonly issuer: string;
  readonly discovery: KeycloakClient.KeycloakDiscovery;
  readonly keys: Jwks.Jwks["Service"];
}

interface CachedRealm extends Realm {
  readonly scope: Scope.Closeable;
  readonly expiresAtMs: number;
}

export class KeycloakRealm extends Context.Service<
  KeycloakRealm,
  {
    readonly realmFor: (issuer: string) => Effect.Effect<Realm, KeycloakClient.KeycloakProblem>;
  }
>()("t3/auth/KeycloakRealm") {}

const make = Effect.gen(function* () {
  const keycloak = yield* KeycloakClient.KeycloakClient;
  let realm: CachedRealm | undefined;
  const lock = yield* Semaphore.make(1);
  const dropRealm = Effect.suspend(() => {
    const current = realm;
    realm = undefined;
    return current === undefined ? Effect.void : Scope.close(current.scope, Exit.void);
  });
  yield* Effect.addFinalizer(() => dropRealm);
  const realmFor = (issuer: string) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (realm !== undefined && realm.issuer === issuer && realm.expiresAtMs > now) {
          return realm as Realm;
        }
        yield* dropRealm;
        const discovery = yield* keycloak.discover(issuer);
        const scope = yield* Scope.make();
        const keys = yield* keycloak.keySet(discovery).pipe(
          Scope.provide(scope),
          Effect.onError(() => Scope.close(scope, Exit.void)),
        );
        const fresh: CachedRealm = {
          issuer,
          discovery,
          keys,
          scope,
          expiresAtMs: now + Duration.toMillis(REALM_TTL),
        };
        realm = fresh;
        return fresh as Realm;
      }),
    );
  return KeycloakRealm.of({ realmFor });
});

export const layer = Layer.effect(KeycloakRealm, make);
