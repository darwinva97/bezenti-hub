import { EnvironmentId, SpaceId, UserId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { useCurrentSpace } from "../../state/currentSpace";
import { ArchivedThreadsPanel } from "./ArchivedThreadsPanel";

const environmentId = EnvironmentId.make("laptop");
const spaceA = SpaceId.make("space-a");
const spaceB = SpaceId.make("space-b");

const archivedThread = (id: string, projectId: string, title: string) => ({
  id,
  projectId,
  title,
  createdAt: "2026-09-17T00:00:00.000Z",
  archivedAt: "2026-09-18T00:00:00.000Z",
});

vi.mock("./SettingsScopeContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./SettingsScopeContext")>()),
  useSettingsScope: () => ({
    scope: { kind: "all", label: "All", members: [], environmentIds: [environmentId] },
    groups: [],
    environments: [{ environmentId, label: "Laptop" }],
  }),
}));
vi.mock("../../lib/archivedThreadsState", () => ({
  useArchivedThreadSnapshots: () => ({
    snapshots: [
      {
        environmentId,
        snapshot: {
          projects: [
            { id: "project-a", title: "Acme site", spaceId: spaceA },
            { id: "project-b", title: "Beta app", spaceId: spaceB },
          ],
          threads: [
            archivedThread("thread-a", "project-a", "Fix login"),
            archivedThread("thread-b", "project-b", "Rewrite billing"),
          ],
        },
      },
    ],
    error: null,
    isLoading: false,
    refresh: vi.fn(),
  }),
}));
vi.mock("../../hooks/useThreadActions", () => ({
  useThreadActions: () => ({ unarchiveThread: vi.fn(), confirmAndDeleteThread: vi.fn() }),
}));
vi.mock("@t3tools/client-runtime/state/shell", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/shell")>()),
  presentThreadShell: (id: string, thread: object) => ({ ...thread, environmentId: id }),
}));
vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => null }));

function showSpace(currentSpaceId: SpaceId): Disposable {
  const space = (id: SpaceId, name: string) => ({
    id,
    kind: "organization" as const,
    name,
    role: "member" as const,
    isOwn: false,
    canCreateThreads: true,
    canInvite: false,
  });
  useCurrentSpace.setState({
    environmentId,
    currentSpaceId,
    view: {
      userId: UserId.make("user-me"),
      spaces: [space(spaceA, "A"), space(spaceB, "B")],
      personalSpaceId: SpaceId.make("space-personal"),
      canCreateOrganization: false,
    },
  });
  return {
    [Symbol.dispose]: () =>
      useCurrentSpace.setState({ environmentId: null, view: null, currentSpaceId: null }),
  };
}

it("lists the archived Threads of the Space's Projects only", async () => {
  using _space = showSpace(spaceA);
  await using screen = await render(<ArchivedThreadsPanel />);
  await expect.element(screen.getByText("Acme site")).toBeVisible();
  await expect.element(screen.getByText("Fix login")).toBeVisible();
  expect(screen.getByText("Beta app").elements()).toHaveLength(0);
  expect(screen.getByText("Rewrite billing").elements()).toHaveLength(0);
});

it("lists the other Space's when that is the one open", async () => {
  using _space = showSpace(spaceB);
  await using screen = await render(<ArchivedThreadsPanel />);
  await expect.element(screen.getByText("Rewrite billing")).toBeVisible();
  expect(screen.getByText("Fix login").elements()).toHaveLength(0);
});
