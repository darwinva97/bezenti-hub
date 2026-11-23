// Keycloak 11's real test (not CI): `node .scratch/keycloak-sign-in/11-real-test.mjs` from the
// repository root in WSL. Keycloak in podman, two realms by its admin API, the Hub server on a
// throwaway home, every flow over HTTP; secrets are random and never printed. See 11-real-test.md.

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";

import {
  appSignInLoopbackRedirectUri,
  appSignInMobileRedirectUri,
  appSignInPageUrl,
  readAppSignInCallback,
} from "../../packages/shared/src/appSignIn.ts";

const REPO = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../..");
const KC_IMAGE = "quay.io/keycloak/keycloak:26.4.0";
const KC_CONTAINER = "kc11-keycloak";
const KC_PORT = 18080; // Keycloak itself, loopback only
const KC_PROXY_PORT = 18081; // the recording proxy: Keycloak's public address (its --hostname)
const BACKCHANNEL_PROXY_PORT = 18082; // the recording proxy in front of the Hub's back-channel
const OTLP_PORT = 18083; // a collector for the Hub's OTLP traces
const HUB_PORT = 3911;
const KC = `http://127.0.0.1:${KC_PROXY_PORT}`;
const HUB = `http://localhost:${HUB_PORT}`;
const ISSUER = `${KC}/realms/hub`;
const CLIENT_ID = "t3-hub";

const random = (bytes = 24) => NodeCrypto.randomBytes(bytes).toString("base64url");
const SECRETS = {
  admin: random(),
  client: random(32),
  broker: random(32),
  password: () => `Pw-${random(12)}`,
};

const RUN = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kc11-run-"));
const HUB_HOME = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kc11-hub-"));

/** What the proxies saw: every secret value of the Hub's flows, to look for afterwards. */
const recorded = {
  codes: new Set(),
  tokens: new Set(),
  verifiers: new Set(),
  logoutTokens: new Set(),
};
const otlpBodies = [];
const results = [];
const started = { hub: undefined, container: false, servers: [] };

const log = (line) => process.stdout.write(`${line}\n`);
const note = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  log(`${ok ? "PASS" : "FAIL"}  ${name}${detail === "" ? "" : `: ${detail}`}`);
};
const STEP_DEADLINE_MS = 180_000;
const step = async (name, run) => {
  try {
    const detail = await Promise.race([
      run(),
      wait(STEP_DEADLINE_MS).then(() => {
        throw new Error(`no answer within ${STEP_DEADLINE_MS / 1000} s`);
      }),
    ]);
    note(name, true, detail ?? "");
  } catch (error) {
    note(name, false, error instanceof Error ? error.message : String(error));
  }
};
const expect = (condition, message) => {
  if (!condition) throw new Error(message);
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Jar {
  cookies = [];
  store(host, setCookies) {
    for (const header of setCookies ?? []) {
      const [pair, ...attributes] = header.split(";").map((part) => part.trim());
      const at = pair.indexOf("=");
      const name = pair.slice(0, at);
      const value = pair.slice(at + 1);
      let path = "/";
      let expired = value === "";
      for (const attribute of attributes) {
        const [key, raw = ""] = attribute.split("=");
        const lower = key.toLowerCase();
        if (lower === "path") path = raw;
        if (lower === "max-age" && Number(raw) <= 0) expired = true;
        if (lower === "expires" && Date.parse(raw) < Date.now()) expired = true;
      }
      this.cookies = this.cookies.filter(
        (cookie) => !(cookie.host === host && cookie.name === name && cookie.path === path),
      );
      if (!expired) this.cookies.push({ host, name, value, path });
    }
  }
  header(host, pathname) {
    return this.cookies
      .filter((cookie) => cookie.host === host && pathname.startsWith(cookie.path))
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");
  }
  forget(host, name) {
    this.cookies = this.cookies.filter((cookie) => !(cookie.host === host && cookie.name === name));
  }
}

/** One request; `localhost` is dialled at 127.0.0.1, the Host header keeps the name. */
const request = (url, { method = "GET", headers = {}, body, jar } = {}) =>
  new Promise((resolve, reject) => {
    const target = new URL(url);
    const cookie = jar?.header(target.host, target.pathname);
    const outgoing = NodeHttp.request(
      {
        host: target.hostname === "localhost" ? "127.0.0.1" : target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method,
        headers: {
          host: target.host,
          ...(cookie ? { cookie } : {}),
          ...(body === undefined ? {} : { "content-length": Buffer.byteLength(body) }),
          ...headers,
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          jar?.store(target.host, response.headers["set-cookie"]);
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            text,
            location: response.headers.location
              ? new URL(response.headers.location, url).href
              : undefined,
            json: () => (text === "" ? {} : JSON.parse(text)),
          });
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.setTimeout(30_000, () => {
      outgoing.destroy(new Error(`no answer from ${target.host} within 30 s`));
    });
    if (body !== undefined) outgoing.write(body);
    outgoing.end();
  });

/** A request to the Hub as its own page makes it (Origin, protocol header), JSON or form. */
const hub = (jar, path, { json, form, bearer, origin = true, method } = {}) =>
  request(`${HUB}${path}`, {
    method: method ?? (json === undefined && form === undefined ? "GET" : "POST"),
    jar,
    headers: {
      "x-t3-orchestration-protocol": "3",
      ...(origin ? { origin: HUB } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(json === undefined ? {} : { "content-type": "application/json" }),
      ...(form === undefined ? {} : { "content-type": "application/x-www-form-urlencoded" }),
    },
    body:
      json !== undefined
        ? JSON.stringify(json)
        : form !== undefined
          ? new URLSearchParams(form).toString()
          : undefined,
  });

const decode = (text) =>
  text
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replace(/&#x([0-9a-f]+);/giu, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/gu, (_, dec) => String.fromCodePoint(Number(dec)));

const attributesOf = (tag) =>
  Object.fromEntries(
    [...tag.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/gu)].map((match) => [match[1], decode(match[2])]),
  );

const formsOf = (html) =>
  [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/giu)].map((match) => {
    const attributes = attributesOf(match[1]);
    const inputs = {};
    for (const input of match[2].matchAll(/<input\b([^>]*)>/giu)) {
      const field = attributesOf(input[1]);
      if (!field.name) continue;
      if ((field.type === "checkbox" || field.type === "radio") && !/\bchecked\b/u.test(input[1])) {
        continue;
      }
      if (field.type === "submit") continue;
      inputs[field.name] = field.value ?? "";
    }
    return { id: attributes.id ?? "", action: attributes.action ?? "", inputs };
  });

const linkOf = (html, pattern) => {
  for (const match of html.matchAll(/<a\b([^>]*)>/giu)) {
    const attributes = attributesOf(match[1]);
    if (attributes.href && (pattern.test(attributes.href) || pattern.test(attributes.id ?? ""))) {
      return attributes.href;
    }
  }
  return undefined;
};

const titleOf = (html) => /<title>([^<]*)<\/title>/iu.exec(html)?.[1]?.trim() ?? "(no title)";
const errorOf = (html) =>
  decode(
    /class="[^"]*(?:kc-feedback-text|pf-m-danger|alert-error)[^"]*"[^>]*>([\s\S]*?)<\//iu
      .exec(html)?.[1]
      ?.replace(/<[^>]+>/gu, "")
      .trim() ?? "",
  );

/** RFC 6238 TOTP over Keycloak's `totpSecret` (its raw secret), SHA-1, 6 digits, 30 seconds. */
const lastCounter = new Map();
const totp = async (secret) => {
  let counter = Math.floor(Date.now() / 30_000);
  // Keycloak refuses a code used once already: wait for the next window if this one is spent.
  while (lastCounter.get(secret) === counter) {
    await wait(1_000);
    counter = Math.floor(Date.now() / 30_000);
  }
  lastCounter.set(secret, counter);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = NodeCrypto.createHmac("sha1", Buffer.from(secret, "utf8"))
    .update(message)
    .digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const value = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(value).padStart(6, "0");
};

/**
 * The person at Keycloak, from `url` until Keycloak sends the browser back to the Hub. `person`:
 * `username`, `password`, `email`, `firstName`, `lastName`; `register` signs up first; `broker`
 * names an upstream account to sign in with instead; `otpSecret` is kept once OTP is set up.
 */
const atKeycloak = async (jar, url, person) => {
  let response = await request(url, { jar });
  let registered = false;
  let brokered = false;
  for (let turn = 0; turn < 30; turn += 1) {
    if (response.status >= 300 && response.status < 400) {
      const next = response.location ?? "";
      if (next.startsWith(HUB)) return next;
      response = await request(next, { jar });
      continue;
    }
    if (response.status !== 200) throw new Error(`Keycloak answered ${response.status}`);
    const html = response.text;
    const forms = formsOf(html);
    const form = (id) => forms.find((candidate) => candidate.id === id);
    const post = (target, fields) =>
      request(new URL(target.action, url).href, {
        method: "POST",
        jar,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ ...target.inputs, ...fields }).toString(),
      });
    const upstream =
      /\/realms\/upstream\//u.test(response.location ?? "") ||
      /realms\/upstream/u.test(form("kc-form-login")?.action ?? "");
    if (form("kc-form-login")) {
      if (person.register && !registered) {
        const link = linkOf(html, /registration/u);
        expect(link, "no registration link on the sign-in page");
        registered = true;
        response = await request(new URL(link, url).href, { jar });
        continue;
      }
      if (person.broker && !brokered && !upstream) {
        const link = linkOf(html, /broker\/upstream\/login|social-upstream/u);
        expect(link, "no link to the upstream identity provider");
        brokered = true;
        response = await request(new URL(link, url).href, { jar });
        continue;
      }
      const account = upstream ? person.broker : person;
      response = await post(form("kc-form-login"), {
        username: account.username,
        password: account.password,
      });
      continue;
    }
    if (form("kc-register-form")) {
      response = await post(form("kc-register-form"), {
        username: person.username,
        email: person.email,
        firstName: person.firstName,
        lastName: person.lastName,
        password: person.password,
        "password-confirm": person.password,
      });
      continue;
    }
    if (form("kc-totp-settings-form")) {
      const target = form("kc-totp-settings-form");
      person.otpSecret = target.inputs.totpSecret;
      expect(person.otpSecret, "no OTP secret on the OTP setup page");
      response = await post(target, { totp: await totp(person.otpSecret), userLabel: "kc11" });
      continue;
    }
    if (form("kc-otp-login-form")) {
      expect(person.otpSecret, "Keycloak asks for an OTP code the person never set up");
      response = await post(form("kc-otp-login-form"), { otp: await totp(person.otpSecret) });
      continue;
    }
    const profile = forms.find((candidate) =>
      /kc-(update-profile|idp-review-profile|update-email)-form/u.test(candidate.id),
    );
    if (profile) {
      response = await post(profile, {
        email: profile.inputs.email || person.email,
        firstName: profile.inputs.firstName || person.firstName,
        lastName: profile.inputs.lastName || person.lastName,
      });
      continue;
    }
    throw new Error(`unexpected Keycloak page «${titleOf(html)}» ${errorOf(html)}`.trim());
  }
  throw new Error("too many Keycloak pages");
};

/** `start` as the sign-in page posts it, Keycloak, and the callback; where it lands. */
const keycloakRound = async (jar, person, body = { intent: "sign-in" }) => {
  const started = await hub(jar, "/api/auth/keycloak/start", { json: body });
  expect(started.status === 200, `start answered ${started.status}`);
  const back = await atKeycloak(jar, started.json().authorizationUrl, person);
  const code = new URL(back).searchParams.get("code");
  if (code) recorded.codes.add(code);
  const landed = await request(back, { jar, headers: { "x-t3-orchestration-protocol": "3" } });
  expect(landed.status === 303, `the callback answered ${landed.status}`);
  return { location: new URL(landed.location ?? "/", HUB), started: started.json() };
};

const sessionOf = async (jar, bearer) => {
  const session = await hub(jar, "/api/auth/session", bearer ? { bearer } : {});
  return session.json();
};

const ownerJar = new Jar();
const owner = (path, options) => hub(ownerJar, path, options);

// A software passkey (P-256, "none" attestation), as UserAuth.testkit.ts's makeAuthenticator.
const cbor = (value) => {
  const head = (major, length) =>
    length < 24
      ? Buffer.from([(major << 5) | length])
      : length < 256
        ? Buffer.from([(major << 5) | 24, length])
        : Buffer.from([(major << 5) | 25, length >> 8, length & 0xff]);
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), value]);
  const entries = [...value.entries()];
  return Buffer.concat([
    head(5, entries.length),
    ...entries.flatMap(([k, v]) => [cbor(k), cbor(v)]),
  ]);
};
const makePasskey = () => {
  const { publicKey, privateKey } = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const credentialId = NodeCrypto.randomBytes(16);
  let signCount = 0;
  let userHandle = "";
  const sha256 = (data) => NodeCrypto.createHash("sha256").update(data).digest();
  const authData = (flags, attested = Buffer.alloc(0)) => {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(signCount);
    return Buffer.concat([sha256(Buffer.from("localhost")), Buffer.from([flags]), count, attested]);
  };
  const clientData = (type, challenge) =>
    Buffer.from(JSON.stringify({ type, challenge, origin: HUB, crossOrigin: false }));
  return {
    create: (options) => {
      userHandle = options.user.id;
      const coseKey = cbor(
        new Map([
          [1, 2],
          [3, -7],
          [-1, 1],
          [-2, Buffer.from(jwk.x, "base64url")],
          [-3, Buffer.from(jwk.y, "base64url")],
        ]),
      );
      const attested = Buffer.concat([
        Buffer.alloc(16),
        Buffer.from([0, credentialId.length]),
        credentialId,
        coseKey,
      ]);
      const attestationObject = cbor(
        new Map([
          ["fmt", "none"],
          ["attStmt", new Map()],
          ["authData", authData(0x45, attested)],
        ]),
      );
      return {
        id: credentialId.toString("base64url"),
        rawId: credentialId.toString("base64url"),
        type: "public-key",
        response: {
          clientDataJSON: clientData("webauthn.create", options.challenge).toString("base64url"),
          attestationObject: attestationObject.toString("base64url"),
          transports: ["internal"],
        },
        clientExtensionResults: {},
      };
    },
    get: (options) => {
      signCount += 1;
      const data = authData(0x05);
      const clientDataJSON = clientData("webauthn.get", options.challenge);
      const signature = NodeCrypto.sign(
        "sha256",
        Buffer.concat([data, sha256(clientDataJSON)]),
        privateKey,
      );
      return {
        id: credentialId.toString("base64url"),
        rawId: credentialId.toString("base64url"),
        type: "public-key",
        response: {
          clientDataJSON: clientDataJSON.toString("base64url"),
          authenticatorData: data.toString("base64url"),
          signature: signature.toString("base64url"),
          userHandle,
        },
        clientExtensionResults: {},
      };
    },
  };
};

const listen = (port, handler) =>
  new Promise((resolve, reject) => {
    const server = NodeHttp.createServer(handler);
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      started.servers.push(server);
      resolve(server);
    });
  });

/** Forwards to `targetPort`, keeping what `record` wants of each exchange. */
const recordingProxy = (port, targetPort, record) =>
  listen(port, (incoming, outgoing) => {
    const chunks = [];
    incoming.on("data", (chunk) => chunks.push(chunk));
    incoming.on("end", () => {
      const body = Buffer.concat(chunks);
      const headers = { ...incoming.headers };
      delete headers["accept-encoding"];
      const upstream = NodeHttp.request(
        {
          host: "127.0.0.1",
          port: targetPort,
          path: incoming.url,
          method: incoming.method,
          headers,
        },
        (response) => {
          const parts = [];
          response.on("data", (chunk) => parts.push(chunk));
          response.on("end", () => {
            const answer = Buffer.concat(parts);
            try {
              record(incoming, body.toString("utf8"), answer.toString("utf8"));
            } catch {
              // A record that cannot be read is no reason to break the exchange.
            }
            outgoing.writeHead(response.statusCode ?? 502, response.headers);
            outgoing.end(answer);
          });
        },
      );
      upstream.on("error", () => {
        outgoing.writeHead(502);
        outgoing.end();
      });
      upstream.end(body);
    });
  });

const podman = (args, options = {}) =>
  NodeChildProcess.execFileSync("podman", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });

const untilReady = async (what, check, attempts = 120) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await check().catch(() => false)) return;
    await wait(1_000);
  }
  throw new Error(`${what} never got ready`);
};

const startKeycloak = async () => {
  const envFile = NodePath.join(RUN, "keycloak.env");
  // The JVM's heap is capped too: without a cgroup limit Keycloak would size it from the host.
  NodeFS.writeFileSync(
    envFile,
    [
      "KC_BOOTSTRAP_ADMIN_USERNAME=admin",
      `KC_BOOTSTRAP_ADMIN_PASSWORD=${SECRETS.admin}`,
      "JAVA_OPTS_KC_HEAP=-Xms256m -Xmx640m -XX:MaxMetaspaceSize=256m",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  const run = (limits) =>
    podman([
      "run",
      "-d",
      "--name",
      KC_CONTAINER,
      ...limits,
      "--network",
      "host",
      "--env-file",
      envFile,
      KC_IMAGE,
      "start-dev",
      "--http-host=127.0.0.1",
      `--http-port=${KC_PORT}`,
      `--hostname=${KC}`,
      "--http-management-port=18089",
    ]);
  started.container = true;
  let limit = "--memory 1g";
  try {
    run(["--memory", "1g"]);
  } catch (error) {
    // Rootless podman without a systemd user session (WSL) has no cgroup to put a limit in.
    if (!/cgroup/u.test(String(error?.stderr ?? error))) throw error;
    try {
      podman(["rm", "-f", KC_CONTAINER]);
    } catch {
      // Never created.
    }
    run(["--cgroups=disabled"]);
    limit = "no cgroup here: --cgroups=disabled, JVM heap capped at 640 MB";
  }
  NodeFS.rmSync(envFile);
  await untilReady(
    "Keycloak",
    async () => (await request(`${KC}/realms/master`)).status === 200,
    180,
  );
  return limit;
};

const startHub = async () => {
  const output = NodeFS.openSync(NodePath.join(RUN, "hub.log"), "a");
  const child = NodeChildProcess.spawn(process.execPath, ["src/bin.ts"], {
    cwd: NodePath.join(REPO, "apps/server"),
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      T3CODE_HOME: HUB_HOME,
      T3CODE_PORT: String(HUB_PORT),
      T3CODE_HOST: "127.0.0.1",
      T3CODE_MODE: "web",
      T3CODE_NO_BROWSER: "1",
      T3CODE_LOG_LEVEL: "Debug",
      T3CODE_OTLP_TRACES_URL: `http://127.0.0.1:${OTLP_PORT}/v1/traces`,
      T3CODE_OTLP_EXPORT_INTERVAL_MS: "1000",
    },
    stdio: ["ignore", output, output],
  });
  started.hub = child;
  await untilReady(
    "the Hub",
    async () => NodeFS.readFileSync(NodePath.join(RUN, "hub.log"), "utf8").includes("pairingUrl:"),
    180,
  );
  const line = NodeFS.readFileSync(NodePath.join(RUN, "hub.log"), "utf8")
    .split("\n")
    .find((candidate) => candidate.includes("pairingUrl:"));
  return new URLSearchParams(new URL(line.split("pairingUrl:")[1].trim()).hash.slice(1)).get(
    "token",
  );
};

const stopHub = async () => {
  const child = started.hub;
  if (child === undefined || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const done = await Promise.race([exited.then(() => true), wait(15_000).then(() => false)]);
  if (!done) child.kill("SIGKILL");
  await exited;
};

const cleanUp = async () => {
  await stopHub().catch(() => undefined);
  if (started.container) {
    try {
      podman(["stop", "-t", "5", KC_CONTAINER]);
    } catch {
      // Already stopped.
    }
    try {
      podman(["rm", "-f", KC_CONTAINER]);
    } catch {
      // Already gone.
    }
  }
  for (const server of started.servers) server.close();
  NodeFS.rmSync(RUN, { recursive: true, force: true });
  NodeFS.rmSync(HUB_HOME, { recursive: true, force: true });
};

const adminToken = async () => {
  const answer = await request(`${KC}/realms/master/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: "admin-cli",
      username: "admin",
      password: SECRETS.admin,
    }).toString(),
  });
  expect(answer.status === 200, `the admin token answered ${answer.status}`);
  return answer.json().access_token;
};

const admin = async (method, path, body) => {
  const answer = await request(`${KC}/admin/realms${path}`, {
    method,
    headers: {
      authorization: `Bearer ${await adminToken()}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (answer.status >= 400) {
    throw new Error(
      `admin ${method} ${path.replace(/[0-9a-f-]{36}/gu, ":id")}: ${answer.status} ${answer.text.slice(0, 160)}`,
    );
  }
  return answer.text === "" ? undefined : answer.json();
};

const executions = (flow) => admin("GET", `/hub/authentication/flows/${flow}/executions`);
const addExecution = async (flow, provider, requirement, config) => {
  await admin("POST", `/hub/authentication/flows/${flow}/executions/execution`, { provider });
  const all = await executions(flow);
  const added = all.filter((execution) => execution.providerId === provider).at(-1);
  await admin("PUT", `/hub/authentication/flows/${flow}/executions`, { ...added, requirement });
  if (config) {
    await admin("POST", `/hub/authentication/executions/${added.id}/config`, config);
  }
  return added;
};
const addSubflow = async (flow, alias, requirement) => {
  await admin("POST", `/hub/authentication/flows/${flow}/executions/flow`, {
    alias,
    type: "basic-flow",
    provider: "registration-page-form",
    description: alias,
  });
  const added = (await executions(flow)).find((execution) => execution.displayName === alias);
  await admin("PUT", `/hub/authentication/flows/${flow}/executions`, { ...added, requirement });
};

const people = {};
const createUser = async (realm, person, groups = []) => {
  await admin("POST", `/${realm}/users`, {
    username: person.username,
    email: person.email,
    firstName: person.firstName,
    lastName: person.lastName,
    enabled: true,
    emailVerified: true,
    groups,
    credentials: [{ type: "password", value: person.password, temporary: false }],
  });
  const [found] = await admin("GET", `/${realm}/users?exact=true&username=${person.username}`);
  person.keycloakId = found.id;
  return person;
};
const personNamed = (username) => ({
  username,
  email: `${username}@example.test`,
  firstName: username[0].toUpperCase() + username.slice(1),
  lastName: "Test",
  password: SECRETS.password(),
});

const buildRealms = async () => {
  // `upstream`: stands in for Google or GitHub, an OIDC provider the `hub` realm brokers.
  await admin("POST", "", { realm: "upstream", enabled: true, sslRequired: "none" });
  await admin("POST", "/upstream/clients", {
    clientId: "hub-broker",
    protocol: "openid-connect",
    publicClient: false,
    secret: SECRETS.broker,
    standardFlowEnabled: true,
    directAccessGrantsEnabled: false,
    redirectUris: [`${KC}/realms/hub/broker/upstream/endpoint`],
  });
  people.uma = await createUser("upstream", personNamed("uma"));

  // `hub`: open registration, the two groups, OTP for Admins, acr levels, the Hub's client.
  await admin("POST", "", {
    realm: "hub",
    enabled: true,
    sslRequired: "none",
    registrationAllowed: true,
    verifyEmail: false,
    attributes: { "acr.loa.map": JSON.stringify({ basico: 1, critica: 2 }) },
  });
  for (const name of ["bezenti", "bezenti-admin"]) await admin("POST", "/hub/groups", { name });
  await admin("POST", "/hub/roles", { name: "hub-admin" });
  const role = await admin("GET", "/hub/roles/hub-admin");
  const groups = await admin("GET", "/hub/groups");
  const adminGroup = groups.find((group) => group.name === "bezenti-admin");
  await admin("POST", `/hub/groups/${adminGroup.id}/role-mappings/realm`, [role]);

  // The browser flow: SSO cookie, or the forms: level 1 (password, acr `basico`), level 2 (OTP,
  // acr `critica`), and OTP whatever the level for anyone with `hub-admin` (bezenti-admin).
  await admin("POST", "/hub/authentication/flows", {
    alias: "hub-browser",
    providerId: "basic-flow",
    topLevel: true,
    builtIn: false,
    description: "kc11",
  });
  await addExecution("hub-browser", "auth-cookie", "ALTERNATIVE");
  await addSubflow("hub-browser", "hub-forms", "ALTERNATIVE");
  await addSubflow("hub-forms", "hub-level-1", "CONDITIONAL");
  await addExecution("hub-level-1", "conditional-level-of-authentication", "REQUIRED", {
    alias: "kc11-loa-1",
    config: { "loa-condition-level": "1", "loa-max-age": "36000" },
  });
  await addExecution("hub-level-1", "auth-username-password-form", "REQUIRED");
  await addSubflow("hub-forms", "hub-level-2", "CONDITIONAL");
  await addExecution("hub-level-2", "conditional-level-of-authentication", "REQUIRED", {
    alias: "kc11-loa-2",
    config: { "loa-condition-level": "2", "loa-max-age": "0" },
  });
  await addExecution("hub-level-2", "auth-otp-form", "REQUIRED");
  await addSubflow("hub-forms", "hub-admins", "CONDITIONAL");
  await addExecution("hub-admins", "conditional-user-role", "REQUIRED", {
    alias: "kc11-admins",
    config: { condUserRole: "hub-admin", negate: "false" },
  });
  await addExecution("hub-admins", "auth-otp-form", "REQUIRED");
  await admin("PUT", "/hub", { browserFlow: "hub-browser" });

  // The Hub's confidential client: PKCE, its three addresses, back-channel logout with `sid`.
  await admin("POST", "/hub/clients", {
    clientId: CLIENT_ID,
    protocol: "openid-connect",
    publicClient: false,
    secret: SECRETS.client,
    standardFlowEnabled: true,
    directAccessGrantsEnabled: false,
    frontchannelLogout: false,
    redirectUris: [`${HUB}/oauth/keycloak/callback`],
    attributes: {
      "pkce.code.challenge.method": "S256",
      "post.logout.redirect.uris": `${HUB}/sign-in`,
      "backchannel.logout.url": `http://127.0.0.1:${BACKCHANNEL_PROXY_PORT}/oauth/keycloak/backchannel-logout`,
      "backchannel.logout.session.required": "true",
      "backchannel.logout.revoke.offline.tokens": "false",
    },
  });
  const [client] = await admin("GET", `/hub/clients?clientId=${CLIENT_ID}`);
  await admin("POST", `/hub/clients/${client.id}/protocol-mappers/models`, {
    name: "groups",
    protocol: "openid-connect",
    protocolMapper: "oidc-group-membership-mapper",
    config: {
      "claim.name": "groups",
      "full.path": "false",
      "id.token.claim": "true",
      "access.token.claim": "true",
      "userinfo.token.claim": "true",
    },
  });
  let amr = "amr mapper added";
  await admin("POST", `/hub/clients/${client.id}/protocol-mappers/models`, {
    name: "amr",
    protocol: "openid-connect",
    protocolMapper: "oidc-amr-mapper",
    config: { "id.token.claim": "true", "access.token.claim": "true" },
  }).catch(() => {
    amr = "no amr mapper in this Keycloak";
  });

  // The broker: `upstream` as an OIDC identity provider of `hub`.
  const upstream = `${KC}/realms/upstream/protocol/openid-connect`;
  await admin("POST", "/hub/identity-provider/instances", {
    alias: "upstream",
    displayName: "Upstream",
    providerId: "oidc",
    enabled: true,
    trustEmail: true,
    config: {
      issuer: `${KC}/realms/upstream`,
      authorizationUrl: `${upstream}/auth`,
      tokenUrl: `${upstream}/token`,
      jwksUrl: `${upstream}/certs`,
      userInfoUrl: `${upstream}/userinfo`,
      logoutUrl: `${upstream}/logout`,
      clientId: "hub-broker",
      clientSecret: SECRETS.broker,
      clientAuthMethod: "client_secret_post",
      defaultScope: "openid profile email",
      validateSignature: "true",
      useJwksUrl: "true",
      pkceEnabled: "true",
      pkceMethod: "S256",
      syncMode: "IMPORT",
    },
  });
  return amr;
};

const needles = () =>
  [
    SECRETS.client,
    ...recorded.codes,
    ...recorded.tokens,
    ...recorded.verifiers,
    ...recorded.logoutTokens,
  ].filter((value) => value.length >= 16);

const holding = (bytes, values) =>
  values.filter((value) => bytes.includes(Buffer.from(value))).length;

const filesUnder = (root, skip) => {
  const found = [];
  const walk = (directory) => {
    for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
      const full = NodePath.join(directory, entry.name);
      if (skip(full, entry)) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) found.push(full);
    }
  };
  walk(root);
  return found;
};

const descendantsOf = (pid) => {
  const all = NodeFS.readdirSync("/proc").filter((name) => /^\d+$/u.test(name));
  const parents = new Map();
  for (const candidate of all) {
    try {
      const stat = NodeFS.readFileSync(`/proc/${candidate}/stat`, "utf8");
      parents.set(candidate, stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    } catch {
      // Gone meanwhile.
    }
  }
  const found = [String(pid)];
  for (let index = 0; index < found.length; index += 1) {
    for (const [child, parent] of parents) if (parent === found[index]) found.push(child);
  }
  return found;
};

const stateDatabase = () =>
  filesUnder(HUB_HOME, () => false).find((file) => file.endsWith("statev2.sqlite"));

/** Ages a User's Keycloak sign-ins two hours, so their next use re-checks (deviation A5). */
const ageSignIns = (userId) => {
  const database = new NodeSqlite.DatabaseSync(stateDatabase());
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    const statement = database.prepare(
      "UPDATE identity_logins SET checked_at = ? WHERE user_id = ? AND ended_at IS NULL",
    );
    return statement.run(new Date(Date.now() - 2 * 3_600_000).toISOString(), userId).changes;
  } finally {
    database.close();
  }
};

/** A socket on the session `jar` holds, and a promise of its close. */
const openSocket = async (jar) => {
  const ticket = await hub(jar, "/api/auth/websocket-ticket", { json: {} });
  expect(ticket.status === 200, `the socket ticket answered ${ticket.status}`);
  const socket = new WebSocket(
    `ws://127.0.0.1:${HUB_PORT}/ws?orchestrationProtocol=3&wsTicket=${encodeURIComponent(ticket.json().ticket)}`,
  );
  const closed = new Promise((resolve) => socket.addEventListener("close", () => resolve(true)));
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve);
    socket.addEventListener("error", () => reject(new Error("the socket did not open")));
    setTimeout(() => reject(new Error("the socket neither opened nor failed in 10 s")), 10_000);
  });
  // Still open a moment later: the Hub took it.
  expect(
    !(await Promise.race([closed, wait(1_500).then(() => false)])),
    "the socket closed at once",
  );
  // Wrapped: an async function returning the promise itself would wait for the close.
  return { closed };
};

const closesWithin = (closed, ms) => Promise.race([closed, wait(ms).then(() => false)]);

const main = async () => {
  // Proxies and the collector first: Keycloak's --hostname is the recording proxy.
  await recordingProxy(KC_PROXY_PORT, KC_PORT, (incoming, body, answer) => {
    if (incoming.url?.startsWith("/realms/hub/protocol/openid-connect/token") !== true) return;
    const form = new URLSearchParams(body);
    for (const name of ["code", "refresh_token"]) {
      const value = form.get(name);
      if (value) (name === "code" ? recorded.codes : recorded.tokens).add(value);
    }
    if (form.get("code_verifier")) recorded.verifiers.add(form.get("code_verifier"));
    const json = JSON.parse(answer);
    for (const name of ["id_token", "refresh_token", "access_token"]) {
      if (typeof json[name] === "string") recorded.tokens.add(json[name]);
    }
  });
  await recordingProxy(BACKCHANNEL_PROXY_PORT, HUB_PORT, (_incoming, body) => {
    const token = new URLSearchParams(body).get("logout_token");
    if (token) recorded.logoutTokens.add(token);
  });
  await listen(OTLP_PORT, (incoming, outgoing) => {
    const chunks = [];
    incoming.on("data", (chunk) => chunks.push(chunk));
    incoming.on("end", () => {
      otlpBodies.push(Buffer.concat(chunks));
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end("{}");
    });
  });

  await step("Keycloak container (start-dev, 1 GB, loopback only)", async () => {
    const limit = await startKeycloak();
    return `${KC_IMAGE}, ${limit}`;
  });
  await step("realms built by the admin REST API", buildRealms);

  let pairingToken;
  await step("Hub server alone on a throwaway home", async () => {
    pairingToken = await startHub();
    expect(pairingToken, "no startup pairing token");
    return `port ${HUB_PORT}`;
  });

  const passkey = makePasskey();
  let recoveryCodes = [];
  let bezenti;
  await step("Owner bootstrap with a passkey, and Keycloak configured and checked", async () => {
    const status = await owner("/api/auth/owner/status", { json: { credential: pairingToken } });
    expect(status.json().status === "available", "no Owner slot");
    const ceremony = (
      await owner("/api/auth/owner/registration", {
        json: { credential: pairingToken, displayName: "Owner" },
      })
    ).json();
    const created = await owner("/api/auth/owner", {
      json: {
        credential: pairingToken,
        ceremonyId: ceremony.ceremonyId,
        response: passkey.create(ceremony.options),
      },
    });
    expect(created.status === 200, `owner bootstrap answered ${created.status}`);
    recoveryCodes = created.json().recoveryCodes;
    bezenti = (await owner("/api/spaces/organizations", { json: { name: "Bezenti" } })).json().id;
    const saved = await owner("/api/installation/sign-in-settings", {
      json: {
        keycloakEnabled: true,
        issuer: ISSUER,
        clientId: CLIENT_ID,
        clientSecret: SECRETS.client,
        strongAcr: ["critica"],
        strongAmr: ["otp"],
        registrationMode: "open",
        groupMappings: [
          { group: "bezenti", spaceId: bezenti, role: "member" },
          { group: "bezenti-admin", spaceId: bezenti, role: "admin" },
        ],
      },
    });
    expect(saved.status === 200, `settings answered ${saved.status}`);
    const check = await owner("/api/installation/sign-in-settings/check", { json: {} });
    const result = check.json();
    expect(
      result._tag === "ok" || result.result?._tag === "ok",
      `Check: ${JSON.stringify(result).slice(0, 200)}`,
    );
    return `Check ok, ${result.signingKeys ?? result.result?.signingKeys} signing key(s)`;
  });

  const setMode = async (registrationMode) => {
    const saved = await owner("/api/installation/sign-in-settings", { json: { registrationMode } });
    expect(saved.status === 200, `mode ${registrationMode} answered ${saved.status}`);
  };
  const userCount = async () => (await owner("/api/installation/users")).json().users?.length;

  const alice = { ...personNamed("alice"), register: true, jar: new Jar() };
  await step("open registration: a newcomer signs up at Keycloak and gets a User", async () => {
    const before = await userCount();
    const { location } = await keycloakRound(alice.jar, alice);
    const session = await sessionOf(alice.jar);
    expect(session.authenticated === true, `landed on ${location.pathname}${location.search}`);
    alice.userId = session.userId;
    expect((await userCount()) === before + 1, "no new User");
    const audit = (await owner("/api/installation/audit?action=user.register")).json();
    return `User created, ${audit.entries?.length} user.register entr(y/ies)`;
  });

  await step("closed registration: a newcomer is refused, no User made", async () => {
    await setMode("closed");
    const carol = { ...personNamed("carol"), register: true };
    const before = await userCount();
    const jar = new Jar();
    const { location } = await keycloakRound(jar, carol);
    expect((await sessionOf(jar)).authenticated !== true, "signed in while closed");
    expect((await userCount()) === before, "a User was made");
    return `landed on ${location.pathname}${location.search}`;
  });

  await step("Platform invitation: accepted by signing up at Keycloak while closed", async () => {
    const created = (await owner("/api/installation/invitations", { json: {} })).json();
    const dave = { ...personNamed("dave"), register: true, jar: new Jar() };
    await keycloakRound(dave.jar, dave, { intent: "invitation", invitationToken: created.token });
    expect((await sessionOf(dave.jar)).authenticated === true, "not signed in");
    // The list keeps pending ones only: a spent one is gone from it.
    const listed = (await owner("/api/installation/invitations")).json();
    const pending = (listed.invitations ?? []).some(
      (invitation) => invitation.id === created.invitation.id,
    );
    expect(!pending, "the invitation is still pending");
    people.dave = dave;
    return "User created, the invitation spent";
  });

  await step(
    "broker (deviation: an OIDC realm stands in for Google/GitHub): open mode",
    async () => {
      await setMode("open");
      const viaBroker = { ...personNamed("uma"), broker: people.uma, jar: new Jar() };
      await keycloakRound(viaBroker.jar, viaBroker);
      expect((await sessionOf(viaBroker.jar)).authenticated === true, "not signed in");
      return "User created through the upstream provider";
    },
  );

  const erin = { ...personNamed("erin"), jar: new Jar() };
  await step("group `bezenti`: a first sign-in makes a managed Member of Bezenti", async () => {
    await createUser("hub", erin, ["/bezenti"]);
    await keycloakRound(erin.jar, erin);
    const session = await sessionOf(erin.jar);
    expect(session.authenticated === true, "not signed in");
    erin.userId = session.userId;
    const members = (await owner(`/api/spaces/${bezenti}/members`)).json();
    const member = (members.members ?? []).find((candidate) => candidate.userId === erin.userId);
    expect(member?.role === "member", `role ${member?.role}`);
    return `Member${member?.managedByKeycloak ? ", managed by Keycloak" : ""}`;
  });

  const frank = { ...personNamed("frank"), jar: new Jar() };
  let acme;
  await step(
    "link a local User: password, then Keycloak; local sign-in refused after",
    async () => {
      acme = (await owner("/api/spaces/organizations", { json: { name: "Acme" } })).json().id;
      const invited = (
        await owner(`/api/spaces/${acme}/invitations`, { json: { role: "member" } })
      ).json();
      const localPassword = SECRETS.password();
      const accepted = await hub(frank.jar, "/api/invitations/accept", {
        json: {
          token: invited.token,
          method: "password",
          displayName: "Frank",
          loginName: "frank",
          password: localPassword,
        },
      });
      expect(accepted.status === 200, `accept answered ${accepted.status}`);
      const signedIn = await hub(frank.jar, "/api/auth/password/sign-in", {
        json: { loginName: "frank", password: localPassword },
      });
      expect(signedIn.status === 200, `password sign-in answered ${signedIn.status}`);
      frank.userId = (await sessionOf(frank.jar)).userId;
      await createUser("hub", frank);
      await keycloakRound(frank.jar, frank, {
        intent: "link",
        reauth: { method: "password", password: localPassword },
      });
      const account = (await hub(frank.jar, "/api/auth/account")).json();
      expect(account.identity?.username === "frank", "no linked identity on the account");
      const again = await hub(new Jar(), "/api/auth/password/sign-in", {
        json: { loginName: "frank", password: localPassword },
      });
      expect(again.status !== 200, "the old password still signs in");
      return `linked; the old password answers ${again.status}`;
    },
  );

  const gina = { ...personNamed("gina"), jar: new Jar() };
  await step(
    "Admin with OTP: `bezenti-admin` sets up OTP at Keycloak and gets in as Admin",
    async () => {
      await createUser("hub", gina, ["/bezenti-admin"]);
      let { location } = await keycloakRound(gina.jar, gina);
      let how = "first sign-in";
      if ((await sessionOf(gina.jar)).authenticated !== true) {
        // Not strong by `amr`: the page's «Retry with second factor» asks for acr `critica`.
        how = `refused first (${location.search}), then «retry with second factor»`;
        ({ location } = await keycloakRound(gina.jar, gina, {
          intent: "sign-in",
          strongFactor: true,
        }));
      }
      const session = await sessionOf(gina.jar);
      expect(session.authenticated === true, `landed on ${location.pathname}${location.search}`);
      gina.userId = session.userId;
      const members = (await owner(`/api/spaces/${bezenti}/members`)).json();
      const member = (members.members ?? []).find((candidate) => candidate.userId === gina.userId);
      expect(member?.role === "admin", `role ${member?.role}`);
      return `Admin, OTP set up at Keycloak; ${how}`;
    },
  );

  await step("Admin without OTP: refused, then in with «retry with second factor»", async () => {
    const promoted = await owner(`/api/spaces/${acme}/members/role`, {
      json: { userId: frank.userId, role: "admin" },
    });
    expect(promoted.status === 200, `promotion answered ${promoted.status}`);
    expect(
      (await sessionOf(frank.jar)).authenticated !== true,
      "the weak session survived the promotion",
    );
    const weak = await keycloakRound(frank.jar, frank);
    expect((await sessionOf(frank.jar)).authenticated !== true, "an Admin got in without OTP");
    const strong = await keycloakRound(frank.jar, frank, { intent: "sign-in", strongFactor: true });
    expect(
      new URL(strong.started.authorizationUrl).searchParams.get("acr_values") === "critica",
      "the retry asked for no second factor",
    );
    expect((await sessionOf(frank.jar)).authenticated === true, "not in after the second factor");
    return `refused (${weak.location.search}); in after OTP set up at Keycloak`;
  });

  const apps = {};
  await step(
    "desktop app at the protocol level: /app-sign-in through a Keycloak sign-in",
    async () => {
      // The desktop app listens on a loopback port and opens the system browser at /app-sign-in.
      const received = new Promise((resolve) => {
        apps.callback = resolve;
      });
      const loopback = await listen(0, (incoming, outgoing) => {
        apps.callback(`http://127.0.0.1:${loopback.address().port}${incoming.url}`);
        outgoing.end("ok");
      });
      const redirectUri = appSignInLoopbackRedirectUri(loopback.address().port);
      const verifier = random(32);
      const challenge = NodeCrypto.createHash("sha256").update(verifier).digest("base64url");
      const state = random(16);
      const page = new URL(
        appSignInPageUrl(HUB, {
          redirectUri,
          codeChallenge: challenge,
          state,
          clientLabel: "T3 Code desktop",
        }),
      );
      // The page's «Sign in with Keycloak» comes back to it; the system browser already has
      // Keycloak's SSO session, so Keycloak sends it straight back.
      const browser = erin.jar;
      const { location } = await keycloakRound(browser, erin, {
        intent: "sign-in",
        returnTo: `${page.pathname}${page.search}`,
      });
      expect(
        `${location.pathname}${location.search}` === `${page.pathname}${page.search}`,
        "did not come back to /app-sign-in",
      );
      const approved = await hub(browser, "/api/auth/app-sign-in/approve", {
        json: {
          redirectUri,
          codeChallenge: challenge,
          codeChallengeMethod: "S256",
          state,
          clientLabel: "T3 Code desktop",
        },
      });
      expect(approved.status === 200, `approve answered ${approved.status}`);
      await request(approved.json().redirectTo);
      const callback = readAppSignInCallback(await received, { redirectUri, state });
      expect(callback._tag === "code", `callback ${callback._tag}`);
      const token = await hub(new Jar(), "/api/auth/app-sign-in/token", {
        origin: false,
        form: {
          grant_type: "authorization_code",
          code: callback.code,
          code_verifier: verifier,
          redirect_uri: redirectUri,
          client_label: "T3 Code desktop",
          client_device_type: "desktop",
        },
      });
      expect(token.status === 200, `token answered ${token.status}`);
      apps.desktop = token.json().access_token;
      expect(
        (await sessionOf(new Jar(), apps.desktop)).authenticated === true,
        "the app token is not a session",
      );
      return "approved from the Keycloak browser session; the app's bearer works";
    },
  );

  await step(
    "mobile app at the protocol level: custom-scheme callback, account identity",
    async () => {
      const redirectUri = appSignInMobileRedirectUri("t3code");
      const verifier = random(32);
      const challenge = NodeCrypto.createHash("sha256").update(verifier).digest("base64url");
      const state = random(16);
      const approved = await hub(erin.jar, "/api/auth/app-sign-in/approve", {
        json: {
          redirectUri,
          codeChallenge: challenge,
          codeChallengeMethod: "S256",
          state,
          clientLabel: "T3 Code mobile",
        },
      });
      expect(approved.status === 200, `approve answered ${approved.status}`);
      // WebBrowser.openAuthSessionAsync hands the app this address instead of following it.
      const callback = readAppSignInCallback(approved.json().redirectTo, { redirectUri, state });
      expect(callback._tag === "code", `callback ${callback._tag}`);
      const token = await hub(new Jar(), "/api/auth/app-sign-in/token", {
        origin: false,
        form: {
          grant_type: "authorization_code",
          code: callback.code,
          code_verifier: verifier,
          redirect_uri: redirectUri,
          client_label: "T3 Code mobile",
          client_device_type: "mobile",
        },
      });
      expect(token.status === 200, `token answered ${token.status}`);
      apps.mobile = token.json().access_token;
      const account = (await hub(new Jar(), "/api/auth/account", { bearer: apps.mobile })).json();
      expect(account.identity?.username === "erin", "the app's account shows no Keycloak identity");
      return "bearer works; account shows the linked identity and the realm's account page";
    },
  );

  await step("MCP client approved from the Keycloak browser session", async () => {
    const redirect = "http://localhost:51234/callback";
    const registered = (
      await hub(new Jar(), "/oauth/mcp/register", {
        origin: false,
        json: {
          client_name: "kc11",
          redirect_uris: [redirect],
          grant_types: ["authorization_code"],
          token_endpoint_auth_method: "none",
        },
      })
    ).json();
    const verifier = random(32);
    const authorization = {
      response_type: "code",
      client_id: registered.client_id,
      redirect_uri: redirect,
      code_challenge: NodeCrypto.createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      state: random(16),
      resource: `${HUB}/mcp`,
    };
    const details = (await hub(erin.jar, "/oauth/mcp/approval", { json: authorization })).json();
    const decided = await hub(erin.jar, "/oauth/mcp/decision", {
      json: {
        authorization,
        decision: { _tag: "browser-session", access: "read-only", csrfToken: details.csrfToken },
      },
    });
    expect(decided.status === 200, `decision answered ${decided.status}`);
    const code = new URL(decided.json().redirectTo).searchParams.get("code");
    const token = await hub(new Jar(), "/oauth/mcp/token", {
      origin: false,
      form: {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirect,
        client_id: registered.client_id,
        code_verifier: verifier,
        resource: `${HUB}/mcp`,
      },
    });
    expect(token.status === 200, `token answered ${token.status}`);
    apps.mcp = token.json().access_token;
    return "MCP client token issued";
  });

  await step(
    "disabled in Keycloak: the next re-check ends the session, its socket and its apps",
    async () => {
      const { closed } = await openSocket(erin.jar);
      await admin("PUT", `/hub/users/${erin.keycloakId}`, { enabled: false });
      const aged = ageSignIns(erin.userId);
      expect(aged > 0, "no live sign-in to age");
      await hub(erin.jar, "/api/auth/session"); // one use: the re-check runs in the background
      expect(await closesWithin(closed, 20_000), "the socket stayed open");
      expect((await sessionOf(erin.jar)).authenticated !== true, "still signed in");
      expect(
        (await sessionOf(new Jar(), apps.desktop)).authenticated !== true,
        "the desktop app survived",
      );
      expect(
        (await sessionOf(new Jar(), apps.mobile)).authenticated !== true,
        "the mobile app survived",
      );
      return `${aged} sign-in(s) aged; session, socket, desktop and mobile apps ended`;
    },
  );

  await step("logout from the Keycloak admin console: back-channel closes the socket", async () => {
    const { closed } = await openSocket(gina.jar);
    // The console's user-level «Sign out» (users/{id}/logout) ends online sessions only. The Hub
    // asks for `offline_access`, so its sign-in lives on the offline session: nothing is sent.
    await admin("POST", `/hub/users/${gina.keycloakId}/logout`);
    const byUserLogout = await closesWithin(closed, 15_000);
    const tokensAfterUserLogout = recorded.logoutTokens.size;
    // The console's «Sign out» on the offline session row (Sessions tab): back-channel logout.
    const [client] = await admin("GET", `/hub/clients?clientId=${CLIENT_ID}`);
    const offline = await admin(
      "GET",
      `/hub/users/${gina.keycloakId}/offline-sessions/${client.id}`,
    );
    expect(offline.length > 0, "no offline session to sign out");
    for (const row of offline) await admin("DELETE", `/hub/sessions/${row.id}?isOffline=true`);
    expect(await closesWithin(closed, 20_000), "the socket stayed open");
    expect((await sessionOf(gina.jar)).authenticated !== true, "still signed in");
    expect(recorded.logoutTokens.size > tokensAfterUserLogout, "no logout token reached the Hub");
    return `user-level «Sign out»: socket closed ${byUserLogout}, ${tokensAfterUserLogout} logout token(s); offline session «Sign out»: ${recorded.logoutTokens.size - tokensAfterUserLogout} logout token(s), socket closed, session ended`;
  });

  await step(
    "«also sign out of Keycloak»: no token in the address, Keycloak's session ends, back to /sign-in",
    async () => {
      const signedOut = (await hub(alice.jar, "/api/auth/sign-out", { json: {} })).json();
      expect(typeof signedOut.keycloakSignOutHandle === "string", "no handle offered");
      const left = (
        await hub(alice.jar, "/api/auth/keycloak/sign-out", {
          json: { handle: signedOut.keycloakSignOutHandle },
        })
      ).json();
      const address = new URL(left.endSessionUrl);
      expect(!address.searchParams.has("id_token_hint"), "an ID token in the address");
      const hadSession = alice.jar.cookies.some(
        (cookie) =>
          cookie.host === `127.0.0.1:${KC_PROXY_PORT}` && cookie.name === "KEYCLOAK_IDENTITY",
      );
      let response = await request(address.href, { jar: alice.jar });
      const seen = [response.status];
      let confirmed = false;
      for (let turn = 0; turn < 5 && !(response.location ?? "").startsWith(HUB); turn += 1) {
        const form = formsOf(response.text).find((candidate) => /logout/u.test(candidate.action));
        if (response.status === 200 && form) {
          confirmed = true;
          response = await request(new URL(form.action, address).href, {
            method: "POST",
            jar: alice.jar,
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ ...form.inputs, confirmLogout: "Logout" }).toString(),
          });
        } else if (response.location) {
          response = await request(response.location, { jar: alice.jar });
        } else break;
        seen.push(response.status);
      }
      expect((response.location ?? "").startsWith(`${HUB}/sign-in`), `ended on ${response.status}`);
      // Keycloak's own session is gone: a new sign-in asks for the password again.
      const again = await hub(alice.jar, "/api/auth/keycloak/start", {
        json: { intent: "sign-in" },
      });
      const page = await request(again.json().authorizationUrl, { jar: alice.jar });
      expect(page.status === 200 && /kc-form-login/u.test(page.text), "Keycloak still signed in");
      return `${confirmed ? "Keycloak showed its confirm page" : "no confirm page"} (Keycloak session cookie before: ${hadSession}, answers ${seen.join(" > ")}); back on /sign-in, and Keycloak asks for the password again`;
    },
  );

  await step(
    "Keycloak stopped: the Owner gets in locally; a Keycloak session stays in",
    async () => {
      podman(["stop", "-t", "5", KC_CONTAINER]);
      const daveAged = ageSignIns((await sessionOf(people.dave.jar)).userId);
      await hub(people.dave.jar, "/api/auth/session");
      await wait(3_000);
      const daveIn = (await sessionOf(people.dave.jar)).authenticated === true;
      const status = (await owner("/api/installation/sign-in-settings")).json().keycloakStatus;
      const byCode = await hub(new Jar(), "/api/auth/recovery-code/sign-in", {
        json: { code: recoveryCodes[0] },
      });
      expect(byCode.status === 200, `recovery code answered ${byCode.status}`);
      const challenge = (await hub(new Jar(), "/api/auth/passkey/challenge", { json: {} })).json();
      const byPasskey = await hub(new Jar(), "/api/auth/passkey/sign-in", {
        json: { ceremonyId: challenge.ceremonyId, response: passkey.get(challenge.options) },
      });
      expect(byPasskey.status === 200, `passkey answered ${byPasskey.status}`);
      const start = await hub(new Jar(), "/api/auth/keycloak/start", {
        json: { intent: "sign-in" },
      });
      expect(daveIn, "a Keycloak session was signed out by the outage");
      return `recovery code and passkey 200; ${daveAged} aged Keycloak sign-in kept (unreachable since ${status?.unreachableSince ? "set" : "unset"}, problem ${status?.problem}); a new start answers ${start.status}`;
    },
  );

  await step("process sweep: the Hub's arguments and environment, and its children's", async () => {
    const swept = sweepProcesses();
    expect(typeof swept === "object", "the Hub is not running");
    expect(swept.hits === 0, `${swept.hits} hits`);
    return `${swept.pids} process(es), 0 hits`;
  });
  // Flush the Hub's spans, then sweep the rest.
  await stopHub();
  await step(
    "leak sweep: no Keycloak secret in the Hub's log, OTLP spans, process args or files",
    async () => {
      const values = needles();
      expect(values.length > 10, `only ${values.length} values recorded`);
      const logHits = holding(NodeFS.readFileSync(NodePath.join(RUN, "hub.log")), values);
      const otlpHits = otlpBodies.reduce((sum, body) => sum + holding(body, values), 0);
      const files = filesUnder(
        HUB_HOME,
        (full, entry) => entry.isDirectory() && entry.name === "secrets",
      );
      const fileHits = files.filter(
        (file) => holding(NodeFS.readFileSync(file), values) > 0,
      ).length;
      expect(
        logHits === 0 && otlpHits === 0 && fileHits === 0,
        `log ${logHits}, OTLP ${otlpHits}, files ${fileHits}`,
      );
      return `${values.length} values (client secret, ${recorded.codes.size} codes, ${recorded.tokens.size} tokens, ${recorded.verifiers.size} verifiers, ${recorded.logoutTokens.size} logout tokens) in 0 of: the log, ${otlpBodies.length} OTLP bodies, ${files.length} files`;
    },
  );
};

/** The Hub's processes, swept while it runs (its arguments and environment). */
const sweepProcesses = () => {
  const child = started.hub;
  if (child?.pid === undefined || child.exitCode !== null) return "not running";
  const values = needles();
  let hits = 0;
  const pids = descendantsOf(child.pid);
  for (const pid of pids) {
    for (const part of ["cmdline", "environ"]) {
      try {
        hits += holding(NodeFS.readFileSync(`/proc/${pid}/${part}`), values);
      } catch {
        // Gone meanwhile.
      }
    }
  }
  return { pids: pids.length, hits };
};

const exit = async (code) => {
  await cleanUp();
  const failed = results.filter((result) => !result.ok).length;
  log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(code ?? (failed === 0 ? 0 : 1));
};

process.on("SIGINT", () => void exit(130));
process.on("SIGTERM", () => void exit(143));
try {
  await main();
} catch (error) {
  note("run", false, error instanceof Error ? error.message : String(error));
}
await exit();
