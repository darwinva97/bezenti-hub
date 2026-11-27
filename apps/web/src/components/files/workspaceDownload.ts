import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";

import { assetEnvironment } from "~/state/assets";
import { readPreparedConnection } from "~/state/session";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

export interface WorkspaceDownloadTarget {
  readonly cwd: string;
  /** Relative to `cwd`; a folder downloads as a ZIP the server streams. */
  readonly path: string;
}

export function useWorkspaceDownload(environmentId: EnvironmentId) {
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  return async (target: WorkspaceDownloadTarget): Promise<void> => {
    const connection = readPreparedConnection(environmentId);
    if (!connection) throw new Error("Reconnect to this environment and try again.");
    const result = await createAssetUrl({
      environmentId,
      input: { resource: { _tag: "workspace-download", cwd: target.cwd, path: target.path } },
    });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    const url = resolveAssetUrl(connection.httpBaseUrl, result.value.relativeUrl);
    if (!url) throw new Error("The environment returned an invalid download URL.");
    // The browser streams the attachment to disk itself, never through page memory.
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "";
    anchor.rel = "noopener";
    anchor.click();
  };
}
