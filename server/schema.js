"use strict";

const crypto = require("node:crypto");
const { HttpError, asPlainText, clampNumber, isRecord } = require("./util");

const CHANNELS = new Set(["ios", "android", "web"]);
const ROOT_KEYS = new Set(["title", "releaseDate", "rolloutMode", "rolloutConditions", "groups", "support"]);

function parseJsonCandidate(text) {
  const source = String(text || "").replace(/^\uFEFF/, "").trim();
  const attempts = [source];
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(source);
  if (fence) attempts.push(fence[1]);
  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch (_error) {
      // Try a balanced object below.
    }
  }

  for (let start = source.indexOf("{"); start >= 0; start = source.indexOf("{", start + 1)) {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < source.length; index += 1) {
      const char = source[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(source.slice(start, index + 1));
          } catch (_error) {
            break;
          }
        }
      }
    }
  }
  throw new HttpError(502, "INVALID_AI_JSON", "AI вернул ответ, который не удалось разобрать как JSON.");
}

function id(prefix, value) {
  const clean = asPlainText(value, 100).replace(/[^0-9A-Za-zА-Яа-яЁё._:-]/g, "-");
  return clean || `${prefix}-${crypto.randomUUID()}`;
}

function channel(value) {
  const key = asPlainText(value, 30).toLowerCase().replace(/[\s._()/\\-]+/g, "").replace(/ё/g, "е");
  if (["ios", "iphone", "ipad", "айос"].includes(key)) return "ios";
  if (["android", "андроид"].includes(key)) return "android";
  if (["web", "веб", "weblk", "веблк", "личныйкабинет"].includes(key)) return "web";
  return "";
}

function normalizeItem(value, index) {
  const item = isRecord(value) ? value : {};
  return {
    id: id("ai-item", item.id || `ai-item-${index + 1}`),
    title: asPlainText(item.title, 500),
    before: asPlainText(item.before, 10000),
    after: asPlainText(item.after, 10000),
    clientAction: asPlainText(item.clientAction || item.action, 10000),
    supportNote: asPlainText(item.supportNote || item.note, 10000),
  };
}

function normalizeGroup(value, index) {
  const group = isRecord(value) ? value : {};
  let items = Array.isArray(group.items) ? group.items.slice(0, 100).map(normalizeItem) : [];
  if (!items.length && [group.before, group.after, group.clientAction, group.supportNote].some(Boolean)) items = [normalizeItem(group, 0)];
  const channels = [...new Set((Array.isArray(group.channels) ? group.channels : []).map(channel).filter((item) => CHANNELS.has(item)))];
  return {
    id: id("ai-group", group.id || `ai-group-${index + 1}`),
    title: asPlainText(group.title, 500),
    channels,
    location: asPlainText(group.location, 3000),
    availability: asPlainText(group.availability, 3000),
    items,
    screenshots: [],
  };
}

function normalizeFaq(value, index) {
  const faq = isRecord(value) ? value : {};
  return {
    id: id("ai-faq", faq.id || `ai-faq-${index + 1}`),
    question: asPlainText(faq.question, 3000),
    answer: asPlainText(faq.answer, 10000),
  };
}

function proposalSource(parsed) {
  if (isRecord(parsed.proposal)) return parsed.proposal;
  if (isRecord(parsed.draft)) return parsed.draft;
  if (isRecord(parsed.result) && Object.keys(parsed.result).some((key) => ROOT_KEYS.has(key))) return parsed.result;
  return parsed;
}

function normalizeProposal(source) {
  const proposal = proposalSource(source);
  const support = isRecord(proposal.support) ? proposal.support : {};
  let groups = Array.isArray(proposal.groups) ? proposal.groups : [];
  if (!groups.length && Array.isArray(proposal.changes)) groups = proposal.changes;
  return {
    schemaVersion: 4,
    title: asPlainText(proposal.title || proposal.feature, 500),
    releaseDate: /^\d{4}-\d{2}-\d{2}$/.test(asPlainText(proposal.releaseDate, 30)) ? asPlainText(proposal.releaseDate, 30) : "",
    rolloutMode: asPlainText(proposal.rolloutMode || proposal.releaseMode, 3000),
    rolloutConditions: asPlainText(proposal.rolloutConditions || proposal.rollout, 10000),
    groups: groups.slice(0, 30).map(normalizeGroup),
    support: {
      say: asPlainText(support.say || proposal.doSay, 10000),
      dontSay: asPlainText(support.dontSay || proposal.dontSay, 10000),
      details: asPlainText(support.details || proposal.details, 20000),
      faq: (Array.isArray(support.faq) ? support.faq : Array.isArray(proposal.faq) ? proposal.faq : []).slice(0, 100).map(normalizeFaq),
    },
  };
}

function normalizePath(value) {
  const path = asPlainText(value, 300);
  return /^(?:proposal\.)?(?:title|releaseDate|rolloutMode|rolloutConditions|groups(?:\[\d+\])?(?:\.(?:title|channels|location|availability|items(?:\[\d+\])?\.(?:title|before|after|clientAction|supportNote)))?|support(?:\.(?:say|dontSay|details|faq(?:\[\d+\])?\.(?:question|answer)))?)$/.test(path) ? path : "";
}

function normalizeAiOutput(rawText, sourceIds) {
  const parsed = parseJsonCandidate(rawText);
  if (!isRecord(parsed)) throw new HttpError(502, "INVALID_AI_SHAPE", "AI вернул JSON неподдерживаемой структуры.");
  const allowedSources = new Set((sourceIds || []).map(String));
  const evidenceInput = Array.isArray(parsed.evidence) ? parsed.evidence : [];
  const evidence = evidenceInput.slice(0, 500).map((entry) => {
    const item = isRecord(entry) ? entry : {};
    const sourceId = asPlainText(item.sourceId || item.fileId, 100);
    return {
      path: normalizePath(item.path || item.field),
      sourceId: allowedSources.has(sourceId) ? sourceId : "",
      page: Number.isInteger(Number(item.page)) && Number(item.page) > 0 ? Number(item.page) : null,
      snippet: asPlainText(item.snippet || item.quote, 500),
      confidence: clampNumber(item.confidence, 0, 1, 0),
    };
  }).filter((item) => item.path && item.sourceId);
  const stringList = (value, max, length) => (Array.isArray(value) ? value : []).slice(0, max).map((item) => asPlainText(item, length)).filter(Boolean);
  return {
    schemaVersion: 4,
    proposal: normalizeProposal(parsed),
    evidence,
    warnings: stringList(parsed.warnings, 100, 1000),
    unknowns: stringList(parsed.unknowns, 200, 300),
  };
}

module.exports = { parseJsonCandidate, normalizeProposal, normalizeAiOutput };
