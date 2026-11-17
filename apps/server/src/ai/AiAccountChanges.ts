/**
 * Spec 4 ticket 11: a signal that who may use an AI account may have changed (a loan ended, an
 * account disabled or deleted), for whoever must check live processes again (`AiSessionReach`).
 * It carries nothing: each listener reads the rule anew.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

export class AiAccountChanges extends Context.Service<
  AiAccountChanges,
  {
    readonly changed: Effect.Effect<void>;
    readonly subscribe: Effect.Effect<Stream.Stream<void>, never, Scope.Scope>;
  }
>()("t3/ai/AiAccountChanges") {}

/**
 * One signal for the Hub: an instance already provided below (Grants', which also signal it) is
 * kept, so every writer and every listener share it however the layers are put together.
 */
export const layer = Layer.effect(
  AiAccountChanges,
  Effect.gen(function* () {
    const existing = yield* Effect.serviceOption(AiAccountChanges);
    if (Option.isSome(existing)) return existing.value;
    // A burst is one change: a listener reads the rule anew anyway.
    const changes = yield* PubSub.sliding<void>(1);
    return AiAccountChanges.of({
      changed: PubSub.publish(changes, undefined).pipe(Effect.asVoid),
      subscribe: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
    });
  }),
);
