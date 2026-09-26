"use strict";

const { analyzeWithProvider } = require("./providers");
const { normalizeAiOutput } = require("./schema");
const {
  buildQualityRepair,
  evaluateProposalQuality,
  normalizeText,
  proposalEntries,
  publicIssue,
  qualityWarnings,
} = require("./quality");
const { HttpError } = require("./util");
const { isContextError, prepareChunkedContext, shouldChunkContext } = require("./chunking");
const { reliableCall } = require("./reliable-call");

const MIN_PROVIDER_TIMEOUT_MS = 250;
const RETRYABLE_OUTPUT_CODES = new Set(["EMPTY_PROVIDER_RESPONSE", "INVALID_AI_JSON", "INVALID_AI_SHAPE"]);
const EVIDENCE_STOP_WORDS = new Set(["для", "или", "при", "это", "как", "что", "будет", "будут", "после", "перед", "только", "клиент", "клиенты", "клиентов", "сотрудник", "сотрудники", "сотрудника"]);
const ACTION_RULES = Object.freeze([
  ["check", /^(?:проверить|проверьте|проверяет|проверяют|сверить|сверьте|сверяет|сверяют)$/u],
  ["click", /^(?:нажать|нажмите|нажимает|нажимают)$/u],
  ["select", /^(?:выбрать|выберите|выбирает|выбирают)$/u],
  ["open", /^(?:открыть|откройте|открывает|открывают)$/u],
  ["enter", /^(?:ввести|введите|вводит|вводят|указать|укажите|указывает|указывают)$/u],
  ["go", /^(?:перейти|перейдите|переходит|переходят)$/u],
  ["contact", /^(?:обратиться|обратитесь|обращается|обращаются)$/u],
  ["tell", /^(?:сообщить|сообщите|сообщает|сообщают)$/u],
  ["remove", /^(?:удалить|удалите|удаляет|удаляют)$/u],
  ["add", /^(?:добавить|добавьте|добавляет|добавляют)$/u],
  ["confirm", /^(?:подтвердить|подтвердите|подтверждает|подтверждают)$/u],
  ["send", /^(?:отправить|отправьте|отправляет|отправляют)$/u],
  ["promise", /^(?:обещать|обещайте|обещает|обещают)$/u],
]);

function plainLanguage(value) {
  const source = String(value || "");
  if (/^\s*(?:a|а)\s*[/\\-]\s*(?:b|б)[-\s]?тест(?:ирование)?\s*$/iu.test(source)) return "Для части клиентов";
  return source
    .replace(/(?<![\p{L}\p{N}])(?:a|а)\s*[/\\-]\s*(?:b|б)[-\s]?тест(?:ирование)?(?![\p{L}\p{N}])/giu, "тестирование для части клиентов")
    .replace(/(?<![\p{L}\p{N}])каунтер([а-яё-]*)(?![\p{L}\p{N}])/giu, "счётчик$1")
    .replace(/(?<![\p{L}\p{N}])функционал(?![\p{L}\p{N}])/giu, "возможность")
    .replace(/(?<![\p{L}\p{N}])ролл(?:аут|аута|аутом|ауте)(?![\p{L}\p{N}])/giu, "поэтапный запуск")
    .replace(/(?<![\p{L}\p{N}])флоу(?![\p{L}\p{N}])/giu, "порядок действий");
}

function simplifyProposalLanguage(value, key = "") {
  if (Array.isArray(value)) return value.map((item) => simplifyProposalLanguage(item, key));
  if (!value || typeof value !== "object") return typeof value === "string" && key !== "id" ? plainLanguage(value) : value;
  return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, simplifyProposalLanguage(child, childKey)]));
}

function semanticToken(value) {
  const token = String(value || "").replace(/ё/g, "е");
  if (/^(?:счетчик|количеств|числ)/u.test(token)) return "счет";
  if (/^(?:сколько)/u.test(token)) return "счет";
  if (/^(?:появ|показ|отображ|видн|увид)/u.test(token)) return "показ";
  if (/^(?:прилож|ios|android|айос|андроид)/u.test(token)) return "прилож";
  if (/^(?:активн)/u.test(token)) return "активн";
  if (/^(?:заяв)/u.test(token)) return "заявк";
  if (/^(?:уведом|сообщ)/u.test(token)) return "сообщ";
  if (/^(?:руковод)/u.test(token)) return "руковод";
  return token;
}

function evidenceTokens(value) {
  return [...new Set(normalizeText(value)
    .split(" ")
    .filter((token) => token.length >= 3 && !EVIDENCE_STOP_WORDS.has(token))
    .map(semanticToken))];
}

function actionIntents(value) {
  const tokens = normalizeText(value).split(" ");
  return new Set(ACTION_RULES.filter(([, pattern]) => tokens.some((token) => pattern.test(token))).map(([intent]) => intent));
}

function actionIntentsSupported(value, candidates) {
  const requested = actionIntents(value);
  if (!requested.size) return true;
  const available = new Set(candidates.flatMap((candidate) => [...actionIntents(candidate.snippet)]));
  return [...requested].every((intent) => available.has(intent));
}

function draftStrings(value, result = []) {
  if (typeof value === "string" && value.trim()) result.push(value.trim());
  else if (Array.isArray(value)) value.forEach((item) => draftStrings(item, result));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => draftStrings(item, result));
  return result;
}

function evidenceCandidates(files, currentDraft = {}) {
  const candidates = [];
  for (const file of Array.isArray(files) ? files : []) {
    const sections = String(file?.text || "")
      .replace(/(?<=\d)\.(?=\d)/gu, "\uE000")
      .split(/(?<=[.!?;\n])/u)
      .map((item) => item.replace(/\uE000/gu, "."))
      .map((item) => item.trim())
      .filter(Boolean);
    for (const section of sections) {
      candidates.push({
        sourceId: String(file.id || ""),
        snippet: section.slice(0, 500),
        normalized: normalizeText(section),
        tokens: new Set(evidenceTokens(section)),
      });
    }
  }
  for (const section of draftStrings(currentDraft)) {
    candidates.push({
      sourceId: "",
      snippet: section.slice(0, 500),
      normalized: normalizeText(section),
      tokens: new Set(evidenceTokens(section)),
    });
  }
  return candidates;
}

function bestEvidence(entry, candidates) {
  const normalized = normalizeText(entry.value);
  const tokens = evidenceTokens(entry.value);
  if (!normalized || !tokens.length) return null;
  let best = null;
  for (const candidate of candidates) {
    const common = tokens.filter((token) => candidate.tokens.has(token)).length;
    const exact = candidate.normalized.includes(normalized);
    const score = exact ? 1 : common / Math.max(2, Math.min(tokens.length, 8));
    const acceptable = exact || (common >= 2 && score >= 0.4) || (tokens.length === 1 && common === 1 && normalized.length >= 6);
    if (acceptable && (!best || score > best.score)) best = { ...candidate, score, exact };
  }
  return best;
}

function supportedText(value, key, candidates, allowFromImage = false) {
  const source = String(value || "").trim();
  if (!source) return "";
  if (/\b(?:say|dontSay|details|title|after|before|clientAction|supportNote)\s*\\?["']?\s*:\s*\\?["']?/iu.test(source)) return "";
  if (allowFromImage) return source;
  if (key === "rolloutMode" && /(?:част[ьи]\s+клиент|поэтапн)/iu.test(source)) {
    const corpus = candidates.map((item) => item.normalized).join(" ");
    return /(?:\b(?:a|а)\s*(?:[/\\-]|\s)\s*(?:b|б)\b|\b\d{1,3}\s*%|част[ьи]\s+клиент|поэтапн)/iu.test(corpus) ? source : "";
  }
  const strictKeys = new Set(["availability", "before", "clientAction", "supportNote", "say", "dontSay", "details", "question", "answer"]);
  const actionKeys = new Set(["clientAction", "supportNote", "dontSay", "answer"]);
  const threshold = strictKeys.has(key) ? 0.7 : 0.5;
  const sentences = source.split(/(?<=[.!?;\n])/u).map((item) => item.trim()).filter(Boolean);
  return sentences.filter((sentence) => {
    if (/^(?:не\s+указано|нет\s+данных|неизвестно)[.!?]?$/iu.test(sentence)) return false;
    if (actionKeys.has(key) && !actionIntentsSupported(sentence, candidates)) return false;
    const match = bestEvidence({ value: sentence }, candidates);
    return Boolean(match && (match.exact || match.score >= threshold));
  }).join(" ").trim();
}

function itemContent(item) {
  return [item?.title, item?.before, item?.after, item?.clientAction, item?.supportNote].filter(Boolean).join(" ");
}

function itemNumbers(item) {
  return new Set(normalizeText(itemContent(item)).match(/\b\d+(?:[.,]\d+)?%?\b/gu) || []);
}

function duplicateItem(left, right) {
  if (!normalizeText(left?.title) || normalizeText(left?.title) !== normalizeText(right?.title)) return false;
  const leftTokens = new Set(evidenceTokens(itemContent(left)));
  const rightTokens = new Set(evidenceTokens(itemContent(right)));
  const smaller = Math.max(1, Math.min(leftTokens.size, rightTokens.size));
  const overlap = [...leftTokens].filter((token) => rightTokens.has(token)).length / smaller;
  const leftNumbers = itemNumbers(left);
  const rightNumbers = itemNumbers(right);
  const sameNumber = [...leftNumbers].some((value) => rightNumbers.has(value));
  return overlap >= 0.8 || (sameNumber && overlap >= 0.5);
}

function dedupeItems(items) {
  const accepted = [];
  return items.map((item) => {
    if (!accepted.some((existing) => duplicateItem(existing, item))) {
      accepted.push(item);
      return item;
    }
    return { ...item, title: "", before: "", after: "", clientAction: "", supportNote: "" };
  });
}

function filterProposalBySources(proposal, files, currentDraft, modelEvidence) {
  const candidates = evidenceCandidates(files, currentDraft);
  const byId = new Map((files || []).map((file) => [String(file.id), file]));
  const trustedEvidencePaths = new Set((modelEvidence || []).filter((item) => {
    const file = byId.get(String(item.sourceId || ""));
    return item?.requiresReview === true || (file?.kind === "image" && file.scanComplete === false);
  }).map((item) => item.path));
  const supported = (value, key, path) => supportedText(value, key, candidates, trustedEvidencePaths.has(path));
  const sourceCorpus = candidates.map((item) => item.normalized).join(" ");
  const channelSupported = (channel) => {
    if (channel === "ios") return /(?:^|\s)(?:ios|iphone|ipad|айос)(?:\s|$)/iu.test(sourceCorpus);
    if (channel === "android") return /(?:^|\s)(?:android|андроид)(?:\s|$)/iu.test(sourceCorpus);
    if (channel === "web") return /(?:^|\s)(?:web|веб|личн\w*\s+кабинет\w*)(?:\s|$)/iu.test(sourceCorpus);
    return false;
  };
  const groups = (Array.isArray(proposal.groups) ? proposal.groups : []).map((group, groupIndex) => {
    const items = (Array.isArray(group.items) ? group.items : []).map((item, itemIndex) => ({
        ...item,
        title: supported(item.title, "title", `proposal.groups[${groupIndex}].items[${itemIndex}].title`),
        before: supported(item.before, "before", `proposal.groups[${groupIndex}].items[${itemIndex}].before`),
        after: supported(item.after, "after", `proposal.groups[${groupIndex}].items[${itemIndex}].after`),
        clientAction: supported(item.clientAction, "clientAction", `proposal.groups[${groupIndex}].items[${itemIndex}].clientAction`),
        supportNote: supported(item.supportNote, "supportNote", `proposal.groups[${groupIndex}].items[${itemIndex}].supportNote`),
      }));
    return {
      ...group,
      title: supported(group.title, "title", `proposal.groups[${groupIndex}].title`),
      channels: (Array.isArray(group.channels) ? group.channels : []).filter((channel) => channelSupported(channel) || trustedEvidencePaths.has(`proposal.groups[${groupIndex}].channels`)),
      location: supported(group.location, "location", `proposal.groups[${groupIndex}].location`),
      availability: supported(group.availability, "availability", `proposal.groups[${groupIndex}].availability`),
      items: dedupeItems(items),
    };
  });
  const support = proposal.support && typeof proposal.support === "object" ? proposal.support : {};
  const faq = (Array.isArray(support.faq) ? support.faq : []).map((item, index) => {
    const answer = supported(item.answer, "answer", `proposal.support.faq[${index}].answer`);
    const question = answer ? supported(item.question, "question", `proposal.support.faq[${index}].question`) : "";
    return { ...item, question, answer };
  }).filter((item) => item.question && item.answer);
  return {
    ...proposal,
    title: supported(proposal.title, "title", "proposal.title"),
    releaseDate: supported(proposal.releaseDate, "releaseDate", "proposal.releaseDate"),
    rolloutMode: supported(proposal.rolloutMode, "rolloutMode", "proposal.rolloutMode"),
    rolloutConditions: supported(proposal.rolloutConditions, "rolloutConditions", "proposal.rolloutConditions"),
    groups,
    support: {
      ...support,
      say: supported(support.say, "say", "proposal.support.say"),
      dontSay: supported(support.dontSay, "dontSay", "proposal.support.dontSay"),
      details: supported(support.details, "details", "proposal.support.details"),
      faq,
    },
  };
}

function validModelEvidence(evidence, files, reviewSourceIds = []) {
  const byId = new Map((files || []).map((file) => [String(file.id), file]));
  const reviewSources = new Set((reviewSourceIds || []).map(String));
  return (Array.isArray(evidence) ? evidence : []).map((item) => {
    if (!item || typeof item !== "object") return null;
    const file = byId.get(String(item.sourceId || ""));
    if (!file) return null;
    if (reviewSources.has(String(item.sourceId || ""))) {
      const rawConfidence = Number(item.confidence);
      return {
        ...item,
        requiresReview: true,
        verification: "manual",
        confidence: Number.isFinite(rawConfidence) ? Math.min(rawConfidence, 0.49) : 0.45,
      };
    }
    if (file.kind === "image" && file.scanComplete === false) return item;
    const snippet = normalizeText(item.snippet);
    return snippet && normalizeText(file.text).includes(snippet) ? item : null;
  }).filter(Boolean);
}

function normalizeWithGrounding(normalized, qualityContext, allowEvidenceInference = false, reviewSourceIds = []) {
  const simplified = simplifyProposalLanguage(normalized.proposal);
  const reviewSources = new Set((reviewSourceIds || []).map(String));
  const evidence = validModelEvidence(normalized.evidence, qualityContext.files, reviewSourceIds);
  const proposal = filterProposalBySources(simplified, qualityContext.files, qualityContext.currentDraft, evidence);
  if (!allowEvidenceInference) return { ...normalized, proposal, evidence };
  const existing = new Set(evidence.map((item) => item.path));
  const candidates = evidenceCandidates(qualityContext.files, qualityContext.currentDraft);
  for (const entry of proposalEntries(proposal)) {
    if (existing.has(entry.path)) continue;
    const match = bestEvidence(entry, candidates);
    if (!match || !match.sourceId) continue;
    evidence.push({
      path: entry.path,
      sourceId: match.sourceId,
      page: null,
      snippet: match.snippet,
      confidence: reviewSources.has(String(match.sourceId)) ? 0.45 : Math.max(0.5, Math.min(0.85, 0.5 + match.score * 0.35)),
      ...(reviewSources.has(String(match.sourceId)) ? { requiresReview: true, verification: "manual" } : {}),
    });
    existing.add(entry.path);
  }
  return { ...normalized, proposal, evidence };
}

function hasProposalContent(normalized) {
  return Boolean(normalized && normalized.proposal && proposalEntries(normalized.proposal).length);
}

function manualReviewFallback(normalized, qualityContext) {
  if (!hasProposalContent(normalized)) return null;
  const files = Array.isArray(qualityContext.files) ? qualityContext.files : [];
  const sourceIds = files.map((file) => String(file?.id || "")).filter(Boolean);
  if (!sourceIds.length) return null;
  const knownSources = new Set(sourceIds);
  const filesById = new Map(files.map((file) => [String(file?.id || ""), file]));
  const defaultSourceId = sourceIds[0];
  const simplifiedProposal = simplifyProposalLanguage(normalized.proposal);
  const evidenceByPath = new Map();
  for (const raw of Array.isArray(normalized.evidence) ? normalized.evidence : []) {
    if (!raw || typeof raw !== "object" || !raw.path) continue;
    const sourceId = knownSources.has(String(raw.sourceId || "")) ? String(raw.sourceId) : defaultSourceId;
    const confidence = Number(raw.confidence);
    const rawSnippet = String(raw.snippet || "").slice(0, 500);
    const sourceText = String(filesById.get(sourceId)?.text || "");
    const snippet = rawSnippet && normalizeText(sourceText).includes(normalizeText(rawSnippet)) ? rawSnippet : "";
    evidenceByPath.set(String(raw.path), {
      ...raw,
      sourceId,
      snippet,
      confidence: Number.isFinite(confidence) ? Math.min(confidence, 0.49) : 0.35,
      requiresReview: true,
      verification: "manual",
    });
  }
  for (const entry of proposalEntries(simplifiedProposal)) {
    if (evidenceByPath.has(entry.path)) continue;
    evidenceByPath.set(entry.path, {
      path: entry.path,
      sourceId: defaultSourceId,
      page: null,
      snippet: "",
      confidence: 0.3,
      requiresReview: true,
      verification: "manual",
    });
  }
  return normalizeWithGrounding({ ...normalized, proposal: simplifiedProposal, evidence: [...evidenceByPath.values()] }, qualityContext, false, sourceIds);
}

function manualReviewResult(normalized, report, qualityContext, processing, repairAttempted) {
  const fallback = manualReviewFallback(normalized, qualityContext);
  if (!fallback) return null;
  const criticalWarnings = report.issues
    .filter((item) => item.severity === "critical")
    .slice(0, 8)
    .map((item) => `Нужно проверить вручную: ${item.message}`);
  return {
    normalized: normalizedWithQualityWarnings(fallback, report, [
      "Автоматическая проверка не смогла подтвердить часть формулировок. Они оставлены в результате, не выбраны и требуют сравнения с исходными материалами.",
      ...criticalWarnings,
    ]),
    quality: {
      checked: true,
      repairAttempted,
      repaired: false,
      degraded: true,
      manualReviewRequired: true,
      ...publicReport(report),
    },
    processing: {
      ...(processing || {}),
      reviewSourceIds: [...new Set([...(processing?.reviewSourceIds || []), ...(qualityContext.files || []).map((file) => String(file?.id || "")).filter(Boolean)])],
    },
  };
}

function repairConfig(config) {
  const requested = Number(config && config.temperature);
  return {
    ...(config || {}),
    temperature: Number.isFinite(requested) ? Math.min(requested, 0.1) : 0.1,
  };
}

function publicReport(report) {
  return {
    passed: !report.hasCritical,
    score: report.score,
    issues: report.issues.slice(0, 20).map(publicIssue),
  };
}

function malformedOutputReport(error) {
  const code = error && RETRYABLE_OUTPUT_CODES.has(error.code) ? error.code : "INVALID_AI_OUTPUT";
  return {
    ok: false,
    needsRepair: true,
    hasCritical: true,
    score: 5,
    issues: [{
      code,
      severity: "critical",
      path: "proposal",
      message: "Первый ответ ИИ был пустым или имел неверный формат. Верните полный JSON Siren v4.",
    }],
    metrics: { fieldsChecked: 0, incompleteExtraction: false },
  };
}

function normalizedWithQualityWarnings(normalized, report, extraWarnings = []) {
  return {
    ...normalized,
    warnings: [
      ...(Array.isArray(normalized.warnings) ? normalized.warnings : []),
      ...qualityWarnings(report),
      ...extraWarnings,
    ],
  };
}

function rejectEmptyRepair(firstReport, repairedReport) {
  if (!firstReport.metrics.fieldsChecked || repairedReport.metrics.fieldsChecked) return repairedReport;
  const emptyIssue = {
    code: "EMPTY_REPAIR",
    severity: "critical",
    path: "proposal",
    message: "Исправленный ответ потерял все содержательные поля. Верните подтверждённые факты в понятной формулировке.",
  };
  return {
    ...repairedReport,
    ok: false,
    needsRepair: true,
    hasCritical: true,
    score: repairedReport.score + 5,
    issues: [...repairedReport.issues, emptyIssue],
  };
}

function remainingTimeout(deadlineAt, perCallTimeoutMs) {
  const remaining = deadlineAt - Date.now();
  if (remaining < MIN_PROVIDER_TIMEOUT_MS) {
    throw new HttpError(504, "ANALYSIS_DEADLINE_EXCEEDED", "Общее время анализа истекло. Повторите попытку.");
  }
  return Math.max(MIN_PROVIDER_TIMEOUT_MS, Math.min(perCallTimeoutMs, remaining));
}

async function callAndNormalize(options, context, config, deadlineAt) {
  const perCallTimeoutMs = Math.max(MIN_PROVIDER_TIMEOUT_MS, Number(options.timeoutMs) || 90000);
  const result = await reliableCall({
    ...options,
    config: config || options.config,
    context,
    deadlineAt,
    timeoutMs: remainingTimeout(deadlineAt, perCallTimeoutMs),
  });
  return normalizeAiOutput(result.text, context.files.map((file) => file.id));
}

async function callProviderWithinDeadline(callOptions) {
  const perCallTimeoutMs = Math.max(MIN_PROVIDER_TIMEOUT_MS, Number(callOptions.timeoutMs) || 90000);
  return reliableCall({
    ...callOptions,
    timeoutMs: remainingTimeout(callOptions.deadlineAt, perCallTimeoutMs),
  });
}

async function runQualityCycle(options, analysisContext, qualityContext, processing, deadlineAt) {
  const reviewSourceIds = Array.isArray(processing?.reviewSourceIds) ? processing.reviewSourceIds : [];
  let firstRaw = null;
  let first = null;
  let firstFailure = null;
  try {
    firstRaw = await callAndNormalize(options, analysisContext, options.config, deadlineAt);
    first = normalizeWithGrounding(firstRaw, qualityContext, analysisContext.sourceLedger === true, reviewSourceIds);
  } catch (error) {
    if (!error || !RETRYABLE_OUTPUT_CODES.has(error.code)) throw error;
    firstFailure = error;
  }
  const firstReport = first
      ? evaluateProposalQuality({
        proposal: first.proposal,
        files: qualityContext.files,
        completenessFiles: analysisContext.sourceLedger === true ? analysisContext.files : qualityContext.files,
        currentDraft: qualityContext.currentDraft,
        evidence: first.evidence,
      })
    : malformedOutputReport(firstFailure);

  if (!firstReport.needsRepair) {
    return {
      normalized: firstReport.issues.length ? normalizedWithQualityWarnings(first, firstReport) : first,
      quality: {
        checked: true,
        repairAttempted: false,
        repaired: false,
        ...publicReport(firstReport),
      },
      processing,
    };
  }

  const repairContext = {
    ...analysisContext,
    qualityRepair: buildQualityRepair(firstReport, first || { proposal: {} }),
  };
  let repairedRaw = null;
  let repaired;
  try {
    repairedRaw = await callAndNormalize(options, repairContext, repairConfig(options.config), deadlineAt);
    repaired = normalizeWithGrounding(repairedRaw, qualityContext, analysisContext.sourceLedger === true, reviewSourceIds);
  } catch (error) {
    if (error && error.code === "ANALYSIS_CANCELLED") throw error;
    if (first && ["PROVIDER_TIMEOUT", "PROVIDER_CONNECTION_LOST", "PROVIDER_SERVER_ERROR", "ANALYSIS_DEADLINE_EXCEEDED"].includes(error?.code)) {
      const kept = manualReviewResult(firstRaw, firstReport, qualityContext, processing, true);
      if (kept) { kept.normalized.warnings.push("Дополнительная проверка не завершилась. Сохранён первый ответ; проверьте его по источникам."); return kept; }
    }
    if (!error || !RETRYABLE_OUTPUT_CODES.has(error.code)) throw error;
    if (firstReport.hasCritical) {
      const degraded = manualReviewResult(firstRaw, firstReport, qualityContext, processing, true);
      if (degraded) return degraded;
      throw new HttpError(
        502,
        "AI_REPAIR_FAILED",
        "ИИ дважды вернул технически непригодный ответ. Повторите анализ или перейдите дальше без изменений.",
        { quality: publicReport(firstReport), canContinueWithoutChanges: true }
      );
    }
    return {
      normalized: normalizedWithQualityWarnings(first, firstReport, ["Автоматическое упрощение текста не завершилось. Проверьте отмеченные формулировки вручную."]),
      quality: {
        checked: true,
        repairAttempted: true,
        repaired: false,
        repairFailed: true,
        ...publicReport(firstReport),
      },
      processing,
    };
  }

  const repairedReport = rejectEmptyRepair(firstReport, evaluateProposalQuality({
    proposal: repaired.proposal,
    files: qualityContext.files,
    completenessFiles: analysisContext.sourceLedger === true ? analysisContext.files : qualityContext.files,
    currentDraft: qualityContext.currentDraft,
    evidence: repaired.evidence,
  }));

  if (firstReport.hasCritical && repairedReport.hasCritical) {
    const degraded = manualReviewResult(hasProposalContent(repairedRaw) ? repairedRaw : firstRaw, repairedReport, qualityContext, processing, true);
    if (degraded) return degraded;
    throw new HttpError(502, "AI_TEXT_QUALITY_FAILED", "ИИ не вернул ни одного пригодного предложения. Повторите анализ или перейдите дальше без изменений.", { quality: publicReport(repairedReport), canContinueWithoutChanges: true });
  }

  let selected = repaired;
  let selectedReport = repairedReport;
  let selectedRepaired = true;
  if (!firstReport.hasCritical && (repairedReport.hasCritical || repairedReport.score >= firstReport.score)) {
    selected = first;
    selectedReport = firstReport;
    selectedRepaired = false;
  }

  if (selectedReport.hasCritical) {
    const selectedRaw = selected === repaired ? repairedRaw : firstRaw;
    const degraded = manualReviewResult(selectedRaw, selectedReport, qualityContext, processing, true);
    if (degraded) return degraded;
    throw new HttpError(502, "AI_TEXT_QUALITY_FAILED", "ИИ не вернул ни одного пригодного предложения. Повторите анализ или перейдите дальше без изменений.", { quality: publicReport(selectedReport), canContinueWithoutChanges: true });
  }

  return {
    normalized: normalizedWithQualityWarnings(selected, selectedReport),
    quality: {
      checked: true,
      repairAttempted: true,
      repaired: selectedRepaired,
      ...publicReport(selectedReport),
    },
    processing,
  };
}

async function analyzeWithQuality(options) {
  const context = options.context;
  const perCallTimeoutMs = Math.max(MIN_PROVIDER_TIMEOUT_MS, Number(options.timeoutMs) || 90000);
  const defaultTotal = Math.min(30 * 60 * 1000, Math.max(180000, Math.ceil(perCallTimeoutMs * 12)));
  const totalTimeoutMs = Math.max(MIN_PROVIDER_TIMEOUT_MS, Number(options.totalTimeoutMs) || defaultTotal);
  const deadlineAt = Date.now() + totalTimeoutMs;
  let prepared = {
    context,
    processing: { mode: "direct", chunks: 1, contextRetries: 0, reductionRounds: 0, warnings: [] },
  };

  if (shouldChunkContext(options.provider, context, options.config)) {
    prepared = await prepareChunkedContext(options, callProviderWithinDeadline, deadlineAt);
  }

  const runChunkedCycle = async (initial) => {
    let current = initial;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await runQualityCycle(options, current.context, context, current.processing, deadlineAt);
      } catch (error) {
        if (!isContextError(error)) throw error;
        const previousTarget = Number(current.processing.targetChars) || 1400;
        const tighterTarget = Math.max(700, Math.floor(previousTarget * 0.55));
        if (attempt > 0 || tighterTarget >= previousTarget) {
          throw new HttpError(422, "MODEL_CONTEXT_TOO_SMALL", "Контекст выбранной модели слишком мал для итоговой инструкции даже после разделения материалов. Увеличьте контекст модели или выберите другую модель.");
        }
        current = await prepareChunkedContext({ ...options, chunkTargetChars: tighterTarget }, callProviderWithinDeadline, deadlineAt);
        current.processing.contextRetries += 1;
      }
    }
    throw new HttpError(422, "MODEL_CONTEXT_TOO_SMALL", "Контекст выбранной модели слишком мал. Увеличьте контекст модели или выберите другую модель.");
  };

  if (prepared.processing.mode === "chunked") return runChunkedCycle(prepared);

  try {
    return await runQualityCycle(options, prepared.context, context, prepared.processing, deadlineAt);
  } catch (error) {
    if (!isContextError(error) && error?.code !== "PROVIDER_TIMEOUT") throw error;
    const chunked = await prepareChunkedContext(options, callProviderWithinDeadline, deadlineAt);
    chunked.processing.contextRetries += 1;
    return runChunkedCycle(chunked);
  }
}

module.exports = { analyzeWithQuality, callProviderWithinDeadline, normalizeWithGrounding, plainLanguage, repairConfig, remainingTimeout };
