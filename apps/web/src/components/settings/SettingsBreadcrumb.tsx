import { Fragment } from "react";

import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { SETTINGS_SECTION_LABELS } from "./settingsSearch";
import {
  SETTINGS_MODAL_LABELS,
  findSettingsSection,
  settingsModalForPathname,
} from "./settingsModals";

const SETTINGS_BREADCRUMB_LABELS: Readonly<Record<string, string>> = {
  ...SETTINGS_SECTION_LABELS,
  "/settings/diagnostics": "Diagnostics",
};

/** The trail of a page: its parents, then its own label. Empty for an unknown page. */
function settingsBreadcrumbTrail(pathname: string): ReadonlyArray<string> {
  const normalizedPathname = pathname.replace(/\/+$/, "") || "/";
  const modal = settingsModalForPathname(normalizedPathname);
  if (modal !== null) {
    const [, , , sectionId, subpage] = normalizedPathname.split("/");
    const section = sectionId === undefined ? undefined : findSettingsSection(modal, sectionId);
    return [
      `${SETTINGS_MODAL_LABELS[modal]} settings`,
      ...(section ? [section.label] : []),
      ...(subpage === "licenses" ? ["Open source licenses"] : []),
    ];
  }
  const label = SETTINGS_BREADCRUMB_LABELS[normalizedPathname];
  return label ? ["Settings", label] : [];
}

export function SettingsBreadcrumb({ pathname }: { pathname: string }) {
  const trail = settingsBreadcrumbTrail(pathname);
  const current = trail.at(-1) ?? "Settings";

  return (
    <WorkspaceBreadcrumb ariaLabel="Settings breadcrumb">
      {trail.slice(0, -1).map((label) => (
        <Fragment key={label}>
          <WorkspaceBreadcrumbItem>{label}</WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator />
        </Fragment>
      ))}
      <WorkspaceBreadcrumbItem current className="truncate">
        {current}
      </WorkspaceBreadcrumbItem>
    </WorkspaceBreadcrumb>
  );
}
