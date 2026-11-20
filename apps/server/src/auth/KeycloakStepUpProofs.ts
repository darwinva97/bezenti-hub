/**
 * Proofs of a fresh confirmation through Keycloak (ticket 06, `step-up`), spent by
 * `UserDirectory.requireStepUp`/`confirmStrongFactor`: single-use, 5 minutes, only for the browser
 * session and User that started the flow. In memory, like the flows.
 */
import type { AuthSessionId, UserId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { makeGrantStore } from "./pkceGrants.ts";
import { base64UrlEncode } from "./utils.ts";

/** Long enough to come back and press «Approve», short enough that a stray one dies. */
const PROOF_TTL = Duration.minutes(5);
/** Proofs held on the whole Hub; past it the oldest go. One per session at most. */
const MAX_PROOFS = 10_000;
/** The longest id `consume` reads; anything longer is no proof of ours. */
const MAX_PROOF_ID_LENGTH = 128;

/** What the confirmation at Keycloak showed. */
export interface StepUpProof {
  readonly userId: UserId;
  readonly sessionId: AuthSessionId;
  /** Whether that sign-in was strong under the Owner's lists (`KeycloakAdmission.loginIsStrong`). */
  readonly strong: boolean;
  /** When the person authenticated at Keycloak (`auth_time`, epoch seconds). */
  readonly authTime: number;
}

interface Held extends StepUpProof {
  readonly expiresAtMs: number;
}

export class KeycloakStepUpProofs extends Context.Service<
  KeycloakStepUpProofs,
  {
    /** A new proof for this session (its previous one, if any, is gone); the id to hand back. */
    readonly issue: (proof: StepUpProof) => Effect.Effect<string>;
    /**
     * Spends the proof, whoever presents it: what it showed when it is live and was issued to this
     * very session and User, else undefined. A proof presented by anyone else is gone too: it
     * leaked, and its owner confirms again.
     */
    readonly consume: (input: {
      readonly proofId: string;
      readonly userId: UserId;
      readonly sessionId: AuthSessionId;
    }) => Effect.Effect<StepUpProof | undefined>;
  }
>()("t3/auth/KeycloakStepUpProofs") {}

const make = Effect.gen(function* () {
  const random = yield* SecureRandom.SecureRandom;
  const digester = yield* Digest.Digest;
  const proofs = yield* makeGrantStore<Held>(MAX_PROOFS);
  /** Each session's live proof key, so a new one replaces it. */
  const bySession = new Map<AuthSessionId, string>();

  // Held by digest: a dump of this map gives no usable id.
  const keyOf = (proofId: string) =>
    digester.digest(Digest.sha256, new TextEncoder().encode(proofId)).pipe(
      Effect.orDie,
      Effect.map((digest) => base64UrlEncode(digest)),
    );

  const issue: KeycloakStepUpProofs["Service"]["issue"] = Effect.fn("KeycloakStepUpProofs.issue")(
    function* (proof) {
      const proofId = base64UrlEncode(yield* random.randomBytes(32).pipe(Effect.orDie));
      const key = yield* keyOf(proofId);
      const nowMs = yield* Clock.currentTimeMillis;
      const previous = bySession.get(proof.sessionId);
      if (previous !== undefined) yield* proofs.take(previous);
      yield* proofs.put(
        key,
        { ...proof, expiresAtMs: nowMs + Duration.toMillis(PROOF_TTL) },
        nowMs,
      );
      bySession.set(proof.sessionId, key);
      return proofId;
    },
  );

  const consume: KeycloakStepUpProofs["Service"]["consume"] = Effect.fn(
    "KeycloakStepUpProofs.consume",
  )(function* ({ proofId, userId, sessionId }) {
    if (proofId.length === 0 || proofId.length > MAX_PROOF_ID_LENGTH) return undefined;
    const key = yield* keyOf(proofId);
    // One take: two requests racing with the same id get it once between them.
    const held = yield* proofs.take(key);
    if (held === undefined) return undefined;
    if (bySession.get(held.sessionId) === key) bySession.delete(held.sessionId);
    const nowMs = yield* Clock.currentTimeMillis;
    if (held.expiresAtMs <= nowMs || held.sessionId !== sessionId || held.userId !== userId) {
      return undefined;
    }
    return {
      userId: held.userId,
      sessionId: held.sessionId,
      strong: held.strong,
      authTime: held.authTime,
    } satisfies StepUpProof;
  });

  return KeycloakStepUpProofs.of({ issue, consume });
});

export const layer = Layer.effect(KeycloakStepUpProofs, make);
