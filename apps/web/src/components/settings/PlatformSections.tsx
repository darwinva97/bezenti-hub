import { HubSandboxesSettings } from "./HubSandboxesSettings";
import { MasterKeySettingsSection } from "./MasterKeySettingsSection";
import { SandboxImageSettings } from "./SandboxImageSettings";
import { SettingsPageContainer } from "./settingsLayout";

export function PlatformMasterKeySection() {
  return (
    <SettingsPageContainer>
      <MasterKeySettingsSection />
    </SettingsPageContainer>
  );
}

/** The Sandboxes of the Hub, their limits and the image they run. */
export function PlatformSandboxesSection() {
  return (
    <SettingsPageContainer>
      <HubSandboxesSettings />
      <SandboxImageSettings />
    </SettingsPageContainer>
  );
}
