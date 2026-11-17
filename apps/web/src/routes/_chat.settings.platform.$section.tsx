import { createFileRoute } from "@tanstack/react-router";

import { PlatformSettingsPage } from "../components/settings/PlatformSettingsPage";

function PlatformSettingsSectionRoute() {
  const { section } = Route.useParams();
  return <PlatformSettingsPage section={section} />;
}

export const Route = createFileRoute("/_chat/settings/platform/$section")({
  component: PlatformSettingsSectionRoute,
});
