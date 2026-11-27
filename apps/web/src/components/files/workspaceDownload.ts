import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";

import { useWorkspaceThreadId } from "~/hooks/useWorkspaceThreadId";
import { assetEnvironment } from "~/state/assets";
import { readPreparedConnection } from "~/state/session";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import { startWorkspaceDownload, type WorkspaceDownloadTarget } from "~/workspaceDownloads";

/** Starts downloading files or folders under `cwd`; progress shows in the downloads panel. */
export function useWorkspaceDownload(
  environmentId: EnvironmentId,
  /** Whether paths are in the open Thread's workspace, which may be on another machine. */
  options: { readonly inThreadWorkspace: boolean },
) {
  const workspaceThreadId = useWorkspaceThreadId(environmentId);
  const threadId = options.inThreadWorkspace ? workspaceThreadId : undefined;
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  return (target: WorkspaceDownloadTarget, label: string) => {
    startWorkspaceDownload({
      environmentId,
      label,
      target,
      mint: async (next) => {
        const connection = readPreparedConnection(environmentId);
        if (!connection) throw new Error("Reconnect to this environment and try again.");
        const result = await createAssetUrl({
          environmentId,
          input: {
            resource: {
              _tag: "workspace-download",
              cwd: next.cwd,
              paths: next.paths,
              ...(next.includeAll === true ? { includeAll: true } : {}),
              ...(threadId === undefined ? {} : { threadId }),
            },
          },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        return {
          result: result.value,
          resolveUrl: (relativeUrl) => {
            const url = resolveAssetUrl(connection.httpBaseUrl, relativeUrl);
            if (!url) throw new Error("The environment returned an invalid download URL.");
            return url;
          },
        };
      },
    });
  };
}
