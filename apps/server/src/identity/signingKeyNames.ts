/**
 * Where the private half of each workload identity signing key is sealed in the server's store.
 * `t3 secrets key import` drops these: a restored Hub makes new keys (ADR 0009, ticket 07).
 */
export const IDENTITY_SIGNING_KEY_PREFIX = "identity-signing-";
