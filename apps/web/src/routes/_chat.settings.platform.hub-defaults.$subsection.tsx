import { createFileRoute } from "@tanstack/react-router";

import { PlatformSettingsPage } from "../components/settings/PlatformSettingsPage";

// A page of Hub defaults: the section reads which one from the path.
export const Route = createFileRoute("/_chat/settings/platform/hub-defaults/$subsection")({
  component: () => <PlatformSettingsPage section="hub-defaults" />,
});
