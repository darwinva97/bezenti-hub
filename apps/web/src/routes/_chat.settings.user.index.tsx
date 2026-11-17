import { createFileRoute } from "@tanstack/react-router";

// `/settings/user` is redirected by the settings route, through the old-URL table.
export const Route = createFileRoute("/_chat/settings/user/")({});
