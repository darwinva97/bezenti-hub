import { Navigate, createFileRoute } from "@tanstack/react-router";

import { ModalSectionPage } from "../components/settings/ModalSectionPage";

function UserSettingsSectionRoute() {
  const { section } = Route.useParams();
  return (
    <ModalSectionPage
      modal="user"
      sectionId={section}
      fallback={<Navigate to="/settings/user/$section" params={{ section: "general" }} replace />}
    />
  );
}

export const Route = createFileRoute("/_chat/settings/user/$section")({
  component: UserSettingsSectionRoute,
});
