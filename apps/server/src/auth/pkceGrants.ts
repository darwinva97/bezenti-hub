// What app sign-in and `t3 join` share: grants a browser approves for an app that proves itself
// with the PKCE verifier (RFC 7636, S256), held in memory for a short time.
import { isAppSignInCodeVerifier } from "@t3tools/shared/appSignIn";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { base64UrlEncode, timingSafeEqualBase64Url } from "./utils.ts";

export const makePkce = Effect.gen(function* () {
  const digester = yield* Digest.Digest;
  const sha256 = (value: string) =>
    digester.digest(Digest.sha256, new TextEncoder().encode(value)).pipe(
      Effect.orDie,
      Effect.map((digest) => base64UrlEncode(digest)),
    );
  /** Whether the verifier is the one the challenge was made from. */
  const verifies = (verifier: string, challenge: string) =>
    isAppSignInCodeVerifier(verifier)
      ? sha256(verifier).pipe(Effect.map((digest) => timingSafeEqualBase64Url(digest, challenge)))
      : Effect.succeed(false);
  return { sha256, verifies };
});

/**
 * Pending grants by key, each with its own expiry. Expired ones are dropped on every write, and
 * past `capacity` the oldest go first, so callers that need no session cannot grow it.
 */
export const makeGrantStore = <V extends { readonly expiresAtMs: number }>(capacity: number) =>
  Effect.map(Ref.make<ReadonlyMap<string, V>>(new Map()), (grants) => ({
    put: (key: string, value: V, nowMs: number) =>
      Ref.update(grants, (current) => {
        const next = new Map(Array.from(current).filter(([, grant]) => grant.expiresAtMs > nowMs));
        next.set(key, value);
        for (const oldest of next.keys()) {
          if (next.size <= capacity) break;
          next.delete(oldest);
        }
        return next;
      }),
    /** Adds the grant only while fewer than `limit` live ones are held: never evicts another. */
    putIfRoom: (key: string, value: V, nowMs: number, limit: number) =>
      Ref.modify(grants, (current) => {
        const next = new Map(Array.from(current).filter(([, grant]) => grant.expiresAtMs > nowMs));
        if (next.size >= limit) return [false, next] as const;
        next.set(key, value);
        return [true, next] as const;
      }),
    get: (key: string, nowMs: number) =>
      Effect.map(Ref.get(grants), (current) => {
        const grant = current.get(key);
        return grant !== undefined && grant.expiresAtMs > nowMs ? grant : undefined;
      }),
    /** Removes the grant and returns it, expired or not: a presented code is spent. */
    take: (key: string) =>
      Ref.modify(grants, (current) => {
        const grant = current.get(key);
        if (grant === undefined) return [undefined, current] as const;
        const next = new Map(current);
        next.delete(key);
        return [grant, next] as const;
      }),
    /** Replaces a live grant; answers the new value, or undefined when there was none. */
    update: (key: string, nowMs: number, change: (grant: V) => V) =>
      Ref.modify(grants, (current) => {
        const grant = current.get(key);
        if (grant === undefined || grant.expiresAtMs <= nowMs) return [undefined, current] as const;
        const changed = change(grant);
        return [changed, new Map(current).set(key, changed)] as const;
      }),
  }));
