/**
 * Workload identity files kept fresh (ticket 07): every few seconds SecretDelivery re-signs the
 * tokens of held folders past two thirds of their life, and this sends them to their machine as
 * `secrets.refreshFiles` (contract 16): the Hub machine's own folder directly, another machine's
 * over its executor socket. A machine that no longer holds the folder says so, and it is dropped.
 */
import {
  EnvironmentExecutorUnavailableError,
  HUB_MACHINE_ENVIRONMENT_ID,
  SecretFilesError,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import * as EnvironmentExecutor from "../environment/EnvironmentExecutor.ts";
import * as ThreadSecretFiles from "../secrets/ThreadSecretFiles.ts";
import * as SecretDelivery from "../vaults/SecretDelivery.ts";

/** How often due folders are looked for: well within a token's shortest third (20 s of 60 s). */
const TICK = Duration.seconds(10);

/** Sends a folder's new files where it is held: the Hub machine's, or a joined machine's. */
export const makeSender = (input: {
  readonly local: Option.Option<ThreadSecretFiles.ThreadSecretFiles["Service"]>;
  readonly registry: Option.Option<EnvironmentExecutor.EnvironmentExecutorRegistry["Service"]>;
}): SecretDelivery.SendSecretFiles =>
  Effect.fn("IdentityRefresher.send")(function* (environmentId, files) {
    if (environmentId === HUB_MACHINE_ENVIRONMENT_ID) {
      if (Option.isNone(input.local)) {
        return yield* new SecretFilesError({ reason: "invalid", detail: "No Secret files here." });
      }
      return yield* input.local.value.refresh(files);
    }
    if (Option.isNone(input.registry)) {
      return yield* new EnvironmentExecutorUnavailableError({ environmentId });
    }
    const executor = yield* input.registry.value.get(environmentId);
    const forward = executor.workspace.forward;
    if (Option.isNone(forward)) {
      return yield* new EnvironmentExecutorUnavailableError({ environmentId });
    }
    return yield* forward.value.call("secrets.refreshFiles", files);
  });

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const delivery = yield* Effect.serviceOption(SecretDelivery.SecretDelivery);
    if (Option.isNone(delivery)) return;
    const send = makeSender({
      local: yield* Effect.serviceOption(ThreadSecretFiles.ThreadSecretFiles),
      registry: yield* Effect.serviceOption(EnvironmentExecutor.EnvironmentExecutorRegistry),
    });
    yield* delivery.value
      .refreshIdentityFiles(send)
      .pipe(Effect.repeat(Schedule.spaced(TICK)), Effect.forkScoped);
  }),
);
