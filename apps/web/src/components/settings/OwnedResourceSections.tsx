import { Link } from "@tanstack/react-router";
import type { SpaceSummary } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { Button } from "../ui/button";
import { AiAccountsSettingsPanel } from "./AiAccountsSettings";
import { HubEnvironmentsSettings } from "./HubEnvironmentsSettings";
import type { OwnedResourceScope } from "./ownedResourceScope";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsSpace } from "./useSettingsSpace";
import { VaultsSettings } from "./VaultsSettings";

/** User → Vault: the User's own Vault. */
export function UserVaultSection() {
  return <VaultsSettings scope={{ kind: "user" }} />;
}

/** User → AI accounts: the User's own AI accounts, their Local CLI keys and, for the Owner, usage. */
export function UserAiAccountsSection() {
  return <AiAccountsSettingsPanel scope={{ kind: "user" }} />;
}

type OwnedResource = "vault" | "ai-accounts" | "machines";

const RESOURCE_LABELS: Readonly<Record<OwnedResource, string>> = {
  vault: "Vault",
  "ai-accounts": "AI accounts",
  machines: "Machines",
};

/**
 * What a Personal space's resource section says in place of a list: the resources are the User's
 * own, so they are managed in User settings (the Owner, reading another User's Personal space,
 * only reads that they are theirs).
 */
function PersonalSpaceNote({
  space,
  resource,
}: {
  readonly space: SpaceSummary;
  readonly resource: OwnedResource;
}) {
  const label = RESOURCE_LABELS[resource];
  return (
    <SettingsPageContainer>
      <SettingsSection id={`personal-${resource}`} title={label}>
        {space.isOwn ? (
          <SettingsRow
            title={`Your ${label} are yours`}
            description={`A Personal space has no ${label} of its own: it uses the ones you keep in User settings.`}
            control={
              <Button
                size="sm"
                variant="outline"
                render={<Link to="/settings/user/$section" params={{ section: resource }} />}
              >
                Manage in User settings
              </Button>
            }
          />
        ) : (
          <SettingsRow
            title="Read only"
            description={`${space.name}'s ${label} are theirs: they manage them in their own User settings.`}
          />
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function SpaceResourceSection({
  resource,
  children,
}: {
  readonly resource: OwnedResource;
  readonly children: (scope: OwnedResourceScope) => ReactNode;
}) {
  const space = useSettingsSpace();
  if (space === null) return null;
  if (space.kind === "personal") return <PersonalSpaceNote space={space} resource={resource} />;
  return <>{children({ kind: "organization", spaceId: space.id })}</>;
}

/** Space → Vault: the Organization's Vault, for its Admins; a Member reads what the Hub lets them. */
export function SpaceVaultSection() {
  return (
    <SpaceResourceSection resource="vault">
      {(scope) => <VaultsSettings scope={scope} />}
    </SpaceResourceSection>
  );
}

/** Space → AI accounts: the Organization's AI accounts. */
export function SpaceAiAccountsSection() {
  return (
    <SpaceResourceSection resource="ai-accounts">
      {(scope) => <AiAccountsSettingsPanel scope={scope} />}
    </SpaceResourceSection>
  );
}

/** Space → Machines: the machines dedicated to the Organization, and its Sandbox. */
export function SpaceMachinesSection() {
  return (
    <SpaceResourceSection resource="machines">
      {(scope) => (
        <SettingsPageContainer>
          <HubEnvironmentsSettings scope={scope} />
        </SettingsPageContainer>
      )}
    </SpaceResourceSection>
  );
}
