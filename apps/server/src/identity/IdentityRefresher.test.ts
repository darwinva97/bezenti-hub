/** Workload identity files (ticket 07) go back to the machine that holds their folder. */
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  HUB_MACHINE_ENVIRONMENT_ID,
  type SecretFilesRefreshInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as EnvironmentExecutor from "../environment/EnvironmentExecutor.ts";
import type * as ThreadSecretFiles from "../secrets/ThreadSecretFiles.ts";
import { makeSender } from "./IdentityRefresher.ts";

const FILES: SecretFilesRefreshInput = {
  filesFolder: "0123456789abcdef0123456789abcdef",
  files: [{ name: "KUBE_TOKEN", content: "header.payload.signature", mode: 0o600 }],
};
const LAPTOP = EnvironmentId.make("environment:laptop");

it.effect("sends the Hub machine's folder to its own files, another's over its socket", () =>
  Effect.gen(function* () {
    const local: Array<SecretFilesRefreshInput> = [];
    const remote: Array<[string, unknown]> = [];
    const executor = (forward: boolean) =>
      ({
        workspace: {
          forward: forward
            ? Option.some({
                call: (operation: string, input: unknown) =>
                  Effect.sync(() => {
                    remote.push([operation, input]);
                    return "not-held" as const;
                  }),
              })
            : Option.none(),
        },
      }) as unknown as EnvironmentExecutor.EnvironmentExecutor;
    const send = makeSender({
      local: Option.some({
        refresh: (input: SecretFilesRefreshInput) =>
          Effect.sync(() => {
            local.push(input);
            return "refreshed" as const;
          }),
      } as unknown as ThreadSecretFiles.ThreadSecretFiles["Service"]),
      registry: Option.some({
        get: (environmentId: EnvironmentId) => Effect.succeed(executor(environmentId === LAPTOP)),
      } as unknown as EnvironmentExecutor.EnvironmentExecutorRegistry["Service"]),
    });
    assert.strictEqual(yield* send(HUB_MACHINE_ENVIRONMENT_ID, FILES), "refreshed");
    assert.deepStrictEqual(local, [FILES]);
    assert.strictEqual(yield* send(LAPTOP, FILES), "not-held");
    assert.deepStrictEqual(remote, [["secrets.refreshFiles", FILES]]);
    // A machine not connected now: a failure, tried again later; nothing is sent elsewhere.
    const offline = yield* send(EnvironmentId.make("environment:other"), FILES).pipe(Effect.flip);
    assert.strictEqual(offline._tag, "EnvironmentExecutorUnavailableError");
    // Without Secret files on the Hub machine, its own folder is refused.
    const bare = makeSender({ local: Option.none(), registry: Option.none() });
    assert.strictEqual(
      (yield* bare(HUB_MACHINE_ENVIRONMENT_ID, FILES).pipe(Effect.flip))._tag,
      "SecretFilesError",
    );
  }),
);
