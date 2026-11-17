import type { EnvironmentId, SpaceId } from "@t3tools/contracts";
import type {
  HomeListFilterMenuEnvironment,
  HomeListFilterMenuProject,
  HomeListSpaceChoice,
} from "./home-list-filter-menu";

export type HomeHeaderEnvironment = HomeListFilterMenuEnvironment;

export interface HomeHeaderProps {
  readonly environments: ReadonlyArray<HomeHeaderEnvironment>;
  readonly projects: ReadonlyArray<HomeListFilterMenuProject>;
  readonly searchQuery: string;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly selectedProjectKey: string | null;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
  readonly onProjectChange: (projectKey: string | null) => void;
  /** The Space selector: where new Projects and Threads go on each Hub. */
  readonly spaceChoices?: ReadonlyArray<HomeListSpaceChoice>;
  readonly onSpaceChange?: (environmentId: EnvironmentId, spaceId: SpaceId) => void;
  /** «Create organization» on a Hub whose User may (any User may, ticket 18). */
  readonly onCreateOrganization?: (environmentId: EnvironmentId) => void;
  readonly onOpenEnvironments: () => void;
  readonly onOpenSettings: () => void;
  readonly onStartNewTask: () => void;
}
