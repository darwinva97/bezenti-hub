import { createFileRoute } from "@tanstack/react-router";

import { SpaceMachinePage } from "../components/settings/MachinePages";
import { validateMachineSearch } from "../components/settings/machineSettings";

function SpaceMachineRoute() {
  const { spaceId, environmentId } = Route.useParams();
  return <SpaceMachinePage spaceId={spaceId} environmentId={environmentId} />;
}

export const Route = createFileRoute(
  "/_chat/settings/space/$spaceId/machines/$environmentId/$machineSection",
)({
  validateSearch: validateMachineSearch,
  component: SpaceMachineRoute,
});
