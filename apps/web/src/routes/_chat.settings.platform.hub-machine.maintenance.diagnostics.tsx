import { createFileRoute } from "@tanstack/react-router";

import { validateMachineSearch } from "../components/settings/machineSettings";
import { PlatformSettingsPage } from "../components/settings/PlatformSettingsPage";

// A page of the Hub machine: the section reads which one from the path.
export const Route = createFileRoute(
  "/_chat/settings/platform/hub-machine/maintenance/diagnostics",
)({
  validateSearch: validateMachineSearch,
  component: () => <PlatformSettingsPage section="hub-machine" />,
});
