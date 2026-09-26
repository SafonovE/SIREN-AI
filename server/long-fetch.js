"use strict";

// The request AbortSignal owns the entire deadline, including response headers.
// Native fetch has a separate five-minute header deadline in the bundled runtime.
const http = require("node:http");
const https = require("node:https");
function longFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const client = target.protocol === "https:" ? https : http;
    if (!["http:", "https:"].includes(target.protocol)) return reject(new Error("Unsupported protocol"));
    const request = client.request(target, {
      method: options.method || "GET", headers: options.headers, signal: options.signal,
      // Never disable certificate verification or forward credentials on redirects.
      agent: false,
    }, (response) => {
      response.cancel = async () => response.destroy();
      resolve({
        ok: response.statusCode >= 200 && response.statusCode < 300,
        status: response.statusCode,
        headers: new Headers(Object.entries(response.headers).filter(([, v]) => v !== undefined).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : v])),
        body: response,
      });
    });
    request.once("error", reject);
    request.end(options.body);
  });
}
module.exports = { longFetch };
