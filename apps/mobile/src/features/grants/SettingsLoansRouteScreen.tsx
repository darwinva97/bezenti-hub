import { useNavigation } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { useHubConnection } from "../../state/use-remote-environment-registry";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { LoansList } from "./LoansList";

/** Settings → Loans: what the User lent, and what their Spaces borrow or are offered. */
export function SettingsLoansRouteScreen() {
  const hub = useHubConnection();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  return (
    <SettingsScreen title="Loans">
      <ScreenScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {hub === null ? (
          <Text className="text-foreground-muted">Loans live on a Hub: connect to one first.</Text>
        ) : (
          <>
            <Button
              label="Apply a lending link"
              size="compact"
              onPress={() => navigation.navigate("SettingsLoanLink")}
            />
            <LoansList connection={hub} />
          </>
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}
