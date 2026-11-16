/**
 * Where each machine writes Secret files (executor contract 14), as the Hub knows it: the Hub
 * machine's own root, and each joined machine's from its last hello. SecretDelivery sends files
 * only to a machine whose root is in memory, and renders `{{ X | path }}` under that root.
 */
import {
  type EnvironmentId,
  HUB_MACHINE_ENVIRONMENT_ID,
  type SecretFilesRoot,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ThreadSecretFiles from "../secrets/ThreadSecretFiles.ts";

export class MachineSecretFiles extends Context.Service<
  MachineSecretFiles,
  {
    /** The machine's root; undefined when it never said (a machine before contract 14). */
    readonly rootOf: (environmentId: EnvironmentId) => SecretFilesRoot | undefined;
    /** What a joined machine said in its hello (null: no folder at all). */
    readonly remember: (
      environmentId: EnvironmentId,
      root: SecretFilesRoot | null | undefined,
    ) => void;
  }
>()("t3/environment/MachineSecretFiles") {}

const NONE: SecretFilesRoot = { path: "", inMemory: false };

export const layer = Layer.effect(
  MachineSecretFiles,
  Effect.gen(function* () {
    const local = yield* Effect.serviceOption(ThreadSecretFiles.ThreadSecretFiles);
    const joined = new Map<EnvironmentId, SecretFilesRoot>();
    return MachineSecretFiles.of({
      rootOf: (environmentId) =>
        environmentId === HUB_MACHINE_ENVIRONMENT_ID
          ? Option.match(local, { onNone: () => NONE, onSome: (files) => files.root })
          : joined.get(environmentId),
      remember: (environmentId, root) => {
        if (root === undefined) joined.delete(environmentId);
        else joined.set(environmentId, root ?? NONE);
      },
    });
  }),
);
