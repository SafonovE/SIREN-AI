"use strict";

const crypto = require("node:crypto");
const { HttpError, isRecord } = require("./util");
const { parseJsonCandidate, normalizeAiOutput } = require("./schema");
const { splitTextPreserving, isContextError } = require("./chunking");
const { reliableCall, fingerprint } = require("./reliable-call");
const { sourceLines } = require("./source-lines");
const { JARGON_RULES } = require("./quality");

const BRIEF_LIMIT = 1500;
const FACT_LIMIT = 160;
const PURPOSES = new Set(["before", "after", "context"]);
const SAFE_PATH = /^(?:title|groups\[0\]\.items\[0\]\.(?:before|after|clientAction|supportNote)|support\.say)$/;
const CORE_PATHS = ["groups[0].items[0].before", "groups[0].items[0].after", "groups[0].items[0].clientAction", "groups[0].items[0].supportNote", "support.say"];
const CORE_LABELS = ["Было: как работало до изменения", "Стало: что изменилось", "Действия клиента", "Подсказки и ограничения для сотрудника", "Готовый текст для клиента"];

// Keep comparison operators in quotes. HTML-oriented text sanitizers can eat
// everything between '< 100' and '> 0' in an extracted requirements table.
function boundedText(value, max, label, status = 502) {
  if (value == null) return "";
  if (typeof value !== "string") throw new HttpError(status, "TOPIC_INVALID_TEXT", `Поле «${label}» должно содержать текст.`);
  if (value.length > max) throw new HttpError(status, "TOPIC_TEXT_TOO_LONG", `Поле «${label}» длиннее ${max} символов. Сократите его без потери смысла.`);
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, "").trim();
}

function normalizeBrief(raw) {
  if (raw == null || raw === "") return { topic: "", include: "", exclude: "", audience: "both" };
  if (typeof raw === "string") raw = { topic: raw };
  if (!isRecord(raw)) throw new HttpError(400, "INVALID_TOPIC_BRIEF", "Задание для ИИ должно содержать тему инструкции.");
  const brief = Object.fromEntries(["topic", "include", "exclude"].map((key) => [key, boundedText(raw[key], BRIEF_LIMIT, key, 400)]));
  brief.audience = raw.audience || "both";
  if (!["both", "support", "client"].includes(brief.audience)) throw new HttpError(400, "INVALID_TOPIC_AUDIENCE", "Выберите аудиторию: сотрудник КЦ, клиент или оба.");
  if (!brief.topic && (brief.include || brief.exclude)) throw new HttpError(400, "TOPIC_REQUIRED", "Укажите тему инструкции, чтобы ИИ применил уточнения и исключения.");
  return brief;
}

function hash(value) { return crypto.createHash("sha256").update(value).digest("hex").slice(0, 20); }
function explicitlyExcluded(fact, brief) {
  // A narrow guard for named exclusions, not a replacement for semantic review.
  // Never discard possible conditions/dependencies or facts naming the subject.
  if (!brief.exclude || /(?:\bif\b|\bunless\b|\bexcept\b|\bdepend\w*\b)|(?:^|[^а-яё])(?:если|при|кроме|без|не)(?:$|[^а-яё])|завис|огранич|услов|доступ|исключ/iu.test(fact.statement)) return false;
  const ignored = new Set(["инструкц", "измен", "друг", "только", "нужн", "включ", "исключ", "опис", "расскаж", "укаж", "количеств", "кнопк", "страниц", "экран", "продукт", "главн", "interface", "button", "screen", "page", "other", "about", "instruction"]);
  const words = (value) => (String(value).toLowerCase().replace(/ё/g, "е").match(/[а-яa-z]{4,}/gu) || []).filter((word) => ![...ignored].some((prefix) => word.startsWith(prefix))).map((word) => word.slice(0, 5));
  const topicWords = new Set(words(brief.topic));
  const excluded = brief.exclude.split(/[,;\n]+/u).map(words).filter((part) => part.length && !part.every((word) => topicWords.has(word)));
  const mentioned = new Set(words(fact.statement));
  if (!excluded.some((part) => part.every((word) => mentioned.has(word)))) return false;
  const excludedWords = new Set(excluded.flat());
  const anchors = words(brief.topic).filter((word) => !excludedWords.has(word));
  return anchors.length > 0 && !anchors.some((word) => mentioned.has(word));
}
function quoteKey(value) { return String(value || "").normalize("NFKC").replace(/[\u00a0\u202f\s]+/gu, " ").trim(); }
function actualQuote(text, quote) {
  if (!quote) return "";
  if (String(text).includes(quote)) return quote;
  // Whitespace layout may change in table extraction. Match only normalized
  // whitespace, never punctuation/negation/numbers or semantic similarity.
  const source = quoteKey(text), candidate = quoteKey(quote);
  return candidate && source.includes(candidate) ? candidate : "";
}
function warningsOf(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 30) throw new HttpError(502, "TOPIC_INVALID_OUTPUT", "ИИ вернул неверный список замечаний.");
  return value.map((item) => boundedText(item, 1200, "замечание")).filter(Boolean);
}
function requireShape(condition, message = "ИИ вернул неполный ответ. Повторите незавершённый этап.") {
  if (!condition) throw new HttpError(502, "TOPIC_INVALID_OUTPUT", message);
}
function safeValidate(validator) {
  return (text) => { try { validator(parseJsonCandidate(text)); return true; } catch { return false; } };
}

async function requestJson(options, context, validator) {
  // Short wire IDs reduce copying errors and token load on small local models.
  // Stable provenance IDs remain unchanged in checkpoints and user evidence.
  const toWire = new Map((context.topicFacts || []).map((fact, index) => [fact.factId, `f${index + 1}`]));
  const fromWire = new Map([...toWire].map(([id, wire]) => [wire, id]));
  const mapRefs = (value, ids, key = "") => {
    if (typeof value === "string") return ["factId", "factIds", "missingFactIds"].includes(key) ? ids.get(value) || value : value;
    if (Array.isArray(value)) return value.map((item) => mapRefs(item, ids, key));
    if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, mapRefs(item, ids, name)]));
    return value;
  };
  const wireContext = { ...mapRefs(context, toWire), topicFactIdentityMap: [...toWire] };
  const contractContext = { ...wireContext, topicContractVersion: context.requestMode === "topic-extract" ? 4 : 6 };
  // Reuse earlier extraction checkpoints only after the current validator has
  // confirmed them against this exact source chunk. Rejected ranges never pass.
  const previousCheckpointContexts = context.requestMode === "topic-extract" ? [{ ...wireContext, topicContractVersion: 3 }] : [];
  const validateWire = (parsed) => validator(mapRefs(parsed, fromWire));
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await reliableCall({ ...options, timeoutMs: Number(options.timeoutMs) || 600000, checkpointContext: contractContext, previousCheckpointContexts, context: { ...contractContext, ...(attempt ? { topicRepair: last.message } : {}) }, validateResult: safeValidate(validateWire) });
      return validateWire(parseJsonCandidate(result.text));
    } catch (error) {
      last = error;
      if (!["TOPIC_INVALID_OUTPUT", "TOPIC_SOURCE_RANGE_INVALID", "TOPIC_INVALID_TEXT", "TOPIC_TEXT_TOO_LONG", "INVALID_AI_JSON", "TOPIC_QUOTE_INVALID", "EMPTY_PROVIDER_RESPONSE"].includes(error?.code) || attempt) throw error;
      await options.onProgress?.({ phase: "topic-retry", message: "Проверяем сложный фрагмент повторно: сопоставляем ответ ИИ с документом. Сохранённые этапы будут использованы повторно.", reason: error.code });
    }
  }
  throw last;
}

function topicUnits(files, chunkChars) {
  const units = [];
  for (const source of files) {
    const text = String(source.text || "");
    const parts = splitTextPreserving(text, chunkChars);
    let offset = 0, section = "";
    for (let i = 0; i < parts.length; i++) {
      // Context overlap keeps table labels and cross-boundary conditions visible.
      const overlapBefore = text.slice(Math.max(0, offset - 280), offset);
      const overlapAfter = text.slice(offset + parts[i].length, offset + parts[i].length + 180);
      const preceding = text.slice(0, offset).split(/\r?\n/u);
      const headings = preceding.filter((line) => /^(?:#{1,6}\s|\d+(?:\.\d+)*[.)]?\s+\p{L})/u.test(line.trim()) && line.length <= 140);
      section = headings.slice(-2).join(" → ");
      units.push({ original: source, part: i + 1, totalParts: parts.length, section,
        file: { ...source, text: overlapBefore + parts[i] + overlapAfter,
          ...(i > 0 ? { kind: "text", buffer: Buffer.alloc(0), mime: "text/plain" } : {}) } });
      offset += parts[i].length;
    }
  }
  return units;
}

function parsePacket(parsed, unit) {
  requireShape(isRecord(parsed) && parsed.coverage === "complete" && Array.isArray(parsed.facts) && parsed.facts.length <= 60);
  const irrelevantReason = boundedText(parsed.irrelevantReason, 1200, "причина отсутствия фактов");
  requireShape(parsed.facts.length || irrelevantReason || !unit.file.text, "ИИ должен вернуть факты по теме или объяснить, почему их нет в этой части.");
  const facts = parsed.facts.map((item) => {
    requireShape(isRecord(item));
    const statement = boundedText(item.statement, 1200, "факт");
    let givenQuote;
    if (Number.isInteger(item.startLine) && Number.isInteger(item.endLine)) {
      const lines = sourceLines(unit.file.text);
      if (item.startLine === 0 && item.endLine === 0 && unit.file.kind === "image" && unit.file.buffer?.length) givenQuote = "";
      else {
        if (!(item.startLine >= 1 && item.endLine >= item.startLine && item.endLine <= lines.length)) throw new HttpError(502, "TOPIC_SOURCE_RANGE_INVALID", `Укажи startLine/endLine только из id текущего sourceLines: от 1 до ${lines.length}, startLine <= endLine. Получено: ${item.startLine}/${item.endLine}. Номера других частей документа недопустимы.`);
        givenQuote = boundedText(unit.file.text.slice(lines[item.startLine - 1].start, lines[item.endLine - 1].end), 1200, "цитата");
      }
    } else givenQuote = boundedText(item.quote, 1200, "цитата");
    requireShape(Boolean(statement));
    const image = unit.original.kind === "image" || unit.original.visualSource === true;
    const actualImage = unit.file.kind === "image" && Boolean(unit.file.buffer?.length);
    const quote = actualQuote(unit.file.text, givenQuote);
    if (!actualImage && !quote) throw new HttpError(502, "TOPIC_QUOTE_INVALID", "Цитата факта отсутствует в текущем материале. Укажи дословное основание, сохранив отрицания, числа и условия; неподтверждённый факт убери.");
    // OCR contains visible text, not a reliable inventory of absent controls.
    // Missing OCR tokens cannot establish that a counter/button did not exist.
    if (image && !actualImage && /(?:нет|не было|не отобража[её]т|не показыва[её]т|не отображал|не показывал|отсутств|без\s+(?:сч[её]тчик|числ|количеств))/iu.test(statement)) {
      throw new HttpError(502, "TOPIC_QUOTE_INVALID", "По распознанному тексту нельзя установить отсутствие элемента на изображении. Убери такой вывод; сравнение внешнего вида требует проверки оригинала.");
    }
    return { factId: `topic-${hash(`${unit.original.id}\n${unit.original.purpose}\n${statement}\n${quote}`)}`, statement, quote,
      sourceId: String(unit.original.id), purpose: PURPOSES.has(unit.original.purpose) ? unit.original.purpose : "context",
      ...(image || unit.original.id === "manual-text" || unit.original.requiresReview ? { requiresReview: true, verification: "manual" } : {}) };
  });
  return { facts, warnings: warningsOf(parsed.warnings), irrelevantReason };
}

async function extractTopicFacts(options) {
  const brief = normalizeBrief(options.context?.brief);
  if (!brief.topic) throw new HttpError(400, "TOPIC_REQUIRED", "Укажите тему инструкции.");
  const files = Array.isArray(options.context?.files) ? options.context.files : [];
  const chunkChars = Math.min(4200, Math.max(500, Number(options.config?.chunkChars) || 1400));
  const units = topicUnits(files, chunkChars), facts = [], warnings = [];
  const stats = { mode: "topic", chunks: 0, contextRetries: 0 };
  const extract = async (unit, depth = 0) => {
    if (!unit.file.text?.trim() && !(unit.file.kind === "image" && unit.file.buffer?.length)) {
      warnings.push(`«${unit.original.name}»: текст не извлечён; добавьте описание материала.`);
      return;
    }
    const text = String(unit.file.text || "");
    const config = { ...options.config };
    for (const key of ["requestTimeoutMinutes", "totalTimeoutMinutes", "retryCount"]) delete config[key];
    const splitKey = `topic-split-${fingerprint({ version: 1, provider: options.provider.id, config, brief, file: unit.file, depth })}`;
    const children = depth < 3 && text.length > 400 && unit.file.kind !== "image" ? splitTextPreserving(text, Math.floor(text.length / 2)) : [];
    const canSplit = children.length > 1 && children.every((child) => child.length < text.length);
    const split = async () => {
      stats.contextRetries++;
      await options.onProgress?.({ phase: "topic-split", message: "Проверяем сложный фрагмент меньшими частями. Сохранённые этапы будут использованы повторно." });
      for (const [index, child] of children.entries()) await extract({ ...unit, file: { ...unit.file, text: child }, part: index + 1, totalParts: children.length }, depth + 1);
    };
    // Persist the recovery route, too: resuming must not repeat a known failing
    // parent before it reaches already saved, validated child responses.
    if (canSplit && (await options.checkpoint?.get(splitKey))?.split === true) { await split(); return; }
    try {
      const packet = await requestJson(options, { requestMode: "topic-extract", files: [unit.file], brief, section: unit.section, part: unit.part, totalParts: unit.totalParts, maxOutputTokens: 1300 }, (parsed) => parsePacket(parsed, unit));
      facts.push(...packet.facts); warnings.push(...packet.warnings); stats.chunks++;
    } catch (error) {
      if (canSplit && (isContextError(error) || ["PROVIDER_TIMEOUT", "TOPIC_INVALID_OUTPUT", "TOPIC_SOURCE_RANGE_INVALID", "TOPIC_QUOTE_INVALID", "INVALID_AI_JSON", "TOPIC_INVALID_TEXT", "TOPIC_TEXT_TOO_LONG", "EMPTY_PROVIDER_RESPONSE"].includes(error.code))) {
        await options.checkpoint?.set(splitKey, { split: true });
        await split();
        return;
      }
      throw error;
    }
  };
  for (const [index, unit] of units.entries()) {
    await options.onProgress?.({ phase: "topic-extract", part: index + 1, parts: units.length, message: `Отбираем факты по теме: часть ${index + 1} из ${units.length}` });
    await extract(unit);
  }
  const unique = [...new Map(facts.map((fact) => [fact.factId, fact])).values()];
  return { facts: unique, warnings: [...new Set(warnings)], irrelevantReason: unique.length ? "" : "В материале не найдены подтверждённые сведения по выбранной теме.", processing: stats };
}

function compactFacts(facts) {
  return facts.map(({ factId, statement, quote, purpose, requiresReview, userAnswer }) => ({ factId, statement, quote, purpose, ...(requiresReview ? { requiresReview: true } : {}), ...(userAnswer ? { userAnswer: true } : {}) }));
}
function factBatches(facts, maxChars = 4200) {
  const batches = []; let batch = [], size = 0;
  for (const fact of facts) {
    const length = JSON.stringify(compactFacts([fact])).length;
    if (batch.length && size + length > maxChars) { batches.push(batch); batch = []; size = 0; }
    batch.push(fact); size += length;
  }
  if (batch.length) batches.push(batch);
  return batches;
}
function parseInspection(parsed, facts) {
  requireShape(isRecord(parsed) && Array.isArray(parsed.decisions) && Array.isArray(parsed.clarifications));
  const byId = new Map(facts.map((fact) => [fact.factId, fact]));
  const seen = new Set(), selected = [];
  for (const decision of parsed.decisions) {
    requireShape(isRecord(decision) && byId.has(decision.factId) && !seen.has(decision.factId) && typeof decision.keep === "boolean" && typeof decision.supported === "boolean", "Проверь каждый factId ровно один раз, без неизвестных идентификаторов.");
    seen.add(decision.factId);
    if (decision.keep && decision.supported) selected.push(byId.get(decision.factId));
  }
  requireShape(seen.size === byId.size, "Проверены не все факты. Верни решение для каждого factId.");
  requireShape(parsed.clarifications.length <= 3, "Задай не больше трёх существенных вопросов.");
  const clarifications = parsed.clarifications.map((question) => {
    requireShape(isRecord(question) && Array.isArray(question.factIds) && question.factIds.length && question.factIds.every((id) => byId.has(id)));
    const text = boundedText(question.question, 180, "короткий вопрос"), reason = boundedText(question.reason, 300, "причина вопроса");
    requireShape(Boolean(text && reason));
    return { id: `clarify-${hash(text)}`, question: text, reason, factIds: [...new Set(question.factIds)] };
  });
  return { facts: selected, clarifications, warnings: warningsOf(parsed.warnings) };
}

function unknownAnswer(value) {
  return /^(?:не\s+знаю|неизвестно|нет\s+(?:данных|информации)|не\s+(?:могу|готов)\s+(?:сказать|уточнить|ответить)|затрудняюсь\s+ответить|пропустить|без\s+ответа|не\s+уверен[а]?)[.!\s]*$/iu.test(String(value || "").trim());
}

function answersAsFacts(answers) {
  if (!Array.isArray(answers) || answers.length > 3) throw new HttpError(400, "INVALID_CLARIFICATIONS", "Допустимы ответы не более чем на три уточнения.");
  return answers.map((answer) => {
    requireShape(isRecord(answer));
    const id = boundedText(answer.id, 100, "идентификатор уточнения", 400);
    const question = boundedText(answer.question, 500, "вопрос", 400);
    const text = boundedText(answer.answer, 1500, "ответ", 400);
    if (!text || unknownAnswer(text)) return null;
    return { factId: `answer-${hash(`${id}\n${text}`)}`, statement: `Уточнение пользователя. ${question} Ответ: ${text}`, quote: text, sourceId: `clarification:${id}`, purpose: "context", userAnswer: true, requiresReview: true, verification: "manual" };
  }).filter(Boolean);
}

function validateStoredFacts(packets, files) {
  const bySource = new Map(files.map((file) => [String(file.id), file]));
  const facts = [];
  for (const packet of packets) for (const input of packet?.facts || []) {
    requireShape(isRecord(input));
    const source = bySource.get(String(input.sourceId));
    requireShape(Boolean(source), "Источник сохранённого факта недоступен. Заново обработайте материал.");
    const statement = boundedText(input.statement, 1200, "факт"), quote = boundedText(input.quote, 1200, "цитата");
    requireShape(Boolean(statement));
    // Root stores extracted image metadata with kind=image; review flag is also
    // retained when a screenshot has been converted to a text-only job record.
    const manual = source.kind === "image" || source.visualSource === true || source.id === "manual-text" || source.requiresReview === true || input.requiresReview === true;
    requireShape(source.kind === "image" || Boolean(actualQuote(source.text, quote)), "Цитата сохранённого факта не совпадает с источником. Повторите обработку материала.");
    const factId = boundedText(input.factId, 100, "идентификатор факта") || `topic-${hash(`${input.sourceId}\n${statement}\n${quote}`)}`;
    facts.push({ factId, statement, quote, sourceId: String(source.id), purpose: PURPOSES.has(source.purpose) ? source.purpose : "context", ...(manual ? { requiresReview: true, verification: "manual" } : {}) });
  }
  const unique = new Map();
  for (const fact of facts) {
    requireShape(!unique.has(fact.factId) || JSON.stringify(unique.get(fact.factId)) === JSON.stringify(fact), "Один factId относится к разным фактам. Заново обработайте материалы.");
    unique.set(fact.factId, fact);
  }
  return [...unique.values()];
}

function parseFields(parsed, facts) {
  requireShape(isRecord(parsed) && Array.isArray(parsed.fields) && parsed.fields.length <= 30);
  const known = new Set(facts.map((fact) => fact.factId)), seen = new Set();
  const fields = parsed.fields.map((field) => {
    requireShape(isRecord(field));
    const path = String(field.path || "").replace(/^proposal\./, "");
    requireShape(SAFE_PATH.test(path) && !seen.has(path), "Используй только разрешённые пути, одно поле на путь, одну группу и один смысловой пункт.");
    seen.add(path);
    const text = boundedText(field.text, 3000, path);
    requireShape(Array.isArray(field.factIds) && field.factIds.length && field.factIds.every((id) => known.has(id)), "Каждое поле должно ссылаться на существующие подтверждающие factId.");
    return { path, text, factIds: [...new Set(field.factIds)] };
  }).filter((field) => field.text);
  requireShape(fields.length > 0, "Составь инструкцию из подтверждённых фактов; ответ fields не может быть пустым.");
  return { fields, warnings: warningsOf(parsed.warnings) };
}

function parseAudit(parsed, fields, facts) {
  requireShape(isRecord(parsed) && Array.isArray(parsed.checks) && Array.isArray(parsed.missingFactIds));
  const paths = new Set(fields.map((field) => field.path)), seen = new Set(), checks = [];
  for (const check of parsed.checks) {
    requireShape(isRecord(check) && paths.has(check.path) && !seen.has(check.path) && typeof check.supported === "boolean" && typeof check.relevant === "boolean", "Проверь каждый path ровно один раз.");
    seen.add(check.path); checks.push(check);
  }
  requireShape(paths.size === seen.size, "Не все поля инструкции проверены. Верни решение для каждого path.");
  const known = new Set(facts.map((fact) => fact.factId));
  requireShape(parsed.missingFactIds.every((id) => known.has(id)));
  return { checks, missingFactIds: [...new Set(parsed.missingFactIds)], warnings: warningsOf(parsed.warnings) };
}

function numbers(value) { return String(value).match(/\d+(?:[.,]\d+)?(?:\s*[%+])?/gu)?.map((n) => n.replace(/\s/g, "").replace(",", ".")) || []; }
function fieldIsReadable(field) {
  return !JARGON_RULES.some((rule) => rule.pattern.test(field.text)) && !/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b|\b(?:API|HTTP)\b|\b[a-z]+\/[a-z]+\b|тогг|эндпоинт|кешир|кэшир/iu.test(field.text);
}
function fieldNumbersSupported(field, byId, problems = []) {
  const corpus = field.factIds.map((id) => { const fact = byId.get(id); return fact.quote || (fact.requiresReview ? fact.statement : ""); }).join("\n");
  const allowed = new Set(numbers(corpus));
  const comparisons = (text) => {
    const normalized = String(text).toLowerCase().replace(/не\s+(?:менее|меньше)/gu, ">=").replace(/не\s+(?:более|больше)|не\s+превышает/gu, "<=").replace(/более|больше/gu, ">").replace(/менее|меньше/gu, "<").replace(/≥/gu, ">=").replace(/≤/gu, "<=");
    const result = [...normalized.matchAll(/([<>]=?|[=])\s*(\d+(?:[.,]\d+)?)/gu)].map((m) => `${m[1]}${m[2].replace(",", ".")}`);
    const reverse = { "<": ">", "<=": ">=", ">": "<", ">=": "<=" };
    for (const match of normalized.matchAll(/(\d+(?:[.,]\d+)?)\s*([<>]=?)\s*[\p{L}_][\p{L}\p{N}_]*/gu)) result.push(`${reverse[match[2]]}${match[1].replace(",", ".")}`);
    // A range stated in prose must not widen a strict numeric condition.
    for (const match of normalized.matchAll(/от\s+(\d+(?:[.,]\d+)?)\s+до\s+(\d+(?:[.,]\d+)?)/gu)) result.push(`>=${match[1].replace(",", ".")}`, `<=${match[2].replace(",", ".")}`);
    return result;
  };
  const allowedComparisons = new Set(comparisons(corpus));
  const integerCounter = [...byId.values()].some((fact) => /\bcount\b|сч[её]тчик/iu.test(fact.statement));
  if (integerCounter) {
    // For a counter, 0 < value < 100 and the user-facing range 1..99
    // are equivalent. Do not apply this conversion to money/continuous values.
    for (const comparison of [...allowedComparisons]) {
      const match = /^([<>]=?)(\d+)$/u.exec(comparison);
      if (!match) continue;
      const value = Number(match[2]);
      if (!Number.isSafeInteger(value)) continue;
      const boundary = value + ([">", "<="].includes(match[1]) ? 1 : -1);
      if (boundary < 0 || !Number.isSafeInteger(boundary)) continue;
      const equivalent = { ">": ">=", "<": "<=", ">=": ">", "<=": "<" }[match[1]];
      allowedComparisons.add(`${equivalent}${boundary}`);
      allowed.add(String(boundary));
    }
  }
  const unknownNumbers = [...new Set(numbers(field.text).filter((number) => !allowed.has(number)))];
  if (unknownNumbers.length) problems.push(`В источниках нет чисел: ${unknownNumbers.slice(0, 8).join(", ")}. Убери неподтверждённые значения.`);
  const unsupported = [...new Set(comparisons(field.text).filter((comparison) => !allowedComparisons.has(comparison)))];
  for (const comparison of unsupported.slice(0, 8)) {
    const match = /^([<>=]+)(.+)$/u.exec(comparison);
    const alternatives = [...allowedComparisons].filter((candidate) => {
      const condition = /^([<>=]+)(.+)$/u.exec(candidate);
      return condition && condition[2] === match[2] && condition[1][0] === match[1][0];
    });
    problems.push(alternatives.length ? `В тексте условие ${comparison}, а цитаты подтверждают ${alternatives.join(" или ")}. Исправь условие: равенство на границе существенно.` : `Условие ${comparison} не подтверждено цитатами. Сверь его с исходным правилом.`);
  }
  return !unknownNumbers.length && !unsupported.length;
}
function setPath(root, path, value) {
  const segments = path.replace(/\[(\d+)\]/g, ".$1").split(".");
  let current = root;
  segments.forEach((key, index) => {
    if (index === segments.length - 1) current[key] = value;
    else { if (current[key] == null) current[key] = /^\d+$/u.test(segments[index + 1]) ? [] : {}; current = current[key]; }
  });
}

function buildNormalized(fields, facts, warnings, manualAll = false, unresolved = []) {
  const byId = new Map(facts.map((fact) => [fact.factId, fact]));
  const proposal = {}, evidence = [];
  for (const field of fields) {
    let value = field.text;
    if (field.path.endsWith(".channels")) value = value.split(/[,;\s]+/u).map((v) => v.toLowerCase()).filter((v) => ["ios", "android", "web"].includes(v));
    setPath(proposal, field.path, value);
    for (const id of field.factIds) {
      const fact = byId.get(id), manual = manualAll || fact.requiresReview;
      evidence.push({ path: `proposal.${field.path}`, sourceId: fact.sourceId, page: null, snippet: fact.quote, confidence: manual ? 0.4 : 0.8, ...(manual ? { requiresReview: true, verification: "manual" } : {}) });
    }
  }
  const normalized = normalizeAiOutput(JSON.stringify({ schemaVersion: 4, proposal, evidence, warnings, unknowns: CORE_PATHS.flatMap((path, index) => fields.some((field) => field.path === path) ? [] : [CORE_LABELS[index]]) }), facts.map((fact) => fact.sourceId));
  // normalizeAiOutput deliberately normalizes legacy evidence to its public
  // shape; preserve topic review flags and full original quotations explicitly.
  normalized.evidence = evidence;
  // The legacy HTML sanitizer treats '< 100 ... > 0' as a tag and would erase
  // essential conditions after successful audit. Values are rendered as text by
  // the client. Restore validated text paths while retaining canonical IDs.
  for (const field of fields) if (!field.path.endsWith(".channels") && field.path !== "releaseDate") setPath(normalized.proposal, field.path, field.text);
  normalized.unknowns.push(...unresolved.map((question) => `Не уточнено: ${question.question}`));
  return normalized;
}

function emptyResult(warnings, processing = {}, unresolved = []) {
  const message = processing.validationFailed ? "Факты найдены, но основной текст модели не прошёл проверки. Попробуйте другую модель или подготовьте инструкцию по источникам. Заголовок без содержания не считается готовой инструкцией." : "По выбранной теме не осталось подтверждённых непротиворечивых фактов. Уточните тему или добавьте материал; инструкция не заполнена посторонними сведениями.";
  return { normalized: buildNormalized([], [], [...new Set([...warnings, message])], false, unresolved), processing: { mode: "topic", factsCount: 0, ...processing }, quality: { checked: true, passed: !unresolved.length && !processing.validationFailed, score: unresolved.length + Number(Boolean(processing.validationFailed)), issues: [], empty: true, degraded: Boolean(unresolved.length || processing.validationFailed), manualReviewRequired: Boolean(unresolved.length || processing.validationFailed) } };
}

function mergeQuestions(questions) {
  const grouped = new Map();
  for (const question of questions) {
    const key = quoteKey(question.question).toLocaleLowerCase("ru");
    const previous = grouped.get(key);
    grouped.set(key, previous ? { ...previous, factIds: [...new Set([...previous.factIds, ...question.factIds])] } : question);
  }
  const unique = [...grouped.values()];
  if (unique.length <= 3) return unique;
  const rest = unique.slice(2);
  const text = `Уточните противоречия: ${rest.map((q) => q.question).join(" ")}`.slice(0, 500);
  return [...unique.slice(0, 2), { id: `clarify-${hash(JSON.stringify(rest))}`, question: text, reason: rest.map((q) => q.reason).join(" ").slice(0, 700), factIds: [...new Set(rest.flatMap((q) => q.factIds))] }];
}

async function composeTopicInstruction(options) {
  const context = options.context || {}, brief = normalizeBrief(context.brief);
  if (!brief.topic) throw new HttpError(400, "TOPIC_REQUIRED", "Укажите тему инструкции.");
  const files = context.files || [], packets = context.packets || [], warnings = packets.flatMap((packet) => packet.warnings || []);
  let facts = validateStoredFacts(packets, files);
  const excluded = facts.filter((fact) => explicitlyExcluded(fact, brief));
  if (excluded.length) {
    const excludedIds = new Set(excluded.map((fact) => fact.factId));
    facts = facts.filter((fact) => !excludedIds.has(fact.factId));
    warnings.push(`По полю «Что исключить» убраны отдельные сведения без упоминания темы и её условий: ${excluded.length}.`);
  }
  const answers = answersAsFacts(context.clarificationAnswers || []);
  const extraSources = answers.map((fact) => ({ id: fact.sourceId, name: "Ответ на уточнение", text: fact.quote, purpose: "context", kind: "text" }));
  const knownIds = new Set([...facts, ...answers].map((fact) => fact.factId));
  const unresolved = [...(context.unansweredClarifications || []), ...(context.clarificationAnswers || []).filter((answer) => unknownAnswer(answer.answer))].map((question) => {
    requireShape(isRecord(question) && Array.isArray(question.factIds) && question.factIds.every((id) => knownIds.has(id)), "Не удалось сопоставить неотвеченное уточнение с фактами. Начните новую обработку.");
    return { id: boundedText(question.id, 100, "уточнение"), question: boundedText(question.question, 500, "вопрос"), reason: boundedText(question.reason || "Ответ не получен", 700, "причина"), factIds: [...new Set(question.factIds)] };
  });
  const blockedIds = new Set(unresolved.flatMap((question) => question.factIds));
  facts = facts.filter((fact) => !blockedIds.has(fact.factId));
  for (const question of unresolved) warnings.push(`Оставлено на проверку: ${question.question} Связанные противоречивые сведения исключены из инструкции.`);
  if (!facts.length) return emptyResult(warnings, { extraSources, unansweredClarifications: unresolved }, unresolved);
  const selected = [], questions = [];
  // If the ledger fits one bounded request, inspect all sources together once.
  // A second global pass is needed only after filtering several large batches.
  const fitsTogether = JSON.stringify(compactFacts([...facts, ...answers])).length + JSON.stringify(brief).length <= 10500;
  const batches = fitsTogether ? [facts] : factBatches(facts);
  const globalInspection = batches.length > 1;
  for (const batch of batches) {
    await options.onProgress?.({ phase: "topic-inspect", message: "Проверяем связь фактов с темой и подтверждение цитатами" });
    const inspection = await requestJson(options, { requestMode: "topic-inspect", files: [], brief, allowClarifications: !globalInspection, topicFacts: compactFacts([...batch, ...answers]), clarificationAnswers: context.clarificationAnswers || [], unansweredClarifications: unresolved, clarificationResolved: Boolean(context.clarificationResolved), maxOutputTokens: 1700 }, (parsed) => parseInspection(parsed, [...batch, ...answers]));
    selected.push(...inspection.facts);
    warnings.push(...inspection.warnings); if (!globalInspection) questions.push(...inspection.clarifications);
  }
  facts = [...new Map(selected.map((fact) => [fact.factId, fact])).values()];
  if (!selected.length) {
    const pending = mergeQuestions(questions);
    if (pending.length && !context.clarificationResolved) return { clarifications: pending, factsCount: 0, processing: { mode: "topic", extraSources }, warnings: [...new Set(warnings)] };
    return emptyResult(warnings, { extraSources, unansweredClarifications: [...unresolved, ...pending] }, [...unresolved, ...pending]);
  }
  if (facts.length > FACT_LIMIT) throw new HttpError(422, "TOPIC_TOO_BROAD", "По теме найдено слишком много разных фактов. Уточните, какой сценарий должен описывать текст. Уже обработанные материалы сохранены.");
  // This global pass also finds contradictions across files/batches; preserving
  // one ledger is essential to writing one instruction rather than concatenation.
  const topicFacts = compactFacts(facts);
  if (JSON.stringify(topicFacts).length + JSON.stringify(brief).length > 11500) throw new HttpError(422, "TOPIC_TOO_BROAD", "Объём фактов по теме слишком велик для одной связной инструкции. Сузьте тему или исключите второстепенные сценарии. Готовые материалы сохранены.");
  if (globalInspection) {
    const inspection = await requestJson(options, { requestMode: "topic-inspect", files: [], brief, topicFacts, clarificationAnswers: context.clarificationAnswers || [], unansweredClarifications: unresolved, clarificationResolved: Boolean(context.clarificationResolved), maxOutputTokens: 2200 }, (parsed) => parseInspection(parsed, facts));
    facts = inspection.facts; questions.push(...inspection.clarifications); warnings.push(...inspection.warnings);
  }
  const clarifications = mergeQuestions(questions);
  if (clarifications.length && !context.clarificationResolved) return { clarifications, factsCount: facts.length, processing: { mode: "topic", extraSources }, warnings: [...new Set(warnings)] };
  // Once the user chose to continue, a newly detected or still unresolved
  // contradiction is withheld as well; never let the model choose a side.
  if (context.clarificationResolved && clarifications.length) {
    unresolved.push(...clarifications);
    const conflicting = new Set(clarifications.flatMap((question) => question.factIds));
    facts = facts.filter((fact) => !conflicting.has(fact.factId));
    warnings.push(...clarifications.map((q) => `Не разрешено противоречие: ${q.question} Связанные сведения исключены.`));
  }
  if (!facts.length) return emptyResult(warnings, { extraSources, unansweredClarifications: unresolved }, unresolved);
  const common = { files: [], brief, topicFacts: compactFacts(facts), clarificationAnswers: context.clarificationAnswers || [], unansweredClarifications: unresolved, clarificationResolved: Boolean(context.clarificationResolved) };
  let composed, audit, repairAttempted = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    await options.onProgress?.({ phase: "topic-compose", message: attempt ? "Уточняем инструкцию по результатам проверки" : "Составляем единую инструкцию для КЦ и клиента" });
    composed = await requestJson(options, { ...common, requestMode: "topic-compose", maxOutputTokens: 1800, ...(attempt ? { topicRepair: { message: "Сохрани правильные формулировки previousFields. Исправь ошибочные утверждения и восстанови общие пропуски преимущественно в supportNote, без дублирования ограничений во всех полях.", previousFields: composed.fields, checks: audit.checks.filter((item) => !item.supported || !item.relevant), missingFactIds: audit.missingFactIds, warnings: audit.warnings } } : {}) }, (parsed) => parseFields(parsed, facts));
    await options.onProgress?.({ phase: "topic-audit", message: "Проверяем каждую формулировку, ограничения и соответствие теме" });
    audit = await requestJson(options, { ...common, requestMode: "topic-audit", topicFields: composed.fields, maxOutputTokens: 1800 }, (parsed) => parseAudit(parsed, composed.fields, facts));
    const byId = new Map(facts.map((fact) => [fact.factId, fact]));
    for (const check of audit.checks) {
      const field = composed.fields.find((field) => field.path === check.path);
      const numericProblems = [];
      if (!fieldNumbersSupported(field, byId, numericProblems)) { check.supported = false; check.reason = numericProblems.join(" "); }
      if (!fieldIsReadable(field)) { check.relevant = false; check.reason = "Перепиши понятным языком без API, служебных флагов и жаргона. Клиент не управляет служебными флагами: не превращай их в пользовательский переключатель или специальный режим настроек. Сохрани смысл как условие доступности функции, а не действие клиента."; }
    }
    if (audit.checks.every((item) => item.supported && item.relevant) && !audit.missingFactIds.length) break;
    repairAttempted = true;
  }
  const acceptedPaths = new Set(audit.checks.filter((item) => item.supported && item.relevant).map((item) => item.path));
  const accepted = composed.fields.filter((field) => acceptedPaths.has(field.path));
  const removed = composed.fields.length - accepted.length;
  const missing = audit.missingFactIds.length;
  warnings.push(...composed.warnings, ...audit.warnings);
  if (removed) warnings.push(`Не включены неподтверждённые или посторонние поля: ${removed}.`);
  if (missing) warnings.push(`Инструкция может быть неполной: не отражены существенные факты (${missing}). Сравните с источниками перед применением.`);
  if (!accepted.some((field) => CORE_PATHS.includes(field.path))) return emptyResult([...warnings, "Модель не смогла подтвердить основной текст; предложения не применены."], { extraSources, factsCount: facts.length, unansweredClarifications: unresolved, validationFailed: true }, unresolved);
  // A second answer from the same model is not independent factual verification.
  // Topic drafts require the author's review even after automated checks pass.
  const manual = true;
  const normalized = buildNormalized(accepted, facts, [...new Set(warnings)], true, unresolved);
  return { normalized, processing: { mode: "topic", factsCount: facts.length, excludedFacts: new Set(selected.map((fact) => fact.factId)).size - facts.length + blockedIds.size, extraSources, unansweredClarifications: unresolved, reviewSourceIds: [...new Set(normalized.evidence.filter((e) => e.requiresReview).map((e) => e.sourceId))] }, quality: { checked: true, passed: !removed && !missing && !unresolved.length, repairAttempted, repaired: repairAttempted && !removed && !missing, manualReviewRequired: manual, degraded: Boolean(removed || missing || unresolved.length), score: removed + missing + unresolved.length, issues: [] } };
}

module.exports = { normalizeBrief, extractTopicFacts, composeTopicInstruction, topicUnits, actualQuote, parsePacket, parseInspection, parseFields, parseAudit, buildNormalized, explicitlyExcluded };
