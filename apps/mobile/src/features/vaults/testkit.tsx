import type { ReactNode } from "react";

/** Shared react-native stand-ins for component tests (no Expo web). */
export const nativeMocks = {
  reactNative: () => ({
    View: ({
      children,
      accessibilityLabel,
    }: {
      children?: ReactNode;
      accessibilityLabel?: string;
    }) => <div aria-label={accessibilityLabel}>{children}</div>,
  }),
  appText: () => ({
    AppText: ({
      children,
      accessibilityRole,
      accessibilityLabel,
    }: {
      children?: ReactNode;
      accessibilityRole?: string;
      accessibilityLabel?: string;
    }) => (
      <span
        role={accessibilityRole === "alert" ? "alert" : undefined}
        aria-label={accessibilityLabel}
      >
        {children}
      </span>
    ),
    AppTextInput: ({
      accessibilityLabel,
      value,
      onChangeText,
      secureTextEntry,
      placeholder,
    }: {
      accessibilityLabel?: string;
      value?: string;
      onChangeText?: (text: string) => void;
      secureTextEntry?: boolean;
      placeholder?: string;
    }) => (
      <input
        aria-label={accessibilityLabel ?? placeholder}
        data-secure={secureTextEntry ? "true" : "false"}
        type={secureTextEntry ? "password" : "text"}
        value={value}
        onChange={(event) => onChangeText?.(event.currentTarget.value)}
      />
    ),
  }),
  button: () => ({
    Button: ({
      label,
      accessibilityLabel,
      onPress,
      disabled,
    }: {
      label: string;
      accessibilityLabel?: string;
      onPress: () => void;
      disabled?: boolean;
    }) => (
      <button aria-label={accessibilityLabel ?? label} disabled={disabled} onClick={onPress}>
        {label}
      </button>
    ),
  }),
  listSection: () => ({
    ListSection: ({ title, children }: { title?: string; children?: ReactNode }) => (
      <section aria-label={title}>{children}</section>
    ),
  }),
  choiceRow: () => ({
    ListChoiceRow: ({
      label,
      selected,
      disabled,
      onPress,
    }: {
      label: string;
      selected: boolean;
      disabled?: boolean;
      onPress: () => void;
    }) => (
      <button
        role="radio"
        aria-checked={selected}
        aria-label={label}
        disabled={disabled}
        onClick={onPress}
      >
        {label}
      </button>
    ),
  }),
  toggleRow: () => ({
    ListToggleRow: ({
      label,
      value,
      onValueChange,
    }: {
      label: string;
      value: boolean | null;
      onValueChange: (value: boolean) => void;
    }) => (
      <button
        role="switch"
        aria-checked={value === true}
        aria-label={label}
        onClick={() => onValueChange(value !== true)}
      >
        {label}
      </button>
    ),
  }),
};
