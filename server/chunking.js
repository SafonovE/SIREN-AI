"use strict";

const crypto = require("node:crypto");
const { parseJsonCandidate } = require("./schema");
const { HttpError, asPlainText, isRecord } = require("./util");

const MAP_CHUNK_CHARS = 4200;
const MIN_RETRY_CHARS = 400;
const FINAL_LEDGER_CHARS = 5200;
const REDUCE_BATCH_CHARS = 7000;
const MAX_REDUCTION_ROUNDS = 5;
const CONTEXT_ERROR_CODES = new Set(["PROVIDER_CONTEXT_LIMIT", "PROVIDER_REQUEST_TOO_LARGE"]);

function isContextError(error) {
  return Boolean(error && CONTEXT_ERROR_CODES.has(error.code));
}

function splitPoint(text, start, tentativeEnd) {
  if (tentativeEnd >= text.length) return text.length;
  let end = tentativeEnd;
  if (/^[\uDC00-\uDFFF]$/u.test(text[end]) && /^[\uD800-\uDBFF]$/u.test(text[end - 1])) end -= 1;
  const minimum = start + Math.floor((end - start) * 0.6);
  const candidates = ["\n\n", "\n", ". ", "; ", " "];
  for (const marker of candidates) {
    const found = text.lastIndexOf(marker, end - 1);
    if (found >= minimum) return found + marker.length;
  }
  return end;
}

function splitTextPreserving(value, maxChars = MAP_CHUNK_CHARS) {
  const text = String(value || "");
  const limit = Math.max(MIN_RETRY_CHARS, Number(maxChars) || MAP_CHUNK_CHARS);
  if (!text) return [""];
  const parts = [];
  let start = 0;
  while (start < text.length) {
    const end = splitPoint(text, start, Math.min(text.length, start + limit));
    if (end <= start) throw new Error("Unable to split material text safely.");
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}

function materialChars(files) {
  return (Array.isArray(files) ? files : []).reduce((sum, file) => sum + String(file?.text || "").length, 0);
}

function effectiveBoundary(provider, config = {}) {
  if (provider?.configurablePolicy && ["public", "corporate", "local"].includes(config?.dataBoundary)) return config.dataBoundary;
  return provider?.dataBoundary || "public";
}

function directInputLimit(provider, config = {}) {
  if (!provider) return 12000;
  const boundary = effectiveBoundary(provider, config);
  if (boundary === "local" || ["ollama", "lmstudio"].includes(provider.id)) return 5200;
  if (boundary === "corporate") return 16000;
  return 48000;
}

function shouldChunkContext(provider, context, config = {}) {
  const files = Array.isArray(context?.files) ? context.files : [];
  const draftChars = JSON.stringify(context?.currentDraft || {}).length;
  const imageCount = files.filter((file) => file?.kind === "image").length;
  return materialChars(files) + draftChars > directInputLimit(provider, config) || imageCount > 3;
}

function unitsFromFiles(files, chunkChars = MAP_CHUNK_CHARS) {
  const units = [];
  for (const file of Array.isArray(files) ? files : []) {
    const textParts = splitTextPreserving(file?.text || "", chunkChars);
    const hasImage = file?.kind === "image" && file?.buffer && file.buffer.length;
    if (!hasImage && textParts.length === 1 && !textParts[0]) {
      units.push({
        unitId: `${file.id}:empty`,
        sourceId: file.id,
        sourceName: file.name,
        purpose: file.purpose,
        part: 1,
        totalParts: 1,
        file: { ...file, text: "", buffer: Buffer.alloc(0), kind: "text", mime: "text/plain" },
        emptyReason: "Текст из материала не удалось извлечь локально.",
      });
      continue;
    }
    textParts.forEach((text, index) => {
      units.push({
        unitId: `${file.id}:${index + 1}:${crypto.createHash("sha1").update(text).digest("hex").slice(0, 10)}`,
        sourceId: file.id,
        sourceName: file.name,
        purpose: file.purpose,
        part: index + 1,
        totalParts: textParts.length,
        file: {
          ...file,
          name: textParts.length > 1 ? `${file.name} — часть ${index + 1} из ${textParts.length}` : file.name,
          text,
          ...(hasImage && index === 0 ? {} : { buffer: Buffer.alloc(0), kind: "text", mime: "text/plain" }),
        },
      });
    });
  }
  return units;
}

function normalizeAnchor(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[\u00a0\u202f\s]+/gu, "")
    .replace(/,/g, ".");
}

function criticalAnchors(value) {
  const text = String(value || "");
  const anchors = new Set();
  const patterns = [
    /(?<![\p{L}\p{N}])\d+(?:[\s.,]\d+)*\s*(?:%|₽|руб(?:\.|ля|лей)?|дн(?:я|ей)?|час(?:а|ов)?|минут(?:а|ы)?|секунд(?:а|ы)?|недел(?:я|и|ь)?|месяц(?:а|ев)?|год(?:а|ов)?|клиент(?:а|ов)?|заяв(?:ка|ки|ок)|операци(?:я|и|й))(?![\p{L}\p{N}])/giu,
    /(?<![\p{L}\p{N}])(?:до|не\s+более|не\s+менее|минимум|максимум|лимит)\s*[:=—-]?\s*\d+(?:[.,]\d+)?/giu,
    /\b(?:iOS|Android|Web)\b/giu,
    /\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/gu,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const anchor = normalizeAnchor(match[0]);
      if (anchor) anchors.add(anchor);
    }
  }
  return [...anchors];
}

function factText(fact) {
  return `${fact.statement || ""}\n${fact.quote || ""}`;
}

function missingAnchors(sourceText, facts) {
  const output = normalizeAnchor((facts || []).map(factText).join("\n"));
  return criticalAnchors(sourceText).filter((anchor) => !output.includes(anchor));
}

function supplementalFacts(sourceText, anchors, sourceId) {
  const sections = String(sourceText || "").split(/(?<=[.!?;\n])/u).map((item) => item.trim()).filter(Boolean);
  return anchors.map((anchor) => {
    const excerpt = sections.find((section) => normalizeAnchor(section).includes(anchor));
    if (!excerpt) return null;
    const safeExcerpt = asPlainText(excerpt, 1200);
    return {
      factId: `fact-${crypto.randomUUID()}`,
      statement: safeExcerpt,
      quote: asPlainText(excerpt, 500),
      sourceIds: [sourceId],
      sourceFactIds: [],
    };
  }).filter(Boolean);
}

function normalizeFactPacket(rawText, unit, options = {}) {
  const parsed = parseJsonCandidate(rawText);
  if (!isRecord(parsed)) throw new HttpError(502, "AI_FACTS_INVALID", `Модель вернула неверный ответ для материала «${unit.sourceName}», часть ${unit.part} из ${unit.totalParts}. Повторите анализ или выберите другую модель.`);
  const input = Array.isArray(parsed.facts) ? parsed.facts : [];
  if (input.length > 200) {
    throw new HttpError(502, "AI_FACTS_TOO_MANY", `Модель вернула слишком много фактов для материала «${unit.sourceName}», часть ${unit.part} из ${unit.totalParts}. Siren попробует меньшие части.`);
  }
  const sourceText = String(unit.file.text || "");
  let manualFallbackCount = 0;
  const facts = input.map((value) => {
    const item = isRecord(value) ? value : { statement: value };
    let quote = asPlainText(item.quote || item.snippet || item.evidence, 500);
    let requiresReview = false;
    if (unit.file.kind === "image" && !sourceText.trim()) {
      requiresReview = true;
      quote = "";
    }
    if (sourceText.trim() && !quote) {
      if (options.retry !== true) {
        throw new HttpError(502, "AI_FACT_QUOTE_MISSING", `Модель не указала подтверждающий фрагмент для материала «${unit.sourceName}», часть ${unit.part} из ${unit.totalParts}. Повторите анализ или выберите другую модель.`);
      }
      requiresReview = true;
    }
    if (sourceText.trim() && quote && !normalizeAnchor(sourceText).includes(normalizeAnchor(quote))) {
      if (options.retry !== true) {
        throw new HttpError(502, "AI_FACT_QUOTE_INVALID", `Модель указала подтверждение, которого нет в материале «${unit.sourceName}», часть ${unit.part} из ${unit.totalParts}. Повторите анализ или выберите другую модель.`);
      }
      requiresReview = true;
      quote = "";
    }
    if (requiresReview) manualFallbackCount += 1;
    return {
      factId: `fact-${crypto.randomUUID()}`,
      statement: asPlainText(item.statement || item.text || item.fact, 1200),
      quote,
      sourceIds: [unit.sourceId],
      sourceFactIds: [],
      ...(requiresReview ? { requiresReview: true, verification: "manual" } : {}),
    };
  }).filter((fact) => fact.statement);
  const irrelevantReason = asPlainText(parsed.irrelevantReason || parsed.noRelevantFactsReason, 500);
  const coverage = asPlainText(parsed.coverage, 30).toLowerCase();
  if (!facts.length && !irrelevantReason && String(unit.file.text || "").trim()) {
    throw new HttpError(502, "AI_FACTS_EMPTY", `Модель не разобрала материал «${unit.sourceName}», часть ${unit.part} из ${unit.totalParts}. Повторите анализ или выберите другую модель.`);
  }
  if (String(unit.file.text || "").trim() && coverage !== "complete") {
    throw new HttpError(502, "AI_FACTS_INCOMPLETE", `Модель не подтвердила полную обработку материала «${unit.sourceName}», часть ${unit.part} из ${unit.totalParts}. Повторите анализ или выберите другую модель.`);
  }
  const warnings = Array.isArray(parsed.warnings) ? parsed.warnings.map((item) => asPlainText(item, 500)).filter(Boolean).slice(0, 20) : [];
  if (manualFallbackCount) {
    warnings.unshift(`Факты без точного совпадения с извлечённым текстом: ${manualFallbackCount}. Сравните отмеченные предложения с исходным материалом перед применением.`);
  }
  return { facts, irrelevantReason, warnings, requiresManualReview: manualFallbackCount > 0 };
}

function retryableFactError(error) {
  return Boolean(error && ["INVALID_AI_JSON", "AI_FACTS_INVALID", "AI_FACTS_EMPTY", "AI_FACTS_INCOMPLETE", "AI_FACTS_TOO_MANY", "AI_FACT_QUOTE_MISSING", "AI_FACT_QUOTE_INVALID"].includes(error.code));
}

async function extractSmallerUnits(options, unit, callProvider, deadlineAt, stats) {
  const text = String(unit.file.text || "");
  const halves = splitTextPreserving(text, Math.max(MIN_RETRY_CHARS, Math.floor(text.length / 2)));
  const facts = [];
  for (let index = 0; index < halves.length; index += 1) {
    const child = {
      ...unit,
      unitId: `${unit.unitId}.${index + 1}`,
      part: index + 1,
      totalParts: halves.length,
      file: { ...unit.file, text: halves[index], name: `${unit.sourceName} — уменьшенная часть ${index + 1} из ${halves.length}` },
    };
    facts.push(...await extractUnitFacts({ ...options, missingAnchors: [] }, child, callProvider, deadlineAt, stats));
  }
  return facts;
}

async function extractUnitFacts(options, unit, callProvider, deadlineAt, stats, retry = false) {
  if (options.signal?.aborted) throw new HttpError(499, "ANALYSIS_CANCELLED", "Анализ отменён. Материалы остались в списке — его можно запустить снова.");
  if (unit.emptyReason) {
    stats.unitsProcessed += 1;
    stats.warnings.push(`${unit.sourceId}: ${unit.emptyReason}`);
    return [];
  }
  try {
    const result = await callProvider({
      ...options,
      context: {
        files: [unit.file],
        currentDraft: {},
        mergeMode: "fill-empty",
        requestMode: "fact-extraction",
        sourceId: unit.sourceId,
        sourceName: unit.sourceName,
        part: unit.part,
        totalParts: unit.totalParts,
        maxOutputTokens: 900,
        factRetry: retry,
        missingAnchors: Array.isArray(options.missingAnchors) ? options.missingAnchors : [],
      },
      deadlineAt,
    });
    const packet = normalizeFactPacket(result.text, unit, { retry });
    if (packet.requiresManualReview) stats.reviewSourceIds.add(String(unit.sourceId));
    const missing = missingAnchors(unit.file.text, packet.facts);
    if (missing.length) {
      if (!retry) {
        return extractUnitFacts({ ...options, missingAnchors: missing }, unit, callProvider, deadlineAt, stats, true);
      }
      packet.facts.push(...supplementalFacts(unit.file.text, missing, unit.sourceId));
      const stillMissing = missingAnchors(unit.file.text, packet.facts);
      if (stillMissing.length) {
        throw new HttpError(
          502,
          "AI_FACTS_LOST_CRITICAL_DATA",
          `Не удалось без искажений сохранить важные значения из материала «${unit.sourceName}», часть ${unit.part} из ${unit.totalParts}. Разделите этот материал или выберите другую модель.`,
          { sourceId: unit.sourceId, part: unit.part, totalParts: unit.totalParts }
        );
      }
      stats.warnings.push(`${unit.sourceId}: важные числа, даты или платформы сохранены напрямую из исходного текста.`);
    }
    stats.unitsProcessed += 1;
    stats.warnings.push(...packet.warnings.map((message) => `«${unit.sourceName}»: ${message}`));
    return packet.facts;
  } catch (error) {
    if (isContextError(error) || error?.code === "PROVIDER_TIMEOUT") {
      const text = String(unit.file.text || "");
      const hasImage = unit.file.kind === "image" && unit.file.buffer?.length;
      if (error.code === "PROVIDER_TIMEOUT" && (hasImage || text.length <= MIN_RETRY_CHARS)) throw error;
      if (hasImage) {
        throw new HttpError(422, "MODEL_CONTEXT_TOO_SMALL_FOR_IMAGE", `Изображение «${unit.sourceName}» не помещается в контекст модели. Используйте модель с поддержкой изображений и большим контекстом либо добавьте описание изображения текстом.`);
      }
      if (text.length <= MIN_RETRY_CHARS) {
        throw new HttpError(422, "MODEL_CONTEXT_TOO_SMALL", `Контекст выбранной модели слишком мал даже для небольшой части материала «${unit.sourceName}». Увеличьте контекст модели или выберите другую модель.`);
      }
      stats.contextRetries += 1;
      return extractSmallerUnits(options, unit, callProvider, deadlineAt, stats);
    }
    if (!retry && retryableFactError(error)) return extractUnitFacts(options, unit, callProvider, deadlineAt, stats, true);
    if (retry && retryableFactError(error) && unit.file.kind !== "image" && String(unit.file.text || "").length > MIN_RETRY_CHARS) {
      stats.contextRetries += 1;
      return extractSmallerUnits(options, unit, callProvider, deadlineAt, stats);
    }
    throw error;
  }
}

function factPayload(fact) {
  return {
    factId: fact.factId,
    statement: fact.statement,
    quote: fact.quote,
    sourceIds: fact.sourceIds,
    ...(fact.requiresReview ? { requiresReview: true, verification: "manual" } : {}),
  };
}

function batchFacts(facts, maxChars = REDUCE_BATCH_CHARS) {
  const batches = [];
  let current = [];
  let size = 0;
  let sourceKey = "";
  for (const fact of facts) {
    const length = JSON.stringify(factPayload(fact)).length + 2;
    const nextSourceKey = [...(fact.sourceIds || [])].sort().join("|");
    if (current.length && (size + length > maxChars || nextSourceKey !== sourceKey)) {
      batches.push(current);
      current = [];
      size = 0;
    }
    if (!current.length) sourceKey = nextSourceKey;
    current.push(fact);
    size += length;
  }
  if (current.length) batches.push(current);
  return batches;
}

function parseReducedFacts(rawText, inputFacts) {
  const parsed = parseJsonCandidate(rawText);
  const output = Array.isArray(parsed?.facts) ? parsed.facts : [];
  const inputById = new Map(inputFacts.map((fact) => [fact.factId, fact]));
  const covered = new Set();
  const facts = output.slice(0, 200).map((value) => {
    const item = isRecord(value) ? value : {};
    const sourceFactIds = (Array.isArray(item.sourceFactIds) ? item.sourceFactIds : [])
      .map(String)
      .filter((id) => inputById.has(id));
    sourceFactIds.forEach((id) => covered.add(id));
    const sourceIds = [...new Set(sourceFactIds.flatMap((id) => inputById.get(id).sourceIds))];
    const requiresReview = sourceFactIds.some((id) => inputById.get(id)?.requiresReview === true);
    return {
      factId: `fact-${crypto.randomUUID()}`,
      statement: asPlainText(item.statement || item.text || item.fact, 1600),
      quote: requiresReview ? "" : asPlainText(item.quote || item.snippet, 500),
      sourceIds,
      sourceFactIds,
      ...(requiresReview ? { requiresReview: true, verification: "manual" } : {}),
    };
  }).filter((fact) => fact.statement && fact.sourceFactIds.length);
  const missingIds = inputFacts.map((fact) => fact.factId).filter((id) => !covered.has(id));
  const anchors = missingAnchors(inputFacts.map(factText).join("\n"), facts);
  if (!facts.length || missingIds.length || anchors.length) {
    throw new HttpError(502, "AI_FACT_COVERAGE_FAILED", "Модель не смогла без потерь объединить все извлечённые факты. Выберите более точную модель или разделите материалы на два анализа.", { missingFactCount: missingIds.length, missingCriticalValueCount: anchors.length });
  }
  return facts;
}

async function reduceBatch(options, batch, callProvider, deadlineAt, retry = false) {
  const sourceIds = [...new Set(batch.flatMap((fact) => fact.sourceIds))];
  const file = {
    id: sourceIds[0] || "fact-ledger",
    name: "Промежуточный реестр фактов.json",
    purpose: "context",
    kind: "text",
    mime: "application/json",
    text: JSON.stringify({ facts: batch.map(factPayload) }),
    buffer: Buffer.alloc(0),
    scanComplete: true,
    warnings: [],
  };
  try {
    const result = await callProvider({
      ...options,
      context: {
        files: [file],
        currentDraft: {},
        mergeMode: "fill-empty",
        requestMode: "fact-reduction",
        maxOutputTokens: 1100,
        factRetry: retry,
      },
      deadlineAt,
    });
    return parseReducedFacts(result.text, batch);
  } catch (error) {
    if ((isContextError(error) || error?.code === "PROVIDER_TIMEOUT") && batch.length > 1) {
      const middle = Math.ceil(batch.length / 2);
      return [
        ...await reduceBatch(options, batch.slice(0, middle), callProvider, deadlineAt),
        ...await reduceBatch(options, batch.slice(middle), callProvider, deadlineAt),
      ];
    }
    if (!retry && (retryableFactError(error) || error?.code === "AI_FACT_COVERAGE_FAILED")) {
      return reduceBatch(options, batch, callProvider, deadlineAt, true);
    }
    throw error;
  }
}

function ledgerChars(facts) {
  return JSON.stringify(facts.map(factPayload)).length;
}

async function reduceFacts(options, initialFacts, callProvider, deadlineAt, stats, targetChars = FINAL_LEDGER_CHARS) {
  let facts = initialFacts;
  for (let round = 0; ledgerChars(facts) > targetChars; round += 1) {
    if (round >= MAX_REDUCTION_ROUNDS) {
      throw new HttpError(422, "MATERIALS_TOO_COMPLEX", "Материалы содержат слишком много разных фактов для контекста выбранной модели. Разделите их на два анализа или выберите модель с большим контекстом.");
    }
    const reduced = [];
    for (const batch of batchFacts(facts)) reduced.push(...await reduceBatch(options, batch, callProvider, deadlineAt));
    if (ledgerChars(reduced) >= ledgerChars(facts) && reduced.length >= facts.length) {
      throw new HttpError(422, "MATERIALS_TOO_COMPLEX", "Модель не смогла достаточно компактно объединить материалы без потери фактов. Разделите материалы на два анализа или выберите модель с большим контекстом.");
    }
    facts = reduced;
    stats.reductionRounds += 1;
  }
  return facts;
}

function ledgerFiles(facts, originalFiles) {
  const bySource = new Map((originalFiles || []).map((file) => [String(file.id), []]));
  for (const fact of facts) {
    for (const sourceId of fact.sourceIds) {
      if (!bySource.has(String(sourceId))) bySource.set(String(sourceId), []);
      bySource.get(String(sourceId)).push(fact);
    }
  }
  return (originalFiles || []).map((file) => {
    const sourceFacts = bySource.get(String(file.id)) || [];
    return {
      ...file,
      kind: "text",
      mime: "text/plain",
      buffer: Buffer.alloc(0),
      text: sourceFacts.length
        ? sourceFacts.map((fact) => `[${fact.factId}] ${fact.statement}${fact.quote ? `\nПодтверждение: ${fact.quote}` : ""}${fact.requiresReview ? "\nПроверка: автоматическое подтверждение не найдено; сотрудник должен сравнить предложение с исходным материалом." : ""}`).join("\n\n")
        : "[Для итогового описания значимые факты в этом материале не найдены.]",
    };
  });
}

async function prepareChunkedContext(options, callProvider, deadlineAt) {
  const originalContext = options.context;
  const stats = { unitsPlanned: 0, unitsProcessed: 0, contextRetries: 0, reductionRounds: 0, warnings: [], reviewSourceIds: new Set() };
  const local = effectiveBoundary(options.provider, options.config) === "local";
  const units = unitsFromFiles(originalContext.files, Number(options.config?.chunkChars) || (local ? 1400 : MAP_CHUNK_CHARS));
  stats.unitsPlanned = units.length;
  const facts = [];
  for (const [index, unit] of units.entries()) {
    await options.onProgress?.({ part: index + 1, parts: units.length, message: `Часть ${index + 1} из ${units.length}` });
    facts.push(...await extractUnitFacts(options, unit, callProvider, deadlineAt, stats));
  }
  if (!facts.length) {
    throw new HttpError(422, "NO_RELEVANT_FACTS", "В материалах не удалось найти сведения для заполнения инструкции. Добавьте описание изменения текстом или выберите более подходящие файлы.");
  }
  const localModel = effectiveBoundary(options.provider, options.config) === "local" || ["ollama", "lmstudio"].includes(options.provider?.id);
  const draftChars = JSON.stringify(originalContext.currentDraft || {}).length;
  const targetChars = localModel
    ? Math.max(1400, 2600 - Math.min(1200, draftChars))
    : Math.max(3000, FINAL_LEDGER_CHARS - Math.min(1800, draftChars));
  const requestedTarget = Number(options.chunkTargetChars);
  const effectiveTarget = Number.isFinite(requestedTarget) ? Math.max(700, Math.min(targetChars, requestedTarget)) : targetChars;
  const reduced = await reduceFacts(options, facts, callProvider, deadlineAt, stats, effectiveTarget);
  return {
    context: { ...originalContext, files: ledgerFiles(reduced, originalContext.files), sourceLedger: true },
    processing: {
      mode: "chunked",
      chunks: stats.unitsProcessed,
      contextRetries: stats.contextRetries,
      reductionRounds: stats.reductionRounds,
      targetChars: effectiveTarget,
      warnings: stats.warnings,
      reviewSourceIds: [...stats.reviewSourceIds],
    },
  };
}

module.exports = {
  FINAL_LEDGER_CHARS,
  MAP_CHUNK_CHARS,
  criticalAnchors,
  directInputLimit,
  effectiveBoundary,
  isContextError,
  ledgerChars,
  materialChars,
  prepareChunkedContext,
  shouldChunkContext,
  splitTextPreserving,
  unitsFromFiles,
};
