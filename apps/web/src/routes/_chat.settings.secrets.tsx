import { createFileRoute, redirect } from "@tanstack/react-router";

import { SecretsSettingsPanel } from "../components/settings/SecretsSettings";
import { isSecretsFeatureEnabled } from "../env";

export const Route = createFileRoute("/_chat/settings/secrets")({
  beforeLoad: () => {
    if (!isSecretsFeatureEnabled)
      throw redirect({
        to: "/settings/user/$section",
        params: { section: "general" },
        replace: true,
      });
  },
  component: SecretsSettingsPanel,
});
