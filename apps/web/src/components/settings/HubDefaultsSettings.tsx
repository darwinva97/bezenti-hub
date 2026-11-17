import { Link, useParams } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

import { Button } from "../ui/button";

const ThreadsDefaults = lazy(() =>
  import("./SettingsPanels").then((module) => ({ default: module.ThreadsSettingsPanel })),
);
const BrowserDefaults = lazy(() =>
  import("./IntegrationsSettings").then((module) => ({ default: module.BrowserSettingsPanel })),
);
const WorktreesDefaults = lazy(() =>
  import("./WorktreesSettings").then((module) => ({ default: module.WorktreesSettingsPanel })),
);

const SUBSECTIONS = [
  { id: "threads", label: "Threads", Panel: ThreadsDefaults },
  { id: "browser", label: "Browser", Panel: BrowserDefaults },
  { id: "worktrees", label: "Worktrees", Panel: WorktreesDefaults },
] as const;

/** The values every Project of this Hub starts from: Threads, Browser and Worktrees. */
export function HubDefaultsSettings() {
  const { subsection } = useParams({ strict: false });
  const active = SUBSECTIONS.find((candidate) => candidate.id === subsection) ?? SUBSECTIONS[0];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <nav aria-label="Hub defaults" className="flex shrink-0 gap-1 border-b px-5 py-2">
        {SUBSECTIONS.map((entry) => (
          <Button
            key={entry.id}
            size="sm"
            variant={entry.id === active.id ? "outline" : "ghost-muted"}
            aria-current={entry.id === active.id ? "page" : undefined}
            render={
              <Link
                to="/settings/platform/hub-defaults/$subsection"
                params={{ subsection: entry.id }}
                replace
              />
            }
          >
            {entry.label}
          </Button>
        ))}
      </nav>
      <Suspense fallback={null}>
        <active.Panel />
      </Suspense>
    </div>
  );
}
