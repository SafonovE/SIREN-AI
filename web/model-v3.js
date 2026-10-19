(function () {
  "use strict";

  const root = typeof globalThis !== "undefined" ? globalThis : window;
  const CHANNEL_ORDER = ["ios", "android", "web"];
  const SCREENSHOT_ROLES = new Set(["before", "after", "step", "scheme"]);
  let fallbackIdCounter = 0;

  function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function asText(value) {
    if (value === null || value === undefined) return "";
    if (typeof value === "string") return value.trim();
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return "";
  }

  function decodeEntities(value) {
    const named = {
      amp: "&",
      apos: "'",
      gt: ">",
      lt: "<",
      nbsp: " ",
      quot: '"',
    };

    return String(value || "").replace(
      /&(#x[0-9a-f]+|#\d+|amp|apos|gt|lt|nbsp|quot);/gi,
      (match, entity) => {
        const key = entity.toLowerCase();
        if (Object.prototype.hasOwnProperty.call(named, key)) return named[key];
        const numeric = key.startsWith("#x")
          ? Number.parseInt(key.slice(2), 16)
          : Number.parseInt(key.slice(1), 10);
        if (!Number.isFinite(numeric) || numeric < 0 || numeric > 0x10ffff) return match;
        try {
          return String.fromCodePoint(numeric);
        } catch (_error) {
          return match;
        }
      }
    );
  }

  function toPlainText(value) {
    return decodeEntities(
      asText(value)
        .replace(/<\s*br\s*\/?>/gi, "\n")
        .replace(/<\/(?:div|h[1-6]|li|ol|p|section|ul)>/gi, "\n")
        .replace(/<li(?:\s[^>]*)?>/gi, "• ")
        .replace(/<!--[^]*?-->|<\/?[a-z][a-z0-9:-]*(?:\s[^<>]*)?\s*\/?>/gi, "")
    )
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
  }

  function hasText(value) {
    return toPlainText(value).length > 0;
  }

  function createId(prefix) {
    if (root.crypto && typeof root.crypto.randomUUID === "function") {
      return `${prefix}-${root.crypto.randomUUID()}`;
    }

    fallbackIdCounter += 1;
    return `${prefix}-${Date.now().toString(36)}-${fallbackIdCounter.toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
  }

  function parseRaw(raw) {
    if (typeof raw !== "string") return isRecord(raw) ? raw : {};
    try {
      const parsed = JSON.parse(raw);
      return isRecord(parsed) ? parsed : {};
    } catch (_error) {
      return {};
    }
  }

  function deepClone(value, seen) {
    if (value === null || typeof value !== "object") return value;

    const references = seen || new WeakMap();
    if (references.has(value)) return references.get(value);

    if (value instanceof Date) return new Date(value.getTime());
    if (value instanceof RegExp) return new RegExp(value.source, value.flags);

    if (Array.isArray(value)) {
      const clone = [];
      references.set(value, clone);
      value.forEach((item) => clone.push(deepClone(item, references)));
      return clone;
    }

    const clone = {};
    references.set(value, clone);
    Object.keys(value).forEach((key) => {
      clone[key] = deepClone(value[key], references);
    });
    return clone;
  }

  function platformKey(value) {
    return asText(value)
      .toLowerCase()
      .replace(/ё/g, "е")
      .replace(/[\s._()/\\-]+/g, "");
  }

  function canonicalChannel(value) {
    const key = platformKey(value);
    if (["ios", "iphone", "ipad", "айос"].includes(key)) return "ios";
    if (["android", "андроид"].includes(key)) return "android";
    if (["web", "weblk", "webcabinet", "веб", "веблк", "личныйкабинет"].includes(key)) {
      return "web";
    }
    return "";
  }

  function normalizeChannels(value) {
    const source = Array.isArray(value)
      ? value
      : typeof value === "string"
        ? value.split(/[,;|]+|\s+\/\s+/)
        : [];
    const selected = new Set();

    source.forEach((item) => {
      const channel = canonicalChannel(item);
      if (channel) selected.add(channel);
    });

    return CHANNEL_ORDER.filter((channel) => selected.has(channel));
  }

  function normalizeScreenshotRole(value) {
    const role = asText(value).toLowerCase();
    if (SCREENSHOT_ROLES.has(role)) return role;
    if (["было", "как было", "старый", "старое", "до"].includes(role)) return "before";
    if (["стало", "как стало", "новый", "новое", "после"].includes(role)) return "after";
    if (["схема", "диаграмма", "diagram"].includes(role)) return "scheme";
    return "step";
  }

  function positiveNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
  }

  function normalizeScreenshot(value) {
    const image = isRecord(value) ? value : {};
    const directDataUrl = typeof value === "string" && value.startsWith("data:") ? value : "";
    return {
      id: asText(image.id) || createId("shot"),
      role: normalizeScreenshotRole(image.role || image.type),
      name: asText(image.name || image.fileName),
      title: asText(image.title),
      caption: asText(image.caption || image.description),
      dataUrl: asText(image.dataUrl) || directDataUrl,
      width: positiveNumber(image.width),
      height: positiveNumber(image.height),
      layout: image.layout === "full" ? "full" : "half",
    };
  }

  function normalizeFaq(value) {
    if (!Array.isArray(value)) return [];
    return value
      .filter(isRecord)
      .map((item) => ({
        id: asText(item.id) || createId("faq"),
        question: asText(item.question),
        answer: asText(item.answer),
      }));
  }

  function normalizeChange(value) {
    const change = isRecord(value) ? value : {};
    return {
      id: asText(change.id) || createId("change"),
      title: asText(change.title),
      channels: normalizeChannels(change.channels),
      location: asText(change.location),
      availability: asText(change.availability),
      before: asText(change.before),
      after: asText(change.after),
      clientAction: asText(change.clientAction),
      supportNote: asText(change.supportNote),
      screenshots: Array.isArray(change.screenshots)
        ? change.screenshots.map(normalizeScreenshot)
        : [],
    };
  }

  function normalizeV3(source) {
    const support = isRecord(source.support) ? source.support : {};
    return {
      schemaVersion: 3,
      title: asText(source.title),
      releaseDate: asText(source.releaseDate),
      rolloutMode: asText(source.rolloutMode),
      rolloutConditions: asText(source.rolloutConditions),
      changes: Array.isArray(source.changes) ? source.changes.map(normalizeChange) : [],
      support: {
        say: asText(support.say),
        dontSay: asText(support.dontSay),
        details: asText(support.details),
        faq: normalizeFaq(support.faq),
      },
    };
  }

  function normalizeItem(value) {
    const item = isRecord(value) ? value : {};
    return {
      id: asText(item.id) || createId("item"),
      title: asText(item.title),
      before: asText(item.before),
      after: asText(item.after),
      clientAction: asText(item.clientAction || item.action),
      supportNote: asText(item.supportNote || item.note),
    };
  }

  function hasDirectItemFields(value) {
    if (!isRecord(value)) return false;
    return ["before", "after", "clientAction", "supportNote", "action", "note"].some((key) =>
      Object.prototype.hasOwnProperty.call(value, key)
    );
  }

  function normalizeGroup(value) {
    const group = isRecord(value) ? value : {};
    let items = Array.isArray(group.items) ? group.items.map(normalizeItem) : [];

    // Preserve a partially migrated group that still carries the old change fields.
    if (!items.length && hasDirectItemFields(group)) items = [normalizeItem(group)];
    // The editor always needs one row even though an entirely blank row is omitted by renderers.
    if (!items.length) items = [normalizeItem({})];

    return {
      id: asText(group.id) || createId("group"),
      title: asText(group.title),
      channels: normalizeChannels(group.channels),
      location: asText(group.location),
      availability: asText(group.availability),
      items,
      screenshots: Array.isArray(group.screenshots)
        ? group.screenshots.map(normalizeScreenshot)
        : [],
    };
  }

  function normalizeV4(source) {
    const support = isRecord(source.support) ? source.support : {};
    const groups = Array.isArray(source.groups) ? source.groups.map(normalizeGroup) : [];
    if (!groups.length) groups.push(normalizeGroup({}));

    return {
      schemaVersion: 4,
      title: asText(source.title),
      releaseDate: asText(source.releaseDate),
      rolloutMode: asText(source.rolloutMode),
      rolloutConditions: asText(source.rolloutConditions),
      groups,
      support: {
        say: asText(support.say),
        dontSay: asText(support.dontSay),
        details: asText(support.details),
        faq: normalizeFaq(support.faq),
      },
    };
  }

  function migrateV3(raw) {
    const source = normalizeV3(parseRaw(raw));
    const groups = source.changes.map((change) => ({
      id: change.id,
      title: change.title,
      channels: change.channels,
      location: change.location,
      availability: change.availability,
      items: [
        {
          id: `${change.id}-item`,
          title: "",
          before: change.before,
          after: change.after,
          clientAction: change.clientAction,
          supportNote: change.supportNote,
        },
      ],
      screenshots: change.screenshots,
    }));

    return normalizeV4({
      schemaVersion: 4,
      title: source.title,
      releaseDate: source.releaseDate,
      rolloutMode: source.rolloutMode,
      rolloutConditions: source.rolloutConditions,
      groups,
      support: source.support,
    });
  }

  function mergeExplicitText(first, second) {
    if (!hasText(first)) return asText(second);
    if (!hasText(second)) return asText(first);

    const firstPlain = toPlainText(first).toLocaleLowerCase("ru-RU");
    const secondPlain = toPlainText(second).toLocaleLowerCase("ru-RU");
    if (secondPlain.includes(firstPlain)) return asText(second);
    if (firstPlain.includes(secondPlain)) return asText(first);
    return `${asText(first)}\n\n${asText(second)}`;
  }

  function legacyVersion(source, channel) {
    const versions = isRecord(source.platformVersions) ? source.platformVersions : {};
    const matchingKey = Object.keys(versions).find((key) => canonicalChannel(key) === channel);
    return matchingKey ? asText(versions[matchingKey]) : "";
  }

  function legacyAvailability(source, channels) {
    const facts = [];
    if (channels.length) {
      const labels = { ios: "iOS", android: "Android", web: "веб-ЛК" };
      const platforms = channels.map((channel) => {
        const version = legacyVersion(source, channel);
        return version ? `${labels[channel]} — ${version}` : labels[channel];
      });
      facts.push(`Платформы: ${platforms.join(", ")}.`);
    }
    if (hasText(source.releaseMode)) facts.push(`Формат выката: ${asText(source.releaseMode)}.`);
    if (hasText(source.rollout)) facts.push(asText(source.rollout));
    return facts.join("\n");
  }

  function migrateLegacy(raw) {
    const source = parseRaw(raw);
    if (Number(source.schemaVersion) === 4) return normalizeV4(source);
    if (Number(source.schemaVersion) === 3 || Array.isArray(source.changes)) {
      return migrateV3(source);
    }

    const channels = normalizeChannels(source.platforms);
    return migrateV3({
      schemaVersion: 3,
      title: source.title || source.feature,
      releaseDate: source.releaseDate,
      rolloutMode: source.releaseMode,
      rolloutConditions: source.rollout,
      changes: [
        {
          id: source.changeId,
          title: source.feature || source.title,
          channels,
          location: source.location,
          availability: legacyAvailability(source, channels),
          before: source.before,
          after: mergeExplicitText(source.brief, source.after),
          clientAction: "",
          supportNote: source.supportNotes,
          screenshots: Array.isArray(source.images) ? source.images : [],
        },
      ],
      support: {
        say: source.doSay,
        dontSay: source.dontSay,
        details: source.details,
        faq: source.faq,
      },
    });
  }

  function normalizeState(input) {
    const source = parseRaw(input);
    return Number(source.schemaVersion) === 4 ? normalizeV4(source) : migrateLegacy(source);
  }

  function addIssue(list, path, message) {
    list.push({ path, message });
  }

  function validateState(state) {
    const errors = [];
    const warnings = [];

    if (!isRecord(state)) {
      addIssue(errors, "state", "Ожидается объект инструкции.");
      return { valid: false, errors, warnings };
    }

    if (Number(state.schemaVersion) !== 4) {
      addIssue(errors, "schemaVersion", "Ожидается версия схемы 4.");
    }
    if (!hasText(state.title)) {
      addIssue(errors, "title", "Укажите название инструкции.");
    }
    if (hasText(state.releaseDate) && !/^\d{4}-\d{2}-\d{2}$/.test(asText(state.releaseDate))) {
      addIssue(warnings, "releaseDate", "Используйте дату в формате ГГГГ-ММ-ДД.");
    }
    const groupIds = new Set();
    const itemIds = new Set();
    const screenshotIds = new Set();
    let hasRequiredAfter = false;

    if (!Array.isArray(state.groups)) {
      addIssue(errors, "groups", "Группы изменений должны быть массивом.");
    } else {
      state.groups.forEach((group, groupIndex) => {
        const base = `groups[${groupIndex}]`;
        if (!isRecord(group)) {
          addIssue(errors, base, "Группа изменений должна быть объектом.");
          return;
        }

        if (!hasText(group.id)) {
          addIssue(warnings, `${base}.id`, "У группы нет идентификатора; он будет создан при нормализации.");
        } else if (groupIds.has(group.id)) {
          addIssue(errors, `${base}.id`, "Идентификатор группы повторяется.");
        } else {
          groupIds.add(group.id);
        }

        if (Object.prototype.hasOwnProperty.call(group, "channels") && !Array.isArray(group.channels)) {
          addIssue(warnings, `${base}.channels`, "Каналы проигнорированы: ожидается массив.");
        } else if (Array.isArray(group.channels)) {
          group.channels.forEach((channel, channelIndex) => {
            if (!CHANNEL_ORDER.includes(channel)) {
              addIssue(
                errors,
                `${base}.channels[${channelIndex}]`,
                "Допустимые значения канала: ios, android, web."
              );
            }
          });
        }

        if (!Array.isArray(group.items)) {
          addIssue(errors, `${base}.items`, "Пункты изменений должны быть массивом.");
        } else {
          group.items.forEach((item, itemIndex) => {
            const itemPath = `${base}.items[${itemIndex}]`;
            if (!isRecord(item)) {
              addIssue(errors, itemPath, "Пункт изменения должен быть объектом.");
              return;
            }
            if (!hasText(item.id)) {
              addIssue(warnings, `${itemPath}.id`, "У пункта нет идентификатора; он будет создан при нормализации.");
            } else if (itemIds.has(item.id)) {
              addIssue(errors, `${itemPath}.id`, "Идентификатор пункта повторяется.");
            } else {
              itemIds.add(item.id);
            }
            if (hasText(item.after)) hasRequiredAfter = true;
          });
        }

        if (
          Object.prototype.hasOwnProperty.call(group, "screenshots") &&
          !Array.isArray(group.screenshots)
        ) {
          addIssue(warnings, `${base}.screenshots`, "Скриншоты проигнорированы: ожидается массив.");
        } else if (Array.isArray(group.screenshots)) {
          group.screenshots.forEach((screenshot, screenshotIndex) => {
            const imagePath = `${base}.screenshots[${screenshotIndex}]`;
            if (!isRecord(screenshot)) {
              addIssue(errors, imagePath, "Скриншот должен быть объектом.");
              return;
            }
            if (!hasText(screenshot.id)) {
              addIssue(errors, `${imagePath}.id`, "У скриншота нет идентификатора. Добавьте файл повторно.");
            } else if (screenshotIds.has(screenshot.id)) {
              addIssue(errors, `${imagePath}.id`, "Идентификатор скриншота повторяется. Добавьте файл повторно.");
            } else {
              screenshotIds.add(screenshot.id);
            }
            if (!SCREENSHOT_ROLES.has(asText(screenshot.role))) {
              addIssue(errors, `${imagePath}.role`, "Выберите роль скриншота: «Было», «Стало», «Шаг» или «Схема».");
            }
            if (!/^data:image\/(?:png|jpe?g|webp);base64,/i.test(asText(screenshot.dataUrl))) {
              addIssue(errors, `${imagePath}.dataUrl`, "Данные скриншота недоступны. Добавьте файл повторно.");
            }
            if (!positiveNumber(screenshot.width) || !positiveNumber(screenshot.height)) {
              addIssue(warnings, imagePath, "Размер скриншота не определен; проверьте файл перед выгрузкой.");
            }
          });
        }
      });
    }

    if (!hasRequiredAfter) {
      addIssue(errors, "groups", "Опишите результат хотя бы в одном пункте «Стало».");
    }

    if (Object.prototype.hasOwnProperty.call(state, "support") && !isRecord(state.support)) {
      addIssue(warnings, "support", "Материалы для поддержки проигнорированы: ожидается объект.");
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  function stripImagesForStorage(state) {
    const stripped = deepClone(state);

    if (Array.isArray(stripped.groups)) {
      stripped.groups.forEach((group) => {
        if (!isRecord(group) || !Array.isArray(group.screenshots)) return;
        group.screenshots = group.screenshots.map((screenshot) => {
          if (!isRecord(screenshot)) return screenshot;
          const metadata = deepClone(screenshot);
          delete metadata.dataUrl;
          return metadata;
        });
      });
    }

    // Keep the legacy branches safe for callers that strip a draft before migrating it.
    if (Array.isArray(stripped.changes)) {
      stripped.changes.forEach((change) => {
        if (!isRecord(change) || !Array.isArray(change.screenshots)) return;
        change.screenshots = change.screenshots.map((screenshot) => {
          if (!isRecord(screenshot)) return screenshot;
          const metadata = deepClone(screenshot);
          delete metadata.dataUrl;
          return metadata;
        });
      });
    }

    if (Array.isArray(stripped.images)) {
      stripped.images = stripped.images.map((image) => {
        if (!isRecord(image)) return image;
        const metadata = deepClone(image);
        delete metadata.dataUrl;
        return metadata;
      });
    }

    return stripped;
  }

  function collectChannels(state) {
    const selected = new Set();
    if (isRecord(state) && Array.isArray(state.groups)) {
      state.groups.forEach((group) => {
        normalizeChannels(isRecord(group) ? group.channels : []).forEach((channel) => selected.add(channel));
      });
    } else if (isRecord(state) && Array.isArray(state.changes)) {
      state.changes.forEach((change) => {
        normalizeChannels(isRecord(change) ? change.channels : []).forEach((channel) => selected.add(channel));
      });
    } else if (isRecord(state)) {
      normalizeChannels(state.platforms).forEach((channel) => selected.add(channel));
    }
    return CHANNEL_ORDER.filter((channel) => selected.has(channel));
  }

  function pushExplicit(target, label, value) {
    const fact = toPlainText(value);
    if (!fact) return;
    const entry = label ? `${label}: ${fact}` : fact;
    const comparable = entry.toLocaleLowerCase("ru-RU").replace(/\s+/g, " ");
    if (!target.some((item) => item.comparable === comparable)) {
      target.push({ comparable, text: entry });
    }
  }

  function buildSafeSupportDraft(state) {
    const normalized = normalizeState(state);
    const existing = normalized.support;
    const say = [];
    const details = [];

    pushExplicit(say, "", existing.say);
    normalized.groups.forEach((group) => {
      group.items.forEach((item) => {
        pushExplicit(say, item.title || group.title || "Изменение", item.after);
        pushExplicit(say, "Действие пользователя", item.clientAction);
      });
    });

    pushExplicit(details, "Условия выката", normalized.rolloutConditions);
    normalized.groups.forEach((group) => {
      const groupPrefix = group.title ? `${group.title} — ` : "";
      pushExplicit(details, `${groupPrefix}где находится`, group.location);
      pushExplicit(details, `${groupPrefix}доступность`, group.availability);
      group.items.forEach((item) => {
        const itemTitle = item.title || group.title;
        const itemPrefix = itemTitle ? `${itemTitle} — ` : "";
        pushExplicit(details, `${itemPrefix}важно для поддержки`, item.supportNote);
      });
    });
    pushExplicit(details, "", existing.details);

    return {
      say: say.map((item) => item.text).join("\n\n"),
      dontSay: toPlainText(existing.dontSay),
      details: details.map((item) => item.text).join("\n\n"),
      faq: deepClone(existing.faq),
    };
  }

  function estimateReadableFilename(state, ext) {
    const source = isRecord(state) ? state : {};
    let groupTitle = "";
    let itemTitle = "";
    if (Array.isArray(source.groups)) {
      source.groups.forEach((group) => {
        if (!isRecord(group)) return;
        if (!groupTitle && hasText(group.title)) groupTitle = group.title;
        if (!itemTitle && Array.isArray(group.items)) {
          const titledItem = group.items.find((item) => isRecord(item) && hasText(item.title));
          if (titledItem) itemTitle = titledItem.title;
        }
      });
    }
    const firstChange = Array.isArray(source.changes) && isRecord(source.changes[0])
      ? source.changes[0]
      : {};
    const title = toPlainText(
      source.title || groupTitle || itemTitle || firstChange.title || "Инструкция"
    )
      .replace(/[\x00-\x1f<>:"/\\|?*]+/g, " ")
      .replace(/\s+/g, " ")
      .replace(/[. ]+$/g, "")
      .trim() || "Инструкция";
    const date = /^\d{4}-\d{2}-\d{2}$/.test(asText(source.releaseDate))
      ? asText(source.releaseDate)
      : "";
    let base = date ? `${date} — ${title}` : title;
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base)) base = `Документ ${base}`;
    base = base.slice(0, 120).replace(/[. ]+$/g, "") || "Инструкция";

    const extension = asText(ext)
      .replace(/^\.+/, "")
      .replace(/[^a-z0-9]+/gi, "")
      .toLowerCase();
    return extension ? `${base}.${extension}` : base;
  }

  const api = {
    normalizeState,
    migrateLegacy,
    validateState,
    stripImagesForStorage,
    collectChannels,
    buildSafeSupportDraft,
    estimateReadableFilename,
    deepClone,
  };

  root.SirenModel = api;
  if (typeof window !== "undefined") window.SirenModel = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
