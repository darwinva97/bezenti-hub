import { createFileRoute } from "@tanstack/react-router";

import { UserMachinePage } from "../components/settings/MachinePages";
import { validateMachineSearch } from "../components/settings/machineSettings";

function UserMachineRoute() {
  const { environmentId } = Route.useParams();
  return <UserMachinePage environmentId={environmentId} />;
}

export const Route = createFileRoute(
  "/_chat/settings/user/machines/$environmentId/$machineSection",
)({
  validateSearch: validateMachineSearch,
  component: UserMachineRoute,
});
