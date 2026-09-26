"use strict";

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { asPlainText } = require("./util");

function powershellPath() {
  if (process.platform !== "win32") return "";
  return path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function spawnCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env || process.env,
    });
    const stdout = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const maxOutput = options.maxOutput || 4 * 1024 * 1024;
    let finished = false;
    const timer = setTimeout(() => {
      child.kill();
      if (!finished) {
        finished = true;
        reject(new Error("HELPER_TIMEOUT"));
      }
    }, options.timeoutMs || 60000);
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= maxOutput) stdout.push(chunk);
      else child.kill();
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 16384) child.kill();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (!finished) {
        finished = true;
        reject(error);
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (finished) return;
      finished = true;
      if (stdoutBytes > maxOutput) reject(new Error("HELPER_OUTPUT_LIMIT"));
      else if (code !== 0) reject(new Error("HELPER_FAILED"));
      else resolve(Buffer.concat(stdout).toString("utf8"));
    });
  });
}

async function runWindowsOcr(scriptPath, imagePaths, timeoutMs) {
  const executable = powershellPath();
  if (!executable || !imagePaths.length) throw new Error("OCR_UNAVAILABLE");
  const stdout = await spawnCapture(
    executable,
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...imagePaths],
    { timeoutMs, maxOutput: 8 * 1024 * 1024 }
  );
  const result = JSON.parse(stdout.replace(/^\uFEFF/, ""));
  if (!result || result.ok !== true || !Array.isArray(result.results) || result.results.length !== imagePaths.length) throw new Error("OCR_FAILED");
  return result.results.map((item) => asPlainText(item && item.text, 300000));
}

async function resolveWindowsShortPaths(literalPaths) {
  const originals = literalPaths.map((item) => path.resolve(item));
  const executable = powershellPath();
  if (!executable || !originals.length) return originals;
  const scriptPath = path.join(__dirname, "windows-short-path.ps1");
  try {
    const stdout = await spawnCapture(
      executable,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...originals],
      { timeoutMs: 15000, maxOutput: 256 * 1024 }
    );
    const result = JSON.parse(stdout.replace(/^\uFEFF/, ""));
    if (!result || result.ok !== true || !Array.isArray(result.paths) || result.paths.length !== originals.length) return originals;
    return result.paths.map((item, index) => path.isAbsolute(item) ? item : originals[index]);
  } catch (_error) {
    // Some Windows volumes have 8.3 names disabled; Poppler can still attempt the Unicode path.
    return originals;
  }
}

async function withTempDirectory(callback) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "SirenAI-OCR-"));
  try {
    return await callback(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

function makeDefaultExtractors(options = {}) {
  const appRoot = path.resolve(options.appRoot || path.join(__dirname, ".."));
  const ocrScript = path.join(appRoot, "server", "windows-ocr.ps1");
  const popplerBin = path.join(appRoot, "runtime", "poppler", "Library", "bin");
  const pdftoppm = path.join(popplerBin, "pdftoppm.exe");
  const pdfinfo = path.join(popplerBin, "pdfinfo.exe");
  const popplerData = path.join(appRoot, "runtime", "poppler", "share", "poppler");
  let popplerToolsPromise;

  function popplerTools() {
    if (!popplerToolsPromise) {
      popplerToolsPromise = resolveWindowsShortPaths([pdftoppm, pdfinfo, popplerData])
        .then(([shortPdftoppm, shortPdfinfo, shortData]) => ({
          pdftoppm: shortPdftoppm,
          pdfinfo: shortPdfinfo,
          data: shortData,
        }));
    }
    return popplerToolsPromise;
  }

  async function image(file) {
    return withTempDirectory(async (directory) => {
      const extension = [".png", ".jpg", ".jpeg", ".webp"].includes(file.extension) ? file.extension : ".img";
      const inputPath = path.join(directory, `image${extension}`);
      await fs.writeFile(inputPath, file.buffer, { mode: 0o600 });
      try {
        const [text] = await runWindowsOcr(ocrScript, [inputPath], 60000);
        return { text, complete: true, warnings: text ? [] : ["OCR не обнаружил текст на изображении."] };
      } catch (_error) {
        return { text: "", complete: false, warnings: ["Не удалось выполнить локальный OCR изображения."] };
      }
    });
  }

  async function pdf(file) {
    const { extractPdfBasic } = require("./files");
    const basic = extractPdfBasic(file.buffer);
    return withTempDirectory(async (directory) => {
      const tools = await popplerTools();
      const inputPath = path.join(directory, "document.pdf");
      await fs.writeFile(inputPath, file.buffer, { mode: 0o600 });
      let pageCount;
      try {
        const info = await spawnCapture(tools.pdfinfo, [inputPath], { cwd: directory, timeoutMs: 30000, maxOutput: 256 * 1024 });
        pageCount = Number(/^Pages:\s+(\d+)\s*$/im.exec(info)?.[1]);
      } catch { /* Report incomplete extraction instead of pretending all pages were read. */ }
      if (!Number.isInteger(pageCount) || pageCount < 1) return { text: basic.text, complete: false, warnings: ["Не удалось определить число страниц PDF. Пересохраните документ без пароля или экспортируйте его текст в DOCX/TXT; полнота этого результата не подтверждена."] };
      if (pageCount > 5000) throw new Error("PDF содержит больше 5000 страниц. Разделите его на несколько файлов и добавьте в ту же обработку.");
      const texts = []; const warnings = []; let complete = true;
      const cacheDir = file.extractionCacheDir;
      if (cacheDir) await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 });
      for (let page = 1; page <= pageCount; page++) {
        if (file.signal?.aborted) throw new Error("Обработка PDF приостановлена. Распознанные страницы сохранены.");
        await file.onExtractionProgress?.({ phase: "extract", message: `Распознаём PDF: страница ${page} из ${pageCount}` });
        const cachePath = cacheDir && path.join(cacheDir, `page-${page}.json`);
        let cached = null;
        if (cachePath) { try { cached = JSON.parse(await fs.readFile(cachePath, "utf8")); } catch { /* This page needs processing. */ } }
        if (!cached) {
          const outputPrefix = path.join(directory, `render-${page}`);
          const imagePath = `${outputPrefix}.png`;
          try {
            await spawnCapture(tools.pdftoppm, ["-f", String(page), "-l", String(page), "-singlefile", "-r", "120", "-png", inputPath, outputPrefix], { cwd: directory, timeoutMs: 120000, maxOutput: 256 * 1024 });
            const [text] = await runWindowsOcr(ocrScript, [imagePath], 90000);
            cached = { text };
            if (cachePath) await fs.writeFile(cachePath, JSON.stringify(cached), { mode: 0o600 });
          } catch (error) {
            if (["ENOSPC", "EACCES", "EPERM"].includes(error.code)) throw error;
            complete = false; warnings.push(`Страница ${page} PDF не распознана. Экспортируйте эту страницу в PNG или добавьте её текст отдельно.`);
            cached = { text: "" };
          } finally { await fs.rm(imagePath, { force: true }).catch(() => {}); }
        }
        texts.push(`[Страница ${page}]\n${cached.text}`);
      }
      warnings.push("PDF обработан постраничным OCR. Схемы, цвет и расположение элементов проверьте по оригиналу; для зрительного анализа добавьте нужные страницы изображениями.");
      return { text: texts.join("\n\n"), complete, warnings };
    });
  }

  return { image, pdf };
}

module.exports = { makeDefaultExtractors, resolveWindowsShortPaths, runWindowsOcr, spawnCapture };
