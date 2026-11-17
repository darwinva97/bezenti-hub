import {
  EnvironmentId,
  SpaceId,
  ThreadId,
  UserId,
  type SpaceDirectoryView,
} from "@t3tools/contracts";
import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import { useCurrentSpace } from "../state/currentSpace";
import { useProjects, useQuietThreadShells } from "../state/entities";
import { useSidebarSpaceFilter } from "./useSidebarSpaceFilter";

vi.mock("../state/entities", { spy: true });

const hub = EnvironmentId.make("hub");
const personal = SpaceId.make("personal:grace");
const acme = SpaceId.make("org-acme");

const viewOf = (isOwner: boolean) =>
  ({
    userId: UserId.make("grace"),
    personalSpaceId: personal,
    canCreateOrganization: true,
    isOwner,
    spaces: [
      { id: personal, kind: "personal", name: "Personal", role: null, isOwn: true },
      { id: acme, kind: "organization", name: "Acme", role: "member", isOwn: false },
    ],
  }) as unknown as SpaceDirectoryView;

const project = (id: string, spaceId?: SpaceId) =>
  ({ environmentId: hub, id, ...(spaceId === undefined ? {} : { spaceId }) }) as never;
const thread = (id: string, projectId: string, spaceId?: SpaceId) =>
  ({
    environmentId: hub,
    id: ThreadId.make(id),
    projectId,
    ...(spaceId === undefined ? {} : { spaceId }),
  }) as never;

// `p-old` and its Thread are from before Spaces: the Owner's Personal space.
const projects = [project("p-acme", acme), project("p-personal", personal), project("p-old")];
const threads = [
  thread("t-acme", "p-acme"),
  thread("t-personal", "p-personal"),
  thread("t-own", "p-personal", acme),
  thread("t-old", "p-old"),
];

async function listed(input: {
  readonly currentSpaceId: SpaceId | null;
  readonly isOwner?: boolean;
}) {
  const previous = useCurrentSpace.getState();
  useCurrentSpace.setState({
    environmentId: hub,
    view: viewOf(input.isOwner ?? false),
    currentSpaceId: input.currentSpaceId,
    loadFailed: false,
  });
  vi.mocked(useProjects).mockReturnValue(projects);
  vi.mocked(useQuietThreadShells).mockReturnValue(threads);
  function Probe() {
    const filtered = useSidebarSpaceFilter();
    return (
      <div data-testid="listed">
        {filtered.threads.map((candidate) => candidate.id).join(",")}|
        {filtered.projects.map((candidate) => candidate.id).join(",")}
      </div>
    );
  }
  await using screen = await render(<Probe />);
  const text = screen.getByTestId("listed").element().textContent;
  useCurrentSpace.setState(previous);
  return text;
}

describe("useSidebarSpaceFilter", () => {
  it("lists only the current Space's Projects and Threads", async () => {
    expect(await listed({ currentSpaceId: acme })).toBe("t-acme,t-own|p-acme");
    expect(await listed({ currentSpaceId: personal })).toBe("t-personal|p-personal");
  });

  it("lists rows from before Spaces in the Owner's Personal space only", async () => {
    expect(await listed({ currentSpaceId: personal, isOwner: true })).toBe(
      "t-personal,t-old|p-personal,p-old",
    );
    expect(await listed({ currentSpaceId: acme, isOwner: true })).toBe("t-acme,t-own|p-acme");
  });

  it("keeps the Projects array when only Threads change", async () => {
    const seen: unknown[] = [];
    useCurrentSpace.setState({
      environmentId: hub,
      view: viewOf(false),
      currentSpaceId: personal,
      loadFailed: false,
    });
    vi.mocked(useProjects).mockReturnValue(projects);
    vi.mocked(useQuietThreadShells).mockReturnValue(threads);
    function Probe() {
      const [tick, setTick] = useState(0);
      const filtered = useSidebarSpaceFilter();
      seen.push(filtered.projects);
      return (
        <button type="button" onClick={() => setTick(tick + 1)}>
          more
        </button>
      );
    }
    await using screen = await render(<Probe />);
    vi.mocked(useQuietThreadShells).mockReturnValue([...threads, thread("t-new", "p-personal")]);
    await screen.getByRole("button", { name: "more" }).click();
    expect(seen.length).toBeGreaterThan(1);
    expect(new Set(seen).size).toBe(1);
  });

  it("filters nothing without a current Space", async () => {
    expect(await listed({ currentSpaceId: null })).toBe(
      "t-acme,t-personal,t-own,t-old|p-acme,p-personal,p-old",
    );
  });
});
