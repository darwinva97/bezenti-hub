import { EnvironmentId, ProjectId, SpaceId, UserId, type SpaceDirectoryView } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import { useCurrentSpace } from "../state/currentSpace";
import { readProject, useAllEnvironmentShellsBootstrapped, useProjects, useVisibleThreadShells } from "../state/entities";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { IndexDraftLanding } from "./_chat.index";

vi.mock("../state/entities", { spy: true });
vi.mock("../hooks/useHandleNewThread", { spy: true });
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useRouter: () => ({ state: { location: { pathname: "/" } } }),
}));

const hub = EnvironmentId.make("hub");
const personal = SpaceId.make("personal:eijun");
const acme = SpaceId.make("org-acme");
const view = {
  userId: UserId.make("eijun"),
  personalSpaceId: personal,
  canCreateOrganization: false,
  isOwner: false,
  spaces: [
    { id: personal, kind: "personal", name: "Personal", role: null, isOwn: true },
    { id: acme, kind: "organization", name: "Acme", role: "member", isOwn: false },
  ],
} as unknown as SpaceDirectoryView;

const project = (id: string, spaceId: SpaceId) =>
  ({ environmentId: hub, id: ProjectId.make(id), spaceId, archivedAt: null }) as never;

async function startedIn(currentSpaceId: SpaceId | null, loaded = true) {
  useCurrentSpace.setState({
    environmentId: loaded ? hub : null,
    view: loaded ? view : null,
    currentSpaceId,
    loadFailed: false,
  });
  const start = vi.fn().mockResolvedValue({});
  vi.mocked(useProjects).mockReturnValue([project("p-acme", acme), project("p-personal", personal)]);
  vi.mocked(useVisibleThreadShells).mockReturnValue([]);
  vi.mocked(useAllEnvironmentShellsBootstrapped).mockReturnValue(true);
  vi.mocked(readProject).mockReturnValue({} as never);
  vi.mocked(useNewThreadHandler).mockReturnValue(start as never);
  await using _screen = await render(<IndexDraftLanding />);
  await new Promise((resolve) => setTimeout(resolve, 50));
  return start.mock.calls.map((call) => call[0].projectId);
}

describe("IndexDraftLanding", () => {
  it("starts the draft in a Project of the current Space", async () => {
    expect(await startedIn(personal)).toEqual(["p-personal"]);
  });

  it("starts nothing before the Spaces have loaded", async () => {
    expect(await startedIn(null, false)).toEqual([]);
  });
});
