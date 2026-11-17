import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import { legacySpaceIdOf, spaceToFollow } from "@t3tools/client-runtime/spaces/space-filter";
import { useEffect } from "react";

import { useProject, useQuietThreadShell } from "../state/entities";
import { selectSpace, useCurrentSpace } from "../state/currentSpace";

/**
 * Opening a Thread, or a draft in a Project, of another Space (a link, a notification, the
 * browser's history) makes that Space the current one, so the sidebar never lists Spaces side by
 * side (ticket 19). Only for the environment whose Spaces the selector shows.
 */
export function useFollowOpenSpace(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly draft: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId } | null;
}) {
  const environmentId = useCurrentSpace((state) => state.environmentId);
  const view = useCurrentSpace((state) => state.view);
  const currentSpaceId = useCurrentSpace((state) => state.currentSpaceId);
  const thread = useQuietThreadShell(
    input.threadRef !== null && input.threadRef.environmentId === environmentId
      ? input.threadRef
      : null,
  );
  const projectRef =
    thread !== null
      ? scopeProjectRef(thread.environmentId, thread.projectId)
      : input.draft !== null && input.draft.environmentId === environmentId
        ? scopeProjectRef(input.draft.environmentId, input.draft.projectId)
        : null;
  const project = useProject(projectRef);
  // Thread shells carry no Space of their own here: a Thread is in its Project's.
  const openSpaceId = project === null ? null : (project.spaceId ?? legacySpaceIdOf(view));
  const next = spaceToFollow({ view, currentSpaceId, openSpaceId });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the current Space follows what the route opened, a store outside React
  useEffect(() => {
    if (next !== null) selectSpace(next);
  }, [next]);
}
