(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.SirenAIMerge = Object.freeze(api);
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const UNKNOWN_MARKERS = new Set([
    "-", "—", "?", "n/a", "na", "none", "null", "tbd", "unknown",
    "нет данных", "неизвестно", "не известно", "не указано", "не определено",
    "уточнить", "требует уточнения", "информация отсутствует", "данные отсутствуют"
  ]);

  const TEXT_LIMIT = 30000;
  const CHANNELS = new Set(["ios", "android", "web"]);

  function deepClone(value) {
    if (typeof structuredClone === "function") {
      try { return structuredClone(value); } catch (_error) { /* JSON fallback below. */ }
    }
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function decodeEntities(value) {
    return String(value || "")
      .replace(/&nbsp;|&#160;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, "\"")
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&#(\d+);/g, (_match, number) => {
        const code = Number(number);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : "";
      });
  }

  function sanitizePlainText(value) {
    if (value === null || value === undefined) return "";
    const source = String(value)
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
      .replace(/<\s*br\s*\/?>/gi, "\n")
      .replace(/<\s*\/\s*(p|div|li|ul|ol|h[1-6])\s*>/gi, "\n")
      .replace(/<!--[^]*?-->|<\/?[a-z][a-z0-9:-]*(?:\s[^<>]*)?\s*\/?>/gi, " ");
    return decodeEntities(source)
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .slice(0, TEXT_LIMIT);
  }

  function plainForComparison(value) {
    return sanitizePlainText(value).replace(/\s+/g, " ").trim().toLocaleLowerCase("ru-RU");
  }

  function isUnknownValue(value) {
    if (value === null || value === undefined) return true;
    if (Array.isArray(value)) return value.length === 0;
    if (typeof value === "object") return Object.keys(value).length === 0;
    const plain = plainForComparison(value);
    if (!plain) return true;
    if (UNKNOWN_MARKERS.has(plain)) return true;
    return /^(?:<[^>]+>\s*)+$/.test(String(value).trim());
  }

  function isEmptyCurrent(value) {
    if (value === null || value === undefined) return true;
    if (Array.isArray(value)) return value.length === 0;
    if (typeof value === "string") return plainForComparison(value) === "";
    return false;
  }

  function sameValue(a, b) {
    if (Array.isArray(a) || Array.isArray(b)) {
      return JSON.stringify(Array.isArray(a) ? a : []) === JSON.stringify(Array.isArray(b) ? b : []);
    }
    return String(a === undefined || a === null ? "" : a) === String(b === undefined || b === null ? "" : b);
  }

  function pathToString(parts) {
    return parts.reduce((result, part) => {
      if (typeof part === "number") return `${result}[${part}]`;
      return result ? `${result}.${part}` : String(part);
    }, "");
  }

  function getAtPath(object, parts) {
    return parts.reduce((value, part) => (value === null || value === undefined ? undefined : value[part]), object);
  }

  function setAtPath(object, parts, value) {
    let cursor = object;
    parts.forEach((part, index) => {
      const isLast = index === parts.length - 1;
      if (isLast) {
        cursor[part] = deepClone(value);
        return;
      }
      const nextPart = parts[index + 1];
      if (cursor[part] === null || typeof cursor[part] !== "object") {
        cursor[part] = typeof nextPart === "number" ? [] : {};
      }
      cursor = cursor[part];
    });
  }

  function safeText(value, sanitizer) {
    if (value === null || value === undefined) return "";
    let candidate = value;
    if (typeof sanitizer === "function") {
      try { candidate = sanitizer(String(value)); } catch (_error) { candidate = value; }
    }
    return sanitizePlainText(candidate);
  }

  function safeChannels(value) {
    if (!Array.isArray(value)) return [];
    const unique = [];
    value.forEach((entry) => {
      const channel = sanitizePlainText(entry).toLowerCase();
      if (CHANNELS.has(channel) && !unique.includes(channel)) unique.push(channel);
    });
    return ["ios", "android", "web"].filter((channel) => unique.includes(channel));
  }

  function safeId(value) {
    return sanitizePlainText(value).replace(/[^a-zA-Z0-9._:-]/g, "").slice(0, 160);
  }

  function normalizeSelectedPaths(value) {
    if (value instanceof Set) return new Set(Array.from(value, String));
    if (Array.isArray(value)) return new Set(value.map(String));
    return null;
  }

  function normalizeEvidence(evidence) {
    const result = Object.create(null);
    const add = (path, raw) => {
      const cleanPath = sanitizePlainText(path).slice(0, 500);
      if (!cleanPath || raw === null || raw === undefined) return;
      const list = Array.isArray(raw) ? raw : [raw];
      const safe = list.map((item) => {
        if (item && typeof item === "object") {
          const entry = {};
          [
            "source", "sourceId", "sourceName", "file", "fileName", "page", "sheet", "slide",
            "region", "lineStart", "lineEnd", "range", "quote", "excerpt", "note", "confidence", "verification"
          ].forEach((key) => {
            if (Object.prototype.hasOwnProperty.call(item, key)) entry[key] = sanitizePlainText(item[key]).slice(0, 1200);
          });
          if (item.requiresReview === true) entry.requiresReview = true;
          return entry;
        }
        return { note: sanitizePlainText(item).slice(0, 1200) };
      }).filter((entry) => Object.keys(entry).length);
      if (safe.length) result[cleanPath] = safe;
    };

    if (Array.isArray(evidence)) {
      evidence.forEach((entry) => {
        if (!entry || typeof entry !== "object") return;
        add(entry.path || entry.field || entry.target, entry);
      });
    } else if (evidence && typeof evidence === "object") {
      Object.keys(evidence).forEach((path) => add(path, evidence[path]));
    }
    return result;
  }

  const ROOT_TEXT = ["title", "releaseDate", "rolloutMode", "rolloutConditions"];
  const GROUP_TEXT = ["title", "location", "availability"];
  const ITEM_TEXT = ["title", "before", "after", "clientAction", "supportNote"];
  const SUPPORT_TEXT = ["say", "dontSay", "details"];
  const FAQ_TEXT = ["question", "answer"];

  function indexById(items) {
    const map = new Map();
    (Array.isArray(items) ? items : []).forEach((item, index) => {
      const id = item && typeof item === "object" ? safeId(item.id) : "";
      if (id && !map.has(id)) map.set(id, index);
    });
    return map;
  }

  function createPlanner(current, proposal, options) {
    const sanitizer = options && options.sanitizeRichText;
    const changes = [];
    const structure = new Map();

    function addText(parts, rawValue) {
      const proposed = safeText(rawValue, sanitizer);
      if (isUnknownValue(proposed)) return;
      if (parts.length === 1 && parts[0] === "releaseDate") {
        const match = proposed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!match) return;
        const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
        if (date.getUTCFullYear() !== Number(match[1]) || date.getUTCMonth() !== Number(match[2]) - 1 || date.getUTCDate() !== Number(match[3])) return;
      }
      const currentValue = getAtPath(current, parts);
      if (sameValue(currentValue, proposed)) return;
      changes.push({
        path: pathToString(parts),
        parts: parts.slice(),
        current: currentValue === undefined || currentValue === null ? "" : deepClone(currentValue),
        proposed,
        currentEmpty: isEmptyCurrent(currentValue),
        kind: "text"
      });
    }

    function addChannels(parts, rawValue) {
      const proposed = safeChannels(rawValue);
      if (!proposed.length) return;
      const currentValue = getAtPath(current, parts);
      if (sameValue(currentValue, proposed)) return;
      changes.push({
        path: pathToString(parts),
        parts: parts.slice(),
        current: Array.isArray(currentValue) ? deepClone(currentValue) : [],
        proposed,
        currentEmpty: !Array.isArray(currentValue) || currentValue.length === 0,
        kind: "channels"
      });
    }

    function noteStructure(parts, id) {
      const path = pathToString(parts);
      if (!structure.has(path)) structure.set(path, safeId(id));
    }

    function planFaq(currentFaq, proposedFaq, baseParts) {
      const existing = Array.isArray(currentFaq) ? currentFaq : [];
      const ids = indexById(existing);
      let appendIndex = existing.length;
      (Array.isArray(proposedFaq) ? proposedFaq : []).forEach((faq) => {
        if (!faq || typeof faq !== "object") return;
        const id = safeId(faq.id);
        const targetIndex = id && ids.has(id) ? ids.get(id) : appendIndex++;
        const parts = baseParts.concat(targetIndex);
        if (targetIndex >= existing.length) noteStructure(parts, id);
        FAQ_TEXT.forEach((key) => {
          if (Object.prototype.hasOwnProperty.call(faq, key)) addText(parts.concat(key), faq[key]);
        });
      });
    }

    function planItems(currentItems, proposedItems, baseParts) {
      const existing = Array.isArray(currentItems) ? currentItems : [];
      const ids = indexById(existing);
      let appendIndex = existing.length;
      (Array.isArray(proposedItems) ? proposedItems : []).forEach((item) => {
        if (!item || typeof item !== "object") return;
        const id = safeId(item.id);
        const targetIndex = id && ids.has(id) ? ids.get(id) : appendIndex++;
        const parts = baseParts.concat(targetIndex);
        if (targetIndex >= existing.length) noteStructure(parts, id);
        ITEM_TEXT.forEach((key) => {
          if (Object.prototype.hasOwnProperty.call(item, key)) addText(parts.concat(key), item[key]);
        });
      });
    }

    ROOT_TEXT.forEach((key) => {
      if (proposal && typeof proposal === "object" && Object.prototype.hasOwnProperty.call(proposal, key)) {
        addText([key], proposal[key]);
      }
    });

    const currentGroups = current && Array.isArray(current.groups) ? current.groups : [];
    const proposedGroups = proposal && Array.isArray(proposal.groups) ? proposal.groups : [];
    const groupIds = indexById(currentGroups);
    let appendGroupIndex = currentGroups.length;
    proposedGroups.forEach((group) => {
      if (!group || typeof group !== "object") return;
      const id = safeId(group.id);
      const targetIndex = id && groupIds.has(id) ? groupIds.get(id) : appendGroupIndex++;
      const parts = ["groups", targetIndex];
      const currentGroup = currentGroups[targetIndex] || {};
      if (targetIndex >= currentGroups.length) noteStructure(parts, id);
      GROUP_TEXT.forEach((key) => {
        if (Object.prototype.hasOwnProperty.call(group, key)) addText(parts.concat(key), group[key]);
      });
      if (Object.prototype.hasOwnProperty.call(group, "channels")) addChannels(parts.concat("channels"), group.channels);
      planItems(currentGroup.items, group.items, parts.concat("items"));
      // screenshots and every dataUrl are intentionally excluded from AI merging.
    });

    const currentSupport = current && current.support && typeof current.support === "object" ? current.support : {};
    const proposedSupport = proposal && proposal.support && typeof proposal.support === "object" ? proposal.support : {};
    SUPPORT_TEXT.forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(proposedSupport, key)) addText(["support", key], proposedSupport[key]);
    });
    planFaq(currentSupport.faq, proposedSupport.faq, ["support", "faq"]);

    return { changes, structure };
  }

  function planProposal(currentInput, proposalInput, optionsInput) {
    const current = currentInput && typeof currentInput === "object" ? deepClone(currentInput) : {};
    const proposal = proposalInput && typeof proposalInput === "object" ? proposalInput : {};
    const options = optionsInput && typeof optionsInput === "object" ? optionsInput : {};
    const mode = options.mode === "replace" || options.mode === "replace-selected" ? "replace-selected" : "fill-empty";
    const selectedPaths = normalizeSelectedPaths(options.selectedPaths);
    const evidenceByPath = normalizeEvidence(options.evidence || (proposalInput && proposalInput.evidence));
    const planned = createPlanner(current, proposal, options);
    const draft = deepClone(current);

    const publicChanges = planned.changes.map((change) => {
      const defaultSelected = mode === "fill-empty" ? change.currentEmpty : true;
      const explicitlySelected = selectedPaths ? selectedPaths.has(change.path) : false;
      const selected = mode === "fill-empty"
        ? change.currentEmpty && (selectedPaths ? explicitlySelected : true)
        : Boolean(selectedPaths && explicitlySelected);
      if (selected) {
        // Create an ID shell only when at least one field of a new entity is actually applied.
        for (const [parentPath, id] of planned.structure.entries()) {
          if (!id || !(change.path === parentPath || change.path.startsWith(`${parentPath}.`) || change.path.startsWith(`${parentPath}[`))) continue;
          const parentParts = parentPath.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean).map((part) => /^\d+$/.test(part) ? Number(part) : part);
          const existingParent = getAtPath(draft, parentParts);
          if (!existingParent || typeof existingParent !== "object") setAtPath(draft, parentParts, { id });
          else if (!existingParent.id) existingParent.id = id;
        }
        setAtPath(draft, change.parts, change.proposed);
      }
      return Object.freeze({
        path: change.path,
        current: deepClone(change.current),
        proposed: deepClone(change.proposed),
        currentEmpty: change.currentEmpty,
        kind: change.kind,
        defaultSelected,
        selected,
        evidence: deepClone(evidenceByPath[change.path] || [])
      });
    });

    // Identity and image payloads already present in the user's draft are never touched.
    return {
      draft,
      changes: publicChanges,
      undoSnapshot: deepClone(current),
      evidenceByPath: deepClone(evidenceByPath)
    };
  }

  function mergeProposal(current, proposal, options) {
    return planProposal(current, proposal, options).draft;
  }

  return {
    planProposal,
    mergeProposal,
    deepClone,
    isUnknownValue,
    sanitizePlainText
  };
});
