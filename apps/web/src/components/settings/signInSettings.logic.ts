import {
  type KeycloakCheckResult,
  keycloakClientUrls,
  type RegistrationMode,
  type SignInSettings,
  type UpdateSignInSettingsRequest,
} from "@t3tools/contracts";
import * as Redacted from "effect/Redacted";

/** What the Owner edits before saving; an empty `clientSecret` keeps the saved one. */
export interface SignInForm {
  readonly registrationMode: RegistrationMode;
  readonly localSignInForMembers: boolean;
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

export const formOf = (settings: SignInSettings): SignInForm => ({
  registrationMode: settings.registrationMode,
  localSignInForMembers: settings.localSignInForMembers,
  issuer: settings.keycloak.issuer ?? "",
  clientId: settings.keycloak.clientId ?? "",
  clientSecret: "",
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
    description: "Anyone who signs in with Keycloak gets a User.",
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
