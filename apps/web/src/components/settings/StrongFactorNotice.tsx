import { Button } from "../ui/button";

/** An account with neither a passkey nor an authenticator app cannot confirm a machine's loan. */
export function StrongFactorNotice({ onOpenAccount }: { readonly onOpenAccount: () => void }) {
  return (
    <p className="text-xs text-warning" role="alert">
      To accept a machine, add a passkey or an authenticator app to your account first.{" "}
      <Button size="xs" type="button" variant="link" onClick={onOpenAccount}>
        Open Settings → Account
      </Button>
    </p>
  );
}
