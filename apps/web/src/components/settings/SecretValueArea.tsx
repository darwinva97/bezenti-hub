import type * as React from "react";

import { Textarea } from "../ui/textarea";

/** Discs instead of what is typed: a style on the text area itself (its class goes to a wrapper). */
const HIDDEN_AS_TYPED = { WebkitTextSecurity: "disc" } as React.CSSProperties;

type SecretValueAreaProps = Omit<
  React.ComponentProps<typeof Textarea>,
  "autoComplete" | "spellCheck" | "value" | "onChange"
> & {
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  /** A Variable's value is meant to be seen: shown as typed. */
  readonly visible?: boolean;
};

/**
 * A Secret's value as typed (owned-resources 02): a text area, so a PEM key or a JSON credential
 * keeps its lines (a browser's text area gives LF). Hidden as typed unless `visible`; not a login, so no
 * password manager offers to save it. The caller clears it once saved: nothing reads it back.
 */
export function SecretValueArea({
  value,
  onValueChange,
  visible = false,
  style,
  ...props
}: SecretValueAreaProps) {
  return (
    <Textarea
      {...props}
      style={visible ? style : { ...style, ...HIDDEN_AS_TYPED }}
      rows={props.rows ?? 1}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      data-1p-ignore
      data-lpignore="true"
      data-bwignore
      value={value}
      onChange={(event) => onValueChange(event.currentTarget.value)}
    />
  );
}
