import { useSearch } from "@tanstack/react-router";

import { ScheduledTasksSettings } from "./ScheduledTasksSettings";
import { validateScheduledTasksSearch } from "./scheduledTasksSettings.logic";

/** The Space's scheduled tasks; a link to one carries its `taskId` and `environmentId`. */
export function SpaceScheduledTasksSection() {
  const search = useSearch({ strict: false });
  return <ScheduledTasksSettings {...validateScheduledTasksSearch(search)} />;
}
