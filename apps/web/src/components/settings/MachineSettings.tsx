import { ProviderInstanceId } from "@t3tools/contracts";
import {
  isMachineSectionAllowed,
  type MachineSectionId,
} from "@t3tools/client-runtime/settings/modal-visibility";
import { useLocation, useNavigate, useSearch } from "@tanstack/react-router";
import { createContext, lazy, Suspense, use, type ComponentType } from "react";

import { isElectron } from "~/env";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { Button } from "../ui/button";
import {
  MACHINE_SECTION_LABELS,
  machinePagePath,
  machineSectionOfPathname,
  type MachineBase,
} from "./machineSettings";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer } from "./settingsLayout";
import { useSettingsVisibility } from "./useSettingsVisibility";

const ProviderSettingsPanel = lazy(() =>
  import("./ProviderSettingsPanel").then((module) => ({ default: module.ProviderSettingsPanel })),
);
const SourceControlPanel = lazy(() =>
  import("./SourceControlSettings").then((module) => ({
    default: module.SourceControlSettingsPanel,
  })),
);
const DevicesPanel = lazy(() =>
  import("./IntegrationsSettings").then((module) => ({ default: module.DevicesSettingsPanel })),
);
const MaintenancePanel = lazy(() =>
  import("./SettingsPanels").then((module) => ({ default: module.MaintenanceSettingsPanel })),
);
const DiagnosticsPanel = lazy(() =>
  import("./DiagnosticsSettings").then((module) => ({ default: module.DiagnosticsSettingsPanel })),
);
const NetworkPanel = lazy(() =>
  import("./MachineNetworkSection").then((module) => ({ default: module.MachineNetworkSection })),
);

const MachineBaseContext = createContext<MachineBase>({ kind: "hub" });

/** Where Maintenance → Diagnostics lives for the machine page that is open. */
export function useMachineDiagnosticsPath(): string {
  return machinePagePath(use(MachineBaseContext), "maintenance", "diagnostics");
}

function MachineProviders() {
  const { environment, scope } = useSettingsScope();
  const search = useSearch({ strict: false }) as { readonly instanceId?: unknown };
  if (!environment) return null;
  return (
    <ProviderSettingsPanel
      environmentId={environment.environmentId}
      {...(typeof search.instanceId === "string" && search.instanceId.trim()
        ? { instanceId: ProviderInstanceId.make(search.instanceId) }
        : {})}
      projectIds={
        scope.kind === "project" || scope.kind === "checkout"
          ? scope.members
              .filter((member) => member.environmentId === environment.environmentId)
              .map((member) => member.id)
          : []
      }
      scoped
    />
  );
}

const PANELS: Readonly<Record<MachineSectionId, ComponentType>> = {
  providers: MachineProviders,
  "source-control": SourceControlPanel,
  devices: DevicesPanel,
  maintenance: MaintenancePanel,
  network: NetworkPanel,
};

const SECTION_ORDER = Object.keys(MACHINE_SECTION_LABELS) as ReadonlyArray<MachineSectionId>;

/**
 * The page of one machine: Providers, Source control, Devices, Maintenance and, for the backend of
 * this computer, Network. The route fixes the machine, so there is no machine or scope selector.
 */
export function MachineSettings({ base }: { readonly base: MachineBase }) {
  const { environment } = useSettingsScope();
  const visibility = useSettingsVisibility();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const { section: requested, subpage } = machineSectionOfPathname(pathname);
  if (environment === null) {
    return (
      <SettingsPageContainer>
        <p className="text-sm text-muted-foreground">
          This machine is not connected. Reconnect it to change its settings.
        </p>
      </SettingsPageContainer>
    );
  }
  const isLocalBackend = isElectron && environment.environmentId === primaryEnvironmentId;
  const sections = SECTION_ORDER.filter((id) =>
    isMachineSectionAllowed(id, visibility, { isLocalBackend }),
  );
  const active = sections.find((id) => id === requested) ?? sections[0];
  if (active === undefined) {
    return (
      <SettingsPageContainer>
        <p role="status" className="text-sm text-muted-foreground">
          Only the Owner of this Hub opens the settings of its machines.
        </p>
      </SettingsPageContainer>
    );
  }
  const Panel =
    subpage === "diagnostics" && active === "maintenance" ? DiagnosticsPanel : PANELS[active];
  return (
    <MachineBaseContext value={base}>
      <div className="flex min-h-0 flex-1 flex-col">
        <nav
          aria-label="Machine settings"
          className="flex shrink-0 gap-1 overflow-x-auto border-b px-5 py-2"
        >
          {sections.map((id) => (
            <Button
              key={id}
              size="sm"
              variant={id === active ? "outline" : "ghost-muted"}
              aria-current={id === active ? "page" : undefined}
              onClick={() => void navigate({ href: machinePagePath(base, id), replace: true })}
            >
              {MACHINE_SECTION_LABELS[id]}
            </Button>
          ))}
        </nav>
        <Suspense fallback={null}>
          <Panel />
        </Suspense>
      </div>
    </MachineBaseContext>
  );
}
