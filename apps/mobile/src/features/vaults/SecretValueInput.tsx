import { useState } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { ListToggleRow } from "../../components/ui/ListToggleRow";

const NO_HELP = {
  autoCorrect: false,
  autoCapitalize: "none",
  autoComplete: "off",
  textContentType: "none",
  importantForAutofill: "no",
  spellCheck: false,
} as const;

/**
 * A Secret's value on a phone (owned-resources 02): one hidden line, or «Several lines» for a PEM
 * key or a JSON credential. A phone cannot hide what is typed over several lines, so that is a
 * choice, said so; either way the field is cleared once saved and nothing reads it back.
 */
export function SecretValueInput(props: {
  readonly accessibilityLabel: string;
  readonly placeholder: string;
  readonly value: string;
  readonly onChangeText: (value: string) => void;
  readonly editable: boolean;
  /** A Variable's value is meant to be seen: never hidden. */
  readonly visible?: boolean;
  readonly onSubmitEditing?: () => void;
}) {
  const [multiline, setMultiline] = useState(props.value.includes("\n"));
  const hidden = props.visible !== true && !multiline;
  return (
    <View className="gap-2">
      <TextInput
        accessibilityLabel={props.accessibilityLabel}
        placeholder={props.placeholder}
        value={props.value}
        onChangeText={props.onChangeText}
        editable={props.editable}
        multiline={multiline}
        secureTextEntry={hidden}
        {...NO_HELP}
        {...(multiline || props.onSubmitEditing === undefined
          ? {}
          : { returnKeyType: "done" as const, onSubmitEditing: props.onSubmitEditing })}
      />
      <ListToggleRow
        label="Several lines"
        value={multiline}
        disabled={!props.editable}
        onValueChange={setMultiline}
      />
      {multiline && props.visible !== true ? (
        <Text className="text-xs text-foreground-muted">
          Shown while you type, so a PEM key or a JSON file keeps its lines. Cleared once saved.
        </Text>
      ) : null}
    </View>
  );
}
