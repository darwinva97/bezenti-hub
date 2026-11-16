import type { EnvironmentId, SecretProviderConfig, SecretProviderId } from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import type { EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentSessionState } from "../../state/session";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { SecretProviderDialog } from "./SecretProviderDialog";
import { SECRET_PROVIDER_KINDS } from "./secretProviderKinds";
import { checkText, ProviderScopesSettings } from "./ProviderScopesSettings";
import { settle } from "./vaultCommands";
import { errorMessageOf } from "../../lib/errorMessage";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { classifySecretProvider } from "./SecretProviderDialog.logic";
import {
  classifyProviderEnvironmentAccess,
  resolveRemoteOperateAccess,
} from "./ProviderSettingsPanel.logic";
import { useSettingsScope } from "./SettingsScopeContext";
import { RedactedSensitiveText } from "./RedactedSensitiveText";
import { searchableSetting } from "./settingsSearch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

export function SecretsSettingsPanel() {
  const { scope, environment } = useSettingsScope();
  const connected = environment?.connection.phase === "connected";
  return (
    <SettingsPageContainer>
      {connected &&
      environment.serverConfig !== null &&
      environment.serverConfig.secretProviderSettings !== true ? (
        <SettingsSection {...searchableSetting("secret-providers")}>
          <p className="px-4 py-3 text-sm text-muted-foreground">
            Update T3 Code on {environment.label} to manage its secret providers.
          </p>
        </SettingsSection>
      ) : connected ? (
        <EnvironmentSecretProviders
          key={environment.environmentId}
          environment={environment}
          projectScoped={scope.kind === "project" || scope.kind === "checkout"}
        />
      ) : (
        <SettingsSection {...searchableSetting("secret-providers")}>
          <p className="px-4 py-3 text-sm text-muted-foreground">
            Connect an environment to manage the secret providers its provider variables read from.
          </p>
        </SettingsSection>
      )}
    </SettingsPageContainer>
  );
}

function EnvironmentSecretProviders({
  environment,
  projectScoped,
}: {
  readonly environment: EnvironmentPresentation;
  readonly projectScoped: boolean;
}) {
  const environmentId = environment.environmentId;
  const sessionState = useEnvironmentSessionState(environmentId);
  // The server requires the same grant for secret providers as for provider settings.
  const access = classifyProviderEnvironmentAccess({
    connectionPhase: environment.connection.phase,
    hasServerConfig: environment.serverConfig !== null,
    operateAccess: resolveRemoteOperateAccess({
      session: sessionState.data,
      isPending: sessionState.isPending,
      hasError: sessionState.hasError,
    }),
  });
  const readOnly = access.kind !== "editable" || projectScoped;
  const providers = useEnvironmentSettings(environmentId, (settings) => settings.secretProviders);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [dialog, setDialog] = useState<
    null | { readonly mode: "add" } | { readonly mode: "edit"; readonly id: SecretProviderId }
  >(null);
  const entries = Object.entries(providers) as Array<[SecretProviderId, SecretProviderConfig]>;
  const editingConfig = dialog?.mode === "edit" ? providers[dialog.id] : undefined;
  const editing =
    dialog?.mode === "edit" && editingConfig !== undefined
      ? { id: dialog.id, config: editingConfig }
      : undefined;
  return (
    <>
      <SettingsSection
        {...searchableSetting("secret-providers")}
        headerAction={
          !readOnly ? (
            <Button size="xs" variant="outline" onClick={() => setDialog({ mode: "add" })}>
              <PlusIcon className="size-3" aria-hidden />
              Add provider
            </Button>
          ) : null
        }
      >
        {projectScoped ? (
          <p className="px-4 pt-3 text-xs text-muted-foreground">
            Environment-wide setting. Select an environment to change it.
          </p>
        ) : null}
        {entries.length === 0 ? (
          <SettingsRow
            title="No secret providers configured."
            description="Add a 1Password account or an OpenBao server, then pick it as the source of a provider variable or a Vault entry."
          />
        ) : (
          entries.map(([id, config]) => {
            const classified = classifySecretProvider(config);
            const kind =
              classified.kind === "unsupported"
                ? undefined
                : SECRET_PROVIDER_KINDS[classified.kind];
            return (
              <SettingsRow
                key={id}
                title={
                  <span className="flex min-w-0 items-center gap-2">
                    {kind ? (
                      <kind.icon className="size-4.5 shrink-0 text-foreground/80" aria-hidden />
                    ) : null}
                    <span className="min-w-0 wrap-anywhere">{config.label}</span>
                  </span>
                }
                description={
                  classified.kind === "one_password" && kind ? (
                    <span className="flex min-w-0 items-center gap-1">
                      <span className="shrink-0">{kind.name} ·</span>
                      <RedactedSensitiveText
                        value={classified.account}
                        ariaLabel="Toggle account visibility"
                        revealTooltip="Click to reveal account"
                        hideTooltip="Click to hide account"
                        className="max-w-full truncate"
                      />
                    </span>
                  ) : classified.kind === "openbao" && kind ? (
                    <span className="min-w-0 truncate">
                      {kind.name} · {classified.config.address}
                    </span>
                  ) : (
                    `Unsupported provider (${config.kind})`
                  )
                }
                control={
                  !readOnly ? (
                    <div className="flex items-center gap-1">
                      {kind ? (
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() => setDialog({ mode: "edit", id })}
                        >
                          Edit
                        </Button>
                      ) : null}
                      <TestSecretProviderButton environmentId={environmentId} providerId={id} />
                      <RemoveSecretProviderButton
                        environmentId={environmentId}
                        providerId={id}
                        label={config.label}
                        onConfirm={() => updateSettings({ secretProviders: { [id]: null } })}
                      />
                    </div>
                  ) : null
                }
              />
            );
          })
        )}
      </SettingsSection>
      {!readOnly ? (
        <ProviderScopesSettings environmentId={environmentId} providers={providers} />
      ) : null}
      {dialog !== null && !readOnly && (dialog.mode === "add" || editing !== undefined) ? (
        <SecretProviderDialog
          onClose={() => setDialog(null)}
          environmentId={environmentId}
          environmentLabel={environment.label}
          existingIds={new Set(Object.keys(providers))}
          {...(editing === undefined ? {} : { existing: editing })}
        />
      ) : null}
    </>
  );
}

/** «Test connection»: the provider's sign-in, in words; never a value. */
function TestSecretProviderButton({
  environmentId,
  providerId,
}: {
  readonly environmentId: EnvironmentId;
  readonly providerId: SecretProviderId;
}) {
  const test = useAtomCommand(serverEnvironment.testSecretProvider, "test a secret provider");
  const [result, setResult] = useState<string | null>(null);
  return (
    <>
      {result === null ? null : (
        <span className="text-xs text-muted-foreground" role="status">
          {result}
        </span>
      )}
      <Button
        size="xs"
        variant="ghost"
        onClick={() =>
          void settle(test({ environmentId, input: { providerId } })).then(
            (answer) => setResult(checkText("Sign-in", answer.auth)),
            (cause: unknown) => setResult(errorMessageOf(cause, "Could not test it.")),
          )
        }
      >
        Test connection
      </Button>
    </>
  );
}

function RemoveSecretProviderButton({
  environmentId,
  providerId,
  label,
  onConfirm,
}: {
  readonly environmentId: EnvironmentId;
  readonly providerId: SecretProviderId;
  readonly label: string;
  readonly onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  const impactOf = useAtomCommand(serverEnvironment.secretProviderImpact, "read what breaks");
  // What removing it breaks (Vaults ticket 03): its scopes and Provider entries, by name.
  const [breaks, setBreaks] = useState<string | null>(null);
  return (
    <>
      <Button
        size="xs"
        variant="ghost"
        onClick={() => {
          setOpen(true);
          void settle(impactOf({ environmentId, input: { providerId } })).then(
            (impact) =>
              setBreaks(
                impact.breaks.length === 0 && impact.scopes.length === 0
                  ? null
                  : `Its scopes (${impact.scopes.map((scope) => scope.label).join(", ") || "none"}) and these Provider entries break: ${impact.breaks.map((entry) => `${entry.vaultName} → ${entry.name}`).join(", ") || "none"}.`,
              ),
            () => setBreaks(null),
          );
        }}
      >
        Remove
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {label}?</AlertDialogTitle>
            <AlertDialogDescription>
              Provider variables that read from {label} stop resolving until a provider with the
              same name is added again. The secrets themselves are untouched.
              {breaks === null ? null : ` ${breaks}`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
            >
              Remove provider
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
