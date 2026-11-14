// @effect-diagnostics nodeBuiltinImport:off -- builds fake CLIProxyAPI release archives on disk for the gateway's tests.
/**
 * A stand-in CLIProxyAPI for tests: a release archive whose `cli-proxy-api` is a shell script
 * running a small Node server that answers the management API and `/v1/models` like the real one.
 * Nothing is downloaded: tests hand the archives to the Hub through a fake `CliproxyReleases`.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

import { AiGatewayError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/http";

import * as AuditLog from "../audit/AuditLog.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import * as AiGateway from "./AiGateway.ts";
import type { CliproxyPlatform, PinnedCliproxyRelease } from "./cliproxyRelease.ts";
import { CliproxyReleases } from "./CliproxyReleases.ts";

/**
 * What the fake does: `serve`; `exit` at once (a release that never starts); `wide`, listening on
 * every address; `refuse`, serving but refusing every config change; `decoy`, leaving the port to another process that records what it is sent (as a
 * local process that took the port first would).
 */
export type FakeCliproxyMode = "serve" | "exit" | "wide" | "decoy" | "refuse";

/** A line a careless release might print: credentials by name and by shape. */
export const LEAKY_LINE =
  'token refresh {"refresh_token":"1//0gLeakyRefreshToken_abc-123","access_token":"ya29.a0Leaky_Access-Token123"} ' +
  "url=https://x.test/v1?key=AIzaSyLeaky_Google-Key1234567890&api_key=sk-ant-leaky_key_1234567890 " +
  "client_secret=GOCSPX-leaky_secret_123 github ghp_Leaky_Github_Token_1234567890";

const FAKE_SERVER =
  String.raw`
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
const configPath = process.argv[process.argv.indexOf("-config") + 1];
const text = fs.readFileSync(configPath, "utf8");
const port = Number(/^\s+port:\s*(\d+)/mu.exec(text)[1]);
const host = /^\s+host:\s*"?([^"\n]+)"?/mu.exec(text)[1];
const secret = /secret-key:\s*"?([^"\n]+)"?/u.exec(text)[1].trim();
const clientKey = /api-keys:\s*\n\s*-\s*"?([^"\n]+)"?/u.exec(text)[1].trim();
const version = process.env.FAKE_CLIPROXY_VERSION;
const mode = process.env.FAKE_CLIPROXY_MODE;
const dir = path.dirname(configPath);
fs.writeFileSync(path.join(dir, "fake-" + process.pid + ".json"), JSON.stringify({ argv: process.argv.slice(2), env: Object.keys(process.env), version }));
// Like a careless release: its own keys and tokens in its output, which the Hub must filter.
console.log("CLIProxyAPI Version: " + version + ", management key " + secret + ", client key " + clientKey);
console.log(${JSON.stringify(LEAKY_LINE)});
if (mode === "exit") process.exit(3);
if (mode === "decoy") {
  const decoy = childProcess.spawn(process.execPath, ["-e", ` +
  "`" +
  String.raw`
    const fs = require("node:fs");
    const seen = process.argv[2];
    require("node:http").createServer((request, response) => {
      fs.appendFileSync(seen, JSON.stringify({ url: request.url, authorization: request.headers.authorization ?? null }) + "\n");
      response.statusCode = 200;
      response.end("{}");
    }).listen(Number(process.argv[1]), "127.0.0.1");
  ` +
  "`" +
  String.raw`, String(port), path.join(dir, "decoy-seen.jsonl")], { stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "decoy-pid"), String(decoy.pid));
  process.on("SIGTERM", () => { decoy.kill("SIGKILL"); process.exit(0); });
  setInterval(() => {}, 1000);
} else {
  // The AI accounts' API keys, as the management API sets them (PATCH of the whole section),
  // and the models each prefix serves: an openai-compatibility entry's own, else a small catalog.
  let apiKeys = {};
  const CATALOG = { claude: ["claude-sonnet-5-5"], codex: ["gpt-5.5"], gemini: ["gemini-3-pro"], vertex: ["gemini-3-pro"], xai: ["grok-5"], meta: ["muse-spark-1.3"] };
  const modelIds = () => Object.entries(apiKeys).flatMap(([block, entries]) =>
    (Array.isArray(entries) ? entries : []).flatMap((entry) =>
      (block === "openai-compatibility" ? (entry.models ?? []).map((model) => model.alias ?? model.name) : CATALOG[block] ?? [])
        .map((model) => entry.prefix + "/" + model)));
  // Subscriptions (spec 4 ticket 03): sign-ins through the management API, and token files in
  // the auth-dir, as the real one keeps them (it reads the folder, so do we).
  const authDir = (/auth-dir:\s*"?([^"\n]+)"?/u.exec(text) || [])[1];
  const logins = new Map();
  const DEVICE = ["kimi", "xai", "meta"];
  const REDIRECT = { antigravity: "http://localhost:51121/oauth-callback", codex: "http://localhost:1455/auth/callback", claude: "http://localhost:54545/callback", devin: "http://127.0.0.1:" + port + "/callback" };
  const TOKEN_MODELS = { antigravity: ["gemini-3-pro", "claude-sonnet-5-5"], claude: ["claude-sonnet-5-5"], codex: ["gpt-5.5"], kimi: ["kimi-k2"], xai: ["grok-5"], devin: ["devin-1"], meta: ["muse-spark-1.3"], vertex: ["gemini-3-pro"] };
  const randomText = () => Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const emailNow = () => (fs.existsSync(path.join(dir, "fake-oauth-email")) ? fs.readFileSync(path.join(dir, "fake-oauth-email"), "utf8").trim() : "owner@example.com");
  const freshToken = (provider) => ({ type: provider, email: emailNow(), access_token: "fake-access-" + randomText(), refresh_token: "fake-refresh-" + randomText(), expired: new Date(Date.now() + 3600000).toISOString(), last_refresh: new Date().toISOString() });
  const writeToken = (name, token) => fs.writeFileSync(path.join(authDir, name), JSON.stringify(token), { mode: 0o600 });
  const tokenFiles = () => (authDir === undefined || !fs.existsSync(authDir) ? [] : fs.readdirSync(authDir).filter((name) => name.endsWith(".json")));
  const readToken = (name) => { try { return JSON.parse(fs.readFileSync(path.join(authDir, name), "utf8")); } catch { return {}; } };
  const credentialList = () => tokenFiles().map((name) => {
    const token = readToken(name);
    return { id: name, name, auth_index: name, provider: token.type, type: token.type, email: token.email, status: token.fake_status || "active", status_message: token.fake_status_message || "", requires_sign_in: token.fake_requires_sign_in === true, quota_blocked: token.fake_quota_blocked === true, unavailable: false, disabled: false, modtime: fs.statSync(path.join(authDir, name)).mtime.toISOString() };
  });
  const tokenModelIds = () => tokenFiles().flatMap((name) => {
    const token = readToken(name);
    return typeof token.prefix === "string" ? (TOKEN_MODELS[token.type] || []).map((model) => token.prefix + "/" + model) : [];
  });
  const readBody = (request) => new Promise((resolve) => { const chunks = []; request.on("data", (chunk) => chunks.push(chunk)); request.on("end", () => resolve(Buffer.concat(chunks))); });
  const send = (response, status, value) => { response.statusCode = status; response.setHeader("content-type", "application/json"); response.end(JSON.stringify(value)); };
  const seen = (what) => fs.appendFileSync(path.join(dir, "fake-oauth.jsonl"), JSON.stringify(what) + String.fromCharCode(10));
  const oauth = async (request, response, url) => {
    const route = url.pathname.slice("/v8/management".length);
    const name = url.searchParams.get("name");
    const safeName = name !== null && /^[A-Za-z0-9@._-]+$/u.test(name) ? name : null;
    if (route === "/oauth/auth-url" && request.method === "GET") {
      const provider = url.searchParams.get("provider");
      seen({ route, provider });
      if (fs.existsSync(path.join(dir, "fake-oauth-down"))) return send(response, 500, { error: "oauth down" });
      if (!DEVICE.includes(provider) && REDIRECT[provider] === undefined) return send(response, 404, { error: "provider_not_found" });
      const state = randomText();
      if (DEVICE.includes(provider)) {
        logins.set(state, { provider, status: "wait", device: true, polls: 0 });
        return send(response, 200, { status: "ok", flow: "device", state, url: "https://fake-provider.test/" + provider + "/device?user_code=FAKE-CODE", user_code: "FAKE-CODE", expires_in: 1800 });
      }
      logins.set(state, { provider, status: "wait", device: false, polls: 0 });
      return send(response, 200, { status: "ok", state, url: "https://fake-provider.test/" + provider + "/authorize?redirect_uri=" + encodeURIComponent(REDIRECT[provider]) + "&state=" + state });
    }
    if (route === "/oauth/callback" && request.method === "POST") {
      const body = JSON.parse((await readBody(request)).toString("utf8") || "{}");
      seen({ route, provider: body.provider, redirect_url: body.redirect_url });
      let back;
      try { back = new URL(body.redirect_url); } catch { return send(response, 400, { status: "error", error: "invalid redirect_url" }); }
      const login = logins.get(back.searchParams.get("state"));
      if (login === undefined || login.provider !== body.provider) return send(response, 404, { status: "error", error: "unknown or expired state" });
      if (back.searchParams.get("code") === "fake-good-code") {
        writeToken(login.provider + "-" + emailNow() + ".json", freshToken(login.provider));
        // Like two sign-ins landing at once: a second new file of the same provider.
        if (fs.existsSync(path.join(dir, "fake-oauth-twice"))) writeToken(login.provider + "-second@example.com.json", freshToken(login.provider));
        login.status = "ok";
      } else {
        login.status = "error";
      }
      return send(response, 200, { status: "ok" });
    }
    if (route === "/oauth/status" && request.method === "GET") {
      const login = logins.get(url.searchParams.get("state"));
      if (login === undefined) return send(response, 404, { status: "error", error: "unknown or expired state" });
      if (login.device && login.status === "wait") {
        login.polls += 1;
        if (fs.existsSync(path.join(dir, "fake-device-deny"))) login.status = "error";
        else if (fs.existsSync(path.join(dir, "fake-device-approve"))) {
          writeToken(login.provider + "-owner@example.com.json", freshToken(login.provider));
          login.status = "ok";
        }
      }
      return send(response, 200, login.status === "error" ? { status: "error", error: "Failed to exchange token" } : { status: login.status });
    }
    if (route === "/oauth/import" && request.method === "POST") {
      const raw = (await readBody(request)).toString("utf8");
      seen({ route, provider: url.searchParams.get("provider") });
      let account;
      try { account = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)); } catch { return send(response, 400, { error: "invalid service account" }); }
      if (account.type !== "service_account") return send(response, 400, { error: "invalid service account" });
      writeToken("vertex-" + account.project_id + ".json", { type: "vertex", project_id: account.project_id, email: account.client_email, location: "us-central1", service_account: account });
      return send(response, 200, { status: "ok" });
    }
    if (route === "/credentials" && request.method === "GET") {
      if (fs.existsSync(path.join(dir, "fake-credentials-down"))) return send(response, 503, { error: "down" });
      return send(response, 200, { files: credentialList() });
    }
    if (route === "/credentials/download" && request.method === "GET") {
      if (safeName === null || !fs.existsSync(path.join(authDir, safeName))) return send(response, 404, { error: "file not found" });
      response.statusCode = 200;
      response.end(fs.readFileSync(path.join(authDir, safeName)));
      return;
    }
    if (route === "/credentials" && request.method === "POST") {
      const body = await readBody(request);
      if (safeName === null) return send(response, 400, { error: "invalid name" });
      fs.writeFileSync(path.join(authDir, safeName), body, { mode: 0o600 });
      seen({ route, method: "POST", name: safeName });
      return send(response, 200, { status: "ok" });
    }
    if (route === "/credentials" && request.method === "DELETE") {
      if (safeName === null || !fs.existsSync(path.join(authDir, safeName))) return send(response, 404, { error: "auth file not found" });
      fs.unlinkSync(path.join(authDir, safeName));
      seen({ route, method: "DELETE", name: safeName });
      return send(response, 200, { status: "ok" });
    }
    // A refresh as CLIProxyAPI does it: a new access token, and a rotated refresh token.
    if (route === "/fake/refresh" && request.method === "POST") {
      if (safeName === null || !fs.existsSync(path.join(authDir, safeName))) return send(response, 404, { error: "auth file not found" });
      const token = readToken(safeName);
      const later = Date.parse(token.expired || "") || Date.now();
      Object.assign(token, { access_token: "fake-access-" + randomText(), refresh_token: "fake-refresh-" + randomText(), expired: new Date(later + 3600000).toISOString(), last_refresh: new Date().toISOString() });
      writeToken(safeName, token);
      return send(response, 200, { refresh_token: token.refresh_token, access_token: token.access_token });
    }
    if (route === "/requests/api-call" && request.method === "POST") {
      const body = JSON.parse((await readBody(request)).toString("utf8") || "{}");
      const token = safeName === null ? readToken(String(body.auth_index)) : {};
      const reset = new Date(Date.now() + 3600000).toISOString();
      if (token.type === "claude" && String(body.url).includes("/api/oauth/usage")) {
        return send(response, 200, { status_code: 200, body: JSON.stringify({ five_hour: { utilization: 42, resets_at: reset }, seven_day: { utilization: 7, resets_at: reset } }) });
      }
      if (token.type === "codex" && String(body.url).endsWith("/usage")) {
        return send(response, 200, { status_code: 200, body: JSON.stringify({ plan_type: "plus", rate_limit: { primary_window: { used_percent: 30, reset_at: Math.floor(Date.now() / 1000) + 3600, limit_window_seconds: 18000 } } }) });
      }
      return send(response, 200, { status_code: 404, body: "" });
    }
    return send(response, 404, { error: "not found" });
  };
  const invalid = (patch) => {
    for (const [block, entries] of Object.entries(patch["api-keys"] ?? {})) {
      if (!Array.isArray(entries)) return "api-keys." + block + " must be a list";
      for (const [index, entry] of entries.entries()) {
        if (!Array.isArray(entry.keys)) return "api-keys." + block + "[" + index + "].keys must be a list";
        if (entry.keys.some((key) => typeof key["api-key"] !== "string")) return "api-keys." + block + "[" + index + "] key";
        // Like a provider CLIProxyAPI cannot use, quoting what it was sent.
        if (String(entry["base-url"] ?? "").includes("refuse.invalid")) return "api-keys." + block + "[" + index + "] cannot use base-url with key ` +
  "`" +
  String.raw`" + entry.keys[0]["api-key"] + "` +
  "`" +
  String.raw`";
      }
    }
    return undefined;
  };
  http.createServer((request, response) => {
    const auth = request.headers.authorization ?? "";
    response.setHeader("X-CPA-VERSION", version);
    if (request.url === "/v8/management/config") {
      if (auth !== "Bearer " + secret) {
        response.statusCode = 401;
        response.end(JSON.stringify({ error: "missing management key" }));
        return;
      }
      if (request.method === "PATCH") {
        let body = "";
        request.on("data", (chunk) => { body += chunk; });
        request.on("end", () => {
          const patch = JSON.parse(body);
          fs.appendFileSync(path.join(dir, "fake-patches.log"), "patch" + String.fromCharCode(10));
          const problem = invalid(patch);
          // A file fake-refuse-all beside the config: refuses every change from now on, like a broken release.
          if (problem !== undefined || mode === "refuse" || fs.existsSync(path.join(dir, "fake-refuse-all"))) {
            response.statusCode = 422;
            response.end(JSON.stringify({ error: "invalid_config", message: problem ?? "refused" }));
            return;
          }
          apiKeys = { ...apiKeys, ...(patch["api-keys"] ?? {}) };
          fs.writeFileSync(path.join(dir, "fake-api-keys-" + process.pid + ".json"), JSON.stringify(apiKeys));
          response.statusCode = 200;
          response.end(JSON.stringify({ "config-version": 8, status: "ok" }));
        });
        return;
      }
      response.statusCode = 200;
      response.end(JSON.stringify({ "config-version": 8, "api-keys": apiKeys }));
      return;
    }
    if (request.url === "/v1/models") {
      response.statusCode = fs.existsSync(path.join(dir, "fake-models-down")) ? 503 : auth === "Bearer " + clientKey ? 200 : 401;
      response.end(JSON.stringify({ data: response.statusCode === 200 ? [...modelIds(), ...tokenModelIds()].map((id) => ({ id, object: "model" })) : [] }));
      return;
    }
    // The AI API the Hub's gateway layer proxies (spec 4 ticket 04), with force-model-prefix:
    // only acct-<id>/<model> of a provisioned account is served. Files beside the config steer
    // it: fake-quota-<id> (429 quoting an email and a key), fake-error-<id> (400 quoting them),
    // fake-stream-hold (a stream waits for fake-stream-release after its first event),
    // fake-stream-error (an error event quoting them mid-stream).
    const aiUrl = new URL(request.url, "http://fake.invalid");
    const geminiCall = /^\/v1beta\/models\/(.+):(generateContent|streamGenerateContent)$/u.exec(aiUrl.pathname);
    const AI_PATHS = ["/v1/chat/completions", "/v1/responses", "/v1/messages", "/v1/messages/count_tokens"];
    if (request.method === "POST" && (AI_PATHS.includes(aiUrl.pathname) || geminiCall !== null)) {
      readBody(request).then(async (raw) => {
        let body = {};
        try { body = JSON.parse(raw.toString("utf8") || "{}"); } catch { body = {}; }
        const model = geminiCall !== null ? decodeURIComponent(geminiCall[1]) : String(body.model ?? "");
        const authOk = auth === "Bearer " + clientKey;
        fs.appendFileSync(path.join(dir, "fake-ai-requests.jsonl"), JSON.stringify({ path: aiUrl.pathname, search: aiUrl.search, model, authOk, headerNames: Object.keys(request.headers).sort(), bodyKeys: Object.keys(body).sort(), roles: (Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : []).map((item) => item && item.role).filter((role) => typeof role === "string") }) + String.fromCharCode(10));
        if (!authOk) return send(response, 401, { error: { message: "Missing API key" } });
        if (![...modelIds(), ...tokenModelIds()].includes(model)) return send(response, 400, { error: { message: "unknown provider for model " + model } });
        const accountId = model.slice("acct-".length, model.indexOf("/"));
        response.setHeader("X-Fake-Account", accountId);
        response.setHeader("Set-Cookie", "fake=1");
        if (fs.existsSync(path.join(dir, "fake-hang"))) await new Promise((resolve) => { const t = setTimeout(resolve, 30000); response.once("close", () => { clearTimeout(t); resolve(); }); });
        if (response.destroyed) return;
        if (fs.existsSync(path.join(dir, "fake-quota-" + accountId))) return send(response, 429, { error: { message: "Quota exceeded for owner@example.com with sk-ant-leaky_key_1234567890", type: "rate_limit_error" } });
        if (fs.existsSync(path.join(dir, "fake-redirect-" + accountId))) { response.statusCode = 302; response.setHeader("location", "https://provider.test/owner@example.com"); response.end(); return; }
        if (fs.existsSync(path.join(dir, "fake-error-" + accountId))) return send(response, 400, { error: { message: "Bad request for owner@example.com on " + model + " with sk-ant-leaky_key_1234567890 see https://provider.test/x?key=AIzaSyLeaky_Google-Key1234567890" } });
        const text = "Hello from " + model;
        const route = geminiCall !== null ? "gemini" : aiUrl.pathname;
        const stream = body.stream === true || (geminiCall !== null && geminiCall[2] === "streamGenerateContent");
        // Gemini's stream without alt=sse: one JSON array, an element at a time.
        if (geminiCall !== null && stream && aiUrl.searchParams.get("alt") !== "sse") {
          response.statusCode = 200;
          response.setHeader("content-type", "application/json");
          response.write("[" + JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "Hello " }] } }], modelVersion: model, usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 1 } }));
          if (fs.existsSync(path.join(dir, "fake-stream-error"))) response.write(",\r\n" + JSON.stringify({ error: { code: 500, message: "upstream failure for owner@example.com token sk-ant-leaky_key_1234567890", status: "INTERNAL" } }));
          response.write(",\r\n" + JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }], modelVersion: model, usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7 } }) + "]");
          response.end();
          return;
        }
        // A plain answer over 1 MiB, its tokens at the end.
        if (!stream && fs.existsSync(path.join(dir, "fake-big-json"))) {
          return send(response, 200, { id: "chat_1", object: "chat.completion", model, choices: [{ index: 0, message: { role: "assistant", content: text + " " + "x".repeat(1536 * 1024) }, finish_reason: "stop" }], usage: { prompt_tokens: 11, completion_tokens: 7 } });
        }
        if (!stream) {
          if (route === "/v1/messages/count_tokens") return send(response, 200, { input_tokens: 11 });
          if (route === "/v1/messages") return send(response, 200, { id: "msg_1", type: "message", role: "assistant", model, content: [{ type: "text", text }], usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 3 } });
          if (route === "/v1/responses") return send(response, 200, { id: "resp_1", object: "response", model, output: [{ type: "message", content: [{ type: "output_text", text }] }], usage: { input_tokens: 11, output_tokens: 7 } });
          if (route === "gemini") return send(response, 200, { candidates: [{ content: { role: "model", parts: [{ text }] } }], modelVersion: model, usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7 } });
          return send(response, 200, { id: "chat_1", object: "chat.completion", model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 11, completion_tokens: 7 } });
        }
        response.statusCode = 200;
        response.setHeader("content-type", "text/event-stream");
        const event = (value, name) => response.write((name === undefined ? "" : "event: " + name + String.fromCharCode(10)) + "data: " + JSON.stringify(value) + String.fromCharCode(10, 10));
        const first = route === "/v1/messages"
          ? [{ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model, content: [], usage: { input_tokens: 11, output_tokens: 1 } } }, "message_start"]
          : route === "gemini"
            ? [{ candidates: [{ content: { role: "model", parts: [{ text: "Hello " }] } }], modelVersion: model }]
            : route === "/v1/responses"
              ? [{ type: "response.created", response: { id: "resp_1", model } }, "response.created"]
              : [{ id: "chat_1", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { role: "assistant", content: "Hello " } }] }];
        event(first[0], first[1]);
        if (fs.existsSync(path.join(dir, "fake-stream-big"))) {
          const filler = "y".repeat(16 * 1024);
          for (let index = 0; index < 4096 && !response.destroyed; index += 1) {
            if (!response.write("data: " + JSON.stringify({ id: "chat_1", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { content: filler } }] }) + String.fromCharCode(10, 10))) {
              await new Promise((resolve) => { response.once("drain", resolve); response.once("close", resolve); });
            }
          }
        }
        if (fs.existsSync(path.join(dir, "fake-stream-hold"))) {
          const until = Date.now() + 15000;
          while (!fs.existsSync(path.join(dir, "fake-stream-release")) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 25));
        }
        if (fs.existsSync(path.join(dir, "fake-stream-error"))) event({ type: "error", error: { type: "api_error", message: "upstream failure for owner@example.com token sk-ant-leaky_key_1234567890 on " + model, account: "owner@example.com" } }, "error");
        if (route === "/v1/messages") {
          event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }, "content_block_delta");
          event({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } }, "message_delta");
          event({ type: "message_stop" }, "message_stop");
        } else if (route === "gemini") {
          event({ candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }], modelVersion: model, usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7 } });
        } else if (route === "/v1/responses") {
          event({ type: "response.output_text.delta", delta: text }, "response.output_text.delta");
          event({ type: "response.completed", response: { id: "resp_1", model, usage: { input_tokens: 11, output_tokens: 7 } } }, "response.completed");
        } else {
          event({ id: "chat_1", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }] });
          // Like OpenAI: the usage chunk only for a client that asked for it.
          if (body.stream_options?.include_usage === true) event({ id: "chat_1", object: "chat.completion.chunk", model, choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } });
          response.write("data: [DONE]" + String.fromCharCode(10, 10));
        }
        response.end();
      }).catch(() => send(response, 500, { error: "fake failed" }));
      return;
    }
    if (request.url.startsWith("/v8/management/")) {
      if (auth !== "Bearer " + secret) {
        response.statusCode = 401;
        response.end(JSON.stringify({ error: "missing management key" }));
        return;
      }
      oauth(request, response, new URL(request.url, "http://fake.invalid")).catch(() => send(response, 500, { error: "fake failed" }));
      return;
    }
    fs.appendFileSync(path.join(dir, "fake-unknown.jsonl"), JSON.stringify({ method: request.method, url: request.url }) + String.fromCharCode(10));
    response.statusCode = 404;
    response.end();
  }).listen(port, mode === "wide" ? "0.0.0.0" : host);
}
`;

const tarHeader = (name: string, size: number, mode: number) => {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write(`${mode.toString(8).padStart(7, "0")}\0`, 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write(
    `${Math.floor(Date.UTC(2026, 0, 1) / 1000)
      .toString(8)
      .padStart(11, "0")}\0`,
    136,
    12,
    "ascii",
  );
  header.write("        ", 148, 8, "ascii");
  header.write("0", 156, 1, "ascii");
  header.write("ustar\u000000", 257, 8, "ascii");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
};

const tarOf = (files: ReadonlyArray<{ name: string; content: Buffer; mode: number }>) =>
  Buffer.concat([
    ...files.flatMap(({ name, content, mode }) => [
      tarHeader(name, content.length, mode),
      content,
      Buffer.alloc((512 - (content.length % 512)) % 512),
    ]),
    Buffer.alloc(1024),
  ]);

const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

export interface FakeRelease {
  readonly version: string;
  readonly archive: Uint8Array;
  readonly sha256: string;
}

/**
 * A release archive whose `cli-proxy-api` runs the fake server with this test's Node. The server
 * itself is written once into `dir`.
 */
export const fakeCliproxyRelease = (
  dir: string,
  version: string,
  mode: FakeCliproxyMode = "serve",
): FakeRelease => {
  const server = NodePath.join(dir, "fake-cliproxy.mjs");
  if (!NodeFS.existsSync(server)) NodeFS.writeFileSync(server, FAKE_SERVER);
  const script = Buffer.from(
    `#!/bin/sh\nFAKE_CLIPROXY_VERSION=${version} FAKE_CLIPROXY_MODE=${mode} exec "${process.execPath}" "${server}" "$@"\n`,
  );
  const archive = NodeZlib.gzipSync(
    tarOf([
      { name: "LICENSE", content: Buffer.from("MIT\n"), mode: 0o644 },
      { name: "cli-proxy-api", content: script, mode: 0o755 },
    ]),
  );
  return { version, archive, sha256: sha256(archive) };
};

/** The Hub's pins for these fake releases, the same hash on every platform. */
export const pinsOf = (releases: ReadonlyArray<FakeRelease>): Array<PinnedCliproxyRelease> =>
  releases.map((release) => ({
    version: release.version,
    sha256: {
      "linux-amd64": release.sha256,
      "linux-arm64": release.sha256,
      "darwin-amd64": release.sha256,
      "darwin-arm64": release.sha256,
    },
  }));

/**
 * GitHub as the tests see it: these archives (or, per version, other bytes in their place), and
 * a list of each download.
 */
export const fakeReleases = (input: {
  readonly releases: ReadonlyArray<FakeRelease>;
  readonly served?: Readonly<Record<string, Uint8Array>>;
}) => {
  const downloads: Array<string> = [];
  const service = CliproxyReleases.of({
    archive: (release: PinnedCliproxyRelease, _platform: CliproxyPlatform) =>
      Effect.suspend(() => {
        const found = input.releases.find((candidate) => candidate.version === release.version);
        if (found === undefined) {
          return Effect.fail(
            new AiGatewayError({ message: `Could not download CLIProxyAPI ${release.version}.` }),
          );
        }
        downloads.push(release.version);
        const bytes = input.served?.[release.version] ?? found.archive;
        return Effect.succeed({ bytes, sha256: sha256(bytes) });
      }),
  });
  return { service, downloads };
};

/** The encrypted store, in memory. */
export const memorySecretStore = () => {
  const entries = new Map<string, Uint8Array>();
  return {
    entries,
    service: ServerSecretStore.of({
      get: (name) => Effect.sync(() => Option.fromNullishOr(entries.get(name))),
      set: (name, value) => Effect.sync(() => void entries.set(name, value)),
      create: (name, value) => Effect.sync(() => void entries.set(name, value)),
      getOrCreateRandom: (name, bytes) =>
        Effect.sync(() => {
          const existing = entries.get(name);
          if (existing !== undefined) return existing;
          const created = new Uint8Array(NodeCrypto.randomBytes(bytes));
          entries.set(name, created);
          return created;
        }),
      remove: (name) => Effect.sync(() => void entries.delete(name)),
    }),
  };
};

/**
 * A gateway as a Hub runs it, over a fake release, in the caller's scope: for tests of what else
 * can reach it. Resolves with its loopback port once it answers.
 */
export const startFakeGateway = Effect.fn("AiGateway.testkit.startFakeGateway")(function* (input: {
  readonly dir: string;
  readonly os: NodeJS.Platform;
  readonly platform: CliproxyPlatform;
}) {
  const release = fakeCliproxyRelease(input.dir, "1.0.0");
  const stateDir = NodePath.join(input.dir, "state");
  NodeFS.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const gateway = yield* AiGateway.make({
    placement: { _tag: "forced", enabled: true },
    os: input.os,
    stateDir,
    platform: input.platform,
    pinned: pinsOf([release]),
    runtimeFolder: { directory: NodePath.join(input.dir, "memory"), inMemory: true },
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(ServerSecretStore, memorySecretStore().service),
        Layer.succeed(CliproxyReleases, fakeReleases({ releases: [release] }).service),
        Layer.succeed(
          AuditLog.AuditLog,
          AuditLog.AuditLog.of({ record: () => Effect.void, list: () => Effect.die("not used") }),
        ),
        FetchHttpClient.layer,
      ),
    ),
  );
  const running = yield* gateway.changes.pipe(
    Stream.filter((status) => status.state === "running" || status.state === "failed"),
    Stream.runHead,
  );
  const endpoint = yield* gateway.endpoint;
  if (Option.isNone(running) || Option.isNone(endpoint)) {
    return yield* Effect.die(new Error("The fake AI gateway did not start."));
  }
  return Number(new URL(endpoint.value.baseUrl).port);
});
