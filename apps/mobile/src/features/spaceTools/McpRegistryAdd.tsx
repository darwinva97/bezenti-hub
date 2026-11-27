import { commandLineOf, pairsText, sourceText } from "@t3tools/client-runtime/space-tools-view";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, SpaceId, SpaceMcpSearchResult } from "@t3tools/contracts";
import { useState } from "react";
import { Alert, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ListSection } from "../../components/ui/ListSection";
import { spaceToolsEnvironment } from "../../state/spaceTools";
import { useAtomCommand } from "../../state/use-atom-command";

const messageOf = (result: AtomCommandResult<unknown, unknown>, fallback: string) => {
  if (result._tag === "Success") return null;
  const failure = squashAtomCommandFailure(result) as { readonly message?: unknown };
  return typeof failure?.message === "string" ? failure.message : fallback;
};

/** Everything the draft sets, as the confirmation spells it out before saving. */
const draftText = (result: SpaceMcpSearchResult) => {
  const { config } = result;
  const values =
    config.transport === "stdio" ? pairsText(config.env, "=") : pairsText(config.headers, ":");
  return [
    sourceText(result.source),
    config.transport === "stdio" ? `Runs: ${commandLineOf(config)}` : `URL: ${config.url}`,
    values === "" ? null : values,
    result.secrets.length === 0
      ? null
      : `Needs ${result.secrets.join(", ")} in a Vault group this Space receives.`,
    config.transport === "stdio"
      ? "This command runs on the machine of every Thread of this Space."
      : null,
  ]
    .filter((part) => part !== null)
    .join("\n\n");
};

/** Search the MCP Registry and add a result as it is; nothing is saved without confirming. */
export function McpRegistryAdd(props: {
  readonly environmentId: EnvironmentId;
  readonly spaceId: SpaceId;
  readonly onAdded: () => void;
}) {
  const { environmentId, spaceId } = props;
  const searchMcp = useAtomCommand(spaceToolsEnvironment.searchMcp, "search the MCP Registry");
  const putMcp = useAtomCommand(spaceToolsEnvironment.putMcp, "save the MCP server");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ReadonlyArray<SpaceMcpSearchResult> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const search = async () => {
    const text = query.trim();
    if (text.length < 2) return;
    setPending(true);
    const result = await searchMcp({ environmentId, input: { spaceId, query: text } });
    setPending(false);
    if (result._tag === "Success") {
      setResults(result.value.results);
      setError(null);
    } else {
      setResults(null);
      setError(messageOf(result, "Could not search the MCP Registry."));
    }
  };

  const add = async (result: SpaceMcpSearchResult) => {
    setPending(true);
    const saved = await putMcp({
      environmentId,
      input: { spaceId, name: result.name, config: result.config, source: result.source },
    });
    setPending(false);
    const problem = messageOf(saved, "Could not save it.");
    if (problem !== null) {
      setError(problem);
      return;
    }
    setResults(null);
    setQuery("");
    props.onAdded();
  };

  const confirm = (result: SpaceMcpSearchResult) =>
    Alert.alert(`Add ${result.name}?`, draftText(result), [
      { text: "Cancel", style: "cancel" },
      { text: "Add", onPress: () => void add(result) },
    ]);

  return (
    <ListSection title="Add from the MCP Registry">
      <View className="gap-2 px-4 py-3">
        <TextInput
          accessibilityLabel="Search the MCP Registry"
          placeholder="Search the MCP Registry"
          value={query}
          onChangeText={setQuery}
          onSubmitEditing={() => void search()}
          returnKeyType="search"
          editable={!pending}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
        />
        <Button
          label="Search"
          size="compact"
          disabled={pending || query.trim().length < 2}
          onPress={() => void search()}
        />
        {error === null ? null : <Text className="text-danger">{error}</Text>}
        {results !== null && results.length === 0 ? (
          <Text className="text-foreground-muted">Nothing found.</Text>
        ) : null}
      </View>
      {(results ?? []).map((result) => (
        <View key={result.source.id} className="gap-1 px-4 py-3">
          <Text className="font-medium text-foreground">{result.title}</Text>
          {result.description === "" ? null : (
            <Text className="text-sm text-foreground-muted">{result.description}</Text>
          )}
          <Text className="text-sm text-foreground-muted">
            {`${result.config.transport === "stdio" ? "Runs a command" : "Over HTTP"} · ${result.source.id}`}
          </Text>
          <Button
            label="Review and add"
            accessibilityLabel={`Review and add ${result.title}`}
            size="compact"
            disabled={pending}
            onPress={() => confirm(result)}
          />
        </View>
      ))}
    </ListSection>
  );
}
