/**
 * Which sections of the settings modals a principal sees. Web and mobile read the same rules;
 * the server still decides what each action is allowed to do.
 */
export type SettingsModalId = "user" | "space" | "project" | "platform";

/** Who is looking at Settings. */
export interface SettingsPrincipal {
  /** The session acts for the whole Installation: the Owner's. */
  readonly isOwner: boolean;
  readonly isDesktop: boolean;
  /** The session belongs to a User with an account; a pairing-link session has none. */
  readonly hasUser: boolean;
}

/** The Space a Space settings modal is about, as the viewer's directory lists it. */
export interface SpaceSettingsSubject {
  readonly kind: "organization" | "personal";
  /** The viewer's own Personal space. The Owner also reads other Users' Personal spaces. */
  readonly isOwn: boolean;
  /** The viewer may invite people here and see its Invitations. */
  readonly canInvite: boolean;
}

/** The Space sections that exist only in an Organization. */
const ORGANIZATION_ONLY_SPACE_SECTIONS: ReadonlySet<string> = new Set(["members", "invitations"]);

/** The Space sections that belong to a User's own Space, not to one the Owner only reads. */
const OWN_SPACE_ONLY_SECTIONS: ReadonlySet<string> = new Set([
  "scheduled-tasks",
  "makita",
  "archive",
]);

function isSpaceSectionAllowed(sectionId: string, space: SpaceSettingsSubject | null): boolean {
  if (space === null) return false;
  if (space.kind === "organization") {
    return sectionId === "invitations" ? space.canInvite : true;
  }
  if (ORGANIZATION_ONLY_SPACE_SECTIONS.has(sectionId)) return false;
  return space.isOwn || !OWN_SPACE_ONLY_SECTIONS.has(sectionId);
}

/**
 * Whether the principal sees a section of a modal. It does not know whether the section is built:
 * a reserved section is never shown, and the registry decides that.
 */
export function isSettingsSectionAllowed(
  modal: SettingsModalId,
  sectionId: string,
  principal: SettingsPrincipal,
  space: SpaceSettingsSubject | null = null,
): boolean {
  switch (modal) {
    case "user":
      if (sectionId === "account") return principal.hasUser;
      if (sectionId === "snap-shot") return principal.isDesktop;
      // What a User owns (their Vault, AI accounts and machines) is theirs: it needs a User.
      if (sectionId === "vault" || sectionId === "ai-accounts" || sectionId === "machines") {
        return principal.hasUser;
      }
      return true;
    case "space":
      return isSpaceSectionAllowed(sectionId, space);
    case "project":
      return true;
    case "platform":
      return principal.isOwner;
  }
}

/** The sections of a machine's page, in order: the URL segments of `.../<machine>/<section>`. */
export const MACHINE_SECTION_IDS = [
  "providers",
  "source-control",
  "devices",
  "maintenance",
  "network",
] as const;

export type MachineSectionId = (typeof MACHINE_SECTION_IDS)[number];

/**
 * Whether the principal sees a section of a machine's page. Whoever acts for the Installation
 * (the Owner) edits it; the others do not see it. Network is how the desktop app's own backend is
 * reached, so only that machine has it.
 */
export function isMachineSectionAllowed(
  sectionId: string,
  principal: SettingsPrincipal,
  machine: { readonly isLocalBackend: boolean },
): boolean {
  if (!principal.isOwner) return false;
  if (sectionId === "network") return principal.isDesktop && machine.isLocalBackend;
  return (MACHINE_SECTION_IDS as ReadonlyArray<string>).includes(sectionId);
}
