import { createFileRoute } from "@tanstack/react-router";

import { OpenSourceLicensesPanel } from "../components/settings/OpenSourceLicenses";

export const Route = createFileRoute("/_chat/settings/user/about/licenses")({
  component: OpenSourceLicensesPanel,
});
