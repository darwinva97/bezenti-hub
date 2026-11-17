import { Suspense, type ReactNode } from "react";

import {
  findSettingsSection,
  isSettingsSectionVisible,
  type SettingsModalId,
} from "./settingsModals";
import { Spinner } from "../ui/spinner";
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
      {/* Keyed by section: a new boundary shows its fallback at once, where the old one would keep
          the previous section on screen while the router's transition waits for the chunk. */}
      <Suspense key={section.id} fallback={<SectionLoading />}>
        <Component />
      </Suspense>
    </>
  );
}

function SectionLoading() {
  return (
    <div
      role="status"
      aria-label="Loading section"
      className="flex flex-1 items-center justify-center p-8"
    >
      <Spinner size="lg" tone="muted" />
    </div>
  );
}
