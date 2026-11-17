import { Navigate } from "@tanstack/react-router";

import { ModalSectionPage } from "./ModalSectionPage";
import { SettingsPageContainer } from "./settingsLayout";
import { useSettingsVisibility } from "./useSettingsVisibility";

/** One section of the Platform modal. Only the Owner opens it; anyone else gets the notice. */
export function PlatformSettingsPage({ section }: { readonly section: string }) {
  const { isOwner } = useSettingsVisibility();
  if (!isOwner) {
    return (
      <SettingsPageContainer>
        <p role="status" className="text-sm text-muted-foreground">
          Only the Owner of this Hub opens Platform.
        </p>
      </SettingsPageContainer>
    );
  }
  return (
    <ModalSectionPage
      modal="platform"
      sectionId={section}
      fallback={<Navigate to="/settings/platform/$section" params={{ section: "users" }} replace />}
    />
  );
}
