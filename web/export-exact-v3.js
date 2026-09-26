(function initSirenExactExport(global) {
  "use strict";

  const A4_WIDTH_MM = 210;
  const A4_HEIGHT_MM = 297;
  const A4_RATIO = A4_WIDTH_MM / A4_HEIGHT_MM;
  const A4_WIDTH_EMU = 7560000;
  const A4_HEIGHT_EMU = 10692000;
  const A4_WIDTH_TWIPS = 11906;
  const A4_HEIGHT_TWIPS = 16838;
  const SLIDE_WIDTH_IN = 13.333;
  const SLIDE_HEIGHT_IN = 7.5;
  const SLIDE_RATIO = 16 / 9;

  const PDF_MIME = "application/pdf";
  const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const BUSY_ERROR_CODE = "SIREN_EXACT_EXPORT_BUSY";
  const DEFAULT_ASPECT_TOLERANCE = 0.01;
  const DEFAULT_OVERFLOW_TOLERANCE_PX = 1;
  const DEFAULT_ASSET_TIMEOUT_MS = 15000;
  const DEFAULT_SCALE = 2;

  let busy = false;

  function makeError(code, message, details, cause) {
    const error = new Error(message);
    error.name = "SirenExactExportError";
    error.code = code;
    if (details !== undefined) error.details = details;
    if (cause !== undefined) error.cause = cause;
    return error;
  }

  function makeBusyError() {
    return makeError(
      BUSY_ERROR_CODE,
      "Экспорт уже выполняется. Дождитесь его завершения."
    );
  }

  function runExclusive(operation) {
    if (busy) return Promise.reject(makeBusyError());
    busy = true;
    return Promise.resolve()
      .then(operation)
      .finally(function releaseExportLock() {
        busy = false;
      });
  }

  function isElement(value) {
    return Boolean(
      value &&
      value.nodeType === 1 &&
      typeof value.getBoundingClientRect === "function"
    );
  }

  function isCanvasLike(value) {
    return Boolean(
      value &&
      typeof value.toDataURL === "function" &&
      Number.isFinite(Number(value.width)) &&
      Number.isFinite(Number(value.height))
    );
  }

  function isBlobLike(value) {
    return Boolean(value && typeof value.arrayBuffer === "function" && typeof value.size === "number");
  }

  function isBinary(value) {
    return value instanceof ArrayBuffer || ArrayBuffer.isView(value) || isBlobLike(value);
  }

  function asList(value, singlePredicate) {
    if (value == null) return [];
    if (singlePredicate && singlePredicate(value)) return [value];
    if (typeof value === "string" || isBinary(value)) return [value];
    if (Array.isArray(value)) return value.slice();
    if (typeof value[Symbol.iterator] === "function") return Array.from(value);
    if (Number.isFinite(value.length)) return Array.prototype.slice.call(value);
    return [value];
  }

  function normalizeElements(elements) {
    const list = asList(elements, isElement);
    if (!list.length) {
      throw makeError("SIREN_EXACT_EXPORT_EMPTY", "Не переданы элементы для экспорта.");
    }
    list.forEach(function validateElement(element, index) {
      if (!isElement(element)) {
        throw makeError(
          "SIREN_EXACT_EXPORT_INVALID_ELEMENT",
          "Элемент экспорта должен быть DOM-элементом.",
          { index: index }
        );
      }
    });
    return list;
  }

  function finitePositive(value, fallback, label) {
    if (value == null) return fallback;
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) {
      throw makeError("SIREN_EXACT_EXPORT_INVALID_OPTION", label + " должно быть положительным числом.");
    }
    return number;
  }

  function finiteNonNegative(value, fallback, label) {
    if (value == null) return fallback;
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) {
      throw makeError("SIREN_EXACT_EXPORT_INVALID_OPTION", label + " не может быть отрицательным.");
    }
    return number;
  }

  function expectedRatioFromOptions(options) {
    const settings = options || {};
    if (settings.expectedAspectRatio != null) {
      return finitePositive(settings.expectedAspectRatio, null, "expectedAspectRatio");
    }
    const format = String(settings.format || "").trim().toLowerCase();
    if (format === "a4" || format === "pdf" || format === "docx") return A4_RATIO;
    if (format === "16:9" || format === "slide" || format === "pptx") return SLIDE_RATIO;
    return null;
  }

  function inspectElementsImpl(elements, options) {
    const list = normalizeElements(elements);
    const settings = options || {};
    const expectedRatio = expectedRatioFromOptions(settings);
    const aspectTolerance = finiteNonNegative(
      settings.aspectTolerance,
      DEFAULT_ASPECT_TOLERANCE,
      "aspectTolerance"
    );
    const overflowTolerance = finiteNonNegative(
      settings.overflowTolerancePx,
      DEFAULT_OVERFLOW_TOLERANCE_PX,
      "overflowTolerancePx"
    );
    const checkVerticalOverflow = settings.checkVerticalOverflow !== false;

    return list.map(function inspectElement(element, index) {
      const rect = element.getBoundingClientRect();
      const clientWidth = Number(element.clientWidth) || 0;
      const clientHeight = Number(element.clientHeight) || 0;
      const scrollWidth = Number(element.scrollWidth) || 0;
      const scrollHeight = Number(element.scrollHeight) || 0;
      const renderedWidth = Number(rect.width) || 0;
      const renderedHeight = Number(rect.height) || 0;
      const aspectRatio = renderedHeight > 0 ? renderedWidth / renderedHeight : 0;
      const aspectError = expectedRatio && aspectRatio
        ? Math.abs(aspectRatio / expectedRatio - 1)
        : 0;
      const errors = [];

      if (!clientWidth || !clientHeight || !renderedWidth || !renderedHeight) {
        errors.push("Элемент скрыт или имеет нулевой размер.");
      }
      if (scrollWidth - clientWidth > overflowTolerance) {
        errors.push(
          "Горизонтальное переполнение: scrollWidth=" + scrollWidth +
          ", clientWidth=" + clientWidth + "."
        );
      }
      if (checkVerticalOverflow && scrollHeight - clientHeight > overflowTolerance) {
        errors.push(
          "Вертикальное переполнение: scrollHeight=" + scrollHeight +
          ", clientHeight=" + clientHeight + "."
        );
      }
      if (expectedRatio && aspectError > aspectTolerance) {
        errors.push(
          "Неверное соотношение сторон: " + aspectRatio.toFixed(5) +
          ", ожидается " + expectedRatio.toFixed(5) + "."
        );
      }

      return {
        index: index,
        element: element,
        ok: errors.length === 0,
        errors: errors,
        clientWidth: clientWidth,
        clientHeight: clientHeight,
        scrollWidth: scrollWidth,
        scrollHeight: scrollHeight,
        renderedWidth: renderedWidth,
        renderedHeight: renderedHeight,
        aspectRatio: aspectRatio,
        expectedAspectRatio: expectedRatio,
        aspectError: aspectError,
        horizontalOverflowPx: Math.max(0, scrollWidth - clientWidth),
        verticalOverflowPx: Math.max(0, scrollHeight - clientHeight)
      };
    });
  }

  function inspectElements(elements, options) {
    return inspectElementsImpl(elements, options);
  }

  function withTimeout(promise, timeoutMs, errorFactory) {
    if (!timeoutMs) return promise;
    let timer;
    const timeout = new Promise(function rejectOnTimeout(resolve, reject) {
      timer = global.setTimeout(function onTimeout() {
        reject(errorFactory());
      }, timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(function clearAssetTimer() {
      global.clearTimeout(timer);
    });
  }

  async function waitForImage(image, timeoutMs) {
    if (!image) return;
    if (!image.complete) {
      await withTimeout(
        new Promise(function waitForLoad(resolve, reject) {
          function cleanup() {
            image.removeEventListener("load", onLoad);
            image.removeEventListener("error", onError);
          }
          function onLoad() {
            cleanup();
            resolve();
          }
          function onError() {
            cleanup();
            reject(makeError(
              "SIREN_EXACT_EXPORT_IMAGE_ERROR",
              "Не удалось загрузить изображение перед экспортом.",
              { src: image.currentSrc || image.src || "" }
            ));
          }
          image.addEventListener("load", onLoad, { once: true });
          image.addEventListener("error", onError, { once: true });
        }),
        timeoutMs,
        function imageTimeoutError() {
          return makeError(
            "SIREN_EXACT_EXPORT_IMAGE_TIMEOUT",
            "Истекло время ожидания изображения перед экспортом.",
            { src: image.currentSrc || image.src || "" }
          );
        }
      );
    }
    if (!image.naturalWidth || !image.naturalHeight) {
      throw makeError(
        "SIREN_EXACT_EXPORT_IMAGE_ERROR",
        "Изображение повреждено или недоступно для экспорта.",
        { src: image.currentSrc || image.src || "" }
      );
    }
    if (typeof image.decode === "function") {
      try {
        await withTimeout(
          image.decode(),
          timeoutMs,
          function imageDecodeTimeoutError() {
            return makeError(
              "SIREN_EXACT_EXPORT_IMAGE_TIMEOUT",
              "Истекло время декодирования изображения перед экспортом."
            );
          }
        );
      } catch (error) {
        if (!image.complete || !image.naturalWidth) throw error;
      }
    }
  }

  async function waitForAssets(elements, options) {
    const settings = options || {};
    const imageTimeoutMs = finiteNonNegative(
      settings.imageTimeoutMs,
      DEFAULT_ASSET_TIMEOUT_MS,
      "imageTimeoutMs"
    );
    const fontTimeoutMs = finiteNonNegative(
      settings.fontTimeoutMs,
      DEFAULT_ASSET_TIMEOUT_MS,
      "fontTimeoutMs"
    );
    const documents = [];
    const images = [];

    elements.forEach(function collectAssets(element) {
      const ownerDocument = element.ownerDocument || global.document;
      if (ownerDocument && documents.indexOf(ownerDocument) === -1) documents.push(ownerDocument);
      if (String(element.tagName || "").toLowerCase() === "img") images.push(element);
      if (typeof element.querySelectorAll === "function") {
        images.push.apply(images, Array.from(element.querySelectorAll("img")));
      }
    });

    await Promise.all(documents.map(function waitForDocumentFonts(documentRef) {
      if (!documentRef.fonts || !documentRef.fonts.ready) return Promise.resolve();
      return withTimeout(
        Promise.resolve(documentRef.fonts.ready),
        fontTimeoutMs,
        function fontTimeoutError() {
          return makeError(
            "SIREN_EXACT_EXPORT_FONT_TIMEOUT",
            "Истекло время ожидания шрифтов перед экспортом."
          );
        }
      );
    }));
    await Promise.all(images.map(function waitForCollectedImage(image) {
      return waitForImage(image, imageTimeoutMs);
    }));

    await nextPaint(elements[0] && elements[0].ownerDocument);
    await nextPaint(elements[0] && elements[0].ownerDocument);
  }

  function nextPaint(documentRef) {
    const view = documentRef && documentRef.defaultView;
    const raf = view && typeof view.requestAnimationFrame === "function"
      ? view.requestAnimationFrame.bind(view)
      : (typeof global.requestAnimationFrame === "function"
        ? global.requestAnimationFrame.bind(global)
        : null);
    if (!raf) return new Promise(function wait(resolve) { global.setTimeout(resolve, 0); });
    return new Promise(function wait(resolve) { raf(function painted() { resolve(); }); });
  }

  function assertInspections(inspections) {
    const failures = inspections.filter(function failed(item) { return !item.ok; });
    if (!failures.length) return;
    throw makeError(
      "SIREN_EXACT_EXPORT_INVALID_LAYOUT",
      "Экспорт остановлен: размер страницы или переполнение не соответствуют точному режиму.",
      failures.map(function failureDetails(item) {
        return { index: item.index, errors: item.errors.slice() };
      })
    );
  }

  function assertCanvasRatio(canvas, expectedRatio, aspectTolerance, index) {
    if (!canvas || !canvas.width || !canvas.height) {
      throw makeError(
        "SIREN_EXACT_EXPORT_EMPTY_CANVAS",
        "Не удалось получить изображение страницы.",
        { index: index }
      );
    }
    if (!expectedRatio) return;
    const actualRatio = canvas.width / canvas.height;
    const error = Math.abs(actualRatio / expectedRatio - 1);
    if (error > aspectTolerance) {
      throw makeError(
        "SIREN_EXACT_EXPORT_CAPTURE_RATIO",
        "Соотношение сторон захваченного изображения изменилось.",
        {
          index: index,
          width: canvas.width,
          height: canvas.height,
          actualRatio: actualRatio,
          expectedRatio: expectedRatio,
          aspectError: error
        }
      );
    }
  }

  async function prepareContainedImages(element, captureScale) {
    const records = [];
    const restoreContainedImages = function () {
      records.forEach((record) => {
        if (record.src === null) record.image.removeAttribute("src");
        else record.image.setAttribute("src", record.src);
        if (record.srcset === null) record.image.removeAttribute("srcset");
        else record.image.setAttribute("srcset", record.srcset);
        if (record.sizes === null) record.image.removeAttribute("sizes");
        else record.image.setAttribute("sizes", record.sizes);
        record.image.style.objectFit = record.objectFit;
        record.image.style.objectPosition = record.objectPosition;
      });
    };
    const images = Array.from(element.querySelectorAll("img"));
    try {
      for (const image of images) {
      const documentRef = image.ownerDocument || global.document;
      const view = documentRef && documentRef.defaultView;
      const computed = view && view.getComputedStyle ? view.getComputedStyle(image) : null;
      const objectFit = computed ? computed.objectFit : "";
      if (objectFit !== "contain" && objectFit !== "scale-down") continue;

      const rect = image.getBoundingClientRect();
      const naturalWidth = image.naturalWidth;
      const naturalHeight = image.naturalHeight;
      if (!(rect.width > 0 && rect.height > 0 && naturalWidth > 0 && naturalHeight > 0)) continue;

      const rasterScale = Math.max(1, captureScale);
      const canvas = documentRef.createElement("canvas");
      canvas.width = Math.max(1, Math.round(rect.width * rasterScale));
      canvas.height = Math.max(1, Math.round(rect.height * rasterScale));
      const context = canvas.getContext("2d");
      if (!context) continue;

      let fitScale = Math.min(canvas.width / naturalWidth, canvas.height / naturalHeight);
      if (objectFit === "scale-down") fitScale = Math.min(fitScale, rasterScale);
      const drawWidth = naturalWidth * fitScale;
      const drawHeight = naturalHeight * fitScale;
      const drawX = (canvas.width - drawWidth) / 2;
      const drawY = (canvas.height - drawHeight) / 2;
      context.drawImage(image, drawX, drawY, drawWidth, drawHeight);

      let normalizedSource;
      try {
        normalizedSource = canvas.toDataURL("image/png");
      } catch (cause) {
        throw makeError(
          "SIREN_EXACT_EXPORT_IMAGE_TAINTED",
          "Нельзя подготовить один из скриншотов к выгрузке из-за ограничений CORS.",
          {},
          cause
        );
      }

      records.push({
        image: image,
        src: image.getAttribute("src"),
        srcset: image.getAttribute("srcset"),
        sizes: image.getAttribute("sizes"),
        objectFit: image.style.objectFit,
        objectPosition: image.style.objectPosition
      });
      image.removeAttribute("srcset");
      image.removeAttribute("sizes");
      image.style.objectFit = "fill";
      image.style.objectPosition = "50% 50%";
      image.src = normalizedSource;
        if (typeof image.decode === "function") {
          try {
            await image.decode();
          } catch (_error) {
            // A data URL can already be ready even if decode() rejects in an old browser.
          }
        }
      }
    } catch (error) {
      restoreContainedImages();
      throw error;
    }
    return restoreContainedImages;
  }

  async function captureElementsImpl(elements, options) {
    const list = normalizeElements(elements);
    const settings = options || {};
    if (typeof global.html2canvas !== "function") {
      throw makeError(
        "SIREN_EXACT_EXPORT_DEPENDENCY",
        "html2canvas не загружен."
      );
    }
    const scale = finitePositive(settings.scale, DEFAULT_SCALE, "scale");
    const expectedRatio = expectedRatioFromOptions(settings);
    const aspectTolerance = finiteNonNegative(
      settings.aspectTolerance,
      DEFAULT_ASPECT_TOLERANCE,
      "aspectTolerance"
    );
    await waitForAssets(list, settings);

    const inspections = inspectElementsImpl(list, settings);
    assertInspections(inspections);

    const captures = [];
    for (let index = 0; index < list.length; index += 1) {
      const element = list[index];
      const rect = element.getBoundingClientRect();
      const documentRef = element.ownerDocument || global.document;
      const view = documentRef && documentRef.defaultView;
      const html2canvasOptions = Object.assign({}, settings.html2canvasOptions || {}, {
        backgroundColor: settings.backgroundColor === undefined ? "#ffffff" : settings.backgroundColor,
        logging: false,
        scale: scale,
        useCORS: settings.useCORS !== false,
        allowTaint: false,
        width: Math.max(1, Math.round(rect.width)),
        height: Math.max(1, Math.round(rect.height)),
        scrollX: view ? -view.scrollX : 0,
        scrollY: view ? -view.scrollY : 0,
        windowWidth: view ? view.innerWidth : Math.max(1, Math.round(rect.width)),
        windowHeight: view ? view.innerHeight : Math.max(1, Math.round(rect.height))
      });

      let canvas;
      const priorInlineBoxShadow = element.style.boxShadow;
      let restoreContainedImages = function () {};
      try {
        // The shadow belongs to the preview canvas, not to the document itself.
        // html2canvas clips an element's outer shadow to its own bounds, which
        // turns that shadow into a grey overlay across the exported page.
        element.style.boxShadow = "none";
        // html2canvas stretches replaced elements and does not reproduce CSS
        // object-fit reliably. Pre-compose contained screenshots into their
        // exact on-screen boxes so the export keeps their aspect ratio.
        restoreContainedImages = await prepareContainedImages(element, scale);
        canvas = await global.html2canvas(element, html2canvasOptions);
      } catch (cause) {
        throw makeError(
          "SIREN_EXACT_EXPORT_CAPTURE_FAILED",
          "Не удалось захватить страницу " + (index + 1) + ".",
          { index: index },
          cause
        );
      } finally {
        restoreContainedImages();
        element.style.boxShadow = priorInlineBoxShadow;
      }
      assertCanvasRatio(canvas, expectedRatio, aspectTolerance, index);

      let dataUrl;
      try {
        dataUrl = canvas.toDataURL("image/png");
      } catch (cause) {
        throw makeError(
          "SIREN_EXACT_EXPORT_CANVAS_TAINTED",
          "Нельзя сохранить страницу: одно из изображений нарушает правила CORS.",
          { index: index },
          cause
        );
      }
      if (!/^data:image\/png;base64,/i.test(dataUrl)) {
        throw makeError(
          "SIREN_EXACT_EXPORT_NOT_PNG",
          "html2canvas вернул изображение не в формате PNG.",
          { index: index }
        );
      }
      captures.push({
        index: index,
        element: element,
        canvas: canvas,
        dataUrl: dataUrl,
        width: canvas.width,
        height: canvas.height,
        inspection: inspections[index]
      });
      await nextPaint(documentRef);
    }
    return captures;
  }

  async function captureElements(elements, options) {
    return runExclusive(function captureOperation() {
      return captureElementsImpl(elements, options);
    });
  }

  function dataUrlToBytes(dataUrl) {
    const match = /^data:image\/png;base64,([a-z0-9+/=\s]+)$/i.exec(String(dataUrl || ""));
    if (!match) {
      throw makeError(
        "SIREN_EXACT_EXPORT_NOT_PNG",
        "Ожидается PNG в base64 data URL."
      );
    }
    let binary;
    try {
      binary = global.atob(match[1].replace(/\s/g, ""));
    } catch (cause) {
      throw makeError(
        "SIREN_EXACT_EXPORT_INVALID_PNG",
        "Не удалось прочитать PNG data URL.",
        undefined,
        cause
      );
    }
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  function bytesToDataUrl(bytes) {
    let binary = "";
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
      binary += String.fromCharCode.apply(null, chunk);
    }
    return "data:image/png;base64," + global.btoa(binary);
  }

  function asUint8Array(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    return null;
  }

  function readPngSize(bytes, index) {
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (!bytes || bytes.length < 24) {
      throw makeError(
        "SIREN_EXACT_EXPORT_INVALID_PNG",
        "PNG слишком короткий или поврежден.",
        { index: index }
      );
    }
    for (let position = 0; position < signature.length; position += 1) {
      if (bytes[position] !== signature[position]) {
        throw makeError(
          "SIREN_EXACT_EXPORT_NOT_PNG",
          "Для точного экспорта разрешены только PNG.",
          { index: index }
        );
      }
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint32(16, false);
    const height = view.getUint32(20, false);
    if (!width || !height) {
      throw makeError(
        "SIREN_EXACT_EXPORT_INVALID_PNG",
        "PNG содержит неверный размер.",
        { index: index }
      );
    }
    return { width: width, height: height };
  }

  async function pngSourceToBytes(source, index) {
    if (typeof source === "string") return dataUrlToBytes(source);
    if (isCanvasLike(source)) return dataUrlToBytes(source.toDataURL("image/png"));
    const directBytes = asUint8Array(source);
    if (directBytes) return directBytes;
    if (isBlobLike(source)) return new Uint8Array(await source.arrayBuffer());
    if (source && typeof source === "object") {
      if (typeof source.dataUrl === "string") return dataUrlToBytes(source.dataUrl);
      if (source.bytes != null) {
        const bytes = asUint8Array(source.bytes);
        if (bytes) return bytes;
        if (isBlobLike(source.bytes)) return new Uint8Array(await source.bytes.arrayBuffer());
      }
      if (source.canvas && isCanvasLike(source.canvas)) {
        return dataUrlToBytes(source.canvas.toDataURL("image/png"));
      }
    }
    throw makeError(
      "SIREN_EXACT_EXPORT_INVALID_PNG_SOURCE",
      "Страница должна быть PNG data URL, Blob, ArrayBuffer, Uint8Array или canvas.",
      { index: index }
    );
  }

  async function normalizePngSources(sources, expectedRatio, options) {
    const list = asList(sources, function isSinglePngSource(value) {
      return isCanvasLike(value) || Boolean(
        value &&
        typeof value === "object" &&
        (typeof value.dataUrl === "string" || value.bytes != null || isCanvasLike(value.canvas))
      );
    });
    if (!list.length) {
      throw makeError("SIREN_EXACT_EXPORT_EMPTY", "Не переданы PNG-страницы для экспорта.");
    }
    const aspectTolerance = finiteNonNegative(
      options && options.aspectTolerance,
      DEFAULT_ASPECT_TOLERANCE,
      "aspectTolerance"
    );
    const normalized = [];
    for (let index = 0; index < list.length; index += 1) {
      const bytes = await pngSourceToBytes(list[index], index);
      const size = readPngSize(bytes, index);
      const actualRatio = size.width / size.height;
      const aspectError = Math.abs(actualRatio / expectedRatio - 1);
      if (aspectError > aspectTolerance) {
        throw makeError(
          "SIREN_EXACT_EXPORT_PNG_RATIO",
          "PNG-страница " + (index + 1) + " имеет неверное соотношение сторон.",
          {
            index: index,
            width: size.width,
            height: size.height,
            actualRatio: actualRatio,
            expectedRatio: expectedRatio,
            aspectError: aspectError
          }
        );
      }
      normalized.push({
        index: index,
        bytes: bytes,
        dataUrl: bytesToDataUrl(bytes),
        width: size.width,
        height: size.height
      });
    }
    return normalized;
  }

  function titleFromFileName(fileName, fallback) {
    const raw = String(fileName || "").trim().replace(/^.*[\\/]/, "");
    const withoutExtension = raw.replace(/\.(pdf|pptx|docx)$/i, "").trim();
    return (withoutExtension || fallback).slice(0, 255);
  }

  async function toTypedBlob(value, mimeType) {
    if (value == null) {
      throw makeError("SIREN_EXACT_EXPORT_OUTPUT", "Библиотека не вернула файл экспорта.");
    }
    if (isBlobLike(value)) {
      if (value.type === mimeType) return value;
      return new Blob([await value.arrayBuffer()], { type: mimeType });
    }
    const bytes = asUint8Array(value);
    if (bytes) return new Blob([bytes], { type: mimeType });
    throw makeError("SIREN_EXACT_EXPORT_OUTPUT", "Неизвестный формат результата библиотеки.");
  }

  async function buildPdfFromPngsImpl(sources, fileName, options) {
    const JsPdf = global.jspdf && global.jspdf.jsPDF
      ? global.jspdf.jsPDF
      : global.jsPDF;
    if (typeof JsPdf !== "function") {
      throw makeError("SIREN_EXACT_EXPORT_DEPENDENCY", "jsPDF не загружен.");
    }
    const pages = await normalizePngSources(sources, A4_RATIO, options);
    const pdf = new JsPdf({
      orientation: "portrait",
      unit: "mm",
      format: [A4_WIDTH_MM, A4_HEIGHT_MM],
      compress: true,
      putOnlyUsedFonts: true
    });
    if (typeof pdf.setProperties === "function") {
      pdf.setProperties({
        title: titleFromFileName(fileName, "Siren exact export"),
        creator: "Siren"
      });
    }
    pages.forEach(function addPdfPage(page, index) {
      if (index > 0) pdf.addPage([A4_WIDTH_MM, A4_HEIGHT_MM], "portrait");
      pdf.addImage(
        page.dataUrl,
        "PNG",
        0,
        0,
        A4_WIDTH_MM,
        A4_HEIGHT_MM,
        "siren-exact-page-" + (index + 1),
        "FAST"
      );
    });
    return toTypedBlob(pdf.output("blob"), PDF_MIME);
  }

  async function buildPptxFromPngsImpl(sources, fileName, options) {
    if (typeof global.PptxGenJS !== "function") {
      throw makeError("SIREN_EXACT_EXPORT_DEPENDENCY", "PptxGenJS не загружен.");
    }
    const pages = await normalizePngSources(sources, SLIDE_RATIO, options);
    const pptx = new global.PptxGenJS();
    pptx.layout = "LAYOUT_WIDE";
    pptx.author = "Siren";
    pptx.company = "Siren";
    pptx.subject = "Точная копия предпросмотра";
    pptx.title = titleFromFileName(fileName, "Siren exact export");
    pptx.lang = "ru-RU";
    pages.forEach(function addPptxSlide(page) {
      const slide = pptx.addSlide();
      slide.background = { color: "FFFFFF" };
      slide.addImage({
        data: page.dataUrl,
        x: 0,
        y: 0,
        w: SLIDE_WIDTH_IN,
        h: SLIDE_HEIGHT_IN
      });
    });
    const output = await pptx.write({ outputType: "blob", compression: true });
    return removeMissingPptxContentTypes(await toTypedBlob(output, PPTX_MIME));
  }

  async function removeMissingPptxContentTypes(blob) {
    if (typeof global.JSZip !== "function") return blob;
    const zip = await global.JSZip.loadAsync(await blob.arrayBuffer());
    let changed = false;
    const contentTypesFile = zip.file("[Content_Types].xml");
    if (contentTypesFile) {
      const source = await contentTypesFile.async("string");
      const cleaned = source.replace(/<Override\b[^>]*\bPartName="\/([^\"]+)"[^>]*\/>/g, function keepExisting(entry, partName) {
        return zip.file(partName) ? entry : "";
      });
      if (cleaned !== source) {
        zip.file("[Content_Types].xml", cleaned);
        changed = true;
      }
    }
    const presentationFile = zip.file("ppt/presentation.xml");
    if (presentationFile) {
      const source = await presentationFile.async("string");
      const notesMatch = source.match(/<p:notesMasterIdLst>[\s\S]*?<\/p:notesMasterIdLst>/);
      if (notesMatch && source.indexOf(notesMatch[0]) > source.indexOf("<p:sldIdLst>")) {
        const withoutNotes = source.replace(notesMatch[0], "");
        const cleaned = withoutNotes.replace("<p:sldIdLst>", notesMatch[0] + "<p:sldIdLst>");
        zip.file("ppt/presentation.xml", cleaned);
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

  function validXmlString(value) {
    let result = "";
    for (const character of String(value == null ? "" : value)) {
      const codePoint = character.codePointAt(0);
      if (
        codePoint === 0x9 ||
        codePoint === 0xA ||
        codePoint === 0xD ||
        (codePoint >= 0x20 && codePoint <= 0xD7FF) ||
        (codePoint >= 0xE000 && codePoint <= 0xFFFD) ||
        (codePoint >= 0x10000 && codePoint <= 0x10FFFF)
      ) {
        result += character;
      } else {
        result += "\uFFFD";
      }
    }
    return result;
  }

  function escapeXml(value) {
    return validXmlString(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  function xmlDeclaration() {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  }

  function docxContentTypesXml() {
    return xmlDeclaration() +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Default Extension="png" ContentType="image/png"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
      '</Types>';
  }

  function docxRootRelationshipsXml() {
    return xmlDeclaration() +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rIdDocument" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '<Relationship Id="rIdCore" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
      '</Relationships>';
  }

  function docxDocumentRelationshipsXml(pageCount) {
    let relationships = "";
    for (let index = 0; index < pageCount; index += 1) {
      relationships +=
        '<Relationship Id="rIdPage' + (index + 1) +
        '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"' +
        ' Target="media/page' + (index + 1) + '.png"/>';
    }
    return xmlDeclaration() +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      relationships +
      '</Relationships>';
  }

  function docxCorePropertiesXml(fileName) {
    const timestamp = new Date().toISOString();
    return xmlDeclaration() +
      '<cp:coreProperties' +
      ' xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"' +
      ' xmlns:dc="http://purl.org/dc/elements/1.1/"' +
      ' xmlns:dcterms="http://purl.org/dc/terms/"' +
      ' xmlns:dcmitype="http://purl.org/dc/dcmitype/"' +
      ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      '<dc:title>' + escapeXml(titleFromFileName(fileName, "Siren exact export")) + '</dc:title>' +
      '<dc:creator>Siren</dc:creator>' +
      '<cp:lastModifiedBy>Siren</cp:lastModifiedBy>' +
      '<dcterms:created xsi:type="dcterms:W3CDTF">' + escapeXml(timestamp) + '</dcterms:created>' +
      '<dcterms:modified xsi:type="dcterms:W3CDTF">' + escapeXml(timestamp) + '</dcterms:modified>' +
      '</cp:coreProperties>';
  }

  function docxPageDrawingXml(pageNumber) {
    const pageName = escapeXml("Страница " + pageNumber);
    const pageBreakBefore = pageNumber > 1 ? '<w:pageBreakBefore/>' : "";
    return '<w:p>' +
      '<w:pPr>' + pageBreakBefore + '<w:spacing w:before="0" w:after="0" w:line="1" w:lineRule="exact"/></w:pPr>' +
      '<w:r><w:rPr><w:noProof/></w:rPr><w:drawing>' +
      '<wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0"' +
      ' relativeHeight="251658240" behindDoc="0" locked="1" layoutInCell="1" allowOverlap="1">' +
      '<wp:simplePos x="0" y="0"/>' +
      '<wp:positionH relativeFrom="page"><wp:posOffset>0</wp:posOffset></wp:positionH>' +
      '<wp:positionV relativeFrom="page"><wp:posOffset>0</wp:posOffset></wp:positionV>' +
      '<wp:extent cx="' + A4_WIDTH_EMU + '" cy="' + A4_HEIGHT_EMU + '"/>' +
      '<wp:effectExtent l="0" t="0" r="0" b="0"/>' +
      '<wp:wrapNone/>' +
      '<wp:docPr id="' + pageNumber + '" name="' + pageName + '" descr="' + pageName + '"/>' +
      '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
      '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
      '<pic:pic>' +
      '<pic:nvPicPr><pic:cNvPr id="' + pageNumber + '" name="' + pageName + '"/>' +
      '<pic:cNvPicPr><a:picLocks noChangeAspect="1" noChangeArrowheads="1"/></pic:cNvPicPr></pic:nvPicPr>' +
      '<pic:blipFill><a:blip r:embed="rIdPage' + pageNumber + '" cstate="print"/>' +
      '<a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
      '<pic:spPr bwMode="auto"><a:xfrm><a:off x="0" y="0"/>' +
      '<a:ext cx="' + A4_WIDTH_EMU + '" cy="' + A4_HEIGHT_EMU + '"/></a:xfrm>' +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></pic:spPr>' +
      '</pic:pic></a:graphicData></a:graphic>' +
      '</wp:anchor>' +
      '</w:drawing></w:r>' +
      '</w:p>';
  }

  function docxDocumentXml(pageCount) {
    let pages = "";
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      pages += docxPageDrawingXml(pageNumber);
    }
    return xmlDeclaration() +
      '<w:document' +
      ' xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"' +
      ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"' +
      ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"' +
      ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"' +
      ' xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
      '<w:body>' + pages +
      '<w:sectPr>' +
      '<w:pgSz w:w="' + A4_WIDTH_TWIPS + '" w:h="' + A4_HEIGHT_TWIPS + '" w:orient="portrait"/>' +
      '<w:pgMar w:top="0" w:right="0" w:bottom="0" w:left="0" w:header="0" w:footer="0" w:gutter="0"/>' +
      '<w:cols w:space="0"/>' +
      '</w:sectPr>' +
      '</w:body></w:document>';
  }

  async function buildDocxFromPngsImpl(sources, fileName, options) {
    if (typeof global.JSZip !== "function") {
      throw makeError("SIREN_EXACT_EXPORT_DEPENDENCY", "JSZip не загружен.");
    }
    const pages = await normalizePngSources(sources, A4_RATIO, options);
    const zip = new global.JSZip();
    zip.file("[Content_Types].xml", docxContentTypesXml());
    zip.file("_rels/.rels", docxRootRelationshipsXml());
    zip.file("docProps/core.xml", docxCorePropertiesXml(fileName));
    zip.file("word/document.xml", docxDocumentXml(pages.length));
    zip.file("word/_rels/document.xml.rels", docxDocumentRelationshipsXml(pages.length));
    pages.forEach(function addDocxImage(page, index) {
      zip.file("word/media/page" + (index + 1) + ".png", page.bytes, {
        binary: true,
        compression: "STORE"
      });
    });
    const output = await zip.generateAsync({
      type: "blob",
      mimeType: DOCX_MIME,
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
      platform: "DOS"
    });
    return toTypedBlob(output, DOCX_MIME);
  }

  async function buildPdfFromPngs(sources, fileName, options) {
    return runExclusive(function buildPdfOperation() {
      return buildPdfFromPngsImpl(sources, fileName, options);
    });
  }

  async function buildPptxFromPngs(sources, fileName, options) {
    return runExclusive(function buildPptxOperation() {
      return buildPptxFromPngsImpl(sources, fileName, options);
    });
  }

  async function buildDocxFromPngs(sources, fileName, options) {
    return runExclusive(function buildDocxOperation() {
      return buildDocxFromPngsImpl(sources, fileName, options);
    });
  }

  async function exportPdf(elements, fileName) {
    return runExclusive(async function exportPdfOperation() {
      const captures = await captureElementsImpl(elements, { format: "a4" });
      return buildPdfFromPngsImpl(captures, fileName);
    });
  }

  async function exportPptx(elements, fileName) {
    return runExclusive(async function exportPptxOperation() {
      const captures = await captureElementsImpl(elements, { format: "16:9" });
      return buildPptxFromPngsImpl(captures, fileName);
    });
  }

  async function exportDocx(elements, fileName) {
    return runExclusive(async function exportDocxOperation() {
      const captures = await captureElementsImpl(elements, { format: "a4" });
      return buildDocxFromPngsImpl(captures, fileName);
    });
  }

  global.SirenExactExport = {
    captureElements: captureElements,
    inspectElements: inspectElements,
    exportPdf: exportPdf,
    exportPptx: exportPptx,
    exportDocx: exportDocx,
    buildPdfFromPngs: buildPdfFromPngs,
    buildPptxFromPngs: buildPptxFromPngs,
    buildDocxFromPngs: buildDocxFromPngs,
    isBusy: function isBusy() { return busy; },
    BUSY_ERROR_CODE: BUSY_ERROR_CODE,
    formats: Object.freeze({
      a4: Object.freeze({ widthMm: A4_WIDTH_MM, heightMm: A4_HEIGHT_MM, aspectRatio: A4_RATIO }),
      slide16x9: Object.freeze({ widthIn: SLIDE_WIDTH_IN, heightIn: SLIDE_HEIGHT_IN, aspectRatio: SLIDE_RATIO })
    })
  };
})(typeof window !== "undefined" ? window : globalThis);
