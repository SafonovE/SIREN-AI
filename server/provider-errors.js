"use strict";

const { HttpError, asPlainText, redactSecrets } = require("./util");

function providerText(payload, rawText) {
  const candidates = [
    typeof payload?.error === "string" ? payload.error : "",
    payload?.error?.message,
    payload?.error?.detail,
    payload?.error?.type,
    payload?.error?.code,
    payload?.message,
    payload?.detail,
    payload?.details,
    typeof rawText === "string" ? rawText : "",
  ];
  return candidates
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => asPlainText(value, 1200))
    .join(" | ")
    .slice(0, 1500);
}

function numberFrom(text, patterns) {
  for (const pattern of patterns) {
    const match = pattern.exec(String(text || ""));
    const digits = match ? String(match[1]).replace(/[^\d]/g, "") : "";
    if (digits && Number.isFinite(Number(digits))) return Number(digits);
  }
  return undefined;
}

function details(status, retryable, text) {
  const inputTokens = numberFrom(text, [
    /request\s*\(?\s*([\d\s.,]+)\s*tokens?/iu,
    /input[^\d]{0,30}([\d\s.,]+)\s*tokens?/iu,
    /prompt[^\d]{0,30}([\d\s.,]+)\s*tokens?/iu,
  ]);
  const contextTokens = numberFrom(text, [
    /context\s+size[^\d]{0,20}([\d\s.,]+)/iu,
    /context(?:\s+window|\s+length)?[^\d]{0,30}([\d\s.,]+)\s*tokens?/iu,
    /maximum[^\d]{0,30}([\d\s.,]+)\s*tokens?/iu,
  ]);
  return {
    providerStatus: Number(status) || 0,
    retryable: Boolean(retryable),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(contextTokens !== undefined ? { contextTokens } : {}),
  };
}

function includesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function classifyProviderHttpError(status, payload, rawText, secrets = []) {
  const raw = redactSecrets(providerText(payload, rawText), secrets);
  const text = raw.toLocaleLowerCase("ru-RU");
  const meta = (retryable) => details(status, retryable, raw);

  if (includesAny(text, [
    /context.{0,40}(?:exceed|limit|length|window|size)/iu,
    /(?:exceed|too (?:many|large)).{0,40}(?:token|context)/iu,
    /token.{0,40}(?:exceed|context|maximum|max(?:imum)?)/iu,
    /prompt.{0,30}(?:too long|is too large)/iu,
    /контекст.{0,40}(?:превыш|лимит|размер)/iu,
  ])) {
    const info = meta(true);
    const values = info.inputTokens && info.contextTokens
      ? ` Запрос: ${info.inputTokens.toLocaleString("ru-RU")} токенов, доступно: ${info.contextTokens.toLocaleString("ru-RU")}.`
      : "";
    return new HttpError(
      422,
      "PROVIDER_CONTEXT_LIMIT",
      `Материалы не помещаются в контекст выбранной модели.${values} Siren попробует обработать их меньшими частями.`,
      info
    );
  }

  if (includesAny(text, [/out of memory/iu, /not enough (?:system )?memory/iu, /insufficient memory/iu, /cuda.{0,20}(?:memory|oom)/iu, /не хватает памяти/iu])) {
    return new HttpError(503, "PROVIDER_OUT_OF_MEMORY", "Модели не хватило памяти. Закройте лишние программы, выберите модель меньшего размера или уменьшите контекст модели и повторите проверку.", meta(false));
  }
  if (status === 401 || includesAny(text, [/invalid.{0,20}(?:api.?key|token|credential)/iu, /unauthori[sz]ed/iu, /authentication.{0,20}(?:fail|required)/iu])) {
    return new HttpError(401, "PROVIDER_AUTH_FAILED", "Провайдер не принял ключ или токен. Проверьте секрет, способ авторизации и срок его действия.", meta(false));
  }
  if (status === 403) {
    return new HttpError(403, "PROVIDER_ACCESS_DENIED", "Провайдер запретил этот запрос. Проверьте права ключа и доступ выбранной модели для вашей учётной записи.", meta(false));
  }
  if (status === 402) {
    return new HttpError(402, "PROVIDER_PAYMENT_REQUIRED", "Провайдер требует оплату или пополнение баланса. Запрос дошёл до сервиса, поэтому изменение URL и ключа обычно не помогает. Проверьте баланс и биллинг выбранного шлюза либо выберите локальную модель Ollama. Затем продолжите незавершённые материалы.", meta(false));
  }
  if (includesAny(text, [/(?:model|модель).{0,40}(?:not found|does not exist|unknown|unavailable|не найден|не существует|недоступ)/iu, /no such model/iu, /model_not_found/iu])) {
    return new HttpError(404, "PROVIDER_MODEL_NOT_FOUND", "Выбранная модель не найдена или не загружена. Проверьте её точное имя и установите или выберите доступную модель.", meta(false));
  }
  if (status === 404) {
    return new HttpError(404, "PROVIDER_ROUTE_NOT_FOUND", "AI-сервис не нашёл указанный маршрут. Проверьте базовый URL и маршрут анализа в дополнительных параметрах.", meta(false));
  }
  if (status === 405) {
    return new HttpError(405, "PROVIDER_METHOD_NOT_ALLOWED", "Указанный маршрут не принимает запросы анализа. Проверьте маршрут анализа; маршрут списка моделей указывать здесь нельзя.", meta(false));
  }
  if (includesAny(text, [/(?:quota|credit|balance|billing).{0,40}(?:exceed|exhaust|insufficient|limit)/iu, /insufficient_quota/iu, /закончил.{0,20}(?:квот|лимит|баланс)/iu])) {
    return new HttpError(429, "PROVIDER_QUOTA_EXHAUSTED", "У провайдера закончилась квота или доступный баланс. Пополните лимит либо выберите другую модель или учётную запись.", meta(false));
  }
  if (status === 429 || includesAny(text, [/rate.?limit/iu, /too many requests/iu, /слишком много запросов/iu])) {
    return new HttpError(429, "PROVIDER_RATE_LIMITED", "Провайдер временно ограничил частоту запросов. Подождите немного и повторите попытку.", meta(true));
  }
  if (status === 408 || status === 504) {
    return new HttpError(504, "PROVIDER_TIMEOUT", "Сам AI-сервис или его шлюз прервал ожидание ответа. Увеличьте таймаут шлюза, если он вам доступен, или уменьшите размер части в настройках обработки. Для локальной модели дождитесь загрузки; затем продолжите незавершённое.", meta(true));
  }
  if (status === 413) {
    return new HttpError(413, "PROVIDER_REQUEST_TOO_LARGE", "AI-сервис ограничил размер одного запроса. Siren попробует обработать материалы меньшими частями.", meta(true));
  }
  if (includesAny(text, [/content.{0,30}(?:filter|policy|blocked)/iu, /safety.{0,30}(?:filter|block)/iu, /moderation/iu, /материал.{0,30}(?:заблок|отклон)/iu])) {
    return new HttpError(422, "PROVIDER_CONTENT_BLOCKED", "AI-сервис отклонил содержимое по своим правилам безопасности. Проверьте материалы или выберите разрешённый корпоративный либо локальный сервис.", meta(false));
  }
  if (status === 400 && includesAny(text, [/response.?format/iu, /json.{0,30}(?:unsupported|not supported|schema)/iu, /image.{0,30}(?:unsupported|not supported)/iu, /vision.{0,30}(?:unsupported|not supported)/iu, /(?:not|does not) support.{0,20}(?:image|vision|format|json)/iu])) {
    return new HttpError(400, "PROVIDER_UNSUPPORTED_REQUEST", "Модель отклонила формат JSON или изображение. Включите «Только распознанный текст» для модели без vision либо выберите модель с поддержкой изображений и JSON. Уже готовые материалы сохранены; продолжите незавершённые.", meta(false));
  }
  if (status === 400 || status === 422) {
    return new HttpError(400, "PROVIDER_BAD_REQUEST", "AI-сервис не принял запрос. Проверьте название модели, маршрут анализа и совместимость модели с JSON и изображениями.", meta(false));
  }
  if (status >= 500) {
    return new HttpError(502, "PROVIDER_SERVER_ERROR", "AI-сервис временно завершил запрос с внутренней ошибкой. Повторите попытку позже или выберите другую модель.", meta(true));
  }
  return new HttpError(502, "PROVIDER_REQUEST_FAILED", "AI-сервис не выполнил запрос. Проверьте настройки подключения и повторите попытку.", meta(false));
}

function causeCode(error) {
  return String(error?.cause?.code || error?.code || "").toUpperCase();
}

function classifyProviderNetworkError(error) {
  const code = causeCode(error);
  if (["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "ETIMEDOUT"].includes(code)) {
    return new HttpError(504, "PROVIDER_TIMEOUT", "Сервис не передал ответ за отведённое время. Увеличьте «Время ожидания одного ответа» в настройках обработки. На CPU уменьшите размер части до 800–1400 символов; при повторении выберите меньшую модель. Готовые этапы можно использовать при продолжении.", { retryable: true });
  }
  if (["ECONNREFUSED", "UND_ERR_CONNECT_TIMEOUT"].includes(code)) {
    return new HttpError(502, "PROVIDER_CONNECTION_REFUSED", "AI-сервис не отвечает по указанному адресу. Убедитесь, что он запущен, и проверьте базовый URL и порт.", { retryable: true });
  }
  if (["ENOTFOUND", "EAI_AGAIN"].includes(code)) {
    return new HttpError(502, "PROVIDER_DNS_FAILED", "Не удалось найти сервер AI по указанному адресу. Проверьте написание адреса, подключение к сети или VPN.", { retryable: true });
  }
  if (includesAny(code, [/CERT/iu, /TLS/iu, /SSL/iu]) || includesAny(String(error?.cause?.message || error?.message || ""), [/certificate/iu, /tls/iu, /ssl/iu])) {
    return new HttpError(502, "PROVIDER_TLS_FAILED", "Не удалось установить защищённое соединение с AI-сервисом. Проверьте сертификат, системную дату и корпоративный прокси.", { retryable: false });
  }
  if (["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"].includes(code)) {
    return new HttpError(502, "PROVIDER_CONNECTION_LOST", "Соединение с AI-сервисом оборвалось. Проверьте сеть и повторите запрос.", { retryable: true });
  }
  return new HttpError(502, "PROVIDER_UNAVAILABLE", "Не удалось подключиться к AI-сервису. Проверьте адрес, сеть и доступность сервиса, затем повторите попытку.", { retryable: true });
}

module.exports = {
  classifyProviderHttpError,
  classifyProviderNetworkError,
  providerText,
};
