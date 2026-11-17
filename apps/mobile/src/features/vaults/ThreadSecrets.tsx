import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { threadSecretLines, vaultFailureMessage } from "@t3tools/client-runtime/vaults";
import type { EnvironmentId, ThreadId, VaultThreadEnvironment } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

/**
 * The names a Thread's turns, terminals and scripts receive, and which group wins each. Variables
 * with their value (owned-resources 05); a Secret's never.
 */
export function ThreadSecrets(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  return (
    <ThreadSecretsPanel
      key={props.threadId}
      environmentId={props.environmentId}
      threadId={props.threadId}
    />
  );
}

function ThreadSecretsPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const read = useAtomCommand(serverEnvironment.threadVaultEnvironment, "read a Thread's secrets");
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState<{
    readonly threadId: ThreadId;
    readonly environment: VaultThreadEnvironment | null;
    readonly error: string | null;
  } | null>(null);
  const latest = useRef(0);
  const current = shown !== null && shown.threadId === props.threadId ? shown : null;

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    const request = ++latest.current;
    const { threadId } = props;
    setShown(null);
    void read({ environmentId: props.environmentId, input: { threadId } }).then((result) => {
      if (request !== latest.current) return;
      setShown(
        result._tag === "Success"
          ? { threadId, environment: result.value, error: null }
          : {
              threadId,
              environment: null,
              error: vaultFailureMessage(
                squashAtomCommandFailure(result),
                "Could not read the Thread's secrets.",
              ),
            },
      );
    });
  };

  return (
    <View className="gap-2 px-4 py-2">
      <Button
        label={open ? "Hide secrets" : "Secrets"}
        accessibilityLabel="Secrets"
        tone="text"
        size="compact"
        onPress={toggle}
      />
      {!open ? null : current === null ? null : current.error !== null ? (
        <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
          {current.error}
        </Text>
      ) : current.environment === null ? null : current.environment.variables.length === 0 ? (
        <Text className="text-sm text-foreground-muted">This Thread receives no secrets.</Text>
      ) : (
        <View className="gap-1" accessibilityLabel="Secrets this Thread receives">
          <Text className="text-xs text-foreground-muted">
            Environment variables this Thread receives. Variables show their value; Secrets never
            do.
          </Text>
          {threadSecretLines(current.environment).map((line) => (
            <View key={line.name}>
              <Text className="text-sm text-foreground">
                {line.name} from {line.from}
              </Text>
              {line.value === null ? null : (
                <Text selectable className="font-mono text-xs text-foreground">
                  {line.value}
                </Text>
              )}
              {line.winsOver === null ? null : (
                <Text className="text-xs text-foreground-muted">Wins over {line.winsOver}</Text>
              )}
            </View>
          ))}
        </View>
      )}
    </View>
  );
}
