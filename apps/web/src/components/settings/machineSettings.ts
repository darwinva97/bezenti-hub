import { ProviderInstanceId } from "@t3tools/contracts";
import {
  MACHINE_SECTION_IDS,
  type MachineSectionId,
} from "@t3tools/client-runtime/settings/modal-visibility";

/** Where a machine page is mounted: the Hub, one of the User, or one of a Space. */
export type MachineBase =
  | { readonly kind: "hub" }
  | { readonly kind: "user"; readonly environmentId: string }
  | { readonly kind: "space"; readonly spaceId: string; readonly environmentId: string };

export const MACHINE_SECTION_LABELS: Readonly<Record<MachineSectionId, string>> = {
  providers: "Providers",
  "source-control": "Source control",
  devices: "Devices",
  maintenance: "Maintenance",
  network: "Network",
};

const isMachineSectionId = (value: string | undefined): value is MachineSectionId =>
  value !== undefined && (MACHINE_SECTION_IDS as ReadonlyArray<string>).includes(value);

/** The URL of a section of a machine page, or of its subpage such as Maintenance → Diagnostics. */
export function machinePagePath(
  base: MachineBase,
  section: MachineSectionId,
  subpage?: "diagnostics",
): string {
  const root =
    base.kind === "hub"
      ? "/settings/platform/hub-machine"
      : base.kind === "user"
        ? `/settings/user/machines/${encodeURIComponent(base.environmentId)}`
        : `/settings/space/${encodeURIComponent(base.spaceId)}/machines/${encodeURIComponent(base.environmentId)}`;
  return `${root}/${section}${subpage === undefined ? "" : `/${subpage}`}`;
}

/** The section and subpage a machine page URL names; none for the bare URL of the machine. */
export function machineSectionOfPathname(pathname: string): {
  readonly section: MachineSectionId | undefined;
  readonly subpage: "diagnostics" | undefined;
} {
  const segments = pathname.replace(/\/+$/, "").split("/");
  const last = segments.at(-1);
  if (last === "diagnostics" && segments.at(-2) === "maintenance") {
    return { section: "maintenance", subpage: "diagnostics" };
  }
  return { section: isMachineSectionId(last) ? last : undefined, subpage: undefined };
}

export interface MachineSettingsTarget {
  readonly section: MachineSectionId;
  /** The machine of the Thread or Project the link comes from; none means the Hub. */
  readonly environmentId?: string | null | undefined;
  readonly primaryEnvironmentId: string | null;
  /** The provider instance whose setup the link opens. */
  readonly instanceId?: string | undefined;
  readonly subpage?: "diagnostics" | undefined;
}

/**
 * Where a link to a machine page leads: the Hub's page for the Hub machine or when there is no
 * machine in the context, else the page the machine has under User settings.
 */
export function machineSettingsHref(target: MachineSettingsTarget): string {
  const { section, environmentId, primaryEnvironmentId, instanceId, subpage } = target;
  const base: MachineBase =
    environmentId === undefined || environmentId === null || environmentId === primaryEnvironmentId
      ? { kind: "hub" }
      : { kind: "user", environmentId };
  const query = instanceId === undefined ? "" : `?instanceId=${encodeURIComponent(instanceId)}`;
  return `${machinePagePath(base, section, subpage)}${query}`;
}

/** Whether a URL is a Providers page of a machine, wherever it is mounted. */
export function isMachineProvidersPathname(pathname: string): boolean {
  return (
    /^\/settings\/platform\/hub-machine\/providers\/?$/.test(pathname) ||
    /^\/settings\/user\/machines\/[^/]+\/providers\/?$/.test(pathname) ||
    /^\/settings\/space\/[^/]+\/machines\/[^/]+\/providers\/?$/.test(pathname)
  );
}

/** The provider instance a Providers link opens, from the query. */
export function validateMachineSearch(raw: Record<string, unknown>) {
  return typeof raw.instanceId === "string" && raw.instanceId.trim()
    ? { instanceId: ProviderInstanceId.make(raw.instanceId) }
    : {};
}

/**
 * The old Settings pages that became a page of a machine. Their links lead to the machine named
 * by `?machine=`, else to the Hub machine.
 */
export const LEGACY_MACHINE_PAGES: Readonly<
  Record<string, { readonly section: MachineSectionId; readonly subpage?: "diagnostics" }>
> = {
  "/settings/providers": { section: "providers" },
  "/settings/source-control": { section: "source-control" },
  "/settings/devices": { section: "devices" },
  "/settings/maintenance": { section: "maintenance" },
  "/settings/diagnostics": { section: "maintenance", subpage: "diagnostics" },
};
