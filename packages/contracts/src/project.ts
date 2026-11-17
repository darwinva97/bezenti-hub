import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { RepositoryIdentity, ThreadEnvMode } from "./environment.ts";
import { AiAccountId, AiAccountProvider } from "./aiAccounts.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ResourceOwner } from "./ownership.ts";
import { VaultGroupId } from "./vaults.ts";
import {
  CommandId,
  EnvironmentId,
  ForwardCompatibleUnion,
  isUnknownUnionMember,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  SpaceId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
  UserId,
  type UnknownUnionMember,
} from "./baseSchemas.ts";

const PROJECT_SEARCH_ENTRIES_MAX_LIMIT = 200;
const PROJECT_SEARCH_CONTENTS_MAX_LIMIT = 500;
const PROJECT_WRITE_FILE_PATH_MAX_LENGTH = 512;
const PROJECT_READ_FILE_PATH_MAX_LENGTH = 512;

export const ProjectScriptIcon = Schema.Literals([
  "play",
  "test",
  "lint",
  "configure",
  "build",
  "debug",
]);
export type ProjectScriptIcon = typeof ProjectScriptIcon.Type;

export const ProjectScript = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  command: TrimmedNonEmptyString,
  icon: ProjectScriptIcon,
  runOnWorktreeCreate: Schema.Boolean,
  runOnSettle: Schema.optional(Schema.Boolean),
  async: Schema.optional(Schema.Boolean),
  previewUrl: Schema.optional(TrimmedNonEmptyString),
  autoOpenPreview: Schema.optional(Schema.Boolean),
});
export type ProjectScript = typeof ProjectScript.Type;

export const ProjectIconColor = Schema.Literals([
  "gray",
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "rose",
]);
export type ProjectIconColor = typeof ProjectIconColor.Type;

const ProjectLucideIconName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
);

const ProjectEmoji = TrimmedNonEmptyString.check(Schema.isMaxLength(32));

// Grapheme-count validation belongs to the server command boundary, not snapshot decoding.
export const ProjectMonogramText = TrimmedNonEmptyString.check(
  Schema.isMaxLength(32),
  Schema.isPattern(/^[\p{L}\p{N}][\p{L}\p{N}\p{M}\u200c\u200d]*$/u),
);

const ProjectLucideIcon = Schema.Struct({
  kind: Schema.Literal("lucide"),
  name: ProjectLucideIconName,
  color: ProjectIconColor,
});
const ProjectEmojiIcon = Schema.Struct({
  kind: Schema.Literal("emoji"),
  emoji: ProjectEmoji,
});
const ProjectMonogramIcon = Schema.Struct({
  kind: Schema.Literal("monogram"),
  text: ProjectMonogramText,
  color: ProjectIconColor,
});
export const ProjectFaviconPath = TrimmedNonEmptyString.check(
  Schema.isMaxLength(1024),
  Schema.isPattern(/\.(?:avif|gif|icns|ico|jpe?g|png|svg|webp)$/i),
);
export type ProjectFaviconPath = typeof ProjectFaviconPath.Type;

export const ProjectIconOverride = Schema.Union([
  ProjectLucideIcon,
  ProjectEmojiIcon,
  ProjectMonogramIcon,
]);
export type ProjectIconOverride = typeof ProjectIconOverride.Type;

const ProjectLucideIconWithLegacyMonogram = Schema.Struct({
  ...ProjectLucideIcon.fields,
  monogramText: Schema.optional(ProjectMonogramText),
  monogram: Schema.optional(ProjectMonogramText),
});
const projectIconMembers = [
  ProjectLucideIconWithLegacyMonogram,
  ProjectEmojiIcon,
  ProjectMonogramIcon,
] as const;
type ProjectIconMember = (typeof projectIconMembers)[number]["Type"];

const fromLegacyMonogram = (icon: ProjectIconMember): ProjectIconOverride => {
  if (icon.kind !== "lucide") return icon;
  const text = icon.monogramText ?? icon.monogram;
  return text === undefined
    ? { kind: "lucide", name: icon.name, color: icon.color }
    : { kind: "monogram", text, color: icon.color };
};

export const StoredProjectIcon = Schema.Union(projectIconMembers).pipe(
  Schema.decodeTo(
    Schema.toType(ProjectIconOverride),
    SchemaTransformation.transform<ProjectIconOverride, ProjectIconMember>({
      decode: fromLegacyMonogram,
      encode: (icon) => icon,
    }),
  ),
);

export const ReceivedProjectIcon = ForwardCompatibleUnion(projectIconMembers, "kind").pipe(
  Schema.decodeTo(
    Schema.NullOr(Schema.toType(ProjectIconOverride)),
    SchemaTransformation.transform<
      ProjectIconOverride | null,
      ProjectIconMember | UnknownUnionMember<"kind">
    >({
      decode: (icon) => (isUnknownUnionMember(icon) ? null : fromLegacyMonogram(icon)),
      encode: (icon) => icon as ProjectIconMember,
    }),
  ),
);

export const Project = Schema.Struct({
  id: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  faviconPath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  projectIcon: Schema.optional(Schema.NullOr(ReceivedProjectIcon)),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  defaultThreadEnvMode: Schema.optional(Schema.NullOr(ThreadEnvMode)),
  // Opt-in because background sync performs network I/O and may move the checkout.
  autoPull: Schema.optional(Schema.Boolean),
  scripts: Schema.Array(ProjectScript),
  pinnedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  archivedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  /** Null for Projects from before Spaces, which belong to the Owner's Personal space. */
  spaceId: Schema.optional(Schema.NullOr(SpaceId)),
  ownerUserId: Schema.optional(Schema.NullOr(UserId)),
  /** Where its new Threads start when nobody chooses; null or absent for the Hub machine. */
  preferredEnvironmentId: Schema.optional(Schema.NullOr(EnvironmentId)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type Project = typeof Project.Type;

export const ProjectSnapshot = Schema.Struct({
  projects: Schema.Array(Project),
  updatedAt: IsoDateTime,
});
export type ProjectSnapshot = typeof ProjectSnapshot.Type;

export const ProjectCreatePayload = Schema.Struct({
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  createWorkspaceRootIfMissing: Schema.optional(Schema.Boolean),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  scripts: Schema.optional(Schema.Array(ProjectScript)),
});
export type ProjectCreatePayload = typeof ProjectCreatePayload.Type;

export const ProjectUpdatePayload = Schema.Struct({
  title: Schema.optional(TrimmedNonEmptyString),
  workspaceRoot: Schema.optional(TrimmedNonEmptyString),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  autoPull: Schema.optional(Schema.Boolean),
  projectIcon: Schema.optional(Schema.NullOr(ProjectIconOverride)),
  faviconPath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  defaultThreadEnvMode: Schema.optional(Schema.NullOr(ThreadEnvMode)),
  scripts: Schema.optional(Schema.Array(ProjectScript)),
  /** Only an Environment the caller may use; null for the Hub machine. */
  preferredEnvironmentId: Schema.optional(Schema.NullOr(EnvironmentId)),
  pinned: Schema.optional(Schema.Boolean),
  archived: Schema.optional(
    Schema.Boolean.annotate({
      description: "Threads and files are kept.",
    }),
  ),
});
export type ProjectUpdatePayload = typeof ProjectUpdatePayload.Type;

export const ProjectMutation = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("project.create"),
    commandId: CommandId,
    projectId: ProjectId,
    ...ProjectCreatePayload.fields,
    /** The client's current Space; the server checks it and stamps the creator. */
    spaceId: Schema.optional(SpaceId),
  }),
  Schema.Struct({
    type: Schema.Literal("project.update"),
    commandId: CommandId,
    projectId: ProjectId,
    ...ProjectUpdatePayload.fields,
  }),
  Schema.Struct({
    type: Schema.Literal("project.delete"),
    commandId: CommandId,
    projectId: ProjectId,
    force: Schema.optional(Schema.Boolean),
  }),
  /**
   * Moves the Project and all its Threads to another Space; in the destination it uses that
   * Space's vaults and AI accounts. A running Thread refuses it unless `stopThreads` (the mover saw
   * them in `ProjectMovePlan`), which stops them first. A Thread whose machine does not serve the
   * destination needs an environment afterwards.
   */
  Schema.Struct({
    type: Schema.Literal("project.move"),
    commandId: CommandId,
    projectId: ProjectId,
    spaceId: SpaceId,
    stopThreads: Schema.optional(Schema.Boolean),
  }),
]);
export type ProjectMutation = typeof ProjectMutation.Type;

/** A move as `project.move` asks it, for the endpoint that answers what it released. */
export const ProjectMoveInput = Schema.Struct({
  commandId: CommandId,
  projectId: ProjectId,
  spaceId: SpaceId,
  stopThreads: Schema.optional(Schema.Boolean),
});
export type ProjectMoveInput = typeof ProjectMoveInput.Type;

/** Which Project, and where it would go: asked before confirming a move. */
export const ProjectMovePlanInput = Schema.Struct({
  projectId: ProjectId,
  spaceId: SpaceId,
});
export type ProjectMovePlanInput = typeof ProjectMovePlanInput.Type;

export const ProjectMovePlanThread = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  /** Its Active environment now; null when it already needs one. */
  environmentId: Schema.NullOr(EnvironmentId),
});
export type ProjectMovePlanThread = typeof ProjectMovePlanThread.Type;

/** A Vault the Project's Threads stop receiving when it moves (spec 5 ticket 07). */
export const ProjectMovePlanVault = Schema.Struct({
  vaultId: VaultGroupId,
  name: Schema.String,
  /** Whose Vault the group is part of (owned-resources 10); missing from an older Hub. */
  owner: Schema.optionalKey(ResourceOwner),
  ownerName: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type ProjectMovePlanVault = typeof ProjectMovePlanVault.Type;

/**
 * An AI account the Project's Threads chose that their owners may not use in the destination
 * (spec 4 ticket 11): the move switches them to the destination's first allowed account, or to
 * none. `name` only for an account its viewers see in the Space it leaves (allowed to it, or its
 * owner's); otherwise null, and clients say «<Provider> account».
 */
export const ProjectMovePlanAiAccount = Schema.Struct({
  aiAccountId: AiAccountId,
  provider: AiAccountProvider,
  name: Schema.NullOr(Schema.String),
  /** How many of its Threads use it. */
  threads: Schema.Number,
});
export type ProjectMovePlanAiAccount = typeof ProjectMovePlanAiAccount.Type;

/** What moving the Project to `spaceId` does to its Threads. */
export const ProjectMovePlan = Schema.Struct({
  projectId: ProjectId,
  spaceId: SpaceId,
  /** Running now: the move stops them. */
  running: Schema.Array(ProjectMovePlanThread),
  /** On a machine that does not serve `spaceId`: they need an environment after the move. */
  needsEnvironment: Schema.Array(ProjectMovePlanThread),
  /**
   * The Vaults its Threads receive from the Space they leave and would not from `spaceId`'s
   * (defaults and the Project's own choices; a User's own Vaults follow the User). Missing from
   * a Hub before Vaults: none.
   */
  vaultsLost: Schema.Array(ProjectMovePlanVault).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
  /** The AI accounts its Threads lose (spec 4 ticket 11). Missing from an older Hub: none. */
  aiAccountsLost: Schema.Array(ProjectMovePlanAiAccount).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
});
export type ProjectMovePlan = typeof ProjectMovePlan.Type;

/** The Project once moved, and the Threads the move released (they need an environment now). */
export const ProjectMoveResult = Schema.Struct({
  project: Project,
  released: Schema.Array(ProjectMovePlanThread),
});
export type ProjectMoveResult = typeof ProjectMoveResult.Type;

export class ProjectMutationError extends Schema.TaggedError<ProjectMutationError>()(
  "ProjectMutationError",
  {
    commandId: CommandId,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const ProjectEntryKind = Schema.Literals(["file", "directory"]);
export type ProjectEntryKind = typeof ProjectEntryKind.Type;

/**
 * The Thread a workspace call is for. The Hub runs it on that Thread's Active environment, inside
 * the Thread's workspace there; without one it runs on the Hub machine.
 */
const WorkspaceThreadScope = { threadId: Schema.optional(ThreadId) };

export const ProjectSearchEntriesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  query: TrimmedString.check(Schema.isMaxLength(256)),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_SEARCH_ENTRIES_MAX_LIMIT)),
  kind: Schema.optional(ProjectEntryKind),
  imageOnly: Schema.optional(Schema.Boolean),
  ...WorkspaceThreadScope,
});
export type ProjectSearchEntriesInput = typeof ProjectSearchEntriesInput.Type;

export const ProjectEntry = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: ProjectEntryKind,
  ignored: Schema.optional(Schema.Boolean),
});
export type ProjectEntry = typeof ProjectEntry.Type;

export const ProjectSearchEntriesResult = Schema.Struct({
  entries: Schema.Array(ProjectEntry),
  truncated: Schema.Boolean,
});
export type ProjectSearchEntriesResult = typeof ProjectSearchEntriesResult.Type;

export const ProjectSearchContentsInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  // Preserve whitespace because it is significant in content queries.
  query: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_SEARCH_CONTENTS_MAX_LIMIT)),
  caseSensitive: Schema.Boolean,
  wholeWord: Schema.Boolean,
  useRegex: Schema.Boolean,
  ...WorkspaceThreadScope,
});
export type ProjectSearchContentsInput = typeof ProjectSearchContentsInput.Type;

export const ProjectContentMatchRange = Schema.Struct({
  start: NonNegativeInt,
  end: NonNegativeInt,
});
export type ProjectContentMatchRange = typeof ProjectContentMatchRange.Type;

export const ProjectContentMatch = Schema.Struct({
  path: TrimmedNonEmptyString,
  lineNumber: PositiveInt,
  lineContent: Schema.String,
  matchRanges: Schema.Array(ProjectContentMatchRange),
});
export type ProjectContentMatch = typeof ProjectContentMatch.Type;

export const ProjectSearchContentsResult = Schema.Struct({
  matches: Schema.Array(ProjectContentMatch),
  truncated: Schema.Boolean,
  regexFallbackError: Schema.optional(Schema.String),
});
export type ProjectSearchContentsResult = typeof ProjectSearchContentsResult.Type;

export const ProjectListEntriesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  directoryPath: Schema.optional(TrimmedString),
  ...WorkspaceThreadScope,
});
export type ProjectListEntriesInput = typeof ProjectListEntriesInput.Type;

export const ProjectListEntriesResult = Schema.Struct({
  entries: Schema.Array(ProjectEntry),
  truncated: Schema.Boolean,
});
export type ProjectListEntriesResult = typeof ProjectListEntriesResult.Type;

// Untracked files git ignores. Wholly ignored folders such as `node_modules`
// are left out, so the list stays small enough to pick from.
export const ProjectListIgnoredFilesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  ...WorkspaceThreadScope,
});
export type ProjectListIgnoredFilesInput = typeof ProjectListIgnoredFilesInput.Type;

export const ProjectIgnoredFile = Schema.Struct({
  path: TrimmedNonEmptyString,
  byteLength: NonNegativeInt,
});
export type ProjectIgnoredFile = typeof ProjectIgnoredFile.Type;

export const ProjectListIgnoredFilesResult = Schema.Struct({
  files: Schema.Array(ProjectIgnoredFile),
  truncated: Schema.Boolean,
});
export type ProjectListIgnoredFilesResult = typeof ProjectListIgnoredFilesResult.Type;

export const ProjectEntriesFailure = Schema.Literals([
  "workspace_root_not_found",
  "workspace_root_create_failed",
  "workspace_root_stat_failed",
  "workspace_root_not_directory",
  "search_index_create_failed",
  "search_index_scan_timed_out",
  "search_index_search_failed",
  "directory_list_failed",
  // The Thread's Active environment is not connected.
  "environment_offline",
  // The call named a Thread and a folder outside that Thread's workspace.
  "outside_thread_workspace",
]);
export type ProjectEntriesFailure = typeof ProjectEntriesFailure.Type;

type ProjectEntriesFailureContext = {
  readonly failure: ProjectEntriesFailure;
  readonly normalizedCwd?: string;
  readonly timeout?: string;
  readonly detail?: string;
  readonly message?: string;
  readonly cause?: unknown;
};

function decodedProjectErrorMessage(props: object): string | undefined {
  if (!("message" in props)) return undefined;
  return typeof props.message === "string" ? props.message : undefined;
}

export class ProjectSearchEntriesError extends Schema.TaggedError<ProjectSearchEntriesError>()(
  "ProjectSearchEntriesError",
  {
    cwd: Schema.optional(TrimmedNonEmptyString),
    queryLength: Schema.optional(NonNegativeInt),
    limit: Schema.optional(PositiveInt),
    failure: Schema.optional(ProjectEntriesFailure),
    normalizedCwd: Schema.optional(TrimmedNonEmptyString),
    timeout: Schema.optional(TrimmedNonEmptyString),
    detail: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(
    props: ProjectEntriesFailureContext & {
      readonly cwd: string;
      readonly queryLength: number;
      readonly limit: number;
    },
  ) {
    super({
      ...props,
      message:
        decodedProjectErrorMessage(props) ??
        `Failed to search workspace entries in '${props.cwd}'.`,
    } as any);
  }
}

export class ProjectSearchContentsError extends Schema.TaggedError<ProjectSearchContentsError>()(
  "ProjectSearchContentsError",
  {
    cwd: Schema.optional(TrimmedNonEmptyString),
    queryLength: Schema.optional(NonNegativeInt),
    limit: Schema.optional(PositiveInt),
    failure: Schema.optional(ProjectEntriesFailure),
    normalizedCwd: Schema.optional(TrimmedNonEmptyString),
    timeout: Schema.optional(TrimmedNonEmptyString),
    detail: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(
    props: ProjectEntriesFailureContext & {
      readonly cwd: string;
      readonly queryLength: number;
      readonly limit: number;
    },
  ) {
    super({
      ...props,
      message:
        decodedProjectErrorMessage(props) ??
        `Failed to search workspace contents in '${props.cwd}'.`,
    } as any);
  }
}

export class ProjectListEntriesError extends Schema.TaggedError<ProjectListEntriesError>()(
  "ProjectListEntriesError",
  {
    cwd: Schema.optional(TrimmedNonEmptyString),
    failure: Schema.optional(ProjectEntriesFailure),
    normalizedCwd: Schema.optional(TrimmedNonEmptyString),
    timeout: Schema.optional(TrimmedNonEmptyString),
    detail: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: ProjectEntriesFailureContext & { readonly cwd: string }) {
    super({
      ...props,
      message:
        decodedProjectErrorMessage(props) ?? `Failed to list workspace entries in '${props.cwd}'.`,
    } as any);
  }
}

export const ProjectReadFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  // Workspace-relative or absolute host path; only workspace-relative paths are writable.
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_READ_FILE_PATH_MAX_LENGTH)),
  // Optional files can be absent without failing the read.
  allowMissing: Schema.optional(Schema.Boolean),
  // Spec 5: a copy to another machine reads the file as it is, unmasked; only a caller who may
  // write files can ask for one.
  forCopy: Schema.optional(Schema.Boolean),
  ...WorkspaceThreadScope,
});
export type ProjectReadFileInput = typeof ProjectReadFileInput.Type;

export const ProjectReadFileResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
  contents: Schema.String,
  byteLength: NonNegativeInt,
  truncated: Schema.Boolean,
  // Omitted by older servers; false only for an absent optional file.
  exists: Schema.optional(Schema.Boolean),
  // Spec 5: true when a secret value shows as `[NAME]`. The editor opens it read-only (a save
  // over it is refused): saving what was shown would write `[NAME]` over the value.
  masked: Schema.optional(Schema.Boolean),
});
export type ProjectReadFileResult = typeof ProjectReadFileResult.Type;

export const ProjectFileFailure = Schema.Literals([
  "workspace_path_outside_root",
  "resolved_path_outside_root",
  "path_not_file",
  "binary_file",
  "operation_failed",
  // The Thread's Active environment is not connected; nothing was read or written.
  "environment_offline",
  // The Hub machine runs no agents (`T3CODE_HUB_RUNS_AGENTS` off): it writes nothing for a Thread.
  "hub_runs_no_agents",
]);
export type ProjectFileFailure = typeof ProjectFileFailure.Type;

export const ProjectFileOperation = Schema.Literals([
  "realpath-workspace-root",
  "realpath-target",
  "open",
  "stat",
  "read",
  "close",
  "make-directory",
  "write-file",
]);
export type ProjectFileOperation = typeof ProjectFileOperation.Type;

type ProjectFileFailureContext = {
  readonly cwd: string;
  readonly relativePath: string;
  readonly failure: ProjectFileFailure;
  readonly resolvedPath?: string;
  readonly resolvedWorkspaceRoot?: string;
  readonly operation?: ProjectFileOperation;
  readonly operationPath?: string;
  readonly message?: string;
  readonly cause?: unknown;
};

export class ProjectReadFileError extends Schema.TaggedError<ProjectReadFileError>()(
  "ProjectReadFileError",
  {
    cwd: Schema.optional(TrimmedNonEmptyString),
    relativePath: Schema.optional(TrimmedNonEmptyString),
    failure: Schema.optional(ProjectFileFailure),
    resolvedPath: Schema.optional(TrimmedNonEmptyString),
    resolvedWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
    operation: Schema.optional(ProjectFileOperation),
    operationPath: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: ProjectFileFailureContext) {
    super({
      ...props,
      message:
        decodedProjectErrorMessage(props) ??
        `Failed to read workspace file '${props.relativePath}' in '${props.cwd}'.`,
    } as any);
  }
}

export const ProjectWriteFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_WRITE_FILE_PATH_MAX_LENGTH)),
  contents: Schema.String,
  ...WorkspaceThreadScope,
});
export type ProjectWriteFileInput = typeof ProjectWriteFileInput.Type;

export const ProjectWriteFileResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
});
export type ProjectWriteFileResult = typeof ProjectWriteFileResult.Type;

export const ProjectEnsureScratchResult = Schema.Struct({
  projectId: ProjectId,
});
export type ProjectEnsureScratchResult = typeof ProjectEnsureScratchResult.Type;

export const ProjectCreateNewInput = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
});
export type ProjectCreateNewInput = typeof ProjectCreateNewInput.Type;

export const ProjectCreateNewResult = Schema.Struct({
  projectId: ProjectId,
  workspaceRoot: TrimmedNonEmptyString,
  /** The project and its files exist either way. */
  commitError: Schema.optionalKey(TrimmedNonEmptyString),
});
export type ProjectCreateNewResult = typeof ProjectCreateNewResult.Type;

export const ProjectCreateFromThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type ProjectCreateFromThreadInput = typeof ProjectCreateFromThreadInput.Type;

export const ProjectCreateFromThreadResult = Schema.Struct({
  projectId: ProjectId,
});
export type ProjectCreateFromThreadResult = typeof ProjectCreateFromThreadResult.Type;

export class ProjectWriteFileError extends Schema.TaggedError<ProjectWriteFileError>()(
  "ProjectWriteFileError",
  {
    cwd: Schema.optional(TrimmedNonEmptyString),
    relativePath: Schema.optional(TrimmedNonEmptyString),
    failure: Schema.optional(ProjectFileFailure),
    resolvedPath: Schema.optional(TrimmedNonEmptyString),
    resolvedWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
    operation: Schema.optional(ProjectFileOperation),
    operationPath: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: ProjectFileFailureContext) {
    super({
      ...props,
      message:
        decodedProjectErrorMessage(props) ??
        `Failed to write workspace file '${props.relativePath}' in '${props.cwd}'.`,
    } as any);
  }
}
