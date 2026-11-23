# Ticket 11: real test against a real Keycloak

Run on 2026-11-22 in WSL (Ubuntu 22.04) with `node .scratch/keycloak-sign-in/11-real-test.mjs`
from the repository root. Result: **21 passed, 0 failed.** It is a reproducible script, not a CI
test. The script makes every password and secret at runtime and never prints them. It cleans up
what it started: the Hub by PID, the `kc11-keycloak` container by name, and its `/tmp` dirs.

## Setup

- **Keycloak** is `quay.io/keycloak/keycloak:26.4.0` in `start-dev`, container `kc11-keycloak`.
  - It runs on the host network bound to `127.0.0.1:18080`.
  - Its `--hostname` is a recording proxy on `127.0.0.1:18081`.
- **Realms** are built through the admin REST API.
  - `hub`:
    - open registration;
    - groups `bezenti` and `bezenti-admin`, the second carrying role `hub-admin`;
    - a browser flow with level 1 (password, acr `basico`), level 2 (OTP, acr `critica`), and OTP whatever the level for `hub-admin`;
    - the confidential client `t3-hub`: PKCE S256, redirect, post-logout and back-channel URLs (session required), a `groups` mapper and an `amr` mapper.
  - `upstream`: an OIDC identity provider of `hub`.
- **Hub**: the server alone (`apps/server/src/bin.ts`).
  - `T3CODE_HOME` is a fresh `/tmp/kc11-hub-*`, port 3911.
  - OTLP traces go to a collector inside the driver.
  - Settings: issuer `http://127.0.0.1:18081/realms/hub`, strong acr `critica`, strong amr `otp`, mappings `bezenti` → Member and `bezenti-admin` → Admin of Bezenti.
- **Recording proxies** keep every code, ID/access/refresh token, PKCE verifier and logout token, for the leak sweep. One sits in front of Keycloak, one in front of the Hub's back-channel.

## Results per flow

| Flow                                                           | Result                                                                                                                                                                                                                                             |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner bootstrap (software passkey), Keycloak settings, «Check» | ok, 1 signing key                                                                                                                                                                                                                                  |
| Open registration: sign up at Keycloak                         | User created, `user.register` audited                                                                                                                                                                                                              |
| Closed registration                                            | refused, `/sign-in?keycloak=registration-closed`, no User                                                                                                                                                                                          |
| Platform invitation while closed                               | User created, invitation spent                                                                                                                                                                                                                     |
| Broker (`upstream` realm) in open mode                         | User created through the provider                                                                                                                                                                                                                  |
| Group `bezenti` on first sign-in                               | Member of Bezenti, managed by Keycloak                                                                                                                                                                                                             |
| Link a local User (password, then Keycloak)                    | linked; the old password answers 401                                                                                                                                                                                                               |
| Admin with OTP (`bezenti-admin`)                               | OTP set up at Keycloak. The first sign-in is refused `strong-factor-required` (see Findings); «retry with second factor» (acr `critica`) gets them in as Admin                                                                                     |
| Admin without OTP (a Hub-promoted Admin)                       | weak session ended by the promotion; refused without OTP; in after OTP via the retry                                                                                                                                                               |
| Desktop at the protocol level                                  | `/app-sign-in` round trip through a Keycloak sign-in, approve, loopback callback, token; the bearer works                                                                                                                                          |
| Mobile at the protocol level                                   | approve with `t3code://auth/callback`, token; the account shows the linked identity                                                                                                                                                                |
| MCP client from the Keycloak browser session                   | token issued                                                                                                                                                                                                                                       |
| Disabled in Keycloak                                           | sign-ins aged (see Deviations); the next use's re-check ends the session, its socket and the desktop and mobile apps                                                                                                                               |
| Logout from the Keycloak admin console                         | user-level «Sign out»: nothing reaches the Hub (see Findings). «Sign out» of the Offline session: back-channel logout, socket closed, session ended                                                                                                |
| «Also sign out of Keycloak»                                    | no `id_token_hint` in the address; Keycloak 26.4 signs out without a confirm page and returns to `/sign-in`; the next sign-in asks for the password                                                                                                |
| Keycloak stopped                                               | the Owner gets in with a recovery code and with the passkey. An existing Keycloak session stays in at its re-check (fails open, as the spec decides), and the Owner sees `unreachable`. A new `start` still answers 200, from the cached discovery |
| Process sweep (Hub and children: args, environment)            | 0 hits                                                                                                                                                                                                                                             |
| Leak sweep                                                     | 58 values (client secret, 11 codes, 33 tokens, 11 verifiers, 2 logout tokens): 0 in the Hub's log, 45 OTLP bodies, 20 files outside the encrypted store                                                                                            |

## Desktop and mobile: what was and wasn't covered

- **Covered:** the HTTP requests both apps make, built with the same shared helpers they use (`appSignInPageUrl`, `appSignInLoopbackRedirectUri`, `appSignInMobileRedirectUri`, `readAppSignInCallback`):
  - the page round trip through a Keycloak sign-in (`returnTo`);
  - the approval;
  - the callback (a real loopback listener for desktop; the custom-scheme address read, not followed, for mobile);
  - the code exchange;
  - the bearer's session and account;
  - both apps ending with the sign-in.
- **Not covered:** Electron and Expo themselves, the system browser's UI and cookies, the deep-link handoff into the apps, and the web pages' JavaScript. The server ran without the web build.

## Deviations

- **Broker:** no Google or GitHub OAuth app credentials, so a second realm (`upstream`), configured as an OIDC identity provider, stands in for them.
- **Memory cap:** rootless podman in this WSL has no systemd user session and no cgroup to delegate. `--memory 1g` fails with "could not find cgroup mount", so the script falls back to `--cgroups=disabled` and caps the JVM heap at 640 MB (`JAVA_OPTS_KC_HEAP`).
- **Re-check time:** no hour-long waits. Before the next use, the driver ages the person's `identity_logins.checked_at` by two hours in the Hub's SQLite (`node:sqlite`).
- **Hub:** the server alone, not `vp run dev`. Every flow is HTTP, so the web build was not needed.

## Findings

- **The admin console's user-level «Sign out» does not reach the Hub.**
  - The Hub asks for `offline_access`, so a person's sign-in lives on an Offline session. After sign-in Keycloak shows 0 regular sessions and 1 offline.
  - `users/{id}/logout` ends regular sessions only. It sends no back-channel logout, and the offline session stays valid, so the hourly re-check never ends that sign-in either.
  - Signing out the Offline session row (`DELETE /sessions/{id}?isOffline=true`) does send the logout token, and the Hub ends the sign-in at once.
  - Documented in `docs/user/public-hub.md`. Spec user story 35 assumed the user-level «Sign out» works: follow-up.
- **`amr` does not make a `bezenti-admin` sign-in strong on the first try** in this realm (the `amr` mapper was added, but the first OTP sign-in was not strong). The Hub's «retry with second factor» (acr `critica`) works as the spec designs. Realms that want Admins strong on the first try need the authenticators' AMR references configured.
- **Keycloak 26.4 signs out without a confirm page** even without `id_token_hint` (with `client_id` and `post_logout_redirect_uri`). The docs say a realm _may_ ask.
- **With Keycloak down, `start` still answers 200**, from the cached discovery, and the browser then hits the dead realm. Not a security gap; noted.
