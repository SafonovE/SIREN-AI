"use strict";

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { HttpError, isRecord, randomToken } = require("./util");

const DPAPI_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Security
$operation = $args[0]
$inputValue = [Console]::In.ReadToEnd()
$entropy = [System.Text.Encoding]::UTF8.GetBytes('Siren AI credentials v1')
if ($operation -eq 'protect') {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($inputValue)
  $protected = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::Out.Write([Convert]::ToBase64String($protected))
} elseif ($operation -eq 'unprotect') {
  $protected = [Convert]::FromBase64String($inputValue.Trim())
  $bytes = [System.Security.Cryptography.ProtectedData]::Unprotect($protected, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($bytes))
} else {
  throw 'Unsupported DPAPI operation.'
}
`;

function defaultDataDir() {
  if (process.env.SIREN_AI_DATA_DIR) return path.resolve(process.env.SIREN_AI_DATA_DIR);
  if (process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, "SirenAI-v2");
  return path.join(os.homedir(), ".siren-ai-v2");
}

function powershellPath() {
  if (process.platform !== "win32") return null;
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  return path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function runDpapi(operation, input, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const executable = powershellPath();
    if (!executable) {
      reject(new Error("DPAPI доступен только в Windows."));
      return;
    }
    const encoded = Buffer.from(DPAPI_SCRIPT, "utf16le").toString("base64");
    const child = spawn(executable, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded, operation], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      if (!settled) {
        settled = true;
        reject(new Error("Операция DPAPI превысила лимит времени."));
      }
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      if (Buffer.concat(stdout).length < 2 * 1024 * 1024) stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (Buffer.concat(stderr).length < 8192) stderr.push(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code !== 0) reject(new Error(`DPAPI завершился с кодом ${code}.`));
      else resolve(Buffer.concat(stdout).toString("utf8"));
    });
    child.stdin.end(String(input), "utf8");
  });
}

class CredentialStore {
  constructor(options = {}) {
    this.dataDir = path.resolve(options.dataDir || defaultDataDir());
    this.filePath = path.join(this.dataDir, "credentials.dpapi.json");
    this.memory = new Map();
    this.remembered = new Map();
    this.dpapi = options.dpapi || runDpapi;
    this.ready = this.load();
  }

  async load() {
    try {
      const envelope = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      if (!isRecord(envelope) || envelope.version !== 1 || typeof envelope.protected !== "string") return;
      const clear = await this.dpapi("unprotect", envelope.protected);
      const parsed = JSON.parse(clear);
      if (!isRecord(parsed)) return;
      for (const [providerId, secret] of Object.entries(parsed)) {
        if (typeof secret === "string" && secret) {
          this.remembered.set(providerId, secret);
          this.memory.set(providerId, secret);
        }
      }
    } catch (_error) {
      // Missing, corrupt, or copied DPAPI data is ignored. A credential is never logged.
    }
  }

  async persist() {
    await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    if (this.remembered.size === 0) {
      await fs.rm(this.filePath, { force: true });
      return;
    }
    const clear = JSON.stringify(Object.fromEntries(this.remembered));
    const protectedValue = await this.dpapi("protect", clear);
    const envelope = JSON.stringify({ version: 1, protected: protectedValue });
    const tempPath = `${this.filePath}.${process.pid}.${randomToken(6)}.tmp`;
    await fs.writeFile(tempPath, envelope, { encoding: "utf8", mode: 0o600 });
    await fs.rename(tempPath, this.filePath);
  }

  async get(providerId) {
    await this.ready;
    return this.memory.get(providerId) || "";
  }

  async has(providerId) {
    return Boolean(await this.get(providerId));
  }

  async isRemembered(providerId) {
    await this.ready;
    return this.remembered.has(providerId);
  }

  async set(providerId, secret, remember) {
    await this.ready;
    const normalized = typeof secret === "string" ? secret.trim() : "";
    if (!normalized) throw new HttpError(400, "CREDENTIAL_REQUIRED", "Введите ключ или токен доступа.");
    if (/[\r\n]/.test(normalized) || normalized.length > 16000) {
      throw new HttpError(400, "INVALID_CREDENTIAL", "Ключ содержит недопустимые символы или слишком велик.");
    }
    this.memory.set(providerId, normalized);
    if (remember) this.remembered.set(providerId, normalized);
    else this.remembered.delete(providerId);
    if (remember || !remember) {
      try {
        await this.persist();
      } catch (_error) {
        if (remember) {
          this.remembered.delete(providerId);
          throw new HttpError(422, "CREDENTIAL_NOT_PERSISTED", "Не удалось сохранить ключ через Windows DPAPI. Ключ оставлен только до закрытия программы.");
        }
      }
    }
  }

  async delete(providerId) {
    await this.ready;
    this.memory.delete(providerId);
    this.remembered.delete(providerId);
    try {
      await this.persist();
    } catch (_error) {
      // Deleting the in-memory value still succeeds; no secret enters the error.
    }
  }

  secretValues() {
    return [...this.memory.values()];
  }
}

module.exports = { CredentialStore, defaultDataDir, runDpapi };
