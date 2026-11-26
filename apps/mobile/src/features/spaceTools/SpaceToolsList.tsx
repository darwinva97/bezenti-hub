import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  SpaceId,
  SpaceMcpSummary,
  SpaceSkillSummary,
  SpaceToolsList as SpaceToolsListResult,
} from "@t3tools/contracts";
import { useEffect, useEffectEvent, useState } from "react";
import { Alert, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ListSection } from "../../components/ui/ListSection";
import { spaceToolsEnvironment } from "../../state/spaceTools";
import { useAtomCommand } from "../../state/use-atom-command";

type Tool =
  | { readonly kind: "mcp"; readonly row: SpaceMcpSummary }
  | { readonly kind: "skill"; readonly row: SpaceSkillSummary };

const messageOf = (result: AtomCommandResult<unknown, unknown>, fallback: string) => {
  if (result._tag === "Success") return null;
  const failure = squashAtomCommandFailure(result) as { readonly message?: unknown };
  return typeof failure?.message === "string" ? failure.message : fallback;
};

/**
 * Space settings → MCP servers & Skills on a phone: names and state, turning one off or on and
 * deleting it. Adding and editing (a server's settings, a Skill's text) stay on web and desktop.
 */
export function SpaceToolsList(props: {
  readonly environmentId: EnvironmentId;
  readonly spaceId: SpaceId;
}) {
  const { environmentId, spaceId } = props;
  const list = useAtomCommand(spaceToolsEnvironment.list, "list MCP servers and Skills");
  const setEnabled = useAtomCommand(spaceToolsEnvironment.setEnabled, "turn it on or off");
  const remove = useAtomCommand(spaceToolsEnvironment.remove, "delete it");
  const [listed, setListed] = useState<SpaceToolsListResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const show = (result: Awaited<ReturnType<typeof list>>) => {
    if (result._tag === "Success") {
      setListed(result.value);
      setError(null);
    } else setError(messageOf(result, "Could not read them."));
  };
  const applyFirst = useEffectEvent(show);
  const loadFirst = useEffectEvent((target: EnvironmentId, space: SpaceId) =>
    list({ environmentId: target, input: { spaceId: space } }),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the Space's MCP servers and Skills from the Hub when the screen opens.
  useEffect(() => {
    let cancelled = false;
    void loadFirst(environmentId, spaceId).then((result) => {
      if (!cancelled) applyFirst(result);
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, spaceId]);

  const act = async (run: () => Promise<AtomCommandResult<unknown, unknown>>) => {
    setPending(true);
    const result = await run();
    setPending(false);
    const problem = messageOf(result, "That did not work.");
    if (problem !== null) setError(problem);
    show(await list({ environmentId, input: { spaceId } }));
  };
  const refOf = (tool: Tool) =>
    tool.kind === "mcp"
      ? ({ kind: "mcp", id: tool.row.id } as const)
      : ({ kind: "skill", id: tool.row.id } as const);
  const confirmDelete = (tool: Tool) =>
    Alert.alert(
      `Delete ${tool.row.name}?`,
      "This Space's Threads stop receiving it from their next turn, and every Space it is lent to loses it.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => void act(() => remove({ environmentId, input: { tool: refOf(tool) } })),
        },
      ],
    );

  if (listed === null) {
    return <Text className="text-foreground-muted">{error ?? "Loading…"}</Text>;
  }
  const rows = (tools: ReadonlyArray<Tool>, title: string) => (
    <ListSection title={title}>
      {tools.length === 0 ? (
        <Text className="px-4 py-3 text-foreground-muted">{`No ${title} yet.`}</Text>
      ) : (
        tools.map((tool) => {
          const manages = listed.canManage && tool.row.lent === undefined;
          return (
            <View key={tool.row.id} className="gap-2 px-4 py-3">
              <Text className="font-medium text-foreground">{tool.row.name}</Text>
              <Text className="text-sm text-foreground-muted">
                {[
                  tool.kind === "mcp"
                    ? tool.row.transport === "stdio"
                      ? "Runs a command"
                      : "Over HTTP"
                    : tool.row.description,
                  tool.row.enabled ? null : "Off",
                  tool.row.lent === undefined ? null : `Lent by ${tool.row.lent.lenderName}`,
                ]
                  .filter((part) => part !== null)
                  .join(" · ")}
              </Text>
              {manages ? (
                <View className="flex-row gap-2">
                  <Button
                    label={tool.row.enabled ? "Turn off" : "Turn on"}
                    accessibilityLabel={`${tool.row.enabled ? "Turn off" : "Turn on"} ${tool.row.name}`}
                    size="compact"
                    disabled={pending}
                    onPress={() =>
                      void act(() =>
                        setEnabled({
                          environmentId,
                          input: { tool: refOf(tool), enabled: !tool.row.enabled },
                        }),
                      )
                    }
                  />
                  <Button
                    label="Delete"
                    accessibilityLabel={`Delete ${tool.row.name}`}
                    tone="danger"
                    size="compact"
                    disabled={pending}
                    onPress={() => confirmDelete(tool)}
                  />
                </View>
              ) : null}
            </View>
          );
        })
      )}
    </ListSection>
  );
  return (
    <View className="gap-6">
      {error === null ? null : <Text className="text-danger">{error}</Text>}
      {rows(
        listed.mcps.map((row) => ({ kind: "mcp", row })),
        "MCP servers",
      )}
      {rows(
        listed.skills.map((row) => ({ kind: "skill", row })),
        "Skills",
      )}
      {listed.canManage ? (
        <Text className="text-sm text-foreground-muted">
          Add or edit MCP servers and Skills in Space settings on the web or desktop app.
        </Text>
      ) : null}
    </View>
  );
}
