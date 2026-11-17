import { pipe } from "effect/Function";
import {
  SECRET_REQUEST_DEFAULT_PLACEHOLDER,
  secretRequestAnswerInput,
  secretRequestDisplay,
  secretRequestFailureMessage,
  secretRequestPrivacyNote,
  secretRequestTargetLabel,
  secretRequestVaultNameProblem,
  secretRequestVaultValueProblem,
  type SecretRequestItem,
} from "@t3tools/client-runtime/secret-request";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  OrchestrationV2ProjectedTurnItem,
  SecretRequestVaultTargets,
  VaultGroupId,
} from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { View, type ColorValue } from "react-native";

import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../../components/ui/Button";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { SecretValueInput } from "../vaults/SecretValueInput";

const LOCK_SYMBOL: AppSymbolName = { ios: "lock", android: "lock" };
const PRIVATE_SYMBOL: AppSymbolName = { ios: "checkmark.shield", android: "lock" };

export function SecretRequestCard(props: {
  readonly environmentId: EnvironmentId;
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly iconColor: ColorValue;
}) {
  const { item, visibility } = props.projectedItem;
  if (item.type !== "secret_request") return null;
  const display = secretRequestDisplay(item, visibility);
  if (display.kind === "pending") {
    return (
      <PendingSecretRequestForm
        environmentId={props.environmentId}
        item={item}
        iconColor={props.iconColor}
      />
    );
  }
  const icon: AppSymbolName =
    display.kind === "pending-elsewhere"
      ? LOCK_SYMBOL
      : display.outcome === "saved"
        ? "checkmark"
        : "minus";
  return (
    <View className="mb-3 min-h-9 flex-row items-center gap-2 px-1">
      <SymbolView name={icon} size={13} tintColor={props.iconColor} type="monochrome" />
      <Text className="flex-1 font-sans text-sm text-foreground-muted" numberOfLines={2}>
        {item.label} · {display.label}
      </Text>
    </View>
  );
}

function PendingSecretRequestForm(props: {
  readonly environmentId: EnvironmentId;
  readonly item: SecretRequestItem;
  readonly iconColor: ColorValue;
}) {
  const { item } = props;
  const answer = useAtomCommand(serverEnvironment.answerSecretRequest, {
    label: "answer secret request",
    // The failure cause holds the request; keep it out of the console.
    reportFailure: false,
    reportDefect: false,
  });
  // «Also save to Vault»: only the Vaults the Hub offers this User for this Thread (none for a
  // Member or a Guest). The Hub checks the choice again.
  const loadTargets = useAtomCommand(serverEnvironment.secretRequestVaultTargets, {
    label: "list Vaults for a secret request",
    reportFailure: false,
    reportDefect: false,
  });
  const [targets, setTargets] = useState<SecretRequestVaultTargets["vaults"]>([]);
  const [saveToVault, setSaveToVault] = useState(false);
  const [vaultId, setVaultId] = useState<VaultGroupId | null>(null);
  const [vaultName, setVaultName] = useState(item.secretName ?? "");
  const targetsAsked = useRef(false);
  const askTargets = useEffectEvent(() => {
    if (targetsAsked.current) return;
    targetsAsked.current = true;
    void loadTargets({
      environmentId: props.environmentId,
      input: { threadId: item.threadId },
    }).then((result) => {
      if (result._tag !== "Success") {
        targetsAsked.current = false;
        return;
      }
      setTargets(result.value.vaults);
      setVaultId((current) => current ?? result.value.vaults[0]?.id ?? null);
    });
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the Hub once which Vaults this card may save to.
  useEffect(() => {
    askTargets();
  }, []);
  const [secret, setSecret] = useState("");
  const saveProblem = saveToVault
    ? (secretRequestVaultNameProblem(vaultName) ?? secretRequestVaultValueProblem(secret))
    : null;
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Submit then a tap can both run before a re-render; this guard is synchronous.
  const inFlight = useRef(false);

  const save = () => {
    if (saveToVault && (vaultId === null || saveProblem !== null)) return;
    void send(
      saveToVault && vaultId !== null
        ? { type: "save", secret, saveToVault: { vaultId, name: vaultName } }
        : { type: "save", secret },
    );
  };

  const send = async (
    reply:
      | {
          readonly type: "save";
          readonly secret: string;
          readonly saveToVault?: { readonly vaultId: VaultGroupId; readonly name: string };
        }
      | { readonly type: "decline" },
  ) => {
    const input = secretRequestAnswerInput(item, reply);
    if (input === null || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    const result = await answer({ environmentId: props.environmentId, input }).finally(() => {
      inFlight.current = false;
      setSubmitting(false);
    });
    if (result._tag === "Success") {
      setSecret("");
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      pipe(squashAtomCommandFailure(result), secretRequestFailureMessage, setError);
    }
  };

  return (
    <View className="mb-3 gap-3 rounded-[20px] border border-border bg-card-alt p-4">
      <View className="gap-1">
        <Text className="font-t3-bold text-base text-foreground">{item.label}</Text>
        {item.reason.trim() ? (
          <Text className="font-sans text-sm leading-5 text-foreground-muted" selectable>
            {item.reason}
          </Text>
        ) : null}
      </View>
      <SecretValueInput
        accessibilityLabel={item.label}
        placeholder={item.placeholder ?? SECRET_REQUEST_DEFAULT_PLACEHOLDER}
        value={secret}
        onChangeText={setSecret}
        editable={!submitting}
        onSubmitEditing={save}
      />
      {targets.length === 0 ? null : (
        <View className="gap-2">
          <ListToggleRow
            label="Also save to Vault"
            value={saveToVault}
            disabled={submitting}
            onValueChange={setSaveToVault}
          />
          {saveToVault ? (
            <View className="gap-2">
              {targets.map((target) => (
                <Button
                  key={target.id}
                  label={secretRequestTargetLabel(target)}
                  accessibilityLabel={`Vault ${target.name}`}
                  tone={target.id === vaultId ? "primary" : "secondary"}
                  size="compact"
                  disabled={submitting}
                  onPress={() => setVaultId(target.id)}
                />
              ))}
              <TextInput
                accessibilityLabel="Secret name"
                placeholder="NAME"
                value={vaultName}
                onChangeText={(text) => setVaultName(text.toUpperCase())}
                editable={!submitting}
                autoCapitalize="characters"
                autoCorrect={false}
                spellCheck={false}
              />
              <Text
                className={
                  saveProblem === null
                    ? "font-sans text-xs text-foreground-muted"
                    : "font-sans text-xs text-danger-foreground"
                }
              >
                {saveProblem ?? `Threads that receive this Vault get it as ${vaultName.trim()}.`}
              </Text>
            </View>
          ) : null}
        </View>
      )}
      {error !== null ? (
        <Text
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          className="font-sans text-sm text-danger-foreground"
        >
          {error}
        </Text>
      ) : null}
      <Button
        label="Save securely"
        tone="primary"
        fullWidth
        disabled={submitting || secret.trim().length === 0 || saveProblem !== null}
        onPress={save}
      />
      <View className="flex-row items-center justify-between gap-2">
        <View className="flex-1 flex-row items-center gap-1.5">
          <SymbolView
            name={PRIVATE_SYMBOL}
            size={13}
            tintColor={props.iconColor}
            type="monochrome"
          />
          <Text className="flex-1 font-sans text-xs text-foreground-muted">
            {secretRequestPrivacyNote(item)}
          </Text>
        </View>
        <Button
          label="Decline"
          tone="text"
          disabled={submitting}
          onPress={() => void send({ type: "decline" })}
        />
      </View>
    </View>
  );
}
