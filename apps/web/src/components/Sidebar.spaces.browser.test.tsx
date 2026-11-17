import {
  EnvironmentId,
  ProjectId,
  SpaceId,
  UserId,
  type SpaceDirectoryView,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { useCurrentSpace } from "../state/currentSpace";
import { useProjects } from "../state/entities";
import type { Project } from "../types";
import Sidebar from "./Sidebar";
import { SidebarProvider } from "./ui/sidebar";

vi.mock("../state/entities", { spy: true });
vi.mock("../commandPaletteBus", () => ({
  openCommandPalette: vi.fn(),
  isCommandPaletteOpen: () => false,
}));
vi.mock("./sidebar/SidebarChrome", () => ({
  SidebarChromeHeader: () => null,
  SidebarChromeFooter: () => null,
}));

const hub = EnvironmentId.make("hub");
const userId = UserId.make("grace");
const personal = SpaceId.make("personal:grace");
const acme = SpaceId.make("org-acme");

const view: SpaceDirectoryView = {
  userId,
  personalSpaceId: personal,
  canCreateOrganization: false,
  spaces: [
    {
      id: personal,
      kind: "personal",
      name: "Personal",
      role: null,
      isOwn: true,
      canCreateThreads: true,
      canInvite: false,
    },
    {
      id: acme,
      kind: "organization",
      name: "Acme",
      role: "member",
      isOwn: false,
      canCreateThreads: true,
      canInvite: false,
    },
  ],
};

function project(id: string, spaceId?: SpaceId): Project {
  return {
    id: ProjectId.make(id),
    environmentId: hub,
    title: id,
    workspaceRoot: `/projects/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
    ...(spaceId === undefined ? {} : { spaceId }),
  };
}

const projects = [project("acme-site", acme), project("diary", personal)];

async function renderSidebar(input: { readonly view: SpaceDirectoryView | null }) {
  const previous = useCurrentSpace.getState();
  useCurrentSpace.setState({
    environmentId: hub,
    view: input.view,
    currentSpaceId: input.view === null ? null : acme,
    loadFailed: false,
  });
  vi.mocked(useProjects).mockReturnValue(projects);
  const screen = await render(
    <SidebarProvider>
      <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
    </SidebarProvider>,
  );
  return {
    screen,
    [Symbol.asyncDispose]: async () => {
      await screen[Symbol.asyncDispose]();
      useCurrentSpace.setState(previous);
    },
  };
}

async function listedProjects(screen: Awaited<ReturnType<typeof render>>) {
  await userEvent.click(screen.getByRole("combobox", { name: "Filter threads by project" }));
  const listed = {
    acme: screen.getByRole("option", { name: "acme-site" }).query() !== null,
    personal: screen.getByRole("option", { name: "diary" }).query() !== null,
  };
  await userEvent.keyboard("{Escape}");
  return listed;
}

describe("sidebar Space filter", () => {
  it("lists only the current Space's projects, with no way to list every Space", async () => {
    await using sidebar = await renderSidebar({ view });
    const { screen } = sidebar;

    expect(await listedProjects(screen)).toEqual({ acme: true, personal: false });
    expect(screen.getByRole("button", { name: "All Spaces" }).query()).toBeNull();
  });

  it("does not filter without Spaces", async () => {
    await using sidebar = await renderSidebar({ view: null });
    const { screen } = sidebar;

    expect(await listedProjects(screen)).toEqual({ acme: true, personal: true });
    expect(screen.getByRole("button", { name: "All Spaces" }).query()).toBeNull();
  });
});
