import {
  type AssetCreateUrlResult,
  type EnvironmentId,
  WORKSPACE_DOWNLOAD_CONFIRM_BYTES,
} from "@t3tools/contracts";
import { create } from "zustand";

/** What a folder download asks for: one or more paths under `cwd`. */
export interface WorkspaceDownloadTarget {
  readonly cwd: string;
  readonly paths: readonly [string, ...Array<string>];
  readonly includeAll?: boolean;
}

type DownloadPartStatus =
  | "queued"
  | "downloading"
  | "done"
  | "failed"
  | "cancelled"
  /** Given to the browser's own downloads, which report no progress to the page. */
  | "handed-off";

export interface DownloadPart {
  readonly fileName: string;
  readonly relativeUrl: string;
  readonly bytes: number;
  readonly files: number;
  readonly status: DownloadPartStatus;
  readonly received: number;
  readonly error?: string | undefined;
}

type DownloadPhase = "preparing" | "confirm" | "downloading" | "done" | "failed" | "cancelled";

export interface DownloadJob {
  readonly id: number;
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly target: WorkspaceDownloadTarget;
  readonly phase: DownloadPhase;
  readonly summary?: { readonly files: number; readonly bytes: number; readonly skipped: number };
  readonly parts: ReadonlyArray<DownloadPart>;
  readonly error?: string | undefined;
}

/** Signs the download; rejects with the server's refusal. */
export type MintWorkspaceDownload = (target: WorkspaceDownloadTarget) => Promise<{
  readonly result: AssetCreateUrlResult;
  readonly resolveUrl: (relative: string) => string;
}>;

/** Large or split downloads ask first; small ones start at once. */
export function needsDownloadConfirmation(summary: {
  readonly bytes: number;
  readonly parts: number;
}): boolean {
  return summary.parts > 1 || summary.bytes > WORKSPACE_DOWNLOAD_CONFIRM_BYTES;
}

function downloadPhaseOf(parts: ReadonlyArray<DownloadPart>): DownloadPhase {
  if (parts.some((part) => part.status === "downloading" || part.status === "queued")) {
    return "downloading";
  }
  if (parts.some((part) => part.status === "failed")) return "failed";
  if (parts.every((part) => part.status === "cancelled")) return "cancelled";
  return "done";
}

interface WritableTarget {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}
interface FileHandleLike {
  createWritable(): Promise<WritableTarget>;
}
interface DirectoryHandleLike {
  getFileHandle(name: string, options: { create: true }): Promise<FileHandleLike>;
}
interface FileSystemAccessWindow {
  showSaveFilePicker?: (options: { suggestedName: string }) => Promise<FileHandleLike>;
  showDirectoryPicker?: (options: { mode: "readwrite" }) => Promise<DirectoryHandleLike>;
}

interface JobRuntime {
  mint: MintWorkspaceDownload;
  resolveUrl: (relative: string) => string;
  /** Where parts are written as they arrive; none: the browser's own downloads. */
  destination: ((fileName: string) => Promise<FileHandleLike>) | null;
  controller: AbortController | null;
  writable: WritableTarget | null;
}

const runtimes = new Map<number, JobRuntime>();
let nextJobId = 1;
const PROGRESS_INTERVAL_MS = 250;

interface WorkspaceDownloadsState {
  readonly jobs: ReadonlyArray<DownloadJob>;
}

export const useWorkspaceDownloadsStore = create<WorkspaceDownloadsState>(() => ({ jobs: [] }));

const readJob = (id: number) =>
  useWorkspaceDownloadsStore.getState().jobs.find((job) => job.id === id);

function updateJob(id: number, update: (job: DownloadJob) => DownloadJob) {
  useWorkspaceDownloadsStore.setState((state) => ({
    jobs: state.jobs.map((job) => (job.id === id ? update(job) : job)),
  }));
}

function updatePart(id: number, index: number, update: Partial<DownloadPart>) {
  updateJob(id, (job) => {
    const parts = job.parts.map((part, at) => (at === index ? { ...part, ...update } : part));
    return { ...job, parts, phase: downloadPhaseOf(parts) };
  });
}

function handOff(url: string) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "";
  anchor.rel = "noopener";
  anchor.click();
}

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "The download failed.";

async function mintInto(id: number, target: WorkspaceDownloadTarget) {
  const runtime = runtimes.get(id);
  if (!runtime) return;
  updateJob(id, (job) => ({ ...job, target, phase: "preparing" }));
  try {
    const { result, resolveUrl } = await runtime.mint(target);
    if (readJob(id)?.phase !== "preparing") return;
    runtime.resolveUrl = resolveUrl;
    const download = result.download;
    if (download === undefined) {
      handOff(resolveUrl(result.relativeUrl));
      dismissWorkspaceDownload(id);
      return;
    }
    const parts = download.parts.map((part): DownloadPart => ({
      ...part,
      status: "queued",
      received: 0,
    }));
    const summary = { files: download.files, bytes: download.bytes, skipped: download.skipped };
    if (needsDownloadConfirmation({ bytes: download.bytes, parts: parts.length })) {
      updateJob(id, (job) => ({ ...job, summary, parts, phase: "confirm" }));
      return;
    }
    // No dialog, so no user gesture left for a save picker: the browser saves it.
    handOff(resolveUrl(parts[0]!.relativeUrl));
    updateJob(id, (job) => ({
      ...job,
      summary,
      parts: [{ ...parts[0]!, status: "handed-off" }],
      phase: "done",
    }));
  } catch (error) {
    if (readJob(id)?.phase !== "preparing") return;
    updateJob(id, (job) => ({ ...job, phase: "failed", error: errorMessage(error) }));
  }
}

export function startWorkspaceDownload(input: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly target: WorkspaceDownloadTarget;
  readonly mint: MintWorkspaceDownload;
}): number {
  const id = nextJobId++;
  runtimes.set(id, {
    mint: input.mint,
    resolveUrl: (relative) => relative,
    destination: null,
    controller: null,
    writable: null,
  });
  useWorkspaceDownloadsStore.setState((state) => ({
    jobs: [
      ...state.jobs,
      {
        id,
        environmentId: input.environmentId,
        label: input.label,
        target: input.target,
        phase: "preparing",
        parts: [],
      },
    ],
  }));
  void mintInto(id, input.target);
  return id;
}

/** Asks again with `.git` and `node_modules` kept or left out. */
export function setWorkspaceDownloadIncludeAll(id: number, includeAll: boolean) {
  const job = readJob(id);
  if (!job || job.phase !== "confirm") return;
  void mintInto(id, { ...job.target, includeAll });
}

async function pickDestination(job: DownloadJob) {
  const picker = window as unknown as FileSystemAccessWindow;
  if (job.parts.length === 1 && picker.showSaveFilePicker) {
    const handle = await picker.showSaveFilePicker({ suggestedName: job.parts[0]!.fileName });
    return async () => handle;
  }
  if (job.parts.length > 1 && picker.showDirectoryPicker) {
    const directory = await picker.showDirectoryPicker({ mode: "readwrite" });
    return (fileName: string) => directory.getFileHandle(fileName, { create: true });
  }
  return null;
}

/** Starts a confirmed download. Call it from the click that confirms: pickers need the gesture. */
export async function confirmWorkspaceDownload(id: number): Promise<void> {
  const job = readJob(id);
  const runtime = runtimes.get(id);
  if (!job || !runtime || job.phase !== "confirm") return;
  try {
    runtime.destination = await pickDestination(job);
  } catch {
    // Closing the picker cancels, as closing a save dialog does.
    return;
  }
  updateJob(id, (current) => ({ ...current, phase: "downloading" }));
  if (runtime.destination === null) {
    // Browsers allow one automatic download per gesture; the rest wait for their own button.
    handOffWorkspaceDownloadPart(id, 0);
    return;
  }
  await runParts(id, 0);
}

export function handOffWorkspaceDownloadPart(id: number, index: number) {
  const job = readJob(id);
  const runtime = runtimes.get(id);
  const part = job?.parts[index];
  if (!runtime || !part) return;
  handOff(runtime.resolveUrl(part.relativeUrl));
  updatePart(id, index, { status: "handed-off" });
}

async function runParts(id: number, from: number) {
  for (let index = from; ; index++) {
    const job = readJob(id);
    const part = job?.parts[index];
    if (!job || !part) return;
    if (part.status !== "queued") continue;
    const ok = await runPart(id, index);
    if (!ok) return;
  }
}

async function runPart(id: number, index: number): Promise<boolean> {
  const runtime = runtimes.get(id);
  const part = readJob(id)?.parts[index];
  if (!runtime?.destination || !part) return false;
  const controller = new AbortController();
  runtime.controller = controller;
  updatePart(id, index, { status: "downloading", received: 0, error: undefined });
  let writable: WritableTarget | null = null;
  try {
    const response = await fetch(runtime.resolveUrl(part.relativeUrl), {
      signal: controller.signal,
    });
    if (!response.ok || response.body === null) {
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      throw new Error(detail || `The server answered ${response.status}.`);
    }
    writable = await (await runtime.destination(part.fileName)).createWritable();
    runtime.writable = writable;
    const reader = response.body.getReader();
    let received = 0;
    let reportedAt = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await writable.write(value);
      received += value.byteLength;
      const now = performance.now();
      if (now - reportedAt >= PROGRESS_INTERVAL_MS) {
        reportedAt = now;
        updatePart(id, index, { received });
      }
    }
    await writable.close();
    updatePart(id, index, { status: "done", received });
    return true;
  } catch (error) {
    await writable?.abort().catch(() => undefined);
    if (controller.signal.aborted) {
      updatePart(id, index, { status: "cancelled" });
    } else {
      updatePart(id, index, { status: "failed", error: errorMessage(error) });
    }
    return false;
  } finally {
    runtime.controller = null;
    runtime.writable = null;
  }
}

/** Retries a failed or cancelled part with fresh URLs, then goes on with the parts after it. */
export async function retryWorkspaceDownloadPart(id: number, index: number): Promise<void> {
  const job = readJob(id);
  const runtime = runtimes.get(id);
  if (!job || !runtime) return;
  updatePart(id, index, { status: "downloading", received: 0, error: undefined });
  try {
    const { result, resolveUrl } = await runtime.mint(job.target);
    const fresh = result.download?.parts;
    if (!fresh || fresh.length !== job.parts.length) {
      throw new Error("The folder changed since the download started. Start it again.");
    }
    runtime.resolveUrl = resolveUrl;
    updateJob(id, (current) => ({
      ...current,
      parts: current.parts.map((part, at) => ({
        ...part,
        relativeUrl: fresh[at]!.relativeUrl,
        ...(at > index && part.status === "cancelled" ? { status: "queued" as const } : {}),
        ...(at === index ? { status: "queued" as const } : {}),
      })),
    }));
  } catch (error) {
    updatePart(id, index, { status: "failed", error: errorMessage(error) });
    return;
  }
  if (runtime.destination === null) {
    handOffWorkspaceDownloadPart(id, index);
    return;
  }
  await runParts(id, index);
}

export function cancelWorkspaceDownload(id: number) {
  const runtime = runtimes.get(id);
  runtime?.controller?.abort();
  updateJob(id, (job) => {
    if (job.phase === "preparing" || job.phase === "confirm") {
      return { ...job, phase: "cancelled" };
    }
    const parts = job.parts.map((part) =>
      part.status === "queued" || part.status === "downloading"
        ? { ...part, status: "cancelled" as const }
        : part,
    );
    return { ...job, parts, phase: downloadPhaseOf(parts) };
  });
}

export function dismissWorkspaceDownload(id: number) {
  cancelWorkspaceDownload(id);
  runtimes.delete(id);
  useWorkspaceDownloadsStore.setState((state) => ({
    jobs: state.jobs.filter((job) => job.id !== id),
  }));
}
