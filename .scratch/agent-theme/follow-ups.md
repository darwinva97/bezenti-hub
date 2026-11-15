# Agent theme: follow-ups (not built)

- CSP hardening: the Hub serves the web app with no Content-Security-Policy beyond `frame-ancestors` (`apps/server/src/http.ts`), and the desktop CSP allows `img-src http: https:` (`apps/desktop/src/electron/ElectronProtocol.ts`). Add `img-src`/`font-src`/`connect-src`/`style-src` limits as defence in depth for any injected markup or CSS; independent of agent themes.
