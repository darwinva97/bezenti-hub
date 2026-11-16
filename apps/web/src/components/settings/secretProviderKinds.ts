import { VaultIcon } from "lucide-react";
import type { ComponentType } from "react";

import { OnePasswordIcon } from "../Icons";

export interface SecretProviderKindPresentation {
  readonly name: string;
  readonly icon: ComponentType<{ readonly className?: string; readonly "aria-hidden"?: boolean }>;
}

/** How Settings shows each kind of secret provider this client can configure. */
export const SECRET_PROVIDER_KINDS: Readonly<Record<string, SecretProviderKindPresentation>> = {
  one_password: { name: "1Password", icon: OnePasswordIcon },
  openbao: { name: "OpenBao / Vault", icon: VaultIcon },
};
