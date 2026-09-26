"use strict";

const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { CredentialStore, defaultDataDir } = require("./credential-store");
const { SettingsStore, cleanConfig } = require("./settings-store");
const { prepareFiles, extractFiles } = require("./files");
const { scanFiles, scanTextResult } = require("./privacy");
const { analyzeWithQuality } = require("./analysis");
const {
  providerList,
  getProvider,
  effectiveConfig,
  dataBoundaryFor,
  testProvider,
} = require("./providers");
const { makeDefaultExtractors } = require("./external-tools");
const { longFetch } = require("./long-fetch");
const { JobManager } = require("./jobs");
const {
  HttpError,
  MAX_JSON_BYTES,
  asPlainText,
  isRecord,
  json,
  parseCookies,
  randomToken,
  readJson,
  redactSecrets,
  safeEqual,
} = require("./util");

const PRODUCT = "Siren AI";
const VERSION = "2.0.0";
const CSRF_COOKIE = "siren_ai_v2_csrf";
const CSRF_HEADER = "x-siren-csrf";
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_RESOLVED_PII_IDS = 5000;

function redactDetails(value, secrets, depth = 0) {
  if (depth > 12) return "[данные скрыты]";
  if (typeof value === "string") return redactSecrets(value, secrets);
  if (Array.isArray(value)) return value.slice(0, 1000).map((item) => redactDetails(item, secrets, depth + 1));
  if (!isRecord(value)) return value;
  const result = {};
  for (const [key, item] of Object.entries(value).slice(0, 1000)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) continue;
    result[key] = redactDetails(item, secrets, depth + 1);
  }
  return result;
}

function redactSuccessfulValue(value, secrets, depth = 0) {
  if (depth > 16) return "[данные скрыты]";
  if (typeof value === "string") {
    let safe = value;
    for (const secret of secrets || []) {
      if (typeof secret === "string" && secret) safe = safe.split(secret).join("[скрыто]");
    }
    return safe
      .replace(/(authorization|api[-_ ]?key|token|secret|credential)\s*[:=]\s*[^\s,;"}]+/gi, "$1: [скрыто]")
      .replace(/([?&](?:key|api_key|token|access_token)=)[^&\s"}]+/gi, "$1[скрыто]");
  }
  if (Array.isArray(value)) return value.map((item) => redactSuccessfulValue(item, secrets, depth + 1));
  if (!isRecord(value)) return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) continue;
    result[key] = redactSuccessfulValue(item, secrets, depth + 1);
  }
  return result;
}

const MIME = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
});

function setSecurityHeaders(response, isApi) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'");
  if (isApi) response.setHeader("Cache-Control", "no-store");
}

function hostParts(request) {
  const raw = String(request.headers.host || "");
  if (!raw || /[\r\n/@]/.test(raw)) return null;
  try {
    const url = new URL(`http://${raw}`);
    return { hostname: url.hostname.replace(/^\[|\]$/g, "").toLowerCase(), port: url.port ? Number(url.port) : 80 };
  } catch (_error) {
    return null;
  }
}

function validateInbound(request) {
  const host = hostParts(request);
  if (!host || !["127.0.0.1", "::1", "localhost"].includes(host.hostname)) {
    throw new HttpError(400, "INVALID_HOST", "Запрос отклонен: недопустимый Host.");
  }
  const localPort = Number(request.socket && request.socket.localPort);
  if (localPort && host.port !== localPort) throw new HttpError(400, "INVALID_HOST", "Запрос отклонен: порт Host не совпадает.");

  const originValue = request.headers.origin;
  if (originValue && originValue !== "null") {
    let origin;
    try {
      origin = new URL(String(originValue));
    } catch (_error) {
      throw new HttpError(403, "INVALID_ORIGIN", "Запрос отклонен: некорректный Origin.");
    }
    const originHost = origin.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const originPort = Number(origin.port || (origin.protocol === "http:" ? 80 : 443));
    if (origin.protocol !== "http:" || !["127.0.0.1", "::1", "localhost"].includes(originHost) || originPort !== host.port) {
      throw new HttpError(403, "INVALID_ORIGIN", "Запрос отклонен: доступ разрешен только локальному интерфейсу.");
    }
  }
}

function safeText(value, max = 500) {
  return asPlainText(value, max);
}

function sanitizeScreenshot(value) {
  const source = isRecord(value) ? value : {};
  return {
    id: safeText(source.id, 100),
    role: safeText(source.role, 30),
    name: safeText(source.name, 240),
    title: safeText(source.title, 500),
    caption: safeText(source.caption, 3000),
    width: Number.isFinite(Number(source.width)) ? Number(source.width) : 0,
    height: Number.isFinite(Number(source.height)) ? Number(source.height) : 0,
    layout: safeText(source.layout, 30),
  };
}

function sanitizeCurrentDraft(value) {
  const source = isRecord(value) ? value : {};
  const support = isRecord(source.support) ? source.support : {};
  return {
    schemaVersion: 4,
    title: safeText(source.title),
    releaseDate: safeText(source.releaseDate, 30),
    rolloutMode: safeText(source.rolloutMode, 3000),
    rolloutConditions: safeText(source.rolloutConditions, 10000),
    groups: (Array.isArray(source.groups) ? source.groups : []).slice(0, 100).map((rawGroup) => {
      const group = isRecord(rawGroup) ? rawGroup : {};
      return {
        id: safeText(group.id, 100),
        title: safeText(group.title),
        channels: (Array.isArray(group.channels) ? group.channels : []).slice(0, 10).map((item) => safeText(item, 30)),
        location: safeText(group.location, 3000),
        availability: safeText(group.availability, 3000),
        items: (Array.isArray(group.items) ? group.items : []).slice(0, 200).map((rawItem) => {
          const item = isRecord(rawItem) ? rawItem : {};
          return {
            id: safeText(item.id, 100),
            title: safeText(item.title),
            before: safeText(item.before, 10000),
            after: safeText(item.after, 10000),
            clientAction: safeText(item.clientAction, 10000),
            supportNote: safeText(item.supportNote, 10000),
          };
        }),
        screenshots: (Array.isArray(group.screenshots) ? group.screenshots : []).slice(0, 100).map(sanitizeScreenshot),
      };
    }),
    support: {
      say: safeText(support.say, 10000),
      dontSay: safeText(support.dontSay, 10000),
      details: safeText(support.details, 20000),
      faq: (Array.isArray(support.faq) ? support.faq : []).slice(0, 200).map((rawFaq) => {
        const faq = isRecord(rawFaq) ? rawFaq : {};
        return { id: safeText(faq.id, 100), question: safeText(faq.question, 3000), answer: safeText(faq.answer, 10000) };
      }),
    },
  };
}

function mergeFlatConfig(body) {
  const source = isRecord(body.config) ? body.config : body;
  return cleanConfig(source);
}

function validateProviderId(value) {
  const provider = getProvider(value);
  return provider.id;
}

async function serveStatic(request, response, staticRoot, pathname) {
  if (!["GET", "HEAD"].includes(request.method)) {
    response.setHeader("Allow", "GET, HEAD");
    throw new HttpError(405, "METHOD_NOT_ALLOWED", "Метод для этого адреса не поддерживается.");
  }
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch (_error) {
    throw new HttpError(400, "INVALID_PATH", "Некорректный путь запроса.");
  }
  if (decoded.includes("\0") || decoded.includes("\\") || decoded.split("/").some((segment) => segment.startsWith("."))) {
    throw new HttpError(404, "NOT_FOUND", "Файл не найден.");
  }
  let relative;
  if (decoded === "/" || decoded === "/index.html") relative = "index.html";
  else if (decoded === "/favicon.ico") relative = "favicon.ico";
  else if (decoded.startsWith("/web/") && decoded.length > 5) relative = decoded.slice(1);
  else throw new HttpError(404, "NOT_FOUND", "Файл не найден.");

  const root = path.resolve(staticRoot);
  const target = path.resolve(root, relative);
  const expectedPrefix = `${root}${path.sep}`.toLowerCase();
  if (!target.toLowerCase().startsWith(expectedPrefix)) throw new HttpError(404, "NOT_FOUND", "Файл не найден.");
  let realTarget;
  try {
    realTarget = await fs.realpath(target);
  } catch (_error) {
    throw new HttpError(404, "NOT_FOUND", "Файл не найден.");
  }
  if (!realTarget.toLowerCase().startsWith(expectedPrefix)) throw new HttpError(404, "NOT_FOUND", "Файл не найден.");
  const stat = await fs.stat(realTarget);
  if (!stat.isFile()) throw new HttpError(404, "NOT_FOUND", "Файл не найден.");
  const extension = path.extname(realTarget).toLowerCase();
  const mime = MIME[extension];
  if (!mime) throw new HttpError(404, "NOT_FOUND", "Файл не найден.");
  response.statusCode = 200;
  response.setHeader("Content-Type", mime);
  response.setHeader("Content-Length", String(stat.size));
  response.setHeader("Cache-Control", extension === ".html" ? "no-store" : "no-cache");
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  const content = await fs.readFile(realTarget);
  response.end(content);
}

function createHandler(options = {}) {
  const staticRoot = path.resolve(options.staticRoot || path.join(__dirname, ".."));
  const dataDir = path.resolve(options.dataDir || defaultDataDir());
  const lowerStatic = `${staticRoot}${path.sep}`.toLowerCase();
  if (`${dataDir}${path.sep}`.toLowerCase().startsWith(lowerStatic)) {
    throw new Error("Siren AI dataDir must be outside the static application root.");
  }
  const credentials = options.credentialStore || new CredentialStore({ dataDir, dpapi: options.dpapi });
  const settings = options.settingsStore || new SettingsStore({ dataDir });
  const fetchImpl = options.fetchImpl || longFetch;
  if (typeof fetchImpl !== "function") throw new Error("A Fetch-compatible implementation is required.");
  const extractors = options.extractors || makeDefaultExtractors({ appRoot: staticRoot });
  const instanceId = safeText(options.instanceId || process.env.SIREN_AI_INSTANCE_ID, 200);
  const sessions = new Map();
  const maxConcurrentAnalyses = Math.max(1, Math.min(8, Number(options.maxConcurrentAnalyses) || 2));
  let activeAnalyses = 0;
  const jobs = new JobManager({ ...options, dataDir, settings, credentials, extractors, fetchImpl, sanitizeDraft: sanitizeCurrentDraft });

  function issueCsrf(response) {
    const token = randomToken(32);
    sessions.set(token, Date.now() + SESSION_TTL_MS);
    for (const [key, expires] of sessions) if (expires < Date.now()) sessions.delete(key);
    response.setHeader("Set-Cookie", `${CSRF_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
    return token;
  }

  function requireCsrf(request) {
    const cookie = parseCookies(request.headers.cookie)[CSRF_COOKIE];
    const header = request.headers[CSRF_HEADER];
    const expires = sessions.get(String(cookie || ""));
    if (!cookie || !header || !expires || expires < Date.now() || !safeEqual(cookie, header)) {
      throw new HttpError(403, "CSRF_INVALID", "Сеанс устарел. Откройте окно AI заново.");
    }
  }

  async function settingsResponse(providerId) {
    const provider = getProvider(providerId);
    const saved = await settings.get(provider.id);
    const config = effectiveConfig(provider, saved);
    return {
      providerId: provider.id,
      config,
      hasCredential: await credentials.has(provider.id),
      remembered: await credentials.isRemembered(provider.id),
    };
  }

  async function handleApi(request, response, url) {
    if (request.method === "GET" && url.pathname === "/api/health") {
      const csrf = issueCsrf(response);
      json(response, 200, { ok: true, product: PRODUCT, version: VERSION, instanceId, csrf });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/providers") {
      json(response, 200, { providers: providerList() });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/settings") {
      const providerId = url.searchParams.get("providerId");
      if (providerId) json(response, 200, await settingsResponse(validateProviderId(providerId)));
      else {
        const entries = await Promise.all(providerList().map((provider) => settingsResponse(provider.id)));
        json(response, 200, { providers: Object.fromEntries(entries.map((item) => [item.providerId, { config: item.config, hasCredential: item.hasCredential, remembered: item.remembered }])) });
      }
      return;
    }

    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) requireCsrf(request);
    if (await jobs.route(request, response, url)) return;

    if (request.method === "POST" && url.pathname === "/api/settings") {
      const body = await readJson(request, 1024 * 1024);
      const provider = getProvider(body.providerId);
      const current = await settings.get(provider.id);
      const config = await settings.set(provider.id, { ...current, ...mergeFlatConfig(body) });
      const token = typeof body.token === "string" ? body.token : typeof body.credential === "string" ? body.credential : "";
      if (token) await credentials.set(provider.id, token, body.remember === true || body.rememberCredential === true);
      json(response, 200, { ok: true, providerId: provider.id, config: effectiveConfig(provider, config), hasCredential: await credentials.has(provider.id), remembered: await credentials.isRemembered(provider.id) });
      return;
    }
    if (request.method === "DELETE" && url.pathname === "/api/settings") {
      const providerId = validateProviderId(url.searchParams.get("providerId"));
      await credentials.delete(providerId);
      json(response, 200, { ok: true, providerId, hasCredential: false, remembered: false });
      return;
    }
    if (request.method === "DELETE" && url.pathname.startsWith("/api/credential/")) {
      const providerId = validateProviderId(decodeURIComponent(url.pathname.slice("/api/credential/".length)));
      await credentials.delete(providerId);
      json(response, 200, { ok: true, providerId, hasCredential: false, remembered: false });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/test-connection") {
      const body = await readJson(request, 1024 * 1024);
      const provider = getProvider(body.providerId);
      const saved = await settings.get(provider.id);
      const config = effectiveConfig(provider, { ...saved, ...mergeFlatConfig(body) });
      const transient = typeof body.token === "string" && body.token ? body.token.trim() : "";
      const credential = transient || await credentials.get(provider.id);
      const result = await testProvider({ provider, config, credential, fetchImpl, timeoutMs: Number(options.connectionTimeoutMs) || Number(config.requestTimeoutMinutes || 10) * 60000 });
      json(response, 200, result);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/analyze") {
      if (activeAnalyses >= maxConcurrentAnalyses) {
        throw new HttpError(429, "ANALYSIS_BUSY", "Уже выполняется несколько анализов. Дождитесь их завершения и повторите попытку.");
      }
      activeAnalyses += 1;
      const analysisController = new AbortController();
      const abortAnalysis = () => analysisController.abort();
      const abortOnClosedResponse = () => {
        if (!response.writableEnded) analysisController.abort();
      };
      request.once("aborted", abortAnalysis);
      response.once("close", abortOnClosedResponse);
      if (request.aborted || response.destroyed) analysisController.abort();
      try {
        const body = await readJson(request, options.maxJsonBytes || MAX_JSON_BYTES);
      const provider = getProvider(body.providerId);
      const config = effectiveConfig(provider, await settings.get(provider.id));
      const boundary = dataBoundaryFor(provider, config);
      const requestedResolvedPiiIds = Array.isArray(body.resolvedPiiIds) ? body.resolvedPiiIds : [];
      if (requestedResolvedPiiIds.length > MAX_RESOLVED_PII_IDS) {
        throw new HttpError(413, "TOO_MANY_PII_RESOLUTIONS", `Можно подтвердить не более ${MAX_RESOLVED_PII_IDS} результатов проверки за один запрос.`);
      }
      const prepared = prepareFiles(body.files);
      const extracted = await extractFiles(prepared, extractors);
      const currentDraft = sanitizeCurrentDraft(body.currentDraft);
      const resolvedPiiIds = new Set(requestedResolvedPiiIds
        .map((value) => safeText(value, 100))
        .filter(Boolean));
      const privacy = scanFiles(extracted, [...resolvedPiiIds]);
      const draftScan = scanTextResult("current-draft", "content", JSON.stringify(currentDraft));
      const draftFindings = draftScan.findings;
      const unresolvedDraftFindings = draftFindings.filter((finding) => !resolvedPiiIds.has(finding.id));
      privacy.detected += draftFindings.length;
      privacy.resolved += draftFindings.length - unresolvedDraftFindings.length;
      privacy.findings.push(...unresolvedDraftFindings);
      if (draftScan.truncated) {
        privacy.incomplete.push({
          id: "current-draft-scan-limit",
          type: "scan_incomplete",
          label: "Слишком много признаков персональных данных",
          sourceId: "current-draft",
          name: "Текущий черновик",
          reason: "В текущем черновике слишком много признаков персональных данных для полной автоматической проверки.",
          blocking: true,
        });
      }

      if (boundary === "public") {
        const privacyOverrideConfirmed = body.privacyOverrideConfirmed === true;
        if (privacy.findings.length && !privacyOverrideConfirmed) {
          throw new HttpError(422, "PERSONAL_DATA_BLOCKED", "Обнаружены возможные персональные данные. Просмотрите предупреждения: материалы можно исправить, обезличить или отправить после явного подтверждения риска.", { privacy, canOverridePrivacyWarning: true });
        }
        if (privacy.incomplete.length && !privacyOverrideConfirmed) {
          throw new HttpError(422, "PII_SCAN_INCOMPLETE", "Локальная проверка материалов выполнена не полностью. Просмотрите предупреждение и при необходимости явно разрешите отправку.", { privacy, canOverridePrivacyWarning: true });
        }
        if (body.confirmedNoPersonalData !== true && !privacyOverrideConfirmed) {
          throw new HttpError(422, "PERSONAL_DATA_CONFIRMATION_REQUIRED", "Подтвердите, что в материалах и текущем черновике нет персональных данных.", { privacy });
        }
      }

        const credential = await credentials.get(provider.id);
        const mergeMode = body.mergeMode === "replace-selected" ? "replace-selected" : "fill-empty";
        const analyzeTimeoutMs = Number(options.analyzeTimeoutMs) || Number(config.requestTimeoutMinutes || 10) * 60000;
        const estimatedParts = Math.max(1, Math.ceil(extracted.reduce((sum, file) => sum + String(file.text || "").length, 0) / 4200));
        const totalTimeoutMs = Number(options.analysisTotalTimeoutMs)
          || Math.min(30 * 60 * 1000, Math.max(180000, analyzeTimeoutMs * Math.min(estimatedParts + 4, 20)));
        const analysisResult = await analyzeWithQuality({
          provider,
          config,
          credential,
          context: { files: extracted, currentDraft, mergeMode },
          fetchImpl,
          timeoutMs: analyzeTimeoutMs,
          totalTimeoutMs,
          signal: analysisController.signal,
        });
        const normalized = redactSuccessfulValue(analysisResult.normalized, [credential, ...credentials.secretValues()]);
        const processing = redactSuccessfulValue(analysisResult.processing, [credential, ...credentials.secretValues()]);
        const extractionWarnings = extracted.flatMap((file) => file.warnings.map((message) => ({ sourceId: file.id, message })));
        json(response, 200, {
          ok: true,
          providerId: provider.id,
          dataBoundary: boundary,
          mergeMode,
          proposal: normalized.proposal,
          evidence: normalized.evidence,
          warnings: [
            ...normalized.warnings,
            ...(Array.isArray(processing?.warnings) ? processing.warnings : []),
            ...extractionWarnings.map((item) => `${item.sourceId}: ${item.message}`),
          ],
          unknowns: normalized.unknowns,
          quality: analysisResult.quality,
          processing,
          privacy: {
            detected: privacy.detected,
            complete: privacy.incomplete.length === 0,
            findings: privacy.findings,
            incomplete: privacy.incomplete,
          },
          sources: extracted.map((file) => ({ id: file.id, name: file.name, type: file.mime, size: file.size, scanComplete: file.scanComplete, warnings: file.warnings })),
        });
      } finally {
        request.removeListener("aborted", abortAnalysis);
        response.removeListener("close", abortOnClosedResponse);
        activeAnalyses -= 1;
      }
      return;
    }

    if (url.pathname.startsWith("/api/")) throw new HttpError(404, "API_NOT_FOUND", "Метод API не найден.");
    return false;
  }

  const handler = async function handler(request, response) {
    let isApi = false;
    try {
      validateInbound(request);
      const url = new URL(request.url || "/", "http://127.0.0.1");
      isApi = url.pathname.startsWith("/api/");
      setSecurityHeaders(response, isApi);
      if (isApi) {
        const handled = await handleApi(request, response, url);
        if (handled !== false) return;
      }
      await serveStatic(request, response, staticRoot, url.pathname);
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      setSecurityHeaders(response, isApi);
      const known = error instanceof HttpError;
      const status = known ? error.status : 500;
      const secrets = credentials.secretValues();
      const message = known ? redactSecrets(error.message, secrets) : "Локальный сервер не смог завершить операцию. Повторите попытку; если ошибка повторится, снова откройте «Siren AI.exe» и проверьте журнал server.err.log.";
      const body = { ok: false, error: { code: known ? error.code : "INTERNAL_ERROR", message } };
      if (known && error.details) body.error.details = redactDetails(error.details, secrets);
      json(response, status, body);
    }
  };
  handler.closeJobs = () => jobs.close();
  return handler;
}

function createServer(options = {}) {
  const handler = createHandler(options);
  const server = http.createServer(handler);
  server.on("close", () => handler.closeJobs());
  server.closeJobs = handler.closeJobs;
  server.requestTimeout = Number(options.requestTimeoutMs) || (31 * 60 * 1000);
  server.headersTimeout = Math.min(server.requestTimeout, Number(options.headersTimeoutMs) || 10000);
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 100;
  server.maxRequestsPerSocket = 100;
  server.maxConnections = 32;
  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });
  return server;
}

module.exports = {
  PRODUCT,
  VERSION,
  CSRF_COOKIE,
  CSRF_HEADER,
  createHandler,
  createServer,
  sanitizeCurrentDraft,
  validateInbound,
};
