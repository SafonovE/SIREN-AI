"use strict";

const crypto = require("node:crypto");
const MAX_FINDINGS_PER_TEXT = 100;
const MAX_PRIVACY_SCAN_CHARS = 3000000;

const PATTERNS = [
  { type: "email", label: "Адрес электронной почты", regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu },
  { type: "phone", label: "Номер телефона", regex: /(?<!\d)(?:\+7|8)[\s(.-]*\d{3}[\s).-]*\d{3}[\s.-]*\d{2}[\s.-]*\d{2}(?!\d)/gu },
  { type: "snils", label: "СНИЛС", regex: /(?<!\d)\d{3}[- ]?\d{3}[- ]?\d{3}[ -]?\d{2}(?!\d)/gu },
  { type: "passport", label: "Паспортные данные", regex: /(?:паспорт|серия)\s*[:№-]?\s*\d{2}[ -]?\d{2}\s*(?:№|номер)?\s*\d{6}/giu },
  { type: "inn", label: "ИНН", regex: /\bИНН\s*[:№-]?\s*\d{10,12}\b/giu },
  { type: "account", label: "Банковские реквизиты", regex: /\b(?:сч[её]т|карта|card)\s*[:№-]?\s*\d{16,20}\b/giu },
  { type: "address", label: "Адрес", regex: /\b(?:адрес(?: регистрации| проживания)?|прописка)\s*[:—-]\s*[^\n]{5,120}/giu },
  {
    type: "full_name",
    label: "Возможное ФИО",
    regex: /(?<![А-ЯЁа-яё-])(?:[А-ЯЁ][а-яё-]{2,}\s+){2}[А-ЯЁ][а-яё-]{2,}(?![А-ЯЁа-яё-])/gu,
  },
];

function mask(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= 4) return "•".repeat(text.length);
  return `${text.slice(0, 2)}${"•".repeat(Math.min(12, Math.max(3, text.length - 4)))}${text.slice(-2)}`;
}

function fingerprint(sourceId, type, match, index) {
  return crypto.createHash("sha256").update(`${sourceId}\0${type}\0${match}\0${index}`).digest("hex").slice(0, 20);
}

function scanTextResult(sourceId, location, value) {
  const raw = value === null || value === undefined ? "" : String(value);
  const text = raw
    .slice(0, MAX_PRIVACY_SCAN_CHARS)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/\r\n?/g, "\n");
  const findings = [];
  let truncated = raw.length > MAX_PRIVACY_SCAN_CHARS;
  patternLoop: for (const pattern of PATTERNS) {
    pattern.regex.lastIndex = 0;
    let match;
    while ((match = pattern.regex.exec(text))) {
      if (findings.length >= MAX_FINDINGS_PER_TEXT) {
        truncated = true;
        break patternLoop;
      }
      findings.push({
        id: fingerprint(sourceId, pattern.type, match[0], match.index),
        type: pattern.type,
        label: pattern.label,
        sourceId,
        location,
        preview: mask(match[0]),
      });
      if (match[0].length === 0) pattern.regex.lastIndex += 1;
    }
  }
  return { findings, truncated };
}

function scanText(sourceId, location, value) {
  return scanTextResult(sourceId, location, value).findings;
}

function scanFiles(extractedFiles, resolvedIds) {
  const resolved = new Set(Array.isArray(resolvedIds) ? resolvedIds.map(String) : []);
  const all = [];
  const incomplete = [];
  for (const file of extractedFiles) {
    const fileScans = [
      ["filename", scanTextResult(file.id, "filename", file.name)],
      ["content", scanTextResult(file.id, "content", file.text)],
    ];
    fileScans.forEach(([location, result]) => {
      all.push(...result.findings);
      if (result.truncated) {
        incomplete.push({
          id: fingerprint(file.id, "scan_limit", location, 0),
          type: "scan_incomplete",
          label: "Слишком много признаков персональных данных",
          sourceId: file.id,
          name: file.name,
          reason: `В материале найдено больше ${MAX_FINDINGS_PER_TEXT} признаков. Для безопасной проверки удалите или обезличьте данные.`,
          blocking: true,
        });
      }
    });
    if (!file.scanComplete) {
      const reason = (Array.isArray(file.warnings) && file.warnings[0]) || "Локальная проверка неполна.";
      incomplete.push({
        id: fingerprint(file.id, "scan_incomplete", reason, 0),
        type: "scan_incomplete",
        label: "Материал проверен не полностью",
        sourceId: file.id,
        name: file.name,
        reason,
        blocking: true,
      });
    }
  }
  const unresolved = all.filter((finding) => !resolved.has(finding.id));
  return {
    detected: all.length,
    resolved: all.length - unresolved.length,
    findings: unresolved,
    incomplete,
    complete: incomplete.length === 0,
  };
}

module.exports = { MAX_FINDINGS_PER_TEXT, MAX_PRIVACY_SCAN_CHARS, scanText, scanTextResult, scanFiles };
