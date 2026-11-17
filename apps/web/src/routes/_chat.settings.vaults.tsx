import { createFileRoute } from "@tanstack/react-router";

// Moved into User settings (an Organization's anchors into its Space settings); the settings route
// redirects old links.
export const Route = createFileRoute("/_chat/settings/vaults")({});
