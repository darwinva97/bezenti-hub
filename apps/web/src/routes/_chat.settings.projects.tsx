import { Navigate, createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";

import { useSettingsProjectGroups } from "../components/settings/useSettingsProjectGroups";
import { readAppModalReturnParams, useCloseAppModal } from "../components/sidebar/mainAppLocation";
import { useThreadShell } from "../state/entities";
import { resolveThreadRouteTarget } from "../threadRoutes";

/**
 * `/settings/projects?project=…` is redirected by the settings route. Without a Project, this is
 * «Project settings» from nowhere in particular: the Project of the Thread Settings was opened
 * from, or, with none, back to where it was opened.
 */
function ContextProjectSettingsRoute() {
  const groups = useSettingsProjectGroups();
  const closeAppModal = useCloseAppModal();
  const target = resolveThreadRouteTarget(readAppModalReturnParams());
  const thread = useThreadShell(target?.kind === "server" ? target.threadRef : null);
  const group =
    thread === null
      ? undefined
      : groups.find((candidate) =>
          candidate.memberProjects.some(
            (member) =>
              member.environmentId === thread.environmentId && member.id === thread.projectId,
          ),
        );
  const hasContext = group !== undefined;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- leaves Settings for the page that opened it when that page has no Project
  useEffect(() => {
    if (!hasContext) void closeAppModal();
  }, [hasContext, closeAppModal]);
  if (group === undefined) return null;
  return (
    <Navigate
      to="/settings/project/$projectKey/$section"
      params={{ projectKey: group.projectKey, section: "general" }}
      replace
    />
  );
}

export const Route = createFileRoute("/_chat/settings/projects")({
  component: ContextProjectSettingsRoute,
});
