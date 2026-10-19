(function (global) {
  "use strict";

  const PROVIDERS = Object.freeze([
    { id: "openai", name: "OpenAI", kind: "cloud", baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini" },
    { id: "anthropic", name: "Anthropic Claude", kind: "cloud", baseUrl: "https://api.anthropic.com/v1", model: "claude-sonnet-4-5" },
    { id: "gemini", name: "Google Gemini", kind: "cloud", baseUrl: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-2.5-flash" },
    { id: "openrouter", name: "OpenRouter", kind: "cloud", baseUrl: "https://openrouter.ai/api/v1", model: "" },
    { id: "yandexgpt", name: "YandexGPT", kind: "cloud", baseUrl: "https://ai.api.cloud.yandex.net/v1", model: "" },
    { id: "gigachat", name: "GigaChat", kind: "cloud", baseUrl: "https://api.giga.chat", model: "GigaChat" },
    { id: "qwen", name: "Qwen (Alibaba Cloud)", kind: "cloud", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
    { id: "deepseek", name: "DeepSeek", kind: "cloud", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash" },
    { id: "ollama", name: "Ollama", kind: "local", baseUrl: "http://127.0.0.1:11434", model: "qwen3.5:2b" },
    { id: "lmstudio", name: "LM Studio", kind: "local", baseUrl: "http://127.0.0.1:1234/v1", model: "" },
    { id: "corporate-qwen", name: "Корпоративный Qwen", kind: "corporate", baseUrl: "", model: "" },
    { id: "custom-openai", name: "Произвольный OpenAI-compatible API", kind: "custom", baseUrl: "", model: "" },
    { id: "custom-webhook", name: "Произвольный REST webhook", kind: "custom", baseUrl: "", model: "" }
  ]);

  const ACCEPTED_EXTENSIONS = Object.freeze([
    "png", "jpg", "jpeg", "webp", "pdf", "docx", "pptx", "xlsx", "csv", "txt", "md"
  ]);
  const ACCEPT_VALUE = ACCEPTED_EXTENSIONS.map((extension) => `.${extension}`).join(",");
  const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp"]);
  const MAX_FILE_BYTES = 100 * 1024 * 1024;
  const MAX_TOTAL_BYTES = 10 * 1024 * 1024 * 1024;
  const MAX_FILES = 2000;
  const MAX_MANUAL_TEXT_CHARS = 3000000;
  const MAX_BRIEF_CHARS = 1500;
  const MANUAL_TEXT_ID = "manual-text";
  const MANUAL_TEXT_NAME = "Введённый текст.txt";
  const PUBLIC_KINDS = new Set(["cloud", "public"]);
  const STEPS = ["Подключение", "Материалы", "Анализ", "Проверка"];

  const state = {
    job: null, jobs: [], jobPoll: null, jobPollGeneration: 0, curlText: "", curlWarnings: [], uploadRequestId: "",
    csrf: "",
    online: false,
    loadingServer: false,
    serverError: "",
    providers: PROVIDERS.map((provider) => ({ ...provider })),
    providerId: "ollama",
    settingsByProvider: new Map(),
    files: [],
    manualText: "",
    brief: { topic: "", include: "", exclude: "", audience: "both" },
    briefError: "",
    clarificationAnswers: {},
    clarificationErrors: new Set(),
    clarificationSubmitting: false,
    step: 0,
    mergeMode: "fill-empty",
    busy: false,
    applying: false,
    abortController: null,
    progressPhase: "idle",
    analysisError: "",
    analysisErrorCode: "",
    canContinueWithoutChanges: false,
    proposal: null,
    plan: null,
    selectedPaths: new Set(),
    piiFindings: [],
    resolvedPii: new Set(),
    piiPreflightReady: false,
    confirmedNoPersonalData: false,
    localPiiWarning: false,
    connectionStatus: null,
    connectionTesting: false,
    connectionTestGeneration: 0,
    connectionAbortController: null,
    processingInfo: null,
    undoSnapshot: null,
    applied: false,
    lastTrigger: null,
    bootstrapped: false
  };

  const refs = {};

  function el(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined && text !== null) element.textContent = String(text);
    return element;
  }

  function button(text, className, action) {
    const control = el("button", className || "button secondary", text);
    control.type = "button";
    if (action) control.dataset.aiAction = action;
    return control;
  }

  function field(labelText, control, hint) {
    const wrapper = el("div", "field ai-field");
    const label = el("label", "", labelText);
    const id = control.id || `ai-field-${Math.random().toString(36).slice(2)}`;
    control.id = id;
    label.htmlFor = id;
    wrapper.append(label, control);
    if (hint) { const help = el("p", "field-help", hint); help.id = `${id}-help`; wrapper.append(help); if (!control.hasAttribute("aria-describedby")) control.setAttribute("aria-describedby", help.id); }
    return wrapper;
  }

  function setAttributes(element, attributes) {
    Object.entries(attributes || {}).forEach(([name, value]) => {
      if (value === false || value === null || value === undefined) return;
      if (value === true) element.setAttribute(name, "");
      else element.setAttribute(name, String(value));
    });
    return element;
  }

  function sanitizeText(value) {
    const merge = global.SirenAIMerge;
    if (merge && typeof merge.sanitizePlainText === "function") return merge.sanitizePlainText(value);
    const holder = document.createElement("div");
    holder.textContent = value === null || value === undefined ? "" : String(value);
    return holder.textContent.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 30000);
  }

  function clone(value) {
    if (global.SirenAIMerge && typeof global.SirenAIMerge.deepClone === "function") {
      return global.SirenAIMerge.deepClone(value);
    }
    if (typeof structuredClone === "function") return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function providerById(id) {
    return state.providers.find((provider) => provider.id === id) || state.providers[0] || PROVIDERS[0];
  }

  function providerKind() {
    const provider = providerById(state.providerId);
    if (provider.kind !== "custom") return provider.kind;
    const settings = currentSettings();
    return settings.dataBoundary === "local" || settings.dataBoundary === "corporate" ? settings.dataBoundary : "cloud";
  }

  function isPublicProvider() {
    return PUBLIC_KINDS.has(providerKind());
  }

  function defaultSettings(provider) {
    const chatPaths = {
      anthropic: "/messages",
      gemini: "",
      gigachat: "/v1/chat/completions",
      "corporate-qwen": "/api/v1/chat/completions",
      ollama: "/api/chat",
      "custom-webhook": ""
    };
    const modelPaths = {
      "corporate-qwen": "/api/v1/models",
      ollama: "/api/tags",
      lmstudio: "/models"
    };
    return {
      providerId: provider.id,
      baseUrl: provider.baseUrl || "",
      model: provider.model || "",
      token: "",
      credentialStored: false,
      credentialRemembered: false,
      remember: false,
      authType: provider.id === "ollama" || provider.id === "lmstudio" ? "none" : provider.id === "gigachat" ? "oauth-basic" : provider.id === "gemini" ? "api-key" : "bearer",
      chatPath: Object.prototype.hasOwnProperty.call(chatPaths, provider.id) ? chatPaths[provider.id] : "/chat/completions",
      modelsPath: Object.prototype.hasOwnProperty.call(modelPaths, provider.id) ? modelPaths[provider.id] : "/models",
      tokenHeader: provider.id === "anthropic" ? "x-api-key" : provider.id === "gemini" ? "x-goog-api-key" : provider.id === "corporate-qwen" ? "X-Client-Token" : "Authorization",
      authUrl: provider.id === "gigachat" ? "https://ngw.devices.sberbank.ru:9443/api/v2/oauth" : "",
      oauthUrl: provider.id === "gigachat" ? "https://ngw.devices.sberbank.ru:9443/api/v2/oauth" : "",
      scope: provider.id === "gigachat" ? "GIGACHAT_API_PERS" : "",
      tenantId: "",
      apiVersion: provider.id === "anthropic" ? "2023-06-01" : "",
      dataBoundary: provider.kind === "custom" ? "public" : provider.kind === "cloud" ? "public" : provider.kind,
      customHeaderName: "Authorization",
      responsePath: provider.id === "custom-webhook" ? "proposal" : "",
      requestTimeoutMinutes: 10, totalTimeoutMinutes: 0, retryCount: 2, chunkChars: provider.kind === "local" ? 1400 : 4200, imageMode: "auto",
      httpMethod: "POST"
    };
  }

  function currentSettings() {
    if (!state.settingsByProvider.has(state.providerId)) {
      state.settingsByProvider.set(state.providerId, defaultSettings(providerById(state.providerId)));
    }
    return state.settingsByProvider.get(state.providerId);
  }

  function resetAnalysis() {
    stopJobPolling(); state.job = null; state.uploadRequestId = "";
    state.clarificationAnswers = {};
    state.clarificationErrors = new Set();
    state.clarificationSubmitting = false;
    state.proposal = null;
    state.plan = null;
    state.selectedPaths = new Set();
    state.piiFindings = [];
    state.resolvedPii = new Set();
    state.piiPreflightReady = false;
    state.confirmedNoPersonalData = false;
    state.localPiiWarning = false;
    state.analysisError = "";
    state.analysisErrorCode = "";
    state.canContinueWithoutChanges = false;
    state.progressPhase = "idle";
    state.processingInfo = null;
    state.applied = false;
  }

  class ApiError extends Error {
    constructor(message, details) {
      super(message);
      this.name = "ApiError";
      Object.assign(this, details || {});
    }
  }

  const ERROR_FALLBACKS = Object.freeze({
    PROVIDER_AUTH_FAILED: "Провайдер не принял ключ или токен. Проверьте секрет, способ авторизации и срок его действия.",
    PROVIDER_ACCESS_DENIED: "У ключа нет доступа к этому запросу или модели. Проверьте права в кабинете провайдера.",
    PROVIDER_MODEL_NOT_FOUND: "Модель не найдена или не загружена. Проверьте её точное имя и выберите доступную модель.",
    PROVIDER_ROUTE_NOT_FOUND: "Маршрут API не найден. Проверьте базовый URL и маршрут анализа.",
    PROVIDER_METHOD_NOT_ALLOWED: "Этот маршрут не принимает запрос анализа. Укажите маршрут анализа, а не маршрут списка моделей.",
    PROVIDER_RATE_LIMITED: "Провайдер временно ограничил частоту запросов. Подождите немного и повторите попытку.",
    PROVIDER_QUOTA_EXHAUSTED: "Закончилась квота или доступный баланс. Пополните лимит либо выберите другую модель.",
    PROVIDER_CONNECTION_REFUSED: "AI-сервис не отвечает. Убедитесь, что он запущен, и проверьте адрес и порт.",
    PROVIDER_DNS_FAILED: "Сервер AI не найден. Проверьте адрес, подключение к сети или VPN.",
    PROVIDER_TLS_FAILED: "Не удалось установить защищённое соединение. Проверьте сертификат, системную дату и корпоративный прокси.",
    PROVIDER_TIMEOUT: "Модель не успела ответить. Дождитесь её загрузки или выберите более быструю модель, затем повторите попытку.",
    PROVIDER_TEST_INVALID_RESPONSE: "Модель ответила, но не вернула JSON, необходимый для анализа. Выберите совместимую модель или проверьте маршрут анализа.",
    PROVIDER_UNSUPPORTED_REQUEST: "Модель не поддерживает необходимый режим JSON или изображения. Выберите совместимую модель.",
    PROVIDER_OUT_OF_MEMORY: "Модели не хватило памяти. Закройте лишние программы или выберите модель меньшего размера.",
    PROVIDER_RESPONSE_TOO_LARGE: "AI-сервис вернул слишком большой ответ. Уменьшите объём одного анализа или выберите модель с более коротким ответом.",
    PROVIDER_REDIRECT_BLOCKED: "AI-сервис попытался перенаправить запрос на другой адрес. Укажите конечный базовый URL и маршрут без перенаправления.",
    PROVIDER_AUTH_ERROR: "Сервис авторизации не выдал рабочий токен. Проверьте ключ, адрес авторизации и права учётной записи.",
    EMPTY_PROVIDER_RESPONSE: "Модель вернула пустой ответ. Повторите запрос; если это повторяется, выберите другую модель или проверьте маршрут анализа.",
    AI_REPAIR_FAILED: "ИИ дважды вернул технически непригодный ответ. Можно повторить анализ или продолжить без изменений.",
    AI_TEXT_QUALITY_FAILED: "ИИ не вернул пригодных предложений. Можно повторить анализ или продолжить без изменений.",
    INVALID_RESPONSE: "Локальный сервер вернул неожиданный ответ. Снова откройте «Siren AI.exe»; если ошибка повторится, проверьте журнал server.err.log.",
    INVALID_JSON: "Локальный сервер вернул повреждённый ответ. Снова откройте «Siren AI.exe»; если ошибка повторится, проверьте журнал server.err.log.",
    INTERNAL_ERROR: "Локальный сервер не смог завершить операцию. Повторите попытку; если ошибка повторится, снова откройте «Siren AI.exe» и проверьте журнал server.err.log.",
  });

  function userFacingError(error, fallback) {
    const message = sanitizeText(error && error.message);
    if (message && !/(?:failed to fetch|AI-сервис вернул ошибку\s*\d+|ECONN|ENOTFOUND|EAI_AGAIN|<!doctype|<html|\{\s*"error")/i.test(message)) return message;
    const code = sanitizeText(error && error.code);
    return ERROR_FALLBACKS[code] || fallback || "Запрос не выполнен. Проверьте настройки и повторите попытку.";
  }

  async function parseJson(response) {
    const type = response.headers.get("content-type") || "";
    if (!type.toLowerCase().includes("application/json")) {
      throw new ApiError("Локальный сервер вернул неожиданный ответ. Снова откройте «Siren AI.exe»; если ошибка повторится, проверьте журнал server.err.log.", { status: response.status, code: "INVALID_RESPONSE" });
    }
    try {
      return await response.json();
    } catch (_error) {
      throw new ApiError("Не удалось прочитать ответ локального сервера. Снова откройте «Siren AI.exe»; если ошибка повторится, проверьте журнал server.err.log.", { status: response.status, code: "INVALID_JSON" });
    }
  }

  async function apiRequest(path, options) {
    const request = options || {};
    const headers = new Headers(request.headers || {});
    if (request.body !== undefined) headers.set("Content-Type", "application/json");
    if (request.method && request.method !== "GET") {
      if (!state.csrf) throw new ApiError("Защитный сеанс не инициализирован. Перезапустите локальный сервер.", { code: "CSRF_MISSING" });
      headers.set("X-Siren-CSRF", state.csrf);
    }

    let response;
    try {
      response = await fetch(path, {
        method: request.method || "GET",
        headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: request.signal || AbortSignal.timeout(30000),
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error"
      });
    } catch (error) {
      if (error && error.name === "AbortError") throw error;
      throw new ApiError("Локальный сервер Siren AI недоступен. Закройте окно и снова откройте файл «Siren AI.exe».", { code: "SERVER_UNAVAILABLE" });
    }

    const payload = await parseJson(response);
    if (payload.error?.code === "CSRF_INVALID" && !request.sessionRefreshed) {
      const health = await apiRequest("/api/health"); state.csrf = health.csrf;
      return apiRequest(path, { ...request, sessionRefreshed: true });
    }
    if (!response.ok || payload.ok === false) {
      const serverError = payload && payload.error && typeof payload.error === "object" ? payload.error : {};
      const message = sanitizeText(serverError.message || payload.message) || `Запрос завершился с ошибкой ${response.status}.`;
      throw new ApiError(message, {
        status: response.status,
        code: sanitizeText(serverError.code || payload.code || "REQUEST_FAILED"),
        details: serverError.details || payload.details,
        payload
      });
    }
    return payload;
  }

  function normalizeProviders(payload) {
    const received = Array.isArray(payload) ? payload : Array.isArray(payload && payload.providers) ? payload.providers : [];
    const byId = new Map(received.filter((item) => item && item.id).map((item) => [String(item.id), item]));
    state.providers = PROVIDERS.map((fallback) => {
      const incoming = byId.get(fallback.id) || {};
      return {
        ...fallback,
        name: sanitizeText(incoming.name || incoming.label) || fallback.name,
        kind: (() => {
          const boundary = incoming.dataBoundary || incoming.kind;
          if (boundary === "public" || incoming.publicCloud === true) return fallback.kind === "custom" ? "custom" : "cloud";
          if (["local", "corporate", "custom"].includes(boundary)) return boundary;
          return fallback.kind;
        })(),
        baseUrl: sanitizeText(incoming.baseUrl || (incoming.defaults && incoming.defaults.baseUrl)) || fallback.baseUrl,
        model: sanitizeText(incoming.model || (incoming.defaults && incoming.defaults.model)) || fallback.model
      };
    });
  }

  function mergeSavedSetting(raw) {
    if (!raw || typeof raw !== "object") return;
    const id = String(raw.providerId || raw.id || "");
    if (!PROVIDERS.some((provider) => provider.id === id)) return;
    const settings = { ...defaultSettings(providerById(id)) };
    const combined = { ...(raw.config && typeof raw.config === "object" ? raw.config : {}), ...raw };
    for (const key of ["requestTimeoutMinutes", "totalTimeoutMinutes", "retryCount", "chunkChars", "temperature", "maxTokens"]) if (Number.isFinite(Number(combined[key]))) settings[key] = Number(combined[key]);
    if (["auto", "vision", "ocr"].includes(combined.imageMode)) settings.imageMode = combined.imageMode;
    if (typeof combined.folderId === "string") settings.folderId = combined.folderId;
    ["baseUrl", "model", "authType", "chatPath", "modelsPath", "tokenHeader", "authUrl", "oauthUrl", "scope", "tenantId", "apiVersion", "dataBoundary", "customHeaderName", "responsePath", "httpMethod"].forEach((key) => {
      if (typeof combined[key] === "string") settings[key] = sanitizeText(combined[key]);
    });
    if (typeof combined.dataScope === "string" && !combined.dataBoundary) settings.dataBoundary = combined.dataScope === "cloud" ? "public" : combined.dataScope;
    if (id === "ollama") {
      if (/\/v1\/?$/i.test(settings.baseUrl)) settings.baseUrl = settings.baseUrl.replace(/\/v1\/?$/i, "");
      if (["/v1/chat/completions", "/chat/completions"].includes(settings.chatPath)) settings.chatPath = "/api/chat";
      if (["/v1/models", "/models", "/v1/chat/completions"].includes(settings.modelsPath)) settings.modelsPath = "/api/tags";
      settings.authType = "none";
    }
    settings.remember = Boolean(raw.remembered || raw.remember);
    settings.credentialRemembered = Boolean(raw.remembered || raw.remember);
    settings.credentialStored = Boolean(raw.credentialStored || raw.hasCredential || raw.tokenStored);
    settings.token = "";
    state.settingsByProvider.set(id, settings);
  }

  function ingestSettings(payload) {
    const source = payload && payload.settings !== undefined ? payload.settings : payload;
    if (Array.isArray(source)) source.forEach(mergeSavedSetting);
    else if (source && Array.isArray(source.providers)) source.providers.forEach(mergeSavedSetting);
    else if (source && source.providers && typeof source.providers === "object") {
      Object.entries(source.providers).forEach(([id, value]) => mergeSavedSetting({ ...(value || {}), providerId: id }));
    }
    else if (source && typeof source === "object" && (source.providerId || source.id)) mergeSavedSetting(source);
    else if (source && typeof source === "object") {
      Object.entries(source).forEach(([id, value]) => mergeSavedSetting({ ...(value || {}), providerId: id }));
    }
    const selected = sanitizeText((payload && (payload.selectedProviderId || payload.providerId)) || "");
    if (PROVIDERS.some((provider) => provider.id === selected)) state.providerId = selected;
  }

  async function bootstrapServer() {
    if (state.loadingServer) return;
    state.loadingServer = true;
    state.serverError = "";
    render();
    try {
      const health = await apiRequest("/api/health");
      state.csrf = sanitizeText(health.csrf || health.csrfToken || (health.session && health.session.csrf));
      if (!state.csrf) throw new ApiError("Локальный сервер не выдал защитный токен сеанса.", { code: "CSRF_MISSING" });
      const results = await Promise.allSettled([
        apiRequest("/api/providers"),
        apiRequest("/api/settings")
      ]);
      if (results[0].status === "fulfilled") normalizeProviders(results[0].value);
      if (results[1].status === "fulfilled") ingestSettings(results[1].value);
      state.online = true;
      await refreshJobs();
      state.serverError = "";
    } catch (error) {
      state.online = false;
      state.serverError = userFacingError(error, "Локальный сервер Siren AI недоступен. Закройте окно и снова откройте «Siren AI.exe».");
    } finally {
      state.loadingServer = false;
      state.bootstrapped = true;
      render();
    }
  }

  function settingsPayload() {
    const settings = currentSettings();
    return {
      providerId: state.providerId,
      baseUrl: settings.baseUrl,
      model: settings.model,
      token: settings.token,
      authType: settings.authType,
      chatPath: settings.chatPath,
      modelsPath: settings.modelsPath,
      tokenHeader: settings.tokenHeader,
      authUrl: settings.authUrl,
      oauthUrl: settings.oauthUrl,
      scope: settings.scope,
      tenantId: settings.tenantId,
      apiVersion: settings.apiVersion,
      dataBoundary: settings.dataBoundary,
      customHeaderName: settings.customHeaderName,
      responsePath: settings.responsePath,
      httpMethod: "POST",
      remember: settings.remember,
      requestTimeoutMinutes: Number(settings.requestTimeoutMinutes), totalTimeoutMinutes: Number(settings.totalTimeoutMinutes), retryCount: Number(settings.retryCount), chunkChars: Number(settings.chunkChars), imageMode: settings.imageMode,
      temperature: settings.temperature === "" ? undefined : settings.temperature, maxTokens: settings.maxTokens === "" ? undefined : settings.maxTokens, folderId: settings.folderId
    };
  }

  function validateSettings() {
    const provider = providerById(state.providerId);
    const settings = currentSettings();
    const errors = [];
    if ((provider.kind === "local" || provider.kind === "corporate" || provider.kind === "custom") && !settings.baseUrl.trim()) {
      errors.push("Укажите адрес API.");
    }
    if (provider.id !== "custom-webhook" && !settings.model.trim()) errors.push("Укажите модель.");
    if (provider.id === "custom-webhook" && !settings.responsePath.trim()) errors.push("Укажите путь к предложению в ответе webhook.");
    if (provider.kind === "cloud" && !settings.token.trim() && !settings.credentialStored) errors.push("Укажите токен доступа.");
    if (provider.id === "corporate-qwen" && !settings.token.trim() && !settings.credentialStored) {
      errors.push("Укажите клиентский токен корпоративного шлюза.");
    }
    for (const [key, min, max, label] of [["requestTimeoutMinutes", 1, 60, "Время ожидания"], ["totalTimeoutMinutes", 0, 10080, "Общий лимит"], ["retryCount", 0, 3, "Повторные попытки"], ["chunkChars", 400, 8000, "Размер части"]]) {
      const value = Number(settings[key]);
      if (!Number.isInteger(value) || value < min || value > max) {
        errors.push(`${label}: укажите целое число от ${min} до ${max}.`);
        const input = refs.body?.querySelector(`[data-ai-setting="${key}"]`);
        input?.setAttribute("aria-invalid", "true"); input?.focus();
      }
    }
    return errors;
  }

  async function saveSettings(signal) {
    const errors = validateSettings();
    if (errors.length) throw new Error(errors[0]);
    const payload = await apiRequest("/api/settings", { method: "POST", body: settingsPayload(), signal });
    const settings = currentSettings();
    if (settings.token) settings.credentialStored = Boolean(settings.remember || payload.credentialStored || payload.hasCredential);
    if (payload && payload.config && typeof payload.config === "object") mergeSavedSetting({ ...payload, providerId: state.providerId });
    return payload;
  }

  async function testConnection() {
    if (!state.online) return bootstrapServer();
    if (state.connectionTesting) return;
    const generation = state.connectionTestGeneration + 1;
    state.connectionTestGeneration = generation;
    state.connectionAbortController?.abort();
    const controller = new AbortController();
    state.connectionAbortController = controller;
    state.connectionTesting = true;
    state.connectionStatus = { tone: "progress", title: "Проверяем готовность", message: "Отправляем короткий тестовый запрос без ваших материалов. Для локальной модели первая проверка может занять несколько минут." };
    render();
    try {
      await saveSettings(controller.signal);
      const payload = await apiRequest("/api/test-connection", { method: "POST", body: settingsPayload(), signal: controller.signal });
      if (generation !== state.connectionTestGeneration || controller.signal.aborted) return;
      if (payload.verified !== true) throw new ApiError("Сервис доступен, но модель не выполнила тестовый запрос. Проверьте маршрут анализа и выбранную модель.", { code: "PROVIDER_TEST_NOT_VERIFIED" });
      const model = sanitizeText(payload.model || currentSettings().model);
      const seconds = Number(payload.latencyMs) > 0 ? Math.max(0.1, Number(payload.latencyMs) / 1000).toLocaleString("ru-RU", { maximumFractionDigits: 1 }) : "";
      state.connectionStatus = {
        tone: "success",
        title: "Всё готово",
        message: `${model ? `Модель ${model} приняла и выполнила тестовый запрос.` : "Модель приняла и выполнила тестовый запрос."}${seconds ? ` Время ответа: ${seconds} с.` : ""} Можно запускать анализ.`
      };
    } catch (error) {
      if (error?.name === "AbortError" || generation !== state.connectionTestGeneration) return;
      state.connectionStatus = { tone: "error", title: "Подключение не готово", message: userFacingError(error, "Проверка не выполнена. Проверьте адрес, модель и авторизацию, затем повторите попытку.") };
    } finally {
      if (generation === state.connectionTestGeneration) {
        state.connectionTesting = false;
        state.connectionAbortController = null;
        render();
      }
    }
  }

  function invalidateConnectionCheck() {
    state.connectionTestGeneration += 1;
    state.connectionAbortController?.abort();
    state.connectionAbortController = null;
    state.connectionTesting = false;
    state.connectionStatus = null;
    refs.body?.querySelector("[data-ai-connection-status]")?.remove();
  }

  async function deleteCredential() {
    if (!state.online) return;
    state.connectionStatus = { tone: "progress", message: "Удаляем сохранённый секрет…" };
    render();
    try {
      await apiRequest(`/api/settings?providerId=${encodeURIComponent(state.providerId)}`, { method: "DELETE" });
      const settings = currentSettings();
      settings.token = "";
      settings.credentialStored = false;
      settings.credentialRemembered = false;
      settings.remember = false;
      state.connectionStatus = { tone: "success", message: "Сохранённый секрет удалён с этого компьютера." };
    } catch (error) {
      state.connectionStatus = { tone: "error", message: userFacingError(error, "Не удалось удалить секрет. Повторите попытку.") };
    }
    render();
  }

  function extensionOf(name) {
    const match = String(name || "").toLowerCase().match(/\.([a-z0-9]+)$/);
    return match ? match[1] : "";
  }

  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} Б`;
    if (value < 1024 * 1024) return `${(value / 1024).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} КБ`;
    return `${(value / (1024 * 1024)).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} МБ`;
  }

  function pluralRu(value, forms) {
    const number = Math.abs(Number(value) || 0);
    const lastTwo = number % 100;
    const last = number % 10;
    if (lastTwo >= 11 && lastTwo <= 14) return forms[2];
    if (last === 1) return forms[0];
    if (last >= 2 && last <= 4) return forms[1];
    return forms[2];
  }

  function hasManualText() {
    return state.manualText.trim().length > 0;
  }

  function manualTextBytes() {
    return new TextEncoder().encode(state.manualText).byteLength;
  }

  function materialCount() {
    return state.files.length + (hasManualText() ? 1 : 0);
  }

  function totalMaterialBytes() {
    return state.files.reduce((sum, entry) => sum + entry.file.size, 0) + (hasManualText() ? manualTextBytes() : 0);
  }

  function hasMaterials() {
    return materialCount() > 0;
  }

  function materialCountLabel() {
    const count = materialCount();
    return `${count} ${pluralRu(count, ["материал", "материала", "материалов"])}`;
  }

  function materialLimitError() {
    if (materialCount() > MAX_FILES) return `Можно добавить не более ${MAX_FILES} материалов. Введённый текст считается отдельным материалом.`;
    if (totalMaterialBytes() > MAX_TOTAL_BYTES) return `Общий объём материалов не должен превышать ${formatBytes(MAX_TOTAL_BYTES)}.`;
    return "";
  }

  function defaultFileRole(file) {
    const extension = extensionOf(file.name);
    if (IMAGE_EXTENSIONS.has(extension)) {
      const stem = file.name.slice(0, -extension.length).replace(/\.$/, "").trim().toLowerCase();
      if (/^(?:было|before)[\s_-]*\d*$/.test(stem)) return "before";
      if (/^(?:стало|after)[\s_-]*\d*$/.test(stem)) return "after";
    }
    return IMAGE_EXTENSIONS.has(extension) ? "screen" : "documentation";
  }

  function addFiles(fileList) {
    const incoming = Array.from(fileList || []);
    const existingKeys = new Set(state.files.map((entry) => `${entry.file.name}|${entry.file.size}|${entry.file.lastModified}`));
    const totalBefore = totalMaterialBytes();
    let plannedTotal = totalBefore;
    const rejected = [];

    incoming.forEach((file) => {
      if (state.files.length + (hasManualText() ? 1 : 0) >= MAX_FILES) {
        rejected.push(`${file.name}: можно добавить не более ${MAX_FILES} материалов, включая введённый текст`);
        return;
      }
      const extension = extensionOf(file.name);
      const key = `${file.name}|${file.size}|${file.lastModified}`;
      if (!ACCEPTED_EXTENSIONS.includes(extension)) {
        rejected.push(`${file.name}: формат не поддерживается`);
        return;
      }
      if (file.size <= 0) {
        rejected.push(`${file.name}: файл пуст`);
        return;
      }
      if (file.size > MAX_FILE_BYTES) {
        rejected.push(`${file.name}: больше ${formatBytes(MAX_FILE_BYTES)}`);
        return;
      }
      if (plannedTotal + file.size > MAX_TOTAL_BYTES) {
        rejected.push(`${file.name}: общий объём превысит ${formatBytes(MAX_TOTAL_BYTES)}`);
        return;
      }
      if (existingKeys.has(key)) {
        rejected.push(`${file.name}: уже добавлен`);
        return;
      }
      existingKeys.add(key);
      plannedTotal += file.size;
      state.files.push({
        id: global.crypto && typeof global.crypto.randomUUID === "function" ? global.crypto.randomUUID() : `file-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        file,
        role: defaultFileRole(file),
        status: "ready",
        error: ""
      });
    });

    resetAnalysis();
    if (rejected.length) state.analysisError = rejected.slice(0, 3).join("; ");
    render();
  }

  function removeFile(id) {
    state.files = state.files.filter((entry) => entry.id !== id);
    resetAnalysis();
    render();
  }

  function readFileBase64(file, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) {
        reject(new DOMException("Операция отменена", "AbortError"));
        return;
      }
      const reader = new FileReader();
      const abort = () => reader.abort();
      if (signal) signal.addEventListener("abort", abort, { once: true });
      reader.onerror = () => {
        if (signal) signal.removeEventListener("abort", abort);
        reject(new Error(`Не удалось прочитать файл «${file.name}».`));
      };
      reader.onabort = () => {
        if (signal) signal.removeEventListener("abort", abort);
        reject(new DOMException("Операция отменена", "AbortError"));
      };
      reader.onload = () => {
        if (signal) signal.removeEventListener("abort", abort);
        const bytes = new Uint8Array(reader.result);
        const chunkSize = 0x8000;
        let binary = "";
        for (let index = 0; index < bytes.length; index += chunkSize) {
          binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunkSize));
        }
        resolve(global.btoa(binary));
      };
      reader.readAsArrayBuffer(file);
    });
  }

  function encodeTextBase64(value) {
    const bytes = new TextEncoder().encode(String(value || ""));
    const chunkSize = 0x8000;
    let binary = "";
    for (let index = 0; index < bytes.length; index += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunkSize));
    }
    return global.btoa(binary);
  }

  async function serializeMaterials(signal) {
    const result = [];
    for (const entry of state.files) {
      entry.status = "reading";
      render();
      try {
        const base64 = await readFileBase64(entry.file, signal);
        entry.status = "ready";
        result.push({
          id: entry.id,
          name: entry.file.name,
          type: entry.file.type || "application/octet-stream",
          size: entry.file.size,
          base64,
          purpose: entry.role
        });
      } catch (error) {
        entry.status = "error";
        entry.error = error && error.name === "AbortError" ? "Чтение отменено" : "Не удалось прочитать";
        throw error;
      }
    }
    if (hasManualText()) {
      if (signal && signal.aborted) throw new DOMException("Операция отменена", "AbortError");
      result.push({
        id: MANUAL_TEXT_ID,
        name: MANUAL_TEXT_NAME,
        type: "text/plain",
        size: manualTextBytes(),
        base64: encodeTextBase64(state.manualText),
        purpose: "context"
      });
    }
    return result;
  }

  function piiSources(errorOrPayload) {
    const payload = errorOrPayload && errorOrPayload.payload ? errorOrPayload.payload : errorOrPayload;
    const details = errorOrPayload && errorOrPayload.details ? errorOrPayload.details : payload && payload.error && payload.error.details;
    const pii = payload && (payload.privacy || payload.pii)
      ? (payload.privacy || payload.pii)
      : details && (details.privacy || details.pii)
        ? (details.privacy || details.pii)
        : details;
    const findings = Array.isArray(pii)
      ? [...pii]
      : pii && Array.isArray(pii.findings)
        ? [...pii.findings]
        : pii && Array.isArray(pii.matches)
          ? [...pii.matches]
          : details && Array.isArray(details.findings)
            ? [...details.findings]
            : [];
    const incomplete = pii && Array.isArray(pii.incomplete) ? pii.incomplete : [];
    incomplete.forEach((item, index) => {
      const source = item && typeof item === "object" ? item : { reason: item };
      const sourceId = sanitizeText(source.sourceId || source.fileId || source.id || "");
      findings.push({
        id: `incomplete-${sourceId || index}`,
        sourceId,
        fileId: sourceId,
        fileName: source.fileName || source.name,
        category: "Материал не удалось проверить полностью",
        reason: source.reason || source.message || "Локальная проверка содержимого не завершена.",
        blocking: true
      });
    });
    return findings;
  }

  function maskSensitivePreview(value) {
    return sanitizeText(value)
      .replace(/([\w.+-])[\w.+-]*(@[\w.-]+)/g, "$1***$2")
      .replace(/\b(?:\d[\s()+-]*){6,}\d\b/g, (match) => `${match.slice(0, 2)}••••${match.slice(-2)}`)
      .slice(0, 240);
  }

  function normalizePiiFindings(source) {
    return (Array.isArray(source) ? source : []).map((finding, index) => {
      const item = finding && typeof finding === "object" ? finding : { category: finding };
      const fileId = sanitizeText(item.fileId || item.sourceId || "");
      const fileEntry = state.files.find((entry) => entry.id === fileId);
      const materialName = fileId === MANUAL_TEXT_ID ? "Текстовый материал" : fileEntry && fileEntry.file.name;
      return {
        id: sanitizeText(item.id) || `pii-${index}-${fileId}`,
        fileId,
        fileName: sanitizeText(item.fileName || item.file || materialName || state.job?.files.find((f) => f.id === fileId)?.name) || "Материал",
        category: sanitizeText(item.category || item.type || item.label) || "Возможные персональные данные",
        location: sanitizeText(item.location || (item.page ? `Страница ${item.page}` : item.sheet ? `Лист ${item.sheet}` : "")),
        preview: maskSensitivePreview(item.masked || item.preview || item.sample || item.match || item.text || item.reason),
        blocking: item.blocking === true,
        reason: sanitizeText(item.reason || item.message || "")
      };
    });
  }

  function normalizedEvidence(evidence) {
    if (!evidence || typeof evidence !== "object") return evidence;
    const normalizePath = (value) => sanitizeText(value)
      .replace(/^\//, "")
      .replace(/\/(\d+)/g, "[$1]")
      .replace(/\//g, ".")
      .replace(/^proposal\./, "");
    const sourceLabel = (sourceId) => {
      if (sourceId === MANUAL_TEXT_ID) return "Текстовый материал";
      const entry = state.files.find((item) => item.id === sourceId);
      return entry && entry.file ? entry.file.name : state.job?.files.find((f) => f.id === sourceId)?.name || sourceId;
    };
    const normalizeItem = (item) => {
      if (!item || typeof item !== "object") return item;
      const sourceId = sanitizeText(item.sourceId || item.fileId || "");
      return {
        ...item,
        ...(sourceId && !item.source && !item.file ? { source: sourceLabel(sourceId) } : {}),
        ...(!item.quote && !item.excerpt && !item.note && item.snippet ? { quote: item.snippet } : {}),
      };
    };
    if (Array.isArray(evidence)) {
      return evidence.map((item) => {
        if (!item || typeof item !== "object") return item;
        const path = normalizePath(item.path || item.field || item.target);
        return { ...normalizeItem(item), path };
      });
    }
    const result = {};
    Object.entries(evidence).forEach(([path, value]) => {
      const normalized = normalizePath(path);
      result[normalized] = Array.isArray(value) ? value.map(normalizeItem) : normalizeItem(value);
    });
    return result;
  }

  function buildPlan() {
    if (!state.proposal || !global.SirenAIMerge || !global.SirenApp) return null;
    const current = global.SirenApp.getState();
    const draft = state.proposal.draft && typeof state.proposal.draft === "object" ? state.proposal.draft : {};
    return global.SirenAIMerge.planProposal(current, draft, {
      mode: state.mergeMode,
      selectedPaths: state.selectedPaths,
      evidence: normalizedEvidence(state.proposal.evidence),
      sanitizeRichText: sanitizeText
    });
  }

  function initializeSelection() {
    if (!state.proposal || !global.SirenAIMerge || !global.SirenApp) return;
    const preliminary = global.SirenAIMerge.planProposal(global.SirenApp.getState(), state.proposal.draft || {}, {
      mode: state.mergeMode,
      evidence: normalizedEvidence(state.proposal.evidence),
      sanitizeRichText: sanitizeText
    });
    state.selectedPaths = new Set(preliminary.changes
      .filter((change) => change.defaultSelected && Array.isArray(change.evidence) && change.evidence.length > 0 && !evidenceNeedsReview(change))
      .map((change) => change.path));
    state.plan = buildPlan();
  }

  function stopJobPolling() {
    state.jobPollGeneration += 1;
    global.clearTimeout(state.jobPoll); state.jobPoll = null;
  }

  async function refreshJobs(append = false) {
    try { const payload = await apiRequest(`/api/jobs?offset=${append ? state.jobs.length : 0}`); state.jobs = append ? [...state.jobs, ...(payload.jobs || [])] : payload.jobs || []; state.jobsTotal = payload.total || 0; }
    catch (error) { state.serverError = userFacingError(error, "Не удалось прочитать сохранённые обработки. Нажмите «Обновить список»."); }
  }

  function jobBusy(job) { return job && ["queued", "preparing", "running"].includes(job.status); }

  function reflectJob(job) {
    if (state.job?.id !== job.id) {
      state.clarificationAnswers = {};
      state.clarificationErrors = new Set();
    }
    state.job = job; state.busy = jobBusy(job);
    if (job.brief) state.brief = { topic: "", include: "", exclude: "", ...job.brief, audience: "both" };
    for (const entry of Array.isArray(job.clarificationAnswers) ? job.clarificationAnswers : []) {
      if (!Object.prototype.hasOwnProperty.call(state.clarificationAnswers, entry.id)) state.clarificationAnswers[entry.id] = String(entry.answer || "");
    }
    state.progressPhase = ["confirmation", "clarification"].includes(job.status) ? job.status : state.busy ? "server" : job.status === "complete" ? "done" : "error";
    state.piiPreflightReady = job.status === "confirmation";
    state.piiFindings = normalizePiiFindings(piiSources({ privacy: job.privacy }));
    state.analysisError = job.error?.message || "";
    if (job.status === "confirmation") state.confirmedNoPersonalData = false;
  }

  function pollJob(id) {
    stopJobPolling(); const generation = state.jobPollGeneration;
    const tick = async () => {
      try {
        const job = await apiRequest(`/api/jobs/${id}`);
        if (generation !== state.jobPollGeneration || state.job?.id !== id) return;
        reflectJob(job);
        if (state.step === 2 && refs.dialog?.open) render();
        else if (state.step === 3 && refs.dialog?.open) renderFooter();
        if (jobBusy(job)) state.jobPoll = global.setTimeout(tick, 2000);
        else { await refreshJobs(); if (state.step === 2 && refs.dialog?.open) render(); }
      } catch (error) {
        if (generation !== state.jobPollGeneration) return;
        state.busy = false; state.analysisError = "Связь с локальной программой прервалась. Обработка могла продолжиться. Откройте SIREN AI v 2.1 и нажмите «Обновить статус»; готовые этапы сохранены.";
        if (refs.dialog?.open) render();
      }
    };
    state.jobPoll = global.setTimeout(tick, 600);
  }

  async function openSavedJob(id) {
    stopJobPolling();
    const generation = state.jobPollGeneration;
    const job = await apiRequest(`/api/jobs/${id}`);
    if (generation !== state.jobPollGeneration) return;
    if (state.job?.id !== id) { state.files = []; state.manualText = ""; state.proposal = null; state.plan = null; state.selectedPaths = new Set(); state.applied = false; }
    state.providerId = job.providerId; reflectJob(job); state.step = 2; render();
    if (jobBusy(job)) pollJob(id);
  }

  async function cancelAnalysis() {
    state.abortController?.abort();
    if (state.job) {
      try { reflectJob(await apiRequest(`/api/jobs/${state.job.id}/pause`, { method: "POST", body: {} })); }
      catch (error) { state.analysisError = userFacingError(error, "Не удалось подтвердить приостановку. Обновите статус обработки."); }
    }
    stopJobPolling(); state.busy = false; render();
  }

  async function uploadMaterial(job, entry, signal) {
    const file = entry.file;
    let saved = job.files.find((item) => item.name === file.name && item.size === file.size);
    if (!saved) saved = await apiRequest(`/api/jobs/${job.id}/files`, { method: "POST", body: { clientId: entry.id, name: file.name, size: file.size, purpose: entry.role }, signal });
    let offset = saved.uploaded || 0;
    while (offset < file.size) {
      const part = file.slice(offset, Math.min(offset + 2 * 1024 * 1024, file.size));
      state.job.progress = { phase: "upload", sourceName: file.name, message: `Сохраняем файл: ${formatBytes(offset)} из ${formatBytes(file.size)}` };
      if (refs.dialog?.open) render();
      let response;
      try { response = await fetch(`/api/jobs/${job.id}/files/${saved.id}?offset=${offset}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream", "X-Siren-CSRF": state.csrf }, body: part, signal, credentials: "same-origin", redirect: "error" }); }
      catch (error) { if (error.name === "AbortError") throw error; throw new Error("Загрузка прервалась. Файлы, уже записанные на диск, сохранены. Нажмите «Продолжить загрузку»; после обновления страницы выберите те же файлы повторно."); }
      const payload = await parseJson(response);
      if (response.status === 409 && Number.isFinite(payload.error?.details?.uploaded)) { offset = payload.error.details.uploaded; continue; }
      if (!response.ok) throw new ApiError(payload.error?.message || "Не удалось сохранить файл. Проверьте свободное место на диске.", payload.error);
      offset = payload.uploaded;
    }
  }

  async function performAnalysis(forceConfirmed) {
    if (state.busy || state.clarificationSubmitting) return;
    state.analysisError = "";
    if (state.job?.status === "clarification") { state.step = 2; render(); return; }
    if (state.job && (state.job.status !== "uploading" || (!hasMaterials() && state.job.files.length > 0 && state.job.files.every((file) => file.uploaded === file.size)))) {
      if (state.job.status === "confirmation" && !forceConfirmed) return;
      const id = state.job.id;
      state.busy = true; render();
      try {
        const job = await apiRequest(`/api/jobs/${id}/start`, { method: "POST", body: forceConfirmed ? { confirmedNoPersonalData: true, privacyOverrideConfirmed: state.piiFindings.length > 0 } : {} });
        if (state.job?.id !== id) return;
        reflectJob(job); state.step = 2; render(); pollJob(id);
      } catch (error) { if (state.job?.id === id) { state.busy = false; state.analysisError = userFacingError(error); render(); } }
      return;
    }
    if (!state.brief.topic.trim()) {
      state.briefError = "Укажите тему: какое изменение нужно объяснить сотруднику и клиенту.";
      state.step = 1; render();
      global.queueMicrotask(() => document.getElementById("aiBriefTopic")?.focus());
      return;
    }
    if (!hasMaterials() || materialLimitError()) { state.analysisError = materialLimitError() || "Добавьте хотя бы один материал."; render(); return; }
    state.busy = true; state.step = 2; state.progressPhase = "preparing";
    state.abortController = new AbortController(); render();
    try {
      await saveSettings();
      if (!state.job) {
        state.uploadRequestId ||= global.crypto.randomUUID();
        const currentDraft = JSON.parse(JSON.stringify(global.SirenApp.getState(), (key, value) => ["dataUrl", "dataURL", "base64"].includes(key) ? undefined : value));
        state.job = await apiRequest("/api/jobs", { method: "POST", body: { clientRequestId: state.uploadRequestId, providerId: state.providerId, mergeMode: state.mergeMode, currentDraft, brief: { ...state.brief } }, signal: state.abortController.signal });
      }
      const entries = state.files.slice();
      if (hasManualText()) entries.push({ id: MANUAL_TEXT_ID, role: "documentation", file: new File([state.manualText], MANUAL_TEXT_NAME, { type: "text/plain" }) });
      for (const entry of entries) await uploadMaterial(state.job, entry, state.abortController.signal);
      reflectJob(await apiRequest(`/api/jobs/${state.job.id}/start`, { method: "POST", body: {} }));
      pollJob(state.job.id);
    } catch (error) {
      state.busy = false;
      state.analysisError = error.name === "AbortError" ? "Загрузка приостановлена. Нажмите «Продолжить загрузку», чтобы передать оставшуюся часть." : userFacingError(error);
      state.progressPhase = "error";
    } finally { state.abortController = null; await refreshJobs(); render(); }
  }

  async function showJobResult() {
    const id = state.job.id;
    const payload = await apiRequest(`/api/jobs/${id}/result`);
    if (state.job?.id !== id) return;
    state.proposal = { draft: payload.proposal, evidence: payload.evidence || [], warnings: payload.warnings || [], unknowns: payload.unknowns || [] };
    state.processingInfo = payload.processing; state.mergeMode = payload.mergeMode;
    initializeSelection(); state.step = 3; render();
  }

  async function submitClarifications(proceedWithUnknowns) {
    if (!state.job || state.job.status !== "clarification" || state.clarificationSubmitting) return;
    const questions = (state.job.clarifications || []).slice(0, 3);
    state.clarificationErrors = new Set(proceedWithUnknowns ? [] : questions.filter((question) => !String(state.clarificationAnswers[question.id] || "").trim()).map((question) => question.id));
    if (state.clarificationErrors.size) {
      render();
      global.queueMicrotask(() => refs.body.querySelector('[data-ai-clarification][aria-invalid="true"]')?.focus());
      return;
    }
    const id = state.job.id;
    state.clarificationSubmitting = true; state.analysisError = ""; render();
    try {
      const answers = questions.map((question) => ({ id: question.id, answer: String(state.clarificationAnswers[question.id] || "").trim() })).filter((answer) => answer.answer);
      const job = await apiRequest(`/api/jobs/${id}/clarifications`, { method: "POST", body: { answers, proceedWithUnknowns } });
      if (state.job?.id !== id) return;
      reflectJob(job);
      if (jobBusy(job)) pollJob(id);
    } catch (error) {
      if (state.job?.id === id) state.analysisError = userFacingError(error, "Не удалось сохранить уточнения. Ответы остались в полях; повторите отправку или обновите статус.");
    } finally {
      state.clarificationSubmitting = false; render();
    }
  }

  async function downloadJobResult() {
    const result = await apiRequest(`/api/jobs/${state.job.id}/result`);
    const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = `SIREN-результат-${state.job.id.slice(0, 8)}.json`; link.click();
    global.setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function resolvablePiiFindings() { return state.piiFindings.filter((finding) => !finding.blocking); }
  function canConfirmPii() { return state.piiPreflightReady; }

  function continueWithoutChanges() {
    state.proposal = {
      draft: { schemaVersion: 4, title: "", releaseDate: "", rolloutMode: "", rolloutConditions: "", groups: [], support: { say: "", dontSay: "", details: "", faq: [] } },
      evidence: [],
      warnings: [state.analysisError || "ИИ не вернул пригодный результат. Черновик оставлен без изменений."],
      unknowns: []
    };
    state.analysisError = "";
    state.analysisErrorCode = "";
    state.canContinueWithoutChanges = false;
    state.progressPhase = "done";
    initializeSelection();
    state.step = 3;
    render();
  }

  async function applyProposal() {
    if (state.applying || !state.selectedPaths.size || !global.SirenApp || !global.SirenAIMerge) return;
    state.applying = true;
    state.analysisError = "";
    render();
    try {
      const current = global.SirenApp.getState();
      const plan = global.SirenAIMerge.planProposal(current, state.proposal.draft || {}, {
        mode: state.mergeMode,
        selectedPaths: state.selectedPaths,
        evidence: normalizedEvidence(state.proposal.evidence),
        sanitizeRichText: sanitizeText
      });
      state.undoSnapshot = clone(plan.undoSnapshot);
      await global.SirenApp.setState(plan.draft);
      state.applied = true;
      state.plan = plan;
      showUndoToast(state.undoSnapshot);
    } catch (error) {
      state.analysisError = userFacingError(error, "Не удалось применить предложения. Проверьте выбранные поля и повторите попытку.");
    } finally {
      state.applying = false;
      render();
    }
  }

  function showUndoToast(snapshot) {
    const region = document.getElementById("toastRegion");
    if (!region || !snapshot) return;
    region.querySelectorAll(".ai-undo-toast").forEach((item) => item.remove());
    const toast = el("div", "toast ai-undo-toast");
    toast.setAttribute("role", "status");
    const text = el("span", "", "Предложения ИИ применены к выбранным полям.");
    const undo = button("Отменить", "button small tertiary", "undo");
    undo.addEventListener("click", async () => {
      undo.disabled = true;
      try {
        await global.SirenApp.setState(clone(snapshot));
        state.applied = false;
        state.undoSnapshot = null;
        toast.remove();
        if (refs.dialog && refs.dialog.open) {
          state.analysisError = "Изменения ИИ отменены. Черновик восстановлен.";
          render();
        }
      } catch (_error) {
        undo.disabled = false;
        text.textContent = "Не удалось отменить изменения.";
      }
    });
    toast.append(text, undo);
    region.append(toast);
    global.setTimeout(() => { if (toast.isConnected) toast.remove(); }, 15000);
  }

  function contourLabel(kind) {
    if (kind === "local") return "Локально";
    if (kind === "corporate") return "Корпоративный контур";
    return "Публичное облако";
  }

  function statusCallout(tone, title, message) {
    const box = el("section", `ai-callout ai-callout-${tone}`);
    box.setAttribute("role", tone === "error" ? "alert" : "status");
    const icon = el("span", "ai-callout-icon", tone === "success" ? "✓" : tone === "warning" ? "!" : tone === "error" ? "×" : "i");
    icon.setAttribute("aria-hidden", "true");
    const copy = el("div");
    copy.append(el("h3", "", title), el("p", "", message));
    box.append(icon, copy);
    return box;
  }

  function settingInput(key, type, placeholder) {
    const input = el("input");
    input.type = type || "text";
    input.value = currentSettings()[key] ?? "";
    input.placeholder = placeholder || "";
    input.dataset.aiSetting = key;
    input.autocomplete = "off";
    input.spellcheck = false;
    return input;
  }

  function renderConnection() {
    const fragment = document.createDocumentFragment();
    if (state.loadingServer) {
      fragment.append(statusCallout("info", "Подключаем локальный модуль", "Проверяем защищённый сеанс и доступные провайдеры…"));
    } else if (!state.online) {
      const offline = statusCallout("error", "Локальный модуль недоступен", state.serverError || "Запустите Siren AI через run_app.bat.");
      const retry = button("Повторить проверку", "button secondary", "retry-server");
      offline.lastElementChild.append(retry);
      fragment.append(offline);
    } else {
      fragment.append(statusCallout("success", "Локальный модуль готов", "Ключи и материалы передаются провайдеру только через локальный сервер Siren AI."));
    }

    const curl = el("details", "details-panel ai-curl-import");
    curl.append(el("summary", "", "Заполнить подключение из cURL"));
    const curlBody = el("div", "details-panel-body");
    const curlInput = el("textarea", "ai-curl-input"); curlInput.id = "aiCurlInput"; curlInput.rows = 5; curlInput.maxLength = 262144; curlInput.value = state.curlText; curlInput.spellcheck = false; curlInput.autocomplete = "off";
    curlInput.addEventListener("input", () => { state.curlText = curlInput.value; });
    curlBody.append(field("Пример cURL", curlInput, "Вставьте одну команду из документации API. Она не выполняется. Текст команды очищается после импорта; секрет переносится в защищённое поле токена."));
    curlBody.append(button("Заполнить поля", "button secondary", "import-curl"));
    curl.append(curlBody); fragment.append(curl);
    if (state.curlWarnings.length) fragment.append(statusCallout("warning", "Проверьте импорт", state.curlWarnings.join(" ")));
    const layout = el("div", "ai-connection-layout");
    const main = el("section", "ai-panel");
    main.append(el("h3", "ai-section-title", "Провайдер и модель"));

    const providerSelect = el("select");
    providerSelect.id = "aiProviderSelect";
    providerSelect.dataset.aiSetting = "providerId";
    state.providers.forEach((provider) => {
      const option = el("option", "", provider.name);
      option.value = provider.id;
      option.selected = provider.id === state.providerId;
      providerSelect.append(option);
    });
    main.append(field("ИИ-провайдер", providerSelect, "Можно переключать провайдеры без перезапуска программы."));

    const settings = currentSettings();
    const provider = providerById(state.providerId);
    const scopeBadge = el("p", `ai-contour-badge ai-contour-${providerKind()}`, contourLabel(providerKind()));
    main.append(scopeBadge);

    const baseUrl = settingInput("baseUrl", "url", provider.kind === "corporate" ? "https://ai-gateway.company.local" : "https://api.example.com/v1");
    main.append(field(provider.id === "custom-webhook" ? "URL webhook" : "Базовый URL API", baseUrl, "Для встроенных облачных провайдеров можно оставить адрес по умолчанию."));

    const model = settingInput("model", "text", provider.id === "custom-webhook" ? "Необязательно" : "Название модели");
    main.append(field(provider.id === "custom-webhook" ? "Модель (необязательно)" : "Модель", model));

    const tokenWrap = el("div", "ai-token-row");
    const tokenPlaceholder = settings.credentialStored
      ? settings.credentialRemembered
        ? "Секрет сохранён через Windows DPAPI"
        : "Секрет доступен до закрытия программы"
      : "Вставьте токен";
    const token = settingInput("token", "password", tokenPlaceholder);
    token.id = "aiProviderToken";
    token.setAttribute("aria-describedby", "aiTokenHint");
    const toggle = button("Показать", "button secondary ai-token-toggle", "toggle-token");
    toggle.setAttribute("aria-controls", token.id);
    toggle.setAttribute("aria-pressed", "false");
    tokenWrap.append(token, toggle);
    const tokenField = field(provider.id === "gigachat" ? "Ключ авторизации" : provider.id === "corporate-qwen" ? "X-Client-Token" : "Токен доступа", tokenWrap);
    const tokenHint = el("p", "field-help", settings.credentialStored
      ? settings.credentialRemembered
        ? "Секрет защищён Windows DPAPI; сервер не возвращает его в интерфейс."
        : "Секрет хранится только в памяти локального сервера до закрытия программы."
      : "Секрет не записывается в черновик, материалы или журналы.");
    tokenHint.id = "aiTokenHint";
    tokenField.append(tokenHint);
    main.append(tokenField);

    const rememberLabel = el("label", "ai-check-row");
    const remember = el("input");
    remember.type = "checkbox";
    remember.checked = settings.remember;
    remember.dataset.aiSetting = "remember";
    rememberLabel.append(remember, el("span", "", "Запомнить секрет на этом компьютере через Windows DPAPI"));
    main.append(rememberLabel);

    if (settings.credentialStored) {
      const removeSecret = button("Удалить сохранённый секрет", "button danger-ghost", "delete-credential");
      main.append(removeSecret);
    }

    const advanced = el("details", "details-panel ai-advanced");
    const summary = el("summary", "", "Дополнительные параметры API");
    const advancedBody = el("div", "details-panel-body ai-advanced-grid");

    const authType = el("select");
    authType.dataset.aiSetting = "authType";
    [
      ["bearer", "Bearer token"], ["api-key", "API key"], ["x-api-key", "X-API-Key"],
      ["oauth-basic", "OAuth 2.0 + Basic"], ["basic", "Basic"], ["none", "Без авторизации"], ["custom-header", "Свой заголовок"]
    ].forEach(([value, name]) => {
      const option = el("option", "", name);
      option.value = value;
      option.selected = settings.authType === value;
      authType.append(option);
    });
    advancedBody.append(field("Способ авторизации", authType));
    advancedBody.append(field("Маршрут анализа", settingInput("chatPath", "text", "/chat/completions")));
    advancedBody.append(field("Маршрут списка моделей", settingInput("modelsPath", "text", "/models")));
    advancedBody.append(field("Заголовок с токеном", settingInput("tokenHeader", "text", "Authorization")));
    const temperature = settingInput("temperature", "number", "0.1"); temperature.min = "0"; temperature.max = "2"; temperature.step = "0.1";
    advancedBody.append(field("Температура", temperature, "Необязательно. Низкие значения уменьшают вариативность; для Ollama используется 0."));
    const maxTokens = settingInput("maxTokens", "number", "4096"); maxTokens.min = "256"; maxTokens.max = "8192"; maxTokens.step = "1";
    advancedBody.append(field("Максимум токенов ответа", maxTokens, "До 8192; для локальной Ollama — до 1200 на ответ. Большой материал обрабатывается несколькими запросами."));
    if (provider.id === "gigachat") {
      advancedBody.append(field("URL получения OAuth-токена", settingInput("oauthUrl", "url", "https://…/api/v2/oauth")));
      const scope = el("select");
      scope.dataset.aiSetting = "scope";
      ["GIGACHAT_API_PERS", "GIGACHAT_API_B2B", "GIGACHAT_API_CORP"].forEach((value) => {
        const option = el("option", "", value);
        option.value = value;
        option.selected = settings.scope === value;
        scope.append(option);
      });
      advancedBody.append(field("OAuth scope", scope, "Выберите scope, выданный для ключа GigaChat."));
    }
    if (["yandexgpt", "gigachat", "corporate-qwen", "custom-openai", "custom-webhook"].includes(provider.id)) {
      advancedBody.append(field(provider.id === "yandexgpt" ? "Folder ID / каталог" : "Идентификатор проекта / клиента", settingInput("tenantId", "text", "Если требуется провайдером")));
    }
    if (["anthropic", "custom-openai", "custom-webhook"].includes(provider.id)) {
      advancedBody.append(field("Версия API", settingInput("apiVersion", "text", "Если требуется")));
    }
    if (provider.id === "custom-webhook") {
      const method = el("input");
      method.type = "text";
      method.value = "POST";
      method.readOnly = true;
      advancedBody.append(field("HTTP-метод", method, "Webhook вызывается только безопасным POST-запросом."));
      advancedBody.append(field("Имя собственного заголовка", settingInput("customHeaderName", "text", "X-API-Key"), "Используется при способе авторизации «Свой заголовок»."));
      advancedBody.append(field("Путь к предложению в JSON-ответе", settingInput("responsePath", "text", "proposal"), "Точечная запись, например result.proposal."));
      const contract = el("div", "ai-webhook-contract");
      contract.append(el("strong", "", "Безопасный контракт webhook"));
      contract.append(el("p", "", "Siren AI отправляет POST JSON с моделью, извлечёнными материалами, текущим черновиком и режимом объединения. В ответе ожидается объект proposal с draft, evidence, warnings и unknowns."));
      const example = el("code", "", '{ "proposal": { "draft": { … }, "evidence": { … }, "warnings": [], "unknowns": [] } }');
      contract.append(example);
      advancedBody.append(contract);
    }
    if (provider.kind === "custom") {
      const scope = el("select");
      scope.dataset.aiSetting = "dataBoundary";
      [["public", "Публичное облако"], ["corporate", "Корпоративный контур"], ["local", "Локальный API"]].forEach(([value, name]) => {
        const option = el("option", "", name);
        option.value = value;
        option.selected = settings.dataBoundary === value;
        scope.append(option);
      });
      advancedBody.prepend(field("Граница обработки данных", scope, "Обязательный выбор: от него зависит блокировка персональных данных."));
    }
    advanced.append(summary, advancedBody);
    main.append(advanced);
    const processing = el("section", "ai-processing-settings"); processing.append(el("h3", "ai-section-title", "Обработка больших материалов"));
    const processingGrid = el("div", "ai-advanced-grid");
    for (const [key, label, min, max, hint] of [
      ["requestTimeoutMinutes", "Время ожидания одного ответа, минут", 1, 60, "Для локальной модели начните с 10 минут. Увеличение ожидания не ускоряет модель."],
      ["totalTimeoutMinutes", "Общий лимит, минут", 0, 10080, "0 — без общего лимита. Каждый запрос всё равно ограничен временем ожидания; обработку можно приостановить."],
      ["retryCount", "Повторы при временном сбое", 0, 3, "Повторяется только незавершённый этап. После таймаута большой текст разбивается на меньшие части."],
      ["chunkChars", "Размер текстовой части, символов", 400, 8000, "Для CPU: 800–1400. Маленькие части требуют больше запросов, но меньше памяти на один запрос."]
    ]) {
      const input = settingInput(key, "number", ""); input.min = min; input.max = max; input.step = "1";
      processingGrid.append(field(label, input, hint));
    }
    const imageMode = el("select"); imageMode.dataset.aiSetting = "imageMode";
    for (const [value, label] of [["auto", "Автоматически: изображение, при сбое — OCR"], ["vision", "Изображение целиком: нужна зрительная модель"], ["ocr", "Только распознанный текст: меньше нагрузка"]]) { const option = el("option", "", label); option.value = value; option.selected = settings.imageMode === value; imageMode.append(option); }
    processingGrid.append(field("Как обрабатывать изображения", imageMode, "OCR читает надписи, но не оценивает цвет, расположение элементов и графику. Такие результаты отмечаются для ручной проверки."));
    processing.append(processingGrid); main.append(processing);
    if (state.job && !jobBusy(state.job) && state.job.providerId === state.providerId) main.append(button("Сохранить настройки для продолжения", "button secondary", "update-job-settings"));

    const aside = el("aside", "ai-panel ai-security-panel");
    aside.append(el("p", "eyebrow", "Контроль данных"));
    if (isPublicProvider()) {
      aside.append(el("h3", "", "Только обезличенные материалы"));
      aside.append(el("p", "", "Перед отправкой локальная проверка ищет возможные ФИО, телефоны, почту, реквизиты и другие признаки персональных данных."));
      const list = el("ul");
      ["Передача блокируется до проверки находок", "Нужно отдельно подтвердить отсутствие персональных данных", "При сомнении выберите локальный или корпоративный контур"].forEach((text) => list.append(el("li", "", text)));
      aside.append(list);
    } else {
      aside.append(el("h3", "", "Данные остаются в выбранном контуре"));
      aside.append(el("p", "", "Siren AI всё равно покажет найденные признаки персональных данных, но не будет блокировать локальную или корпоративную обработку."));
    }
    const test = button(state.connectionTesting ? "Проверяем…" : "Проверить подключение", "button secondary", "test-connection");
    test.disabled = !state.online || state.loadingServer || state.connectionTesting;
    aside.append(test);
    if (state.connectionStatus) {
      const connectionCallout = statusCallout(state.connectionStatus.tone, state.connectionStatus.title || (state.connectionStatus.tone === "success" ? "Готово" : state.connectionStatus.tone === "error" ? "Не удалось подключиться" : "Проверка"), state.connectionStatus.message);
      connectionCallout.dataset.aiConnectionStatus = "";
      aside.append(connectionCallout);
    }

    layout.append(main, aside);
    fragment.append(layout);
    return fragment;
  }

  function refreshMaterialIndicators() {
    if (refs.materialCounter && refs.materialCounter.isConnected) {
      refs.materialCounter.textContent = `${materialCountLabel()} · ${formatBytes(totalMaterialBytes())}`;
    }
    if (refs.manualTextCounter && refs.manualTextCounter.isConnected) {
      refs.manualTextCounter.textContent = `${state.manualText.length.toLocaleString("ru-RU")} из ${MAX_MANUAL_TEXT_CHARS.toLocaleString("ru-RU")} символов`;
    }
    if (refs.materialEmpty && refs.materialEmpty.isConnected) refs.materialEmpty.hidden = hasMaterials();
    if (refs.materialLimit && refs.materialLimit.isConnected) {
      const message = materialLimitError();
      refs.materialLimit.hidden = !message;
      refs.materialLimit.textContent = message;
    }
    renderFooter();
  }

  function resizeManualTextArea(target) {
    if (!target) return;
    target.style.height = "auto";
    const height = Math.min(Math.max(target.scrollHeight, 168), 340);
    target.style.height = `${height}px`;
    target.style.overflowY = target.scrollHeight > 340 ? "auto" : "hidden";
  }

  function handleManualTextInput(target) {
    state.manualText = String(target.value || "").replace(/\r\n?/g, "\n").replace(/\u0000/g, "").slice(0, MAX_MANUAL_TEXT_CHARS);
    if (target.value !== state.manualText) target.value = state.manualText;
    resetAnalysis();
    const staleError = refs.body && refs.body.querySelector(".ai-material-action-error");
    if (staleError) staleError.remove();
    resizeManualTextArea(target);
    refreshMaterialIndicators();
  }

  function handleBriefInput(target) {
    const key = target.dataset.aiBrief;
    if (!["topic", "include", "exclude"].includes(key)) return;
    state.brief[key] = String(target.value || "").replace(/\r\n?/g, "\n").replace(/\u0000/g, "").slice(0, MAX_BRIEF_CHARS);
    if (target.value !== state.brief[key]) target.value = state.brief[key];
    resetAnalysis();
    if (key === "topic" && state.brief.topic.trim()) {
      state.briefError = "";
      target.removeAttribute("aria-invalid");
      const error = document.getElementById("aiBriefTopicError");
      if (error) { error.hidden = true; error.textContent = ""; }
    }
    const counter = document.getElementById(`${target.id}-counter`);
    if (counter) counter.textContent = `${state.brief[key].length.toLocaleString("ru-RU")} из ${MAX_BRIEF_CHARS.toLocaleString("ru-RU")} символов`;
    resizeTaskTextarea(target);
    renderFooter();
  }

  function resizeTaskTextarea(target) {
    if (!target) return;
    target.style.height = "auto";
    const maximum = 240;
    target.style.height = `${Math.min(Math.max(target.scrollHeight, 88), maximum)}px`;
    target.style.overflowY = target.scrollHeight > maximum ? "auto" : "hidden";
  }

  function renderBrief() {
    const panel = el("section", "ai-panel ai-brief-panel");
    panel.setAttribute("aria-labelledby", "aiBriefHeading");
    const heading = el("h3", "ai-section-title", "Задача для ИИ"); heading.id = "aiBriefHeading";
    panel.append(heading, el("p", "field-help", "Опишите нужное изменение. ИИ отберёт факты по этой теме, уточнит существенные пробелы и подготовит инструкцию для сотрудника КЦ и текст для клиента."));
    const fields = [
      { key: "topic", id: "aiBriefTopic", label: "О чём нужна инструкция — обязательно", hint: "Укажите продукт, экран и изменение. До 1500 символов.", placeholder: "Какое изменение нужно объяснить сотруднику и клиенту?" },
      { key: "include", id: "aiBriefInclude", label: "Что обязательно раскрыть", hint: "Необязательно. Вопросы, условия и ограничения, которые нужно найти в материалах.", placeholder: "Например: как было, что изменилось, ограничения и польза для клиента." },
      { key: "exclude", id: "aiBriefExclude", label: "Что не включать", hint: "Необязательно. Перечислите соседние темы и изменения, которые здесь не нужны.", placeholder: "Какие разделы материалов не относятся к задаче?" }
    ];
    for (const descriptor of fields) {
      const input = el("textarea", "ai-task-textarea");
      input.id = descriptor.id; input.rows = 3; input.maxLength = MAX_BRIEF_CHARS;
      input.value = state.brief[descriptor.key]; input.placeholder = descriptor.placeholder;
      input.spellcheck = true; input.autocomplete = "off"; input.dataset.aiBrief = descriptor.key;
      if (descriptor.key === "topic") input.setAttribute("aria-required", "true");
      const wrapper = field(descriptor.label, input, descriptor.hint);
      const counter = el("p", "ai-character-counter", `${input.value.length.toLocaleString("ru-RU")} из ${MAX_BRIEF_CHARS.toLocaleString("ru-RU")} символов`);
      counter.id = `${descriptor.id}-counter`; wrapper.append(counter);
      const describedBy = [`${descriptor.id}-help`, counter.id];
      if (descriptor.key === "topic") {
        const error = el("p", "ai-error-copy", state.briefError); error.id = "aiBriefTopicError"; error.hidden = !state.briefError;
        error.setAttribute("role", "alert"); wrapper.append(error); describedBy.push(error.id);
        if (state.briefError) input.setAttribute("aria-invalid", "true");
      }
      input.setAttribute("aria-describedby", describedBy.join(" "));
      panel.append(wrapper);
    }
    panel.append(el("p", "field-help", "Структура сохранится: «Было / Стало / Действия / Подсказки». Задание задаёт тему; факты ИИ берёт из материалов ниже. Задание сохранится вместе с обработкой после её запуска."));
    return panel;
  }

  function renderMaterials() {
    const fragment = document.createDocumentFragment();
    const privacy = isPublicProvider()
      ? statusCallout("warning", "Публичный облачный ИИ", "Не добавляйте персональные данные. Перед отправкой Siren AI выполнит локальную проверку и потребует подтверждение.")
      : statusCallout("info", contourLabel(providerKind()), "Материалы будут обработаны в выбранном локальном или корпоративном контуре.");
    fragment.append(privacy);
    fragment.append(renderBrief());

    const mergePanel = el("section", "ai-panel");
    mergePanel.append(el("h3", "ai-section-title", "Как заполнить черновик"));
    const choices = el("div", "ai-choice-grid");
    [
      { value: "fill-empty", title: "Заполнить пустые поля", text: "Рекомендуется: введённый текст и скриншоты останутся без изменений." },
      { value: "replace-selected", title: "Предложить замены", text: "ИИ покажет отличия, но заменит только поля, которые вы отметите на проверке." }
    ].forEach((choice) => {
      const label = el("label", `ai-choice-card${state.mergeMode === choice.value ? " is-selected" : ""}`);
      const input = el("input");
      input.type = "radio";
      input.name = "aiMergeMode";
      input.value = choice.value;
      input.checked = state.mergeMode === choice.value;
      input.dataset.aiMergeMode = "";
      const copy = el("span");
      copy.append(el("strong", "", choice.title), el("small", "", choice.text));
      label.append(input, copy);
      choices.append(label);
    });
    mergePanel.append(choices);
    fragment.append(mergePanel);

    const uploadPanel = el("section", "ai-panel");
    const uploadHead = el("div", "ai-section-head");
    const copy = el("div");
    copy.append(el("h3", "ai-section-title", "Материалы для анализа"), el("p", "", "Скриншоты, документация, таблицы и текстовые файлы."));
    const counter = el("span", "ai-file-counter", `${materialCountLabel()} · ${formatBytes(totalMaterialBytes())}`);
    refs.materialCounter = counter;
    uploadHead.append(copy, counter);
    uploadPanel.append(uploadHead);

    const drop = el("div", "ai-drop-zone");
    drop.tabIndex = 0;
    drop.dataset.aiDropZone = "";
    drop.setAttribute("role", "button");
    drop.setAttribute("aria-label", "Добавить материалы для анализа");
    const fileInput = el("input", "visually-hidden");
    fileInput.type = "file";
    fileInput.multiple = true;
    fileInput.accept = ACCEPT_VALUE;
    fileInput.id = "aiMaterialPicker";
    fileInput.dataset.aiFileInput = "";
    const pickerLabel = el("label", "button secondary ai-picker-button", "Выбрать файлы");
    pickerLabel.htmlFor = fileInput.id;
    drop.append(el("span", "ai-drop-icon", "+"), el("strong", "", "Перетащите файлы сюда"), el("span", "", "или выберите их на компьютере"), pickerLabel, fileInput);
    uploadPanel.append(drop);
    uploadPanel.append(el("p", "field-help ai-format-help", "PNG, JPG, WebP, PDF, DOCX, PPTX, XLSX, CSV, TXT и Markdown · до 100 МБ на файл, до 10 ГБ и 2000 материалов в одной обработке"));

    const divider = el("div", "ai-material-divider");
    divider.append(el("span", "", "или вставьте текст"));
    uploadPanel.append(divider);

    const textMaterial = el("div", "ai-text-material");
    const textHead = el("div", "ai-text-material-head");
    const textTitle = el("div");
    const textLabel = el("label", "ai-text-material-label", "Текстовый материал");
    textLabel.htmlFor = "aiManualText";
    textTitle.append(textLabel, el("p", "", "Исходные факты и описание продукта. Задачу для ИИ задайте в отдельном поле выше."));
    const textCounter = el("span", "ai-character-counter", `${state.manualText.length.toLocaleString("ru-RU")} из ${MAX_MANUAL_TEXT_CHARS.toLocaleString("ru-RU")} символов`);
    textCounter.id = "aiManualTextCounter";
    refs.manualTextCounter = textCounter;
    textHead.append(textTitle, textCounter);

    const textarea = el("textarea", "ai-material-textarea");
    textarea.id = "aiManualText";
    textarea.rows = 7;
    textarea.maxLength = MAX_MANUAL_TEXT_CHARS;
    textarea.value = state.manualText;
    textarea.placeholder = "Вставьте описание изменений, условия запуска, подсказки для сотрудников или другой текст для анализа.";
    textarea.spellcheck = true;
    textarea.autocomplete = "off";
    textarea.dataset.aiManualText = "";
    textarea.setAttribute("aria-describedby", "aiManualTextHelp aiManualTextCounter");
    const textHelp = el("p", "field-help", "Текст проходит ту же локальную проверку персональных данных, что и файлы, и считается одним материалом.");
    textHelp.id = "aiManualTextHelp";
    textMaterial.append(textHead, textarea, textHelp);
    uploadPanel.append(textMaterial);

    const materialLimit = el("p", "ai-material-limit");
    materialLimit.setAttribute("role", "alert");
    const limitMessage = materialLimitError();
    materialLimit.hidden = !limitMessage;
    materialLimit.textContent = limitMessage;
    refs.materialLimit = materialLimit;
    uploadPanel.append(materialLimit);

    const empty = el("div", "ai-empty-state");
    empty.hidden = hasMaterials();
    empty.append(el("strong", "", "Материалы ещё не добавлены"), el("p", "", "Добавленные файлы и введённый текст остаются в памяти только на время работы."));
    refs.materialEmpty = empty;
    uploadPanel.append(empty);

    if (state.files.length) {
      const list = el("div", "ai-file-list");
      state.files.forEach((entry) => {
        const item = el("article", "ai-file-item");
        item.dataset.fileId = entry.id;
        const icon = el("span", "ai-file-icon", extensionOf(entry.file.name).toUpperCase());
        const details = el("div", "ai-file-copy");
        details.append(el("strong", "", entry.file.name));
        const status = entry.status === "reading" ? "Подготовка…" : entry.status === "error" ? entry.error || "Ошибка" : "Готов к анализу";
        details.append(el("span", entry.status === "error" ? "ai-file-status is-error" : "ai-file-status", `${formatBytes(entry.file.size)} · ${status}`));
        const role = el("select", "ai-file-role");
        role.dataset.aiFileRole = entry.id;
        role.setAttribute("aria-label", `Роль файла ${entry.file.name}`);
        [["documentation", "Документация"], ["screen", "Скриншот интерфейса"], ["before", "Экран «Было»"], ["after", "Экран «Стало»"], ["scheme", "Схема"], ["context", "Дополнительный контекст"]].forEach(([value, name]) => {
          const option = el("option", "", name);
          option.value = value;
          option.selected = entry.role === value;
          role.append(option);
        });
        const remove = button("×", "icon-button danger", "remove-file");
        remove.dataset.fileId = entry.id;
        remove.setAttribute("aria-label", `Удалить ${entry.file.name}`);
        item.append(icon, details, role, remove);
        list.append(item);
      });
      uploadPanel.append(list);
    }
    fragment.append(uploadPanel);
    if (state.analysisError) {
      const error = statusCallout("error", "Проверьте материалы", state.analysisError);
      error.classList.add("ai-material-action-error");
      fragment.append(error);
    }
    return fragment;
  }

  function progressItem(label, status, detail) {
    const item = el("li", `ai-progress-item is-${status}`);
    const marker = el("span", "ai-progress-marker", status === "complete" ? "✓" : status === "active" ? "•" : status === "error" ? "×" : "");
    marker.setAttribute("aria-hidden", "true");
    const copy = el("div");
    copy.append(el("strong", "", label));
    if (detail) copy.append(el("span", "", detail));
    item.append(marker, copy);
    return item;
  }

  function renderPiiReview() {
    const box = el("section", "ai-pii-review");
    box.append(el("p", "eyebrow", "Локальная проверка"));
    if (state.piiFindings.length) {
      box.append(el("h3", "", "Возможные персональные данные найдены"));
      box.append(el("p", "", "Проверьте список. Можно исправить материалы, отметить ложные срабатывания или осознанно продолжить отправку без дополнительных отметок."));
      const resolvable = resolvablePiiFindings();
      if (resolvable.length) {
        const resolvedCount = resolvable.filter((finding) => state.resolvedPii.has(finding.id)).length;
        const bulk = el("div", "ai-pii-bulk");
        const bulkLabel = el("label", "ai-check-row");
        const bulkCheck = el("input");
        bulkCheck.type = "checkbox";
        bulkCheck.checked = resolvedCount === resolvable.length;
        bulkCheck.indeterminate = resolvedCount > 0 && resolvedCount < resolvable.length;
        bulkCheck.dataset.aiPiiResolveAll = "";
        const bulkCopy = el("span");
        bulkCopy.append(
          el("strong", "", `Отметить все как проверенные (${resolvable.length})`),
          el("small", "", "Используйте только после просмотра списка. Неполностью проверенные материалы так отметить нельзя.")
        );
        bulkLabel.append(bulkCheck, bulkCopy);
        bulk.append(bulkLabel);
        box.append(bulk);
      }
      const list = el("div", "ai-pii-list");
      state.piiFindings.forEach((finding) => {
        const item = el("article", "ai-pii-item");
        const copy = el("div");
        copy.append(el("strong", "", finding.category));
        copy.append(el("span", "", [finding.fileName, finding.location].filter(Boolean).join(" · ")));
        if (finding.preview) copy.append(el("code", "", finding.preview));
        item.append(copy);
        if (finding.blocking) {
          item.classList.add("is-blocking");
          item.append(el("p", "ai-pii-blocking-note", "Этот материал не удалось проверить полностью. Надёжнее заменить его читаемой версией или выбрать локальный/корпоративный ИИ; продолжить можно только после явного подтверждения риска."));
        } else {
          const checkLabel = el("label", "ai-check-row");
          const check = el("input");
          check.type = "checkbox";
          check.checked = state.resolvedPii.has(finding.id);
          check.dataset.aiPiiResolved = finding.id;
          checkLabel.append(check, el("span", "", "Проверено: это ложное срабатывание, персональных данных нет"));
          item.append(checkLabel);
        }
        if (finding.fileId && state.files.some((entry) => entry.id === finding.fileId)) {
          const remove = button("Удалить файл", "button danger-ghost small", "remove-pii-file");
          remove.dataset.fileId = finding.fileId;
          item.append(remove);
        } else if (finding.fileId === MANUAL_TEXT_ID) {
          item.append(button("Изменить текст", "button secondary small", "edit-pii-text"));
        }
        list.append(item);
      });
      box.append(list);
    } else {
      box.append(el("h3", "", "Явные признаки не найдены"));
      box.append(el("p", "", "Автоматическая проверка может ошибаться. Просмотрите материалы самостоятельно перед подтверждением."));
    }

    const confirm = el("label", `ai-confirm-card${canConfirmPii() ? "" : " is-disabled"}`);
    const checkbox = el("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.confirmedNoPersonalData;
    checkbox.disabled = !canConfirmPii();
    checkbox.dataset.aiConfirmNoPii = "";
    confirm.append(checkbox, el("span", "", state.piiFindings.length
      ? "Я просмотрел предупреждения, понимаю риск передачи данных и разрешаю отправить материалы в выбранный публичный ИИ"
      : "Я просмотрел материалы и разрешаю отправить их в выбранный публичный ИИ"));
    box.append(confirm);
    return box;
  }

  const JOB_LABELS = { uploading: "Загрузка", queued: "В очереди", preparing: "Подготовка", running: "Обработка", paused: "Приостановлено", confirmation: "Нужно подтверждение", clarification: "Нужно уточнение", partial: "Готово частично", complete: "Готово", failed: "Нужно исправить ошибку" };

  function renderBriefSummary(brief) {
    const section = el("section", "ai-panel ai-brief-summary");
    section.append(el("h3", "ai-section-title", "Задача для ИИ"));
    section.append(el("p", "ai-preserve-lines", sanitizeText(brief.topic)));
    for (const [key, title] of [["include", "Раскрыть"], ["exclude", "Не включать"]]) {
      if (!brief[key]) continue;
      const row = el("p", "ai-preserve-lines"); row.append(el("strong", "", `${title}: `), document.createTextNode(sanitizeText(brief[key]))); section.append(row);
    }
    section.append(el("p", "field-help", "Для сотрудника КЦ и клиента · Было / Стало / Действия / Подсказки"));
    return section;
  }

  function renderClarifications() {
    const section = el("section", "ai-panel ai-clarifications");
    section.setAttribute("aria-labelledby", "aiClarificationsHeading");
    section.setAttribute("aria-busy", String(state.clarificationSubmitting));
    const heading = el("h3", "ai-section-title", "Короткие уточнения"); heading.id = "aiClarificationsHeading";
    section.append(heading, el("p", "field-help", "Ответьте на вопросы, которые влияют на инструкцию. Если ответа нет, продолжите с отметками о пробелах: ИИ не должен их придумывать."));
    for (const [index, question] of (state.job.clarifications || []).slice(0, 3).entries()) {
      const input = el("textarea", "ai-task-textarea");
      input.id = `aiClarification${index}`; input.rows = 3; input.maxLength = MAX_BRIEF_CHARS;
      input.value = state.clarificationAnswers[question.id] || "";
      input.dataset.aiClarification = question.id; input.disabled = state.clarificationSubmitting;
      input.placeholder = "Ваш ответ или уточнение по источнику"; input.autocomplete = "off";
      const wrapper = field(sanitizeText(question.question), input, sanitizeText(question.reason) || "Если не знаете ответа, оставьте поле пустым и выберите продолжение с пробелами.");
      const error = el("p", "ai-error-copy", "Ответьте на вопрос или выберите «Продолжить с пробелами».");
      error.id = `${input.id}-error`; error.hidden = !state.clarificationErrors.has(question.id); error.setAttribute("role", "alert");
      if (!error.hidden) input.setAttribute("aria-invalid", "true");
      input.setAttribute("aria-describedby", `${input.id}-help ${error.id}`);
      wrapper.append(error); section.append(wrapper);
    }
    section.append(el("p", "field-help", "Уточнения будут сохранены после нажатия кнопки. При внешнем подключении они проходят проверку перед отправкой, как и исходные материалы."));
    return section;
  }

  function renderJobHistory() {
    const section = el("section", "ai-job-history ai-panel");
    section.append(el("h3", "ai-section-title", "Сохранённые обработки"));
    section.append(el("p", "field-help", "Материалы и ответы сохраняются на этом компьютере до удаления обработки. Ключи API в них не записываются. После перезапуска можно продолжить с сохранённого этапа."));
    section.append(button("Обновить список", "button secondary", "jobs-refresh"));
    if (!state.jobs.length) section.append(el("p", "", "Здесь появятся начатые обработки."));
    const list = el("ul", "ai-job-list");
    for (const job of state.jobs) {
      const item = el("li", "ai-job-row");
      const copy = el("span");
      if (job.brief?.topic) copy.append(el("strong", "ai-job-topic", sanitizeText(job.brief.topic)));
      copy.append(document.createTextNode(`${JOB_LABELS[job.status] || job.status} · ${job.completed}/${job.total} · ${job.model || job.providerId} · ${new Date(job.createdAt).toLocaleString("ru-RU")}`));
      item.append(copy);
      const open = button("Открыть обработку", "button secondary small", "open-job"); open.dataset.jobId = job.id; item.append(open); list.append(item);
    }
    section.append(list);
    if (state.jobs.length < state.jobsTotal) section.append(button("Показать ещё", "button secondary", "jobs-more"));
    return section;
  }

  function renderJobError(error, job) {
    const recovery = error.recovery === "retry-unfinished";
    const card = statusCallout(recovery ? "warning" : "error", error.title || "Что произошло и как продолжить", error.message);
    card.classList.add("ai-job-recovery");
    const copy = card.lastElementChild;
    if (recovery) {
      const saved = job.completed > 0 || job.factsCount > 0 || job.hasResult;
      copy.append(el("p", "field-help", saved ? "Готовые результаты сохранены. Программа продолжит незавершённые этапы всех материалов и использует сохранённые ответы." : "Повтор использует сохранённые этапы, если они есть. Указывать номера строк или редактировать документ не требуется."));
      const actions = el("div", "ai-recovery-actions");
      const retry = button("Повторить незавершённое", "button secondary", "retry-analysis");
      retry.disabled = state.busy || jobBusy(job) || ["clarification", "confirmation"].includes(job.status);
      if (state.busy) retry.setAttribute("aria-busy", "true");
      actions.append(retry);
      if (job.hasResult) actions.append(button("Проверить готовое", "button secondary", "job-result"));
      if (!jobBusy(job)) actions.append(button("Настройки обработки", "button secondary", "job-settings"));
      actions.querySelectorAll("button").forEach((control) => { if (state.busy) control.disabled = true; });
      copy.append(actions);
      copy.append(el("p", "field-help", jobBusy(job) ? "Повтор станет доступен после завершения текущей обработки." : ["clarification", "confirmation"].includes(job.status) ? "Сначала завершите текущий шаг: ответьте на уточнения или подтвердите отправку." : "Если ошибка повторится, выберите другую модель в настройках и нажмите «Сохранить настройки для продолжения»."));
    }
    if (error.technicalDetails) {
      const details = el("details", "ai-error-details");
      details.append(el("summary", "", "Подробности для поддержки"), el("p", "ai-preserve-lines", error.technicalDetails));
      copy.append(details);
    }
    return card;
  }

  function renderDurableJob() {
    const job = state.job; const fragment = document.createDocumentFragment();
    const head = el("section", "ai-analysis-head"); head.append(el("p", "eyebrow", "Обработка с сохранением этапов"), el("h3", "", `${JOB_LABELS[job.status] || job.status} · ${job.model || job.providerId}`));
    head.append(el("p", "", "Можно закрыть это окно или обновить страницу: сервер продолжит работу. При выключении программы или компьютера обработка остановится; после запуска нажмите «Продолжить».")); fragment.append(head);
    if (job.brief?.topic) fragment.append(renderBriefSummary(job.brief));
    const progress = el("section", "ai-durable-progress"); progress.setAttribute("role", "status"); progress.setAttribute("aria-live", "polite");
    progress.append(el("strong", "", `${job.brief?.topic ? "Разобрано" : "Готово"} ${job.completed} из ${job.total} материалов`));
    const bar = el("progress"); bar.max = Math.max(1, job.total); bar.value = job.completed; bar.setAttribute("aria-label", "Завершённые материалы"); progress.append(bar);
    progress.append(el("p", "", job.progress?.message || "Ожидает запуска"));
    if (job.progress?.sourceName) progress.append(el("p", "ai-progress-source", job.progress.sourceName));
    if (job.progress?.parts) progress.append(el("p", "", `Часть ${job.progress.part} из ${job.progress.parts}`));
    if (job.progress?.requestStartedAt && jobBusy(job)) {
      const seconds = Math.max(0, Math.floor((Date.now() - job.progress.requestStartedAt) / 1000));
      progress.append(el("p", "field-help", `Текущий запрос: ${Math.floor(seconds / 60)} мин ${seconds % 60} с. Лимит: ${Math.ceil((job.progress.timeoutMs || 600000) / 60000)} мин.`));
    }
    fragment.append(progress);
    if (job.factsCount > 0 && !job.hasResult) fragment.append(el("p", "field-help", "Факты сохранены. Инструкция появится после объединения и проверки по выбранной теме."));
    if (job.status === "uploading" && !state.busy) {
      const input = el("input"); input.type = "file"; input.multiple = true; input.accept = ACCEPTED_EXTENSIONS.map((ext) => `.${ext}`).join(",");
      input.addEventListener("change", () => {
        state.files = Array.from(input.files).map((file) => ({ id: global.crypto.randomUUID(), file, role: defaultFileRole(file), status: "ready", error: "" }));
        state.analysisError = materialLimitError(); render();
      });
      fragment.append(field("Повторно выбрать исходные файлы", input, "После обновления страницы выберите весь исходный набор. Уже загруженные байты будут пропущены. Вставленный текст нужно добавить снова как TXT-файл, если он не успел загрузиться."));
      if (state.files.length) fragment.append(el("p", "field-help", `Выбрано файлов для продолжения: ${state.files.length}`));
    }
    if (job.status === "confirmation") fragment.append(renderPiiReview());
    if (job.status === "clarification") fragment.append(renderClarifications());
    if (state.analysisError) fragment.append(job.error?.message === state.analysisError ? renderJobError(job.error, job) : statusCallout("error", "Что произошло и как продолжить", state.analysisError));
    const list = el("ul", "ai-job-materials");
    if (job.files.some((file) => file.error?.recovery)) list.classList.add("has-recovery");
    for (const file of job.files) {
      const item = el("li", `ai-job-material is-${file.status}`);
      item.append(el("strong", "", file.name), el("span", "ai-material-state", file.error?.recovery === "retry-unfinished" ? "Нужна повторная обработка" : ({ complete: "Готово", partial: "Готово частично", failed: "Не завершено", running: "Обрабатывается", ready: "В очереди", uploading: "Загружается" })[file.status] || file.status));
      if (file.sectionsTotal > 1) item.append(el("p", "field-help", `Готово разделов: ${file.sectionsDone || 0} из ${file.sectionsTotal}`));
      if (file.error) item.append(renderJobError(file.error, job));
      for (const warning of file.warnings || []) item.append(el("p", "field-help", warning));
      list.append(item);
    }
    fragment.append(list);
    const actions = el("div", "ai-job-actions"); actions.append(button("Обновить статус", "button secondary", "job-refresh"));
    if (job.hasResult) actions.append(button("Скачать результат JSON", "button secondary", "job-download"));
    actions.append(button("Новая обработка", "button secondary", "job-new"));
    if (!jobBusy(job)) actions.append(button("Удалить обработку…", "button danger-ghost", "job-delete"));
    if (state.busy || state.clarificationSubmitting) actions.querySelectorAll("button").forEach((control) => { control.disabled = true; });
    fragment.append(actions);
    if (state.deleteJobPending) {
      const confirmation = statusCallout("warning", "Удалить материалы и результаты этой обработки?", "Сохранённые копии и этапы будут удалены с компьютера. Исходные файлы останутся на месте. Отменить удаление нельзя.");
      confirmation.append(button("Оставить", "button secondary", "job-delete"), button("Удалить материалы и результаты", "button danger", "job-delete-confirm")); fragment.append(confirmation);
    }
    return fragment;
  }

  function renderAnalysis() {
    if (state.job) return renderDurableJob();
    const fragment = document.createDocumentFragment();
    const provider = providerById(state.providerId);
    const heading = el("section", "ai-analysis-head");
    heading.append(el("p", "eyebrow", "Обработка материалов"), el("h3", "", `${provider.name} · ${currentSettings().model || "модель провайдера"}`));
    const message = state.busy ? "Не закрывайте программу. Можно отменить запрос — исходный черновик не изменится." : "Черновик изменится только после вашей проверки и явного применения выбранных полей.";
    heading.append(el("p", "", message));
    fragment.append(heading);

    const progress = el("ol", "ai-progress-list");
    const preparingDone = ["server", "confirmation", "done", "error"].includes(state.progressPhase);
    const serverDone = state.progressPhase === "done";
    const activePrepare = state.progressPhase === "preparing";
    const activeServer = state.progressPhase === "server";
    progress.append(progressItem("Подготовка материалов", preparingDone ? "complete" : activePrepare ? "active" : "pending", activePrepare ? "Подготавливаем материалы локально" : materialCountLabel()));
    progress.append(progressItem("Проверка персональных данных", serverDone ? "complete" : activeServer ? "active" : state.progressPhase === "confirmation" ? "error" : "pending", activeServer ? "Сервер проверяет материалы до внешней отправки" : state.progressPhase === "confirmation" ? "Нужно ваше решение" : "Ожидает"));
    progress.append(progressItem(`Анализ в ${provider.name}`, serverDone ? "complete" : activeServer ? "active" : "pending", activeServer ? "Большие материалы автоматически обрабатываются по частям без пропуска текста" : "Ожидает"));
    progress.append(progressItem("Подготовка предложений", serverDone ? "complete" : "pending", "Ожидает ответа"));
    fragment.append(progress);

    if (state.busy) {
      const live = statusCallout("info", "Запрос выполняется", state.progressPhase === "preparing" ? "Файлы подготавливаются в памяти компьютера…" : "Проверяем материалы. Если они не помещаются в контекст модели, программа обработает их последовательно по частям. Это может занять больше времени.");
      live.setAttribute("aria-live", "polite");
      fragment.append(live);
    }
    if (state.piiPreflightReady && isPublicProvider()) fragment.append(renderPiiReview());
    if (state.analysisError) fragment.append(statusCallout(state.progressPhase === "confirmation" ? "warning" : "error", state.progressPhase === "confirmation" ? "Требуется проверка" : "Анализ не завершён", state.analysisError));
    if (!state.busy && !state.piiPreflightReady && !state.analysisError && state.progressPhase === "idle") {
      fragment.append(statusCallout("info", "Готово к запуску", "Нажмите «Начать анализ»."));
    }
    return fragment;
  }

  const FIELD_LABELS = {
    title: "Название инструкции",
    releaseDate: "Дата начала",
    rolloutMode: "Формат запуска",
    rolloutConditions: "Общие условия запуска",
    say: "Что можно говорить клиенту",
    dontSay: "Что не обещать",
    details: "Технические детали",
    channels: "Платформы",
    location: "Путь в интерфейсе",
    availability: "Кому и когда доступно",
    before: "Было",
    after: "Стало",
    clientAction: "Что сделать клиенту",
    supportNote: "Подсказка поддержке",
    question: "Вопрос FAQ",
    answer: "Ответ FAQ"
  };

  function labelForPath(path) {
    const key = String(path).split(/[.\]]/).filter(Boolean).pop().replace(/^\[/, "");
    const groupMatch = String(path).match(/groups\[(\d+)\]/);
    const itemMatch = String(path).match(/items\[(\d+)\]/);
    const faqMatch = String(path).match(/faq\[(\d+)\]/);
    const prefix = faqMatch ? `FAQ ${Number(faqMatch[1]) + 1}` : groupMatch ? `Изменение ${Number(groupMatch[1]) + 1}${itemMatch ? ` · пункт ${Number(itemMatch[1]) + 1}` : ""}` : "Инструкция";
    return `${prefix} · ${FIELD_LABELS[key] || key}`;
  }

  function displayValue(value) {
    if (Array.isArray(value)) {
      const names = { ios: "iOS", android: "Android", web: "веб-ЛК" };
      return value.map((item) => names[item] || sanitizeText(item)).join(", ");
    }
    const text = sanitizeText(value);
    return text || "Не заполнено";
  }

  function confidenceFor(change) {
    const raw = (change.evidence || []).map((entry) => entry.confidence).find(Boolean);
    if (raw === undefined || raw === null || raw === "") return "";
    const number = Number(raw);
    if (Number.isFinite(number)) {
      const percent = number <= 1 ? Math.round(number * 100) : Math.round(number);
      return `Уверенность ${Math.max(0, Math.min(100, percent))}%`;
    }
    return sanitizeText(raw);
  }

  function evidenceNeedsReview(change) {
    return Array.isArray(change && change.evidence) && change.evidence.some((entry) => entry && (entry.requiresReview === true || ["manual", "visual"].includes(entry.verification)));
  }

  function renderEvidence(change) {
    const rail = el("aside", "ai-evidence-rail");
    rail.append(el("strong", "", "Основание"));
    if (!change.evidence || !change.evidence.length) {
      rail.append(el("span", "", "Источник не указан — проверьте особенно внимательно."));
      return rail;
    }
    change.evidence.slice(0, 4).forEach((evidence) => {
      const source = [evidence.file || evidence.source, evidence.page ? `стр. ${evidence.page}` : evidence.slide ? `слайд ${evidence.slide}` : evidence.sheet ? `лист ${evidence.sheet}` : ""].filter(Boolean).join(" · ");
      const item = el("div", "ai-evidence-item");
      if (source) item.append(el("span", "ai-evidence-source", source));
      const excerpt = sanitizeText(evidence.quote || evidence.excerpt || evidence.note);
      if (excerpt) item.append(el("q", "", excerpt));
      if (evidence && (evidence.requiresReview === true || ["manual", "visual"].includes(evidence.verification))) {
        item.append(el("span", "ai-evidence-review", "Сравните предложение с исходным материалом перед применением."));
      }
      rail.append(item);
    });
    return rail;
  }

  function renderInstructionPreview() {
    const draft = state.proposal?.draft;
    if (!draft || !Object.keys(draft).length) return null;
    const panel = el("section", "ai-panel ai-instruction-preview");
    panel.setAttribute("aria-labelledby", "aiInstructionPreviewHeading");
    const heading = el("h3", "ai-section-title", "Инструкция целиком"); heading.id = "aiInstructionPreviewHeading";
    panel.append(heading, el("p", "field-help", "Это предложенный текст до применения. Прочитайте его целиком, затем ниже отметьте поля, которые нужно перенести в черновик."));
    const article = el("article", "ai-instruction-copy");
    const appendField = (container, label, value) => {
      const text = Array.isArray(value) ? displayValue(value) : sanitizeText(value);
      if (!text) return;
      const block = el("div", "ai-instruction-field");
      block.append(el("strong", "", label), el("p", "ai-preserve-lines", text)); container.append(block);
    };
    if (draft.title) article.append(el("h4", "ai-instruction-title", sanitizeText(draft.title)));
    for (const key of ["releaseDate", "rolloutMode", "rolloutConditions"]) appendField(article, FIELD_LABELS[key], draft[key]);
    for (const group of Array.isArray(draft.groups) ? draft.groups : []) {
      const section = el("section", "ai-instruction-group");
      if (group.title) section.append(el("h4", "", sanitizeText(group.title)));
      for (const key of ["channels", "location", "availability"]) appendField(section, FIELD_LABELS[key], group[key]);
      for (const item of Array.isArray(group.items) ? group.items : []) {
        const change = el("section", "ai-instruction-item");
        if (item.title) change.append(el("h5", "", sanitizeText(item.title)));
        for (const [key, label] of [["before", "Было"], ["after", "Стало"], ["clientAction", "Действия клиента"], ["supportNote", "Подсказки сотруднику"]]) appendField(change, label, item[key]);
        if (change.childElementCount) section.append(change);
      }
      if (section.childElementCount) article.append(section);
    }
    const support = draft.support || {};
    for (const [key, label] of [["say", "Готовый текст для клиента"], ["dontSay", "Что не обещать клиенту"], ["details", "Дополнительные сведения для сотрудника"]]) appendField(article, label, support[key]);
    if (Array.isArray(support.faq) && support.faq.length) {
      const faq = el("section", "ai-instruction-group"); faq.append(el("h4", "", "Ответы на вопросы"));
      for (const entry of support.faq) appendField(faq, sanitizeText(entry.question), entry.answer);
      article.append(faq);
    }
    if (!article.childElementCount) return null;
    panel.append(article); return panel;
  }

  function renderReview() {
    const fragment = document.createDocumentFragment();
    state.plan = buildPlan();
    const changes = state.plan ? state.plan.changes : [];
    const selectedCount = changes.filter((change) => state.selectedPaths.has(change.path) && (state.mergeMode === "replace-selected" || change.currentEmpty)).length;

    if (state.processingInfo && state.processingInfo.mode === "chunked") {
      const chunks = Math.max(1, Number(state.processingInfo.chunks) || 1);
      fragment.append(statusCallout("info", "Материалы обработаны полностью", `Большой объём был последовательно разобран на ${chunks.toLocaleString("ru-RU")} частей, затем факты объединены и проверены перед подготовкой предложений.`));
    }

    if (state.applied) {
      const success = statusCallout("success", "Черновик обновлён", "Применены только выбранные поля. Исходные значения и скриншоты сохранены; действие можно отменить один раз.");
      if (state.undoSnapshot) {
        const undo = button("Отменить применение", "button secondary", "undo-dialog");
        success.lastElementChild.append(undo);
      }
      fragment.append(success);
    }
    if (state.localPiiWarning) fragment.append(statusCallout("warning", "В материалах есть признаки персональных данных", "Обработка разрешена, потому что выбран локальный или корпоративный контур. Проверьте, что его правила допускают эти данные."));
    if (state.analysisError) fragment.append(statusCallout("error", "Нужна проверка", state.analysisError));

    if (state.job?.brief?.topic) fragment.append(renderBriefSummary(state.job.brief));
    const preview = renderInstructionPreview();
    if (preview) fragment.append(preview);

    const summary = el("section", "ai-review-summary");
    const copy = el("div");
    copy.append(el("p", "eyebrow", "Предложения ИИ"), el("h3", "", `${changes.length} предложений · выбрано ${selectedCount}`));
    copy.append(el("p", "", state.mergeMode === "fill-empty" ? "Заполненные поля защищены режимом «Только пустые»." : "Замены применятся только для отмеченных строк."));
    const selectAll = button(selectedCount ? "Снять выбор" : "Выбрать доступные", "button secondary small", "toggle-all-changes");
    selectAll.disabled = !changes.length || state.applied;
    summary.append(copy, selectAll);
    fragment.append(summary);

    const warnings = Array.isArray(state.proposal && state.proposal.warnings) ? state.proposal.warnings.map(sanitizeText).filter(Boolean) : [];
    const unknowns = Array.isArray(state.proposal && state.proposal.unknowns) ? state.proposal.unknowns.map(sanitizeText).filter(Boolean) : [];
    if (warnings.length || unknowns.length) {
      const notes = el("section", "ai-review-notes");
      notes.append(el("h3", "", "Что проверить вручную"));
      const list = el("ul");
      [...warnings, ...unknowns.map((text) => `Не удалось подтвердить: ${text}`)].slice(0, 12).forEach((text) => list.append(el("li", "", text)));
      notes.append(list);
      fragment.append(notes);
    }

    if (!changes.length) {
      const empty = el("div", "ai-empty-state");
      empty.append(el("strong", "", "Подходящих изменений нет"), el("p", "", "ИИ не нашёл подтверждённых данных для пустых полей или предложения совпадают с черновиком."));
      fragment.append(empty);
      return fragment;
    }

    const list = el("div", "ai-change-list");
    changes.forEach((change) => {
      const protectedField = state.mergeMode === "fill-empty" && !change.currentEmpty;
      const selected = !protectedField && state.selectedPaths.has(change.path);
      const card = el("article", `ai-change-card${selected ? " is-selected" : ""}${protectedField ? " is-protected" : ""}`);
      const head = el("header", "ai-change-head");
      const checkLabel = el("label", "ai-change-check");
      const checkbox = el("input");
      checkbox.type = "checkbox";
      checkbox.checked = selected;
      checkbox.disabled = protectedField || state.applied;
      checkbox.dataset.aiChangePath = change.path;
      checkLabel.append(checkbox, el("strong", "", labelForPath(change.path)));
      head.append(checkLabel);
      const badges = el("div", "ai-change-badges");
      const confidence = confidenceFor(change);
      if (confidence) badges.append(el("span", "ai-confidence", confidence));
      if (protectedField) badges.append(el("span", "ai-protected-badge", "Сохранено исходное"));
      else if (evidenceNeedsReview(change)) badges.append(el("span", "ai-review-badge", "Проверить по источнику"));
      else badges.append(el("span", "ai-ready-badge", selected ? "Будет применено" : "Не выбрано"));
      head.append(badges);

      const compare = el("div", "ai-compare-grid");
      const before = el("section", "ai-value ai-value-current");
      before.append(el("span", "", "Сейчас"), el("p", "", displayValue(change.current)));
      const after = el("section", "ai-value ai-value-proposed");
      after.append(el("span", "", "Предложение"), el("p", "", displayValue(change.proposed)));
      compare.append(before, after);
      card.append(head, compare, renderEvidence(change));
      list.append(card);
    });
    fragment.append(list);
    return fragment;
  }

  function updateStepper() {
    refs.stepper.replaceChildren();
    STEPS.forEach((name, index) => {
      const item = el("li", `ai-step${index === state.step ? " is-current" : ""}${index < state.step ? " is-complete" : ""}`);
      const control = button(name, "ai-step-button");
      control.dataset.aiStep = String(index);
      control.disabled = index > state.step || state.busy || state.applying || state.clarificationSubmitting;
      control.setAttribute("aria-current", index === state.step ? "step" : "false");
      const number = el("span", "ai-step-number", index < state.step ? "✓" : String(index + 1));
      number.setAttribute("aria-hidden", "true");
      control.prepend(number);
      item.append(control);
      refs.stepper.append(item);
    });
  }

  function renderFooter() {
    refs.footer.replaceChildren();
    const status = el("p", "ai-footer-status");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    if (state.step === 0) status.textContent = state.online ? "Настройки сохраняются только локально." : "Нужно запустить локальный модуль.";
    if (state.step === 1) status.textContent = !state.brief.topic.trim() ? "Укажите тему инструкции в задании для ИИ." : hasMaterials() ? `${materialCountLabel()} готово к анализу по теме.` : "Добавьте файл или вставьте текст.";
    if (state.step === 2) status.textContent = state.busy ? "Запрос выполняется…" : state.piiPreflightReady ? "Ожидается подтверждение." : "Черновик ещё не изменён.";
    if (state.step === 3) status.textContent = state.applied ? "Изменения применены." : "Применятся только отмеченные поля.";
    refs.footer.append(status);
    if (state.job && state.step === 2) {
      if (state.job.status === "clarification") {
        status.textContent = state.clarificationSubmitting ? "Сохраняем уточнения…" : "Ответьте или продолжите с отмеченными пробелами.";
        const submit = button("Сохранить ответы и продолжить", "button primary ai-clarification-submit", "submit-clarifications");
        const skip = button("Продолжить с пробелами", "button secondary", "skip-clarifications");
        submit.disabled = skip.disabled = state.clarificationSubmitting;
        if (state.clarificationSubmitting) submit.setAttribute("aria-busy", "true");
        refs.footer.append(submit, skip);
        return;
      }
      if (state.busy) refs.footer.append(button("Приостановить", "button secondary", "cancel-analysis"));
      else if (state.job.status === "confirmation") {
        const proceed = button("Подтвердить отправку", "button primary", "confirm-analyze"); proceed.disabled = !state.confirmedNoPersonalData; refs.footer.append(proceed);
      } else {
        if (state.job.status !== "complete") refs.footer.append(button(state.job.status === "uploading" ? "Продолжить загрузку" : ["partial", "failed"].includes(state.job.status) ? "Повторить незавершённое" : "Продолжить незавершённое", "button primary", "retry-analysis"));
        refs.footer.append(button("Настройки обработки", "button secondary", "job-settings"));
      }
      if (state.job.hasResult) refs.footer.append(button("Проверить готовое", state.job.status === "complete" ? "button primary" : "button secondary", "job-result"));
      else if (state.job.status === "failed") refs.footer.append(button("Продолжить без изменений", "button secondary", "continue-without-changes"));
      return;
    }

    if (state.step > 0 && (!state.busy || state.step === 3) && !state.applying) {
      const back = button("Назад", "button secondary", "back");
      refs.footer.append(back);
    }
    if (state.busy && state.step !== 3) {
      refs.footer.append(button("Отменить анализ", "button danger-ghost", "cancel-analysis"));
      return;
    }
    if (state.step === 0) {
      const next = button("К материалам", "button primary", "next");
      next.disabled = !state.online || state.loadingServer;
      refs.footer.append(next);
    } else if (state.step === 1) {
      const analyze = button("Начать анализ", "button primary", "analyze");
      analyze.disabled = !hasMaterials() || Boolean(materialLimitError()) || !state.online;
      refs.footer.append(analyze);
    } else if (state.step === 2) {
      if (state.piiPreflightReady && isPublicProvider()) {
        const proceed = button("Продолжить и отправить", "button primary", "confirm-analyze");
        proceed.disabled = !canConfirmPii() || !state.confirmedNoPersonalData;
        refs.footer.append(proceed);
      } else {
        if (state.canContinueWithoutChanges) refs.footer.append(button("Продолжить без изменений", "button secondary", "continue-without-changes"));
        const retry = button("Повторить анализ", "button primary", "retry-analysis");
        retry.disabled = !hasMaterials() || Boolean(materialLimitError());
        refs.footer.append(retry);
      }
    } else if (state.step === 3 && !state.applied) {
      const selected = state.plan ? state.plan.changes.filter((change) => state.selectedPaths.has(change.path) && (state.mergeMode === "replace-selected" || change.currentEmpty)).length : 0;
      const apply = button(`Применить выбранное (${selected})`, "button primary", "apply");
      apply.disabled = !selected || state.applying;
      if (state.applying) apply.setAttribute("aria-busy", "true");
      refs.footer.append(apply);
    } else if (state.step === 3) {
      refs.footer.append(button("Готово", "button primary", "close"));
    }
  }

  function render() {
    if (!refs.dialog) return;
    updateStepper();
    refs.body.replaceChildren();
    if (state.step === 0) { refs.body.append(renderConnection()); refs.body.append(renderJobHistory()); }
    else if (state.step === 1) { refs.body.append(renderMaterials()); refs.body.append(renderJobHistory()); }
    else if (state.step === 2) refs.body.append(renderAnalysis());
    else refs.body.append(renderReview());
    refs.title.textContent = STEPS[state.step];
    refs.subtitle.textContent = `Шаг ${state.step + 1} из ${STEPS.length}`;
    renderFooter();
    if (state.step === 1) global.queueMicrotask(() => resizeManualTextArea(document.getElementById("aiManualText")));
    global.queueMicrotask(() => refs.body.querySelectorAll(".ai-task-textarea").forEach(resizeTaskTextarea));
  }

  function handleSettingChange(target) {
    const key = target.dataset.aiSetting;
    if (!key) return;
    invalidateConnectionCheck();
    if (key === "providerId") {
      state.providerId = target.value;
      currentSettings();
      resetAnalysis();
      render();
      return;
    }
    const settings = currentSettings();
    settings[key] = target.type === "checkbox" ? target.checked : target.value;
    if (key === "dataBoundary") {
      resetAnalysis();
      render();
    }
  }

  async function goNext() {
    if (state.step !== 0) return;
    state.connectionStatus = { tone: "progress", message: "Сохраняем настройки…" };
    render();
    try {
      await saveSettings();
      state.connectionStatus = null;
      state.step = 1;
    } catch (error) {
      state.connectionStatus = { tone: "error", message: userFacingError(error, "Не удалось сохранить настройки. Проверьте заполненные поля и повторите попытку.") };
    }
    render();
  }

  async function undoInsideDialog() {
    if (!state.undoSnapshot || !global.SirenApp) return;
    try {
      await global.SirenApp.setState(clone(state.undoSnapshot));
      state.undoSnapshot = null;
      state.applied = false;
      state.analysisError = "Изменения ИИ отменены. Черновик восстановлен.";
      document.querySelectorAll(".ai-undo-toast").forEach((toast) => toast.remove());
    } catch (error) {
      state.analysisError = userFacingError(error, "Не удалось отменить изменения. Перезапустите программу и проверьте черновик.");
    }
    render();
  }

  async function handleAction(action, target) {
    if (action === "close") {
      refs.dialog.close();
    } else if (action === "import-curl") {
      try {
        const parsed = global.SirenCurlImport.parseCurl(state.curlText);
        invalidateConnectionCheck(); state.providerId = parsed.providerId;
        state.settingsByProvider.set(parsed.providerId, { ...defaultSettings(providerById(parsed.providerId)), ...parsed.config, token: parsed.token });
        state.curlText = ""; state.curlWarnings = parsed.warnings;
        state.connectionStatus = { tone: "success", title: "Поля заполнены", message: "Проверьте значения и нажмите «Проверить подключение»." };
      } catch (error) { state.connectionStatus = { tone: "error", message: error.message }; }
      render();
    } else if (action === "jobs-refresh" || action === "jobs-more") {
      await refreshJobs(action === "jobs-more"); render();
    } else if (action === "job-refresh") {
      if (state.job) await openSavedJob(state.job.id); else { await refreshJobs(); render(); }
    } else if (action === "open-job") {
      await openSavedJob(target.dataset.jobId);
    } else if (action === "job-settings") {
      state.providerId = state.job.providerId; state.step = 0; render();
    } else if (action === "update-job-settings") {
      await saveSettings(); await apiRequest(`/api/jobs/${state.job.id}/settings`, { method: "POST", body: {} }); await openSavedJob(state.job.id);
    } else if (action === "job-result") {
      await showJobResult();
    } else if (action === "job-download") {
      await downloadJobResult();
    } else if (action === "job-new") {
      if (state.busy || state.clarificationSubmitting) return;
      stopJobPolling(); state.busy = false; resetAnalysis(); state.files = []; state.manualText = ""; state.brief = { topic: "", include: "", exclude: "", audience: "both" }; state.briefError = ""; state.step = 1; render();
    } else if (action === "job-delete") {
      state.deleteJobPending = !state.deleteJobPending; render();
    } else if (action === "job-delete-confirm") {
      await apiRequest(`/api/jobs/${state.job.id}`, { method: "DELETE" }); state.deleteJobPending = false; resetAnalysis(); state.step = 0; await refreshJobs(); render();
    } else if (action === "retry-server") {
      await bootstrapServer();
    } else if (action === "test-connection") {
      await testConnection();
    } else if (action === "delete-credential") {
      await deleteCredential();
    } else if (action === "toggle-token") {
      const token = document.getElementById("aiProviderToken");
      if (token) {
        const visible = token.type === "text";
        token.type = visible ? "password" : "text";
        target.textContent = visible ? "Показать" : "Скрыть";
        target.setAttribute("aria-pressed", String(!visible));
      }
    } else if (action === "next") {
      await goNext();
    } else if (action === "back") {
      state.step = Math.max(0, state.step - 1);
      render();
    } else if (action === "analyze" || action === "retry-analysis") {
      await performAnalysis(false);
    } else if (action === "confirm-analyze") {
      await performAnalysis(true);
    } else if (action === "submit-clarifications" || action === "skip-clarifications") {
      await submitClarifications(action === "skip-clarifications");
    } else if (action === "continue-without-changes") {
      continueWithoutChanges();
    } else if (action === "cancel-analysis") {
      cancelAnalysis();
    } else if (action === "remove-file") {
      removeFile(target.dataset.fileId);
    } else if (action === "remove-pii-file") {
      removeFile(target.dataset.fileId);
      state.step = 1;
      render();
    } else if (action === "edit-pii-text") {
      resetAnalysis();
      state.step = 1;
      render();
      global.queueMicrotask(() => {
        const textarea = document.getElementById("aiManualText");
        if (textarea) textarea.focus();
      });
    } else if (action === "toggle-all-changes") {
      if (!state.plan) return;
      const eligible = state.plan.changes
        .filter((change) => (state.mergeMode === "replace-selected" || change.currentEmpty)
          && Array.isArray(change.evidence) && change.evidence.length > 0
          && !evidenceNeedsReview(change))
        .map((change) => change.path);
      const allSelected = eligible.length && eligible.every((path) => state.selectedPaths.has(path));
      state.selectedPaths = allSelected ? new Set() : new Set(eligible);
      render();
    } else if (action === "apply") {
      await applyProposal();
    } else if (action === "undo-dialog") {
      await undoInsideDialog();
    }
  }

  function bindDialogEvents() {
    refs.dialog.addEventListener("click", (event) => {
      if (event.target === refs.dialog && !state.busy && !state.applying) refs.dialog.close();
      const actionTarget = event.target.closest("[data-ai-action]");
      if (actionTarget && !actionTarget.disabled) handleAction(actionTarget.dataset.aiAction, actionTarget).catch((error) => { state.analysisError = userFacingError(error); state.connectionStatus = { tone: "error", message: state.analysisError }; render(); });
    });
    refs.dialog.addEventListener("input", (event) => {
      const target = event.target;
      if (target.matches("[data-ai-manual-text]")) handleManualTextInput(target);
      else if (target.matches("[data-ai-brief]")) handleBriefInput(target);
      else if (target.matches("[data-ai-clarification]")) {
        const id = target.dataset.aiClarification;
        state.clarificationAnswers[id] = target.value.slice(0, MAX_BRIEF_CHARS);
        if (target.value.trim()) {
          state.clarificationErrors.delete(id); target.removeAttribute("aria-invalid");
          const error = document.getElementById(`${target.id}-error`); if (error) error.hidden = true;
        }
        resizeTaskTextarea(target);
      }
      else if (target.matches("[data-ai-setting]")) handleSettingChange(target);
    });
    refs.dialog.addEventListener("change", (event) => {
      const target = event.target;
      if (target.matches("[data-ai-setting]")) handleSettingChange(target);
      if (target.matches("[data-ai-file-input]")) {
        addFiles(target.files);
        target.value = "";
      } else if (target.matches("[data-ai-file-role]")) {
        const entry = state.files.find((file) => file.id === target.dataset.aiFileRole);
        if (entry) { entry.role = target.value; resetAnalysis(); renderFooter(); }
      } else if (target.matches("[data-ai-merge-mode]")) {
        state.mergeMode = target.value === "replace-selected" ? "replace-selected" : "fill-empty";
        resetAnalysis();
        render();
      } else if (target.matches("[data-ai-pii-resolve-all]")) {
        const resolvable = resolvablePiiFindings();
        resolvable.forEach((finding) => {
          if (target.checked) state.resolvedPii.add(finding.id);
          else state.resolvedPii.delete(finding.id);
        });
        state.confirmedNoPersonalData = false;
        render();
      } else if (target.matches("[data-ai-pii-resolved]")) {
        if (target.checked) state.resolvedPii.add(target.dataset.aiPiiResolved);
        else state.resolvedPii.delete(target.dataset.aiPiiResolved);
        state.confirmedNoPersonalData = false;
        render();
      } else if (target.matches("[data-ai-confirm-no-pii]")) {
        state.confirmedNoPersonalData = target.checked;
        renderFooter();
      } else if (target.matches("[data-ai-change-path]")) {
        if (target.checked) state.selectedPaths.add(target.dataset.aiChangePath);
        else state.selectedPaths.delete(target.dataset.aiChangePath);
        render();
      }
    });
    refs.dialog.addEventListener("keydown", (event) => {
      const drop = event.target.closest("[data-ai-drop-zone]");
      if (drop && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        const picker = drop.querySelector("[data-ai-file-input]");
        if (picker) picker.click();
      }
    });
    refs.dialog.addEventListener("dragover", (event) => {
      const drop = event.target.closest("[data-ai-drop-zone]");
      if (!drop) return;
      event.preventDefault();
      drop.classList.add("is-dragging");
    });
    refs.dialog.addEventListener("dragleave", (event) => {
      const drop = event.target.closest("[data-ai-drop-zone]");
      if (drop) drop.classList.remove("is-dragging");
    });
    refs.dialog.addEventListener("drop", (event) => {
      const drop = event.target.closest("[data-ai-drop-zone]");
      if (!drop) return;
      event.preventDefault();
      drop.classList.remove("is-dragging");
      addFiles(event.dataTransfer.files);
    });
    refs.dialog.addEventListener("cancel", () => { /* Server jobs continue when the dialog closes. */ });
    refs.dialog.addEventListener("close", () => {
      if (state.lastTrigger && state.lastTrigger.isConnected) state.lastTrigger.focus();
    });
    refs.stepper.addEventListener("click", (event) => {
      const control = event.target.closest("[data-ai-step]");
      if (!control || control.disabled) return;
      const step = Number(control.dataset.aiStep);
      if (Number.isInteger(step) && step >= 0 && step <= state.step) {
        state.step = step;
        render();
      }
    });
  }

  function createDialog() {
    const dialog = el("dialog", "modal ai-assistant-modal");
    dialog.id = "aiAssistantDialog";
    dialog.setAttribute("aria-labelledby", "aiAssistantDialogTitle");
    dialog.setAttribute("aria-describedby", "aiAssistantDialogSubtitle");

    const shell = el("div", "modal-shell ai-assistant-shell");
    const head = el("header", "modal-head ai-assistant-head");
    const heading = el("div");
    heading.append(el("p", "eyebrow", "Siren AI"));
    refs.title = el("h2", "", STEPS[0]);
    refs.title.id = "aiAssistantDialogTitle";
    refs.subtitle = el("p", "ai-dialog-subtitle", "Шаг 1 из 4");
    refs.subtitle.id = "aiAssistantDialogSubtitle";
    heading.append(refs.title, refs.subtitle);
    const close = button("×", "icon-button close-dialog", "close");
    close.setAttribute("aria-label", "Закрыть помощника ИИ");
    head.append(heading, close);

    const nav = el("nav", "ai-stepper-wrap");
    nav.setAttribute("aria-label", "Этапы заполнения с ИИ");
    refs.stepper = el("ol", "ai-stepper");
    nav.append(refs.stepper);
    refs.body = el("div", "modal-body ai-assistant-body");
    refs.body.id = "aiAssistantBody";
    refs.footer = el("footer", "modal-actions ai-assistant-actions");
    shell.append(head, nav, refs.body, refs.footer);
    dialog.append(shell);
    document.body.append(dialog);
    refs.dialog = dialog;
    bindDialogEvents();
  }

  function openAssistant(trigger) {
    state.lastTrigger = trigger || document.activeElement;
    render();
    refs.dialog.showModal();
    global.queueMicrotask(() => {
      const first = refs.dialog.querySelector("select:not(:disabled), input:not(:disabled), button:not(:disabled)");
      if (first) first.focus();
    });
    if (!state.bootstrapped || !state.online) bootstrapServer();
  }

  function initialize() {
    if (document.getElementById("openAiAssistantBtn")) return;
    const actions = document.querySelector(".top-actions");
    const example = document.getElementById("loadExampleBtn");
    if (!actions || !example) return;
    const open = button("Заполнить с ИИ", "button secondary ai-open-button");
    open.id = "openAiAssistantBtn";
    open.setAttribute("aria-haspopup", "dialog");
    open.setAttribute("aria-controls", "aiAssistantDialog");
    actions.insertBefore(open, example);
    createDialog();
    open.addEventListener("click", () => openAssistant(open));
    render();
  }

  global.SirenAIAssistant = Object.freeze({
    providers: PROVIDERS.map((provider) => ({ ...provider })),
    acceptedExtensions: ACCEPTED_EXTENSIONS.slice(),
    open: () => openAssistant(document.getElementById("openAiAssistantBtn")),
    cancel: cancelAnalysis
  });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
  else initialize();
})(window);
