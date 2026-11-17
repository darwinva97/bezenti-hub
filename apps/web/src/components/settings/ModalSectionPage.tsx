import { Suspense, type ReactNode } from "react";

import {
  findSettingsSection,
  isSettingsSectionVisible,
  type SettingsModalId,
} from "./settingsModals";
import { useSettingsVisibility } from "./useSettingsVisibility";

const HUB_WIDE_NOTE = "These settings apply to the whole Hub, so only its Owner changes them.";

/**
 * The page of one modal section. A section that does not exist, or that this User cannot use, is
 * not a page: `fallback` sends them to the first one.
 */
export function ModalSectionPage({
  modal,
  sectionId,
  fallback,
}: {
  modal: SettingsModalId;
  sectionId: string;
  fallback: ReactNode;
}) {
  const visibility = useSettingsVisibility();
  const section = findSettingsSection(modal, sectionId);
  const Component = section?.component;
  if (!section || !Component || !isSettingsSectionVisible(modal, section, visibility)) {
    return fallback;
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
