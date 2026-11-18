/**
 * What checkpoints leave out beside what the repository ignores, so no Project can fill the Hub
 * with videos or dependencies again. Only untracked paths: committed files are the repository's
 * own business. A restore leaves every one of them as it is.
 */

/** Untracked files larger than this are left out. GitHub warns from the same size. */
export const CHECKPOINT_MAX_FILE_BYTES = 50 * 1024 * 1024;

/**
 * Untracked folders with these names are left out at any depth, as ignore rules of the lowest
 * precedence: tracked files in them are still captured, and `!dist/` in `.gitignore` brings one
 * back. `build` is not here because it is often source.
 */
export const CHECKPOINT_DEFAULT_EXCLUDED_FOLDERS = [
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".parcel-cache",
  ".gradle",
  "target",
  "dist",
] as const;

/** Entries a checkpoint's report lists; its counts go on. */
export const CHECKPOINT_SKIPPED_LIST_MAX = 50;

/**
 * Commands that cannot read pathspecs from a file take them as arguments, up to this many bytes:
 * below the Windows command-line limit with room for the rest of the command.
 */
export const CHECKPOINT_PATHSPEC_ARGS_MAX_BYTES = 16 * 1024;

const defaultFolderPatterns = (): string =>
  CHECKPOINT_DEFAULT_EXCLUDED_FOLDERS.map((name) => `${name}/\n`).join("");

/**
 * The excludes file checkpoint commands read in place of the user's global one: the default
 * folders first, so the user's own global rules (appended after) can still override them.
 */
export function checkpointExcludesFile(userExcludes: string): string {
  const user =
    userExcludes.length === 0 || userExcludes.endsWith("\n") ? userExcludes : `${userExcludes}\n`;
  return `${defaultFolderPatterns()}${user}`;
}

/** A pathspec that keeps a command away from one repository-relative path. */
export const excludePathspec = (repositoryPath: string): string =>
  `:(top,literal,exclude)${repositoryPath}`;

export const isDefaultExcludedFolder = (entry: string): boolean => {
  if (!entry.endsWith("/")) return false;
  const name = entry.slice(0, -1).split("/").at(-1) ?? "";
  return (CHECKPOINT_DEFAULT_EXCLUDED_FOLDERS as ReadonlyArray<string>).includes(name);
};
