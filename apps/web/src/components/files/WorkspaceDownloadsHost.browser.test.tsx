import {
  type AssetCreateUrlResult,
  EnvironmentId,
  WORKSPACE_DOWNLOAD_CONFIRM_BYTES,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import {
  cancelWorkspaceDownload,
  type MintWorkspaceDownload,
  needsDownloadConfirmation,
  startWorkspaceDownload,
  useWorkspaceDownloadsStore,
} from "~/workspaceDownloads";
import { WorkspaceDownloadsHost } from "./WorkspaceDownloadsHost";

const environmentId = EnvironmentId.make("env-downloads");

function setup() {
  useWorkspaceDownloadsStore.setState({ jobs: [] });
}

function archive(parts: ReadonlyArray<number>, generation = 0): AssetCreateUrlResult {
  const urls = parts.map((bytes, index) => ({
    relativeUrl: `/api/assets/token-${generation}-${index}/part-${index + 1}.zip`,
    fileName: `data-part-${index + 1}-of-${parts.length}.zip`,
    bytes,
    files: 1,
  }));
  return {
    relativeUrl: urls[0]!.relativeUrl,
    expiresAt: 0,
    download: {
      files: parts.length,
      bytes: parts.reduce((total, bytes) => total + bytes, 0),
      skipped: 0,
      parts: urls,
    },
  };
}

function mintReturning(...results: Array<AssetCreateUrlResult>) {
  const calls: Array<unknown> = [];
  const mint: MintWorkspaceDownload = (target) => {
    calls.push(target);
    const result = results[Math.min(calls.length - 1, results.length - 1)]!;
    return Promise.resolve({ result, resolveUrl: (relative) => `https://hub.test${relative}` });
  };
  return { mint, calls };
}

/** A save-folder picker whose files keep what is written to them. */
function stubDirectoryPicker() {
  const written = new Map<string, number>();
  const directory = {
    getFileHandle: (name: string) =>
      Promise.resolve({
        createWritable: () =>
          Promise.resolve({
            write: (chunk: Uint8Array) => {
              written.set(name, (written.get(name) ?? 0) + chunk.byteLength);
              return Promise.resolve();
            },
            close: () => Promise.resolve(),
            abort: () => Promise.resolve(),
          }),
      }),
  };
  const picker = vi.fn(() => Promise.resolve(directory));
  const restore = { [Symbol.dispose]: () => vi.unstubAllGlobals() };
  vi.stubGlobal("showDirectoryPicker", picker);
  return { written, picker, restore };
}

describe("workspace downloads", () => {
  it("asks first only for large or split downloads", () => {
    expect(needsDownloadConfirmation({ bytes: WORKSPACE_DOWNLOAD_CONFIRM_BYTES, parts: 1 })).toBe(
      false,
    );
    expect(
      needsDownloadConfirmation({ bytes: WORKSPACE_DOWNLOAD_CONFIRM_BYTES + 1, parts: 1 }),
    ).toBe(true);
    expect(needsDownloadConfirmation({ bytes: 10, parts: 2 })).toBe(true);
  });

  it("hands a small folder to the browser without asking", async () => {
    setup();
    using click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await using _screen = await render(<WorkspaceDownloadsHost />, { router: false });
    const { mint } = mintReturning(archive([1024]));
    startWorkspaceDownload({
      environmentId,
      label: "docs",
      target: { cwd: "/repo", paths: ["docs"] },
      mint,
    });
    await expect
      .element(page.getByText("saving in your browser's downloads", { exact: false }))
      .toBeVisible();
    expect(click).toHaveBeenCalledTimes(1);
    expect(page.getByRole("alertdialog").elements()).toHaveLength(0);
  });

  it("confirms a split folder, writes its parts in order, and retries a failed part", async () => {
    setup();
    const picker = stubDirectoryPicker();
    using _restore = picker.restore;
    let attempts = 0;
    using _fetch = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      attempts++;
      const url = String(input);
      if (url.includes("token-0-1")) {
        return Promise.resolve(
          new Response("At most 3 folder downloads can run at once.", { status: 429 }),
        );
      }
      const index = Number(/token-\d+-(\d+)/.exec(url)?.[1]);
      return Promise.resolve(new Response(new Uint8Array(index === 0 ? 5 : 7)));
    });
    await using _screen = await render(<WorkspaceDownloadsHost />, { router: false });
    const { mint, calls } = mintReturning(archive([5, 7, 7]), archive([5, 7, 7], 1));
    startWorkspaceDownload({
      environmentId,
      label: "data",
      target: { cwd: "/repo", paths: ["data"] },
      mint,
    });

    await expect
      .element(page.getByText("It downloads as 3 .zip files", { exact: false }))
      .toBeVisible();
    // Without the app stylesheet the dialog's own inert backdrop sits over it; click the button.
    (page.getByRole("button", { name: "Download all" }).element() as HTMLButtonElement).click();
    await expect
      .element(
        page.getByText("Part 2 of 3 failed: At most 3 folder downloads can run at once.", {
          exact: false,
        }),
      )
      .toBeVisible();
    expect(picker.picker).toHaveBeenCalledTimes(1);
    expect(picker.written.get("data-part-1-of-3.zip")).toBe(5);
    expect(picker.written.has("data-part-3-of-3.zip")).toBe(false);

    await userEvent.click(page.getByRole("button", { name: "Retry" }));
    await expect.element(page.getByText("Part 3 of 3 (7 B)", { exact: false })).toBeVisible();
    expect(calls).toHaveLength(2);
    expect(picker.written.get("data-part-2-of-3.zip")).toBe(7);
    expect(picker.written.get("data-part-3-of-3.zip")).toBe(7);
    expect(attempts).toBe(4);
    await expect.element(page.getByRole("button", { name: "Close downloads" })).toBeVisible();
  });

  it("drops a download cancelled while it is being prepared", async () => {
    setup();
    using click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await using _screen = await render(<WorkspaceDownloadsHost />, { router: false });
    const pending = Promise.withResolvers<Awaited<ReturnType<MintWorkspaceDownload>>>();
    const id = startWorkspaceDownload({
      environmentId,
      label: "docs",
      target: { cwd: "/repo", paths: ["docs"] },
      mint: () => pending.promise,
    });
    await expect.element(page.getByText("Preparing…")).toBeVisible();
    cancelWorkspaceDownload(id);
    pending.resolve({ result: archive([1]), resolveUrl: (relative) => relative });
    await expect.element(page.getByText("Cancelled")).toBeVisible();
    expect(click).not.toHaveBeenCalled();
  });
});
