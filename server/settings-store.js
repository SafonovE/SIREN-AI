"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { HttpError, asPlainText, isRecord, randomToken } = require("./util");
const { defaultDataDir } = require("./credential-store");

const ALLOWED_KEYS = new Set([
  "baseUrl",
  "model",
  "authType",
  "chatPath",
  "modelsPath",
  "tokenHeader",
  "customHeaderName",
  "tokenPrefix",
  "tenantId",
  "apiVersion",
  "folderId",
  "projectId",
  "oauthUrl",
  "scope",
  "responsePath",
  "requestField",
  "dataBoundary",
  "publicCloud",
  "temperature",
  "maxTokens",
  "requestTimeoutMinutes",
  "totalTimeoutMinutes",
  "retryCount",
  "chunkChars",
  "imageMode",
]);

function cleanConfig(value) {
  const source = isRecord(value) ? value : {};
  const result = {};
  for (const [key, raw] of Object.entries(source)) {
    if (!ALLOWED_KEYS.has(key) || raw === undefined || raw === null) continue;
    if (["requestTimeoutMinutes", "totalTimeoutMinutes", "retryCount", "chunkChars"].includes(key)) {
      const ranges = { requestTimeoutMinutes: [1, 60], totalTimeoutMinutes: [0, 10080], retryCount: [0, 3], chunkChars: [400, 8000] };
      const number = Number(raw); const [min, max] = ranges[key];
      if (!Number.isFinite(number) || !Number.isInteger(number) || number < min || number > max) throw new HttpError(400, "INVALID_ANALYSIS_SETTING", `Параметр ${key} должен быть целым числом от ${min} до ${max}. Исправьте значение в настройках обработки.`);
      result[key] = number; continue;
    }
    if (key === "imageMode") { if (!["auto", "vision", "ocr"].includes(raw)) throw new HttpError(400, "INVALID_IMAGE_MODE", "Выберите способ обработки изображений из списка."); result[key] = raw; continue; }
    if (key === "publicCloud") {
      result[key] = Boolean(raw);
      continue;
    }
    if (key === "dataBoundary") {
      const boundary = String(raw || "").toLowerCase();
      if (["public", "corporate", "local"].includes(boundary)) result[key] = boundary;
      continue;
    }
    if (key === "temperature" || key === "maxTokens") {
      const number = Number(raw);
      if (Number.isFinite(number)) result[key] = number;
      continue;
    }
    const limit = key.toLowerCase().includes("url") ? 2048 : 500;
    result[key] = asPlainText(raw, limit);
  }
  return result;
}

class SettingsStore {
  constructor(options = {}) {
    this.dataDir = path.resolve(options.dataDir || defaultDataDir());
    this.filePath = path.join(this.dataDir, "settings.json");
    this.values = Object.create(null);
    this.ready = this.load();
  }

  async load() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.providers)) return;
      for (const [providerId, config] of Object.entries(parsed.providers)) this.values[providerId] = cleanConfig(config);
    } catch (_error) {
      // First launch and damaged non-secret settings both fall back to provider defaults.
    }
  }

  async persist() {
    await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const payload = JSON.stringify({ version: 1, providers: this.values }, null, 2);
    const tempPath = `${this.filePath}.${process.pid}.${randomToken(6)}.tmp`;
    await fs.writeFile(tempPath, payload, { encoding: "utf8", mode: 0o600 });
    await fs.rename(tempPath, this.filePath);
  }

  async get(providerId) {
    await this.ready;
    return { ...(this.values[providerId] || {}) };
  }

  async all() {
    await this.ready;
    return Object.fromEntries(Object.entries(this.values).map(([id, config]) => [id, { ...config }]));
  }

  async set(providerId, config) {
    await this.ready;
    const next = cleanConfig(config);
    if (Object.prototype.hasOwnProperty.call(next, "baseUrl") && next.baseUrl && !/^https?:\/\//i.test(next.baseUrl)) {
      throw new HttpError(400, "INVALID_BASE_URL", "Адрес API должен начинаться с http:// или https://.");
    }
    this.values[providerId] = next;
    await this.persist();
    return { ...next };
  }
}

module.exports = { SettingsStore, cleanConfig, ALLOWED_KEYS };
