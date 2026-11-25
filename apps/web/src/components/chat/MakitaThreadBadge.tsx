import { makitaItemUrl, type ThreadId } from "@t3tools/contracts";
import { BotIcon } from "lucide-react";

import { useMakitaThreads } from "../../state/makitaThreads";
import { Badge } from "../ui/badge";

/** A Makita Thread's header mark: «Makita · repo#n · asked by @caller», linking to GitHub. */
export function MakitaThreadBadge({ threadId }: { readonly threadId: ThreadId }) {
  const task = useMakitaThreads().get(threadId);
  if (task === undefined) return null;
  const label = `Makita · ${task.repo}#${task.number} · asked by @${task.callerLogin}`;
  return (
    <Badge
      variant="outline"
      size="sm"
      className="max-w-72"
      data-makita-thread={task.threadId}
      aria-label={`${label}. Open the ${task.kind === "pull" ? "pull request" : "issue"} on GitHub`}
      render={<a href={makitaItemUrl(task)} target="_blank" rel="noreferrer" />}
    >
      <BotIcon />
      <span className="truncate">{label}</span>
    </Badge>
  );
}
