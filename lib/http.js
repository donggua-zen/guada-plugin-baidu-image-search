"use strict";

/**
 * 最小 HTTP 客户端（零依赖，基于 Node 内置模块）。
 *
 * 目标不是"通用 fetch"，而是安全地抓取**外部公网**资源：
 * 1. 每一跳（含重定向）都重新解析 DNS，并拒绝内网/回环/链路本地地址；
 * 2. 把已校验的 IP 通过自定义 `lookup` 钉死到本次连接，
 *    避免"先检查、再普通解析"之间被 DNS 重绑定钻空子；
 * 3. 限制重定向次数、超时、响应体大小，防止被恶意站点拖死。
 */

const dns = require("dns");
const http = require("http");
const https = require("https");
const net = require("net");
const zlib = require("zlib");

const MAX_REDIRECTS = 3;

class HttpError extends Error {}

/** 判断 IP 是否属于不可访问的非公网段 */
function isPrivateAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const parts = address.split(".").map((n) => Number.parseInt(n, 10));
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return true;
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 192 && b === 0) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  if (family === 6) {
    const lower = address.toLowerCase();
    if (lower === "::" || lower === "::1") return true;
    if (lower.startsWith("::ffff:")) return isPrivateAddress(lower.slice(7));
    if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true; // fc00::/7 唯一本地地址
    if (/^fe[89ab][0-9a-f]:/.test(lower)) return true; // fe80::/10 链路本地
    return false;
  }
  return true; // 无法识别 → 一律拒绝
}

/** 解析主机并返回一个已确认是公网的地址 */
async function resolvePublicHost(hostname) {
  const host = String(hostname || "").trim().toLowerCase().replace(/\.$/, "");
  if (!host) throw new HttpError("URL has no hostname");
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new HttpError(`refusing to fetch non-public host: ${host}`);
  }

  if (net.isIP(host)) {
    if (isPrivateAddress(host)) {
      throw new HttpError(`refusing to fetch non-public address: ${host}`);
    }
    return { address: host, family: net.isIP(host) };
  }

  let records;
  try {
    records = await dns.promises.lookup(host, { all: true, verbatim: true });
  } catch (error) {
    throw new HttpError(`DNS lookup failed for ${host}: ${error.message}`);
  }
  if (!records.length) throw new HttpError(`DNS lookup returned no address for ${host}`);
  for (const record of records) {
    if (isPrivateAddress(record.address)) {
      throw new HttpError(`refusing to fetch non-public address: ${host} -> ${record.address}`);
    }
  }
  return records[0];
}

function decodeBody(buffer, encoding) {
  const value = String(encoding || "").toLowerCase();
  if (value.includes("br")) return zlib.brotliDecompressSync(buffer);
  if (value.includes("gzip")) return zlib.gunzipSync(buffer);
  if (value.includes("deflate")) return zlib.inflateSync(buffer);
  return buffer;
}

/** 单次请求（不跟重定向），返回 { statusCode, headers, body } */
function requestOnce(target, pinned, options) {
  const { headers, timeoutMs, maxBytes, signal } = options;
  const isHttps = target.protocol === "https:";
  const transport = isHttps ? https : http;

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    const req = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: "GET",
        headers: { "Accept-Encoding": "gzip, deflate, br", ...headers },
        // 把连接钉在已校验的公网 IP 上；SNI/证书校验仍按原主机名进行
        lookup: (hostname, opts, callback) => {
          const done = typeof opts === "function" ? opts : callback;
          if (opts && typeof opts === "object" && opts.all) {
            done(null, [{ address: pinned.address, family: pinned.family }]);
          } else {
            done(null, pinned.address, pinned.family);
          }
        },
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            res.destroy(new HttpError(`response larger than ${maxBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          try {
            const raw = Buffer.concat(chunks);
            finish(resolve, {
              statusCode: res.statusCode || 0,
              headers: res.headers,
              body: decodeBody(raw, res.headers["content-encoding"]),
            });
          } catch (error) {
            finish(reject, new HttpError(`failed to decode response: ${error.message}`));
          }
        });
        res.on("error", (error) => finish(reject, error));
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new HttpError(`request timed out after ${timeoutMs}ms`));
    });
    req.on("error", (error) => finish(reject, error));
    if (signal) {
      if (signal.aborted) {
        req.destroy(new HttpError("request cancelled"));
      } else {
        signal.addEventListener("abort", () => req.destroy(new HttpError("request cancelled")), {
          once: true,
        });
      }
    }
    req.end();
  });
}

/**
 * GET 一个公网 URL，自动跟随少量重定向。
 *
 * @param {string} rawUrl
 * @param {{ headers?: Record<string,string>, timeoutMs?: number, maxBytes?: number, signal?: AbortSignal }} options
 */
async function getPublicUrl(rawUrl, options = {}) {
  const {
    headers = {},
    timeoutMs = 15000,
    maxBytes = 24 * 1024 * 1024,
    signal,
  } = options;

  let current;
  try {
    current = new URL(rawUrl);
  } catch {
    throw new HttpError(`invalid URL: ${rawUrl}`);
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (signal?.aborted) throw new HttpError("request cancelled");
    if (current.protocol !== "http:" && current.protocol !== "https:") {
      throw new HttpError(`unsupported protocol: ${current.protocol}`);
    }
    const pinned = await resolvePublicHost(current.hostname);
    const response = await requestOnce(current, pinned, {
      headers,
      timeoutMs,
      maxBytes,
      signal,
    });

    const status = response.statusCode;
    if (status >= 300 && status < 400 && response.headers.location) {
      const next = new URL(String(response.headers.location), current);
      current = next;
      continue;
    }
    return response;
  }
  throw new HttpError(`too many redirects (limit ${MAX_REDIRECTS})`);
}

module.exports = {
  HttpError,
  getPublicUrl,
  isPrivateAddress,
  resolvePublicHost,
};
