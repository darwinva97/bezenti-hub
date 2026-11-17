import type { HubEnvironmentOverviewEntry, HubEnvironmentSummary } from "@t3tools/contracts";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ListSection } from "../../components/ui/ListSection";
import {
  refreshHubEnvironmentOverview,
  useHubEnvironmentOverview,
  useHubEnvironmentOverviewStatus,
} from "../../state/hubEnvironmentOverview";
import {
  refreshHubEnvironments,
  useHubEnvironments,
  useHubEnvironmentsStatus,
} from "../../state/hubEnvironments";
import { useSpaceSelections } from "../../state/spaces";
import { useHubConnection } from "../../state/use-remote-environment-registry";
import { EnvironmentStatusDot } from "./EnvironmentStatusDot";
import { hubMachineRow } from "./hubMachineRow";

/**
 * «Machines on this Hub», to read only. The Owner gets every Environment, with how it is used, its
 * Space and live status, from an endpoint only the Owner gets; everyone else their own machines and
 * those dedicated to their Organizations (owned-resources 06 and 07). Renaming, removing,
 * dedicating and approving machines stay on the web and desktop app.
 */
export function HubMachinesSection() {
  const hub = useHubConnection();
  const selections = useSpaceSelections();
  const view = hub === null ? undefined : selections.get(hub.environmentId)?.view;
  if (view === undefined || view === null) return null;
  if (view.isOwner === true) return <HubMachinesList viewerUserId={view.userId} />;
  const spaceNames = new Map((view.spaces ?? []).map((space) => [space.id, space.name] as const));
  return <OwnMachinesList viewerUserId={view.userId} spaceNames={spaceNames} />;
}

/** «Run `t3 join`»: every User adds their own machines; approving happens in a browser. */
function AddMachineHint() {
  return (
    <Text className="px-4 pb-3 text-xs text-foreground-muted">
      Add a machine: run <Text className="font-mono text-xs">t3 join</Text> with this Hub's address
      on it, then approve it in a browser. Rename, remove or dedicate machines from the web or
      desktop app.
    </Text>
  );
}

/** A machine of the User's list in the Owner's overview shape, for the same words. */
const asOverviewEntry = (
  environment: HubEnvironmentSummary,
  spaceNames: ReadonlyMap<string, string>,
): HubEnvironmentOverviewEntry => ({
  id: environment.id,
  name: environment.name,
  kind: environment.kind,
  mode: environment.mode,
  spaceId: environment.spaceId ?? null,
  spaceName:
    environment.spaceId === undefined || environment.spaceId === null
      ? null
      : (spaceNames.get(environment.spaceId) ?? null),
  ownerUserId: environment.ownerUserId,
  ownerName: null,
  status: environment.status,
  startError: environment.startError ?? null,
  os: environment.os,
  lastSeenAt: environment.lastSeenAt,
  runningThreadCount: environment.runningThreadCount,
});

function OwnMachinesList(props: {
  readonly viewerUserId: string;
  readonly spaceNames: ReadonlyMap<string, string>;
}) {
  const environments = useHubEnvironments().filter(
    (environment) => environment.kind === "external",
  );
  const status = useHubEnvironmentsStatus();
  return (
    <ListSection title="Your machines">
      {status === "error" ? (
        <View accessibilityRole="alert" className="flex-row items-center gap-3 px-4 py-3">
          <Text className="flex-1 text-sm text-danger-foreground">
            Could not load your machines.
          </Text>
          <Button
            label="Try again"
            size="compact"
            tone="secondary"
            onPress={refreshHubEnvironments}
          />
        </View>
      ) : null}
      {environments.map((environment) => (
        <MachineRow
          key={environment.id}
          environment={asOverviewEntry(environment, props.spaceNames)}
          viewerUserId={props.viewerUserId}
        />
      ))}
      <AddMachineHint />
    </ListSection>
  );
}

function MachineRow(props: {
  readonly environment: HubEnvironmentOverviewEntry;
  readonly viewerUserId: string;
}) {
  const { environment } = props;
  const row = hubMachineRow(environment, props.viewerUserId);
  return (
    <View
      accessible
      accessibilityLabel={row.accessibilityLabel}
      className="flex-row items-center gap-3 px-4 py-3"
    >
      <EnvironmentStatusDot status={row.status} />
      <View className="flex-1">
        <View className="flex-row items-center gap-2">
          <Text className="flex-shrink text-base" numberOfLines={1}>
            {environment.name}
          </Text>
          <Text className="text-xs text-foreground-muted">{row.mode}</Text>
        </View>
        <Text className="text-xs text-foreground-muted">{row.details}</Text>
        {row.error === null ? null : (
          <Text className="text-xs text-danger-foreground">{row.error}</Text>
        )}
      </View>
    </View>
  );
}

function HubMachinesList(props: { readonly viewerUserId: string }) {
  const environments = useHubEnvironmentOverview();
  const status = useHubEnvironmentOverviewStatus();
  return (
    <ListSection title="Machines on this Hub">
      {status === "error" ? (
        <View accessibilityRole="alert" className="flex-row items-center gap-3 px-4 py-3">
          <Text className="flex-1 text-sm text-danger-foreground">
            Could not load this Hub's machines.
          </Text>
          <Button
            label="Try again"
            size="compact"
            tone="secondary"
            onPress={refreshHubEnvironmentOverview}
          />
        </View>
      ) : null}
      {environments.length === 0 ? (
        status === "loading" ? (
          <Text className="px-4 py-3 text-sm text-foreground-muted">Loading machines…</Text>
        ) : null
      ) : (
        environments.map((environment) => (
          <MachineRow
            key={environment.id}
            environment={environment}
            viewerUserId={props.viewerUserId}
          />
        ))
      )}
      <AddMachineHint />
    </ListSection>
  );
}
