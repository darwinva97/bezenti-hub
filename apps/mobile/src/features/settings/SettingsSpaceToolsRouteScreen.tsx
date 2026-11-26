import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { useSpaceSelections } from "../../state/spaces";
import { useHubConnection } from "../../state/use-remote-environment-registry";
import { SpaceToolsList } from "../spaceTools/SpaceToolsList";
import { SettingsScreen } from "./components/SettingsScreen";

export function SettingsSpaceToolsRouteScreen() {
  const hub = useHubConnection();
  const selections = useSpaceSelections();
  const insets = useSafeAreaInsets();
  const spaceId = hub === null ? null : (selections.get(hub.environmentId)?.currentSpaceId ?? null);
  return (
    <SettingsScreen title="MCP servers & Skills">
      <ScreenScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {hub === null || spaceId === null ? (
          <Text className="text-foreground-muted">
            MCP servers and Skills live in a Space on a Hub: connect to one first.
          </Text>
        ) : (
          <SpaceToolsList environmentId={hub.environmentId} spaceId={spaceId} />
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}
