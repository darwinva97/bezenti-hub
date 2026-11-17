import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { Navigate, createFileRoute, useLocation } from "@tanstack/react-router";
import { useEffect } from "react";

import { LegacyMachineRedirect } from "../components/settings/LegacyMachineRedirect";
import { LEGACY_MACHINE_PAGES } from "../components/settings/machineSettings";
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

/**
 * Every `/settings/<old page>` that is not a modal. The settings route redirects the ones the
 * old-URL table (`OLD_SETTINGS_PATHS`) knows; what reaches here is a page of a machine, a Project
 * from nowhere in particular, or a URL nobody knows, which goes to User settings.
 */
function OldSettingsUrl() {
  const pathname = useLocation({ select: (location) => location.pathname });
  if (LEGACY_MACHINE_PAGES[pathname] !== undefined)
    return <LegacyMachineRedirect path={pathname} />;
  if (pathname === "/settings/projects") return <ContextProjectSettingsRoute />;
  return <Navigate to="/settings/user/$section" params={{ section: "general" }} replace />;
}

export const Route = createFileRoute("/_chat/settings/$")({
  // Old links to a provider name the machine and the provider instance in the query.
  validateSearch: (raw: Record<string, unknown>) => ({
    ...(typeof raw.environmentId === "string" && raw.environmentId.trim()
      ? { environmentId: EnvironmentId.make(raw.environmentId) }
      : {}),
    ...(typeof raw.instanceId === "string" && raw.instanceId.trim()
      ? { instanceId: ProviderInstanceId.make(raw.instanceId) }
      : {}),
  }),
  component: OldSettingsUrl,
});
