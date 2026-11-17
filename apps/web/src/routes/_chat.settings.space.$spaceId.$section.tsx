import { createFileRoute } from "@tanstack/react-router";

import { validateScheduledTasksSearch } from "../components/settings/scheduledTasksSettings.logic";
import { SpaceSettingsPage } from "../components/settings/SpaceSettingsPage";

function SpaceSettingsSectionRoute() {
  const { spaceId, section } = Route.useParams();
  return <SpaceSettingsPage spaceId={spaceId} section={section} />;
}

export const Route = createFileRoute("/_chat/settings/space/$spaceId/$section")({
  // Scheduled tasks opens the task a link names.
  validateSearch: validateScheduledTasksSearch,
  component: SpaceSettingsSectionRoute,
});
