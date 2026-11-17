import { createFileRoute } from "@tanstack/react-router";

import { LegacyMachineRedirect } from "../components/settings/LegacyMachineRedirect";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";

// Moved to the page of a machine; this leads there.
export const Route = createFileRoute("/_chat/settings/providers")({
  // Old links name the machine and the provider instance in the query.
  validateSearch: (raw: Record<string, unknown>) => ({
    ...(typeof raw.environmentId === "string" && raw.environmentId.trim()
      ? { environmentId: EnvironmentId.make(raw.environmentId) }
      : {}),
    ...(typeof raw.instanceId === "string" && raw.instanceId.trim()
      ? { instanceId: ProviderInstanceId.make(raw.instanceId) }
      : {}),
  }),
  component: () => <LegacyMachineRedirect path="/settings/providers" />,
});
