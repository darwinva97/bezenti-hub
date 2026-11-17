import type { SettingsModalId } from "@t3tools/client-runtime/settings/modal-visibility";
import { Linking } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { EmptyState } from "../../components/ui/EmptyState";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useHubConnection } from "../../state/use-remote-environment-registry";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";
import { SETTINGS_MODAL_LABELS, platformBrowserUrl, settingsModalPages } from "./settings-modals";
import { useSettingsModalContext } from "./useSettingsModalContext";

/** One Settings entry's index: the pages of that modal this viewer sees. */
function SettingsModalIndexRouteScreen(props: { readonly modal: SettingsModalId }) {
  const insets = useSafeAreaInsets();
  const context = useSettingsModalContext();
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const hub = useHubConnection();
  const pages = settingsModalPages(props.modal, context);
  const browserUrl =
    props.modal === "platform" && pages.length > 0
      ? platformBrowserUrl(hub?.httpBaseUrl ?? null)
      : null;

  return (
    <SettingsScreen title={SETTINGS_MODAL_LABELS[props.modal]}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {pages.length === 0 ? (
          <EmptyState
            variant="plain"
            title="Nothing here"
            detail="You have no settings in this section."
          />
        ) : (
          <SettingsSection>
            {pages.map((page) => (
              <SettingsRow
                key={page.target}
                icon={page.icon}
                label={page.label}
                target={page.target}
                disabled={page.needsServer === true && selectedTargets.length === 0}
              />
            ))}
          </SettingsSection>
        )}
        {browserUrl === null ? null : (
          <SettingsSection title="In the browser">
            <SettingsRow
              icon="safari"
              label="Open Platform in browser"
              value="Users, audit log, master key, AI gateway"
              onPress={() => void Linking.openURL(browserUrl)}
            />
          </SettingsSection>
        )}
      </ScrollView>
    </SettingsScreen>
  );
}

export function SettingsUserRouteScreen() {
  return <SettingsModalIndexRouteScreen modal="user" />;
}

export function SettingsSpaceRouteScreen() {
  return <SettingsModalIndexRouteScreen modal="space" />;
}

export function SettingsPlatformRouteScreen() {
  return <SettingsModalIndexRouteScreen modal="platform" />;
}
