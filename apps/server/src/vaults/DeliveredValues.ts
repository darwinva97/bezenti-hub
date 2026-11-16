/**
 * Values read from Secret providers that a Thread received, kept sealed only to mask them there
 * (`delivered:<id>` rows). A Thread's deletion removes its rows and every value no other Thread
 * holds; the start sweeps what a stop left behind.
 */
import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import {
  DELIVERED_VALUE_ID_PATTERN,
  deliveredValueId,
  storeIdOfValueId,
} from "./deliveredValueId.ts";
import * as ThreadSecretValues from "./ThreadSecretValues.ts";

/**
 * A Thread deleted: its delivered rows go, and each value no other Thread holds leaves the store.
 * Exported for the tests that delete a Thread by its event.
 */
export const forgetThread = Effect.fn("DeliveredValues.forgetThread")(function* (threadId: string) {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* ServerSecretStore.DeliveredValueStore;
  const gone = yield* sql<{ readonly valueId: string }>`
    DELETE FROM thread_secret_values
    WHERE thread_id = ${threadId} AND value_id LIKE ${DELIVERED_VALUE_ID_PATTERN}
    RETURNING value_id AS "valueId"
  `;
  for (const { valueId } of gone) {
    const held = yield* ThreadSecretValues.heldByThread(sql, valueId);
    const id = storeIdOfValueId(valueId);
    if (!held && id !== undefined) yield* store.remove(id);
  }
});

/** The start: rows of deleted and gone Threads go (ThreadSecretValues), then values none holds. */
export const sweep = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* ServerSecretStore.DeliveredValueStore;
  const held = yield* ThreadSecretValues.pruneAndListHeld(sql);
  let removed = 0;
  for (const id of yield* store.list) {
    if (held.has(deliveredValueId(id))) continue;
    yield* store.remove(id).pipe(Effect.ignore);
    removed += 1;
  }
  if (removed > 0) {
    yield* Effect.logInfo("DeliveredValues: removed values no Thread holds", { removed });
  }
});

const logged = Effect.catchCause((cause) =>
  Effect.logWarning("DeliveredValues: could not forget a deleted Thread's values", { cause }),
);

/** Sweeps at the start, then forgets each deleted Thread's delivered values as it goes. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const context = yield* Effect.context<
      SqlClient.SqlClient | ServerSecretStore.DeliveredValueStore
    >();
    yield* sweep.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("DeliveredValues: could not sweep values no Thread holds", { cause }),
      ),
    );
    yield* orchestrator.streamDomainEvents.pipe(
      Stream.runForEach((event: OrchestrationV2DomainEvent) =>
        event.type === "thread.deleted"
          ? forgetThread(event.threadId).pipe(Effect.provide(context), logged)
          : Effect.void,
      ),
      logged,
      Effect.forkScoped,
    );
  }),
);
