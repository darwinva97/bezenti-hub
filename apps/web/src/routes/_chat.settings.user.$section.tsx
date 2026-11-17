import { Navigate, createFileRoute } from "@tanstack/react-router";
import { Suspense } from "react";

import {
  findSettingsSection,
  isSettingsSectionVisible,
} from "../components/settings/settingsModals";
import { useSettingsVisibility } from "../components/settings/useSettingsVisibility";

const HUB_WIDE_NOTE = "These settings apply to the whole Hub, so only its Owner changes them.";

function UserSettingsSectionRoute() {
  const { section: sectionId } = Route.useParams();
  const visibility = useSettingsVisibility();
  const section = findSettingsSection("user", sectionId);
  const Component = section?.component;
  // A section the User cannot use is not a page: send them to the first one.
  if (!section || !Component || !isSettingsSectionVisible("user", section, visibility)) {
    return <Navigate to="/settings/user/$section" params={{ section: "general" }} replace />;
  }
  return (
    <>
      {section.hubWide && !visibility.isOwner ? (
        <p role="note" className="shrink-0 border-b px-5 py-2 text-sm text-muted-foreground">
          {HUB_WIDE_NOTE}
        </p>
      ) : null}
      <Suspense fallback={null}>
        <Component />
      </Suspense>
    </>
  );
}

export const Route = createFileRoute("/_chat/settings/user/$section")({
  component: UserSettingsSectionRoute,
});
