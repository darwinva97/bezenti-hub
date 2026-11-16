/**
 * How a value read from a Secret provider is named among a Thread's delivered values
 * (`thread_secret_values.value_id`): an HMAC of it with the Hub's own key, never the value or its
 * plain hash. SecretMasker reads it back from `DeliveredValueStore` (DeliveredValues).
 */
// @effect-diagnostics nodeBuiltinImport:off -- HMAC of a value, synchronously.
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

const PREFIX = "delivered:";
/** The store's own name of the key the HMACs are made with: 32 random bytes, made once. */
const FINGERPRINT_KEY = "vault-fingerprint-key";

/** The HMAC key: made the first time a Provider entry is delivered, kept sealed in the store. */
export const fingerprintKey = Effect.gen(function* () {
  const store = yield* ServerSecretStore.ServerSecretStore;
  return yield* store.getOrCreateRandom(FINGERPRINT_KEY, 32);
});

/** The store id of a delivered value: an HMAC of it with the Hub's own key. */
export const deliveredIdOf = (key: Uint8Array, value: string): string =>
  NodeCrypto.createHmac("sha256", key).update(value, "utf8").digest("hex");

/** The masker's value id of a delivered value. */
export const deliveredValueId = (id: string) => `${PREFIX}${id}`;

/** For SQL that picks delivered rows (`value_id LIKE …`). */
export const DELIVERED_VALUE_ID_PATTERN = `${PREFIX}%`;

/** The store id a masker value id names, when it is a delivered value's. */
export const storeIdOfValueId = (valueId: string): string | undefined =>
  valueId.startsWith(PREFIX) && valueId.length > PREFIX.length
    ? valueId.slice(PREFIX.length)
    : undefined;
