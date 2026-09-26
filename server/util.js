"use strict";

const crypto = require("node:crypto");

// 100 MiB of binary file data expands to about 133.34 MiB in Base64.
// Keep transport headroom for JSON metadata while files.js enforces the real 100 MiB binary limit.
const MAX_JSON_BYTES = 145 * 1024 * 1024;

class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asPlainText(value, maxLength = 20000) {
  if (value === null || value === undefined) return "";
  const source = typeof value === "string" ? value : String(value);
  return source
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/?(?:div|h[1-6]|li|ol|p|section|ul)(?:\s[^>]*)?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, maxLength);
}

function json(response, status, body, extraHeaders) {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(payload.length),
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  response.end(payload);
}

async function readJson(request, limit = MAX_JSON_BYTES) {
  const declared = Number(request.headers["content-length"] || 0);
  if (declared > limit) {
    throw new HttpError(413, "REQUEST_TOO_LARGE", "Размер запроса превышает допустимый предел.");
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > limit) {
      request.destroy();
      throw new HttpError(413, "REQUEST_TOO_LARGE", "Размер запроса превышает допустимый предел.");
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!isRecord(parsed)) {
      throw new Error("root is not an object");
    }
    return parsed;
  } catch (_error) {
    throw new HttpError(400, "INVALID_JSON", "Тело запроса должно быть корректным JSON-объектом.");
  }
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function redactSecrets(message, secrets) {
  let safe = asPlainText(message, 1500) || "Неизвестная ошибка.";
  for (const secret of secrets || []) {
    if (typeof secret === "string" && secret.length >= 4) {
      safe = safe.split(secret).join("[скрыто]");
    }
  }
  safe = safe
    .replace(/(authorization|api[-_ ]?key|token|secret|credential)\s*[:=]\s*[^\s,;]+/gi, "$1: [скрыто]")
    .replace(/([?&](?:key|api_key|token|access_token)=)[^&\s]+/gi, "$1[скрыто]");
  return safe;
}

function parseCookies(header) {
  const result = Object.create(null);
  String(header || "")
    .split(";")
    .forEach((part) => {
      const index = part.indexOf("=");
      if (index < 1) return;
      const key = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();
      try {
        result[key] = decodeURIComponent(value);
      } catch (_error) {
        result[key] = value;
      }
    });
  return result;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

module.exports = {
  MAX_JSON_BYTES,
  HttpError,
  isRecord,
  asPlainText,
  json,
  readJson,
  randomToken,
  safeEqual,
  redactSecrets,
  parseCookies,
  clampNumber,
};
