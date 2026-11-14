import {
  EnvironmentId,
  SpaceId,
  ThreadId,
  UserId,
  type SpaceDirectoryView,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import { useCurrentSpace } from "../state/currentSpace";
import { useProjects, useQuietThreadShells } from "../state/entities";
import { useSidebarSpaceFilter } from "./useSidebarSpaceFilter";

vi.mock("../state/entities", { spy: true });

const hub = EnvironmentId.make("hub");
const personal = SpaceId.make("personal:grace");
const acme = SpaceId.make("org-acme");

const view = {
  userId: UserId.make("grace"),
  personalSpaceId: personal,
  canCreateOrganization: false,
  spaces: [
    { id: personal, kind: "personal", name: "Personal", role: null, isOwn: true },
    { id: acme, kind: "organization", name: "Acme", role: "member", isOwn: false },
  ],
} as unknown as SpaceDirectoryView;

const project = (id: string, spaceId?: SpaceId) =>
  ({ environmentId: hub, id, ...(spaceId === undefined ? {} : { spaceId }) }) as never;
const thread = (
  id: string,
  projectId: string,
  options: { spaceId?: SpaceId; parentThreadId?: string } = {},
) =>
  ({
    environmentId: hub,
    id: ThreadId.make(id),
    projectId,
    ...(options.spaceId === undefined ? {} : { spaceId: options.spaceId }),
    lineage: {
      parentThreadId: options.parentThreadId ?? null,
      relationshipToParent: options.parentThreadId === undefined ? null : "subagent",
      rootThreadId: ThreadId.make(options.parentThreadId ?? id),
    },
  }) as never;

const projects = [project("p-acme", acme), project("p-personal", personal)];
const threads = [
  thread("t-acme", "p-acme"),
  thread("t-sub", "p-acme", { parentThreadId: "t-acme" }),
  thread("t-personal", "p-personal"),
  thread("t-own", "p-personal", { spaceId: acme }),
];

async function listed(input: {
  readonly currentSpaceId: SpaceId | null;
  readonly showAllSpaces?: boolean;
  readonly open?: string;
}) {
  const previous = useCurrentSpace.getState();
  useCurrentSpace.setState({
    environmentId: hub,
    view,
    currentSpaceId: input.currentSpaceId,
    loadFailed: false,
    showAllSpaces: input.showAllSpaces ?? false,
  });
  vi.mocked(useProjects).mockReturnValue(projects);
  vi.mocked(useQuietThreadShells).mockReturnValue(threads);
  function Probe() {
    const filtered = useSidebarSpaceFilter({
      openThreadEnvironmentId: input.open === undefined ? null : hub,
      openThreadId: input.open === undefined ? null : ThreadId.make(input.open),
      openDraftEnvironmentId: null,
      openDraftProjectId: null,
    });
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
  it("lists the current Space's Threads, by own Space first and else the Project's", async () => {
    expect(await listed({ currentSpaceId: acme })).toBe("t-acme,t-sub,t-own|p-acme,p-personal");
    expect(await listed({ currentSpaceId: personal })).toBe("t-personal|p-personal");
  });

  it("keeps the open Thread, and the row of an open subagent, from another Space", async () => {
    expect(await listed({ currentSpaceId: personal, open: "t-acme" })).toBe(
      "t-acme,t-personal|p-acme,p-personal",
    );
    expect(await listed({ currentSpaceId: personal, open: "t-sub" })).toBe(
      "t-acme,t-sub,t-personal|p-acme,p-personal",
    );
  });

  it("filters nothing without a current Space or with All Spaces", async () => {
    const everything = "t-acme,t-sub,t-personal,t-own|p-acme,p-personal";
    expect(await listed({ currentSpaceId: null })).toBe(everything);
    expect(await listed({ currentSpaceId: acme, showAllSpaces: true })).toBe(everything);
  });
});
