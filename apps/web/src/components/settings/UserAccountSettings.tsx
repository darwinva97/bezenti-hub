import { AccountSettingsSection } from "./AccountSettingsSection";
import { HubOfThisAppSettings } from "./HubOfThisAppSettings";
import { SettingsPageContainer } from "./settingsLayout";

/**
 * The User's own account. «Connect with Keycloak» (`keycloak-sign-in`) and «Delete my account»
 * (`platform-privacy`) land here when their specs build them.
 */
export function UserAccountSettings() {
  return (
    <SettingsPageContainer>
      <AccountSettingsSection />
      <HubOfThisAppSettings />
    </SettingsPageContainer>
  );
}
