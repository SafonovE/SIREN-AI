"use strict";
const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");

async function atomicJson(filename, value) {
  const temp = `${filename}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(value), { mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(temp, filename); break; }
      catch (error) {
        // Windows indexing, sync and antivirus can briefly lock the old file.
        // Keep both the old valid snapshot and the new temp intact while retrying.
        if (!["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt >= 6) throw error;
        await delay(Math.min(400, 40 * 2 ** attempt));
      }
    }
  } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
}
module.exports = { atomicJson };
