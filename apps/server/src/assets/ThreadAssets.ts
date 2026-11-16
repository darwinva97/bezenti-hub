/**
 * A Thread's own file served by URL (`assets.createUrl` for `workspace-file` and `media-file`).
 */
import type { AssetResource, UserId } from "@t3tools/contracts";
import { isNetworkPath } from "@t3tools/shared/path";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { issueAssetUrl } from "./AssetAccess.ts";

export type ThreadAssetResource = Extract<AssetResource, { _tag: "workspace-file" | "media-file" }>;

export const issueThreadAssetUrl = Effect.fn("ThreadAssets.issueThreadAssetUrl")(function* <
  E,
  R,
>(input: {
  readonly resource: ThreadAssetResource;
  readonly viewer: UserId | undefined;
  /** The Thread's workspace on the Hub machine (its worktree, else its Project's root). */
  readonly localWorkspaceRoot: Effect.Effect<string, E, R>;
}) {
  const path = yield* Path.Path;
  const { resource } = input;
  // A host file outside any workspace: the Hub machine's own (a network path only in the Thread's
  // Project, judged against its workspace).
  if (
    resource._tag === "media-file" &&
    path.isAbsolute(resource.path) &&
    !isNetworkPath(resource.path)
  ) {
    return yield* issueAssetUrl({ resource, viewer: input.viewer });
  }
  return yield* issueAssetUrl({
    resource,
    workspaceRoot: yield* input.localWorkspaceRoot,
    viewer: input.viewer,
  });
});
