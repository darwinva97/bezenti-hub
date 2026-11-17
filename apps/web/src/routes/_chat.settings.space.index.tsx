import { Navigate, createFileRoute } from "@tanstack/react-router";

import { useCurrentSpace } from "../state/currentSpace";

// A bare `/settings/space` names no Space, so it opens the one that is current.
function CurrentSpaceSettingsRoute() {
  const currentSpaceId = useCurrentSpace((state) => state.currentSpaceId);
  if (currentSpaceId === null) return null;
  return (
    <Navigate
      to="/settings/space/$spaceId/$section"
      params={{ spaceId: currentSpaceId, section: "general" }}
      replace
    />
  );
}

export const Route = createFileRoute("/_chat/settings/space/")({
  component: CurrentSpaceSettingsRoute,
});
