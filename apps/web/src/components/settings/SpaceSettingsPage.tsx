import { Navigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { selectSpace, useCurrentSpace } from "../../state/currentSpace";
import { ModalSectionPage } from "./ModalSectionPage";

/** One section of the Space settings modal, for the Space its URL names. */
export function SpaceSettingsPage({
  spaceId,
  section,
}: {
  readonly spaceId: string;
  readonly section: string;
}) {
  const view = useCurrentSpace((state) => state.view);
  const currentSpaceId = useCurrentSpace((state) => state.currentSpaceId);
  const space = view?.spaces.find((candidate) => candidate.id === spaceId);
  const knownSpaceId = space?.id ?? null;
  // Opening the settings of another Space makes it the current one, so the sidebar never lists
  // Spaces side by side.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the current Space follows the Space this modal opened, a store outside React
  useEffect(() => {
    if (knownSpaceId !== null && currentSpaceId !== knownSpaceId) selectSpace(knownSpaceId);
  }, [knownSpaceId, currentSpaceId]);
  // The directory is still loading.
  if (view === null) return null;
  // A Space the viewer cannot see is not a page: the current Space's settings take its place.
  if (space === undefined) return <Navigate to="/settings/space" replace />;
  return (
    <ModalSectionPage
      modal="space"
      sectionId={section}
      fallback={
        <Navigate
          to="/settings/space/$spaceId/$section"
          params={{ spaceId, section: "general" }}
          replace
        />
      }
    />
  );
}
