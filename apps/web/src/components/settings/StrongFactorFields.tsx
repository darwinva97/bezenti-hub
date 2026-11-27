import type { AuthAccount } from "@t3tools/contracts";

import { Button } from "../ui/button";
import {
  hasLocalStrongFactor,
  lacksStrongFactor,
  type StepUpState,
  StepUpFields,
} from "./AccountSettingsSection";

/** An account with no strong factor at all (no Keycloak either) cannot confirm this action. */
function StrongFactorNotice({
  action,
  onOpenAccount,
}: {
  readonly action: string;
  readonly onOpenAccount: () => void;
}) {
  return (
    <p className="text-xs text-warning" role="alert">
      To {action}, add a passkey or an authenticator app to your account first.{" "}
      <Button size="xs" type="button" variant="link" onClick={onOpenAccount}>
        Open Settings → Account
      </Button>
    </p>
  );
}

/**
 * How this account confirms a strong-factor action: here, or through Keycloak for who signs in
 * with it. The Owner, who keeps local credentials beside Keycloak, may switch between both.
 */
export function StrongFactorFields({
  account,
  action = "accept a machine",
  disabled,
  value,
  onChange,
  onOpenAccount,
}: {
  readonly account: AuthAccount;
  readonly action?: string;
  readonly disabled: boolean;
  readonly value: StepUpState;
  readonly onChange: (value: StepUpState) => void;
  readonly onOpenAccount: () => void;
}) {
  if (lacksStrongFactor(account)) {
    return <StrongFactorNotice action={action} onOpenAccount={onOpenAccount} />;
  }
  if (value.viaKeycloak) {
    return (
      <p className="text-xs text-muted-foreground">
        You will confirm it's you with Keycloak, with your second factor, and come back here.{" "}
        {hasLocalStrongFactor(account) ? (
          <Button
            disabled={disabled}
            size="xs"
            type="button"
            variant="link"
            onClick={() => onChange({ ...value, viaKeycloak: false })}
          >
            Use your passkey or password instead
          </Button>
        ) : null}
      </p>
    );
  }
  return (
    <>
      <StepUpFields account={account} disabled={disabled} value={value} onChange={onChange} />
      {account.identity === undefined ? null : (
        <Button
          disabled={disabled}
          size="xs"
          type="button"
          variant="link"
          onClick={() => onChange({ ...value, viaKeycloak: true })}
        >
          Confirm with Keycloak instead
        </Button>
      )}
    </>
  );
}
