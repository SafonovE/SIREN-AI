"use strict";
const crypto = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const { analyzeWithProvider } = require("./providers");
const { parseJsonCandidate, normalizeAiOutput } = require("./schema");
const { HttpError } = require("./util");

function fingerprint(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value, (key, item) => {
    if (key === "buffer" && item) return crypto.createHash("sha256").update(Buffer.isBuffer(item) ? item : Buffer.from(item.data || [])).digest("hex");
    return item;
  })).digest("hex");
}
async function reliableCall(options) {
  if (options.signal?.aborted) throw new HttpError(499, "ANALYSIS_CANCELLED", "Обработка приостановлена. Готовые этапы сохранены. Нажмите «Продолжить».");
  const cacheConfig = { ...options.config }; for (const name of ["requestTimeoutMinutes", "totalTimeoutMinutes", "retryCount"]) delete cacheConfig[name];
  // A validated format repair answers the same task. Store it under the
  // caller's original contract so resume does not repeat the rejected response.
  const key = fingerprint({ version: 3, provider: options.provider.id, config: cacheConfig, context: options.checkpointContext || options.context });
  const previousKeys = options.validateResult ? (options.previousCheckpointContexts || []).map((context) => fingerprint({ version: 3, provider: options.provider.id, config: cacheConfig, context })) : [];
  for (const candidateKey of [key, ...previousKeys]) {
    const cached = await options.checkpoint?.get(candidateKey);
    if (cached && (!options.validateResult || options.validateResult(cached.text))) {
      if (candidateKey !== key) await options.checkpoint?.set(key, cached);
      await options.onProgress?.({ phase: "cached", message: "Используем сохранённый ответ" });
      return cached;
    }
  }
  const retries = Math.max(0, Math.min(3, Number(options.config?.retryCount ?? 2)));
  for (let attempt = 0; ; attempt++) {
    const remaining = options.deadlineAt ? options.deadlineAt - Date.now() : Number.MAX_SAFE_INTEGER;
    if (remaining < 250) throw new HttpError(504, "ANALYSIS_DEADLINE_EXCEEDED", "Общий лимит времени истёк. Увеличьте его в настройках обработки и продолжите; готовые этапы сохранены.");
    const topicMessages = { "topic-extract": "Отбираем факты по теме из части материала", "topic-inspect": "Проверяем факты и противоречия в источниках", "topic-compose": "Составляем единую инструкцию", "topic-audit": "Проверяем формулировки и полноту инструкции" };
    await options.onProgress?.({ phase: "request", attempt: attempt + 1, requestStartedAt: Date.now(), timeoutMs: options.timeoutMs, message: topicMessages[options.context.requestMode] || (options.context.requestMode === "fact-extraction" ? "Извлекаем факты из части материала" : options.context.qualityRepair ? "Проверяем и уточняем формулировки" : "Составляем предложения") });
    try {
      const result = await analyzeWithProvider({ ...options, timeoutMs: Math.min(options.timeoutMs, remaining) });
      // Never persist an incomplete JSON response as a successful checkpoint.
      let valid = false;
      try {
        const parsed = parseJsonCandidate(result.text);
        if (options.validateResult) valid = options.validateResult(result.text) === true;
        else if (options.context.requestMode === "topic-extract") valid = parsed.coverage === "complete" && Array.isArray(parsed.facts) && (parsed.facts.length > 0 || Boolean(parsed.irrelevantReason));
        else if (options.context.requestMode) valid = Array.isArray(parsed.facts) && parsed.facts.length > 0;
        else {
          const normalized = normalizeAiOutput(result.text, options.context.files.map((file) => file.id));
          valid = Boolean(normalized.proposal.title || normalized.proposal.groups?.length || normalized.proposal.support?.say);
        }
      } catch { /* The quality cycle repairs invalid JSON and invalid shapes. */ }
      if (valid) await options.checkpoint?.set(key, result);
      return result;
    } catch (error) {
      if (options.signal?.aborted) throw new HttpError(499, "ANALYSIS_CANCELLED", "Обработка приостановлена. Готовые этапы сохранены.");
      // A timeout must reach adaptive splitting instead of retrying the same large input.
      if (!error?.details?.retryable || ["PROVIDER_TIMEOUT", "PROVIDER_CONTEXT_LIMIT", "PROVIDER_REQUEST_TOO_LARGE"].includes(error.code) || attempt >= retries) throw error;
      const waitMs = Math.min(15000, 1500 * 2 ** attempt, options.deadlineAt ? Math.max(0, options.deadlineAt - Date.now()) : 15000);
      await options.onProgress?.({ phase: "retry", message: `Временный сбой. Повтор ${attempt + 1} из ${retries} через ${Math.ceil(waitMs / 1000)} с.` });
      try { await delay(waitMs, undefined, { signal: options.signal }); } catch { throw new HttpError(499, "ANALYSIS_CANCELLED", "Обработка приостановлена."); }
    }
  }
}
module.exports = { reliableCall, fingerprint };
