import { Fragment } from "react";

import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { useOptionalSettingsScope } from "./SettingsScopeContext";
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
function settingsBreadcrumbTrail(
  pathname: string,
  objectName: string | null,
): ReadonlyArray<string> {
  const normalizedPathname = pathname.replace(/\/+$/, "") || "/";
  const modal = settingsModalForPathname(normalizedPathname);
  if (modal !== null) {
    // The path is /settings/<modal>/<section>, with the modal's object before the section.
    const segments = normalizedPathname.split("/");
    const sectionId = segments[modal === "project" ? 4 : 3];
    const subpage = segments[modal === "project" ? 5 : 4];
    const section = sectionId === undefined ? undefined : findSettingsSection(modal, sectionId);
    return [
      `${SETTINGS_MODAL_LABELS[modal]} settings${objectName ? ` · ${objectName}` : ""}`,
      ...(section ? [section.label] : []),
      ...(subpage === "licenses" ? ["Open source licenses"] : []),
    ];
  }
  const label = SETTINGS_BREADCRUMB_LABELS[normalizedPathname];
  return label ? ["Settings", label] : [];
}

export function SettingsBreadcrumb({ pathname }: { pathname: string }) {
  const scope = useOptionalSettingsScope();
  // Only a Project's modal names its object, and it reads it from the scope.
  const objectName =
    scope !== null && (scope.scope.kind === "project" || scope.scope.kind === "checkout")
      ? scope.scope.group.displayName
      : null;
  const trail = settingsBreadcrumbTrail(
    pathname,
    settingsModalForPathname(pathname) === "project" ? objectName : null,
  );
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
