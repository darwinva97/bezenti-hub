# Publish the Hub on your domain

Put the Hub at an address such as `https://hub.example.com` so the people you
invite can sign in from anywhere, without Tailscale. A reverse
proxy on the same machine serves HTTPS and forwards to T3 Code, which keeps
listening only on this machine.

Create the Owner account first, from this machine or your local network. Until
the Installation has an Owner it refuses clients from public addresses, including
those your proxy forwards; once it has one, it accepts any address, because every
request then needs someone signed in.

## Before you start

- A machine that stays on, with T3 Code running as a
  [background service](./background-service.md) or under `t3 serve`.
- A domain name whose DNS record points at that machine, and ports 80 and 443
  open to it.
- [Caddy](https://caddyserver.com), or nginx with a TLS certificate.

## Configure T3 Code

Set these in the environment that starts the server. For the background
service, add them to
[`service.env`](./background-service.md#configure-the-service-environment) and
restart it:

```sh
T3CODE_PUBLIC_URL=https://hub.example.com
T3CODE_TRUSTED_PROXIES=loopback
```

- `T3CODE_PUBLIC_URL` is the address people open. Passkeys are registered on
  that address and only work there, so set it before anyone registers one, and
  sign in through it rather than through `localhost` or a LAN address. It is
  also where every link T3 Code hands out points: **Copy thread** and prompt
  links, thread links for outside MCP clients, guest links, and the links
  `t3 auth pairing create` and `t3 auth owner-reset` print. Without it, links
  use the address you reached the Hub on, and guest links are off. To have
  copied thread links open the mobile app, build it with
  `EXPO_PUBLIC_T3CODE_PUBLIC_URL` set to the same address.
- `T3CODE_TRUSTED_PROXIES` lists the proxies allowed to tell T3 Code who the
  client is: `loopback` for a proxy on the same machine, or IP addresses and
  CIDR ranges such as `10.0.0.0/8` for one elsewhere, separated by commas.
  `loopback` is the default; setting a list replaces it, so keep `loopback`
  in it if Tailscale Serve also runs on the machine. `none` trusts
  no proxy.

T3 Code reads the client's address and whether it used HTTPS from
`X-Forwarded-For` and `X-Forwarded-Proto` (or `Forwarded`), but only when the
request comes from a trusted proxy. From anyone else those headers are ignored.
The client's address is what sign-in back-off counts against and what
**User settings → Sessions** shows, so with a proxy T3 Code does not
trust, every visitor looks like the proxy.

## Caddy

Caddy gets and renews the certificate on its own. A complete `Caddyfile`:

```caddyfile
hub.example.com {
	reverse_proxy 127.0.0.1:3773
}
```

Replace `3773` with the port T3 Code listens on (`t3 status` shows it). Caddy
sends `X-Forwarded-For` and `X-Forwarded-Proto` and keeps the `Host` header, and
WebSocket connections pass through without extra settings.

## nginx

nginx needs the headers and the WebSocket upgrade spelled out:

```nginx
location / {
    proxy_pass http://127.0.0.1:3773;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 1h;
}
```

Put it in a `server` block that listens on 443 with your certificate.

## Sign in over HTTPS

Signing in or pairing over plain HTTP works only from this machine, your local
network and your tailnet; from a public address it takes HTTPS. Once
`T3CODE_PUBLIC_URL` is set, only this machine may use plain HTTP. A proxy that
forwards a request without naming the client counts as a public client. Session
cookies sent over HTTPS are marked `Secure`.

## Previews on a domain of their own

A dev server started in a Thread opens through the Hub with **Open preview**. Without more
settings it opens at `/preview/<code>/` on the Hub's own address, sandboxed so the page cannot
use your Hub session; dev servers that load modules or call `fetch()` (Vite, Next.js and the like)
do not work there. Give previews a domain of their own and each one gets its own address, where
they work as on your machine:

```sh
T3CODE_PREVIEW_ORIGIN=https://*.preview.example.net
```

- **DNS:** a wildcard record, `*.preview.example.net`, pointing at the Hub's machine.
- **Certificate:** a wildcard certificate for `*.preview.example.net` (Caddy gets one with a DNS
  challenge; see its `tls` directive), and the proxy forwarding those names to T3 Code with their
  `Host` header kept (or `X-Forwarded-Host` from a trusted proxy).
- **Prefer a separate domain** (`example.net` for a Hub at `hub.example.com`). A preview on a
  subdomain of the Hub's own domain (`*.preview.hub.example.com`) works too, and T3 Code guards
  the Hub from it, but pages on the same domain are "same-site" to the browser, so a separate
  domain is one less thing to rely on.

Each preview gets a random name of its own, never shared between people or Organizations. Opening
one signs that browser in to it with a one-time link and a cookie for that preview only; your Hub
session never reaches it, and nothing at those addresses reaches the Hub. With the setting on, the
Hub's session cookie over HTTPS is named `__Host-…`: a browser that last used the Hub before the
upgrade signs in once more.

For trying it on one machine, `T3CODE_PREVIEW_ORIGIN=http://*.localhost:3773` (with the Hub's
port) works without DNS or certificates: browsers send `*.localhost` to this machine.

## Sign in with Keycloak

People you let in sign in with an account of your own Keycloak realm instead of
a passkey or a password kept in the Hub. Keycloak then holds their password,
second factor, email verification and password recovery, and a person you disable
there stops having access to the Hub. You stay in charge of who gets a User and
of who belongs to which Organization. Set `T3CODE_PUBLIC_URL` first: the
addresses below are built from it. Your own passkey and recovery codes keep
working whatever you configure here.

**In Keycloak**, create a client in the realm:

- **Client authentication** on (a confidential client), **Standard flow** on.
- **Valid redirect URIs:** `https://hub.example.com/oauth/keycloak/callback`
- **Backchannel logout URL:** `https://hub.example.com/oauth/keycloak/backchannel-logout`,
  with **Backchannel logout session required** on.
- **Valid post logout redirect URIs:** `https://hub.example.com/sign-in`

**Platform → Keycloak** shows the three addresses with a **Copy** button each,
for your own domain. Allow the `offline_access` scope for the client: the Hub
asks for it, and it is what lets the Hub keep checking an account for up to 30
days (see below). Copy the client's secret from its **Credentials** tab.

**In T3 Code**, open **Platform → Keycloak** and fill in:

- **Issuer:** the realm's address, `https://auth.example.com/realms/<realm>`.
- **Client ID** and **Client secret.** The secret is write-only: once saved,
  nobody can read it back from the Hub, you included. **Replace** sets a new one.
- **Check** fetches the realm's discovery document and keys and says what the
  realm offers: back-channel logout, `offline_access` and its `acr` values.
- Turn **Keycloak active** on. It checks the realm first and stays off if the
  check fails. **Sign in with Keycloak** then appears on the sign-in page.

**Groups.** To make a Keycloak group give people a Membership, add a mapper to
the client (**Group Membership**) with **Add to ID token** on, and write its
claim name in **Groups** (`groups` unless you changed it). A claim that is
missing from the token means the person has no groups, so set the mapper up
_before_ you add mappings: otherwise every managed Membership would go at the
next sign-in. A mapping names a group, an Organization and a Role; the list
offers only Organizations you steward. See
[Keycloak groups and Memberships](./install.md#keycloak-groups-and-memberships).

**Second factor.** Your Admins and you must sign in to Keycloak with a second
factor. The Hub trusts only what the verified ID token says, so tell it what
counts: under **Strong factor**, list the `acr` values and the `amr` values (for
example `otp` or `webauthn`) that mean a second factor, exactly as the token
spells them. Add the `acr` and `amr` claims to the client's ID token with
mappers (Keycloak's authentication-level and authentication-method mappers, or
your own). **Check** lists the realm's `acr` values. With both lists empty, no
Keycloak sign-in is strong, and Admins cannot sign in with Keycloak. Members do
not need a second factor.

**Who may register.** **Platform → Registration** has three modes: **Open**,
**Invitation only** (the default) and **Closed**; see
[Registration and invitations](./install.md#registration-modes-and-platform-invitations).
Keep **Open** off a public Hub until the terms of use that people accept at
sign-up exist.

**Local sign-in.** The switch **Local sign-in (passkey or password) for
everyone but you** closes the Hub's own passkeys and passwords to everyone
else. It turns off only while Keycloak is on, and asks you to confirm first,
saying how many people and sessions it ends. Turning Keycloak off opens it
again.

The Hub re-checks every Keycloak sign-in in the background, at most once an
hour, and back-channel logout ends one the moment Keycloak says it ended. A
Keycloak that is down does not sign anyone out; the Platform page then warns
that it has not answered since a time.

**Also sign out of Keycloak.** Signing out of the Hub from a Keycloak sign-in
offers to sign out of Keycloak too. The Hub never sends Keycloak a token of the
person, so depending on its version and settings Keycloak may first show its own
«Do you want to log out?» page (Keycloak 26.4 signs them out straight away).
Then it brings them back to the Hub's sign-in page.

## If something does not work

- **Passkey sign-in says to open the Installation's own address.** The page's
  address does not match `T3CODE_PUBLIC_URL`. Open the public address.
- **Passkeys registered before you set the public URL stopped working.** They
  belong to the address they were registered on. Sign in with a recovery code
  and register a new passkey, or have the Owner run `t3 auth owner-reset
  --base-url https://hub.example.com`.
- **Sign-in is refused as insecure.** The proxy is not sending
  `X-Forwarded-Proto: https`, or its address is not in
  `T3CODE_TRUSTED_PROXIES`.
- **Everyone is locked out after one person's failed attempts.** T3 Code does
  not trust the proxy, so it counts every attempt against the proxy's address.
  Add the proxy to `T3CODE_TRUSTED_PROXIES`.
- **Sign in with Keycloak ends on the realm with a redirect error.** The
  client's **Valid redirect URIs** does not contain the Hub's address from
  **Platform → Keycloak**, which follows `T3CODE_PUBLIC_URL`.
- **Keycloak is rejected, or «Check» fails.** Read what **Check** says: the issuer
  must be the realm's exact address, and a rejected client usually means a wrong
  client secret. Nobody is signed out while the realm is unreachable or rejects
  the client.
- **Sessions end when the Keycloak session does.** The newest sign-in did not get
  `offline_access`. Allow that scope for the client.
- **Signing someone out in Keycloak's console leaves them in the Hub.** The Hub
  asks for `offline_access`, so its sign-in lives on the person's _offline_
  session. The user's **Sign out** ends only their regular sessions. To cut
  them at once, open the user's **Sessions** tab and sign out the session of
  type **Offline**; Keycloak then sends the back-channel logout. Disabling the
  user works too, at the next hourly re-check.
- **Back-channel logout never arrives.** Keycloak must reach the Hub's address.
  On a Hub it cannot reach (a LAN or Tailscale), the hourly re-check ends the
  sign-in instead, a little later.
