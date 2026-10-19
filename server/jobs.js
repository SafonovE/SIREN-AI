"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { prepareFiles, extractFiles, TYPES } = require("./files");
const { analyzeWithQuality } = require("./analysis");
const { scanFiles, scanTextResult } = require("./privacy");
const { dataBoundaryFor, getProvider, effectiveConfig } = require("./providers");
const { fingerprint } = require("./reliable-call");
const { splitTextPreserving } = require("./chunking");
const { normalizeBrief } = require("./topic");
const { runTopicJob, topicResult } = require("./topic-jobs");
const { HttpError, asPlainText, readJson, json, redactSecrets } = require("./util");

const MAX_JOB_FILES = 2000;
const MAX_JOB_BYTES = 10 * 1024 ** 3;
const MAX_FILE_BYTES = 100 * 1024 ** 2;
const MAX_UPLOAD_CHUNK = 2 * 1024 ** 2;
const ACTIVE = new Set(["queued", "preparing", "running"]);
const TERMINAL = new Set(["complete", "partial", "failed", "paused", "confirmation", "clarification"]);
async function atomicJson(filename, value) {
  return require("./atomic-json").atomicJson(filename, value);
}
async function readStored(filename) {
  try { return JSON.parse(await fs.readFile(filename, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
function safeError(error, secrets = []) {
  if (error?.code === "ENOSPC") return { code: "DISK_FULL", message: "На диске закончилось место для сохранения этапа. Освободите место и нажмите «Продолжить». Уже записанные результаты остаются доступны." };
  if (error?.code === "EACCES" || error?.code === "EPERM") return { code: "STORAGE_DENIED", message: "Windows не разрешила сохранить этап. Проверьте доступ к папке данных SIREN AI и защиту от записи, затем продолжите обработку." };
  if (["TOPIC_SOURCE_RANGE_INVALID", "TOPIC_INVALID_OUTPUT", "TOPIC_QUOTE_INVALID", "TOPIC_INVALID_TEXT", "TOPIC_TEXT_TOO_LONG", "INVALID_AI_JSON", "EMPTY_PROVIDER_RESPONSE"].includes(error?.code)) {
    return { code: error.code, title: "Нужно повторить обработку", recovery: "retry-unfinished",
      message: "Не удалось подтвердить часть ответа ИИ по тексту документа. Исходный файл менять не нужно.",
      technicalDetails: redactSecrets(asPlainText(error.technicalDetails || error.message || "Ответ ИИ не прошёл проверку.", 1800), secrets) };
  }
  return { code: String(error?.code || "ANALYSIS_FAILED"), message: redactSecrets(asPlainText(error?.message || "Этап не завершён. Проверьте настройки модели и продолжите обработку.", 1800), secrets) };
}
function combinedResult(results, job) {
  const proposal = { schemaVersion: 4, title: "", releaseDate: "", rolloutMode: "", rolloutConditions: "", groups: [], support: { say: "", dontSay: "", details: "", faq: [] } };
  const evidence = [], warnings = [], unknowns = [];
  const rootFields = ["title", "releaseDate", "rolloutMode", "rolloutConditions"];
  for (const [index, result] of results.entries()) {
    const item = result.normalized; if (!item?.proposal) continue;
    const draft = item.proposal;
    const offset = proposal.groups.length;
    for (const field of rootFields) {
      if (!proposal[field]) proposal[field] = draft[field] || "";
      else if (draft[field] && proposal[field] !== draft[field]) warnings.push(`Материал/раздел ${index + 1}: другой вариант поля «${({ title: "Название", releaseDate: "Дата", rolloutMode: "Порядок запуска", rolloutConditions: "Условия запуска" })[field]}»: «${draft[field]}». В общем предложении оставлено «${proposal[field]}». Сверьте оба варианта с источниками.`);
    }
    for (const group of draft.groups || []) proposal.groups.push({ ...group, id: `j${index}-${group.id || crypto.randomUUID()}`, items: (group.items || []).map((i, n) => ({ ...i, id: `j${index}-i${n}-${i.id || "item"}` })) });
    for (const field of ["say", "dontSay", "details"]) if (draft.support?.[field]) proposal.support[field] = [...new Set([proposal.support[field], draft.support[field]].filter(Boolean))].join("\n\n");
    const faqOffset = proposal.support.faq.length;
    proposal.support.faq.push(...(draft.support?.faq || []));
    for (const itemEvidence of item.evidence || []) {
      let field = itemEvidence.path || itemEvidence.field || "";
      if (rootFields.includes(field) && draft[field] !== proposal[field]) continue;
      field = field.replace(/^groups\[(\d+)\]/, (_, n) => `groups[${Number(n) + offset}]`).replace(/^support\.faq\[(\d+)\]/, (_, n) => `support.faq[${Number(n) + faqOffset}]`);
      // Independently composed materials need a human check for cross-source conflicts.
      evidence.push({ ...itemEvidence, path: field, ...(itemEvidence.field ? { field } : {}), requiresReview: true, verification: "manual" });
    }
    warnings.push(...(item.warnings || []), ...(result.processing?.warnings || []));
    unknowns.push(...(item.unknowns || []));
  }
  const failed = job.files.filter((f) => f.status !== "complete");
  if (failed.length) warnings.unshift(`Неполный результат: готово ${job.files.length - failed.length} из ${job.files.length} материалов. Не завершены: ${failed.map((f) => f.name).join(", ")}.`);
  warnings.unshift("Предложения собраны по материалам отдельно. Сопоставьте связанные описания «Было» и «Стало»; проверьте общие условия и повторы перед применением.");
  return { ok: true, providerId: job.providerId, mergeMode: job.mergeMode, proposal, evidence, warnings: [...new Set(warnings)], unknowns: [...new Set(unknowns)], processing: { mode: "durable", partial: failed.length > 0, completed: job.files.length - failed.length, total: job.files.length, failed: failed.map((f) => ({ id: f.id, name: f.name, error: f.error })), manualReview: true }, sources: job.files.map(({ id, name, size, mime }) => ({ id, name, size, type: mime })) };
}

class JobManager {
  constructor(options) {
    this.options = options; this.root = path.join(options.dataDir, "jobs-v2");
    this.jobs = new Map(); this.controllers = new Map(); this.writes = new Map(); this.locks = new Map();
    this.pumping = false; this.closed = false; this.ready = this.load();
  }
  directory(id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new HttpError(404, "JOB_NOT_FOUND", "Эта обработка не найдена. Откройте список сохранённых обработок.");
    return path.join(this.root, id);
  }
  async load() {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    for (const id of await fs.readdir(this.root)) {
      if (!/^[a-f0-9-]{36}$/.test(id)) continue;
      try {
        const job = await readStored(path.join(this.directory(id), "job.json"));
        if (!job || job.id !== id || !Array.isArray(job.files)) continue;
        if (ACTIVE.has(job.status)) { job.status = "paused"; job.error = { code: "SERVER_RESTARTED", message: "Программа была закрыта. Сохранённые этапы восстановлены. Нажмите «Продолжить»." }; }
        for (const file of job.files) if (file.status === "running") file.status = "ready";
        this.jobs.set(id, job);
      } catch { /* A damaged job must not prevent other jobs or the application starting. */ }
    }
  }
  async save(job) {
    job.updatedAt = Date.now();
    const filename = path.join(this.directory(job.id), "job.json");
    const value = JSON.parse(JSON.stringify(job));
    const promise = (this.writes.get(job.id) || Promise.resolve()).catch(() => {}).then(() => atomicJson(filename, value));
    this.writes.set(job.id, promise); await promise;
  }
  async locked(id, callback) {
    const previous = this.locks.get(id) || Promise.resolve();
    const next = previous.catch(() => {}).then(callback); this.locks.set(id, next);
    try { return await next; } finally { if (this.locks.get(id) === next) this.locks.delete(id); }
  }
  async get(id) { await this.ready; this.directory(id); const job = this.jobs.get(id); if (!job) throw new HttpError(404, "JOB_NOT_FOUND", "Обработка не найдена. Обновите список сохранённых обработок."); return job; }
  public(job) {
    // Normalize older saved errors without discarding their checkpoints.
    const friendly = (error) => error ? safeError(error, this.options.credentials.secretValues()) : error;
    return { id: job.id, providerId: job.providerId, model: job.config.model, status: job.status, brief: job.brief, clarifications: job.clarifications || [], clarificationAnswers: job.clarificationAnswers || [], factsCount: job.factsCount || 0, createdAt: job.createdAt, updatedAt: job.updatedAt, startedAt: job.startedAt, progress: job.progress, error: friendly(job.error), privacy: job.privacy, hasResult: Boolean(job.hasResult), completed: job.files.filter((f) => f.status === "complete").length, total: job.files.length, files: job.files.map(({ id, name, size, uploaded, status, error, warnings, textChars, sectionsDone, sectionsTotal, model, factCount }) => ({ id, name, size, uploaded, status, error: friendly(error), warnings, textChars, sectionsDone, sectionsTotal, model, factCount })), limits: { maxFiles: MAX_JOB_FILES, maxFileBytes: MAX_FILE_BYTES, maxJobBytes: MAX_JOB_BYTES, uploadChunkBytes: MAX_UPLOAD_CHUNK } };
  }
  async create(body) {
    await this.ready;
    const brief = normalizeBrief(body.brief);
    if (body.clientRequestId) {
      const existing = [...this.jobs.values()].find((j) => j.clientRequestId === body.clientRequestId);
      if (existing) {
        if (fingerprint(existing.brief || normalizeBrief()) !== fingerprint(brief) || existing.providerId !== body.providerId) throw new HttpError(409, "JOB_REQUEST_CHANGED", "Задание изменилось. Начните новую обработку, чтобы не использовать прежний результат.");
        return existing;
      }
    }
    const provider = getProvider(body.providerId);
    const config = effectiveConfig(provider, await this.options.settings.get(provider.id));
    const id = crypto.randomUUID(); const now = Date.now();
    const job = { version: 2, id, clientRequestId: asPlainText(body.clientRequestId, 100), providerId: provider.id, config, mergeMode: body.mergeMode === "replace-selected" ? "replace-selected" : "fill-empty", currentDraft: this.options.sanitizeDraft(body.currentDraft), status: "uploading", createdAt: now, updatedAt: now, files: [], progress: { phase: "upload", message: "Добавьте материалы" }, confirmed: false };
    job.brief = brief;
    await fs.mkdir(this.directory(id), { recursive: true, mode: 0o700 });
    this.jobs.set(id, job); await this.save(job); return job;
  }
  async addFile(job, body) {
    if (job.status !== "uploading") throw new HttpError(409, "JOB_ALREADY_STARTED", "Материалы этой обработки уже зафиксированы. Для других файлов начните новую обработку.");
    const name = asPlainText(body.name, 240).replace(/[\\/]/g, "_");
    const size = Number(body.size); const info = TYPES[path.extname(name).toLowerCase()];
    if (!info) throw new HttpError(415, "UNSUPPORTED_FILE_TYPE", "Этот формат не поддерживается. Используйте DOCX, PPTX, XLSX, PDF, TXT, CSV, Markdown, PNG, JPEG или WebP.");
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_FILE_BYTES) throw new HttpError(413, "FILE_TOO_LARGE", "Один файл должен занимать от 1 байта до 100 МБ. Разделите крупный документ на части; их можно добавить в одну обработку.");
    const previous = job.files.find((f) => f.clientId && f.clientId === body.clientId);
    if (previous) return previous;
    if (job.files.length >= MAX_JOB_FILES || job.files.reduce((n, f) => n + f.size, size) > MAX_JOB_BYTES) throw new HttpError(413, "JOB_TOO_LARGE", "Лимит одной обработки — 2000 материалов и 10 ГБ на диске. Создайте следующую обработку для оставшихся файлов; готовые результаты сохранятся отдельно.");
    const id = crypto.randomUUID();
    const file = { id, clientId: asPlainText(body.clientId, 100), name, size, uploaded: 0, status: "uploading", extension: path.extname(name).toLowerCase(), ...info, purpose: ["documentation", "screen", "before", "after", "scheme", "context"].includes(body.purpose) ? body.purpose : "context" };
    await fs.writeFile(path.join(this.directory(job.id), `${id}.bin`), Buffer.alloc(0), { mode: 0o600 });
    job.files.push(file); await this.save(job); return file;
  }
  async upload(job, fileId, request, offset) {
    const file = job.files.find((f) => f.id === fileId);
    if (!file || job.status !== "uploading") throw new HttpError(409, "UPLOAD_NOT_ALLOWED", "Файл не найден или обработка уже запущена. Обновите список обработок.");
    const filename = path.join(this.directory(job.id), `${file.id}.bin`);
    const actual = (await fs.stat(filename)).size;
    if (actual > file.size) throw new HttpError(409, "UPLOAD_DAMAGED", "Сохранённый файл больше ожидаемого размера. Создайте новую обработку и выберите исходный файл заново.");
    if (file.uploaded !== actual) {
      // A process may stop between appending bytes and persisting job.json.
      file.uploaded = actual; file.status = actual === file.size ? "ready" : "uploading";
      await this.save(job);
    }
    if (!Number.isSafeInteger(offset) || offset !== actual) throw new HttpError(409, "UPLOAD_OFFSET", "Передача прервалась. Продолжите загрузку с сохранённой позиции.", { uploaded: actual });
    let bytes = 0; const chunks = [];
    for await (const chunk of request) { bytes += chunk.length; if (bytes > MAX_UPLOAD_CHUNK || actual + bytes > file.size) throw new HttpError(413, "UPLOAD_CHUNK_TOO_LARGE", "Часть загрузки слишком большая. Повторите загрузку через интерфейс SIREN."); chunks.push(chunk); }
    if (!bytes) throw new HttpError(400, "UPLOAD_EMPTY", "Получена пустая часть файла. Повторите загрузку.");
    await fs.appendFile(filename, Buffer.concat(chunks));
    file.uploaded = actual + bytes; file.status = file.uploaded === file.size ? "ready" : "uploading";
    await this.save(job); return file;
  }
  async start(job, body = {}) {
    if (this.controllers.has(job.id) && !ACTIVE.has(job.status)) throw new HttpError(409, "JOB_PAUSING", "Текущий запрос ещё останавливается. Подождите несколько секунд, обновите статус и продолжите.");
    if (ACTIVE.has(job.status)) return;
    if (job.status === "complete") return;
    if (job.status === "clarification") throw new HttpError(409, "CLARIFICATION_REQUIRED", "Ответьте на уточнения или выберите продолжение с неизвестными данными.");
    if (!job.files.length || job.files.some((f) => f.uploaded !== f.size)) throw new HttpError(409, "UPLOAD_INCOMPLETE", "Загрузка материалов ещё не завершена. Вернитесь к материалам и закончите загрузку перед запуском.");
    if (body.confirmedNoPersonalData === true || body.privacyOverrideConfirmed === true) {
      if (job.status !== "confirmation") throw new HttpError(409, "PRIVACY_REVIEW_REQUIRED", "Сначала дождитесь локальной проверки материалов и просмотрите её результаты.");
      job.confirmed = true;
    }
    for (const f of job.files) if (f.status === "failed") { f.status = "ready"; delete f.error; }
    job.error = null; job.status = "queued"; job.startedAt = Date.now();
    job.deadlineAt = Number(job.config.totalTimeoutMinutes) > 0 ? Date.now() + Number(job.config.totalTimeoutMinutes) * 60000 : null;
    await this.save(job); this.pump();
  }
  async pause(job) {
    this.controllers.get(job.id)?.abort();
    if (ACTIVE.has(job.status)) { job.status = "paused"; job.progress = { phase: "paused", message: "Приостановлено. Готовые этапы сохранены." }; await this.save(job); }
  }
  async answerClarifications(job, body) {
    if (job.status !== "clarification" || this.controllers.has(job.id)) throw new HttpError(409, "CLARIFICATION_UNAVAILABLE", "Уточнения сейчас недоступны. Обновите состояние обработки.");
    if (!Array.isArray(body.answers) || body.answers.length > 3) throw new HttpError(400, "INVALID_CLARIFICATION_ANSWERS", "Передайте ответы на показанные вопросы.");
    const byId = new Map((job.clarifications || []).map((q) => [q.id, q]));
    const seen = new Set(), answers = [];
    for (const value of body.answers) {
      if (!value || !byId.has(value.id) || seen.has(value.id) || typeof value.answer !== "string" || value.answer.length > 1500) throw new HttpError(400, "INVALID_CLARIFICATION_ANSWERS", "Проверьте ответы: каждый вопрос можно заполнить один раз, до 1500 символов.");
      seen.add(value.id);
      const answer = value.answer.trim();
      if (answer) answers.push({ id: value.id, question: byId.get(value.id).question, factIds: byId.get(value.id).factIds || [], answer });
    }
    if (answers.length < byId.size && body.proceedWithUnknowns !== true) throw new HttpError(400, "CLARIFICATION_INCOMPLETE", "Ответьте на вопросы или явно продолжите, оставив неизвестное на проверку.");
    job.clarificationAnswers = answers;
    job.clarificationResolved = true;
    job.unansweredClarifications = (job.clarifications || []).filter((q) => !answers.some((a) => a.id === q.id));
    // New free text requires another local privacy scan before any cloud request.
    if (answers.length) job.confirmed = false;
    job.status = "paused";
    await this.save(job);
    await this.start(job);
  }
  async pump() {
    if (this.pumping || this.closed) return; this.pumping = true;
    try {
      while (!this.closed) {
        const job = [...this.jobs.values()].find((j) => j.status === "queued"); if (!job) break;
        const controller = new AbortController(); this.controllers.set(job.id, controller);
        try { await this.run(job, controller.signal); }
        catch (error) {
          job.status = controller.signal.aborted ? "paused" : "failed";
          job.error = safeError(error, this.options.credentials.secretValues());
          await this.save(job).catch(() => {});
        } finally { this.controllers.delete(job.id); }
      }
    } finally { this.pumping = false; }
  }
  async progress(job, value) { job.progress = { ...job.progress, ...value }; await this.save(job); }
  check(signal, job) {
    if (signal.aborted) throw new HttpError(499, "ANALYSIS_CANCELLED", "Обработка приостановлена. Готовые этапы сохранены.");
    if (job.deadlineAt && Date.now() >= job.deadlineAt) throw new HttpError(504, "ANALYSIS_DEADLINE_EXCEEDED", "Общее время обработки истекло. Увеличьте общий лимит в настройках или выберите «Без общего лимита», затем продолжите обработку.");
  }
  async extracted(job, file) {
    const filename = path.join(this.directory(job.id), `${file.id}.text.json`);
    let extracted = await readStored(filename);
    if (!extracted) {
      const buffer = await fs.readFile(path.join(this.directory(job.id), `${file.id}.bin`));
      const prepared = prepareFiles([{ id: file.id, name: file.name, purpose: file.purpose, buffer }]);
      prepared[0].signal = this.controllers.get(job.id)?.signal;
      prepared[0].extractionCacheDir = path.join(this.directory(job.id), `${file.id}.pages`);
      prepared[0].onExtractionProgress = (value) => this.progress(job, value);
      [extracted] = await extractFiles(prepared, this.options.extractors);
      const { buffer: ignored, ...stored } = extracted;
      if (stored.scanComplete) await atomicJson(filename, stored);
      extracted = stored;
    }
    return extracted;
  }
  async run(job, signal) {
    const provider = getProvider(job.providerId); const directory = this.directory(job.id);
    job.status = "preparing"; await this.save(job);
    const privacy = { detected: 0, resolved: 0, findings: [], incomplete: [] };
    for (const [index, file] of job.files.entries()) {
      this.check(signal, job);
      await this.progress(job, { phase: "extract", sourceName: file.name, sourceId: file.id, fileIndex: index + 1, fileTotal: job.files.length, message: "Извлекаем текст и проверяем материал локально" });
      try {
        const extracted = await this.extracted(job, file);
        file.textChars = extracted.text.length; file.warnings = extracted.warnings;
        const scan = scanFiles([extracted], []);
        privacy.detected += scan.detected;
        privacy.findings.push(...scan.findings); privacy.incomplete.push(...scan.incomplete);
      } catch (error) {
        if (signal.aborted || ["ENOSPC", "EACCES", "EPERM"].includes(error.code)) throw error;
        file.error = safeError(error, this.options.credentials.secretValues());
        file.status = "failed";
        privacy.incomplete.push({ id: `${file.id}-extraction`, sourceId: file.id, name: file.name, reason: file.error.message, blocking: true });
      }
    }
    const draftScan = scanTextResult("current-draft", "content", JSON.stringify(job.currentDraft));
    privacy.findings.push(...draftScan.findings); privacy.detected += draftScan.findings.length;
    if (draftScan.truncated) privacy.incomplete.push({ id: "current-draft-scan-limit", sourceId: "current-draft", name: "Текущий черновик", reason: "Проверка черновика выполнена не полностью", blocking: true });
    if (job.brief?.topic) {
      const briefScan = scanTextResult("instruction-task", "content", JSON.stringify({ brief: job.brief, answers: job.clarificationAnswers || [] }));
      privacy.findings.push(...briefScan.findings); privacy.detected += briefScan.findings.length;
      if (briefScan.truncated) privacy.incomplete.push({ id: "task-scan-limit", sourceId: "instruction-task", name: "Задание и уточнения", reason: "Проверка задания выполнена не полностью", blocking: true });
    }
    job.privacy = privacy;
    if (dataBoundaryFor(provider, job.config) === "public" && !job.confirmed) {
      job.status = "confirmation"; job.progress = { phase: "confirmation", message: "Просмотрите результаты локальной проверки и подтвердите отправку в публичный ИИ." }; await this.save(job); return;
    }
    const credential = await this.options.credentials.get(job.providerId);
    if (job.brief?.topic) return runTopicJob(this, job, signal, provider, credential, safeError);
    // One worker performs one provider request at a time, including across jobs.
    job.status = "running"; await this.save(job);
    let preloaded = false;
    for (const [index, file] of job.files.entries()) {
      this.check(signal, job);
      if (file.status === "complete") continue;
      file.status = "running"; delete file.error;
      await this.progress(job, { phase: "material", sourceName: file.name, sourceId: file.id, fileIndex: index + 1, fileTotal: job.files.length, part: null, parts: null, message: "Обрабатываем материал" });
      try {
        let extracted = await this.extracted(job, file);
        if (extracted.kind !== "image" && !extracted.text.trim()) throw new HttpError(422, "MATERIAL_TEXT_MISSING", `В материале «${file.name}» не удалось прочитать текст. Проверьте сообщения извлечения, снимите пароль или экспортируйте документ в TXT/PDF. Другие материалы продолжат обрабатываться.`);
        extracted = { ...extracted, buffer: extracted.kind === "image" ? await fs.readFile(path.join(directory, `${file.id}.bin`)) : Buffer.alloc(0) };
        const mode = job.config.imageMode || "auto";
        if (extracted.kind === "image" && (mode === "ocr" || !provider.supportsVision)) {
          if (!extracted.text.trim()) throw new HttpError(422, "IMAGE_TEXT_MISSING", "На изображении не удалось распознать текст. Выберите режим «Изображение целиком» и модель с поддержкой изображений либо добавьте описание текстом.");
          extracted = { ...extracted, kind: "text", buffer: Buffer.alloc(0) };
          file.warnings = [...(file.warnings || []), "Использован только распознанный текст. Цвет, расположение, графика и скрытые элементы требуют проверки по изображению."];
        }
        const timeoutMs = Number(this.options.analyzeTimeoutMs) || Number(job.config.requestTimeoutMinutes || 10) * 60000;
        if (provider.family === "ollama" && !preloaded && this.options.preload !== false) {
          preloaded = true;
          await this.progress(job, { phase: "loading", message: "Загружаем локальную модель в память", requestStartedAt: Date.now(), timeoutMs });
          const { preloadModel } = require("./providers");
          await preloadModel({ provider, config: job.config, credential, fetchImpl: this.options.fetchImpl, timeoutMs, signal });
        }
        const cacheDirectory = path.join(directory, `cache-${file.id}`); await fs.mkdir(cacheDirectory, { recursive: true });
        const checkpoint = {
          get: (key) => readStored(path.join(cacheDirectory, `${key}.json`)),
          set: (key, value) => atomicJson(path.join(cacheDirectory, `${key}.json`), value),
        };
        const callOptions = {
          provider, config: job.config, credential, fetchImpl: this.options.fetchImpl, signal, checkpoint,
          timeoutMs, totalTimeoutMs: job.deadlineAt ? Math.max(250, job.deadlineAt - Date.now()) : Number.MAX_SAFE_INTEGER,
          context: { files: [extracted], currentDraft: job.currentDraft, mergeMode: job.mergeMode },
          onProgress: (value) => this.progress(job, value),
        };
        let result;
        try { result = await this.analyzeSections(job, file, extracted, callOptions); }
        catch (error) {
          const imageRetry = extracted.kind === "image" && extracted.text.trim() && mode === "auto" && ["PROVIDER_TIMEOUT", "PROVIDER_OUT_OF_MEMORY", "PROVIDER_UNSUPPORTED_REQUEST", "MODEL_CONTEXT_TOO_SMALL_FOR_IMAGE"].includes(error.code);
          if (!imageRetry) throw error;
          file.warnings = [...(file.warnings || []), "Модель не обработала изображение целиком. Использован OCR-текст; визуальные изменения необходимо проверить вручную."];
          await this.progress(job, { phase: "ocr-fallback", message: "Изображение не обработано моделью. Продолжаем по распознанному тексту" });
          extracted = { ...extracted, kind: "text", buffer: Buffer.alloc(0) };
          result = await this.analyzeSections(job, file, extracted, { ...callOptions, context: { ...callOptions.context, files: [extracted] } });
        }
        result.normalized.warnings.push(...(file.warnings || []));
        await atomicJson(path.join(directory, `${file.id}.result.json`), result);
        file.status = "complete"; file.hasResult = true; file.model = job.config.model; job.hasResult = true;
        if (!extracted.scanComplete && extracted.kind !== "image") {
          file.status = "partial";
          file.error = { code: "EXTRACTION_INCOMPLETE", message: "Прочитана только часть материала. Проверьте сообщения распознавания, исправьте файл или настройку OCR и продолжите. Готовые разделы сохранены; результат пока неполный." };
        }
      } catch (error) {
        if (signal.aborted) { file.status = "ready"; throw error; }
        if (["ANALYSIS_DEADLINE_EXCEEDED", "ENOSPC", "EACCES", "EPERM"].includes(error.code)) { file.status = "ready"; throw error; }
        file.status = file.hasResult ? "partial" : "failed"; file.error = safeError(error, [credential, ...this.options.credentials.secretValues()]);
        if (["PROVIDER_AUTH_FAILED", "PROVIDER_ACCESS_DENIED", "PROVIDER_QUOTA_EXHAUSTED", "PROVIDER_PAYMENT_REQUIRED", "PROVIDER_MODEL_NOT_FOUND"].includes(error.code)) { job.status = "paused"; job.error = file.error; await this.save(job); return; }
      }
      await this.save(job);
    }
    job.status = job.files.every((f) => f.status === "complete") ? "complete" : job.hasResult ? "partial" : "failed";
    job.progress = { phase: job.status, message: job.status === "complete" ? "Все материалы обработаны. Проверьте предложения по источникам." : "Обработка завершена с пропусками. Готовые результаты сохранены; повторите только незавершённые материалы." };
    await this.save(job);
  }
  async analyzeSections(job, file, extracted, options) {
    // Never squeeze an arbitrarily long document into one final model context.
    // Each bounded section produces its own reviewable proposal; merging is deterministic.
    const target = Math.max(800, Math.min(8000, Number(job.config.chunkChars || 1400) * 3));
    const parts = extracted.kind === "image" ? [extracted.text] : splitTextPreserving(extracted.text, target);
    file.sectionsTotal = parts.length; file.sectionsDone = 0;
    const results = []; const sectionErrors = [];
    for (const [index, text] of parts.entries()) {
      this.check(options.signal, job);
      const key = fingerprint({ text, index, kind: extracted.kind, purpose: extracted.purpose });
      const filename = path.join(this.directory(job.id), `${file.id}.section-${key}.json`);
      let result = await readStored(filename);
      if (!result) {
        await this.progress(job, { phase: "section", section: index + 1, sections: parts.length, message: `Раздел ${index + 1} из ${parts.length}`, part: null, parts: null });
        try {
          result = await analyzeWithQuality({ ...options, totalTimeoutMs: job.deadlineAt ? Math.max(250, job.deadlineAt - Date.now()) : options.totalTimeoutMs, context: { ...options.context, files: [{ ...extracted, text, name: parts.length > 1 ? `${file.name} — раздел ${index + 1} из ${parts.length}` : file.name }] } });
          result.model = job.config.model;
          await atomicJson(filename, result);
        } catch (error) {
          if (parts.length === 1) throw error;
          if (options.signal.aborted || ["ANALYSIS_DEADLINE_EXCEEDED", "ENOSPC", "EACCES", "EPERM", "PROVIDER_AUTH_FAILED", "PROVIDER_ACCESS_DENIED", "PROVIDER_QUOTA_EXHAUSTED", "PROVIDER_PAYMENT_REQUIRED", "PROVIDER_MODEL_NOT_FOUND"].includes(error.code)) throw error;
          sectionErrors.push({ section: index + 1, ...safeError(error, [options.credential]) });
          continue;
        }
      }
      results.push(result); file.sectionsDone += 1;
      if (results.length && parts.length > 1) {
        const combined = combinedResult(results, { ...job, files: [{ ...file, status: "running" }] });
        const partial = { normalized: { proposal: combined.proposal, evidence: combined.evidence, warnings: combined.warnings, unknowns: combined.unknowns }, processing: { mode: "sections", sections: parts.length, completed: file.sectionsDone }, quality: { manualReview: true } };
        await atomicJson(path.join(this.directory(job.id), `${file.id}.result.json`), partial);
        file.hasResult = true; job.hasResult = true; await this.save(job);
      }
    }
    if (sectionErrors.length) throw new HttpError(502, "SECTIONS_INCOMPLETE", `Не завершены разделы ${sectionErrors.map((e) => e.section).join(", ")} из ${parts.length}. Готово: ${file.sectionsDone}. ${sectionErrors[0].message} Продолжение повторит только незавершённые разделы.`);
    if (results.length === 1) return results[0];
    const combined = combinedResult(results, { ...job, files: [{ ...file, status: "complete" }] });
    return { normalized: { proposal: combined.proposal, evidence: combined.evidence, warnings: combined.warnings, unknowns: combined.unknowns }, processing: { mode: "sections", sections: parts.length, completed: file.sectionsDone }, quality: { manualReview: true } };
  }
  async result(job) {
    if (job.brief?.topic) return topicResult(this, job);
    const results = [];
    for (const file of job.files) if (file.status === "complete" || file.hasResult) { const value = await readStored(path.join(this.directory(job.id), `${file.id}.result.json`)); if (value) results.push(value); }
    if (!results.length) throw new HttpError(409, "RESULT_NOT_READY", "Готовых предложений пока нет. Дождитесь завершения первого материала или продолжите обработку после исправления ошибки.");
    return combinedResult(results, job);
  }
  async route(request, response, url) {
    if (!url.pathname.startsWith("/api/jobs")) return false;
    await this.ready;
    if (url.pathname === "/api/jobs") {
      if (request.method === "POST") json(response, 201, this.public(await this.create(await readJson(request, 4 * 1024 ** 2))));
      else if (request.method === "GET") {
        const offset = Math.max(0, Number.parseInt(url.searchParams.get("offset"), 10) || 0);
        json(response, 200, { jobs: [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(offset, offset + 20).map((j) => this.public(j)), total: this.jobs.size });
      }
      else throw new HttpError(405, "METHOD_NOT_ALLOWED", "Метод не поддерживается.");
      return true;
    }
    const match = /^\/api\/jobs\/([a-f0-9-]{36})(?:\/(files|start|pause|result|settings|clarifications)(?:\/([a-f0-9-]{36}))?)?$/.exec(url.pathname);
    if (!match) throw new HttpError(404, "JOB_NOT_FOUND", "Обработка не найдена.");
    const job = await this.get(match[1]); const action = match[2];
    if (request.method === "GET" && !action) json(response, 200, this.public(job));
    else if (request.method === "GET" && action === "result") json(response, 200, await this.result(job));
    else await this.locked(job.id, async () => {
      if (request.method === "POST" && action === "files") json(response, 201, await this.addFile(job, await readJson(request, 65536)));
      else if (request.method === "PUT" && action === "files" && match[3]) json(response, 200, await this.upload(job, match[3], request, Number(url.searchParams.get("offset"))));
      else if (request.method === "POST" && action === "start") { await this.start(job, await readJson(request, 65536)); json(response, 200, this.public(job)); }
      else if (request.method === "POST" && action === "pause") { await this.pause(job); json(response, 200, this.public(job)); }
      else if (request.method === "POST" && action === "clarifications") { await this.answerClarifications(job, await readJson(request, 65536)); json(response, 200, this.public(job)); }
      else if (request.method === "POST" && action === "settings") {
        if (!TERMINAL.has(job.status) || this.controllers.has(job.id)) throw new HttpError(409, "JOB_BUSY", "Сначала приостановите обработку и дождитесь завершения текущего запроса.");
        const config = effectiveConfig(getProvider(job.providerId), await this.options.settings.get(job.providerId));
        const modelChanged = fingerprint({ ...job.config, requestTimeoutMinutes: 0, totalTimeoutMinutes: 0, retryCount: 0 }) !== fingerprint({ ...config, requestTimeoutMinutes: 0, totalTimeoutMinutes: 0, retryCount: 0 });
        // Completed materials retain their provenance; retries use new settings only for unfinished work.
        job.config = config;
        if (modelChanged) job.confirmed = false;
        await this.save(job); json(response, 200, this.public(job));
      } else if (request.method === "DELETE" && !action) {
        if (ACTIVE.has(job.status) || this.controllers.has(job.id)) throw new HttpError(409, "JOB_BUSY", "Сначала приостановите обработку, затем удалите сохранённые материалы.");
        await this.writes.get(job.id);
        await fs.rm(this.directory(job.id), { recursive: true, force: true }); this.jobs.delete(job.id); json(response, 200, { ok: true });
      } else throw new HttpError(405, "METHOD_NOT_ALLOWED", "Действие недоступно для этой обработки.");
    });
    return true;
  }
  async close() { this.closed = true; for (const [id, controller] of this.controllers) { controller.abort(); const job = this.jobs.get(id); if (job) { job.status = "paused"; await this.save(job).catch(() => {}); } } }
}
module.exports = { JobManager, combinedResult, safeError, MAX_JOB_FILES, MAX_FILE_BYTES, MAX_JOB_BYTES };
