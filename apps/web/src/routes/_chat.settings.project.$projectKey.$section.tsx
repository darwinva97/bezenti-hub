import { Navigate, createFileRoute } from "@tanstack/react-router";

import { ModalSectionPage } from "../components/settings/ModalSectionPage";

function ProjectSettingsSectionRoute() {
  const { projectKey, section } = Route.useParams();
  return (
    <ModalSectionPage
      modal="project"
      sectionId={section}
      fallback={
        <Navigate
          to="/settings/project/$projectKey/$section"
          params={{ projectKey, section: "general" }}
          search={(previous) => previous}
          replace
        />
      }
    />
  );
}

export const Route = createFileRoute("/_chat/settings/project/$projectKey/$section")({
  component: ProjectSettingsSectionRoute,
});
