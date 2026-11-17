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
