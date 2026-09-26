"use strict";

const path = require("node:path");
const zlib = require("node:zlib");
const { HttpError, asPlainText, isRecord } = require("./util");

const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_FILES = 20;
const MAX_EXTRACTED_CHARS = 20000000;
const MAX_TOTAL_EXTRACTED_CHARS = 20000000;

const TYPES = Object.freeze({
  ".png": { mime: "image/png", kind: "image" },
  ".jpg": { mime: "image/jpeg", kind: "image" },
  ".jpeg": { mime: "image/jpeg", kind: "image" },
  ".webp": { mime: "image/webp", kind: "image" },
  ".pdf": { mime: "application/pdf", kind: "pdf" },
  ".docx": { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", kind: "docx" },
  ".pptx": { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", kind: "pptx" },
  ".xlsx": { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", kind: "xlsx" },
  ".csv": { mime: "text/csv", kind: "text" },
  ".txt": { mime: "text/plain", kind: "text" },
  ".md": { mime: "text/markdown", kind: "text" },
  ".markdown": { mime: "text/markdown", kind: "text" },
});

function safeFileName(value) {
  const name = String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/]+/g, "_")
    .trim();
  return (name || "file").slice(0, 240);
}

function decodeBase64(value, maxBytes) {
  const raw = String(value || "").replace(/^data:[^;,]+;base64,/i, "").replace(/\s+/g, "");
  if (!raw || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw) || raw.length % 4 === 1) {
    throw new HttpError(400, "INVALID_FILE_DATA", "Файл передан не в корректном Base64.");
  }
  if (raw.length > Math.ceil(maxBytes / 3) * 4 + 4) {
    throw new HttpError(413, "FILE_TOO_LARGE", "Размер отдельного файла превышает 25 МБ.");
  }
  const buffer = Buffer.from(raw, "base64");
  if (!buffer.length || buffer.length > maxBytes) {
    throw new HttpError(413, "FILE_TOO_LARGE", "Размер отдельного файла превышает 25 МБ.");
  }
  return buffer;
}

function hasMagic(buffer, kind) {
  if (kind === "image") {
    return (
      (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
      (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) ||
      (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP")
    );
  }
  if (["docx", "pptx", "xlsx"].includes(kind)) {
    return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
  }
  if (kind === "pdf") return buffer.subarray(0, 5).toString("ascii") === "%PDF-";
  return true;
}

function prepareFiles(input) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new HttpError(400, "FILES_REQUIRED", "Добавьте хотя бы один материал для анализа.");
  }
  if (input.length > MAX_FILES) {
    throw new HttpError(413, "TOO_MANY_FILES", `Можно загрузить не более ${MAX_FILES} файлов за один анализ.`);
  }

  let total = 0;
  const ids = new Set();
  return input.map((entry, index) => {
    if (!isRecord(entry)) throw new HttpError(400, "INVALID_FILE", `Файл №${index + 1} описан некорректно.`);
    const name = safeFileName(entry.name);
    const extension = path.extname(name).toLowerCase();
    const info = TYPES[extension];
    if (!info) {
      throw new HttpError(415, "UNSUPPORTED_FILE_TYPE", `Формат файла «${name}» не поддерживается.`);
    }
    const buffer = Buffer.isBuffer(entry.buffer) ? entry.buffer : decodeBase64(entry.base64, MAX_FILE_BYTES);
    if (!buffer.length || buffer.length > MAX_FILE_BYTES) throw new HttpError(413, "FILE_TOO_LARGE", "Файл превышает 100 МБ. Разделите его на части и добавьте их в одну обработку.");
    total += buffer.length;
    if (total > MAX_TOTAL_BYTES) {
      throw new HttpError(413, "FILES_TOO_LARGE", "Суммарный размер файлов превышает 100 МБ.");
    }
    if (!hasMagic(buffer, info.kind)) {
      throw new HttpError(415, "FILE_SIGNATURE_MISMATCH", `Содержимое файла «${name}» не соответствует его формату.`);
    }
    const idBase = asPlainText(entry.id, 100) || `file-${index + 1}`;
    const id = ids.has(idBase) ? `${idBase}-${index + 1}` : idBase;
    const purposeValue = asPlainText(entry.purpose, 30).toLowerCase();
    const purpose = ["documentation", "screen", "before", "after", "scheme", "context"].includes(purposeValue)
      ? purposeValue
      : "context";
    ids.add(id);
    return {
      id,
      name,
      purpose,
      extension,
      kind: info.kind,
      mime: info.mime,
      reportedType: asPlainText(entry.type, 150),
      size: buffer.length,
      buffer,
    };
  });
}

function decodeXmlEntities(value) {
  return String(value || "")
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, num) => String.fromCodePoint(Number.parseInt(num, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function xmlText(xml) {
  return decodeXmlEntities(
    String(xml || "")
      .replace(/<w:tab\b[^>]*\/>/gi, "\t")
      .replace(/<w:br\b[^>]*\/>/gi, "\n")
      .replace(/<\/(?:w:p|a:p|row|c|si|t)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeZipName(buffer, utf8) {
  // Office Open XML packages use UTF-8 names. ASCII is a safe fallback when the flag is absent.
  return buffer.toString(utf8 ? "utf8" : "latin1");
}

function unzipEntries(buffer, limits = {}) {
  const maxEntries = limits.maxEntries || 5000;
  const maxUncompressed = limits.maxUncompressed || 80 * 1024 * 1024;
  const minimum = Math.max(0, buffer.length - 65557);
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new HttpError(422, "INVALID_OFFICE_FILE", "Не удалось прочитать структуру Office-файла.");

  const count = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (count > maxEntries || centralOffset >= buffer.length) {
    throw new HttpError(422, "UNSAFE_OFFICE_FILE", "Office-файл содержит слишком много элементов.");
  }

  const entries = new Map();
  let pointer = centralOffset;
  let uncompressedTotal = 0;
  for (let index = 0; index < count; index += 1) {
    if (pointer + 46 > buffer.length || buffer.readUInt32LE(pointer) !== 0x02014b50) {
      throw new HttpError(422, "INVALID_OFFICE_FILE", "Центральный каталог Office-файла поврежден.");
    }
    const flags = buffer.readUInt16LE(pointer + 8);
    const method = buffer.readUInt16LE(pointer + 10);
    const compressedSize = buffer.readUInt32LE(pointer + 20);
    const uncompressedSize = buffer.readUInt32LE(pointer + 24);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);
    const localOffset = buffer.readUInt32LE(pointer + 42);
    const nameEnd = pointer + 46 + nameLength;
    if (nameEnd > buffer.length) throw new HttpError(422, "INVALID_OFFICE_FILE", "Имя элемента Office-файла повреждено.");
    const name = decodeZipName(buffer.subarray(pointer + 46, nameEnd), Boolean(flags & 0x800)).replace(/\\/g, "/");
    if (!name || name.startsWith("/") || name.split("/").includes("..") || name.includes("\0")) {
      throw new HttpError(422, "UNSAFE_OFFICE_FILE", "Office-файл содержит небезопасный путь.");
    }
    uncompressedTotal += uncompressedSize;
    if (uncompressedTotal > maxUncompressed || uncompressedSize > maxUncompressed) {
      throw new HttpError(422, "OFFICE_EXPANSION_LIMIT", "Office-файл слишком велик после распаковки.");
    }
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new HttpError(422, "INVALID_OFFICE_FILE", "Локальная запись Office-файла повреждена.");
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) throw new HttpError(422, "INVALID_OFFICE_FILE", "Данные Office-файла повреждены.");
    if (flags & 0x1) throw new HttpError(422, "ENCRYPTED_OFFICE_FILE", "Защищенные паролем Office-файлы не поддерживаются.");
    const compressed = buffer.subarray(dataStart, dataEnd);
    let data;
    if (method === 0) data = Buffer.from(compressed);
    else if (method === 8) {
      try {
        data = zlib.inflateRawSync(compressed, { maxOutputLength: Math.min(maxUncompressed, uncompressedSize + 65536) });
      } catch (_error) {
        throw new HttpError(422, "INVALID_OFFICE_FILE", "Не удалось распаковать Office-файл.");
      }
    } else {
      pointer = nameEnd + extraLength + commentLength;
      continue;
    }
    if (data.length > maxUncompressed) throw new HttpError(422, "OFFICE_EXPANSION_LIMIT", "Элемент Office-файла слишком велик.");
    entries.set(name, data);
    pointer = nameEnd + extraLength + commentLength;
  }
  return entries;
}

function extractDocx(buffer) {
  const entries = unzipEntries(buffer);
  const selected = [...entries.entries()]
    .filter(([name]) => /^word\/(?:document|header\d*|footer\d*|comments|footnotes|endnotes)\.xml$/i.test(name))
    .sort(([left], [right]) => left.localeCompare(right, "en"));
  const text = selected.map(([name, data]) => `[${name}]\n${xmlText(data.toString("utf8"))}`).join("\n\n");
  return { text, complete: Boolean(selected.length), warnings: selected.length ? [] : ["В DOCX не найден текст документа."] };
}

function numericFileSort(left, right) {
  const a = Number((left.match(/(\d+)(?=\.xml$)/) || [])[1] || 0);
  const b = Number((right.match(/(\d+)(?=\.xml$)/) || [])[1] || 0);
  return a - b || left.localeCompare(right, "en");
}

function extractPptx(buffer) {
  const entries = unzipEntries(buffer);
  const names = [...entries.keys()].filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name)).sort(numericFileSort);
  const text = names.map((name, index) => `[Слайд ${index + 1}]\n${xmlText(entries.get(name).toString("utf8"))}`).join("\n\n");
  return { text, complete: Boolean(names.length), warnings: names.length ? [] : ["В PPTX не найдены слайды с текстом."] };
}

function extractXlsx(buffer) {
  const entries = unzipEntries(buffer);
  const sharedXml = entries.get("xl/sharedStrings.xml");
  const shared = [];
  if (sharedXml) {
    const xml = sharedXml.toString("utf8");
    const matches = xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi);
    for (const match of matches) shared.push(xmlText(match[1]));
  }
  const sheetNames = [...entries.keys()].filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name)).sort(numericFileSort);
  const sheets = sheetNames.map((name, sheetIndex) => {
    const xml = entries.get(name).toString("utf8");
    const cells = [];
    for (const match of xml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)) {
      const attrs = match[1];
      const body = match[2];
      const ref = (/\br="([^"]+)"/i.exec(attrs) || [])[1] || "";
      const type = (/\bt="([^"]+)"/i.exec(attrs) || [])[1] || "";
      const raw = (/<v\b[^>]*>([\s\S]*?)<\/v>/i.exec(body) || [])[1];
      let value = "";
      if (type === "inlineStr") value = xmlText(body);
      else if (raw !== undefined && type === "s") value = shared[Number(raw)] || "";
      else if (raw !== undefined) value = decodeXmlEntities(raw).trim();
      if (value) cells.push(`${ref}: ${value}`);
    }
    return `[Лист ${sheetIndex + 1}]\n${cells.join("\n")}`;
  });
  const text = sheets.join("\n\n");
  return { text, complete: Boolean(sheetNames.length), warnings: sheetNames.length ? [] : ["В XLSX не найдены листы с данными."] };
}

function unescapePdfString(value) {
  return String(value || "")
    .replace(/\\([0-7]{1,3})/g, (_m, oct) => String.fromCharCode(Number.parseInt(oct, 8)))
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\b/g, "\b")
    .replace(/\\f/g, "\f")
    .replace(/\\([\\()])/g, "$1");
}

function pdfTextFromContent(content) {
  const parts = [];
  for (const match of String(content || "").matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj\b/g)) {
    parts.push(unescapePdfString(match[1]));
  }
  for (const match of String(content || "").matchAll(/\[([\s\S]*?)\]\s*TJ\b/g)) {
    for (const stringMatch of match[1].matchAll(/\(((?:\\.|[^\\)])*)\)/g)) parts.push(unescapePdfString(stringMatch[1]));
  }
  return parts.join(" ");
}

function extractPdfBasic(buffer) {
  if (buffer.includes(Buffer.from("/Encrypt"))) {
    return { text: "", complete: false, warnings: ["PDF защищен или зашифрован; локальное извлечение текста невозможно."] };
  }
  const latin = buffer.toString("latin1");
  const parts = [pdfTextFromContent(latin)];
  for (const match of latin.matchAll(/<<(.*?)>>\s*stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    if (!/\/FlateDecode\b/.test(match[1])) continue;
    try {
      const start = match.index + match[0].indexOf(match[2]);
      const compressed = buffer.subarray(start, start + match[2].length);
      const inflated = zlib.inflateSync(compressed, { maxOutputLength: 20 * 1024 * 1024 });
      parts.push(pdfTextFromContent(inflated.toString("latin1")));
    } catch (_error) {
      // A PDF stream may contain binary marker sequences. Other streams remain useful.
    }
  }
  const text = parts.join("\n").replace(/[ \t]{2,}/g, " ").trim();
  const pages = Math.max(1, (latin.match(/\/Type\s*\/Page\b/g) || []).length);
  const complete = text.length >= Math.min(80, pages * 20);
  return {
    text,
    complete,
    warnings: complete ? [] : ["В PDF мало извлекаемого текста. Возможно, это скан; требуется локальный OCR."],
  };
}

function extractImageMetadata(file) {
  const parts = [];
  const buffer = file.buffer;
  if (file.extension === ".png") {
    let offset = 8;
    while (offset + 12 <= buffer.length) {
      const length = buffer.readUInt32BE(offset);
      const type = buffer.toString("ascii", offset + 4, offset + 8);
      const dataStart = offset + 8;
      const dataEnd = dataStart + length;
      if (dataEnd + 4 > buffer.length) break;
      if (type === "tEXt") parts.push(buffer.toString("utf8", dataStart, dataEnd));
      offset = dataEnd + 4;
      if (type === "IEND") break;
    }
  } else if (file.extension === ".jpg" || file.extension === ".jpeg") {
    let offset = 2;
    while (offset + 4 <= buffer.length && buffer[offset] === 0xff) {
      const marker = buffer[offset + 1];
      if (marker === 0xda || marker === 0xd9) break;
      const length = buffer.readUInt16BE(offset + 2);
      if (length < 2 || offset + 2 + length > buffer.length) break;
      if (marker === 0xfe) parts.push(buffer.toString("utf8", offset + 4, offset + 2 + length));
      offset += 2 + length;
    }
  }
  return {
    text: asPlainText(parts.join("\n"), MAX_EXTRACTED_CHARS + 1),
    complete: false,
    warnings: ["Текст на изображении не проверен: локальный OCR недоступен."],
  };
}

async function extractOne(file, extractors) {
  if (file.kind === "text") {
    let text = file.buffer.toString("utf8");
    if (file.buffer[0] === 0xff && file.buffer[1] === 0xfe) text = file.buffer.subarray(2).toString("utf16le");
    else if (file.buffer[0] === 0xfe && file.buffer[1] === 0xff) text = new TextDecoder("utf-16be").decode(file.buffer.subarray(2));
    const replacementRatio = (text.match(/\uFFFD/g) || []).length / Math.max(1, text.length);
    if (replacementRatio > 0.02) text = new TextDecoder("windows-1251").decode(file.buffer);
    return { text, complete: true, warnings: replacementRatio > 0.02 ? ["Кодировка определена как Windows-1251. Если текст отображается неверно, сохраните файл в UTF-8 и загрузите заново."] : [] };
  }
  if (file.kind === "docx" || file.kind === "pptx") {
    const extracted = file.kind === "docx" ? extractDocx(file.buffer) : extractPptx(file.buffer);
    const media = [...unzipEntries(file.buffer)].filter(([name]) => /^(?:word|ppt)\/media\/.+\.(png|jpe?g|webp)$/i.test(name));
    for (const [name, buffer] of media) {
      if (file.signal?.aborted) throw new HttpError(499, "ANALYSIS_CANCELLED", "Распознавание документа приостановлено.");
      if (!extractors?.image) { extracted.complete = false; extracted.warnings.push(`Вложенное изображение «${name}» не распознано. Добавьте его отдельным файлом.`); continue; }
      const result = await extractors.image({ ...file, buffer, kind: "image", extension: path.extname(name).toLowerCase() });
      extracted.text += `\n\n[Текст вложенного изображения ${name}]\n${result.text || ""}`;
      if (!result.complete) extracted.complete = false;
      extracted.warnings.push(...(result.warnings || []));
    }
    if (media.length) extracted.warnings.push(`Распознаны надписи во вложенных изображениях: ${media.length}. Для анализа графики и расположения элементов добавьте изображения отдельно.`);
    return extracted;
  }
  if (file.kind === "xlsx") return extractXlsx(file.buffer);
  if (file.kind === "pdf") {
    if (extractors && typeof extractors.pdf === "function") {
      const result = await extractors.pdf(file);
      if (isRecord(result)) return result;
    }
    return extractPdfBasic(file.buffer);
  }
  if (file.kind === "image") {
    if (extractors && typeof extractors.image === "function") {
      const result = await extractors.image(file);
      if (isRecord(result)) return result;
    }
    return extractImageMetadata(file);
  }
  return { text: "", complete: false, warnings: ["Формат не удалось обработать локально."] };
}

async function extractFiles(files, extractors) {
  const results = [];
  let totalExtractedChars = 0;
  for (const file of files) {
    try {
      const result = await extractOne(file, extractors || {});
      // Material text is data, not HTML. Preserve literal tags and comparisons;
      // the browser renders it as text and proposal fields are sanitized separately.
      const rawText = String(result.text || "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").replace(/\r\n?/g, "\n").trim().slice(0, MAX_EXTRACTED_CHARS + 1);
      if (rawText.length > MAX_EXTRACTED_CHARS) {
        throw new HttpError(413, "MATERIAL_TEXT_TOO_LARGE", `В файле «${file.name}» больше ${MAX_EXTRACTED_CHARS.toLocaleString("ru-RU")} символов текста. Разделите файл на несколько материалов и повторите анализ.`);
      }
      totalExtractedChars += rawText.length;
      if (totalExtractedChars > MAX_TOTAL_EXTRACTED_CHARS) {
        throw new HttpError(413, "MATERIALS_TEXT_TOO_LARGE", `Во всех материалах больше ${MAX_TOTAL_EXTRACTED_CHARS.toLocaleString("ru-RU")} символов текста. Разделите материалы на два анализа, чтобы программа ничего не пропустила.`);
      }
      results.push({
        id: file.id,
        name: file.name,
        purpose: file.purpose,
        kind: file.kind,
        mime: file.mime,
        size: file.size,
        text: rawText,
        scanComplete: Boolean(result.complete),
        warnings: Array.isArray(result.warnings) ? result.warnings.map((item) => asPlainText(item, 500)).filter(Boolean) : [],
        buffer: file.buffer,
      });
    } catch (error) {
      if (error instanceof HttpError && ["MATERIAL_TEXT_TOO_LARGE", "MATERIALS_TEXT_TOO_LARGE"].includes(error.code)) throw error;
      results.push({
        id: file.id,
        name: file.name,
        purpose: file.purpose,
        kind: file.kind,
        mime: file.mime,
        size: file.size,
        text: "",
        scanComplete: false,
        warnings: [`Не удалось извлечь текст локально: ${asPlainText(error.message, 300)}`],
        buffer: file.buffer,
      });
    }
  }
  return results;
}

module.exports = {
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  MAX_EXTRACTED_CHARS,
  MAX_TOTAL_EXTRACTED_CHARS,
  MAX_FILES,
  TYPES,
  prepareFiles,
  extractFiles,
  unzipEntries,
  extractDocx,
  extractPptx,
  extractXlsx,
  extractPdfBasic,
};
