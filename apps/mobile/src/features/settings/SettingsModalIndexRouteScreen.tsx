import type { SettingsModalId } from "@t3tools/client-runtime/settings/modal-visibility";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { EmptyState } from "../../components/ui/EmptyState";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { useHubConnection } from "../../state/use-remote-environment-registry";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";
import {
  hubBrowserUrl,
  PLATFORM_BROWSER_PATH,
  SETTINGS_MODAL_LABELS,
  settingsModalPages,
  spaceBrowserPath,
} from "./settings-modals";
import { useSettingsModalContext } from "./useSettingsModalContext";

/** One Settings entry's index: the pages of that modal this viewer sees. */
function SettingsModalIndexRouteScreen(props: { readonly modal: SettingsModalId }) {
  const insets = useSafeAreaInsets();
  const context = useSettingsModalContext();
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const hubBaseUrl = useHubConnection()?.httpBaseUrl ?? null;
  const pages = settingsModalPages(props.modal, context);

  // What mobile has no screen for opens in the system browser, on the Hub's public URL.
  const browser =
    pages.length === 0
      ? null
      : props.modal === "platform"
        ? {
            label: "Open Platform in browser",
            value: "Users, audit log, master key, AI gateway",
            url: hubBrowserUrl(hubBaseUrl, PLATFORM_BROWSER_PATH),
          }
        : props.modal === "space" &&
            context.principal.isOwner &&
            context.space?.kind === "organization" &&
            context.spaceId
          ? {
              label: "Archive or delete in browser",
              value: "Archive, restore or delete the Organization",
              url: hubBrowserUrl(hubBaseUrl, spaceBrowserPath(context.spaceId)),
            }
          : null;

  const browserUrl = browser?.url ?? null;

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
        {browser !== null && browserUrl !== null ? (
          <SettingsSection title="In the browser">
            <SettingsRow
              icon="safari"
              label={browser.label}
              value={browser.value}
              onPress={() => void tryOpenExternalUrl(browserUrl, "hub-settings")}
            />
          </SettingsSection>
        ) : null}
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
