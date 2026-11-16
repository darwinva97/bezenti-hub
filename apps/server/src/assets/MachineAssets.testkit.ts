/**
 * A Thread's machine for asset tests, in process: a folder served with the machine's own
 * `files.inspectAsset` and `files.streamAsset`, whose answers a test can tamper with.
 */
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import {
  inspectOnMachine,
  type MachineAssetItem,
  type MachineAssetSource,
  readOnMachine,
} from "./MachineAssets.ts";

export const LAPTOP = EnvironmentId.make("environment:laptop");

export const machineOver = (
  root: string,
  options: {
    /** What the machine sends for a window, instead of what it read. */
    readonly tamper?: (items: ReadonlyArray<MachineAssetItem>) => Stream.Stream<MachineAssetItem>;
    /** What the machine answers when the Hub inspects a file, instead of looking. */
    readonly inspect?: MachineAssetSource["inspect"];
  } = {},
): MachineAssetSource => {
  const workspace = {
    root,
    inside: (relative: string) => Effect.succeed(`${root}/${relative}`),
  };
  const notInternal = () => Effect.succeed(false);
  return {
    environmentId: LAPTOP,
    name: "Laptop",
    toRelative: (path) => path,
    inspect:
      options.inspect ?? ((relativePath) => inspectOnMachine(workspace, relativePath, notInternal)),
    read: (input) =>
      Stream.unwrap(
        Effect.map(readOnMachine(workspace, input, notInternal), (items) =>
          options.tamper === undefined ? Stream.fromIterable(items) : options.tamper(items),
        ),
      ),
  };
};
