"use strict";

const path = require("node:path");
const { createServer } = require("./index");

function requiredLoopbackHost(value) {
  const host = String(value || "127.0.0.1").trim();
  if (host !== "127.0.0.1") throw new Error("SIREN_AI_HOST must be exactly 127.0.0.1.");
  return host;
}

function validPort(value) {
  const port = Number(value || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("SIREN_AI_PORT must be an integer from 1 to 65535.");
  return port;
}

function startFromEnvironment() {
  const host = requiredLoopbackHost(process.env.SIREN_AI_HOST);
  const port = validPort(process.env.SIREN_AI_PORT);
  const staticRoot = path.resolve(process.env.SIREN_AI_ROOT || path.join(__dirname, ".."));
  const server = createServer({ staticRoot, instanceId: process.env.SIREN_AI_INSTANCE_ID || "" });
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  server.once("error", (error) => {
    process.stderr.write(`SIREN_AI_START_FAILED ${error && error.code ? error.code : "UNKNOWN"}\n`);
    process.exitCode = 1;
  });
  server.listen(port, host, () => {
    process.stdout.write(`SIREN_AI_READY ${port}\n`);
  });
  return server;
}

if (require.main === module) startFromEnvironment();

module.exports = { createServer, startFromEnvironment, requiredLoopbackHost, validPort };
