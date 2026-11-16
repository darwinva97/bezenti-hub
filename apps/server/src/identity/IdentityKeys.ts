// @effect-diagnostics nodeBuiltinImport:off -- ES256 keys and signatures come from node:crypto.
/**
 * The Hub's signing keys for workload identity (ADR 0009): ES256, each signing 30 days, the next
 * published 7 days before it signs and the last kept 7 days after. The private half is sealed in
 * the server's store and never leaves it; only public halves are published.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeCrypto from "node:crypto";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

const SIGNS_FOR = Duration.toMillis(Duration.days(30));
const PUBLISHED_BEFORE = Duration.toMillis(Duration.days(7));
const KEPT_AFTER = Duration.toMillis(Duration.days(7));

/** Where the private half of a key is sealed. `t3 secrets key import` drops these. */
const SIGNING_KEY_PREFIX = "identity-signing-";

/** A public key as published: these fields and nothing else (never `d`). */
export interface PublicJwk {
  readonly kty: "EC";
  readonly crv: "P-256";
  readonly x: string;
  readonly y: string;
  readonly kid: string;
  readonly alg: "ES256";
  readonly use: "sig";
}

export class IdentityKeysError extends Schema.TaggedError<IdentityKeysError>()(
  "IdentityKeysError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not read or rotate the Hub's identity signing keys.";
  }
}

export class IdentityKeys extends Context.Service<
  IdentityKeys,
  {
    /** The keys a verifier may meet now: the signing one, the next, and the last for 7 days. */
    readonly published: Effect.Effect<ReadonlyArray<PublicJwk>, IdentityKeysError>;
    /**
     * Signs (ES256, raw r‖s) what `dataFor` builds for the key of the moment, made if there is
     * none yet: a JWT names that key in the header it signs.
     */
    readonly sign: (
      dataFor: (kid: string) => Uint8Array,
    ) => Effect.Effect<{ readonly kid: string; readonly signature: Uint8Array }, IdentityKeysError>;
    /** Makes the next key when due and drops retired ones; also run every hour while keys exist. */
    readonly maintain: Effect.Effect<void, IdentityKeysError>;
  }
>()("t3/identity/IdentityKeys") {}

interface KeyRow {
  readonly kid: string;
  readonly publicJwk: string;
  readonly publishAt: string;
  readonly signFrom: string;
  readonly signUntil: string;
  readonly retireAt: string;
}

const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));
const millisOf = (value: string) => Date.parse(value);

/** RFC 7638: the SHA-256 of the required members, in order, base64url. */
const thumbprint = (x: string, y: string) =>
  NodeCrypto.createHash("sha256")
    .update(`{"crv":"P-256","kty":"EC","x":"${x}","y":"${y}"}`)
    .digest("base64url");

const newKeyPair = () => {
  const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pub = publicKey.export({ format: "jwk" });
  const priv = privateKey.export({ format: "jwk" });
  const kid = thumbprint(pub.x!, pub.y!);
  const publicJwk: PublicJwk = {
    kty: "EC",
    crv: "P-256",
    x: pub.x!,
    y: pub.y!,
    kid,
    alg: "ES256",
    use: "sig",
  };
  return { kid, publicJson: JSON.stringify(publicJwk), privateJwk: JSON.stringify(priv) };
};

/** Only the public members, whatever a stored row holds. */
const publicOf = (json: string): PublicJwk | undefined => {
  try {
    const parsed = JSON.parse(json) as Partial<PublicJwk>;
    if (
      typeof parsed.x !== "string" ||
      typeof parsed.y !== "string" ||
      typeof parsed.kid !== "string"
    ) {
      return undefined;
    }
    return {
      kty: "EC",
      crv: "P-256",
      x: parsed.x,
      y: parsed.y,
      kid: parsed.kid,
      alg: "ES256",
      use: "sig",
    };
  } catch {
    return undefined;
  }
};

const signWith = (privateJwk: string, data: Uint8Array) =>
  new Uint8Array(
    NodeCrypto.sign("sha256", data, {
      key: NodeCrypto.createPrivateKey({ key: JSON.parse(privateJwk), format: "jwk" }),
      dsaEncoding: "ieee-p1363",
    }),
  );

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* ServerSecretStore.ServerSecretStore;
  const failed = (cause: unknown) => new IdentityKeysError({ cause });

  const rows = sql<KeyRow>`
    SELECT kid, public_jwk AS "publicJwk", publish_at AS "publishAt", sign_from AS "signFrom",
      sign_until AS "signUntil", retire_at AS "retireAt"
    FROM identity_signing_keys ORDER BY sign_from
  `.pipe(Effect.mapError(failed));

  const add = Effect.fn("IdentityKeys.add")(function* (signFrom: number, publishAt: number) {
    const key = newKeyPair();
    // Sealed first: a row never names a key that is not there.
    yield* store.set(`${SIGNING_KEY_PREFIX}${key.kid}`, new TextEncoder().encode(key.privateJwk));
    yield* sql`
      INSERT INTO identity_signing_keys (kid, public_jwk, created_at, publish_at, sign_from,
        sign_until, retire_at)
      VALUES (${key.kid}, ${key.publicJson}, ${iso(publishAt)}, ${iso(publishAt)},
        ${iso(signFrom)}, ${iso(signFrom + SIGNS_FOR)}, ${iso(signFrom + SIGNS_FOR + KEPT_AFTER)})
    `;
  }, Effect.mapError(failed));

  const drop = Effect.fn("IdentityKeys.drop")(function* (kid: string) {
    yield* sql`DELETE FROM identity_signing_keys WHERE kid = ${kid}`;
    yield* store.remove(`${SIGNING_KEY_PREFIX}${kid}`);
  }, Effect.mapError(failed));

  /**
   * Drops retired keys and rows whose sealed half is gone (a restore drops them), then makes a
   * key to sign now if none does, and the next one 7 days before the current one ends.
   */
  const maintain = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    for (const row of yield* rows) {
      const sealed = yield* store
        .get(`${SIGNING_KEY_PREFIX}${row.kid}`)
        .pipe(Effect.mapError(failed));
      if (millisOf(row.retireAt) <= now || Option.isNone(sealed)) yield* drop(row.kid);
    }
    const kept = yield* rows;
    const current = kept.find(
      (row) => millisOf(row.signFrom) <= now && now < millisOf(row.signUntil),
    );
    if (current === undefined) {
      yield* add(now, now);
      return;
    }
    const until = millisOf(current.signUntil);
    const next = kept.some((row) => millisOf(row.signFrom) >= until);
    if (!next && now >= until - PUBLISHED_BEFORE) yield* add(until, now);
  }).pipe(Effect.withSpan("IdentityKeys.maintain"));

  const published = Effect.gen(function* () {
    yield* maintain;
    const now = yield* Clock.currentTimeMillis;
    return (yield* rows).flatMap((row) => {
      const key = publicOf(row.publicJwk);
      return key !== undefined && millisOf(row.publishAt) <= now && now < millisOf(row.retireAt)
        ? [key]
        : [];
    });
  });

  const sign = Effect.fn("IdentityKeys.sign")(function* (dataFor: (kid: string) => Uint8Array) {
    yield* maintain;
    const now = yield* Clock.currentTimeMillis;
    const current = (yield* rows).find(
      (row) => millisOf(row.signFrom) <= now && now < millisOf(row.signUntil),
    );
    if (current === undefined) return yield* failed("no signing key after maintenance");
    const sealed = yield* store
      .get(`${SIGNING_KEY_PREFIX}${current.kid}`)
      .pipe(Effect.mapError(failed));
    if (Option.isNone(sealed)) return yield* failed("the signing key's sealed half is gone");
    const signature = yield* Effect.try({
      try: () => signWith(new TextDecoder().decode(sealed.value), dataFor(current.kid)),
      catch: failed,
    });
    return { kid: current.kid, signature };
  });

  return IdentityKeys.of({ published, sign, maintain });
});

/** The service, with its hourly upkeep once any key exists (none is made by the upkeep alone). */
export const layer = Layer.effect(
  IdentityKeys,
  Effect.gen(function* () {
    const keys = yield* make;
    const sql = yield* SqlClient.SqlClient;
    const upkeep = Effect.gen(function* () {
      const any = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS "n" FROM identity_signing_keys
      `;
      if ((any[0]?.n ?? 0) > 0) yield* keys.maintain;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("IdentityKeys: upkeep failed", { cause: String(cause) }),
      ),
    );
    yield* upkeep.pipe(Effect.repeat(Schedule.spaced(Duration.hours(1))), Effect.forkScoped);
    return keys;
  }),
);
