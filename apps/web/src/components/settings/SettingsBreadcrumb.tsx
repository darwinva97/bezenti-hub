import { Fragment } from "react";

import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { useOptionalSettingsScope } from "./SettingsScopeContext";
import { useSettingsSpace } from "./useSettingsSpace";
import { MACHINE_SECTION_LABELS } from "./machineSettings";
import {
  SETTINGS_MODAL_LABELS,
  findSettingsSection,
  settingsModalForPathname,
} from "./settingsModals";

const HUB_DEFAULTS_PAGE_LABELS: Readonly<Record<string, string>> = {
  threads: "Threads",
  browser: "Browser",
  worktrees: "Worktrees",
};

/** The part of a machine page trail after its modal section: the machine, its section, its subpage. */
function machinePageTrail(rest: ReadonlyArray<string>, modal: string): ReadonlyArray<string> {
  // Under Hub machine the machine is the Hub's, so the segments start at its section.
  const [machine, section, subpage] = modal === "platform" ? [null, rest[0], rest[1]] : rest;
  const isMachinePage = modal === "platform" ? section !== undefined : machine !== undefined;
  if (!isMachinePage) return [];
  const sectionLabel =
    MACHINE_SECTION_LABELS[section as keyof typeof MACHINE_SECTION_LABELS] ?? undefined;
  return [
    ...(machine === null ? [] : [modal === "user" ? "This computer" : "Machine"]),
    ...(sectionLabel === undefined ? [] : [sectionLabel]),
    ...(subpage === "diagnostics" ? ["Diagnostics"] : []),
  ];
}

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
    const objectFirst = modal === "project" || modal === "space";
    const sectionId = segments[objectFirst ? 4 : 3];
    const subpage = segments[objectFirst ? 5 : 4];
    const section = sectionId === undefined ? undefined : findSettingsSection(modal, sectionId);
    return [
      `${SETTINGS_MODAL_LABELS[modal]} settings${objectName ? ` · ${objectName}` : ""}`,
      ...(section ? [section.label] : []),
      ...(subpage === "licenses" ? ["Open source licenses"] : []),
      ...(modal === "platform" && sectionId === "hub-defaults"
        ? [HUB_DEFAULTS_PAGE_LABELS[subpage ?? "threads"] ?? "Threads"]
        : []),
      ...((modal === "platform" && sectionId === "hub-machine") ||
      ((modal === "user" || modal === "space") && sectionId === "machines")
        ? machinePageTrail(segments.slice(modal === "space" ? 5 : 4), modal)
        : []),
    ];
  }
  return [];
}

export function SettingsBreadcrumb({ pathname }: { pathname: string }) {
  const scope = useOptionalSettingsScope();
  // A Project's modal names its Project, read from the scope; a Space's names its Space.
  const objectName =
    scope !== null && (scope.scope.kind === "project" || scope.scope.kind === "checkout")
      ? scope.scope.group.displayName
      : null;
  const spaceName = useSettingsSpace()?.name ?? null;
  const modal = settingsModalForPathname(pathname);
  const trail = settingsBreadcrumbTrail(
    pathname,
    modal === "project" ? objectName : modal === "space" ? spaceName : null,
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
