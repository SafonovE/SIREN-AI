(function (global) {
  "use strict";

  const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  const EMU_PER_INCH = 914400;
  const PAGE_WIDTH_DXA = 9638;
  const FONT_FACE = "Arial";
  const COLORS = Object.freeze({
    ink: "151922",
    muted: "626B78",
    navy: "1F334D",
    red: "C7182F",
    darkRed: "8F1021",
    green: "0F766E",
    border: "D9D9D9",
    soft: "F6F8FA",
    before: "F3F6F9",
    after: "F1FAF7",
    warning: "A15C04",
    white: "FFFFFF"
  });

  function requireLibrary(name) {
    const value = global[name];
    if (!value) throw new Error(`${name} не загружен`);
    return value;
  }

  function asString(value) {
    if (value === null || value === undefined) return "";
    return String(value);
  }

  function hasText(value) {
    return plainText(value).trim().length > 0;
  }

  function escapeXml(value) {
    return asString(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  function normalizeHex(value) {
    const source = asString(value).trim().toLowerCase();
    const named = {
      black: "000000",
      white: "FFFFFF",
      red: "C7182F",
      green: "0F766E",
      blue: "1F5B8F",
      gray: "626B78",
      grey: "626B78"
    };
    if (named[source]) return named[source];
    const shortHex = source.match(/^#([0-9a-f]{3})$/i);
    if (shortHex) return shortHex[1].split("").map((char) => char + char).join("").toUpperCase();
    const fullHex = source.match(/^#?([0-9a-f]{6})$/i);
    if (fullHex) return fullHex[1].toUpperCase();
    const rgb = source.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i);
    if (rgb) {
      return rgb.slice(1, 4).map((part) => Math.min(255, Number(part)).toString(16).padStart(2, "0")).join("").toUpperCase();
    }
    return "";
  }

  function sameFormat(left, right) {
    return Boolean(left.bold) === Boolean(right.bold)
      && Boolean(left.italic) === Boolean(right.italic)
      && (left.color || "") === (right.color || "");
  }

  function pushRun(paragraph, text, format) {
    if (!text) return;
    let clean = asString(text).replace(/\u00a0/g, " ").replace(/[\t\f\v ]+/g, " ");
    if (!paragraph.runs.length) clean = clean.replace(/^ +/, "");
    const previous = paragraph.runs[paragraph.runs.length - 1];
    if (previous && / $/.test(previous.text) && /^ /.test(clean)) clean = clean.replace(/^ +/, "");
    if (!clean) return;
    const next = {
      text: clean,
      bold: Boolean(format && format.bold),
      italic: Boolean(format && format.italic),
      color: normalizeHex(format && format.color)
    };
    if (previous && sameFormat(previous, next)) previous.text += next.text;
    else paragraph.runs.push(next);
  }

  function parseRichWithDom(value) {
    const parser = new global.DOMParser();
    const parsed = parser.parseFromString(`<body>${asString(value)}</body>`, "text/html");
    const root = parsed.body;
    const paragraphs = [];
    let current = { bullet: false, runs: [] };

    function flush(force) {
      while (current.runs.length && /^\s*$/.test(current.runs[current.runs.length - 1].text)) current.runs.pop();
      if (current.runs.length || force) paragraphs.push(current);
      current = { bullet: false, runs: [] };
    }

    function visit(node, format, listDepth) {
      if (node.nodeType === 3) {
        const pieces = asString(node.nodeValue).split(/\r?\n/);
        pieces.forEach((piece, index) => {
          if (piece.trim() || current.runs.length) pushRun(current, piece, format);
          if (index < pieces.length - 1 && current.runs.length) flush(false);
        });
        return;
      }
      if (node.nodeType !== 1) return;
      const tag = node.tagName.toLowerCase();
      if (tag === "script" || tag === "style" || tag === "noscript") return;
      if (tag === "br") {
        flush(false);
        return;
      }

      const next = { ...format };
      if (tag === "strong" || tag === "b") next.bold = true;
      if (tag === "em" || tag === "i") next.italic = true;
      if (tag === "span") {
        const styleColor = node.style && node.style.color;
        const attributeColor = node.getAttribute("color");
        const color = normalizeHex(styleColor || attributeColor);
        if (color) next.color = color;
      }

      const isList = tag === "ul" || tag === "ol";
      const isItem = tag === "li";
      const isBlock = /^(p|div|section|article|header|footer|h[1-6]|blockquote|pre)$/.test(tag);
      if ((isList || isItem || isBlock) && current.runs.length) flush(false);
      if (isItem) current.bullet = true;
      Array.from(node.childNodes).forEach((child) => visit(child, next, isList ? listDepth + 1 : listDepth));
      if ((isList || isItem || isBlock) && current.runs.length) flush(false);
    }

    Array.from(root.childNodes).forEach((node) => visit(node, {}, 0));
    if (current.runs.length) flush(false);
    return paragraphs.filter((paragraph) => paragraph.runs.some((run) => run.text.trim()));
  }

  function parseRichFallback(value) {
    let source = asString(value);
    source = source
      .replace(/<\s*(script|style|noscript)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
      .replace(/<\s*li[^>]*>/gi, "\n- ")
      .replace(/<\s*br\s*\/?>/gi, "\n")
      .replace(/<\s*\/?\s*(p|div|section|article|h[1-6]|ul|ol|blockquote|pre)[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, "\"")
      .replace(/&#39;|&apos;/gi, "'");
    return source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
      const bullet = /^[-*•]\s+/.test(line);
      const text = bullet ? line.replace(/^[-*•]\s+/, "") : line;
      return { bullet, runs: [{ text, bold: false, italic: false, color: "" }] };
    });
  }

  function parseRich(value) {
    if (!hasRawText(value)) return [];
    if (typeof global.DOMParser === "function") {
      try {
        return parseRichWithDom(value);
      } catch (error) {
        console.warn("Не удалось разобрать форматирование, использован простой текст", error);
      }
    }
    return parseRichFallback(value);
  }

  function hasRawText(value) {
    return value !== null && value !== undefined && asString(value).trim() !== "";
  }

  function plainText(value) {
    return parseRich(value).map((paragraph) => paragraph.runs.map((run) => run.text).join("")).join("\n");
  }

  function cloneRuns(runs) {
    return (runs || []).map((run) => ({ ...run }));
  }

  function cloneParagraph(paragraph) {
    return { bullet: Boolean(paragraph && paragraph.bullet), runs: cloneRuns(paragraph && paragraph.runs) };
  }

  function normalizeFaq(value) {
    if (!value) return [];
    if (Array.isArray(value)) {
      return value.map((item, index) => {
        if (typeof item === "string") return { question: "", answer: item };
        return {
          question: asString(item && (item.question || item.q || item.title)),
          answer: asString(item && (item.answer || item.a || item.text))
        };
      }).filter((item) => hasText(item.question) || hasText(item.answer));
    }
    if (typeof value === "object") {
      return Object.keys(value).map((question) => ({ question, answer: asString(value[question]) }));
    }
    return [{ question: "", answer: asString(value) }];
  }

  function normalizeChannels(value) {
    const labels = { ios: "iOS", android: "Android", web: "веб-ЛК" };
    if (Array.isArray(value)) return value.map((item) => {
      const channel = plainText(item).trim();
      return labels[channel.toLowerCase()] || channel;
    }).filter(Boolean);
    const text = plainText(value).trim();
    return text ? text.split(/[,;\n]+/).map((item) => {
      const channel = item.trim();
      return labels[channel.toLowerCase()] || channel;
    }).filter(Boolean) : [];
  }

  function normalizeRole(value) {
    const role = asString(value).trim().toLowerCase();
    if (/^(before|было|до|old)$/.test(role)) return "before";
    if (/^(after|стало|после|new)$/.test(role)) return "after";
    if (/^(step|шаг|process)$/.test(role)) return "step";
    if (/^(scheme|схема|diagram)$/.test(role)) return "scheme";
    if (/^(result|результат)$/.test(role)) return "result";
    return role;
  }

  function roleLabel(value) {
    const role = normalizeRole(value);
    if (role === "before") return "Как было";
    if (role === "after") return "Как стало";
    if (role === "step") return "Шаг";
    if (role === "scheme") return "Схема";
    if (role === "result") return "Результат";
    return "";
  }

  function normalizeScreenshot(value, fallbackId) {
    const image = value && typeof value === "object" ? value : {};
    return {
      id: asString(image.id || fallbackId),
      role: normalizeRole(image.role || image.type),
      title: asString(image.title),
      caption: asString(image.caption || image.description),
      dataUrl: asString(image.dataUrl),
      width: Math.max(0, Number(image.width) || 0),
      height: Math.max(0, Number(image.height) || 0),
      layout: image.layout === "full" ? "full" : "half"
    };
  }

  function normalizeItem(value, fallbackId) {
    const item = value && typeof value === "object" ? value : {};
    return {
      id: asString(item.id || fallbackId),
      title: asString(item.title),
      before: asString(item.before),
      after: asString(item.after),
      clientAction: asString(item.clientAction || item.action),
      supportNote: asString(item.supportNote || item.note)
    };
  }

  function legacyGroups(source) {
    const changes = Array.isArray(source.changes) ? source.changes : [];
    return changes.map((change, changeIndex) => {
      const item = change && typeof change === "object" ? change : {};
      const id = asString(item.id || `group-${changeIndex + 1}`);
      return {
        id,
        title: asString(item.title),
        channels: item.channels,
        location: asString(item.location),
        availability: asString(item.availability),
        items: [{
          id: `${id}-item-1`,
          title: "",
          before: asString(item.before),
          after: asString(item.after),
          clientAction: asString(item.clientAction),
          supportNote: asString(item.supportNote)
        }],
        screenshots: Array.isArray(item.screenshots) ? item.screenshots : []
      };
    });
  }

  function normalizeState(input) {
    const source = input && typeof input === "object" ? input : {};
    const groups = Array.isArray(source.groups) ? source.groups : legacyGroups(source);
    return {
      title: asString(source.title),
      releaseDate: asString(source.releaseDate),
      rolloutMode: asString(source.rolloutMode),
      rolloutConditions: asString(source.rolloutConditions),
      groups: groups.map((group, groupIndex) => {
        const sourceGroup = group && typeof group === "object" ? group : {};
        const groupId = asString(sourceGroup.id || `group-${groupIndex + 1}`);
        let items = Array.isArray(sourceGroup.items) ? sourceGroup.items : [];
        if (!items.length && ["before", "after", "clientAction", "supportNote", "action", "note"].some((key) => Object.prototype.hasOwnProperty.call(sourceGroup, key))) {
          items = [sourceGroup];
        }
        const screenshots = Array.isArray(sourceGroup.screenshots) ? sourceGroup.screenshots : [];
        return {
          id: groupId,
          title: asString(sourceGroup.title),
          channels: normalizeChannels(sourceGroup.channels),
          location: asString(sourceGroup.location),
          availability: asString(sourceGroup.availability),
          items: items.map((item, itemIndex) => normalizeItem(item, `${groupId}-item-${itemIndex + 1}`)),
          screenshots: screenshots.map((screenshot, screenshotIndex) => normalizeScreenshot(screenshot, `${groupId}-screen-${screenshotIndex + 1}`))
        };
      }),
      support: {
        say: asString(source.support && source.support.say),
        dontSay: asString(source.support && source.support.dontSay),
        details: asString(source.support && source.support.details),
        faq: normalizeFaq(source.support && source.support.faq)
      },
      legacyScreenshots: Array.isArray(source.screenshots) ? source.screenshots : []
    };
  }

  function itemHasContent(item) {
    return hasText(item && item.before)
      || hasText(item && item.after)
      || hasText(item && item.clientAction)
      || hasText(item && item.supportNote);
  }

  function groupHasContent(group) {
    return Boolean(group && group.channels && group.channels.length)
      || hasText(group && group.location)
      || hasText(group && group.availability)
      || Boolean(group && group.items && group.items.some(itemHasContent))
      || Boolean(group && group.screenshots && group.screenshots.some((image) => /^data:image\//i.test(image.dataUrl)));
  }

  function formatDate(value) {
    const source = asString(value).trim();
    const match = source.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return match ? `${match[3]}.${match[2]}.${match[1]}` : source;
  }

  function collectWarnings(input) {
    const source = input && typeof input === "object" ? input : {};
    const state = normalizeState(source);
    const warnings = [];
    const seenScreenshotIds = new Set();

    function add(code, path, message, severity) {
      warnings.push({ code, path, message, severity: severity || "warning" });
    }

    function tooLong(path, value, limit, label) {
      const length = plainText(value).length;
      if (length > limit) add("long_field", path, `Поле «${label}» содержит ${length} знаков. Рекомендуемый максимум: ${limit}`);
    }

    if (!hasText(state.title)) add("empty_field", "title", "Добавьте название инструкции", "error");
    tooLong("title", state.title, 120, "Название инструкции");
    tooLong("rolloutConditions", state.rolloutConditions, 2500, "Условия выката");

    const conditionText = plainText(state.rolloutConditions);
    if (conditionText && /(tbd|todo|уточнить|не подтвержден|не согласован|предварительн|черновик|\?{2,}|\[[^\]]*(?:дата|услов|уточ)[^\]]*\])/i.test(conditionText)) {
      add("unconfirmed_conditions", "rolloutConditions", "Условия выката выглядят неподтвержденными. Проверьте дату, долю аудитории и ограничения");
    }

    let hasRequiredAfter = false;
    if (!state.groups.length) add("empty_groups", "groups", "Добавьте хотя бы одну группу изменений", "error");
    state.groups.forEach((group, groupIndex) => {
      const base = `groups[${groupIndex}]`;
      tooLong(`${base}.title`, group.title, 140, "Название экрана или сценария");
      tooLong(`${base}.location`, group.location, 1800, "Путь к изменению");
      tooLong(`${base}.availability`, group.availability, 1800, "Условия доступности");

      const availabilityText = plainText(group.availability);
      if (availabilityText && /(tbd|todo|уточнить|не подтвержден|не согласован|предварительн|\?{2,}|\[[^\]]*(?:дата|услов|уточ)[^\]]*\])/i.test(availabilityText)) {
        add("unconfirmed_conditions", `${base}.availability`, "Условия доступности выглядят неподтвержденными");
      }

      group.items.forEach((item, itemIndex) => {
        const itemPath = `${base}.items[${itemIndex}]`;
        if (hasText(item.after)) hasRequiredAfter = true;
        tooLong(`${itemPath}.title`, item.title, 140, "Название пункта");
        tooLong(`${itemPath}.before`, item.before, 3500, "Как было");
        tooLong(`${itemPath}.after`, item.after, 3500, "Как стало");
        tooLong(`${itemPath}.clientAction`, item.clientAction, 2500, "Действие пользователя");
        tooLong(`${itemPath}.supportNote`, item.supportNote, 2500, "Нюанс для поддержки");
      });

      group.screenshots.forEach((screenshot, screenshotIndex) => {
        const imagePath = `${base}.screenshots[${screenshotIndex}]`;
        if (!screenshot.dataUrl || !/^data:image\//i.test(screenshot.dataUrl)) {
          add("invalid_screenshot", `${imagePath}.dataUrl`, "У скриншота нет корректных данных изображения", "error");
        }
        if (!screenshot.role || screenshot.role === "other") {
          add("unlinked_screenshot", `${imagePath}.role`, "Укажите роль скриншота: «Было», «Стало», «Шаг» или «Результат»");
        }
        if (seenScreenshotIds.has(screenshot.id)) {
          add("duplicate_screenshot", `${imagePath}.id`, "Идентификатор скриншота повторяется");
        }
        seenScreenshotIds.add(screenshot.id);
        if (!screenshot.width || !screenshot.height) {
          add("unknown_image_size", imagePath, "Не определены размеры скриншота. При экспорте будет использовано соотношение 16:9");
        }
        tooLong(`${imagePath}.title`, screenshot.title, 140, "Название скриншота");
        tooLong(`${imagePath}.caption`, screenshot.caption, 600, "Подпись скриншота");
      });
    });

    if (!hasRequiredAfter) add("empty_after", "groups", "Опишите результат хотя бы в одном пункте «Как стало»", "error");

    state.legacyScreenshots.forEach((screenshot, index) => {
      add("unlinked_screenshot", `screenshots[${index}]`, "Скриншот находится вне карточки изменения и не попадет в редактируемый экспорт");
    });

    tooLong("support.say", state.support.say, 5000, "Что можно говорить");
    tooLong("support.dontSay", state.support.dontSay, 5000, "Что не обещать");
    tooLong("support.details", state.support.details, 7000, "Дополнительные детали");
    state.support.faq.forEach((item, index) => {
      tooLong(`support.faq[${index}].question`, item.question, 300, "Вопрос FAQ");
      tooLong(`support.faq[${index}].answer`, item.answer, 3000, "Ответ FAQ");
    });
    return warnings;
  }

  function validateState(input) {
    const issues = collectWarnings(input);
    return {
      valid: !issues.some((issue) => issue.severity === "error"),
      errors: issues.filter((issue) => issue.severity === "error"),
      warnings: issues.filter((issue) => issue.severity !== "error")
    };
  }

  function docRunXml(run, defaults) {
    const options = defaults || {};
    const properties = [];
    if (run.bold || options.bold) properties.push("<w:b/><w:bCs/>");
    if (run.italic || options.italic) properties.push("<w:i/><w:iCs/>");
    const color = normalizeHex(run.color || options.color);
    if (color) properties.push(`<w:color w:val="${color}"/>`);
    if (options.size) properties.push(`<w:sz w:val="${options.size}"/><w:szCs w:val="${options.size}"/>`);
    return `<w:r>${properties.length ? `<w:rPr>${properties.join("")}</w:rPr>` : ""}<w:t xml:space="preserve">${escapeXml(run.text)}</w:t></w:r>`;
  }

  function docParagraphXml(paragraph, style, options) {
    const config = options || {};
    const properties = [];
    if (style) properties.push(`<w:pStyle w:val="${style}"/>`);
    if (config.keepNext) properties.push("<w:keepNext/>");
    if (config.keepLines) properties.push("<w:keepLines/>");
    if (config.pageBreakBefore) properties.push("<w:pageBreakBefore/>");
    if (paragraph && paragraph.bullet) {
      properties.push('<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>');
    }
    if (config.before !== undefined || config.after !== undefined) {
      properties.push(`<w:spacing w:before="${config.before || 0}" w:after="${config.after === undefined ? 120 : config.after}"/>`);
    }
    if (config.align) properties.push(`<w:jc w:val="${config.align}"/>`);
    const runs = paragraph && paragraph.runs && paragraph.runs.length
      ? paragraph.runs.map((run) => docRunXml(run, config)).join("")
      : '<w:r><w:t xml:space="preserve"></w:t></w:r>';
    return `<w:p><w:pPr>${properties.join("")}</w:pPr>${runs}</w:p>`;
  }

  function docPlainParagraph(text, style, options) {
    return docParagraphXml({ bullet: false, runs: [{ text: asString(text) }] }, style || "Normal", options);
  }

  function docRichBlocks(value, style, options) {
    return parseRich(value).map((paragraph) => docParagraphXml(paragraph, paragraph.bullet ? "ListParagraph" : (style || "Normal"), options));
  }

  function docHeading(text, level, options) {
    const style = level === 1 ? "Heading1" : level === 2 ? "Heading2" : "Heading3";
    return docPlainParagraph(text, style, { ...(options || {}), keepNext: true, keepLines: true });
  }

  function docCellMargins(value) {
    return `<w:tcMar><w:top w:w="${value}" w:type="dxa"/><w:left w:w="${value}" w:type="dxa"/><w:bottom w:w="${value}" w:type="dxa"/><w:right w:w="${value}" w:type="dxa"/></w:tcMar>`;
  }

  function docBorders(color) {
    const shade = color || COLORS.border;
    return `<w:tblBorders><w:top w:val="single" w:sz="6" w:color="${shade}"/><w:left w:val="single" w:sz="6" w:color="${shade}"/><w:bottom w:val="single" w:sz="6" w:color="${shade}"/><w:right w:val="single" w:sz="6" w:color="${shade}"/><w:insideH w:val="single" w:sz="4" w:color="${shade}"/><w:insideV w:val="single" w:sz="4" w:color="${shade}"/></w:tblBorders>`;
  }

  function docMetaTable(rows) {
    const clean = rows.filter((row) => hasText(row[1]));
    if (!clean.length) return "";
    const labelWidth = 2450;
    const valueWidth = PAGE_WIDTH_DXA - labelWidth;
    const rowXml = clean.map(([label, value]) => {
      const valueBlocks = docRichBlocks(value, "TableText").join("") || docPlainParagraph("", "TableText");
      return `<w:tr><w:trPr><w:cantSplit/></w:trPr><w:tc><w:tcPr><w:tcW w:w="${labelWidth}" w:type="dxa"/><w:shd w:val="clear" w:fill="EEF1F4"/>${docCellMargins(120)}</w:tcPr>${docPlainParagraph(label, "TableLabel")}</w:tc><w:tc><w:tcPr><w:tcW w:w="${valueWidth}" w:type="dxa"/>${docCellMargins(120)}</w:tcPr>${valueBlocks}</w:tc></w:tr>`;
    }).join("");
    return `<w:tbl><w:tblPr><w:tblW w:w="${PAGE_WIDTH_DXA}" w:type="dxa"/>${docBorders()}<w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid><w:gridCol w:w="${labelWidth}"/><w:gridCol w:w="${valueWidth}"/></w:tblGrid>${rowXml}</w:tbl>`;
  }

  function docComparisonTable(before, after) {
    const columnWidth = Math.floor(PAGE_WIDTH_DXA / 2);
    const header = `<w:tr><w:trPr><w:cantSplit/></w:trPr>${docHeaderCell("Как было", columnWidth, COLORS.navy, "E9EEF3")}${docHeaderCell("Как стало", PAGE_WIDTH_DXA - columnWidth, COLORS.green, "E5F5F0")}</w:tr>`;
    const beforeBlocks = docRichBlocks(before, "Normal").join("");
    const afterBlocks = docRichBlocks(after, "Normal").join("");
    const content = `<w:tr>${docContentCell(beforeBlocks, columnWidth, COLORS.before)}${docContentCell(afterBlocks, PAGE_WIDTH_DXA - columnWidth, COLORS.after)}</w:tr>`;
    return `<w:tbl><w:tblPr><w:tblW w:w="${PAGE_WIDTH_DXA}" w:type="dxa"/>${docBorders()}<w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid><w:gridCol w:w="${columnWidth}"/><w:gridCol w:w="${PAGE_WIDTH_DXA - columnWidth}"/></w:tblGrid>${header}${content}</w:tbl>`;
  }

  function docHeaderCell(text, width, color, fill) {
    return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/><w:shd w:val="clear" w:fill="${fill}"/>${docCellMargins(130)}</w:tcPr>${docPlainParagraph(text, "TableHeading", { color, after: 0, keepNext: true })}</w:tc>`;
  }

  function docContentCell(content, width, fill) {
    return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/><w:shd w:val="clear" w:fill="${fill}"/>${docCellMargins(150)}</w:tcPr>${content}</w:tc>`;
  }

  function fitContain(width, height, ratio) {
    const safeRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : 16 / 9;
    let fittedWidth = width;
    let fittedHeight = fittedWidth / safeRatio;
    if (fittedHeight > height) {
      fittedHeight = height;
      fittedWidth = fittedHeight * safeRatio;
    }
    return {
      x: (width - fittedWidth) / 2,
      y: (height - fittedHeight) / 2,
      width: fittedWidth,
      height: fittedHeight
    };
  }

  function docImageDrawing(image, relId, drawingId) {
    const ratio = image.width && image.height ? image.width / image.height : 16 / 9;
    const maxWidth = 6.55 * EMU_PER_INCH;
    const maxHeight = 5.9 * EMU_PER_INCH;
    const fit = fitContain(maxWidth, maxHeight, ratio);
    const width = Math.round(fit.width);
    const height = Math.round(fit.height);
    const name = plainText(image.title).trim() || roleLabel(image.role) || `Image ${drawingId}`;
    const description = plainText(image.caption || image.title || roleLabel(image.role)).slice(0, 240);
    return `<w:p><w:pPr><w:keepLines/><w:spacing w:before="80" w:after="100"/><w:jc w:val="center"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${width}" cy="${height}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${drawingId}" name="${escapeXml(name)}" descr="${escapeXml(description)}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${drawingId}" name="${escapeXml(name)}" descr="${escapeXml(description)}"/><pic:cNvPicPr><a:picLocks noChangeAspect="1"/></pic:cNvPicPr></pic:nvPicPr><pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${width}" cy="${height}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
  }

  function docScreenshotTable(image, relId, drawingId) {
    const role = roleLabel(image.role);
    const imageTitle = plainText(image.title).trim();
    const title = role && imageTitle ? `${role}. ${imageTitle}` : (role || imageTitle);
    const titleBlock = title
      ? docPlainParagraph(title, "TableHeading", { keepNext: true, after: 60, color: image.role === "after" ? COLORS.green : COLORS.navy })
      : "";
    const caption = hasText(image.caption) ? docRichBlocks(image.caption, "Caption").join("") : "";
    return `<w:tbl><w:tblPr><w:tblW w:w="${PAGE_WIDTH_DXA}" w:type="dxa"/>${docBorders()}<w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid><w:gridCol w:w="${PAGE_WIDTH_DXA}"/></w:tblGrid><w:tr><w:trPr><w:cantSplit/></w:trPr><w:tc><w:tcPr><w:tcW w:w="${PAGE_WIDTH_DXA}" w:type="dxa"/><w:shd w:val="clear" w:fill="FFFFFF"/>${docCellMargins(140)}</w:tcPr>${titleBlock}${docImageDrawing(image, relId, drawingId)}${caption}</w:tc></w:tr></w:tbl>${docPlainParagraph("", "Normal", { after: 80 })}`;
  }

  function dataUrlParts(dataUrl) {
    const match = asString(dataUrl).match(/^data:([^;,]+)(;base64)?,([\s\S]*)$/i);
    if (!match || !/^image\//i.test(match[1])) return null;
    const mime = match[1].toLowerCase();
    let bytes;
    if (match[2]) {
      const binary = global.atob(match[3].replace(/\s/g, ""));
      bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    } else {
      bytes = new TextEncoder().encode(decodeURIComponent(match[3]));
    }
    const extensions = {
      "image/png": "png",
      "image/jpeg": "jpeg",
      "image/jpg": "jpg",
      "image/gif": "gif",
      "image/bmp": "bmp",
      "image/webp": "webp",
      "image/svg+xml": "svg"
    };
    return { mime, extension: extensions[mime] || "png", bytes };
  }

  function flattenScreenshots(state) {
    const images = [];
    state.groups.forEach((group, groupIndex) => {
      group.screenshots.forEach((screenshot, screenshotIndex) => {
        const decoded = dataUrlParts(screenshot.dataUrl);
        if (!decoded) return;
        images.push({
          ...screenshot,
          groupIndex,
          screenshotIndex,
          mediaIndex: images.length + 1,
          relId: `rIdImage${images.length + 1}`,
          mediaName: `image${images.length + 1}.${decoded.extension}`,
          mime: decoded.mime,
          bytes: decoded.bytes
        });
      });
    });
    return images;
  }

  function docBodyXml(state, images) {
    const body = [];
    const title = plainText(state.title).trim();
    if (title) body.push(docPlainParagraph(title, "Title", { keepNext: true }));
    const releaseMeta = docMetaTable([
      ["Дата изменения", formatDate(state.releaseDate)],
      ["Формат выката", state.rolloutMode]
    ]);
    if (releaseMeta) body.push(releaseMeta);

    if (hasText(state.rolloutConditions)) {
      body.push(docHeading("Условия выката", 1));
      body.push(...docRichBlocks(state.rolloutConditions, "Normal"));
    }

    const visibleGroups = state.groups.filter(groupHasContent);
    visibleGroups.forEach((group, visibleGroupIndex) => {
      const groupTitle = plainText(group.title).trim();
      if (groupTitle) {
        body.push(docHeading(groupTitle, 1, { pageBreakBefore: visibleGroupIndex > 0 }));
      }
      const groupMeta = docMetaTable([
        ["Канал", group.channels.join(", ")],
        ["Где находится", group.location],
        ["Когда и кому доступно", group.availability]
      ]);
      if (groupMeta) body.push(groupMeta);

      const visibleItems = group.items.filter(itemHasContent);
      visibleItems.forEach((item, itemIndex) => {
        const itemTitle = plainText(item.title).trim();
        if (itemTitle) body.push(docHeading(`${itemIndex + 1}. ${itemTitle}`, 2));

        const hasBefore = hasText(item.before);
        const hasAfter = hasText(item.after);
        if (hasBefore && hasAfter) {
          body.push(docComparisonTable(item.before, item.after));
        } else if (hasBefore) {
          body.push(docHeading("Как было", 3));
          body.push(...docRichBlocks(item.before, "Normal"));
        } else if (hasAfter) {
          body.push(docHeading("Как стало", 3));
          body.push(...docRichBlocks(item.after, "Normal"));
        }
        if (hasText(item.clientAction)) {
          body.push(docHeading("Что делает пользователь", 3));
          body.push(...docRichBlocks(item.clientAction, "Normal"));
        }
        if (hasText(item.supportNote)) {
          body.push(docHeading("Что важно для поддержки", 3));
          body.push(...docRichBlocks(item.supportNote, "Normal"));
        }
      });

      const sourceGroupIndex = state.groups.indexOf(group);
      const linkedImages = images.filter((image) => image.groupIndex === sourceGroupIndex);
      if (linkedImages.length) {
        body.push(docHeading("Связанные скриншоты", 2));
        linkedImages.forEach((image) => {
          body.push(docScreenshotTable(image, image.relId, 100 + image.mediaIndex));
        });
      }
    });

    const supportHasContent = hasText(state.support.say)
      || hasText(state.support.dontSay)
      || hasText(state.support.details)
      || state.support.faq.some((item) => hasText(item.question) || hasText(item.answer));
    if (supportHasContent) body.push(docHeading("Материалы для коллег", 1, { pageBreakBefore: visibleGroups.length > 0 }));
    if (hasText(state.support.say)) {
      body.push(docHeading("Что можно говорить клиенту", 2));
      body.push(...docRichBlocks(state.support.say, "Normal"));
    }
    if (hasText(state.support.dontSay)) {
      body.push(docHeading("Чего не обещать", 2));
      body.push(...docRichBlocks(state.support.dontSay, "Normal"));
    }
    if (hasText(state.support.details)) {
      body.push(docHeading("Дополнительные детали", 2));
      body.push(...docRichBlocks(state.support.details, "Normal"));
    }
    const visibleFaq = state.support.faq.filter((item) => hasText(item.question) || hasText(item.answer));
    if (visibleFaq.length) {
      body.push(docHeading("Частые вопросы", 2));
      visibleFaq.forEach((item) => {
        if (hasText(item.question)) body.push(docHeading(plainText(item.question).trim(), 3));
        if (hasText(item.answer)) body.push(...docRichBlocks(item.answer, "Normal"));
      });
    }
    return body.join("");
  }

  function xmlDeclaration() {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  }

  function docDocumentXml(body) {
    return xmlDeclaration() + `<w:document xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:w10="urn:schemas-microsoft-com:office:word" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup" xmlns:wpi="http://schemas.microsoft.com/office/word/2010/wordprocessingInk" xmlns:wne="http://schemas.microsoft.com/office/word/2006/wordml" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" mc:Ignorable="w14 wp14"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  }

  function docStylesXml() {
    function style(id, name, paragraphProperties, runProperties) {
      return `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:qFormat/>${paragraphProperties ? `<w:pPr>${paragraphProperties}</w:pPr>` : ""}${runProperties ? `<w:rPr>${runProperties}</w:rPr>` : ""}</w:style>`;
    }
    const font = `<w:rFonts w:ascii="${FONT_FACE}" w:hAnsi="${FONT_FACE}" w:cs="${FONT_FACE}"/>`;
    const run = (extra, color, size) => `${font}${extra || ""}${color ? `<w:color w:val="${color}"/>` : ""}${size ? `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>` : ""}`;
    return xmlDeclaration() + `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr>${run("", COLORS.ink, 22)}</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:widowControl/><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>${style("Normal", "Normal", "", "")}${style("Title", "Title", '<w:keepNext/><w:spacing w:after="180"/>', run("<w:b/>", "000000", 40))}${style("Subtitle", "Subtitle", '<w:keepNext/><w:spacing w:after="220"/>', run("<w:i/>", COLORS.muted, 22))}${style("Heading1", "heading 1", '<w:keepNext/><w:keepLines/><w:spacing w:before="260" w:after="120"/><w:outlineLvl w:val="0"/>', run("<w:b/>", "000000", 30))}${style("Heading2", "heading 2", '<w:keepNext/><w:keepLines/><w:spacing w:before="200" w:after="100"/><w:outlineLvl w:val="1"/>', run("<w:b/>", "000000", 25))}${style("Heading3", "heading 3", '<w:keepNext/><w:keepLines/><w:spacing w:before="160" w:after="80"/><w:outlineLvl w:val="2"/>', run("<w:b/>", "000000", 23))}${style("ListParagraph", "List Paragraph", '<w:ind w:left="720" w:hanging="360"/>', "")}${style("Muted", "Muted", "", `<w:i/><w:color w:val="${COLORS.muted}"/>`)}${style("TableLabel", "Table Label", '<w:spacing w:after="0"/>', `<w:b/><w:sz w:val="20"/><w:szCs w:val="20"/>`)}${style("TableText", "Table Text", '<w:spacing w:after="0"/>', '<w:sz w:val="20"/><w:szCs w:val="20"/>')}${style("TableHeading", "Table Heading", '<w:keepNext/><w:spacing w:after="0"/>', '<w:b/><w:sz w:val="22"/><w:szCs w:val="22"/>')}${style("Caption", "Caption", '<w:keepLines/><w:spacing w:before="60" w:after="20"/>', `<w:color w:val="${COLORS.muted}"/><w:sz w:val="19"/><w:szCs w:val="19"/>`)}</w:styles>`;
  }

  function docNumberingXml() {
    return xmlDeclaration() + `<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:tabs><w:tab w:val="num" w:pos="720"/></w:tabs><w:ind w:left="720" w:hanging="360"/></w:pPr><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:hint="default"/></w:rPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;
  }

  function docSettingsXml() {
    return xmlDeclaration() + '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:zoom w:percent="100"/><w:defaultTabStop w:val="720"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>';
  }

  function relationship(id, type, target) {
    return `<Relationship Id="${escapeXml(id)}" Type="${escapeXml(type)}" Target="${escapeXml(target)}"/>`;
  }

  function docRelationshipsXml(images) {
    const rels = [
      relationship("rIdStyles", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles", "styles.xml"),
      relationship("rIdSettings", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings", "settings.xml"),
      relationship("rIdNumbering", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering", "numbering.xml")
    ];
    images.forEach((image) => {
      rels.push(relationship(image.relId, "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image", `media/${image.mediaName}`));
    });
    return xmlDeclaration() + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`;
  }

  function rootRelationshipsXml() {
    return xmlDeclaration() + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationship("rId1", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument", "word/document.xml")}${relationship("rId2", "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties", "docProps/core.xml")}${relationship("rId3", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties", "docProps/app.xml")}</Relationships>`;
  }

  function docContentTypesXml(images) {
    const defaults = new Map([
      ["rels", "application/vnd.openxmlformats-package.relationships+xml"],
      ["xml", "application/xml"]
    ]);
    images.forEach((image) => defaults.set(image.mediaName.split(".").pop(), image.mime));
    const defaultXml = Array.from(defaults.entries()).map(([extension, type]) => `<Default Extension="${escapeXml(extension)}" ContentType="${escapeXml(type)}"/>`).join("");
    return xmlDeclaration() + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${defaultXml}<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;
  }

  function corePropertiesXml(title) {
    const now = new Date().toISOString();
    return xmlDeclaration() + `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escapeXml(title)}</dc:title><dc:creator>Siren</dc:creator><cp:lastModifiedBy>Siren</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`;
  }

  function appPropertiesXml() {
    return xmlDeclaration() + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Siren</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop><Company></Company><LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc><HyperlinksChanged>false</HyperlinksChanged><AppVersion>4.0</AppVersion></Properties>';
  }

  async function buildDocx(input) {
    const JSZip = requireLibrary("JSZip");
    const state = normalizeState(input);
    const images = flattenScreenshots(state);
    const zip = new JSZip();
    const title = plainText(state.title).trim();
    zip.file("[Content_Types].xml", docContentTypesXml(images));
    zip.file("_rels/.rels", rootRelationshipsXml());
    zip.file("docProps/core.xml", corePropertiesXml(title));
    zip.file("docProps/app.xml", appPropertiesXml());
    zip.file("word/document.xml", docDocumentXml(docBodyXml(state, images)));
    zip.file("word/_rels/document.xml.rels", docRelationshipsXml(images));
    zip.file("word/styles.xml", docStylesXml());
    zip.file("word/settings.xml", docSettingsXml());
    zip.file("word/numbering.xml", docNumberingXml());
    images.forEach((image) => zip.file(`word/media/${image.mediaName}`, image.bytes));
    const output = await zip.generateAsync({ type: "blob", mimeType: DOCX_MIME, compression: "DEFLATE", compressionOptions: { level: 6 } });
    return output instanceof Blob ? output : new Blob([output], { type: DOCX_MIME });
  }

  function paragraphText(paragraph) {
    return (paragraph.runs || []).map((run) => run.text).join("");
  }

  function lineCapacity(width, fontSize) {
    return Math.max(12, Math.floor((width * 72) / (Math.max(11, fontSize) * 0.54)));
  }

  function lineBudget(height, fontSize) {
    return Math.max(1, Math.floor((height * 72) / (Math.max(11, fontSize) * 1.28)));
  }

  function paragraphLineCost(paragraph, width, fontSize) {
    const capacity = lineCapacity(width, fontSize);
    const length = Math.max(1, paragraphText(paragraph).length + (paragraph.bullet ? 4 : 0));
    return Math.max(1, Math.ceil(length / capacity)) + 0.35;
  }

  function sliceRuns(runs, start, end) {
    const result = [];
    let offset = 0;
    runs.forEach((run) => {
      const runStart = offset;
      const runEnd = offset + run.text.length;
      offset = runEnd;
      const from = Math.max(start, runStart);
      const to = Math.min(end, runEnd);
      if (to <= from) return;
      result.push({ ...run, text: run.text.slice(from - runStart, to - runStart) });
    });
    return result;
  }

  function splitParagraph(paragraph, maximumCharacters) {
    const text = paragraphText(paragraph);
    if (text.length <= maximumCharacters) return [cloneParagraph(paragraph)];
    const parts = [];
    let start = 0;
    while (start < text.length) {
      let end = Math.min(text.length, start + maximumCharacters);
      if (end < text.length) {
        const candidate = text.lastIndexOf(" ", end);
        if (candidate > start + Math.floor(maximumCharacters * 0.55)) end = candidate + 1;
      }
      const runs = sliceRuns(paragraph.runs, start, end);
      if (runs.length) {
        runs[0].text = runs[0].text.replace(/^ +/, "");
        runs[runs.length - 1].text = runs[runs.length - 1].text.replace(/ +$/, "");
      }
      parts.push({ bullet: parts.length === 0 && paragraph.bullet, runs: runs.filter((run) => run.text) });
      start = end;
      while (text[start] === " ") start += 1;
    }
    return parts.filter((part) => part.runs.length);
  }

  function paginateParagraphs(paragraphs, width, height, fontSize) {
    const budget = lineBudget(height, fontSize);
    const capacity = lineCapacity(width, fontSize);
    const expanded = [];
    paragraphs.forEach((paragraph) => {
      const maximumCharacters = Math.max(capacity, Math.floor(capacity * Math.max(1, budget - 0.7)));
      expanded.push(...splitParagraph(paragraph, maximumCharacters));
    });
    const pages = [];
    let page = [];
    let used = 0;
    expanded.forEach((paragraph) => {
      const cost = paragraphLineCost(paragraph, width, fontSize);
      if (page.length && used + cost > budget) {
        pages.push(page);
        page = [];
        used = 0;
      }
      page.push(paragraph);
      used += cost;
    });
    if (page.length) pages.push(page);
    return pages.length ? pages : [[]];
  }

  function labeledParagraphs(label, value) {
    const paragraphs = parseRich(value);
    if (!paragraphs.length) return [];
    const result = paragraphs.map(cloneParagraph);
    result[0].runs.unshift({ text: `${label}: `, bold: true, italic: false, color: COLORS.navy });
    return result;
  }

  function addTextModels(models, title, value, options) {
    if (!hasText(value)) return;
    const config = options || {};
    const fontSize = Math.max(11, config.fontSize || 16);
    const width = config.width || 11.75;
    const height = config.height || 4.6;
    const pages = paginateParagraphs(parseRich(value), width, height, fontSize);
    pages.forEach((paragraphs, pageIndex) => {
      models.push({
        type: "text",
        title: pageIndex ? `${title}, продолжение` : title,
        paragraphs,
        fontSize,
        tone: config.tone || "neutral"
      });
    });
  }

  function addParagraphModels(models, title, paragraphs, options) {
    if (!paragraphs.length) return;
    const config = options || {};
    const fontSize = Math.max(11, config.fontSize || 15);
    paginateParagraphs(paragraphs, config.width || 11.75, config.height || 4.6, fontSize).forEach((page, pageIndex) => {
      models.push({
        type: "text",
        title: pageIndex ? `${title}, продолжение` : title,
        paragraphs: page,
        fontSize,
        tone: config.tone || "neutral"
      });
    });
  }

  function canShareComparisonSlide(before, after) {
    if (!before.length || !after.length) return false;
    const maximumLines = lineBudget(4.0, 14);
    const beforeCost = before.reduce((sum, paragraph) => sum + paragraphLineCost(paragraph, 5.15, 14), 0);
    const afterCost = after.reduce((sum, paragraph) => sum + paragraphLineCost(paragraph, 5.15, 14), 0);
    return beforeCost <= maximumLines && afterCost <= maximumLines;
  }

  function pairScreenshots(screenshots) {
    const pending = screenshots.slice();
    const groups = [];
    while (pending.length) {
      const first = pending.shift();
      if (first.layout !== "full" && first.role === "before" && first.width && first.height && first.width / first.height <= 1.15) {
        const pairIndex = pending.findIndex((candidate) => candidate.layout !== "full" && candidate.role === "after" && candidate.width && candidate.height && candidate.width / candidate.height <= 1.15);
        if (pairIndex >= 0) {
          groups.push([first, pending.splice(pairIndex, 1)[0]]);
          continue;
        }
      }
      groups.push([first]);
    }
    return groups;
  }

  function buildSlideModels(input) {
    const state = normalizeState(input);
    const models = [];
    const cover = {
      type: "cover",
      title: plainText(state.title).trim(),
      releaseDate: formatDate(state.releaseDate),
      rolloutMode: plainText(state.rolloutMode).trim()
    };
    if (cover.title || cover.releaseDate || cover.rolloutMode) models.push(cover);

    addTextModels(models, "Условия выката", state.rolloutConditions, { fontSize: 16 });

    state.groups.filter(groupHasContent).forEach((group) => {
      const groupTitle = plainText(group.title).trim();
      const meta = [];
      if (group.channels.length) meta.push(...labeledParagraphs("Канал", group.channels.join(", ")));
      meta.push(...labeledParagraphs("Где находится", group.location));
      meta.push(...labeledParagraphs("Когда и кому доступно", group.availability));
      addParagraphModels(models, groupTitle || "Расположение и доступность", meta, { fontSize: 15 });

      group.items.filter(itemHasContent).forEach((item, itemIndex) => {
        const itemTitle = plainText(item.title).trim();
        const numberedTitle = itemTitle ? `${itemIndex + 1}. ${itemTitle}` : "";
        const title = numberedTitle || groupTitle;
        const notes = [];
        notes.push(...labeledParagraphs("Что делает пользователь", item.clientAction));
        notes.push(...labeledParagraphs("Что важно для поддержки", item.supportNote));
        const notesTitle = title || (
          hasText(item.clientAction) && hasText(item.supportNote)
            ? "Действие пользователя и информация для поддержки"
            : hasText(item.clientAction)
              ? "Действие пользователя"
              : "Информация для поддержки"
        );
        addParagraphModels(models, notesTitle, notes, { fontSize: 15 });

        const before = parseRich(item.before);
        const after = parseRich(item.after);
        if (canShareComparisonSlide(before, after)) {
          models.push({ type: "comparison", title: title || "Как было и как стало", before, after, fontSize: 14 });
        } else {
          if (before.length) addParagraphModels(models, title ? `${title}. Как было` : "Как было", before, { fontSize: 16, tone: "before" });
          if (after.length) addParagraphModels(models, title ? `${title}. Как стало` : "Как стало", after, { fontSize: 16, tone: "after" });
        }
      });

      const screenshotTitle = groupTitle ? `${groupTitle}. Скриншоты` : "Скриншоты";
      pairScreenshots(group.screenshots.filter((image) => /^data:image\//i.test(image.dataUrl))).forEach((items) => {
        const model = { type: "image", title: screenshotTitle, images: items, captions: [] };
        const overflowCaptions = [];
        items.forEach((image) => {
          const captionParagraphs = parseRich(image.caption);
          const captionCost = captionParagraphs.reduce((sum, paragraph) => sum + paragraphLineCost(paragraph, items.length === 2 ? 5.2 : 11.6, 12), 0);
          if (captionCost <= 2.1) model.captions.push(captionParagraphs);
          else {
            model.captions.push([]);
            overflowCaptions.push(captionParagraphs);
          }
        });
        models.push(model);
        overflowCaptions.forEach((captionParagraphs) => {
          addParagraphModels(models, `${screenshotTitle}. Комментарий`, captionParagraphs, { fontSize: 15 });
        });
      });
    });

    const say = parseRich(state.support.say);
    const dontSay = parseRich(state.support.dontSay);
    const pairBudget = lineBudget(4.0, 14);
    const sayCost = say.reduce((sum, paragraph) => sum + paragraphLineCost(paragraph, 5.1, 14), 0);
    const dontSayCost = dontSay.reduce((sum, paragraph) => sum + paragraphLineCost(paragraph, 5.1, 14), 0);
    if (say.length && dontSay.length && sayCost <= pairBudget && dontSayCost <= pairBudget) {
      models.push({ type: "supportPair", title: "Коммуникация с клиентом", say, dontSay, fontSize: 14 });
    } else {
      if (say.length) addParagraphModels(models, "Что можно говорить клиенту", say, { fontSize: 16, tone: "after" });
      if (dontSay.length) addParagraphModels(models, "Чего не обещать", dontSay, { fontSize: 16, tone: "warning" });
    }
    addTextModels(models, "Дополнительные детали", state.support.details, { fontSize: 15 });

    state.support.faq.filter((item) => hasText(item.question) || hasText(item.answer)).forEach((item) => {
      const paragraphs = [];
      const question = parseRich(item.question);
      const answer = parseRich(item.answer);
      if (question.length) {
        const first = cloneParagraph(question[0]);
        first.runs.unshift({ text: "Вопрос: ", bold: true, italic: false, color: COLORS.navy });
        paragraphs.push(first, ...question.slice(1).map(cloneParagraph));
      }
      if (answer.length) {
        const first = cloneParagraph(answer[0]);
        first.runs.unshift({ text: "Ответ: ", bold: true, italic: false, color: COLORS.green });
        paragraphs.push(first, ...answer.slice(1).map(cloneParagraph));
      }
      addParagraphModels(models, "Частые вопросы", paragraphs, { fontSize: 15 });
    });
    return models;
  }

  function pptTitleSize(title) {
    const length = asString(title).length;
    if (length > 135) return 18;
    if (length > 90) return 20;
    if (length > 58) return 22;
    return 25;
  }

  function addSlideBase(slide, pptx, title) {
    slide.background = { color: "F7F8FA" };
    if (hasText(title)) {
      slide.addText(title, {
        x: 0.72, y: 0.38, w: 11.9, h: 0.86,
        fontFace: FONT_FACE, fontSize: pptTitleSize(title), bold: true,
        color: COLORS.ink, margin: 0, valign: "mid", breakLine: false, fit: "shrink"
      });
    }
  }

  function richRunsForPpt(paragraphs, fontSize, fallbackColor) {
    const runs = [];
    paragraphs.forEach((paragraph, paragraphIndex) => {
      const paragraphRuns = paragraph.runs && paragraph.runs.length ? paragraph.runs : [{ text: "" }];
      paragraphRuns.forEach((run, runIndex) => {
        const options = {
          fontFace: FONT_FACE,
          fontSize: Math.max(11, fontSize),
          color: normalizeHex(run.color) || fallbackColor || COLORS.ink,
          bold: Boolean(run.bold),
          italic: Boolean(run.italic),
          breakLine: runIndex === paragraphRuns.length - 1 && paragraphIndex < paragraphs.length - 1
        };
        if (paragraph.bullet && runIndex === 0) options.bullet = { indent: Math.round(fontSize * 1.25), hanging: Math.round(fontSize * 0.35) };
        runs.push({ text: run.text || "", options });
      });
    });
    return runs;
  }

  function addRichText(slide, paragraphs, box, fontSize, color) {
    if (!paragraphs || !paragraphs.length) return;
    slide.addText(richRunsForPpt(paragraphs, fontSize, color), {
      x: box.x, y: box.y, w: box.w, h: box.h,
      fontFace: FONT_FACE, fontSize: Math.max(11, fontSize), color: color || COLORS.ink,
      margin: box.margin === undefined ? 0 : box.margin,
      valign: "top", paraSpaceAfterPt: Math.max(4, Math.round(fontSize * 0.42)),
      breakLine: false
    });
  }

  function addPanel(slide, pptx, box, fill, line) {
    slide.addShape(pptx.ShapeType.rect, {
      x: box.x, y: box.y, w: box.w, h: box.h,
      rectRadius: 0,
      line: { color: line || COLORS.border, width: 0.7 },
      fill: { color: fill || COLORS.white }
    });
  }

  function renderCover(pptx, model) {
    const slide = pptx.addSlide();
    slide.background = { color: "F7F8FA" };
    if (model.title) {
      const titleSize = model.title.length > 120 ? 24 : model.title.length > 75 ? 27 : 31;
      slide.addText(model.title, {
        x: 0.8, y: 1.0, w: 11.75, h: 1.9,
        fontFace: FONT_FACE, fontSize: titleSize, bold: true, color: COLORS.ink,
        margin: 0, valign: "mid"
      });
    }
    const metadata = [];
    if (model.releaseDate) metadata.push(`Дата изменения: ${model.releaseDate}`);
    if (model.rolloutMode) metadata.push(`Формат выката: ${model.rolloutMode}`);
    if (metadata.length) {
      slide.addText(metadata.join("\n"), {
        x: 0.82, y: 3.35, w: 8.8, h: 1.0,
        fontFace: FONT_FACE, fontSize: 16, color: COLORS.navy,
        margin: 0, breakLine: false, paraSpaceAfterPt: 8
      });
    }
  }

  function renderTextSlide(pptx, model) {
    const slide = pptx.addSlide();
    addSlideBase(slide, pptx, model.title);
    let fill = COLORS.white;
    let line = COLORS.border;
    if (model.tone === "before") fill = COLORS.before;
    if (model.tone === "after") {
      fill = COLORS.after;
      line = "A9D7CB";
    }
    if (model.tone === "warning") {
      fill = "FFF4F5";
      line = "F0BCC4";
    }
    addPanel(slide, pptx, { x: 0.72, y: 1.35, w: 11.88, h: 5.35 }, fill, line);
    addRichText(slide, model.paragraphs, { x: 1.02, y: 1.67, w: 11.28, h: 4.72 }, model.fontSize, COLORS.ink);
  }

  function renderComparisonSlide(pptx, model) {
    const slide = pptx.addSlide();
    addSlideBase(slide, pptx, model.title);
    const boxes = [
      { x: 0.72, title: "Как было", fill: COLORS.before, line: COLORS.border, color: COLORS.navy, paragraphs: model.before },
      { x: 6.82, title: "Как стало", fill: COLORS.after, line: "A9D7CB", color: COLORS.green, paragraphs: model.after }
    ];
    boxes.forEach((item) => {
      addPanel(slide, pptx, { x: item.x, y: 1.35, w: 5.8, h: 5.35 }, item.fill, item.line);
      slide.addText(item.title, {
        x: item.x + 0.28, y: 1.65, w: 5.2, h: 0.34,
        fontFace: FONT_FACE, fontSize: 16, bold: true, color: item.color, margin: 0
      });
      addRichText(slide, item.paragraphs, { x: item.x + 0.28, y: 2.14, w: 5.2, h: 4.16 }, model.fontSize, COLORS.ink);
    });
  }

  function renderSupportPairSlide(pptx, model) {
    const slide = pptx.addSlide();
    addSlideBase(slide, pptx, model.title);
    const boxes = [
      { x: 0.72, title: "Что можно говорить", fill: COLORS.after, line: "A9D7CB", color: COLORS.green, paragraphs: model.say },
      { x: 6.82, title: "Чего не обещать", fill: "FFF4F5", line: "F0BCC4", color: COLORS.darkRed, paragraphs: model.dontSay }
    ];
    boxes.forEach((item) => {
      addPanel(slide, pptx, { x: item.x, y: 1.35, w: 5.8, h: 5.35 }, item.fill, item.line);
      slide.addText(item.title, {
        x: item.x + 0.28, y: 1.65, w: 5.2, h: 0.34,
        fontFace: FONT_FACE, fontSize: 16, bold: true, color: item.color, margin: 0
      });
      addRichText(slide, item.paragraphs, { x: item.x + 0.28, y: 2.14, w: 5.2, h: 4.16 }, model.fontSize, COLORS.ink);
    });
  }

  function addContainedImage(slide, image, box) {
    const ratio = image.width && image.height ? image.width / image.height : 16 / 9;
    const fit = fitContain(box.w, box.h, ratio);
    slide.addImage({
      data: image.dataUrl,
      x: box.x + fit.x,
      y: box.y + fit.y,
      w: fit.width,
      h: fit.height
    });
  }

  function renderImageSlide(pptx, model) {
    const slide = pptx.addSlide();
    addSlideBase(slide, pptx, model.title);
    const paired = model.images.length === 2;
    model.images.forEach((image, imageIndex) => {
      const x = paired ? (imageIndex === 0 ? 0.72 : 6.82) : 0.72;
      const width = paired ? 5.8 : 11.88;
      const role = roleLabel(image.role);
      const imageTitle = plainText(image.title).trim();
      const label = role && imageTitle ? `${role}. ${imageTitle}` : (role || imageTitle);
      if (label) {
        slide.addText(label, {
          x: x + 0.02, y: 1.34, w: width - 0.04, h: 0.38,
          fontFace: FONT_FACE, fontSize: 14, bold: true,
          color: image.role === "after" ? COLORS.green : COLORS.navy,
          margin: 0, align: paired ? "center" : "left"
        });
      }
      const imageTop = label ? 1.82 : 1.35;
      const panelHeight = label ? 4.55 : 5.02;
      addPanel(slide, pptx, { x, y: imageTop, w: width, h: panelHeight }, COLORS.white, image.role === "after" ? "A9D7CB" : COLORS.border);
      addContainedImage(slide, image, { x: x + 0.18, y: imageTop + 0.16, w: width - 0.36, h: panelHeight - 0.35 });
      const captions = model.captions[imageIndex];
      if (captions && captions.length) {
        addRichText(slide, captions, { x: x + 0.02, y: 6.48, w: width - 0.04, h: 0.45 }, 12, COLORS.muted);
      }
    });
  }

  async function removeMissingContentTypeOverrides(blob) {
    const JSZip = requireLibrary("JSZip");
    const source = blob && typeof blob.arrayBuffer === "function" ? await blob.arrayBuffer() : blob;
    const zip = await JSZip.loadAsync(source);
    let changed = false;
    const contentTypesFile = zip.file("[Content_Types].xml");
    if (contentTypesFile) {
      const contentTypes = await contentTypesFile.async("string");
      const cleaned = contentTypes.replace(/<Override\b[^>]*\bPartName="\/([^\"]+)"[^>]*\/>/g, (entry, partName) => {
        return zip.file(partName) ? entry : "";
      });
      if (cleaned !== contentTypes) {
        zip.file("[Content_Types].xml", cleaned);
        changed = true;
      }
    }

    const presentationFile = zip.file("ppt/presentation.xml");
    if (presentationFile) {
      const presentation = await presentationFile.async("string");
      const notesMatch = presentation.match(/<p:notesMasterIdLst>[\s\S]*?<\/p:notesMasterIdLst>/);
      if (notesMatch && presentation.indexOf(notesMatch[0]) > presentation.indexOf("<p:sldIdLst>")) {
        const withoutNotes = presentation.replace(notesMatch[0], "");
        zip.file("ppt/presentation.xml", withoutNotes.replace("<p:sldIdLst>", notesMatch[0] + "<p:sldIdLst>"));
        changed = true;
      }
    }

    const slideFiles = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
    for (const name of slideFiles) {
      const slideFile = zip.file(name);
      if (!slideFile) continue;
      const slideXml = await slideFile.async("string");
      const cleanedSlide = slideXml.replace(/<a:p>([\s\S]*?)<\/a:p>/g, (paragraphXml, innerXml) => {
        let propertyCount = 0;
        const cleanedInner = innerXml.replace(/<a:pPr\b[^>]*(?:\/>|>[\s\S]*?<\/a:pPr>)/g, (propertiesXml) => {
          propertyCount += 1;
          return propertyCount === 1 ? propertiesXml : "";
        });
        return `<a:p>${cleanedInner}</a:p>`;
      });
      if (cleanedSlide !== slideXml) {
        zip.file(name, cleanedSlide);
        changed = true;
      }
    }

    if (!changed) return blob;
    return zip.generateAsync({
      type: "blob",
      mimeType: PPTX_MIME,
      compression: "DEFLATE",
      compressionOptions: { level: 6 }
    });
  }

  async function buildPptx(input) {
    const PptxGenJS = requireLibrary("PptxGenJS");
    const state = normalizeState(input);
    const models = buildSlideModels(state);
    const pptx = new PptxGenJS();
    pptx.layout = "LAYOUT_WIDE";
    pptx.author = "Siren";
    pptx.company = "";
    pptx.subject = "Инструкция об изменениях для коллег";
    pptx.title = plainText(state.title).trim() || "Инструкция об изменениях";
    pptx.lang = "ru-RU";
    pptx.theme = { headFontFace: FONT_FACE, bodyFontFace: FONT_FACE, lang: "ru-RU" };

    models.forEach((model) => {
      if (model.type === "cover") renderCover(pptx, model);
      else if (model.type === "comparison") renderComparisonSlide(pptx, model);
      else if (model.type === "supportPair") renderSupportPairSlide(pptx, model);
      else if (model.type === "image") renderImageSlide(pptx, model);
      else renderTextSlide(pptx, model);
    });

    const output = await pptx.write({ outputType: "blob", compression: true });
    const blob = output instanceof Blob ? output : new Blob([output], { type: PPTX_MIME });
    return removeMissingContentTypeOverrides(blob);
  }

  global.SirenEditableExport = Object.freeze({
    buildDocx,
    buildPptx,
    buildSlideModels,
    collectWarnings,
    validateState
  });
})(typeof window !== "undefined" ? window : globalThis);
