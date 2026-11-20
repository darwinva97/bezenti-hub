import {
  type KeycloakCheckResult,
  type KeycloakStatus,
  keycloakClientUrls,
  type KeycloakGroupMapping,
  type RegistrationMode,
  type SignInSettings,
  type SpaceId,
  type SpaceRole,
  type UpdateSignInSettingsRequest,
} from "@t3tools/contracts";
import * as Redacted from "effect/Redacted";

/** A group mapping as the form lists it: what the Hub showed, or one added and not saved yet. */
export type MappingRow = KeycloakGroupMapping;

/**
 * What the Owner edits before saving; an empty `clientSecret` keeps the saved one. The strong
 * factor's `acr` and `amr` values (ticket 06) are typed as a list, separated by commas or spaces.
 * The groups claim and the group mappings are ticket 05's.
 */
export interface SignInForm {
  readonly registrationMode: RegistrationMode;
  readonly localSignInForMembers: boolean;
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly strongAcr: string;
  readonly strongAmr: string;
  readonly groupsClaim: string;
  readonly groupMappings: ReadonlyArray<MappingRow>;
}

/** A group as the Hub keeps it: trimmed, without one leading `/`. */
const groupNameOf = (text: string): string => {
  const trimmed = text.trim();
  return trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
};

const mappingKey = (mapping: { readonly group: string; readonly spaceId: string }) =>
  `${mapping.group}\u0000${mapping.spaceId}`;

/**
 * The form's mappings with one more, or a reason it can't be added: empty group, no Organization,
 * or that group already mapped to that Organization (change its Role by removing it first).
 */
export const withMapping = (
  settings: SignInSettings,
  rows: ReadonlyArray<MappingRow>,
  added: { readonly group: string; readonly spaceId: SpaceId | null; readonly role: SpaceRole },
): { readonly rows: ReadonlyArray<MappingRow> } | { readonly error: string } => {
  const group = groupNameOf(added.group);
  if (group === "") return { error: "Enter the Keycloak group." };
  const organization = settings.mappableOrganizations.find(
    (candidate) => candidate.spaceId === added.spaceId,
  );
  if (organization === undefined) return { error: "Choose the Organization." };
  if (
    rows.some((row) => mappingKey(row) === mappingKey({ group, spaceId: organization.spaceId }))
  ) {
    return { error: `${group} is already mapped to ${organization.name}.` };
  }
  return {
    rows: [
      ...rows,
      {
        group,
        spaceId: organization.spaceId,
        organizationName: organization.name,
        role: added.role,
        enabled: true,
        archived: false,
      },
    ],
  };
};

const sameMappings = (a: ReadonlyArray<MappingRow>, b: ReadonlyArray<MappingRow>) =>
  a.length === b.length &&
  a.every((row) => b.find((other) => mappingKey(other) === mappingKey(row))?.role === row.role);

/** A typed list of values: split on commas and blanks, without repeats or empties. */
export const valuesOf = (text: string): ReadonlyArray<string> => [
  ...new Set(text.split(/[\s,]+/).filter((value) => value !== "")),
];

const sameValues = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

export const formOf = (settings: SignInSettings): SignInForm => ({
  registrationMode: settings.registrationMode,
  localSignInForMembers: settings.localSignInForMembers,
  issuer: settings.keycloak.issuer ?? "",
  clientId: settings.keycloak.clientId ?? "",
  clientSecret: "",
  strongAcr: settings.keycloak.strongAcr.join(", "),
  strongAmr: settings.keycloak.strongAmr.join(", "),
  groupsClaim: settings.keycloak.groupsClaim,
  groupMappings: settings.groupMappings,
});

/** Only what the Owner changed; `null` when nothing did. The secret goes only when typed. */
export const changesOf = (
  settings: SignInSettings,
  form: SignInForm,
): UpdateSignInSettingsRequest | null => {
  const saved = formOf(settings);
  const request: {
    -readonly [K in keyof UpdateSignInSettingsRequest]: UpdateSignInSettingsRequest[K];
  } = {};
  if (form.registrationMode !== saved.registrationMode) {
    request.registrationMode = form.registrationMode;
  }
  if (form.localSignInForMembers !== saved.localSignInForMembers) {
    request.localSignInForMembers = form.localSignInForMembers;
  }
  if (form.issuer.trim() !== saved.issuer) request.issuer = form.issuer;
  if (form.clientId.trim() !== saved.clientId) request.clientId = form.clientId;
  if (form.clientSecret !== "") request.clientSecret = Redacted.make(form.clientSecret);
  const strongAcr = valuesOf(form.strongAcr);
  const strongAmr = valuesOf(form.strongAmr);
  if (!sameValues(strongAcr, settings.keycloak.strongAcr)) request.strongAcr = strongAcr;
  if (!sameValues(strongAmr, settings.keycloak.strongAmr)) request.strongAmr = strongAmr;
  if (form.groupsClaim.trim() !== saved.groupsClaim) request.groupsClaim = form.groupsClaim;
  // The whole list goes when anything in it changed; the Hub works out what was added or removed.
  if (!sameMappings(form.groupMappings, settings.groupMappings)) {
    request.groupMappings = form.groupMappings.map(({ group, spaceId, role }) => ({
      group,
      spaceId,
      role,
    }));
  }
  return Object.keys(request).length === 0 ? null : request;
};

/** One URL to paste into the Keycloak client, with the field it goes in. */
export interface ClientUrl {
  readonly label: string;
  /** The field's name in Keycloak's client settings. */
  readonly keycloakField: string;
  readonly url: string;
}

/**
 * The URLs for the Keycloak client, from `T3CODE_PUBLIC_URL` when the Hub has one, else from the
 * address this page was opened on (`fromPage`: the Owner should check it is the one people use).
 */
export const clientUrlsOf = (
  publicOrigin: string | null,
  pageOrigin: string,
): { readonly fromPage: boolean; readonly urls: ReadonlyArray<ClientUrl> } => {
  const urls = keycloakClientUrls(publicOrigin ?? pageOrigin);
  return {
    fromPage: publicOrigin === null,
    urls: [
      { label: "Redirect URL", keycloakField: "Valid redirect URIs", url: urls.redirect },
      {
        label: "Back-channel logout URL",
        keycloakField: "Backchannel logout URL",
        url: urls.backchannelLogout,
      },
      {
        label: "Post-logout URL",
        keycloakField: "Valid post logout redirect URIs",
        url: urls.postLogout,
      },
    ],
  };
};

/** «Check» in a few lines for the Owner. */
/**
 * The Owner's warnings about Keycloak's re-checks (ticket 07), while it is on: a realm that does
 * not answer, or rejects the Hub's client (a wrong secret looks like nothing else), and a newest
 * sign-in without `offline_access`. `formatDate` writes the date as the page does.
 */
export const keycloakWarningsOf = (
  enabled: boolean,
  status: KeycloakStatus | undefined,
  formatDate: (iso: string) => string,
): ReadonlyArray<string> => {
  if (!enabled || status === undefined) return [];
  const warnings: Array<string> = [];
  if (status.unreachableSince !== null) {
    const since = formatDate(status.unreachableSince);
    warnings.push(
      status.problem === "rejected"
        ? `Keycloak has rejected this Hub's client since ${since}: check its client secret. Nobody is signed out meanwhile, so a disabled account is not signed out either.`
        : `Keycloak has not answered since ${since}. Nobody is signed out meanwhile; disabled accounts are signed out once it answers again.`,
    );
  }
  if (status.lastLoginOffline === false) {
    warnings.push(
      "The newest Keycloak sign-in did not get offline_access, so Hub sessions end when the Keycloak session ends. Allow the offline_access scope for this client in Keycloak.",
    );
  }
  return warnings;
};

export const checkLinesOf = (result: KeycloakCheckResult): ReadonlyArray<string> =>
  result._tag === "failed"
    ? [result.message]
    : [
        `The realm answers, with ${result.signingKeys} signing ${result.signingKeys === 1 ? "key" : "keys"}.`,
        result.backchannelLogoutSupported
          ? "Back-channel logout: supported."
          : "Back-channel logout: not offered by this realm.",
        result.offlineAccessOffered
          ? "Offline access: offered."
          : "Offline access: not offered by this realm.",
        ...(result.acrValuesSupported.length === 0
          ? []
          : [`acr values: ${result.acrValuesSupported.join(", ")}.`]),
      ];

export const REGISTRATION_MODES: ReadonlyArray<{
  readonly value: RegistrationMode;
  readonly label: string;
  readonly description: string;
}> = [
  {
    value: "open",
    label: "Open",
    description: "Anyone who signs in with Keycloak gets a User, without any Organization.",
  },
  {
    value: "invitation-only",
    label: "Invitation only",
    description: "A new person needs an Invitation or a mapped Keycloak group.",
  },
  {
    value: "closed",
    label: "Closed",
    description: "Only a Platform invitation from you adds someone new.",
  },
];
