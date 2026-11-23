import { useAtomValue } from "@effect/atom-react";
import {
  aiAccountPickerLabel,
  aiAccountServes,
  aiAccountsDecide,
  aiAccountsFor,
  deriveThreadAiAccount,
  nameThreadAiAccount,
  resolveAiAccount,
} from "@t3tools/client-runtime/ai-account-picker";
import type {
  AiAccountId,
  AiAccountPickerResult,
  EnvironmentId,
  ModelSelection,
  ServerProvider,
  SpaceId,
  ThreadId,
} from "@t3tools/contracts";
import { useEffect, useEffectEvent, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { aiGatewayEnvironment } from "../../state/aiGateway";
import { useAtomCommand } from "../../state/use-atom-command";
import { commandFailureMessage } from "./failureMessage";

type Structure = Parameters<typeof deriveThreadAiAccount>[0];

/**
 * The account in use and its picker above a Thread's composer, as the Hub answers. Mid-Thread a
 * change goes to the Hub (gated by its permission); on a draft it joins the model selection.
 */
export function ThreadAiAccountStrip(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly isDraft: boolean;
  readonly spaceId: SpaceId | null | undefined;
  readonly threadEnvironmentId?: EnvironmentId | null | undefined;
  readonly modelSelection: ModelSelection;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly structure: Structure;
  readonly onChooseDraft: (accountId: AiAccountId) => void;
}) {
  const { environmentId, spaceId, threadEnvironmentId } = props;
  const pick = useAtomCommand(aiGatewayEnvironment.pickerAccounts, "read your AI accounts");
  const switchAccount = useAtomCommand(
    aiGatewayEnvironment.setThreadAccount,
    "switch the Thread's AI account",
  );
  const mayChange = useAtomValue(
    aiGatewayEnvironment.setThreadAccount.permissionAtom(environmentId),
  );
  const [answer, setAnswer] = useState<{
    readonly key: string;
    readonly result: AiAccountPickerResult;
  } | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = `${environmentId}|${spaceId ?? ""}|${threadEnvironmentId ?? ""}`;
  const load = useEffectEvent((space: SpaceId) =>
    pick({
      environmentId,
      input: {
        spaceId: space,
        ...(threadEnvironmentId == null ? {} : { environmentId: threadEnvironmentId }),
      },
    }),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads from the Hub, once per Space and machine, which AI accounts this Thread may use.
  useEffect(() => {
    if (spaceId == null) return;
    let cancelled = false;
    void load(spaceId).then((result) => {
      if (!cancelled && result._tag === "Success") setAnswer({ key, result: result.value });
    });
    return () => {
      cancelled = true;
    };
  }, [spaceId, key]);
  const picker = answer !== null && answer.key === key ? answer.result : null;

  const driver = props.providers.find(
    (provider) => provider.instanceId === props.modelSelection.instanceId,
  )?.driver;
  const decides = driver !== undefined && aiAccountsDecide(driver, picker);
  const selectable =
    driver === undefined
      ? []
      : aiAccountsFor(driver, picker).filter((account) =>
          aiAccountServes(account, props.modelSelection.model),
        );
  const selected =
    driver === undefined
      ? undefined
      : resolveAiAccount({
          driver,
          model: props.modelSelection.model,
          picker,
          preferred: props.modelSelection.aiAccountId,
        });
  const inUse = nameThreadAiAccount({
    session: props.isDraft ? null : deriveThreadAiAccount(props.structure),
    threadSelection: props.modelSelection,
    picker,
  });
  const label =
    inUse ??
    (selected === undefined ? null : { name: selected.name, model: props.modelSelection.model });
  if (!decides || label === null) return null;
  // A lent account says whose it is and how much of its cap is used («Team · from Ana · 40% of
  // daily cap»), as web's picker does.
  const inUseAccount =
    inUse === null ? selected : picker?.accounts.find((account) => account.id === inUse.id);
  const shownName = inUseAccount === undefined ? label.name : aiAccountPickerLabel(inUseAccount);

  const choose = async (accountId: AiAccountId) => {
    setOpen(false);
    setError(null);
    if (accountId === selected?.id) return;
    if (props.isDraft) {
      props.onChooseDraft(accountId);
      return;
    }
    const result = await switchAccount({
      environmentId,
      input: {
        threadId: props.threadId,
        aiAccountId: accountId,
        instanceId: props.modelSelection.instanceId,
        model: props.modelSelection.model,
      },
    });
    if (result._tag !== "Success") {
      setError(commandFailureMessage(result, "Could not switch the AI account."));
    }
  };

  return (
    <View className="gap-1 px-4 pb-1">
      <View className="flex-row items-center justify-between gap-2">
        <Text
          accessibilityLabel={`AI account in use: ${label.name}`}
          className="min-w-0 shrink text-xs text-foreground-muted"
          numberOfLines={1}
        >
          {shownName}
          {label.model === null ? "" : ` · ${label.model}`}
        </Text>
        {mayChange && selectable.length > 1 ? (
          <Button
            label={open ? "Close" : "Change AI account"}
            tone="text"
            size="compact"
            onPress={() => setOpen((value) => !value)}
          />
        ) : null}
      </View>
      {open
        ? selectable.map((account) => (
            <Button
              key={account.id}
              label={aiAccountPickerLabel(account)}
              accessibilityLabel={`Use AI account ${account.name}`}
              tone={account.id === selected?.id ? "primary" : "secondary"}
              size="compact"
              onPress={() => void choose(account.id)}
            />
          ))
        : null}
      {error === null ? null : (
        <Text accessibilityRole="alert" className="text-xs text-danger-foreground">
          {error}
        </Text>
      )}
    </View>
  );
}
