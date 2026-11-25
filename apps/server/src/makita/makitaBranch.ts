/**
 * Makita ticket 10: the names a pushing task uses, all built by the Hub from its task row: its
 * branch on GitHub, the refs it keeps in the Hub repository, and the bot's commit identity.
 */

/** A branch name is at most this long: `makita/<n>-<slug>`. */
const MAX_BRANCH = 50;

/** `makita/<number>-<slug of the title>`: ASCII, lowercase, at most 50 characters. */
export const makitaBranchOf = (number: number, title: string) => {
  const prefix = `makita/${number}`;
  const slug = title
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  const room = MAX_BRANCH - prefix.length - 1;
  const cut = slug.slice(0, Math.max(room, 0)).replace(/-+$/u, "");
  return cut.length === 0 ? prefix : `${prefix}-${cut}`;
};

/** Where the Hub keeps a task's base in the Project's Hub repository (every machine reads it). */
export const makitaBaseRef = (taskId: string) => `refs/t3/project/makita/${taskId}/base`;

/**
 * Where the Thread's machine uploads its worktree for a push: under the Thread's own prefix, which
 * only its Active environment may write (`gitRoute.ts`).
 */
export const makitaPushRef = (threadId: string) =>
  `refs/t3/threads/${encodeURIComponent(threadId)}/makita/push`;

/** The bot's commit identity: its login and GitHub's `noreply` address for its id. */
export const makitaAuthorOf = (account: { readonly login: string; readonly id: number }) => ({
  name: account.login,
  email: `${account.id}+${account.login}@users.noreply.github.com`,
});

/** A login, branch or ref safe to write in a shell command unquoted (`sh` and `cmd.exe`). */
const isShellSafe = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._/+@-]*$/u.test(value);

/**
 * The command a new worktree runs once made (`move.prepare`'s setup script): the task's branch at
 * the base, and the bot as the author of its commits, in this worktree's config only.
 */
export const makitaWorktreeSetup = (input: {
  readonly branch: string;
  readonly baseRef: string;
  readonly author: { readonly name: string; readonly email: string };
}) => {
  const parts = [input.branch, input.baseRef, input.author.name, input.author.email];
  if (!parts.every(isShellSafe)) return null;
  return [
    `git checkout --quiet -B ${input.branch} ${input.baseRef}`,
    "git config extensions.worktreeConfig true",
    `git config --worktree user.name ${input.author.name}`,
    `git config --worktree user.email ${input.author.email}`,
  ].join(" && ");
};
