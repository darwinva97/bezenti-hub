/**
 * The Hub's address for the realm to send a browser back to (callback, post-logout): the public
 * URL when set, else the page's origin, only when it is the request's own (forwarded only by a
 * trusted proxy) or a trusted one; never a preview's page.
 */
import type { HttpServerRequest } from "effect/http";

import type * as ServerConfig from "../config.ts";
import { crossesFromPreviewOrigin } from "../preview/PreviewOrigin.ts";

export const makeHubOrigin = (config: ServerConfig.ServerConfig["Service"]) => {
  // The Hub's own page origins besides the request's: the public URL and the dev servers'.
  const trustedOrigins = new Set<string>([
    ...(config.publicUrl === undefined ? [] : [config.publicUrl.origin]),
    ...(config.devUrl === undefined ? [] : [config.devUrl.origin]),
    ...config.devAllowedOrigins,
  ]);
  /** The base origin to name to the realm, or undefined when the page is not the Hub's own. */
  return (request: HttpServerRequest.HttpServerRequest): string | undefined => {
    const origin = request.headers.origin;
    if (origin === undefined || crossesFromPreviewOrigin(config.previewOrigin, request.headers)) {
      return undefined;
    }
    const host = request.headers.host;
    const own = host === undefined ? null : URL.parse(`${request.protocol}://${host}`);
    const allowed =
      trustedOrigins.has(origin) ||
      (config.publicUrl === undefined && own !== null && own.origin === origin);
    if (!allowed) return undefined;
    return config.publicUrl?.origin ?? origin;
  };
};
