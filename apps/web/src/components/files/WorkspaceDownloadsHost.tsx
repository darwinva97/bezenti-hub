import { WORKSPACE_DOWNLOAD_PART_BYTES } from "@t3tools/contracts";
import {
  AlertCircleIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CircleIcon,
  DownloadIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";

import { formatBytes } from "~/lib/formatBytes";
import {
  cancelWorkspaceDownload,
  confirmWorkspaceDownload,
  dismissWorkspaceDownload,
  type DownloadJob,
  type DownloadPart,
  handOffWorkspaceDownloadPart,
  retryWorkspaceDownloadPart,
  setWorkspaceDownloadIncludeAll,
  useWorkspaceDownloadsStore,
} from "~/workspaceDownloads";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Spinner } from "../ui/spinner";

const ACTIVE_PHASES = new Set(["preparing", "confirm", "downloading"]);

function ConfirmDownloadDialog({ job }: { job: DownloadJob | undefined }) {
  const summary = job?.summary;
  const parts = job?.parts.length ?? 0;
  return (
    <AlertDialog
      open={job !== undefined}
      onOpenChange={(open) => {
        if (!open && job) cancelWorkspaceDownload(job.id);
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Download “{job?.label}”?</AlertDialogTitle>
          {summary ? (
            <AlertDialogDescription>
              {parts > 1
                ? `This download is ${formatBytes(summary.bytes)} in ${summary.files.toLocaleString()} files. It downloads as ${parts} .zip files of up to ${formatBytes(WORKSPACE_DOWNLOAD_PART_BYTES)} each.`
                : `This download is ${formatBytes(summary.bytes)} in ${summary.files.toLocaleString()} files, as one .zip file.`}
            </AlertDialogDescription>
          ) : null}
        </AlertDialogHeader>
        {job ? (
          <label className="flex items-center gap-2 px-6 text-sm">
            <Checkbox
              checked={job.target.includeAll !== true}
              onCheckedChange={(checked) => setWorkspaceDownloadIncludeAll(job.id, !checked)}
            />
            Leave out .git and node_modules
            {summary && summary.skipped > 0 && job.target.includeAll !== true
              ? ` (${summary.skipped.toLocaleString()} items left out)`
              : null}
          </label>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <Button
            disabled={job?.phase !== "confirm"}
            onClick={() => {
              if (job) void confirmWorkspaceDownload(job.id);
            }}
          >
            {parts > 1 ? "Download all" : "Download"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

function partTitle(index: number, count: number) {
  return count > 1 ? `Part ${index + 1} of ${count}` : "Download";
}

function PartRow({ job, part, index }: { job: DownloadJob; part: DownloadPart; index: number }) {
  const count = job.parts.length;
  const title = partTitle(index, count);
  switch (part.status) {
    case "downloading": {
      const percent =
        part.bytes > 0 ? Math.min(99, Math.floor((part.received / part.bytes) * 100)) : 0;
      return (
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              {title} · {formatBytes(part.received)} / {formatBytes(part.bytes)}
            </span>
            <span>{percent} %</span>
          </div>
          <div
            className="h-1.5 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-label={title}
            aria-valuenow={percent}
          >
            <div className="h-full bg-primary" style={{ width: `${percent}%` }} />
          </div>
        </div>
      );
    }
    case "done":
      return (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <CheckIcon className="size-3.5" /> {title} ({formatBytes(part.bytes)})
        </div>
      );
    case "handed-off":
      return (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <DownloadIcon className="size-3.5" /> {title}: saving in your browser's downloads
        </div>
      );
    case "queued":
      return (
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <CircleIcon className="size-3.5" /> {title} queued
          </span>
          {job.phase === "downloading" &&
          !job.parts.some((other) => other.status === "downloading") ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => handOffWorkspaceDownloadPart(job.id, index)}
            >
              Download part {index + 1}
            </Button>
          ) : null}
        </div>
      );
    case "failed":
    case "cancelled":
      return (
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
            <AlertCircleIcon className="size-3.5 shrink-0" />
            <span className="break-words">
              {title}{" "}
              {part.status === "failed"
                ? `failed${part.error ? `: ${part.error}` : ""}`
                : "cancelled"}
            </span>
          </span>
          <Button
            size="xs"
            variant="outline"
            onClick={() => void retryWorkspaceDownloadPart(job.id, index)}
          >
            Retry
          </Button>
        </div>
      );
  }
}

function JobRow({ job }: { job: DownloadJob }) {
  const active = ACTIVE_PHASES.has(job.phase);
  return (
    <li className="flex flex-col gap-1.5 border-t px-3 py-2 first:border-t-0">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium">{job.label}</span>
        {active ? (
          <Button size="xs" variant="ghost" onClick={() => cancelWorkspaceDownload(job.id)}>
            Cancel
          </Button>
        ) : (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Dismiss ${job.label}`}
            onClick={() => dismissWorkspaceDownload(job.id)}
          >
            <XIcon />
          </Button>
        )}
      </div>
      {job.phase === "preparing" ? (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Spinner className="size-3.5" /> Preparing…
        </div>
      ) : job.phase === "confirm" ? (
        <div className="text-xs text-muted-foreground">Waiting for confirmation</div>
      ) : job.phase === "cancelled" && job.parts.length === 0 ? (
        <div className="text-xs text-muted-foreground">Cancelled</div>
      ) : job.phase === "failed" && job.parts.length === 0 ? (
        <div className="text-xs text-destructive">{job.error ?? "The download failed."}</div>
      ) : (
        job.parts.map((part, index) => (
          <PartRow key={part.fileName} job={job} part={part} index={index} />
        ))
      )}
    </li>
  );
}

/** The downloads card and its confirmation dialog; mounted once, above every route. */
export function WorkspaceDownloadsHost() {
  const jobs = useWorkspaceDownloadsStore((state) => state.jobs);
  const [collapsed, setCollapsed] = useState(false);
  const confirming = jobs.find(
    (job) => job.phase === "confirm" || (job.phase === "preparing" && job.summary),
  );
  const activeCount = jobs.filter((job) => ACTIVE_PHASES.has(job.phase)).length;
  return (
    <>
      <ConfirmDownloadDialog job={confirming} />
      {jobs.length > 0 ? (
        <section
          aria-label="Downloads"
          className="fixed right-4 bottom-4 z-50 flex w-80 flex-col overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg"
        >
          <header className="flex items-center justify-between gap-2 border-b bg-muted/40 px-3 py-2">
            <span className="text-sm font-medium">
              {activeCount > 0
                ? `Downloading ${activeCount} ${activeCount === 1 ? "item" : "items"}`
                : "Downloads"}
            </span>
            <span className="flex items-center gap-1">
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={collapsed ? "Show downloads" : "Hide downloads"}
                onClick={() => setCollapsed(!collapsed)}
              >
                {collapsed ? <ChevronUpIcon /> : <ChevronDownIcon />}
              </Button>
              {activeCount === 0 ? (
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Close downloads"
                  onClick={() => {
                    for (const job of jobs) dismissWorkspaceDownload(job.id);
                  }}
                >
                  <XIcon />
                </Button>
              ) : null}
            </span>
          </header>
          {collapsed ? null : (
            <ul className="max-h-80 overflow-y-auto">
              {jobs.map((job) => (
                <JobRow key={job.id} job={job} />
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </>
  );
}
