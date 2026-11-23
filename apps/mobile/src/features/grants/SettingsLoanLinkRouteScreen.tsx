import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { useHubConnection } from "../../state/use-remote-environment-registry";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { ApplyLoanLink } from "./ApplyLoanLink";

/** Settings → Loans → «Apply a lending link». */
export function SettingsLoanLinkRouteScreen() {
  const hub = useHubConnection();
  const insets = useSafeAreaInsets();
  return (
    <SettingsScreen title="Apply a lending link">
      <ScreenScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {hub === null ? (
          <Text className="text-foreground-muted">Loans live on a Hub: connect to one first.</Text>
        ) : (
          <ApplyLoanLink key={hub.environmentId} environmentId={hub.environmentId} />
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}
