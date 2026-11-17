import { createFileRoute } from "@tanstack/react-router";

import { LegacyMachineRedirect } from "../components/settings/LegacyMachineRedirect";

// Moved to the page of a machine; this leads there.
export const Route = createFileRoute("/_chat/settings/diagnostics")({
  component: () => <LegacyMachineRedirect path="/settings/diagnostics" />,
});
