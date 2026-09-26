(function (root) {
  "use strict";
  function words(source) {
    const input = source.replace(/(?:\\|`|\^)\r?\n/g, " ").trim();
    const result = []; let value = "", quote = "", started = false;
    for (let i = 0; i < input.length; i++) {
      const c = input[i];
      if (quote) {
        if (c === quote) quote = "";
        else if (c === "\\" && quote === '"' && ['"', "\\", "$", "`"].includes(input[i + 1])) value += input[++i];
        else value += c;
      } else if (c === "'" || c === '"') { quote = c; started = true; }
      else if (/\s/.test(c)) { if (started || value) result.push(value); value = ""; started = false; }
      else if (c === "\\" && i + 1 < input.length) { value += input[++i]; started = true; }
      else if (/[|;<>`]/.test(c) || (c === "&" && !value.startsWith("http"))) throw new Error("Вставьте одну команду cURL без команд оболочки, перенаправлений и конвейеров.");
      else { value += c; started = true; }
    }
    if (quote) throw new Error("В примере cURL не закрыта кавычка. Скопируйте команду целиком.");
    if (started || value) result.push(value);
    return result;
  }
  function parseCurl(source) {
    if (typeof source !== "string" || source.length > 262144) throw new Error("Пример cURL слишком большой. Оставьте адрес, заголовки и короткий JSON с моделью.");
    const args = words(source); const warnings = []; const headers = {}; let url = "", body = "", method = "POST", basic = "";
    if (!/^(?:curl|curl\.exe)$/i.test(args.shift() || "")) throw new Error("Команда должна начинаться с curl или curl.exe.");
    for (let i = 0; i < args.length; i++) {
      let arg = args[i], inline;
      if (arg.startsWith("--") && arg.includes("=")) { [arg, ...inline] = arg.split("="); inline = inline.join("="); }
      const next = () => { const v = inline === undefined ? args[++i] : inline; if (v === undefined) throw new Error(`После ${arg} отсутствует значение.`); return v; };
      if (["-H", "--header"].includes(arg)) { const h = next(); const p = h.indexOf(":"); if (p < 1) throw new Error("Заголовок cURL должен иметь вид «Имя: значение»."); headers[h.slice(0, p).trim().toLowerCase()] = h.slice(p + 1).trim(); }
      else if (["-d", "--data", "--data-raw", "--data-binary", "--json"].includes(arg)) body = next();
      else if (["-X", "--request"].includes(arg)) method = next().toUpperCase();
      else if (["-u", "--user"].includes(arg)) basic = next();
      else if (arg === "--url") url = next();
      else if (/^https?:\/\//i.test(arg)) url = arg;
      else if (["-s", "-S", "-sS", "--silent", "--show-error", "-N", "--no-buffer", "--compressed"].includes(arg)) continue;
      else if (["-k", "--insecure", "-L", "--location"].includes(arg)) warnings.push("Отключение проверки сертификата и автоматические перенаправления не импортируются.");
      else throw new Error(`Параметр ${arg.slice(0, 40)} пока не поддерживается. Оставьте URL, -H и JSON в -d; файлы и команды оболочки не выполняются.`);
    }
    if (method !== "POST") throw new Error("Нужен пример POST-запроса к модели. Запрос списка моделей или загрузки файла не подходит.");
    if (!url) throw new Error("В примере не найден полный URL API.");
    if (/\$\(|\$\{|%[A-Za-z_]+%|\$[A-Za-z_]/.test(url + body + Object.values(headers).join(" "))) warnings.push("Переменные окружения не вычисляются. Замените обозначения $API_KEY и похожие на реальные значения в соответствующих полях.");
    const parsed = new URL(url);
    if (parsed.username || parsed.password) throw new Error("Уберите логин и пароль из URL; используйте заголовок Authorization.");
    if (body.startsWith("@")) throw new Error("Содержимое @файла не читается. Вставьте JSON прямо в пример cURL.");
    let data = {};
    if (body) { try { data = JSON.parse(body); } catch { throw new Error("Тело cURL не является корректным JSON. Проверьте кавычки и скопируйте пример целиком."); } }
    let providerId = "custom-openai", model = typeof data.model === "string" ? data.model : "";
    const host = parsed.hostname.toLowerCase(), route = parsed.pathname;
    if (route === "/api/chat") providerId = "ollama";
    else if (host === "api.openai.com" && /\/responses$/.test(route)) providerId = "openai";
    else if (host === "api.anthropic.com") providerId = "anthropic";
    else if (host === "generativelanguage.googleapis.com") providerId = "gemini";
    else if (host === "openrouter.ai") providerId = "openrouter";
    else if (host === "api.deepseek.com") providerId = "deepseek";
    else if (host.includes("dashscope")) providerId = "qwen";
    const local = ["127.0.0.1", "localhost", "[::1]"].includes(host);
    const suffix = route.match(/\/(?:chat\/completions|responses|messages|api\/chat)$/)?.[0];
    const config = { baseUrl: parsed.origin + (suffix ? route.slice(0, -suffix.length) : ""), chatPath: suffix || route, model, dataBoundary: local ? "local" : "public", authType: "none", tokenHeader: "Authorization" };
    if (providerId === "gemini") { config.baseUrl = parsed.origin + "/v1beta"; config.chatPath = ""; config.model = /\/models\/([^:]+):/.exec(route)?.[1] || model; }
    let token = "";
    const auth = headers.authorization;
    if (auth) { const m = /^(Bearer|Basic)\s+(.+)$/i.exec(auth); if (m) { config.authType = m[1].toLowerCase(); token = m[2]; } else { config.authType = "custom-header"; token = auth; config.customHeaderName = "Authorization"; } }
    else if (basic) { config.authType = "basic"; token = typeof btoa === "function" ? btoa(basic) : Buffer.from(basic).toString("base64"); }
    else for (const h of ["x-api-key", "x-goog-api-key", "api-key", "x-client-token"]) if (headers[h]) { config.authType = "custom-header"; config.tokenHeader = h; config.customHeaderName = h; token = headers[h]; break; }
    if (providerId === "anthropic" && headers["x-api-key"]) config.authType = "api-key";
    if (providerId === "ollama" && !local) throw new Error("Этот пример обращается к удалённой Ollama. Для локальной обработки укажите http://127.0.0.1:11434/api/chat. Удалённый адрес требует отдельной настройки границы передачи данных.");
    for (const key of parsed.searchParams.keys()) if (/token|secret|credential|api[-_]?key/i.test(key)) throw new Error("В URL найден секрет. Перенесите его в заголовок авторизации, затем повторите импорт; секреты в адресе не сохраняются.");
    if (parsed.searchParams.has("key")) { token = parsed.searchParams.get("key"); config.authType = "api-key"; config.tokenHeader = "x-goog-api-key"; parsed.searchParams.delete("key"); }
    if (parsed.searchParams.toString()) { config.chatPath += "?" + parsed.searchParams.toString(); warnings.push("Проверьте параметры URL: секреты должны находиться в поле токена, а не в адресе."); }
    if (headers["anthropic-version"]) config.apiVersion = headers["anthropic-version"];
    if (headers["x-folder-id"]) config.folderId = headers["x-folder-id"];
    if (Number.isFinite(data.temperature)) config.temperature = data.temperature;
    if (Number.isFinite(data.max_tokens ?? data.max_output_tokens)) config.maxTokens = data.max_tokens ?? data.max_output_tokens;
    const known = new Set(["authorization", "content-type", "accept", "x-api-key", "x-goog-api-key", "api-key", "x-client-token", "anthropic-version", "x-folder-id"]);
    for (const h of Object.keys(headers)) if (!known.has(h)) warnings.push(`Заголовок «${h}» не перенесён. Проверьте, обязателен ли он для вашего API.`);
    if (!config.model && providerId !== "custom-webhook") warnings.push("В примере нет имени модели — заполните поле «Модель».");
    if (!suffix && providerId !== "gemini") warnings.push("Неизвестный формат API. Адрес перенесён; проверьте совместимость с OpenAI или выберите REST webhook и укажите путь к ответу.");
    return { providerId, config, token, warnings: [...new Set(warnings)] };
  }
  if (typeof module === "object" && module.exports) module.exports = { parseCurl, words };
  else root.SirenCurlImport = { parseCurl };
})(typeof window !== "undefined" ? window : globalThis);
