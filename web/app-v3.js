(function initSirenApp(global) {
  "use strict";

  const STORAGE_KEY = "siren-ai-instruction-draft-v1";
  const LEGACY_STORAGE_KEY = "siren-ai-instruction-draft-legacy";
  const DB_NAME = "siren-ai-assets-v1";
  const DB_STORE = "screenshots";
  const DB_VERSION = 1;
  const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
  const ACCEPTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
  const CHANNEL_LABELS = Object.freeze({ ios: "iOS", android: "Android", web: "веб-ЛК" });
  const ROLE_LABELS = Object.freeze({ before: "Было", after: "Стало", step: "Шаг", scheme: "Схема" });
  const COLOR_PALETTE = Object.freeze({
    ink: "#151922",
    blue: "#1f5b8f",
    teal: "#0f766e",
    red: "#c7182f"
  });
  const COLOR_LABELS = Object.freeze({
    ink: "\u043e\u0441\u043d\u043e\u0432\u043d\u043e\u0439",
    blue: "\u0441\u0438\u043d\u0438\u0439",
    teal: "\u0437\u0435\u043b\u0435\u043d\u044b\u0439",
    red: "\u043a\u0440\u0430\u0441\u043d\u044b\u0439"
  });

  const Model = global.SirenModel;
  const Examples = global.SirenExamples;
  let state;
  let assetDb = null;
  let storageMode = "indexeddb";
  let saveTimer = 0;
  let previewTimer = 0;
  let previewRevision = 0;
  let currentPreviewMode = "document";
  let confirmCallback = null;
  let lastDialogTrigger = null;
  let exportRunning = false;
  let migratedLegacyDraft = false;
  let paginationWarnings = [];

  const $ = (selector, root) => (root || document).querySelector(selector);
  const $$ = (selector, root) => Array.from((root || document).querySelectorAll(selector));

  function createId(prefix) {
    if (global.crypto && typeof global.crypto.randomUUID === "function") {
      return `${prefix}-${global.crypto.randomUUID()}`;
    }
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function deepClone(value) {
    if (Model && typeof Model.deepClone === "function") return Model.deepClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function blankChange() {
    if (Examples && typeof Examples.createBlankChange === "function") return Examples.createBlankChange();
    return {
      id: createId("change"), title: "", channels: [], location: "", availability: "",
      before: "", after: "", clientAction: "", supportNote: "", screenshots: []
    };
  }

  function blankDraft() {
    if (Examples && typeof Examples.createBlankDraft === "function") return Examples.createBlankDraft();
    return {
      schemaVersion: 3,
      title: "",
      releaseDate: "",
      rolloutMode: "",
      rolloutConditions: "",
      changes: [blankChange()],
      support: { say: "", dontSay: "", details: "", faq: [] }
    };
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function appendTextLine(parent, label, value, className) {
    if (!plainText(value).trim()) return null;
    const node = element("div", className || "");
    const strong = element("strong", "", label);
    node.append(strong, document.createTextNode(String(value)));
    parent.append(node);
    return node;
  }

  function isAllowedColor(value) {
    const compact = String(value || "").toLowerCase().replace(/\s+/g, "");
    const map = {
      "#151922": COLOR_PALETTE.ink,
      "rgb(21,25,34)": COLOR_PALETTE.ink,
      "#1f5b8f": COLOR_PALETTE.blue,
      "rgb(31,91,143)": COLOR_PALETTE.blue,
      "#0f766e": COLOR_PALETTE.teal,
      "rgb(15,118,110)": COLOR_PALETTE.teal,
      "#c7182f": COLOR_PALETTE.red,
      "rgb(199,24,47)": COLOR_PALETTE.red
    };
    return map[compact] || "";
  }

  function plainText(value) {
    const source = value === null || value === undefined ? "" : String(value);
    if (!source.includes("<")) return source.replace(/\u00a0/g, " ");
    const parsed = new DOMParser().parseFromString(source, "text/html");
    return (parsed.body.textContent || "").replace(/\u00a0/g, " ");
  }

  function appendPlainParagraphs(fragment, value) {
    const source = String(value || "").replace(/\r\n?/g, "\n");
    if (!source) return;
    const groups = source.split(/\n{2,}/);
    groups.forEach((group) => {
      const paragraph = document.createElement("p");
      const lines = group.split("\n");
      lines.forEach((line, index) => {
        if (index) paragraph.append(document.createElement("br"));
        paragraph.append(document.createTextNode(line));
      });
      fragment.append(paragraph);
    });
  }

  function cloneSafeNode(node, target) {
    if (node.nodeType === Node.TEXT_NODE) {
      target.append(document.createTextNode(node.nodeValue || ""));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const tag = node.tagName.toLowerCase();
    if (["script", "style", "noscript", "iframe", "object", "embed"].includes(tag)) return;
    const tagMap = {
      p: "p", div: "p", br: "br", strong: "strong", b: "strong", em: "em", i: "em",
      ul: "ul", ol: "ol", li: "li", span: "span"
    };
    const safeTag = tagMap[tag];
    if (!safeTag) {
      Array.from(node.childNodes).forEach((child) => cloneSafeNode(child, target));
      return;
    }

    const safe = document.createElement(safeTag);
    if (safeTag === "span") {
      const color = isAllowedColor(node.style && node.style.color);
      if (color) safe.style.color = color;
    }
    Array.from(node.childNodes).forEach((child) => cloneSafeNode(child, safe));
    target.append(safe);
  }

  function safeRichFragment(value) {
    const fragment = document.createDocumentFragment();
    const source = value === null || value === undefined ? "" : String(value);
    if (!/<\/?[a-z][\s\S]*>/i.test(source)) {
      appendPlainParagraphs(fragment, source);
      return fragment;
    }
    const parsed = new DOMParser().parseFromString(source, "text/html");
    Array.from(parsed.body.childNodes).forEach((node) => cloneSafeNode(node, fragment));
    return fragment;
  }

  function serializeRichEditor(editor) {
    const fragment = document.createDocumentFragment();
    Array.from(editor.childNodes).forEach((node) => cloneSafeNode(node, fragment));
    const holder = document.createElement("div");
    holder.append(fragment);
    const text = (holder.textContent || "").replace(/\u200b/g, "").trim();
    return text ? holder.innerHTML : "";
  }

  function setRichValue(editor, value) {
    editor.replaceChildren(safeRichFragment(value));
  }

  function insertPlainText(editor, text) {
    const selection = global.getSelection();
    if (!selection || !selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    const owner = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
    if (!owner || !editor.contains(owner)) return;

    range.deleteContents();
    const fragment = document.createDocumentFragment();
    let lastNode = null;
    String(text || "").replace(/\r\n?/g, "\n").split("\n").forEach((line, index) => {
      if (index) {
        const br = document.createElement("br");
        fragment.append(br);
        lastNode = br;
      }
      if (line) {
        const textNode = document.createTextNode(line);
        fragment.append(textNode);
        lastNode = textNode;
      }
    });
    range.insertNode(fragment);
    if (lastNode) {
      const caret = document.createRange();
      caret.setStartAfter(lastNode);
      caret.collapse(true);
      selection.removeAllRanges();
      selection.addRange(caret);
    }
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  }

  function selectedRangeFor(editor) {
    const selection = global.getSelection();
    if (!selection || !selection.rangeCount) return null;
    const range = selection.getRangeAt(0);
    const owner = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
    if (!owner || !editor.contains(owner)) return null;
    return { selection, range };
  }

  function applyInlineFormat(editor, tagName, color) {
    const selected = selectedRangeFor(editor);
    if (!selected || selected.range.collapsed) {
      showToast("Сначала выделите текст, который нужно оформить.");
      editor.focus();
      return;
    }
    const wrapper = document.createElement(tagName);
    if (color) wrapper.style.color = color;
    wrapper.append(selected.range.extractContents());
    selected.range.insertNode(wrapper);
    const range = document.createRange();
    range.selectNodeContents(wrapper);
    selected.selection.removeAllRanges();
    selected.selection.addRange(range);
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "format" }));
  }

  function applyListFormat(editor) {
    const selected = selectedRangeFor(editor);
    if (!selected) return;
    const replaceWholeEditor = selected.range.collapsed;
    let source = selected.range.toString().trim();
    if (replaceWholeEditor) source = editor.textContent.trim();
    if (!source) {
      showToast("Введите или выделите текст для списка.");
      return;
    }
    const list = document.createElement("ul");
    source.split(/\n+/).map((line) => line.trim()).filter(Boolean).forEach((line) => {
      const item = document.createElement("li");
      item.textContent = line.replace(/^[-*•]\s*/, "");
      list.append(item);
    });
    const insertionRange = replaceWholeEditor ? document.createRange() : selected.range;
    if (replaceWholeEditor) insertionRange.selectNodeContents(editor);
    insertionRange.deleteContents();
    insertionRange.insertNode(list);
    const range = document.createRange();
    range.selectNodeContents(list);
    range.collapse(false);
    selected.selection.removeAllRanges();
    selected.selection.addRange(range);
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "format" }));
  }

  function clearSelectedFormat(editor) {
    const selected = selectedRangeFor(editor);
    if (!selected || selected.range.collapsed) {
      showToast("Сначала выделите текст, у которого нужно убрать оформление.");
      return;
    }
    const textNode = document.createTextNode(selected.range.toString());
    selected.range.deleteContents();
    selected.range.insertNode(textNode);
    const range = document.createRange();
    range.selectNodeContents(textNode);
    selected.selection.removeAllRanges();
    selected.selection.addRange(range);
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "format" }));
  }

  function buildToolbar(toolbar, editor) {
    toolbar.replaceChildren();
    const commands = [
      { action: "bold", label: "Жирный", text: "Ж", title: "Жирный текст" },
      { action: "italic", label: "Курсив", text: "К", title: "Курсив" },
      { action: "list", label: "Маркированный список", text: "•", title: "Маркированный список" },
      { action: "clear", label: "Очистить оформление", text: "Tx", title: "Очистить оформление" }
    ];
    commands.forEach((command) => {
      const button = element("button", "format-button", command.text);
      button.type = "button";
      button.dataset.format = command.action;
      button.setAttribute("aria-label", command.label);
      button.title = command.title;
      toolbar.append(button);
    });
    toolbar.append(element("span", "toolbar-separator"));
    Object.entries(COLOR_PALETTE).forEach(([name, color]) => {
      const button = element("button", "format-button color-swatch", "Цвет");
      button.type = "button";
      button.dataset.format = "color";
      button.dataset.color = color;
      button.style.setProperty("--swatch", color);
      const colorName = COLOR_LABELS[name] || name;
      button.setAttribute("aria-label", `Цвет текста: ${colorName}`);
      button.title = `Цвет текста: ${colorName}`;
      toolbar.append(button);
    });
    if (!toolbar.dataset.bound) {
      toolbar.addEventListener("mousedown", (event) => event.preventDefault());
      toolbar.addEventListener("click", (event) => {
        const button = event.target.closest("button[data-format]");
        if (!button || button.disabled) return;
        const activeEditor = $(".rich-editor", toolbar.parentElement);
        if (!activeEditor) return;
        const action = button.dataset.format;
        if (action === "bold") applyInlineFormat(activeEditor, "strong");
        else if (action === "italic") applyInlineFormat(activeEditor, "em");
        else if (action === "list") applyListFormat(activeEditor);
        else if (action === "clear") clearSelectedFormat(activeEditor);
        else if (action === "color") applyInlineFormat(activeEditor, "span", button.dataset.color);
      });
      toolbar.dataset.bound = "true";
    }
  }

  function bindRichEditor(editor) {
    editor.addEventListener("paste", (event) => {
      event.preventDefault();
      insertPlainText(editor, event.clipboardData ? event.clipboardData.getData("text/plain") : "");
    });
    editor.addEventListener("keydown", (event) => {
      if (!(event.ctrlKey || event.metaKey) || event.isComposing) return;
      const key = event.key.toLowerCase();
      if (key !== "b" && key !== "i") return;
      event.preventDefault();
      applyInlineFormat(editor, key === "b" ? "strong" : "em");
    });
  }

  function autoGrow(textarea) {
    if (!textarea || textarea.tagName !== "TEXTAREA") return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(360, Math.max(74, textarea.scrollHeight))}px`;
  }

  function setSaveState(mode, text) {
    const container = $("#saveState");
    const label = $("#saveStateText");
    if (!container || !label) return;
    container.dataset.state = mode;
    label.textContent = text;
  }

  function showToast(message, tone) {
    const region = $("#toastRegion");
    if (!region) return;
    const toast = element("div", `toast${tone === "error" ? " error" : ""}`, message);
    region.replaceChildren(toast);
    global.setTimeout(() => {
      if (toast.isConnected) toast.remove();
    }, 4800);
  }

  function openDatabase() {
    return new Promise((resolve) => {
      if (!global.indexedDB) {
        storageMode = "localstorage";
        resolve(null);
        return;
      }
      const request = global.indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE, { keyPath: "id" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        storageMode = "localstorage";
        resolve(null);
      };
      request.onblocked = () => {
        storageMode = "localstorage";
        resolve(null);
      };
    });
  }

  function assetOperation(mode, callback) {
    if (!assetDb) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const transaction = assetDb.transaction(DB_STORE, mode);
      const store = transaction.objectStore(DB_STORE);
      let request;
      try {
        request = callback(store);
      } catch (error) {
        reject(error);
        return;
      }
      transaction.oncomplete = () => resolve(request && request.result);
      transaction.onerror = () => reject(transaction.error || new Error("Не удалось сохранить скриншот"));
      transaction.onabort = () => reject(transaction.error || new Error("Сохранение скриншота отменено"));
    });
  }

  function putAsset(screenshot) {
    if (!screenshot || !screenshot.id || !screenshot.dataUrl) return Promise.resolve();
    return assetOperation("readwrite", (store) => store.put({
      id: screenshot.id,
      dataUrl: screenshot.dataUrl,
      width: screenshot.width || 0,
      height: screenshot.height || 0,
      updatedAt: Date.now()
    }));
  }

  function getAsset(id) {
    return assetOperation("readonly", (store) => store.get(id));
  }

  function deleteAsset(id) {
    return assetOperation("readwrite", (store) => store.delete(id));
  }

  function clearAssets() {
    return assetOperation("readwrite", (store) => store.clear());
  }

  function loadDraft() {
    let rawV3 = "";
    let rawLegacy = "";
    try {
      rawV3 = global.localStorage.getItem(STORAGE_KEY) || "";
      rawLegacy = global.localStorage.getItem(LEGACY_STORAGE_KEY) || "";
    } catch (error) {
      storageMode = "memory";
    }
    if (rawV3) {
      try {
        return Model.normalizeState(JSON.parse(rawV3));
      } catch (error) {
        showToast("Локальный черновик поврежден. Открыт чистый черновик.", "error");
      }
    }
    if (rawLegacy) {
      try {
        migratedLegacyDraft = true;
        return Model.migrateLegacy(JSON.parse(rawLegacy));
      } catch (error) {
        showToast("Старый черновик не удалось перенести. Открыт чистый черновик.", "error");
      }
    }
    return Model.normalizeState(blankDraft());
  }

  async function hydrateScreenshotAssets() {
    const tasks = [];
    state.changes.forEach((change) => {
      change.screenshots.forEach((screenshot) => {
        if (screenshot.dataUrl) {
          tasks.push(putAsset(screenshot));
          return;
        }
        tasks.push(getAsset(screenshot.id).then((asset) => {
          if (!asset) return;
          screenshot.dataUrl = asset.dataUrl || "";
          screenshot.width = screenshot.width || asset.width || 0;
          screenshot.height = screenshot.height || asset.height || 0;
        }));
      });
    });
    await Promise.allSettled(tasks);
  }

  function persistedState() {
    if (storageMode === "indexeddb" && Model) return Model.stripImagesForStorage(state);
    return deepClone(state);
  }

  function persistNow() {
    global.clearTimeout(saveTimer);
    setSaveState("saving", "Сохраняю локально…");
    try {
      global.localStorage.setItem(STORAGE_KEY, JSON.stringify(persistedState()));
      if (migratedLegacyDraft) {
        global.localStorage.removeItem(LEGACY_STORAGE_KEY);
        migratedLegacyDraft = false;
      }
      setSaveState("saved", storageMode === "memory" ? "Черновик хранится только до закрытия" : "Черновик сохранен локально");
    } catch (error) {
      setSaveState("error", "Не удалось сохранить черновик");
      showToast("Не удалось сохранить черновик. Удалите лишние изображения или проверьте доступ к хранилищу.", "error");
    }
  }

  function schedulePersist() {
    global.clearTimeout(saveTimer);
    setSaveState("saving", "Сохраняю локально…");
    saveTimer = global.setTimeout(persistNow, 520);
  }

  function schedulePreview() {
    const revision = ++previewRevision;
    global.clearTimeout(previewTimer);
    previewTimer = global.setTimeout(() => {
      if (revision !== previewRevision) return;
      renderPreviews();
    }, 180);
  }

  function scheduleUpdate() {
    schedulePersist();
    schedulePreview();
  }

  function safeDomId(value) {
    return String(value || "item").replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 80);
  }

  function findChange(id) {
    return state.changes.find((change) => change.id === id) || null;
  }

  function findScreenshot(change, id) {
    return change && change.screenshots.find((image) => image.id === id) || null;
  }

  function setBoundFields() {
    $$('[data-bind="title"], [data-bind="releaseDate"], [data-bind="rolloutMode"], [data-bind="rolloutConditions"]').forEach((input) => {
      input.value = state[input.dataset.bind] || "";
      autoGrow(input);
    });
  }

  function renderSupportFields() {
    $$('[data-rich-editor^="support."]').forEach((editor) => {
      const key = editor.dataset.richEditor.split(".")[1];
      setRichValue(editor, state.support[key] || "");
      const toolbar = $(".format-toolbar", editor.closest(".rich-field"));
      if (toolbar) buildToolbar(toolbar, editor);
      if (!editor.dataset.bound) {
        bindRichEditor(editor);
        editor.dataset.bound = "true";
      }
    });
  }

  function renderImageItem(change, screenshot, index) {
    const template = $("#imageTemplate");
    const item = template.content.firstElementChild.cloneNode(true);
    const sid = safeDomId(screenshot.id);
    item.dataset.imageId = screenshot.id;
    item.dataset.changeId = change.id;

    const image = $("img", item);
    if (screenshot.dataUrl) image.src = screenshot.dataUrl;
    image.alt = screenshot.title
      ? `${ROLE_LABELS[screenshot.role] || "Скриншот"}: ${screenshot.title}`
      : `${ROLE_LABELS[screenshot.role] || "Скриншот"} ${index + 1}`;

    $$('[data-image-field]', item).forEach((field) => {
      const key = field.dataset.imageField;
      field.value = screenshot[key] || (key === "role" ? "step" : "");
      field.id = `shot-${sid}-${key}`;
      const label = $(`[data-image-label="${key}"]`, item);
      if (label) label.htmlFor = field.id;
      autoGrow(field);
    });

    $(".image-up", item).disabled = index === 0;
    $(".image-down", item).disabled = index === change.screenshots.length - 1;
    return item;
  }

  function renderChangeCard(change, index) {
    const template = $("#changeTemplate");
    const card = template.content.firstElementChild.cloneNode(true);
    const cid = safeDomId(change.id);
    card.dataset.changeId = change.id;
    $(".change-index", card).textContent = String(index + 1).padStart(2, "0");
    $(".change-title-preview", card).textContent = plainText(change.title).trim() || "Без названия";
    $(".move-up", card).disabled = index === 0;
    $(".move-down", card).disabled = index === state.changes.length - 1;

    $$('[data-change-field]', card).forEach((field) => {
      const key = field.dataset.changeField;
      field.value = change[key] || "";
      field.id = `change-${cid}-${key}`;
      const label = $(`[data-label="${key}"]`, card);
      if (label) label.htmlFor = field.id;
      autoGrow(field);
    });

    $$('[data-channel]', card).forEach((checkbox) => {
      checkbox.checked = change.channels.includes(checkbox.value);
      checkbox.id = `change-${cid}-channel-${checkbox.value}`;
      const label = checkbox.closest("label");
      if (label) label.htmlFor = checkbox.id;
    });

    $$('[data-change-rich]', card).forEach((editor) => {
      const key = editor.dataset.changeRich;
      editor.id = `change-${cid}-${key}`;
      editor.setAttribute("aria-label", `${key === "before" ? "Как было" : "Как стало"}: ${plainText(change.title).trim() || `изменение ${index + 1}`}`);
      setRichValue(editor, change[key] || "");
      const toolbar = $(".format-toolbar", editor.closest(".rich-field"));
      if (toolbar) buildToolbar(toolbar, editor);
      bindRichEditor(editor);
    });

    const imageInput = $(".image-input", card);
    imageInput.id = `change-${cid}-images`;
    const imageList = $("[data-image-list]", card);
    change.screenshots.forEach((screenshot, screenshotIndex) => {
      imageList.append(renderImageItem(change, screenshot, screenshotIndex));
    });
    return card;
  }

  function renderChanges() {
    const list = $("#changeList");
    const fragment = document.createDocumentFragment();
    state.changes.forEach((change, index) => fragment.append(renderChangeCard(change, index)));
    list.replaceChildren(fragment);
  }

  function renderFaqItem(item, index) {
    const template = $("#faqTemplate");
    const node = template.content.firstElementChild.cloneNode(true);
    const fid = safeDomId(item.id);
    node.dataset.faqId = item.id;
    $(".faq-index", node).textContent = String(index + 1);
    $$('[data-faq-field]', node).forEach((field) => {
      const key = field.dataset.faqField;
      field.value = item[key] || "";
      field.id = `faq-${fid}-${key}`;
      const label = $(`[data-faq-label="${key}"]`, node);
      if (label) label.htmlFor = field.id;
      autoGrow(field);
    });
    $(".faq-up", node).disabled = index === 0;
    $(".faq-down", node).disabled = index === state.support.faq.length - 1;
    return node;
  }

  function renderFaq() {
    const list = $("#faqList");
    const fragment = document.createDocumentFragment();
    state.support.faq.forEach((item, index) => fragment.append(renderFaqItem(item, index)));
    if (!state.support.faq.length) {
      const empty = element("p", "field-help", "FAQ пока пуст. Добавьте вопрос, если он действительно нужен коллегам.");
      empty.dataset.faqEmpty = "true";
      fragment.append(empty);
    }
    list.replaceChildren(fragment);
  }

  function renderForm() {
    setBoundFields();
    renderChanges();
    renderSupportFields();
    renderFaq();
    clearValidationPresentation();
  }

  function updateStateFromControl(control) {
    if (control.matches("[data-bind]")) {
      state[control.dataset.bind] = control.value;
      if (control.dataset.bind === "title") {
        document.title = `${plainText(control.value).trim() || "Новая инструкция"} — Siren AI`;
      }
      return true;
    }

    const card = control.closest("[data-change-card]");
    if (card) {
      const change = findChange(card.dataset.changeId);
      if (!change) return false;
      if (control.matches("[data-change-field]")) {
        change[control.dataset.changeField] = control.value;
        if (control.dataset.changeField === "title") {
          $(".change-title-preview", card).textContent = plainText(control.value).trim() || "Без названия";
          $$('[data-change-rich]', card).forEach((editor) => {
            const label = editor.dataset.changeRich === "before" ? "Как было" : "Как стало";
            editor.setAttribute("aria-label", `${label}: ${plainText(control.value).trim() || "изменение"}`);
          });
        }
        return true;
      }
      if (control.matches("[data-channel]")) {
        change.channels = $$('[data-channel]:checked', card).map((checkbox) => checkbox.value);
        return true;
      }
      if (control.matches("[data-change-rich]")) {
        change[control.dataset.changeRich] = serializeRichEditor(control);
        return true;
      }
      if (control.matches("[data-image-field]")) {
        const item = control.closest("[data-image-item]");
        const screenshot = findScreenshot(change, item && item.dataset.imageId);
        if (!screenshot) return false;
        screenshot[control.dataset.imageField] = control.value;
        if (["title", "role"].includes(control.dataset.imageField)) {
          const image = $("img", item);
          image.alt = screenshot.title
            ? `${ROLE_LABELS[screenshot.role] || "Скриншот"}: ${screenshot.title}`
            : ROLE_LABELS[screenshot.role] || "Скриншот";
        }
        return true;
      }
    }

    if (control.matches('[data-rich-editor^="support."]')) {
      const key = control.dataset.richEditor.split(".")[1];
      state.support[key] = serializeRichEditor(control);
      return true;
    }

    const faqItem = control.closest("[data-faq-item]");
    if (faqItem && control.matches("[data-faq-field]")) {
      const faq = state.support.faq.find((entry) => entry.id === faqItem.dataset.faqId);
      if (!faq) return false;
      faq[control.dataset.faqField] = control.value;
      return true;
    }
    return false;
  }

  function moveItem(array, from, to) {
    if (from < 0 || to < 0 || from >= array.length || to >= array.length || from === to) return false;
    const [item] = array.splice(from, 1);
    array.splice(to, 0, item);
    return true;
  }

  async function duplicateChange(change) {
    const copy = deepClone(change);
    copy.id = createId("change");
    copy.title = plainText(copy.title).trim() ? `${plainText(copy.title).trim()} — копия` : "";
    copy.screenshots = copy.screenshots.map((screenshot) => ({ ...screenshot, id: createId("shot") }));
    const stored = await Promise.allSettled(copy.screenshots.map(putAsset));
    if (stored.some((result) => result.status === "rejected")) {
      await Promise.allSettled(copy.screenshots.map((screenshot) => deleteAsset(screenshot.id)));
      showToast("Не удалось сохранить копии скриншотов. Карточка не продублирована.", "error");
      return;
    }
    const index = state.changes.indexOf(change);
    state.changes.splice(index + 1, 0, copy);
    renderChanges();
    scheduleUpdate();
    const nextCard = $(`[data-change-card][data-change-id="${CSS.escape(copy.id)}"]`);
    if (nextCard) nextCard.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function openConfirm(options) {
    const dialog = $("#confirmDialog");
    lastDialogTrigger = document.activeElement;
    $("#confirmDialogTitle").textContent = options.title;
    $("#confirmDialogText").textContent = options.text;
    const action = $("#confirmActionBtn");
    action.textContent = options.actionLabel;
    action.className = `button ${options.intent === "warning" ? "secondary" : "danger"}`;
    confirmCallback = options.onConfirm;
    dialog.showModal();
    global.setTimeout(() => $("#confirmCancelBtn").focus(), 0);
  }

  function closeConfirm() {
    const dialog = $("#confirmDialog");
    if (dialog.open) dialog.close();
    confirmCallback = null;
    if (lastDialogTrigger && lastDialogTrigger.isConnected) lastDialogTrigger.focus();
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error("Не удалось прочитать файл"));
      reader.readAsDataURL(file);
    });
  }

  function readImageSize(dataUrl) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve({ width: image.naturalWidth || 0, height: image.naturalHeight || 0 });
      image.onerror = () => reject(new Error("Изображение повреждено"));
      image.src = dataUrl;
    });
  }

  async function addImageFiles(change, files, role) {
    const selected = Array.from(files || []);
    if (!selected.length) return;
    const added = [];
    const failures = [];
    for (const file of selected) {
      if (!ACCEPTED_IMAGE_TYPES.has(file.type)) {
        failures.push(`${file.name}: поддерживаются PNG, JPG и WebP`);
        continue;
      }
      if (!file.size || file.size > MAX_IMAGE_BYTES) {
        failures.push(`${file.name}: размер должен быть от 1 байта до 20 МБ`);
        continue;
      }
      try {
        const dataUrl = await readFileAsDataUrl(file);
        const size = await readImageSize(dataUrl);
        const screenshot = {
          id: createId("shot"),
          role: ROLE_LABELS[role] ? role : "step",
          name: file.name,
          title: file.name.replace(/\.[^.]+$/, ""),
          caption: "",
          dataUrl,
          width: size.width,
          height: size.height,
          layout: "half"
        };
        await putAsset(screenshot);
        change.screenshots.push(screenshot);
        added.push(screenshot);
      } catch (error) {
        failures.push(`${file.name}: файл не удалось прочитать`);
      }
    }
    renderChanges();
    scheduleUpdate();
    if (added.length) showToast(`Добавлено скриншотов: ${added.length}`);
    if (failures.length) showToast(failures.join(". "), "error");
  }

  function addFaq() {
    const item = { id: createId("faq"), question: "", answer: "" };
    state.support.faq.push(item);
    renderFaq();
    scheduleUpdate();
    const field = $(`[data-faq-item][data-faq-id="${CSS.escape(item.id)}"] [data-faq-field="question"]`);
    if (field) field.focus();
  }

  function buildSupportDraft() {
    const draft = Model.buildSafeSupportDraft(state);
    if (!plainText(draft.say).trim() && !plainText(draft.details).trim()) {
      showToast("Сначала заполните хотя бы одно изменение.", "error");
      return;
    }
    state.support.say = draft.say;
    state.support.dontSay = draft.dontSay;
    state.support.details = draft.details;
    renderSupportFields();
    scheduleUpdate();
    showToast("Черновик собран только из введенных фактов.");
  }

  function isDraftMeaningful() {
    if ([state.title, state.releaseDate, state.rolloutMode, state.rolloutConditions]
      .some((value) => plainText(value).trim())) return true;
    if ([state.support.say, state.support.dontSay, state.support.details]
      .some((value) => plainText(value).trim())) return true;
    if (state.support.faq.some((item) => plainText(item.question).trim() || plainText(item.answer).trim())) return true;
    return state.changes.some((change) => [
      change.title,
      change.location,
      change.availability,
      change.before,
      change.after,
      change.clientAction,
      change.supportNote
    ].some((value) => plainText(value).trim()) || change.channels.length || change.screenshots.length);
  }

  function formatDate(value) {
    const source = String(value || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(source)) return source;
    const date = new Date(`${source}T00:00:00`);
    if (Number.isNaN(date.getTime())) return source;
    return new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "long", year: "numeric" }).format(date);
  }

  function channelText(channels) {
    return (channels || []).map((channel) => CHANNEL_LABELS[channel] || channel).join(", ");
  }

  function truncateText(value, limit) {
    const source = plainText(value).replace(/\s+/g, " ").trim();
    if (source.length <= limit) return source;
    return `${source.slice(0, Math.max(0, limit - 1)).trim()}…`;
  }

  function splitText(value, limit) {
    const source = plainText(value).replace(/\r\n?/g, "\n").trim();
    if (!source) return [];
    const chunks = [];
    let rest = source;
    while (rest.length > limit) {
      let cut = rest.lastIndexOf(" ", limit);
      if (cut < Math.round(limit * 0.58)) cut = limit;
      chunks.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) chunks.push(rest);
    return chunks;
  }

  function richChunks(value, limit) {
    const holder = document.createElement("div");
    holder.append(safeRichFragment(value));
    const sourceNodes = Array.from(holder.childNodes).filter((node) => (node.textContent || "").trim());
    if (!sourceNodes.length) return [];
    const chunks = [];
    let current = [];
    let cost = 0;
    sourceNodes.forEach((node) => {
      const nodeCost = (node.textContent || "").length + 18;
      if (nodeCost > limit) {
        if (current.length) {
          chunks.push(current);
          current = [];
          cost = 0;
        }
        splitText(node.textContent || "", limit).forEach((part) => {
          const paragraph = document.createElement("p");
          paragraph.textContent = part;
          chunks.push([paragraph]);
        });
        return;
      }
      if (current.length && cost + nodeCost > limit) {
        chunks.push(current);
        current = [];
        cost = 0;
      }
      current.push(node.cloneNode(true));
      cost += nodeCost;
    });
    if (current.length) chunks.push(current);
    return chunks;
  }

  function appendRichNodes(parent, nodes) {
    (nodes || []).forEach((node) => parent.append(node.cloneNode(true)));
  }

  function createDocSection(number, title) {
    const block = element("section", "doc-block doc-section-title");
    block.append(element("span", "", number), document.createTextNode(title));
    return block;
  }

  function createDocCover() {
    const block = element("section", "doc-block doc-cover");
    block.append(element("p", "doc-label", "Инструкция для КЦ и поддержки"));
    block.append(element("h1", "doc-title", plainText(state.title).trim() || "Новая инструкция"));
    block.append(element("p", "doc-subtitle", "Что изменится для пользователей, где находится изменение и при каких условиях оно доступно"));
    const meta = element("div", "doc-meta-row");
    if (state.releaseDate) meta.append(element("span", "doc-meta-pill", `Дата: ${formatDate(state.releaseDate)}`));
    if (state.rolloutMode) meta.append(element("span", "doc-meta-pill", `Запуск: ${plainText(state.rolloutMode)}`));
    const channels = channelText(Model.collectChannels(state));
    if (channels) meta.append(element("span", "doc-meta-pill", `Каналы: ${channels}`));
    if (meta.childNodes.length) block.append(meta);
    return block;
  }

  function createDocRollout() {
    if (!plainText(state.rolloutConditions).trim() && !plainText(state.rolloutMode).trim()) return null;
    const block = element("section", "doc-block doc-rollout");
    block.append(element("strong", "", "Условия запуска"));
    if (state.rolloutMode) block.append(element("p", "", plainText(state.rolloutMode)));
    splitText(state.rolloutConditions, 850).forEach((part) => block.append(element("p", "", part)));
    return block;
  }

  function createChangeHeading(change, index, continuation) {
    const block = element("section", `doc-block doc-change-heading${continuation ? " continuation" : ""}`);
    block.dataset.contextTitle = plainText(change.title).trim() || `Изменение ${index + 1}`;
    block.dataset.contextIndex = String(index + 1);
    block.append(element("div", "doc-change-number", String(index + 1)));
    const copy = element("div");
    copy.append(element("h3", "", `${plainText(change.title).trim() || `Изменение ${index + 1}`}${continuation ? ", продолжение" : ""}`));
    const channels = channelText(change.channels);
    if (channels) copy.append(element("p", "doc-channel-line", channels));
    block.append(copy);
    return block;
  }

  function createFactBlock(change, index, location, availability) {
    const block = element("section", "doc-block doc-fact-grid");
    block.dataset.contextTitle = plainText(change.title).trim() || `Изменение ${index + 1}`;
    block.dataset.contextIndex = String(index + 1);
    const first = element("div", "doc-fact");
    first.append(element("strong", "", "Где находится"), document.createTextNode(location || "Не указано"));
    const second = element("div", "doc-fact");
    second.append(element("strong", "", "Кому и когда доступно"), document.createTextNode(availability || "Не указано"));
    block.append(first, second);
    return block;
  }

  function createCompareBlock(change, index, beforeNodes, afterNodes, partIndex) {
    const block = element("section", "doc-block doc-compare");
    block.dataset.contextTitle = plainText(change.title).trim() || `Изменение ${index + 1}`;
    block.dataset.contextIndex = String(index + 1);
    const before = element("div", "doc-compare-panel");
    before.append(element("h4", "", partIndex ? "Было, продолжение" : "Было"));
    const beforeRich = element("div", "doc-rich");
    if (beforeNodes && beforeNodes.length) appendRichNodes(beforeRich, beforeNodes);
    else beforeRich.append(element("p", "", "Не указано"));
    before.append(beforeRich);

    const after = element("div", "doc-compare-panel after");
    after.append(element("h4", "", partIndex ? "Стало, продолжение" : "Стало"));
    const afterRich = element("div", "doc-rich");
    if (afterNodes && afterNodes.length) appendRichNodes(afterRich, afterNodes);
    else afterRich.append(element("p", "", "Не указано"));
    after.append(afterRich);
    block.append(before, after);
    return block;
  }

  function groupScreenshots(screenshots) {
    const pending = screenshots.filter((shot) => shot && shot.dataUrl).slice();
    const groups = [];
    const isCompact = (shot) => shot.width && shot.height && shot.width / shot.height <= 1.15;
    while (pending.length) {
      const first = pending.shift();
      if (first.role === "before" && isCompact(first)) {
        const match = pending.findIndex((item) => item.role === "after" && isCompact(item));
        if (match >= 0) {
          groups.push([first, pending.splice(match, 1)[0]]);
          continue;
        }
      }
      if ((first.role === "step" || first.role === "scheme") && isCompact(first)
        && pending[0] && pending[0].role === first.role && isCompact(pending[0])) {
        groups.push([first, pending.shift()]);
      } else {
        groups.push([first]);
      }
    }
    return groups;
  }

  function createImageBlock(change, index, images) {
    const block = element("section", `doc-block doc-image-grid${images.length === 1 ? " single" : ""}`);
    block.dataset.contextTitle = plainText(change.title).trim() || `Изменение ${index + 1}`;
    block.dataset.contextIndex = String(index + 1);
    images.forEach((screenshot) => {
      const figure = element("figure", "doc-figure");
      const label = ROLE_LABELS[screenshot.role] || "Скриншот";
      figure.append(element("p", "doc-figure-label", screenshot.title ? `${label}: ${plainText(screenshot.title)}` : label));
      const image = element("img");
      image.src = screenshot.dataUrl;
      image.alt = screenshot.title ? `${label}: ${plainText(screenshot.title)}` : label;
      if (screenshot.width && screenshot.height) {
        image.width = screenshot.width;
        image.height = screenshot.height;
      }
      figure.append(image);
      const caption = plainText(screenshot.caption).trim();
      if (caption) figure.append(element("figcaption", "", caption));
      block.append(figure);
    });
    return block;
  }

  function createGuidanceBlock(change, index, actionText, supportText) {
    const block = element("section", "doc-block doc-fact-grid");
    block.dataset.contextTitle = plainText(change.title).trim() || `Изменение ${index + 1}`;
    block.dataset.contextIndex = String(index + 1);
    const action = element("div", "doc-fact");
    action.append(element("strong", "", "Что сделать клиенту"), document.createTextNode(actionText || "Действие не указано"));
    const support = element("div", "doc-fact");
    support.append(element("strong", "", "Подсказка поддержке"), document.createTextNode(supportText || "Дополнительная подсказка не указана"));
    block.append(action, support);
    return block;
  }

  function createSupportPair(title, firstNodes, secondNodes, continuation) {
    const block = element("section", "doc-block doc-compare");
    const first = element("div", "doc-guidance");
    first.append(element("h4", "", continuation ? `${title[0]}, продолжение` : title[0]));
    const firstRich = element("div", "doc-rich");
    appendRichNodes(firstRich, firstNodes);
    if (!firstNodes || !firstNodes.length) firstRich.append(element("p", "", "Не заполнено"));
    first.append(firstRich);
    const second = element("div", "doc-guidance warning");
    second.append(element("h4", "", continuation ? `${title[1]}, продолжение` : title[1]));
    const secondRich = element("div", "doc-rich");
    appendRichNodes(secondRich, secondNodes);
    if (!secondNodes || !secondNodes.length) secondRich.append(element("p", "", "Не заполнено"));
    second.append(secondRich);
    block.append(first, second);
    return block;
  }

  function createTextBlock(value, className, heading) {
    const block = element("section", `doc-block ${className || ""}`.trim());
    if (heading) block.append(element("h4", "", heading));
    const rich = element("div", "doc-rich");
    rich.append(safeRichFragment(value));
    block.append(rich);
    return block;
  }

  function buildDocumentBlocks() {
    const blocks = [createDocCover()];
    const rollout = createDocRollout();
    if (rollout) blocks.push(createDocSection("01", "Условия запуска"), rollout);
    blocks.push(createDocSection("02", "Что изменится"));

    state.changes.forEach((change, index) => {
      blocks.push(createChangeHeading(change, index, false));
      const locations = splitText(change.location, 430);
      const availability = splitText(change.availability, 430);
      const factParts = Math.max(locations.length, availability.length, 1);
      for (let part = 0; part < factParts; part += 1) {
        blocks.push(createFactBlock(change, index, locations[part] || "", availability[part] || ""));
      }

      const before = richChunks(change.before, 640);
      const after = richChunks(change.after, 640);
      const compareParts = Math.max(before.length, after.length, 1);
      for (let part = 0; part < compareParts; part += 1) {
        blocks.push(createCompareBlock(change, index, before[part] || [], after[part] || [], part));
      }

      groupScreenshots(change.screenshots).forEach((images) => blocks.push(createImageBlock(change, index, images)));

      const actions = splitText(change.clientAction, 430);
      const notes = splitText(change.supportNote, 430);
      const guidanceParts = Math.max(actions.length, notes.length);
      for (let part = 0; part < guidanceParts; part += 1) {
        blocks.push(createGuidanceBlock(change, index, actions[part] || "", notes[part] || ""));
      }
    });

    const supportHasContent = [state.support.say, state.support.dontSay, state.support.details]
      .some((value) => plainText(value).trim()) || state.support.faq.length;
    if (supportHasContent) {
      blocks.push(createDocSection("03", "Для поддержки"));
      const say = richChunks(state.support.say, 620);
      const dontSay = richChunks(state.support.dontSay, 620);
      const pairParts = Math.max(say.length, dontSay.length);
      for (let part = 0; part < pairParts; part += 1) {
        blocks.push(createSupportPair(["Что можно говорить", "Что не обещать"], say[part] || [], dontSay[part] || [], part));
      }
      richChunks(state.support.details, 760).forEach((nodes, index) => {
        const block = element("section", "doc-block doc-guidance");
        block.append(element("h4", "", index ? "Технические детали, продолжение" : "Технические детали"));
        const rich = element("div", "doc-rich");
        appendRichNodes(rich, nodes);
        block.append(rich);
        blocks.push(block);
      });
      state.support.faq.forEach((item, index) => {
        const question = splitText(item.question, 220);
        const answers = richChunks(item.answer, 650);
        if (!question.length && !answers.length) return;
        const parts = Math.max(answers.length, 1);
        for (let part = 0; part < parts; part += 1) {
          const faq = element("section", "doc-block doc-faq");
          faq.append(element("strong", "", `${index + 1}. ${question.join(" ") || "Вопрос"}${part ? ", продолжение" : ""}`));
          const rich = element("div", "doc-rich");
          appendRichNodes(rich, answers[part] || []);
          faq.append(rich);
          blocks.push(faq);
        }
      });
    }
    return blocks;
  }

  function createDocumentPage(pageNumber) {
    const page = element("article", "document-page");
    page.dataset.exportPage = "a4";
    page.setAttribute("aria-label", `Страница ${pageNumber}`);
    const layout = element("div", "doc-page-content");
    const head = element("header", "doc-running-head");
    const brand = element("div", "doc-brand");
    brand.append(element("span", "doc-brand-dot"), document.createTextNode("Siren"));
    head.append(brand, element("span", "", truncateText(state.title || "Инструкция", 72)));
    const body = element("div", "doc-body");
    const footer = element("footer", "doc-footer");
    footer.append(element("span", "", "Инструкция для КЦ и технической поддержки"));
    const number = element("span", "doc-page-number", String(pageNumber));
    footer.append(number);
    layout.append(head, body, footer);
    page.append(layout);
    return { page, body, number };
  }

  function renderDocumentPreview() {
    const container = $("#documentPages");
    const panel = $("#documentPreview");
    const wasHidden = panel.hidden;
    panel.hidden = false;
    const priorZoom = container.style.zoom;
    container.style.zoom = "1";
    container.replaceChildren();
    paginationWarnings = [];

    const pages = [];
    let current = createDocumentPage(1);
    pages.push(current);
    container.append(current.page);

    buildDocumentBlocks().forEach((block) => {
      current.body.append(block);
      if (current.body.scrollHeight <= current.body.clientHeight + 1) return;

      block.remove();
      current = createDocumentPage(pages.length + 1);
      pages.push(current);
      container.append(current.page);
      if (block.dataset.contextTitle && !block.classList.contains("doc-change-heading")) {
        const changeIndex = Math.max(0, Number(block.dataset.contextIndex || 1) - 1);
        const change = state.changes[changeIndex];
        if (change) current.body.append(createChangeHeading(change, changeIndex, true));
      }
      current.body.append(block);
      if (current.body.scrollHeight > current.body.clientHeight + 1) {
        paginationWarnings.push(`Слишком крупный блок на странице ${pages.length}. Сократите подпись или разделите текст.`);
        block.dataset.overflow = "true";
      }
    });

    pages.forEach((entry, index) => {
      entry.number.textContent = `${index + 1} / ${pages.length}`;
      entry.page.setAttribute("aria-label", `Страница ${index + 1} из ${pages.length}`);
    });
    container.style.zoom = priorZoom || "";
    panel.hidden = wasHidden;
  }

  function appendModelParagraphs(parent, paragraphs) {
    (paragraphs || []).forEach((paragraph) => {
      const item = element(paragraph.bullet ? "li" : "p");
      (paragraph.runs || []).forEach((run) => {
        let node = document.createTextNode(run.text || "");
        if (run.bold) {
          const strong = document.createElement("strong");
          strong.append(node);
          node = strong;
        }
        if (run.italic) {
          const emphasis = document.createElement("em");
          emphasis.append(node);
          node = emphasis;
        }
        if (run.color && /^[0-9a-f]{6}$/i.test(run.color)) {
          const span = document.createElement("span");
          span.style.color = `#${run.color}`;
          span.append(node);
          node = span;
        }
        item.append(node);
      });
      if (paragraph.bullet) {
        let list = parent.lastElementChild;
        if (!list || list.tagName !== "UL") {
          list = document.createElement("ul");
          parent.append(list);
        }
        list.append(item);
      } else {
        parent.append(item);
      }
    });
  }

  function createSlideBase(model, index, total) {
    const page = element("article", "slide-page");
    page.dataset.exportSlide = "16:9";
    page.setAttribute("aria-label", `Слайд ${index} из ${total}`);
    page.append(element("div", "slide-topline"));
    return page;
  }

  function renderSlideModel(model, index, total) {
    const page = createSlideBase(model, index, total);
    if (model.type === "cover") {
      page.classList.add("slide-cover");
      const content = element("div", "slide-content");
      const main = element("div", "slide-cover-main");
      main.append(element("p", "slide-section-label", "Инструкция для КЦ и поддержки"));
      main.append(element("h2", "", model.title || "Новая инструкция"));
      main.append(element("p", "", "Изменения для пользователей, условия доступности и сценарии консультации"));
      const meta = element("div", "slide-meta-row");
      if (model.releaseDate) meta.append(element("span", "", `Дата: ${model.releaseDate}`));
      if (model.rolloutMode) meta.append(element("span", "", `Запуск: ${model.rolloutMode}`));
      if (meta.childNodes.length) main.append(meta);
      const footer = element("footer", "slide-footer");
      footer.append(element("span", "", "Siren"), element("span", "", `${index} / ${total}`));
      content.append(main, footer);
      page.append(content);
      return page;
    }

    const content = element("div", "slide-content");
    const head = element("header", "slide-head");
    head.append(element("h2", "", model.title || "Инструкция"), element("span", "slide-section-label", `Слайд ${index}`));
    const body = element("div", "slide-body");
    const footer = element("footer", "slide-footer");
    footer.append(element("span", "", truncateText(state.title || "Инструкция", 90)), element("span", "", `${index} / ${total}`));

    if (model.type === "comparison") {
      const grid = element("div", "slide-compare");
      const before = element("section", "slide-panel");
      before.append(element("h3", "", "Как было"));
      appendModelParagraphs(before, model.before);
      const after = element("section", "slide-panel after");
      after.append(element("h3", "", "Как стало"));
      appendModelParagraphs(after, model.after);
      grid.append(before, after);
      body.append(grid);
    } else if (model.type === "supportPair") {
      const grid = element("div", "slide-compare");
      const say = element("section", "slide-panel positive");
      say.append(element("h3", "", "Что можно говорить"));
      appendModelParagraphs(say, model.say);
      const dont = element("section", "slide-panel warning");
      dont.append(element("h3", "", "Что не обещать"));
      appendModelParagraphs(dont, model.dontSay);
      grid.append(say, dont);
      body.append(grid);
    } else if (model.type === "image") {
      const grid = element("div", `slide-image-grid${model.images.length === 1 ? " single" : ""}`);
      model.images.forEach((imageModel, imageIndex) => {
        const figure = element("figure", "slide-figure");
        figure.append(element("strong", "", imageModel.title
          ? `${ROLE_LABELS[imageModel.role] || "Скриншот"}: ${plainText(imageModel.title)}`
          : ROLE_LABELS[imageModel.role] || "Скриншот"));
        const image = element("img");
        image.src = imageModel.dataUrl;
        image.alt = imageModel.title || ROLE_LABELS[imageModel.role] || "Скриншот";
        figure.append(image);
        const caption = model.captions && model.captions[imageIndex];
        if (caption && caption.length) {
          const figcaption = document.createElement("figcaption");
          appendModelParagraphs(figcaption, caption);
          figure.append(figcaption);
        }
        grid.append(figure);
      });
      body.append(grid);
    } else {
      const tone = model.tone === "after" ? " positive" : model.tone === "warning" ? " warning" : "";
      const panel = element("section", `slide-panel${tone}`);
      appendModelParagraphs(panel, model.paragraphs);
      body.append(panel);
    }
    content.append(head, body, footer);
    page.append(content);
    return page;
  }

  function renderSlidesPreview() {
    const container = $("#slidePages");
    const panel = $("#slidesPreview");
    const wasHidden = panel.hidden;
    panel.hidden = false;
    const priorZoom = container.style.zoom;
    container.style.zoom = "1";
    container.replaceChildren();

    const localizedState = deepClone(state);
    localizedState.changes.forEach((change) => {
      change.channels = change.channels.map((channel) => CHANNEL_LABELS[channel] || channel);
    });
    let models = [];
    try {
      models = global.SirenEditableExport.buildSlideModels(localizedState);
    } catch (error) {
      models = [{ type: "cover", title: plainText(state.title).trim() || "Новая инструкция", releaseDate: formatDate(state.releaseDate), rolloutMode: state.rolloutMode }];
    }
    models.forEach((model, index) => container.append(renderSlideModel(model, index + 1, models.length)));
    $$('[data-export-slide]', container).forEach((slide, index) => {
      const body = $(".slide-body", slide);
      if (body && body.scrollHeight > body.clientHeight + 1) {
        paginationWarnings.push(`Содержимое слайда ${index + 1} не помещается. Разделите длинный текст.`);
        slide.dataset.overflow = "true";
      }
    });
    container.style.zoom = priorZoom || "";
    panel.hidden = wasHidden;
  }

  function scalePreviews() {
    const panel = $(".preview-panel");
    const available = Math.max(300, panel.clientWidth - 62);
    const docScale = Math.min(1, available / 794);
    const slideScale = Math.min(1, available / 1280);
    $("#documentPages").style.zoom = String(docScale);
    $("#slidePages").style.zoom = String(slideScale);
  }

  function updatePreviewStatus() {
    const validation = Model.validateState(state);
    const callout = $("#previewCallout");
    const label = $("#previewCalloutText");
    const issueCount = validation.errors.length + validation.warnings.length + paginationWarnings.length;
    if (!issueCount) {
      callout.dataset.tone = "ok";
      $(".status-icon", callout).textContent = "✓";
      label.textContent = "Предпросмотр готов к точной выгрузке";
      return;
    }
    callout.dataset.tone = "warning";
    $(".status-icon", callout).textContent = "!";
    label.textContent = validation.errors.length
      ? `Нужно исправить обязательные поля: ${validation.errors.length}`
      : `Перед публикацией проверьте замечания: ${validation.warnings.length + paginationWarnings.length}`;
  }

  function renderPreviews() {
    renderDocumentPreview();
    renderSlidesPreview();
    scalePreviews();
    updatePreviewStatus();
  }

  function clearValidationPresentation() {
    const summary = $("#validationSummary");
    if (summary) {
      summary.hidden = true;
      summary.replaceChildren();
    }
    $$('[aria-invalid="true"]', $("#instructionForm")).forEach((field) => field.removeAttribute("aria-invalid"));
    $$(".field-error", $("#instructionForm")).forEach((error) => {
      error.hidden = true;
      error.textContent = "";
    });
  }

  function errorTarget(path) {
    if (path === "title") {
      return { field: $("#instructionTitle"), error: $("#instructionTitleError") };
    }
    const match = path.match(/^changes\[(\d+)]\.(title|channels|location|after)$/);
    if (!match) return null;
    const card = $$("[data-change-card]") [Number(match[1])];
    if (!card) return null;
    const key = match[2];
    let field;
    if (key === "channels") field = $(".channel-fieldset", card);
    else if (key === "after") field = $('[data-change-rich="after"]', card);
    else field = $(`[data-change-field="${key}"]`, card);
    return { field, error: $(`[data-error="${key}"]`, card) };
  }

  function presentValidationErrors(validation, focusFirst) {
    clearValidationPresentation();
    if (!validation.errors.length) return;
    const summary = $("#validationSummary");
    summary.hidden = false;
    summary.append(element("strong", "", "Исправьте обязательные поля"));
    const list = document.createElement("ul");
    validation.errors.forEach((issue) => {
      list.append(element("li", "", issue.message));
      const target = errorTarget(issue.path);
      if (!target || !target.field) return;
      target.field.setAttribute("aria-invalid", "true");
      if (target.error) {
        target.error.hidden = false;
        target.error.textContent = issue.message;
        if (!target.error.id) target.error.id = `error-${createId("field")}`;
        const describedBy = new Set((target.field.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean));
        describedBy.add(target.error.id);
        target.field.setAttribute("aria-describedby", Array.from(describedBy).join(" "));
      }
    });
    summary.append(list);
    if (focusFirst) {
      const target = errorTarget(validation.errors[0].path);
      summary.focus({ preventScroll: true });
      summary.scrollIntoView({ behavior: "smooth", block: "start" });
      global.setTimeout(() => {
        if (target && target.field) target.field.focus({ preventScroll: false });
      }, 260);
    }
  }

  function renderExportValidation() {
    const validation = Model.validateState(state);
    const container = $("#exportValidation");
    const exactErrors = paginationWarnings.slice();
    container.replaceChildren();
    container.className = "export-validation";
    if (validation.errors.length) container.classList.add("has-errors");
    else if (validation.warnings.length || exactErrors.length) container.classList.add("has-warnings");

    if (!validation.errors.length && !validation.warnings.length && !exactErrors.length) {
      container.append(element("strong", "", "Проверка пройдена"));
      container.append(element("p", "", "Обязательные поля заполнены, переполнений страниц и слайдов не найдено."));
    } else {
      const headline = validation.errors.length
        ? `Нужно исправить: ${validation.errors.length}`
        : "Можно выгружать, но перед публикацией проверьте замечания";
      container.append(element("strong", "", headline));
      const list = document.createElement("ul");
      validation.errors.concat(validation.warnings).slice(0, 10).forEach((issue) => list.append(element("li", "", issue.message)));
      exactErrors.slice(0, 4).forEach((message) => list.append(element("li", "", message)));
      container.append(list);
      const total = validation.errors.length + validation.warnings.length + exactErrors.length;
      if (total > 14) container.append(element("p", "", `Еще замечаний: ${total - 14}`));
    }

    $$('[data-export]', $("#exportDialog")).forEach((button) => {
      const isExact = button.dataset.export.endsWith("exact");
      button.disabled = exportRunning || validation.errors.length > 0 || (isExact && exactErrors.length > 0);
    });
    return validation;
  }

  function openExportDialog(trigger) {
    renderPreviews();
    const validation = renderExportValidation();
    if (validation.errors.length) presentValidationErrors(validation, false);
    const dialog = $("#exportDialog");
    lastDialogTrigger = trigger || document.activeElement;
    dialog.showModal();
    global.setTimeout(() => {
      const firstEnabled = $('[data-export]:not(:disabled)', dialog) || $('[data-close-dialog]', dialog);
      if (firstEnabled) firstEnabled.focus();
    }, 0);
  }

  function closeDialog(dialog) {
    if (dialog && dialog.open) dialog.close();
  }

  function renderExampleList() {
    const list = $("#exampleList");
    list.replaceChildren();
    const choices = [{
      id: "blank",
      title: "Чистый черновик",
      description: "Одна пустая карточка изменения и только обязательные поля.",
      draft: blankDraft()
    }].concat((Examples.examples || []).map((draft, index) => ({
      id: `example-${index}`,
      title: draft.title,
      description: `${draft.changes.length} ${draft.changes.length === 1 ? "изменение" : "изменения"}; ${channelText(Model.collectChannels(draft)) || "каналы не указаны"}.`,
      draft
    })));

    choices.forEach((choice) => {
      const option = element("article", "example-option");
      const copy = element("div");
      copy.append(element("h3", "", choice.title), element("p", "", choice.description));
      const button = element("button", "button primary", choice.id === "blank" ? "Открыть" : "Загрузить пример");
      button.type = "button";
      button.dataset.exampleId = choice.id;
      option.append(copy, button);
      list.append(option);
    });
    list.dataset.choices = "ready";
  }

  async function replaceDraft(nextDraft, message) {
    await clearAssets();
    state = Model.normalizeState(deepClone(nextDraft));
    await hydrateScreenshotAssets();
    renderForm();
    renderPreviews();
    persistNow();
    showToast(message);
    $("#instructionTitle").focus();
  }

  function chooseExample(id) {
    let choice;
    if (id === "blank") choice = blankDraft();
    else {
      const index = Number(String(id).replace("example-", ""));
      choice = Examples.examples[index];
    }
    if (!choice) return;
    closeDialog($("#exampleDialog"));
    const action = () => replaceDraft(choice, id === "blank" ? "Открыт чистый черновик." : "Учебный пример загружен.");
    if (isDraftMeaningful()) {
      openConfirm({
        title: "Заменить текущий черновик",
        text: "Текущий локальный черновик будет заменен выбранным вариантом. Это действие нельзя отменить.",
        actionLabel: "Заменить черновик",
        intent: "danger",
        onConfirm: action
      });
    } else {
      action();
    }
  }

  function setPreviewMode(mode, moveFocus) {
    currentPreviewMode = mode === "slides" ? "slides" : "document";
    $$('[data-preview-mode]').forEach((tab) => {
      const selected = tab.dataset.previewMode === currentPreviewMode;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      if (selected && moveFocus) tab.focus();
    });
    $("#documentPreview").hidden = currentPreviewMode !== "document";
    $("#slidesPreview").hidden = currentPreviewMode !== "slides";
    scalePreviews();
  }

  function nextFrame() {
    return new Promise((resolve) => global.requestAnimationFrame(() => global.requestAnimationFrame(resolve)));
  }

  function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    global.setTimeout(() => URL.revokeObjectURL(url), 3000);
  }

  async function exactExport(mode, kind, fileName) {
    const previousMode = currentPreviewMode;
    setPreviewMode(mode, false);
    const container = mode === "document" ? $("#documentPages") : $("#slidePages");
    const previousZoom = container.style.zoom;
    container.style.zoom = "1";
    try {
      await nextFrame();
      const selector = mode === "document" ? "[data-export-page]" : "[data-export-slide]";
      const elements = $$(selector, container);
      const format = mode === "document" ? "a4" : "16:9";
      const inspection = global.SirenExactExport.inspectElements(elements, { format });
      const invalid = inspection.filter((item) => !item.ok);
      if (invalid.length) {
        throw new Error(`Экспорт остановлен: найдено переполнение или неверный размер на ${invalid.length} страницах.`);
      }
      if (kind === "pdf") return await global.SirenExactExport.exportPdf(elements, fileName);
      if (kind === "docx") return await global.SirenExactExport.exportDocx(elements, fileName);
      return await global.SirenExactExport.exportPptx(elements, fileName);
    } finally {
      container.style.zoom = previousZoom;
      setPreviewMode(previousMode, false);
    }
  }

  function setExportBusy(button, busy, message) {
    exportRunning = busy;
    $$('[data-export]', $("#exportDialog")).forEach((item) => {
      item.disabled = busy || item.disabled;
      item.setAttribute("aria-busy", String(busy && item === button));
    });
    $("#exportBusyText").textContent = message || "";
    if (!busy) renderExportValidation();
  }

  async function runExport(kind, button) {
    if (exportRunning) return;
    renderPreviews();
    const validation = Model.validateState(state);
    if (validation.errors.length) {
      presentValidationErrors(validation, true);
      closeDialog($("#exportDialog"));
      showToast("Исправьте обязательные поля перед выгрузкой.", "error");
      return;
    }
    if (kind.endsWith("exact") && paginationWarnings.length) {
      renderExportValidation();
      showToast("Точная выгрузка остановлена: есть переполнение предпросмотра.", "error");
      return;
    }

    const labels = {
      "pdf-exact": "Готовлю точный PDF…",
      "docx-exact": "Готовлю точную копию Word…",
      "docx-editable": "Готовлю редактируемый Word…",
      "pptx-exact": "Готовлю точную презентацию…",
      "pptx-editable": "Готовлю редактируемую презентацию…"
    };
    setExportBusy(button, true, labels[kind]);
    try {
      let blob;
      let extension;
      if (kind === "pdf-exact") {
        extension = "pdf";
        blob = await exactExport("document", "pdf", Model.estimateReadableFilename(state, extension));
      } else if (kind === "docx-exact") {
        extension = "docx";
        blob = await exactExport("document", "docx", Model.estimateReadableFilename(state, extension));
      } else if (kind === "pptx-exact") {
        extension = "pptx";
        blob = await exactExport("slides", "pptx", Model.estimateReadableFilename(state, extension));
      } else if (kind === "docx-editable") {
        extension = "docx";
        blob = await global.SirenEditableExport.buildDocx(state);
      } else if (kind === "pptx-editable") {
        extension = "pptx";
        blob = await global.SirenEditableExport.buildPptx(state);
      } else {
        throw new Error("Неизвестный режим экспорта");
      }
      const fileName = Model.estimateReadableFilename(state, extension);
      downloadBlob(blob, fileName);
      $("#exportBusyText").textContent = `Готово: ${fileName}`;
      showToast(`Файл ${fileName} подготовлен.`);
    } catch (error) {
      console.error(error);
      $("#exportBusyText").textContent = "Не удалось подготовить файл.";
      showToast(error && error.message ? error.message : "Ошибка экспорта.", "error");
    } finally {
      setExportBusy(button, false, $("#exportBusyText").textContent);
    }
  }

  function bindFormEvents() {
    const form = $("#instructionForm");
    const composing = new WeakSet();
    form.addEventListener("compositionstart", (event) => composing.add(event.target));
    form.addEventListener("compositionend", (event) => {
      composing.delete(event.target);
      if (updateStateFromControl(event.target)) scheduleUpdate();
    });
    form.addEventListener("input", (event) => {
      autoGrow(event.target);
      if (event.isComposing || composing.has(event.target)) return;
      if (updateStateFromControl(event.target)) {
        event.target.removeAttribute("aria-invalid");
        scheduleUpdate();
      }
    });
    form.addEventListener("change", (event) => {
      const control = event.target;
      if (control.matches(".image-input")) {
        const card = control.closest("[data-change-card]");
        const change = findChange(card && card.dataset.changeId);
        if (change) addImageFiles(change, control.files, control.dataset.pendingRole || "step");
        control.value = "";
        return;
      }
      autoGrow(control);
      if (updateStateFromControl(control)) scheduleUpdate();
    });

    form.addEventListener("click", (event) => {
      const target = event.target.closest("button");
      if (!target || target.disabled) return;
      const card = target.closest("[data-change-card]");
      const change = findChange(card && card.dataset.changeId);

      if (target.classList.contains("add-image") && change) {
        const input = $(".image-input", card);
        input.dataset.pendingRole = target.dataset.imageRole || "step";
        input.click();
      } else if (target.classList.contains("move-up") && change) {
        const index = state.changes.indexOf(change);
        if (moveItem(state.changes, index, index - 1)) {
          renderChanges();
          scheduleUpdate();
        }
      } else if (target.classList.contains("move-down") && change) {
        const index = state.changes.indexOf(change);
        if (moveItem(state.changes, index, index + 1)) {
          renderChanges();
          scheduleUpdate();
        }
      } else if (target.classList.contains("duplicate-change") && change) {
        duplicateChange(change);
      } else if (target.classList.contains("remove-change") && change) {
        openConfirm({
          title: "Удалить изменение",
          text: `Карточка «${plainText(change.title).trim() || "Без названия"}» и ее скриншоты будут удалены из локального черновика.`,
          actionLabel: "Удалить изменение",
          intent: "danger",
          onConfirm: async () => {
            await Promise.allSettled(change.screenshots.map((image) => deleteAsset(image.id)));
            state.changes.splice(state.changes.indexOf(change), 1);
            if (!state.changes.length) state.changes.push(blankChange());
            renderChanges();
            scheduleUpdate();
            showToast("Изменение удалено.");
          }
        });
      } else if ((target.classList.contains("image-up") || target.classList.contains("image-down")) && change) {
        const item = target.closest("[data-image-item]");
        const index = change.screenshots.findIndex((image) => image.id === item.dataset.imageId);
        const offset = target.classList.contains("image-up") ? -1 : 1;
        if (moveItem(change.screenshots, index, index + offset)) {
          renderChanges();
          scheduleUpdate();
        }
      } else if (target.classList.contains("remove-image") && change) {
        const item = target.closest("[data-image-item]");
        const screenshot = findScreenshot(change, item.dataset.imageId);
        if (!screenshot) return;
        openConfirm({
          title: "Удалить скриншот",
          text: `Скриншот «${plainText(screenshot.title).trim() || screenshot.name || "Без названия"}» будет удален из карточки.`,
          actionLabel: "Удалить скриншот",
          intent: "danger",
          onConfirm: async () => {
            change.screenshots.splice(change.screenshots.indexOf(screenshot), 1);
            await deleteAsset(screenshot.id);
            renderChanges();
            scheduleUpdate();
            showToast("Скриншот удален.");
          }
        });
      } else if ((target.classList.contains("faq-up") || target.classList.contains("faq-down"))) {
        const item = target.closest("[data-faq-item]");
        const index = state.support.faq.findIndex((faq) => faq.id === item.dataset.faqId);
        const offset = target.classList.contains("faq-up") ? -1 : 1;
        if (moveItem(state.support.faq, index, index + offset)) {
          renderFaq();
          scheduleUpdate();
        }
      } else if (target.classList.contains("remove-faq")) {
        const item = target.closest("[data-faq-item]");
        const index = state.support.faq.findIndex((faq) => faq.id === item.dataset.faqId);
        if (index >= 0) {
          state.support.faq.splice(index, 1);
          renderFaq();
          scheduleUpdate();
        }
      }
    });
  }

  function bindGlobalEvents() {
    $("#addChangeBtn").addEventListener("click", () => {
      const change = blankChange();
      state.changes.push(change);
      renderChanges();
      scheduleUpdate();
      const field = $(`[data-change-card][data-change-id="${CSS.escape(change.id)}"] [data-change-field="title"]`);
      if (field) field.focus();
    });
    $("#addFaqBtn").addEventListener("click", addFaq);
    $("#buildSupportBtn").addEventListener("click", buildSupportDraft);
    $("#loadExampleBtn").addEventListener("click", (event) => {
      lastDialogTrigger = event.currentTarget;
      $("#exampleDialog").showModal();
      global.setTimeout(() => $('[data-example-id]', $("#exampleDialog")).focus(), 0);
    });
    $("#exampleList").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-example-id]");
      if (button) chooseExample(button.dataset.exampleId);
    });
    $("#resetBtn").addEventListener("click", () => chooseExample("blank"));
    [$("#openExportBtn"), $("#formExportBtn")].forEach((button) => {
      button.addEventListener("click", () => openExportDialog(button));
    });

    $$('[data-preview-mode]').forEach((tab) => {
      tab.addEventListener("click", () => setPreviewMode(tab.dataset.previewMode, false));
      tab.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
        event.preventDefault();
        setPreviewMode(currentPreviewMode === "document" ? "slides" : "document", true);
      });
    });

    $("#exportDialog").addEventListener("click", (event) => {
      const exportButton = event.target.closest("button[data-export]");
      if (exportButton) runExport(exportButton.dataset.export, exportButton);
      const closeButton = event.target.closest("[data-close-dialog]");
      if (closeButton && !exportRunning) closeDialog($("#exportDialog"));
    });

    $("#confirmCancelBtn").addEventListener("click", closeConfirm);
    $("#confirmActionBtn").addEventListener("click", async () => {
      const callback = confirmCallback;
      const button = $("#confirmActionBtn");
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      try {
        if (callback) await callback();
        closeConfirm();
      } catch (error) {
        showToast(error && error.message ? error.message : "Не удалось выполнить действие.", "error");
      } finally {
        button.disabled = false;
        button.removeAttribute("aria-busy");
      }
    });

    $$('dialog.modal').forEach((dialog) => {
      dialog.addEventListener("click", (event) => {
        if (event.target === dialog && !exportRunning) dialog.close();
      });
      dialog.addEventListener("cancel", (event) => {
        if (exportRunning) event.preventDefault();
      });
      dialog.addEventListener("close", () => {
        if (lastDialogTrigger && lastDialogTrigger.isConnected) lastDialogTrigger.focus();
      });
    });

    let resizeTimer = 0;
    global.addEventListener("resize", () => {
      global.clearTimeout(resizeTimer);
      resizeTimer = global.setTimeout(scalePreviews, 120);
    });
    global.addEventListener("pagehide", persistNow);
  }

  async function initialize() {
    if (!Model || !Examples) {
      document.body.replaceChildren(element("p", "", "Не удалось загрузить модули Siren. Проверьте комплект файлов."));
      return;
    }
    assetDb = await openDatabase();
    if (!assetDb && storageMode === "indexeddb") storageMode = "localstorage";
    state = loadDraft();
    const didMigrate = migratedLegacyDraft;
    await hydrateScreenshotAssets();
    renderExampleList();
    bindFormEvents();
    bindGlobalEvents();
    renderForm();
    renderPreviews();
    setPreviewMode("document", false);
    persistNow();
    document.title = `${plainText(state.title).trim() || "Новая инструкция"} — Siren AI`;
    if (didMigrate) showToast("Старый черновик перенесен в новую карточную структуру.");
    if (!assetDb) showToast("IndexedDB недоступна: скриншоты будут храниться вместе с текстом и могут занимать больше места.");
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => renderPreviews());
    }
  }

  /* Schema v4 editor overrides. */
  function blankItemV4() {
    if (Examples && typeof Examples.createBlankItem === "function") return Examples.createBlankItem();
    return {
      id: createId("item"),
      title: "",
      before: "",
      after: "",
      clientAction: "",
      supportNote: ""
    };
  }

  function blankGroupV4() {
    if (Examples && typeof Examples.createBlankGroup === "function") return Examples.createBlankGroup();
    return {
      id: createId("group"),
      title: "",
      channels: [],
      location: "",
      availability: "",
      items: [blankItemV4()],
      screenshots: []
    };
  }

  function blankDraft() {
    if (Examples && typeof Examples.createBlankDraft === "function") return Examples.createBlankDraft();
    return {
      schemaVersion: 4,
      title: "",
      releaseDate: "",
      rolloutMode: "",
      rolloutConditions: "",
      groups: [blankGroupV4()],
      support: { say: "", dontSay: "", details: "", faq: [] }
    };
  }

  function hasV4Text(value) {
    return Boolean(plainText(value).trim());
  }

  function itemHasV4Content(item) {
    return Boolean(item) && ["before", "after", "clientAction", "supportNote"]
      .some((key) => hasV4Text(item[key]));
  }

  function groupHasV4Content(group) {
    return Boolean(group) && (
      ["location", "availability"].some((key) => hasV4Text(group[key]))
      || Boolean(group.channels && group.channels.length)
      || Boolean(group.items && group.items.some(itemHasV4Content))
      || Boolean(group.screenshots && group.screenshots.some((shot) => shot && shot.dataUrl))
    );
  }

  function dispatchRichEditorInput(editor, inputType) {
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: inputType || "format" }));
  }

  function runRichCommand(editor, command, value) {
    editor.focus();
    try {
      document["execCommand"]("styleWithCSS", false, true);
      const changed = document["execCommand"](command, false, value === undefined ? null : value);
      if (changed) dispatchRichEditorInput(editor, "format");
      return changed;
    } catch (_error) {
      return false;
    }
  }

  function applyInlineFormat(editor, tagName, color) {
    const selected = selectedRangeFor(editor);
    if (!selected || selected.range.collapsed) {
      showToast("\u0421\u043d\u0430\u0447\u0430\u043b\u0430 \u0432\u044b\u0434\u0435\u043b\u0438\u0442\u0435 \u0442\u0435\u043a\u0441\u0442, \u043a\u043e\u0442\u043e\u0440\u044b\u0439 \u043d\u0443\u0436\u043d\u043e \u043e\u0444\u043e\u0440\u043c\u0438\u0442\u044c.");
      editor.focus();
      return false;
    }
    return runRichCommand(editor, color ? "foreColor" : (tagName === "strong" ? "bold" : "italic"), color);
  }

  function applyListFormat(editor) {
    const selected = selectedRangeFor(editor);
    if (!selected || !plainText(editor.innerHTML).trim()) {
      showToast("\u0412\u0432\u0435\u0434\u0438\u0442\u0435 \u0442\u0435\u043a\u0441\u0442, \u043a\u043e\u0442\u043e\u0440\u044b\u0439 \u043d\u0443\u0436\u043d\u043e \u043f\u0440\u0435\u0432\u0440\u0430\u0442\u0438\u0442\u044c \u0432 \u0441\u043f\u0438\u0441\u043e\u043a.");
      editor.focus();
      return false;
    }
    return runRichCommand(editor, "insertUnorderedList");
  }

  function clearSelectedFormat(editor) {
    const selected = selectedRangeFor(editor);
    if (!selected || selected.range.collapsed) {
      showToast("\u0421\u043d\u0430\u0447\u0430\u043b\u0430 \u0432\u044b\u0434\u0435\u043b\u0438\u0442\u0435 \u0442\u0435\u043a\u0441\u0442, \u0443 \u043a\u043e\u0442\u043e\u0440\u043e\u0433\u043e \u043d\u0443\u0436\u043d\u043e \u0443\u0431\u0440\u0430\u0442\u044c \u043e\u0444\u043e\u0440\u043c\u043b\u0435\u043d\u0438\u0435.");
      editor.focus();
      return false;
    }
    return runRichCommand(editor, "removeFormat");
  }

  function refreshToolbarState(editor) {
    const toolbar = editor && editor.closest(".rich-field") && $(".format-toolbar", editor.closest(".rich-field"));
    if (!toolbar) return;
    const hasSelection = Boolean(selectedRangeFor(editor));
    let currentColor = "";
    try { currentColor = isAllowedColor(document.queryCommandValue("foreColor")); } catch (_error) { currentColor = ""; }
    $$('button[data-format]', toolbar).forEach((button) => {
      let pressed = false;
      if (hasSelection) {
        try {
          if (button.dataset.format === "bold") pressed = document.queryCommandState("bold");
          else if (button.dataset.format === "italic") pressed = document.queryCommandState("italic");
          else if (button.dataset.format === "list") pressed = document.queryCommandState("insertUnorderedList");
          else if (button.dataset.format === "color") pressed = currentColor === button.dataset.color;
        } catch (_error) { pressed = false; }
      }
      if (["bold", "italic", "list", "color"].includes(button.dataset.format)) {
        button.setAttribute("aria-pressed", pressed ? "true" : "false");
      }
    });
  }

  function buildToolbar(toolbar, editor) {
    toolbar.replaceChildren();
    const commands = [
      { action: "bold", label: "\u0416\u0438\u0440\u043d\u044b\u0439", text: "\u0416", title: "\u0421\u0434\u0435\u043b\u0430\u0442\u044c \u0432\u044b\u0434\u0435\u043b\u0435\u043d\u043d\u044b\u0439 \u0442\u0435\u043a\u0441\u0442 \u0436\u0438\u0440\u043d\u044b\u043c" },
      { action: "italic", label: "\u041a\u0443\u0440\u0441\u0438\u0432", text: "\u041a", title: "\u0421\u0434\u0435\u043b\u0430\u0442\u044c \u0432\u044b\u0434\u0435\u043b\u0435\u043d\u043d\u044b\u0439 \u0442\u0435\u043a\u0441\u0442 \u043a\u0443\u0440\u0441\u0438\u0432\u043e\u043c" },
      { action: "list", label: "\u041c\u0430\u0440\u043a\u0438\u0440\u043e\u0432\u0430\u043d\u043d\u044b\u0439 \u0441\u043f\u0438\u0441\u043e\u043a", text: "\u2022", title: "\u0421\u043e\u0437\u0434\u0430\u0442\u044c \u043c\u0430\u0440\u043a\u0438\u0440\u043e\u0432\u0430\u043d\u043d\u044b\u0439 \u0441\u043f\u0438\u0441\u043e\u043a" },
      { action: "clear", label: "\u041e\u0447\u0438\u0441\u0442\u0438\u0442\u044c \u043e\u0444\u043e\u0440\u043c\u043b\u0435\u043d\u0438\u0435", text: "Tx", title: "\u0423\u0431\u0440\u0430\u0442\u044c \u0446\u0432\u0435\u0442, \u0436\u0438\u0440\u043d\u043e\u0441\u0442\u044c \u0438 \u043a\u0443\u0440\u0441\u0438\u0432 \u0443 \u0432\u044b\u0434\u0435\u043b\u0435\u043d\u0438\u044f" }
    ];
    commands.forEach((command) => {
      const button = element("button", "format-button", command.text);
      button.type = "button";
      button.dataset.format = command.action;
      button.setAttribute("aria-label", command.label);
      button.title = command.title;
      if (command.action !== "clear") button.setAttribute("aria-pressed", "false");
      toolbar.append(button);
    });
    toolbar.append(element("span", "toolbar-separator"));
    Object.entries(COLOR_PALETTE).forEach(([name, color]) => {
      const colorName = COLOR_LABELS[name] || name;
      const button = element("button", "format-button color-swatch", "\u0426\u0432\u0435\u0442");
      button.type = "button";
      button.dataset.format = "color";
      button.dataset.color = color;
      button.style.setProperty("--swatch", color);
      button.setAttribute("aria-label", "\u0426\u0432\u0435\u0442 \u0442\u0435\u043a\u0441\u0442\u0430" + ": " + colorName);
      button.title = "\u0426\u0432\u0435\u0442 \u0442\u0435\u043a\u0441\u0442\u0430" + ": " + colorName;
      button.setAttribute("aria-pressed", "false");
      toolbar.append(button);
    });
    toolbar.addEventListener("mousedown", (event) => event.preventDefault());
    toolbar.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-format]");
      if (!button || button.disabled) return;
      const action = button.dataset.format;
      if (action === "bold") applyInlineFormat(editor, "strong");
      else if (action === "italic") applyInlineFormat(editor, "em");
      else if (action === "list") applyListFormat(editor);
      else if (action === "clear") clearSelectedFormat(editor);
      else if (action === "color") applyInlineFormat(editor, "span", button.dataset.color);
      refreshToolbarState(editor);
    });
    refreshToolbarState(editor);
  }

  function bindRichEditor(editor) {
    editor.addEventListener("paste", (event) => {
      event.preventDefault();
      insertPlainText(editor, event.clipboardData ? event.clipboardData.getData("text/plain") : "");
      refreshToolbarState(editor);
    });
    editor.addEventListener("keydown", (event) => {
      if (!(event.ctrlKey || event.metaKey) || event.isComposing) return;
      const key = event.key.toLowerCase();
      if (key !== "b" && key !== "i") return;
      event.preventDefault();
      applyInlineFormat(editor, key === "b" ? "strong" : "em");
      refreshToolbarState(editor);
    });
    ["focus", "keyup", "mouseup"].forEach((type) => {
      editor.addEventListener(type, () => refreshToolbarState(editor));
    });
  }

  function selectedTextSlicesV4(editor, range) {
    const slices = [];
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const length = (node.nodeValue || "").length;
      let intersects = false;
      try { intersects = length > 0 && range.intersectsNode(node); } catch (_error) { intersects = false; }
      if (intersects) {
        const start = node === range.startContainer ? range.startOffset : 0;
        const end = node === range.endContainer ? range.endOffset : length;
        if (end > start) slices.push({ node, start, end });
      }
      node = walker.nextNode();
    }
    return slices;
  }

  function splitTextSliceV4(slice) {
    let target = slice.node;
    if (slice.end < target.length) target.splitText(slice.end);
    if (slice.start > 0) target = target.splitText(slice.start);
    return target;
  }

  function formatAncestorV4(node, editor, predicate) {
    let current = node && node.parentNode;
    while (current && current !== editor) {
      if (current.nodeType === Node.ELEMENT_NODE && predicate(current)) return current;
      current = current.parentNode;
    }
    return null;
  }

  function removeAncestorAroundNodeV4(node, ancestor) {
    let branch = node;
    while (branch.parentNode && branch.parentNode !== ancestor) branch = branch.parentNode;
    if (branch.parentNode !== ancestor || !ancestor.parentNode) return;
    const before = ancestor.cloneNode(false);
    const after = ancestor.cloneNode(false);
    while (ancestor.firstChild && ancestor.firstChild !== branch) before.append(ancestor.firstChild);
    while (branch.nextSibling) after.append(branch.nextSibling);
    const parent = ancestor.parentNode;
    if (before.hasChildNodes()) parent.insertBefore(before, ancestor);
    parent.insertBefore(branch, ancestor);
    if (after.hasChildNodes()) parent.insertBefore(after, ancestor);
    ancestor.remove();
  }

  function removeMatchingAncestorsV4(node, editor, predicate) {
    let ancestor = formatAncestorV4(node, editor, predicate);
    while (ancestor) {
      removeAncestorAroundNodeV4(node, ancestor);
      ancestor = formatAncestorV4(node, editor, predicate);
    }
  }

  function selectTextNodesV4(selection, nodes) {
    const connected = nodes.filter((node) => node && node.isConnected && node.length);
    if (!connected.length) return;
    const range = document.createRange();
    range.setStart(connected[0], 0);
    range.setEnd(connected[connected.length - 1], connected[connected.length - 1].length);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function applyInlineFormat(editor, tagName, color) {
    const selected = selectedRangeFor(editor);
    if (!selected || selected.range.collapsed) {
      showToast("\u0421\u043d\u0430\u0447\u0430\u043b\u0430 \u0432\u044b\u0434\u0435\u043b\u0438\u0442\u0435 \u0442\u0435\u043a\u0441\u0442, \u043a\u043e\u0442\u043e\u0440\u044b\u0439 \u043d\u0443\u0436\u043d\u043e \u043e\u0444\u043e\u0440\u043c\u0438\u0442\u044c.");
      editor.focus();
      return false;
    }
    const slices = selectedTextSlicesV4(editor, selected.range);
    if (!slices.length) return false;
    const normalizedTag = String(tagName || "span").toUpperCase();
    const matchesRequested = (node) => (
      node.tagName === normalizedTag
      && (!color || isAllowedColor(node.style && node.style.color) === color)
    );
    const removeRequested = slices.every((slice) => Boolean(formatAncestorV4(slice.node, editor, matchesRequested)));
    const formattedNodes = [];

    for (let index = slices.length - 1; index >= 0; index -= 1) {
      const target = splitTextSliceV4(slices[index]);
      if (removeRequested) {
        removeMatchingAncestorsV4(target, editor, matchesRequested);
      } else if (!formatAncestorV4(target, editor, matchesRequested)) {
        if (color) {
          removeMatchingAncestorsV4(target, editor, (node) => (
            node.tagName === "SPAN" && Boolean(isAllowedColor(node.style && node.style.color))
          ));
        }
        const wrapper = document.createElement(normalizedTag.toLowerCase());
        if (color) wrapper.style.color = color;
        target.parentNode.insertBefore(wrapper, target);
        wrapper.append(target);
      }
      formattedNodes.unshift(target);
    }
    selectTextNodesV4(selected.selection, formattedNodes);
    dispatchRichEditorInput(editor, "format");
    return true;
  }

  function topLevelEditorNodeV4(node, editor) {
    let current = node;
    while (current && current.parentNode && current.parentNode !== editor) current = current.parentNode;
    return current && current.parentNode === editor ? current : null;
  }

  function applyListFormat(editor) {
    const selected = selectedRangeFor(editor);
    if (!selected || !plainText(editor.innerHTML).trim()) {
      showToast("\u0412\u0432\u0435\u0434\u0438\u0442\u0435 \u0442\u0435\u043a\u0441\u0442, \u043a\u043e\u0442\u043e\u0440\u044b\u0439 \u043d\u0443\u0436\u043d\u043e \u043f\u0440\u0435\u0432\u0440\u0430\u0442\u0438\u0442\u044c \u0432 \u0441\u043f\u0438\u0441\u043e\u043a.");
      editor.focus();
      return false;
    }

    let targets = [];
    if (selected.range.collapsed) {
      const anchor = topLevelEditorNodeV4(selected.range.startContainer, editor);
      if (anchor) targets = [anchor];
    } else {
      targets = Array.from(editor.childNodes).filter((node) => {
        try { return selected.range.intersectsNode(node) && plainText(node.textContent || "").trim(); }
        catch (_error) { return false; }
      });
    }
    if (!targets.length) {
      targets = Array.from(editor.childNodes).filter((node) => plainText(node.textContent || "").trim());
    }
    if (!targets.length) return false;

    const allLists = targets.every((node) => (
      node.nodeType === Node.ELEMENT_NODE && ["UL", "OL"].includes(node.tagName)
    ));
    let selectionTargets = [];
    if (allLists) {
      targets.forEach((list) => {
        Array.from(list.children).forEach((item) => {
          const paragraph = document.createElement("p");
          while (item.firstChild) paragraph.append(item.firstChild);
          list.parentNode.insertBefore(paragraph, list);
          selectionTargets.push(paragraph);
        });
        list.remove();
      });
    } else {
      const list = document.createElement("ul");
      editor.insertBefore(list, targets[0]);
      targets.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE && ["UL", "OL"].includes(node.tagName)) {
          Array.from(node.children).forEach((item) => list.append(item));
          node.remove();
          return;
        }
        const item = document.createElement("li");
        if (node.nodeType === Node.ELEMENT_NODE) {
          while (node.firstChild) item.append(node.firstChild);
          node.remove();
        } else {
          item.append(node);
        }
        list.append(item);
      });
      selectionTargets = [list];
    }

    if (selectionTargets.length) {
      const range = document.createRange();
      range.setStartBefore(selectionTargets[0]);
      range.setEndAfter(selectionTargets[selectionTargets.length - 1]);
      selected.selection.removeAllRanges();
      selected.selection.addRange(range);
    }
    dispatchRichEditorInput(editor, "format");
    return true;
  }

  function clearSelectedFormat(editor) {
    const selected = selectedRangeFor(editor);
    if (!selected || selected.range.collapsed) {
      showToast("\u0421\u043d\u0430\u0447\u0430\u043b\u0430 \u0432\u044b\u0434\u0435\u043b\u0438\u0442\u0435 \u0442\u0435\u043a\u0441\u0442, \u0443 \u043a\u043e\u0442\u043e\u0440\u043e\u0433\u043e \u043d\u0443\u0436\u043d\u043e \u0443\u0431\u0440\u0430\u0442\u044c \u043e\u0444\u043e\u0440\u043c\u043b\u0435\u043d\u0438\u0435.");
      editor.focus();
      return false;
    }
    const slices = selectedTextSlicesV4(editor, selected.range);
    const clearedNodes = [];
    for (let index = slices.length - 1; index >= 0; index -= 1) {
      const target = splitTextSliceV4(slices[index]);
      removeMatchingAncestorsV4(target, editor, (node) => ["STRONG", "EM", "SPAN"].includes(node.tagName));
      clearedNodes.unshift(target);
    }
    selectTextNodesV4(selected.selection, clearedNodes);
    dispatchRichEditorInput(editor, "format");
    return true;
  }

  function refreshToolbarState(editor) {
    const toolbar = editor && editor.closest(".rich-field") && $(".format-toolbar", editor.closest(".rich-field"));
    if (!toolbar) return;
    const selected = selectedRangeFor(editor);
    const slices = selected ? selectedTextSlicesV4(editor, selected.range) : [];
    let nodes = slices.map((slice) => slice.node);
    if (!nodes.length && selected && selected.range.startContainer.nodeType === Node.TEXT_NODE) {
      nodes = [selected.range.startContainer];
    }
    const allHave = (predicate) => nodes.length > 0 && nodes.every((node) => Boolean(formatAncestorV4(node, editor, predicate)));
    const colors = nodes.map((node) => {
      const ancestor = formatAncestorV4(node, editor, (candidate) => (
        candidate.tagName === "SPAN" && Boolean(isAllowedColor(candidate.style && candidate.style.color))
      ));
      return ancestor ? isAllowedColor(ancestor.style.color) : "";
    });
    const currentColor = colors.length && colors.every((value) => value === colors[0]) ? colors[0] : "";

    $$("button[data-format]", toolbar).forEach((button) => {
      let pressed = false;
      if (button.dataset.format === "bold") pressed = allHave((node) => node.tagName === "STRONG");
      else if (button.dataset.format === "italic") pressed = allHave((node) => node.tagName === "EM");
      else if (button.dataset.format === "list") pressed = allHave((node) => node.tagName === "LI");
      else if (button.dataset.format === "color") pressed = Boolean(currentColor) && currentColor === button.dataset.color;
      if (["bold", "italic", "list", "color"].includes(button.dataset.format)) {
        button.setAttribute("aria-pressed", pressed ? "true" : "false");
      }
    });
  }
  function prepareV4Shell() {
    const intro = $(".form-intro");
    if (intro) {
      $("h2", intro).textContent = "\u041e\u043f\u0438\u0448\u0438\u0442\u0435 \u0438\u0437\u043c\u0435\u043d\u0435\u043d\u0438\u044f";
    }
    const introHelp = $(".form-intro > p:last-child");
    if (introHelp) introHelp.textContent = "\u041e\u0431\u044f\u0437\u0430\u0442\u0435\u043b\u044c\u043d\u044b \u0442\u043e\u043b\u044c\u043a\u043e \u043d\u0430\u0437\u0432\u0430\u043d\u0438\u0435 \u0438\u043d\u0441\u0442\u0440\u0443\u043a\u0446\u0438\u0438 \u0438 \u0445\u043e\u0442\u044f \u0431\u044b \u043e\u0434\u043d\u043e \u043f\u043e\u043b\u0435 \u00ab\u0421\u0442\u0430\u043b\u043e\u00bb. \u041e\u0441\u0442\u0430\u043b\u044c\u043d\u043e\u0435 \u0437\u0430\u043f\u043e\u043b\u043d\u044f\u0439\u0442\u0435 \u043f\u0440\u0438 \u043d\u0435\u043e\u0431\u0445\u043e\u0434\u0438\u043c\u043e\u0441\u0442\u0438: \u043f\u0443\u0441\u0442\u044b\u0435 \u043f\u043e\u043b\u044f \u0432 \u0440\u0435\u0437\u0443\u043b\u044c\u0442\u0430\u0442 \u043d\u0435 \u043f\u043e\u043f\u0430\u0434\u0443\u0442.";
    const titleHelp = $("#instructionTitleHelp");
    if (titleHelp) titleHelp.textContent = "\u041e\u0431\u044f\u0437\u0430\u0442\u0435\u043b\u044c\u043d\u043e\u0435 \u043f\u043e\u043b\u0435. \u041d\u0430\u043f\u0438\u0448\u0438\u0442\u0435, \u043a\u0430\u043a\u043e\u0439 \u044d\u043a\u0440\u0430\u043d \u0438\u043b\u0438 \u0441\u0446\u0435\u043d\u0430\u0440\u0438\u0439 \u043c\u0435\u043d\u044f\u0435\u0442\u0441\u044f.";
    const dateHelp = $("#releaseDateHelp");
    if (dateHelp) dateHelp.textContent = "\u0415\u0441\u043b\u0438 \u0434\u0430\u0442\u0430 \u043d\u0435 \u043f\u043e\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043d\u0430, \u043e\u0441\u0442\u0430\u0432\u044c\u0442\u0435 \u043f\u043e\u043b\u0435 \u043f\u0443\u0441\u0442\u044b\u043c.";
    const modeHelp = $("#rolloutModeHelp");
    if (modeHelp) modeHelp.textContent = "\u041d\u0430\u043f\u0440\u0438\u043c\u0435\u0440: \u0432\u0441\u0435\u043c \u0441\u0440\u0430\u0437\u0443, \u043f\u043e\u044d\u0442\u0430\u043f\u043d\u043e \u0438\u043b\u0438 A/B-\u0442\u0435\u0441\u0442.";
    const heading = $("#changesHeading");
    if (heading) heading.textContent = "\u042d\u043a\u0440\u0430\u043d\u044b \u0438 \u0441\u0446\u0435\u043d\u0430\u0440\u0438\u0438";
    const sectionCopy = heading && heading.nextElementSibling;
    if (sectionCopy) {
      sectionCopy.textContent = "\u041e\u0434\u043d\u0430 \u043a\u0430\u0440\u0442\u043e\u0447\u043a\u0430 \u2014 \u043e\u0434\u0438\u043d \u044d\u043a\u0440\u0430\u043d. \u0412\u043d\u0443\u0442\u0440\u0438 \u043c\u043e\u0436\u043d\u043e \u043e\u043f\u0438\u0441\u0430\u0442\u044c \u043d\u0435\u0441\u043a\u043e\u043b\u044c\u043a\u043e \u0438\u0437\u043c\u0435\u043d\u0435\u043d\u0438\u0439 \u0438 \u0434\u043e\u0431\u0430\u0432\u0438\u0442\u044c \u043e\u0431\u0449\u0438\u0435 \u0441\u043a\u0440\u0438\u043d\u0448\u043e\u0442\u044b.";
    }
    const addGroupButton = $("#addChangeBtn");
    if (addGroupButton) addGroupButton.textContent = "\u0414\u043e\u0431\u0430\u0432\u0438\u0442\u044c \u044d\u043a\u0440\u0430\u043d \u0438\u043b\u0438 \u0441\u0446\u0435\u043d\u0430\u0440\u0438\u0439";
    const rolloutHelp = $("#rolloutConditionsHelp");
    if (rolloutHelp) rolloutHelp.textContent = "\u041d\u0430\u043f\u0438\u0448\u0438\u0442\u0435 \u0437\u0434\u0435\u0441\u044c \u0442\u043e\u043b\u044c\u043a\u043e \u043e\u0431\u0449\u0438\u0435 \u0443\u0441\u043b\u043e\u0432\u0438\u044f. \u0418\u0441\u043a\u043b\u044e\u0447\u0435\u043d\u0438\u0435 \u0434\u043b\u044f \u043e\u0434\u043d\u043e\u0433\u043e \u044d\u043a\u0440\u0430\u043d\u0430 \u0443\u043a\u0430\u0436\u0438\u0442\u0435 \u0432 \u0435\u0433\u043e \u043a\u0430\u0440\u0442\u043e\u0447\u043a\u0435.";
    const exampleLead = $("#exampleDialog .modal-lead");
    if (exampleLead) {
      exampleLead.textContent = "\u041d\u0438\u0436\u0435 \u043c\u043e\u0436\u043d\u043e \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044c \u043e\u0434\u0438\u043d \u0438\u0437 \u043f\u0440\u0438\u043c\u0435\u0440\u043e\u0432.";
    }
  }

  async function hydrateScreenshotAssets() {
    const tasks = [];
    (state.groups || []).forEach((group) => {
      (group.screenshots || []).forEach((screenshot) => {
        if (screenshot.dataUrl) {
          tasks.push(putAsset(screenshot));
          return;
        }
        tasks.push(getAsset(screenshot.id).then((asset) => {
          if (!asset) return;
          screenshot.dataUrl = asset.dataUrl || "";
          screenshot.width = screenshot.width || asset.width || 0;
          screenshot.height = screenshot.height || asset.height || 0;
        }));
      });
    });
    await Promise.allSettled(tasks);
  }

  function findGroup(id) {
    return (state.groups || []).find((group) => group.id === id) || null;
  }

  function findGroupItem(group, id) {
    return group && (group.items || []).find((item) => item.id === id) || null;
  }

  function renderImageItem(group, screenshot, index) {
    const template = $("#imageTemplate");
    const item = template.content.firstElementChild.cloneNode(true);
    const sid = safeDomId(screenshot.id);
    item.dataset.imageId = screenshot.id;
    item.dataset.groupId = group.id;
    const image = $("img", item);
    if (screenshot.dataUrl) image.src = screenshot.dataUrl;
    image.alt = screenshot.title
      ? (ROLE_LABELS[screenshot.role] || "\u0421\u043a\u0440\u0438\u043d\u0448\u043e\u0442") + ": " + screenshot.title
      : (ROLE_LABELS[screenshot.role] || "\u0421\u043a\u0440\u0438\u043d\u0448\u043e\u0442") + " " + (index + 1);
    $$("[data-image-field]", item).forEach((field) => {
      const key = field.dataset.imageField;
      field.value = screenshot[key] || (key === "role" ? "step" : "");
      field.id = "shot-" + sid + "-" + key;
      const label = $("[data-image-label=\"" + key + "\"]", item);
      if (label) label.htmlFor = field.id;
      if (key === "caption") {
        field.placeholder = "\u041d\u0430\u043f\u0440\u0438\u043c\u0435\u0440: \u043f\u0443\u043d\u043a\u0442\u044b 1\u20133 \u2014 \u043e\u0431\u0440\u0430\u0442\u0438\u0442\u0435 \u0432\u043d\u0438\u043c\u0430\u043d\u0438\u0435 \u043d\u0430 \u0432\u044b\u0434\u0435\u043b\u0435\u043d\u043d\u044b\u0435 \u043e\u0431\u043b\u0430\u0441\u0442\u0438";
      }
      autoGrow(field);
    });
    $(".image-up", item).disabled = index === 0;
    $(".image-down", item).disabled = index === group.screenshots.length - 1;
    return item;
  }

  function renderChangeItem(group, item, index) {
    const source = $("#changeTemplate").content.firstElementChild.cloneNode(true);
    const node = element("article", "change-item");
    const itemId = safeDomId(item.id);
    node.dataset.changeItem = "";
    node.dataset.itemId = item.id;
    node.dataset.groupId = group.id;

    const header = element("header", "change-item-head");
    const heading = element("div", "change-item-heading");
    const badge = element("span", "change-index item-index", String(index + 1).padStart(2, "0"));
    const headingCopy = element("div");
    headingCopy.append(element("p", "change-kicker", "\u041f\u0443\u043d\u043a\u0442 \u0438\u0437\u043c\u0435\u043d\u0435\u043d\u0438\u044f"));
    headingCopy.append(element("h4", "item-title-preview", plainText(item.title).trim() || "\u0411\u0435\u0437 \u043d\u0430\u0437\u0432\u0430\u043d\u0438\u044f"));
    heading.append(badge, headingCopy);

    const actions = $(".card-actions", source).cloneNode(true);
    actions.setAttribute("aria-label", "\u0414\u0435\u0439\u0441\u0442\u0432\u0438\u044f \u0441 \u043f\u0443\u043d\u043a\u0442\u043e\u043c \u0438\u0437\u043c\u0435\u043d\u0435\u043d\u0438\u044f");
    const up = $(".move-up", actions);
    const down = $(".move-down", actions);
    const duplicate = $(".duplicate-change", actions);
    const remove = $(".remove-change", actions);
    up.className = "icon-button item-up";
    down.className = "icon-button item-down";
    duplicate.className = "button small tertiary duplicate-item";
    remove.className = "icon-button danger remove-item";
    up.setAttribute("aria-label", "\u041f\u0435\u0440\u0435\u043c\u0435\u0441\u0442\u0438\u0442\u044c \u043f\u0443\u043d\u043a\u0442 \u0432\u044b\u0448\u0435");
    down.setAttribute("aria-label", "\u041f\u0435\u0440\u0435\u043c\u0435\u0441\u0442\u0438\u0442\u044c \u043f\u0443\u043d\u043a\u0442 \u043d\u0438\u0436\u0435");
    remove.setAttribute("aria-label", "\u0423\u0434\u0430\u043b\u0438\u0442\u044c \u043f\u0443\u043d\u043a\u0442");
    up.disabled = index === 0;
    down.disabled = index === group.items.length - 1;
    header.append(heading, actions);
    node.append(header);

    const titleField = source.querySelector(":scope > .field");
    const titleInput = $("[data-change-field=\"title\"]", titleField);
    const titleLabel = $("[data-label=\"title\"]", titleField);
    const obsoleteError = $("[data-error=\"title\"]", titleField);
    if (obsoleteError) obsoleteError.remove();
    titleInput.removeAttribute("data-change-field");
    titleInput.dataset.itemField = "title";
    titleInput.value = item.title || "";
    titleInput.id = "item-" + itemId + "-title";
    titleInput.placeholder = "\u041a\u043e\u0440\u043e\u0442\u043a\u043e: \u0447\u0442\u043e \u0438\u043c\u0435\u043d\u043d\u043e \u0438\u0437\u043c\u0435\u043d\u0438\u043b\u043e\u0441\u044c";
    titleLabel.removeAttribute("data-label");
    titleLabel.dataset.itemLabel = "title";
    titleLabel.htmlFor = titleInput.id;
    titleLabel.textContent = "\u041a\u0440\u0430\u0442\u043a\u043e\u0435 \u043d\u0430\u0437\u0432\u0430\u043d\u0438\u0435";
    node.append(titleField);

    const comparison = $(".comparison-grid", source);
    $$(".add-image", comparison).forEach((button) => button.remove());
    $$("[data-change-rich]", comparison).forEach((editor) => {
      const key = editor.dataset.changeRich;
      editor.removeAttribute("data-change-rich");
      editor.dataset.itemRich = key;
      editor.id = "item-" + itemId + "-" + key;
      const visibleLabel = key === "before"
        ? $(".comparison-tag.before", comparison).textContent
        : $(".comparison-tag.after", comparison).textContent;
      editor.setAttribute("aria-label", visibleLabel + ": " + (plainText(item.title).trim() || (index + 1)));
      editor.dataset.placeholder = key === "before" ? "\u0427\u0442\u043e \u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u044c \u0432\u0438\u0434\u0435\u043b \u0438\u043b\u0438 \u043c\u043e\u0433 \u0441\u0434\u0435\u043b\u0430\u0442\u044c \u0440\u0430\u043d\u044c\u0448\u0435" : "\u0427\u0442\u043e \u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u044c \u0443\u0432\u0438\u0434\u0438\u0442 \u0438\u043b\u0438 \u0441\u043c\u043e\u0436\u0435\u0442 \u0441\u0434\u0435\u043b\u0430\u0442\u044c";
      setRichValue(editor, item[key] || "");
      const toolbar = $(".format-toolbar", editor.closest(".rich-field"));
      if (toolbar) buildToolbar(toolbar, editor);
      bindRichEditor(editor);
    });
    node.append(comparison);

    const details = $(".change-details", source);
    $$("[data-change-field]", details).forEach((field) => {
      const key = field.dataset.changeField;
      field.removeAttribute("data-change-field");
      field.dataset.itemField = key;
      field.value = item[key] || "";
      field.id = "item-" + itemId + "-" + key;
      field.placeholder = key === "clientAction" ? "\u0427\u0442\u043e \u043d\u0443\u0436\u043d\u043e \u0441\u0434\u0435\u043b\u0430\u0442\u044c \u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u044e, \u0435\u0441\u043b\u0438 \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0435 \u0442\u0440\u0435\u0431\u0443\u0435\u0442\u0441\u044f" : "\u0427\u0442\u043e \u043f\u0440\u043e\u0432\u0435\u0440\u0438\u0442\u044c \u0441\u043e\u0442\u0440\u0443\u0434\u043d\u0438\u043a\u0443 \u043f\u043e\u0434\u0434\u0435\u0440\u0436\u043a\u0438";
      const label = $("[data-label=\"" + key + "\"]", details);
      if (label) {
        label.removeAttribute("data-label");
        label.dataset.itemLabel = key;
        label.htmlFor = field.id;
      }
      autoGrow(field);
    });
    node.append(details);
    return node;
  }

  function renderChangeCard(group, index) {
    const card = $("#changeTemplate").content.firstElementChild.cloneNode(true);
    const groupId = safeDomId(group.id);
    card.removeAttribute("data-change-card");
    card.dataset.groupCard = "";
    card.dataset.groupId = group.id;
    card.classList.add("scenario-card");
    $(".change-index", card).textContent = String(index + 1).padStart(2, "0");
    $(".change-kicker", card).textContent = "\u042d\u043a\u0440\u0430\u043d \u0438\u043b\u0438 \u0441\u0446\u0435\u043d\u0430\u0440\u0438\u0439";
    $(".change-title-preview", card).textContent = plainText(group.title).trim() || "\u0411\u0435\u0437 \u043d\u0430\u0437\u0432\u0430\u043d\u0438\u044f";

    const up = $(".move-up", card);
    const down = $(".move-down", card);
    const duplicate = $(".duplicate-change", card);
    const remove = $(".remove-change", card);
    up.className = "icon-button group-up";
    down.className = "icon-button group-down";
    duplicate.className = "button small tertiary duplicate-group";
    remove.className = "icon-button danger remove-group";
    up.disabled = index === 0;
    down.disabled = index === state.groups.length - 1;
    $(".card-actions", card).setAttribute("aria-label", "\u0414\u0435\u0439\u0441\u0442\u0432\u0438\u044f \u0441 \u044d\u043a\u0440\u0430\u043d\u043e\u043c \u0438\u043b\u0438 \u0441\u0446\u0435\u043d\u0430\u0440\u0438\u0435\u043c");
    up.setAttribute("aria-label", "\u041f\u0435\u0440\u0435\u043c\u0435\u0441\u0442\u0438\u0442\u044c \u044d\u043a\u0440\u0430\u043d \u0432\u044b\u0448\u0435");
    down.setAttribute("aria-label", "\u041f\u0435\u0440\u0435\u043c\u0435\u0441\u0442\u0438\u0442\u044c \u044d\u043a\u0440\u0430\u043d \u043d\u0438\u0436\u0435");
    remove.setAttribute("aria-label", "\u0423\u0434\u0430\u043b\u0438\u0442\u044c \u044d\u043a\u0440\u0430\u043d");

    const comparison = $(".comparison-grid", card);
    const details = $(".change-details", card);
    if (comparison) comparison.remove();
    if (details) details.remove();

    $$("[data-change-field]", card).forEach((field) => {
      const key = field.dataset.changeField;
      field.removeAttribute("data-change-field");
      field.dataset.groupField = key;
      field.value = group[key] || "";
      field.id = "group-" + groupId + "-" + key;
      const placeholder = {
        title: "\u041d\u0430\u043f\u0440\u0438\u043c\u0435\u0440: \u0418\u0441\u0442\u043e\u0440\u0438\u044f \u043e\u043f\u0435\u0440\u0430\u0446\u0438\u0439",
        location: "\u041d\u0430\u043f\u0440\u0438\u043c\u0435\u0440: \u0432\u0435\u0431-\u041b\u041a \u2192 \u041e\u043f\u0435\u0440\u0430\u0446\u0438\u0438 \u2192 \u0418\u0441\u0442\u043e\u0440\u0438\u044f",
        availability: "\u041d\u0430\u043f\u0440\u0438\u043c\u0435\u0440: \u0430\u0432\u0442\u043e\u0440\u0438\u0437\u043e\u0432\u0430\u043d\u043d\u044b\u0435 \u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u0438 \u0432\u0435\u0431-\u041b\u041a"
      }[key];
      if (placeholder) field.placeholder = placeholder;
      const label = $("[data-label=\"" + key + "\"]", card);
      if (label) {
        label.removeAttribute("data-label");
        label.dataset.groupLabel = key;
        label.htmlFor = field.id;
      }
      autoGrow(field);
    });
    const groupTitleLabel = $("[data-group-label=\"title\"]", card);
    if (groupTitleLabel) groupTitleLabel.textContent = "\u041d\u0430\u0437\u0432\u0430\u043d\u0438\u0435 \u044d\u043a\u0440\u0430\u043d\u0430 \u0438\u043b\u0438 \u0441\u0446\u0435\u043d\u0430\u0440\u0438\u044f";
    $$("[data-error=\"title\"], [data-error=\"channels\"], [data-error=\"location\"]", card)
      .forEach((error) => error.remove());
    const legend = $(".channel-fieldset legend", card);
    if (legend) legend.textContent = "\u041f\u043b\u0430\u0442\u0444\u043e\u0440\u043c\u044b";

    $$("[data-channel]", card).forEach((checkbox) => {
      checkbox.checked = (group.channels || []).includes(checkbox.value);
      checkbox.id = "group-" + groupId + "-channel-" + checkbox.value;
      const label = checkbox.closest("label");
      if (label) label.htmlFor = checkbox.id;
    });

    const screenshotBlock = $(".screenshots-block", card);
    const screenshotTitle = $(".subsection-head h4", screenshotBlock);
    const screenshotHelp = $(".subsection-head p", screenshotBlock);
    if (screenshotTitle) screenshotTitle.textContent = "\u041e\u0431\u0449\u0438\u0435 \u0441\u043a\u0440\u0438\u043d\u0448\u043e\u0442\u044b \u044d\u043a\u0440\u0430\u043d\u0430";
    if (screenshotHelp) screenshotHelp.textContent = "\u0414\u043e\u0431\u0430\u0432\u044c\u0442\u0435 \u0441\u043a\u0440\u0438\u043d\u0448\u043e\u0442 \u043e\u0434\u0438\u043d \u0440\u0430\u0437. \u0412 \u043f\u043e\u0434\u043f\u0438\u0441\u0438 \u0443\u043a\u0430\u0436\u0438\u0442\u0435, \u043a \u043a\u0430\u043a\u0438\u043c \u043f\u0443\u043d\u043a\u0442\u0430\u043c \u043e\u043d \u043e\u0442\u043d\u043e\u0441\u0438\u0442\u0441\u044f.";
    const addImageButton = $(".add-image", screenshotBlock);
    if (addImageButton) addImageButton.textContent = "\u0414\u043e\u0431\u0430\u0432\u0438\u0442\u044c \u0441\u043a\u0440\u0438\u043d\u0448\u043e\u0442\u044b";

    const itemSection = element("section", "group-items-block");
    const itemHead = element("div", "subsection-head compact");
    const itemCopy = element("div");
    itemCopy.append(
      element("h4", "", "\u041f\u0443\u043d\u043a\u0442\u044b \u0438\u0437\u043c\u0435\u043d\u0435\u043d\u0438\u0439"),
      element("p", "", "\u041e\u0434\u0438\u043d \u043f\u0443\u043d\u043a\u0442 \u2014 \u043e\u0434\u043d\u043e \u0437\u0430\u043c\u0435\u0442\u043d\u043e\u0435 \u043e\u0442\u043b\u0438\u0447\u0438\u0435 \u0434\u043b\u044f \u043a\u043b\u0438\u0435\u043d\u0442\u0430.")
    );
    const addItem = element("button", "button small secondary add-item", "\u0414\u043e\u0431\u0430\u0432\u0438\u0442\u044c \u043f\u0443\u043d\u043a\u0442");
    addItem.type = "button";
    itemHead.append(itemCopy, addItem);
    const itemList = element("div", "change-item-list");
    itemList.dataset.itemList = "";
    (group.items || []).forEach((item, itemIndex) => itemList.append(renderChangeItem(group, item, itemIndex)));
    itemSection.append(itemHead, itemList);
    card.insertBefore(itemSection, screenshotBlock);

    const imageInput = $(".image-input", card);
    imageInput.id = "group-" + groupId + "-images";
    const imageList = $("[data-image-list]", card);
    (group.screenshots || []).forEach((screenshot, screenshotIndex) => {
      imageList.append(renderImageItem(group, screenshot, screenshotIndex));
    });
    return card;
  }

  function renderChanges() {
    const list = $("#changeList");
    const fragment = document.createDocumentFragment();
    (state.groups || []).forEach((group, index) => fragment.append(renderChangeCard(group, index)));
    list.replaceChildren(fragment);
  }

  function renderForm() {
    prepareV4Shell();
    setBoundFields();
    renderChanges();
    renderSupportFields();
    renderFaq();
    clearValidationPresentation();
  }

  function updateStateFromControl(control) {
    if (control.matches("[data-bind]")) {
      state[control.dataset.bind] = control.value;
      if (control.dataset.bind === "title") {
      document.title = (plainText(control.value).trim() || "\u041d\u043e\u0432\u0430\u044f \u0438\u043d\u0441\u0442\u0440\u0443\u043a\u0446\u0438\u044f") + " \u2014 Siren AI";
      }
      return true;
    }

    const card = control.closest("[data-group-card]");
    const group = findGroup(card && card.dataset.groupId);
    if (group) {
      const itemNode = control.closest("[data-change-item]");
      const item = findGroupItem(group, itemNode && itemNode.dataset.itemId);
      if (item && control.matches("[data-item-field]")) {
        item[control.dataset.itemField] = control.value;
        if (control.dataset.itemField === "title") {
          $(".item-title-preview", itemNode).textContent = plainText(control.value).trim() || "\u0411\u0435\u0437 \u043d\u0430\u0437\u0432\u0430\u043d\u0438\u044f";
        }
        return true;
      }
      if (item && control.matches("[data-item-rich]")) {
        item[control.dataset.itemRich] = serializeRichEditor(control);
        return true;
      }
      if (control.matches("[data-group-field]")) {
        group[control.dataset.groupField] = control.value;
        if (control.dataset.groupField === "title") {
          $(".change-title-preview", card).textContent = plainText(control.value).trim() || "\u0411\u0435\u0437 \u043d\u0430\u0437\u0432\u0430\u043d\u0438\u044f";
        }
        return true;
      }
      if (control.matches("[data-channel]")) {
        group.channels = $$("[data-channel]:checked", card).map((checkbox) => checkbox.value);
        return true;
      }
      if (control.matches("[data-image-field]")) {
        const imageItem = control.closest("[data-image-item]");
        const screenshot = findScreenshot(group, imageItem && imageItem.dataset.imageId);
        if (!screenshot) return false;
        screenshot[control.dataset.imageField] = control.value;
        if (["title", "role"].includes(control.dataset.imageField)) {
          const image = $("img", imageItem);
          image.alt = screenshot.title
            ? (ROLE_LABELS[screenshot.role] || "\u0421\u043a\u0440\u0438\u043d\u0448\u043e\u0442") + ": " + screenshot.title
            : ROLE_LABELS[screenshot.role] || "\u0421\u043a\u0440\u0438\u043d\u0448\u043e\u0442";
        }
        return true;
      }
    }

    if (control.matches("[data-rich-editor^=\"support.\"]")) {
      const key = control.dataset.richEditor.split(".")[1];
      state.support[key] = serializeRichEditor(control);
      return true;
    }
    const faqItem = control.closest("[data-faq-item]");
    if (faqItem && control.matches("[data-faq-field]")) {
      const faq = state.support.faq.find((entry) => entry.id === faqItem.dataset.faqId);
      if (!faq) return false;
      faq[control.dataset.faqField] = control.value;
      return true;
    }
    return false;
  }

  function isDraftMeaningful() {
    if ([state.title, state.releaseDate, state.rolloutMode, state.rolloutConditions].some(hasV4Text)) return true;
    if ([state.support.say, state.support.dontSay, state.support.details].some(hasV4Text)) return true;
    if (state.support.faq.some((item) => hasV4Text(item.question) || hasV4Text(item.answer))) return true;
    return (state.groups || []).some((group) => (
      ["title", "location", "availability"].some((key) => hasV4Text(group[key]))
      || Boolean(group.channels && group.channels.length)
      || Boolean(group.items && group.items.some((item) => (
        ["title", "before", "after", "clientAction", "supportNote"].some((key) => hasV4Text(item[key]))
      )))
      || Boolean(group.screenshots && group.screenshots.some((shot) => shot && (
        shot.dataUrl || hasV4Text(shot.name) || hasV4Text(shot.title) || hasV4Text(shot.caption)
      )))
    ));
  }

  function createDocCover() {
    const block = element("section", "doc-block doc-cover");
    if (hasV4Text(state.title)) block.append(element("h1", "doc-title", plainText(state.title).trim()));
    const meta = element("div", "doc-meta-row");
    if (hasV4Text(state.releaseDate)) {
      meta.append(element("span", "doc-meta-pill", "\u0414\u0430\u0442\u0430: " + formatDate(state.releaseDate)));
    }
    if (hasV4Text(state.rolloutMode)) {
      meta.append(element("span", "doc-meta-pill", "\u0417\u0430\u043f\u0443\u0441\u043a: " + plainText(state.rolloutMode)));
    }
    const channels = channelText(Model.collectChannels(state));
    if (channels) meta.append(element("span", "doc-meta-pill", "\u041a\u0430\u043d\u0430\u043b\u044b: " + channels));
    if (meta.childNodes.length) block.append(meta);
    return block;
  }

  function createDocRollout() {
    if (!hasV4Text(state.rolloutConditions)) return null;
    const block = element("section", "doc-block doc-rollout");
    splitText(state.rolloutConditions, 850).forEach((part) => block.append(element("p", "", part)));
    return block;
  }

  function createV4GroupHeading(group, index, continuation) {
    if (!hasV4Text(group.title)) return null;
    const block = element("section", "doc-block doc-change-heading" + (continuation ? " continuation" : ""));
    block.append(element("div", "doc-change-number", String(index + 1)));
    const copy = element("div");
    const suffix = continuation ? ", \u043f\u0440\u043e\u0434\u043e\u043b\u0436\u0435\u043d\u0438\u0435" : "";
    copy.append(element("h3", "", plainText(group.title).trim() + suffix));
    block.append(copy);
    return block;
  }

  function createV4ItemHeading(item, index, continuation) {
    if (!hasV4Text(item.title)) return null;
    const block = element("section", "doc-block doc-change-heading doc-item-heading" + (continuation ? " continuation" : ""));
    block.append(element("div", "doc-change-number", String(index + 1)));
    const copy = element("div");
    const suffix = continuation ? ", \u043f\u0440\u043e\u0434\u043e\u043b\u0436\u0435\u043d\u0438\u0435" : "";
    copy.append(element("h3", "", plainText(item.title).trim() + suffix));
    block.append(copy);
    return block;
  }

  function createV4FactGrid(group) {
    const facts = [];
    const channels = channelText(group.channels);
    if (channels) facts.push(["\u041f\u043b\u0430\u0442\u0444\u043e\u0440\u043c\u044b", channels]);
    if (hasV4Text(group.location)) facts.push(["\u0413\u0434\u0435 \u043d\u0430\u0445\u043e\u0434\u0438\u0442\u0441\u044f", plainText(group.location)]);
    if (hasV4Text(group.availability)) facts.push(["\u041a\u0442\u043e \u0443\u0432\u0438\u0434\u0438\u0442 \u0438 \u043f\u0440\u0438 \u043a\u0430\u043a\u0438\u0445 \u0443\u0441\u043b\u043e\u0432\u0438\u044f\u0445", plainText(group.availability)]);
    if (!facts.length) return null;
    const block = element("section", "doc-block doc-fact-grid" + (facts.length === 1 ? " single" : ""));
    facts.forEach((fact) => {
      const panel = element("div", "doc-fact");
      panel.append(element("strong", "", fact[0]), document.createTextNode(fact[1]));
      block.append(panel);
    });
    return block;
  }

  function createV4CompareBlock(item, beforeNodes, afterNodes, continuation) {
    const hasBefore = Boolean(beforeNodes && beforeNodes.length);
    const hasAfter = Boolean(afterNodes && afterNodes.length);
    if (!hasBefore && !hasAfter) return null;
    const block = element("section", "doc-block doc-compare" + (hasBefore !== hasAfter ? " single" : ""));
    if (hasBefore) {
      const before = element("div", "doc-compare-panel");
      before.append(element("h4", "", continuation ? "\u0411\u044b\u043b\u043e, \u043f\u0440\u043e\u0434\u043e\u043b\u0436\u0435\u043d\u0438\u0435" : "\u0411\u044b\u043b\u043e"));
      const rich = element("div", "doc-rich");
      appendRichNodes(rich, beforeNodes);
      before.append(rich);
      block.append(before);
    }
    if (hasAfter) {
      const after = element("div", "doc-compare-panel after");
      after.append(element("h4", "", continuation ? "\u0421\u0442\u0430\u043b\u043e, \u043f\u0440\u043e\u0434\u043e\u043b\u0436\u0435\u043d\u0438\u0435" : "\u0421\u0442\u0430\u043b\u043e"));
      const rich = element("div", "doc-rich");
      appendRichNodes(rich, afterNodes);
      after.append(rich);
      block.append(after);
    }
    return block;
  }

  function createV4GuidanceBlock(actionText, supportText) {
    const hasAction = hasV4Text(actionText);
    const hasSupport = hasV4Text(supportText);
    if (!hasAction && !hasSupport) return null;
    const block = element("section", "doc-block doc-fact-grid" + (hasAction !== hasSupport ? " single" : ""));
    if (hasAction) {
      const action = element("div", "doc-fact");
      action.append(element("strong", "", "\u0427\u0442\u043e \u0441\u0434\u0435\u043b\u0430\u0442\u044c \u043a\u043b\u0438\u0435\u043d\u0442\u0443"), document.createTextNode(actionText));
      block.append(action);
    }
    if (hasSupport) {
      const support = element("div", "doc-fact");
      support.append(element("strong", "", "\u041f\u043e\u0434\u0441\u043a\u0430\u0437\u043a\u0430 \u043f\u043e\u0434\u0434\u0435\u0440\u0436\u043a\u0435"), document.createTextNode(supportText));
      block.append(support);
    }
    return block;
  }

  function createV4SupportPair(firstNodes, secondNodes, continuation) {
    const hasFirst = Boolean(firstNodes && firstNodes.length);
    const hasSecond = Boolean(secondNodes && secondNodes.length);
    if (!hasFirst && !hasSecond) return null;
    const block = element("section", "doc-block doc-compare" + (hasFirst !== hasSecond ? " single" : ""));
    if (hasFirst) {
      const first = element("div", "doc-guidance");
      first.append(element("h4", "", continuation ? "\u0427\u0442\u043e \u043c\u043e\u0436\u043d\u043e \u0433\u043e\u0432\u043e\u0440\u0438\u0442\u044c, \u043f\u0440\u043e\u0434\u043e\u043b\u0436\u0435\u043d\u0438\u0435" : "\u0427\u0442\u043e \u043c\u043e\u0436\u043d\u043e \u0433\u043e\u0432\u043e\u0440\u0438\u0442\u044c"));
      const rich = element("div", "doc-rich");
      appendRichNodes(rich, firstNodes);
      first.append(rich);
      block.append(first);
    }
    if (hasSecond) {
      const second = element("div", "doc-guidance warning");
      second.append(element("h4", "", continuation ? "\u0427\u0442\u043e \u043d\u0435 \u043e\u0431\u0435\u0449\u0430\u0442\u044c, \u043f\u0440\u043e\u0434\u043e\u043b\u0436\u0435\u043d\u0438\u0435" : "\u0427\u0442\u043e \u043d\u0435 \u043e\u0431\u0435\u0449\u0430\u0442\u044c"));
      const rich = element("div", "doc-rich");
      appendRichNodes(rich, secondNodes);
      second.append(rich);
      block.append(second);
    }
    return block;
  }

  function buildDocumentBlocks() {
    const blocks = [];
    let visibleSection = 0;
    const nextSectionNumber = () => String(++visibleSection).padStart(2, "0");
    const cover = createDocCover();
    if (cover.childNodes.length) blocks.push(cover);
    const rollout = createDocRollout();
    if (rollout) blocks.push(createDocSection(nextSectionNumber(), "\u0423\u0441\u043b\u043e\u0432\u0438\u044f \u0437\u0430\u043f\u0443\u0441\u043a\u0430"), rollout);

    const visibleGroups = (state.groups || []).filter(groupHasV4Content);
    if (visibleGroups.length) blocks.push(createDocSection(nextSectionNumber(), "\u0427\u0442\u043e \u0438\u0437\u043c\u0435\u043d\u0438\u0442\u0441\u044f"));
    visibleGroups.forEach((group, groupIndex) => {
      const groupHeading = createV4GroupHeading(group, groupIndex, false);
      if (groupHeading) blocks.push(groupHeading);
      const facts = createV4FactGrid(group);
      if (facts) blocks.push(facts);

      (group.items || []).filter(itemHasV4Content).forEach((item, itemIndex) => {
        const itemHeading = createV4ItemHeading(item, itemIndex, false);
        if (itemHeading) blocks.push(itemHeading);
        const before = richChunks(item.before, 640);
        const after = richChunks(item.after, 640);
        const compareParts = Math.max(before.length, after.length);
        for (let part = 0; part < compareParts; part += 1) {
          const comparison = createV4CompareBlock(item, before[part] || [], after[part] || [], part > 0);
          if (comparison) blocks.push(comparison);
        }
        const actions = splitText(item.clientAction, 430);
        const notes = splitText(item.supportNote, 430);
        const guidanceParts = Math.max(actions.length, notes.length);
        for (let part = 0; part < guidanceParts; part += 1) {
          const guidance = createV4GuidanceBlock(actions[part] || "", notes[part] || "");
          if (guidance) blocks.push(guidance);
        }
      });

      groupScreenshots((group.screenshots || []).filter((shot) => shot && shot.dataUrl))
        .forEach((images) => blocks.push(createImageBlock(group, groupIndex, images)));
    });

    const visibleFaq = (state.support.faq || []).filter((item) => hasV4Text(item.question) || hasV4Text(item.answer));
    const supportHasContent = [state.support.say, state.support.dontSay, state.support.details]
      .some(hasV4Text) || visibleFaq.length > 0;
    if (supportHasContent) {
      blocks.push(createDocSection(nextSectionNumber(), "\u0414\u043b\u044f \u043f\u043e\u0434\u0434\u0435\u0440\u0436\u043a\u0438"));
      const say = richChunks(state.support.say, 620);
      const dontSay = richChunks(state.support.dontSay, 620);
      const pairParts = Math.max(say.length, dontSay.length);
      for (let part = 0; part < pairParts; part += 1) {
        const pair = createV4SupportPair(say[part] || [], dontSay[part] || [], part > 0);
        if (pair) blocks.push(pair);
      }
      richChunks(state.support.details, 760).forEach((nodes, index) => {
        const block = element("section", "doc-block doc-guidance");
        block.append(element("h4", "", index ? "\u0422\u0435\u0445\u043d\u0438\u0447\u0435\u0441\u043a\u0438\u0435 \u0434\u0435\u0442\u0430\u043b\u0438, \u043f\u0440\u043e\u0434\u043e\u043b\u0436\u0435\u043d\u0438\u0435" : "\u0422\u0435\u0445\u043d\u0438\u0447\u0435\u0441\u043a\u0438\u0435 \u0434\u0435\u0442\u0430\u043b\u0438"));
        const rich = element("div", "doc-rich");
        appendRichNodes(rich, nodes);
        block.append(rich);
        blocks.push(block);
      });
      visibleFaq.forEach((item, index) => {
        const faq = element("section", "doc-block doc-faq");
        if (hasV4Text(item.question)) {
          faq.append(element("strong", "", (index + 1) + ". " + plainText(item.question).trim()));
        }
        if (hasV4Text(item.answer)) {
          const rich = element("div", "doc-rich");
          rich.append(safeRichFragment(item.answer));
          faq.append(rich);
        }
        blocks.push(faq);
      });
    }
    return blocks;
  }

  function createDocumentPage() {
    const page = element("article", "document-page");
    page.dataset.exportPage = "a4";
    page.setAttribute("aria-label", "\u041b\u0438\u0441\u0442 \u0434\u043e\u043a\u0443\u043c\u0435\u043d\u0442\u0430");
    const layout = element("div", "doc-page-content");
    const body = element("div", "doc-body");
    layout.append(body);
    page.append(layout);
    return { page, body };
  }

  function renderDocumentPreview() {
    const container = $("#documentPages");
    const panel = $("#documentPreview");
    const wasHidden = panel.hidden;
    panel.hidden = false;
    const priorZoom = container.style.zoom;
    container.style.zoom = "1";
    container.replaceChildren();
    paginationWarnings = [];

    let current = createDocumentPage();
    container.append(current.page);
    buildDocumentBlocks().forEach((block) => {
      current.body.append(block);
      if (current.body.scrollHeight <= current.body.clientHeight + 1) return;
      block.remove();
      current = createDocumentPage();
      container.append(current.page);
      current.body.append(block);
      if (current.body.scrollHeight > current.body.clientHeight + 1) {
        paginationWarnings.push("\u041e\u0434\u0438\u043d \u0438\u0437 \u0431\u043b\u043e\u043a\u043e\u0432 \u043d\u0435 \u043f\u043e\u043c\u0435\u0441\u0442\u0438\u043b\u0441\u044f \u043d\u0430 \u043b\u0438\u0441\u0442\u0435. \u0421\u043e\u043a\u0440\u0430\u0442\u0438\u0442\u0435 \u043f\u043e\u0434\u043f\u0438\u0441\u044c \u0438\u043b\u0438 \u0440\u0430\u0437\u0434\u0435\u043b\u0438\u0442\u0435 \u0442\u0435\u043a\u0441\u0442.");
        block.dataset.overflow = "true";
      }
    });
    container.style.zoom = priorZoom || "";
    panel.hidden = wasHidden;
  }

  function createSlideBase(model) {
    const page = element("article", "slide-page");
    page.dataset.exportSlide = "16:9";
    page.setAttribute("aria-label", plainText(model && model.title).trim() || "\u0421\u043b\u0430\u0439\u0434 \u0434\u043e\u043a\u0443\u043c\u0435\u043d\u0442\u0430");
    return page;
  }

  function renderSlideModel(model) {
    const page = createSlideBase(model);
    if (model.type === "cover") {
      page.classList.add("slide-cover");
      const content = element("div", "slide-content");
      const main = element("div", "slide-cover-main");
      if (hasV4Text(model.title)) main.append(element("h2", "", model.title));
      const meta = element("div", "slide-meta-row");
      if (hasV4Text(model.releaseDate)) meta.append(element("span", "", "\u0414\u0430\u0442\u0430: " + model.releaseDate));
      if (hasV4Text(model.rolloutMode)) meta.append(element("span", "", "\u0417\u0430\u043f\u0443\u0441\u043a: " + model.rolloutMode));
      if (meta.childNodes.length) main.append(meta);
      content.append(main);
      page.append(content);
      return page;
    }

    const content = element("div", "slide-content");
    const title = plainText(model.title).trim();
    if (title) {
      const head = element("header", "slide-head");
      if (title.length > 120) head.classList.add("very-long-title");
      else if (title.length > 72) head.classList.add("long-title");
      head.append(element("h2", "", title));
      content.append(head);
    } else {
      content.classList.add("no-head");
    }
    const body = element("div", "slide-body");

    if (model.type === "comparison") {
      const beforePresent = Boolean(model.before && model.before.length);
      const afterPresent = Boolean(model.after && model.after.length);
      const grid = element("div", "slide-compare" + (beforePresent !== afterPresent ? " single" : ""));
      if (beforePresent) {
        const before = element("section", "slide-panel");
        before.append(element("h3", "", "\u041a\u0430\u043a \u0431\u044b\u043b\u043e"));
        appendModelParagraphs(before, model.before);
        grid.append(before);
      }
      if (afterPresent) {
        const after = element("section", "slide-panel after");
        after.append(element("h3", "", "\u041a\u0430\u043a \u0441\u0442\u0430\u043b\u043e"));
        appendModelParagraphs(after, model.after);
        grid.append(after);
      }
      body.append(grid);
    } else if (model.type === "supportPair") {
      const sayPresent = Boolean(model.say && model.say.length);
      const dontPresent = Boolean(model.dontSay && model.dontSay.length);
      const grid = element("div", "slide-compare" + (sayPresent !== dontPresent ? " single" : ""));
      if (sayPresent) {
        const say = element("section", "slide-panel positive");
        say.append(element("h3", "", "\u0427\u0442\u043e \u043c\u043e\u0436\u043d\u043e \u0433\u043e\u0432\u043e\u0440\u0438\u0442\u044c"));
        appendModelParagraphs(say, model.say);
        grid.append(say);
      }
      if (dontPresent) {
        const dont = element("section", "slide-panel warning");
        dont.append(element("h3", "", "\u0427\u0442\u043e \u043d\u0435 \u043e\u0431\u0435\u0449\u0430\u0442\u044c"));
        appendModelParagraphs(dont, model.dontSay);
        grid.append(dont);
      }
      body.append(grid);
    } else if (model.type === "image") {
      const images = (model.images || []).filter((imageModel) => imageModel && imageModel.dataUrl);
      const grid = element("div", "slide-image-grid" + (images.length === 1 ? " single" : ""));
      images.forEach((imageModel, imageIndex) => {
        const figure = element("figure", "slide-figure");
        const label = ROLE_LABELS[imageModel.role] || "\u0421\u043a\u0440\u0438\u043d\u0448\u043e\u0442";
        figure.append(element("strong", "", imageModel.title ? label + ": " + plainText(imageModel.title) : label));
        const image = element("img");
        image.src = imageModel.dataUrl;
        image.alt = imageModel.title || label;
        figure.append(image);
        const caption = model.captions && model.captions[imageIndex];
        if (caption && caption.length) {
          const figcaption = document.createElement("figcaption");
          appendModelParagraphs(figcaption, caption);
          figure.append(figcaption);
        }
        grid.append(figure);
      });
      body.append(grid);
    } else if (model.paragraphs && model.paragraphs.length) {
      const tone = model.tone === "after" ? " positive" : model.tone === "warning" ? " warning" : "";
      const panel = element("section", "slide-panel" + tone);
      appendModelParagraphs(panel, model.paragraphs);
      body.append(panel);
    }
    content.append(body);
    page.append(content);
    return page;
  }

  function renderSlidesPreview() {
    const container = $("#slidePages");
    const panel = $("#slidesPreview");
    const wasHidden = panel.hidden;
    panel.hidden = false;
    const priorZoom = container.style.zoom;
    container.style.zoom = "1";
    container.replaceChildren();

    const localizedState = deepClone(state);
    (localizedState.groups || []).forEach((group) => {
      group.channels = (group.channels || []).map((channel) => CHANNEL_LABELS[channel] || channel);
    });
    let models = [];
    try {
      models = global.SirenEditableExport.buildSlideModels(localizedState);
    } catch (error) {
      models = [{ type: "cover", title: plainText(state.title).trim(), releaseDate: formatDate(state.releaseDate), rolloutMode: state.rolloutMode }];
    }
    models.forEach((model) => container.append(renderSlideModel(model)));
    $$("[data-export-slide]", container).forEach((slide) => {
      const body = $(".slide-body", slide);
      const content = $(".slide-content", slide);
      if ((body && body.scrollHeight > body.clientHeight + 1)
        || (content && content.scrollHeight > content.clientHeight + 1)) {
        paginationWarnings.push("\u0421\u043e\u0434\u0435\u0440\u0436\u0438\u043c\u043e\u0435 \u043e\u0434\u043d\u043e\u0433\u043e \u0438\u0437 \u0441\u043b\u0430\u0439\u0434\u043e\u0432 \u043d\u0435 \u043f\u043e\u043c\u0435\u0449\u0430\u0435\u0442\u0441\u044f. \u0420\u0430\u0437\u0434\u0435\u043b\u0438\u0442\u0435 \u0434\u043b\u0438\u043d\u043d\u044b\u0439 \u0442\u0435\u043a\u0441\u0442.");
        slide.dataset.overflow = "true";
      }
    });
    container.style.zoom = priorZoom || "";
    panel.hidden = wasHidden;
  }

  async function duplicateGroup(group) {
    const copy = deepClone(group);
    copy.id = createId("group");
    copy.title = hasV4Text(copy.title) ? plainText(copy.title).trim() + " \u2014 \u043a\u043e\u043f\u0438\u044f" : "";
    copy.items = (copy.items || []).map((item) => ({ ...item, id: createId("item") }));
    copy.screenshots = (copy.screenshots || []).map((screenshot) => ({ ...screenshot, id: createId("shot") }));
    const stored = await Promise.allSettled(copy.screenshots.map(putAsset));
    if (stored.some((result) => result.status === "rejected")) {
      await Promise.allSettled(copy.screenshots.map((screenshot) => deleteAsset(screenshot.id)));
      showToast("\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u0441\u043e\u0445\u0440\u0430\u043d\u0438\u0442\u044c \u043a\u043e\u043f\u0438\u0438 \u0441\u043a\u0440\u0438\u043d\u0448\u043e\u0442\u043e\u0432.", "error");
      return;
    }
    const index = state.groups.indexOf(group);
    state.groups.splice(index + 1, 0, copy);
    renderChanges();
    scheduleUpdate();
    const nextCard = $("[data-group-card][data-group-id=\"" + CSS.escape(copy.id) + "\"]");
    if (nextCard) nextCard.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function duplicateGroupItem(group, item) {
    const copy = deepClone(item);
    copy.id = createId("item");
    copy.title = hasV4Text(copy.title) ? plainText(copy.title).trim() + " \u2014 \u043a\u043e\u043f\u0438\u044f" : "";
    const index = group.items.indexOf(item);
    group.items.splice(index + 1, 0, copy);
    renderChanges();
    scheduleUpdate();
    const field = $("[data-change-item][data-item-id=\"" + CSS.escape(copy.id) + "\"] [data-item-field=\"title\"]");
    if (field) field.focus();
  }

  function errorTarget(path) {
    if (path === "title") return { field: $("#instructionTitle"), error: $("#instructionTitleError") };
    if (path === "groups") {
      const field = $("[data-item-rich=\"after\"]");
      const item = field && field.closest("[data-change-item]");
      return { field, error: item && $("[data-error=\"after\"]", item) };
    }
    const match = String(path || "").match(/^groups\[(\d+)]\.items\[(\d+)]\.after$/);
    if (!match) return null;
    const card = $$("[data-group-card]")[Number(match[1])];
    const item = card && $$("[data-change-item]", card)[Number(match[2])];
    return { field: item && $("[data-item-rich=\"after\"]", item), error: item && $("[data-error=\"after\"]", item) };
  }

  function renderExampleList() {
    const list = $("#exampleList");
    list.replaceChildren();
    const blank = blankDraft();
    const choices = [{
      id: "blank",
      title: "\u0427\u0438\u0441\u0442\u044b\u0439 \u0447\u0435\u0440\u043d\u043e\u0432\u0438\u043a",
      description: "\u041e\u0434\u0438\u043d \u043f\u0443\u0441\u0442\u043e\u0439 \u044d\u043a\u0440\u0430\u043d \u0441 \u043e\u0434\u043d\u0438\u043c \u043f\u0443\u043d\u043a\u0442\u043e\u043c.",
      draft: blank
    }].concat((Examples.examples || []).map((draft, index) => {
      const groupCount = Array.isArray(draft.groups) ? draft.groups.length : 0;
      const itemCount = (draft.groups || []).reduce((sum, group) => sum + (group.items || []).length, 0);
      return {
        id: "example-" + index,
        title: draft.title,
        description: groupCount + " \u044d\u043a\u0440\u0430\u043d; " + itemCount + " \u043f\u0443\u043d\u043a\u0442\u0430 \u0438\u0437\u043c\u0435\u043d\u0435\u043d\u0438\u0439.",
        draft
      };
    }));
    choices.forEach((choice) => {
      const option = element("article", "example-option");
      const copy = element("div");
      copy.append(element("h3", "", choice.title), element("p", "", choice.description));
      const button = element("button", "button primary", choice.id === "blank" ? "\u041e\u0442\u043a\u0440\u044b\u0442\u044c" : "\u0417\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044c \u043f\u0440\u0438\u043c\u0435\u0440");
      button.type = "button";
      button.dataset.exampleId = choice.id;
      option.append(copy, button);
      list.append(option);
    });
  }

  async function chooseExample(id) {
    closeDialog($("#exampleDialog"));
    const action = async () => {
      let choice;
      if (id === "blank") {
        choice = blankDraft();
      } else {
        const index = Number(String(id).replace("example-", ""));
        choice = Examples && typeof Examples.resolveExample === "function"
          ? await Examples.resolveExample(index)
          : Examples.examples[index];
      }
      if (!choice) throw new Error("\u041f\u0440\u0438\u043c\u0435\u0440 \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d.");
      await replaceDraft(choice, id === "blank" ? "\u041e\u0442\u043a\u0440\u044b\u0442 \u0447\u0438\u0441\u0442\u044b\u0439 \u0447\u0435\u0440\u043d\u043e\u0432\u0438\u043a." : "\u041f\u0440\u0438\u043c\u0435\u0440 \u0437\u0430\u0433\u0440\u0443\u0436\u0435\u043d.");
    };
    if (isDraftMeaningful()) {
      openConfirm({
        title: "\u0417\u0430\u043c\u0435\u043d\u0438\u0442\u044c \u0442\u0435\u043a\u0443\u0449\u0438\u0439 \u0447\u0435\u0440\u043d\u043e\u0432\u0438\u043a",
        text: "\u0422\u0435\u043a\u0443\u0449\u0438\u0439 \u0447\u0435\u0440\u043d\u043e\u0432\u0438\u043a \u0431\u0443\u0434\u0435\u0442 \u0437\u0430\u043c\u0435\u043d\u0435\u043d.",
        actionLabel: "\u0417\u0430\u043c\u0435\u043d\u0438\u0442\u044c \u0447\u0435\u0440\u043d\u043e\u0432\u0438\u043a",
        intent: "danger",
        onConfirm: action
      });
    } else {
      await action();
    }
  }

  function bindFormEvents() {
    const form = $("#instructionForm");
    const composing = new WeakSet();
    form.addEventListener("compositionstart", (event) => composing.add(event.target));
    form.addEventListener("compositionend", (event) => {
      composing.delete(event.target);
      if (updateStateFromControl(event.target)) scheduleUpdate();
    });
    form.addEventListener("input", (event) => {
      autoGrow(event.target);
      if (event.isComposing || composing.has(event.target)) return;
      if (updateStateFromControl(event.target)) {
        event.target.removeAttribute("aria-invalid");
        scheduleUpdate();
      }
    });
    form.addEventListener("change", (event) => {
      const control = event.target;
      if (control.matches(".image-input")) {
        const card = control.closest("[data-group-card]");
        const group = findGroup(card && card.dataset.groupId);
        if (group) addImageFiles(group, control.files, control.dataset.pendingRole || "step");
        control.value = "";
        return;
      }
      autoGrow(control);
      if (updateStateFromControl(control)) scheduleUpdate();
    });

    form.addEventListener("click", (event) => {
      const target = event.target.closest("button");
      if (!target || target.disabled) return;
      const card = target.closest("[data-group-card]");
      const group = findGroup(card && card.dataset.groupId);
      const itemNode = target.closest("[data-change-item]");
      const item = findGroupItem(group, itemNode && itemNode.dataset.itemId);

      if (target.classList.contains("add-item") && group) {
        const next = blankItemV4();
        group.items.push(next);
        renderChanges();
        scheduleUpdate();
        const field = $("[data-change-item][data-item-id=\"" + CSS.escape(next.id) + "\"] [data-item-field=\"title\"]");
        if (field) field.focus();
      } else if (target.classList.contains("add-image") && group) {
        const input = $(".image-input", card);
        input.dataset.pendingRole = target.dataset.imageRole || "step";
        input.click();
      } else if (target.classList.contains("group-up") && group) {
        const index = state.groups.indexOf(group);
        if (moveItem(state.groups, index, index - 1)) {
          renderChanges();
          scheduleUpdate();
        }
      } else if (target.classList.contains("group-down") && group) {
        const index = state.groups.indexOf(group);
        if (moveItem(state.groups, index, index + 1)) {
          renderChanges();
          scheduleUpdate();
        }
      } else if (target.classList.contains("duplicate-group") && group) {
        duplicateGroup(group);
      } else if (target.classList.contains("remove-group") && group) {
        openConfirm({
          title: "\u0423\u0434\u0430\u043b\u0438\u0442\u044c \u044d\u043a\u0440\u0430\u043d \u0438\u043b\u0438 \u0441\u0446\u0435\u043d\u0430\u0440\u0438\u0439",
          text: "\u0412\u0441\u0435 \u0435\u0433\u043e \u043f\u0443\u043d\u043a\u0442\u044b \u0438 \u0441\u043a\u0440\u0438\u043d\u0448\u043e\u0442\u044b \u0431\u0443\u0434\u0443\u0442 \u0443\u0434\u0430\u043b\u0435\u043d\u044b \u0438\u0437 \u0447\u0435\u0440\u043d\u043e\u0432\u0438\u043a\u0430.",
          actionLabel: "\u0423\u0434\u0430\u043b\u0438\u0442\u044c \u044d\u043a\u0440\u0430\u043d",
          intent: "danger",
          onConfirm: async () => {
            await Promise.allSettled((group.screenshots || []).map((image) => deleteAsset(image.id)));
            state.groups.splice(state.groups.indexOf(group), 1);
            if (!state.groups.length) state.groups.push(blankGroupV4());
            renderChanges();
            scheduleUpdate();
            showToast("\u042d\u043a\u0440\u0430\u043d \u0443\u0434\u0430\u043b\u0435\u043d.");
          }
        });
      } else if (target.classList.contains("item-up") && item) {
        const index = group.items.indexOf(item);
        if (moveItem(group.items, index, index - 1)) {
          renderChanges();
          scheduleUpdate();
        }
      } else if (target.classList.contains("item-down") && item) {
        const index = group.items.indexOf(item);
        if (moveItem(group.items, index, index + 1)) {
          renderChanges();
          scheduleUpdate();
        }
      } else if (target.classList.contains("duplicate-item") && item) {
        duplicateGroupItem(group, item);
      } else if (target.classList.contains("remove-item") && item) {
        openConfirm({
          title: "\u0423\u0434\u0430\u043b\u0438\u0442\u044c \u043f\u0443\u043d\u043a\u0442",
          text: "\u0422\u0435\u043a\u0441\u0442 \u044d\u0442\u043e\u0433\u043e \u043f\u0443\u043d\u043a\u0442\u0430 \u0431\u0443\u0434\u0435\u0442 \u0443\u0434\u0430\u043b\u0435\u043d \u0438\u0437 \u0447\u0435\u0440\u043d\u043e\u0432\u0438\u043a\u0430.",
          actionLabel: "\u0423\u0434\u0430\u043b\u0438\u0442\u044c \u043f\u0443\u043d\u043a\u0442",
          intent: "danger",
          onConfirm: () => {
            group.items.splice(group.items.indexOf(item), 1);
            if (!group.items.length) group.items.push(blankItemV4());
            renderChanges();
            scheduleUpdate();
            showToast("\u041f\u0443\u043d\u043a\u0442 \u0443\u0434\u0430\u043b\u0435\u043d.");
          }
        });
      } else if ((target.classList.contains("image-up") || target.classList.contains("image-down")) && group) {
        const imageItem = target.closest("[data-image-item]");
        const index = group.screenshots.findIndex((image) => image.id === imageItem.dataset.imageId);
        const offset = target.classList.contains("image-up") ? -1 : 1;
        if (moveItem(group.screenshots, index, index + offset)) {
          renderChanges();
          scheduleUpdate();
        }
      } else if (target.classList.contains("remove-image") && group) {
        const imageItem = target.closest("[data-image-item]");
        const screenshot = findScreenshot(group, imageItem.dataset.imageId);
        if (!screenshot) return;
        openConfirm({
          title: "\u0423\u0434\u0430\u043b\u0438\u0442\u044c \u0441\u043a\u0440\u0438\u043d\u0448\u043e\u0442",
          text: "\u0421\u043a\u0440\u0438\u043d\u0448\u043e\u0442 \u0431\u0443\u0434\u0435\u0442 \u0443\u0434\u0430\u043b\u0435\u043d \u0438\u0437 \u044d\u0442\u043e\u0433\u043e \u044d\u043a\u0440\u0430\u043d\u0430.",
          actionLabel: "\u0423\u0434\u0430\u043b\u0438\u0442\u044c \u0441\u043a\u0440\u0438\u043d\u0448\u043e\u0442",
          intent: "danger",
          onConfirm: async () => {
            group.screenshots.splice(group.screenshots.indexOf(screenshot), 1);
            await deleteAsset(screenshot.id);
            renderChanges();
            scheduleUpdate();
            showToast("\u0421\u043a\u0440\u0438\u043d\u0448\u043e\u0442 \u0443\u0434\u0430\u043b\u0435\u043d.");
          }
        });
      } else if (target.classList.contains("faq-up") || target.classList.contains("faq-down")) {
        const faqNode = target.closest("[data-faq-item]");
        const index = state.support.faq.findIndex((faq) => faq.id === faqNode.dataset.faqId);
        const offset = target.classList.contains("faq-up") ? -1 : 1;
        if (moveItem(state.support.faq, index, index + offset)) {
          renderFaq();
          scheduleUpdate();
        }
      } else if (target.classList.contains("remove-faq")) {
        const faqNode = target.closest("[data-faq-item]");
        const index = state.support.faq.findIndex((faq) => faq.id === faqNode.dataset.faqId);
        if (index >= 0) {
          state.support.faq.splice(index, 1);
          renderFaq();
          scheduleUpdate();
        }
      }
    });
  }

  function bindGlobalEvents() {
    $("#addChangeBtn").addEventListener("click", () => {
      const group = blankGroupV4();
      state.groups.push(group);
      renderChanges();
      scheduleUpdate();
      const field = $("[data-group-card][data-group-id=\"" + CSS.escape(group.id) + "\"] [data-group-field=\"title\"]");
      if (field) field.focus();
    });
    $("#addFaqBtn").addEventListener("click", addFaq);
    $("#buildSupportBtn").addEventListener("click", buildSupportDraft);
    $("#loadExampleBtn").addEventListener("click", (event) => {
      lastDialogTrigger = event.currentTarget;
      $("#exampleDialog").showModal();
      global.setTimeout(() => {
        const first = $("[data-example-id]", $("#exampleDialog"));
        if (first) first.focus();
      }, 0);
    });
    $("#exampleList").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-example-id]");
      if (button) chooseExample(button.dataset.exampleId).catch((error) => showToast(error.message, "error"));
    });
    $("#resetBtn").addEventListener("click", () => {
      chooseExample("blank").catch((error) => showToast(error.message, "error"));
    });
    [$("#openExportBtn"), $("#formExportBtn")].forEach((button) => {
      button.addEventListener("click", () => openExportDialog(button));
    });
    $$("[data-preview-mode]").forEach((tab) => {
      tab.addEventListener("click", () => setPreviewMode(tab.dataset.previewMode, false));
      tab.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
        event.preventDefault();
        setPreviewMode(currentPreviewMode === "document" ? "slides" : "document", true);
      });
    });
    $("#exportDialog").addEventListener("click", (event) => {
      const exportButton = event.target.closest("button[data-export]");
      if (exportButton) runExport(exportButton.dataset.export, exportButton);
      const closeButton = event.target.closest("[data-close-dialog]");
      if (closeButton && !exportRunning) closeDialog($("#exportDialog"));
    });
    $("#confirmCancelBtn").addEventListener("click", closeConfirm);
    $("#confirmActionBtn").addEventListener("click", async () => {
      const callback = confirmCallback;
      const button = $("#confirmActionBtn");
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      try {
        if (callback) await callback();
        closeConfirm();
      } catch (error) {
        showToast(error && error.message ? error.message : "\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u0432\u044b\u043f\u043e\u043b\u043d\u0438\u0442\u044c \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0435.", "error");
      } finally {
        button.disabled = false;
        button.removeAttribute("aria-busy");
      }
    });
    $$("dialog.modal").forEach((dialog) => {
      dialog.addEventListener("click", (event) => {
        if (event.target === dialog && !exportRunning) dialog.close();
      });
      dialog.addEventListener("cancel", (event) => {
        if (exportRunning) event.preventDefault();
      });
      dialog.addEventListener("close", () => {
        if (lastDialogTrigger && lastDialogTrigger.isConnected) lastDialogTrigger.focus();
      });
    });
    let resizeTimer = 0;
    global.addEventListener("resize", () => {
      global.clearTimeout(resizeTimer);
      resizeTimer = global.setTimeout(scalePreviews, 120);
    });
    global.addEventListener("pagehide", persistNow);
  }

  global.SirenApp = Object.freeze({
    getState: () => deepClone(state),
    setState: async (next) => replaceDraft(next, "Черновик обновлен."),
    renderPreviews,
    runValidation: () => Model.validateState(state),
    buildDocumentBlocks,
    sanitizeRichText: (value) => {
      const holder = document.createElement("div");
      holder.append(safeRichFragment(value));
      return holder.innerHTML;
    }
  });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
  else initialize();
})(window);
