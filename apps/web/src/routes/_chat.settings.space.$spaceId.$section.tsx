import { createFileRoute } from "@tanstack/react-router";

import { SpaceSettingsPage } from "../components/settings/SpaceSettingsPage";

function SpaceSettingsSectionRoute() {
  const { spaceId, section } = Route.useParams();
  return <SpaceSettingsPage spaceId={spaceId} section={section} />;
}

export const Route = createFileRoute("/_chat/settings/space/$spaceId/$section")({
  component: SpaceSettingsSectionRoute,
});
