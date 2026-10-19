"use strict";

// Durable topic workflow. Extraction checkpoints and the final draft are separate:
// a successful source is never presented as a finished instruction on its own.
const fs = require("node:fs/promises");
const path = require("node:path");
const { fingerprint } = require("./reliable-call");
const { extractTopicFacts, composeTopicInstruction } = require("./topic");
const { HttpError } = require("./util");

async function read(filename) {
  try { return JSON.parse(await fs.readFile(filename, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
async function write(filename, value) {
  return require("./atomic-json").atomicJson(filename, value);
}
async function checkpoint(directory) {
  await fs.mkdir(directory, { recursive: true });
  return { get: (key) => read(path.join(directory, `${key}.json`)), set: (key, value) => write(path.join(directory, `${key}.json`), value), delete: (key) => fs.rm(path.join(directory, `${key}.json`), { force: true }) };
}
function modelConfig(config) {
  const value = { ...config };
  for (const name of ["requestTimeoutMinutes", "totalTimeoutMinutes", "retryCount"]) delete value[name];
  return value;
}

async function runTopicJob(manager, job, signal, provider, credential, safeError) {
  const directory = manager.directory(job.id);
  const packets = [], originals = [];
  let preloaded = false;
  const timeoutMs = Number(manager.options.analyzeTimeoutMs) || Number(job.config.requestTimeoutMinutes || 10) * 60000;
  const base = {
    provider, config: job.config, credential, signal, fetchImpl: manager.options.fetchImpl, timeoutMs,
    deadlineAt: job.deadlineAt,
    onProgress: (value) => manager.progress(job, value),
  };
  job.status = "running";
  // Keep a usable earlier draft during retries, with an explicit stale-result
  // warning until synthesis of the current source set has actually finished.
  job.resultPending = Boolean(job.hasResult);
  await manager.save(job);
  for (const [index, file] of job.files.entries()) {
    manager.check(signal, job);
    await manager.progress(job, { phase: "topic-extraction", sourceId: file.id, sourceName: file.name, fileIndex: index + 1, fileTotal: job.files.length, message: `Отбираем факты по теме: ${file.name}` });
    try {
      let extracted = await manager.extracted(job, file);
      if (file.clientId === "manual-text") extracted = { ...extracted, requiresReview: true };
      const original = { ...extracted, buffer: Buffer.alloc(0) };
      const signature = fingerprint({ version: 3, brief: job.brief, config: modelConfig(job.config), text: extracted.text, complete: extracted.scanComplete, sourceId: file.id, purpose: file.purpose, size: file.size, requiresReview: extracted.requiresReview || false });
      const packetPath = path.join(directory, `${file.id}.topic.json`);
      let cached = await read(packetPath);
      // Sources and the brief are immutable after a job starts. A model change
      // for recovery must not reprocess a source that already completed.
      const keepCompleted = file.status === "complete" && cached?.complete && Array.isArray(cached?.packet?.facts);
      if (!cached || (!keepCompleted && cached.signature !== signature)) {
        file.status = "running"; delete file.error;
        await manager.save(job);
        const mode = job.config.imageMode || "auto";
        if (extracted.kind === "image") {
          extracted = { ...extracted, buffer: await fs.readFile(path.join(directory, `${file.id}.bin`)) };
          if (mode === "ocr" || !provider.supportsVision) {
            if (!extracted.text.trim()) throw new HttpError(422, "IMAGE_TEXT_MISSING", "На изображении не удалось распознать текст. Добавьте его описание или выберите модель с поддержкой изображений.");
            extracted = { ...extracted, kind: "text", visualSource: true, buffer: Buffer.alloc(0) };
          }
        } else if (!extracted.text.trim()) {
          throw new HttpError(422, "MATERIAL_TEXT_MISSING", `В материале «${file.name}» не удалось прочитать текст. Добавьте читаемый файл и начните новую обработку.`);
        }
        if (provider.family === "ollama" && !preloaded && manager.options.preload !== false) {
          preloaded = true;
          await manager.progress(job, { phase: "loading", message: "Загружаем локальную модель в память", requestStartedAt: Date.now(), timeoutMs });
          await require("./providers").preloadModel(base);
        }
        const options = { ...base, checkpoint: await checkpoint(path.join(directory, `topic-cache-${file.id}`)), context: { files: [extracted], brief: job.brief, currentDraft: {}, mergeMode: job.mergeMode } };
        let packet;
        try { packet = await extractTopicFacts(options); }
        catch (error) {
          if (extracted.kind !== "image" || mode !== "auto" || !extracted.text.trim() || !["PROVIDER_TIMEOUT", "PROVIDER_OUT_OF_MEMORY", "PROVIDER_UNSUPPORTED_REQUEST", "MODEL_CONTEXT_TOO_SMALL_FOR_IMAGE"].includes(error.code)) throw error;
          file.warnings = [...(file.warnings || []), "Изображение обработано по распознанному тексту. Расположение элементов и визуальные изменения проверьте по оригиналу."];
          extracted = { ...extracted, kind: "text", visualSource: true, buffer: Buffer.alloc(0) };
          packet = await extractTopicFacts({ ...options, context: { ...options.context, files: [extracted] } });
        }
        cached = { signature, packet, model: job.config.model, complete: Boolean(extracted.scanComplete || extracted.kind === "image"), warnings: file.warnings || [] };
        await write(packetPath, cached);
      }
      packets.push(cached.packet); originals.push(original);
      file.status = cached.complete ? "complete" : "partial";
      file.factCount = cached.packet.facts.length;
      file.model = cached.model || file.model || job.config.model;
      file.warnings = [...new Set([...(file.warnings || []), ...(cached.warnings || []), ...(cached.packet.warnings || [])])];
      delete file.error;
      if (file.status === "partial") file.error = { code: "EXTRACTION_INCOMPLETE", message: "Материал прочитан не полностью. Сохранённые факты использованы, пропуски требуют проверки." };
      job.factsCount = packets.reduce((n, packet) => n + packet.facts.length, 0);
      await manager.save(job);
    } catch (error) {
      if (signal.aborted || ["ANALYSIS_DEADLINE_EXCEEDED", "ENOSPC", "EACCES", "EPERM"].includes(error.code)) { file.status = "ready"; throw error; }
      file.status = "failed";
      file.error = safeError(error, [credential, ...manager.options.credentials.secretValues()]);
      await manager.save(job);
      if (["PROVIDER_AUTH_FAILED", "PROVIDER_ACCESS_DENIED", "PROVIDER_QUOTA_EXHAUSTED", "PROVIDER_PAYMENT_REQUIRED", "PROVIDER_MODEL_NOT_FOUND"].includes(error.code)) throw error;
    }
  }
  manager.check(signal, job);
  if (!packets.length) throw new HttpError(422, "NO_READABLE_MATERIALS", "Не удалось подготовить факты ни из одного материала. Исправьте указанные ошибки и продолжите обработку.");
  await manager.progress(job, { phase: "topic-compose", sourceName: "", sourceId: "", message: "Сопоставляем факты и готовим единую инструкцию" });
  const result = await composeTopicInstruction({
    ...base, checkpoint: await checkpoint(path.join(directory, "topic-final-cache")),
    context: { files: originals, packets, brief: job.brief, clarificationAnswers: job.clarificationAnswers || [], unansweredClarifications: job.unansweredClarifications || [], clarificationResolved: Boolean(job.clarificationResolved), currentDraft: {}, mergeMode: job.mergeMode },
  });
  manager.check(signal, job);
  if (result.clarifications?.length) {
    job.clarifications = result.clarifications.slice(0, 3);
    job.status = "clarification";
    job.progress = { phase: "clarification", message: "Нужно короткое уточнение перед подготовкой инструкции. Отобранные факты сохранены." };
    await manager.save(job); return;
  }
  const failed = job.files.filter((f) => f.status !== "complete");
  const extraSources = result.processing?.extraSources || [];
  const warnings = [...(result.normalized.warnings || []), ...job.files.flatMap((f) => f.warnings || [])];
  const partial = failed.length > 0 || result.quality?.degraded === true;
  if (failed.length) warnings.unshift(`Результат неполный: ${failed.length} из ${job.files.length} материалов требуют проверки или повторной обработки.`);
  const final = {
    ok: true, providerId: job.providerId, mergeMode: job.mergeMode, brief: job.brief,
    ...result.normalized, warnings: [...new Set(warnings)], quality: result.quality,
    processing: { ...result.processing, mode: "topic", partial, completed: job.files.length - failed.length, total: job.files.length, factsCount: result.processing?.factsCount ?? job.factsCount, failed: failed.map(({ id, name, error }) => ({ id, name, error })) },
    sources: [...job.files.map(({ id, name, size, mime, purpose }) => ({ id, name, size, type: mime, purpose })), ...extraSources.map(({ id, name, purpose }) => ({ id, name, purpose, type: "text/plain" }))],
  };
  if (partial) final.evidence = final.evidence.map((e) => ({ ...e, requiresReview: true, verification: "manual" }));
  await write(path.join(directory, "topic-result.json"), final);
  job.clarifications = [];
  job.hasResult = true;
  job.resultPending = false;
  job.status = partial ? "partial" : "complete";
  job.progress = { phase: job.status, message: result.processing?.validationFailed ? "Факты найдены, но модель не подготовила текст, прошедший проверки. Попробуйте другую модель или подготовьте инструкцию по источникам." : result.quality?.empty ? "По выбранной теме нет подтверждённых фактов. Уточните тему или добавьте материалы." : job.status === "complete" ? "Инструкция по выбранной теме готова. Проверьте текст и источники." : "Инструкция подготовлена по доступным фактам. Есть пропуски, требующие проверки." };
  await manager.save(job);
}

async function topicResult(manager, job) {
  const result = job.hasResult && await read(path.join(manager.directory(job.id), "topic-result.json"));
  if (!result) throw new HttpError(409, "RESULT_NOT_READY", "Факты сохраняются по мере обработки. Единая инструкция будет доступна после сопоставления материалов и уточнений.");
  if (!job.resultPending) return result;
  return { ...result, warnings: ["Это сохранённый результат предыдущей попытки. Новая обработка ещё не завершена; обновлённые материалы пока не учтены.", ...result.warnings], processing: { ...result.processing, partial: true, previousAttempt: true }, evidence: result.evidence.map((e) => ({ ...e, requiresReview: true, verification: "manual" })) };
}

module.exports = { runTopicJob, topicResult };
