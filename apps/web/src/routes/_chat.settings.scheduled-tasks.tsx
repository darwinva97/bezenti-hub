import { createFileRoute } from "@tanstack/react-router";

import { validateScheduledTasksSearch } from "../components/settings/scheduledTasksSettings.logic";

// Redirected by the settings route, through the old-URL table; the task a link names goes along.
export const Route = createFileRoute("/_chat/settings/scheduled-tasks")({
  validateSearch: validateScheduledTasksSearch,
});
