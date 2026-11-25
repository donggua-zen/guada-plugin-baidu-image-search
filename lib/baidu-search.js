"use strict";

/**
 * 百度图片搜索（移植自 D:/AI/work/public/tools/baidu_img/baidu_image_search.py）。
 *
 * 只保留插件真正需要的两件事：
 * 1) searchImages：请求 image.baidu.com 网页端 acjson 接口，归一化结果；
 * 2) downloadImage：下载单张原图（失败退回 CDN 副本）到插件数据目录。
 *
 * 刻意不做的：
 * - 不在插件里转码（JPEG/长边缩放）。宿主 chat 引擎物化 imageRefs 时会按
 *   「工具图 150KB 预算」统一转码，插件再转一次是重复有损编码。
 * - 不内置测试网页 / 代理接口（参考项目的 Flask 部分只服务于本地调试）。
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { HttpError, getPublicUrl } = require("./http");

const ACJSON_URL = "https://image.baidu.com/search/acjson";
const HOME_URL = "https://image.baidu.com/";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const MAX_PAGE_SIZE = 60;
const MAX_DOWNLOAD_BYTES = 24 * 1024 * 1024;
const SEARCH_TIMEOUT_MS = 12000;
const DOWNLOAD_TIMEOUT_MS = 15000;
/** 两次搜索的最小间隔；网页接口对高频很敏感 */
const MIN_SEARCH_INTERVAL_MS = 1200;
/** 缓存目录保留的文件数上限（超出按 mtime 从旧到新删） */
const MAX_CACHED_FILES = 200;

const SEARCH_HEADERS = {
  "User-Agent": USER_AGENT,
  Accept: "text/plain, */*; q=0.01",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  Referer: HOME_URL,
  "X-Requested-With": "XMLHttpRequest",
  Connection: "keep-alive",
};

let lastSearchAt = 0;
/** 串行化搜索请求：同一进程内不并发打百度 */
let searchChain = Promise.resolve();

const IMAGE_SIGNATURES = [
  { magic: Buffer.from([0xff, 0xd8, 0xff]), mime: "image/jpeg", ext: "jpg" },
  { magic: Buffer.from([0x89, 0x50, 0x4e, 0x47]), mime: "image/png", ext: "png" },
  { magic: Buffer.from("GIF8"), mime: "image/gif", ext: "gif" },
  { magic: Buffer.from("RIFF"), mime: "image/webp", ext: "webp" },
  { magic: Buffer.from("BM"), mime: "image/bmp", ext: "bmp" },
];

/** 扩展名 → MIME（缓存命中时没有响应头可依，按落盘扩展名还原） */
const MIME_BY_EXT = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  avif: "image/avif",
};

/** MIME → 落盘扩展名（转码后统一按实际格式命名） */
const MIME_BY_EXT_INV = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/bmp": "bmp",
  "image/avif": "avif",
};

// --------------------------------------------------------------------------
// JSON 修复：百度返回体的两类常见破损
//   1) 非法转义（`\x` 之类）——JSON 规范里不存在的转义序列
//   2) 字符串里夹裸控制字符（原始换行/制表符）——网页端接口把标题原样拼进去
// 两者都会让 JSON.parse 直接抛错，且 2) 比 1) 更常见（标题含换行时必现）。
// --------------------------------------------------------------------------

const VALID_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);

/** 裸控制字符 → 合法转义；非可打印的其余 C0 控制符统一转 \u00XX */
function escapeControl(ch) {
  switch (ch) {
    case "\n":
      return "\\n";
    case "\r":
      return "\\r";
    case "\t":
      return "\\t";
    case "\b":
      return "\\b";
    case "\f":
      return "\\f";
    default:
      return `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
  }
}

function repairJson(raw) {
  // BOM 会让 JSON.parse 在位置 0 就失败
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const out = [];
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!inString) {
      if (ch === '"') inString = true;
      out.push(ch);
      continue;
    }
    if (ch === "\\") {
      const next = text[i + 1] || "";
      if (next && VALID_ESCAPES.has(next)) {
        out.push(ch + next);
        i += 1;
        continue;
      }
      // 非法转义（如 \x）：补一个反斜杠，让它变成字面量
      out.push("\\\\");
      continue;
    }
    if (ch === '"') {
      inString = false;
      out.push(ch);
      continue;
    }
    // 字符串内的裸控制字符（< 0x20）必须转义，否则整包解析失败
    if (ch < " ") {
      out.push(escapeControl(ch));
      continue;
    }
    out.push(ch);
  }
  return out.join("");
}

function parseJsonLenient(text) {
  try {
    return JSON.parse(text);
  } catch {
    return JSON.parse(repairJson(text));
  }
}

/**
 * 兜底抢救：整包解析失败时，从 `"data": [...]` 里逐个切出完整的顶层对象。
 *
 * 用于修复也无法解决的破损（如某一条里出现无法判定的引号、响应被截断）。
 * 拿回多少算多少——比整批丢弃好，模型至少能看到部分结果。
 */
function salvageDataItems(text) {
  const keyMatch = /"data"\s*:\s*\[/.exec(text);
  if (!keyMatch) return [];

  const objects = [];
  let depth = 0;
  let objStart = -1;
  let inString = false;

  for (let i = keyMatch.index + keyMatch[0].length; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") {
        i += 1; // 跳过被转义的字符，避免把 \" 当成字符串结束
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) objStart = i;
      depth += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0 && objStart >= 0) {
        objects.push(text.slice(objStart, i + 1));
        objStart = -1;
      }
      continue;
    }
    if (ch === "]" && depth === 0) break; // data 数组结束
  }

  const items = [];
  for (const chunk of objects) {
    try {
      items.push(parseJsonLenient(chunk));
    } catch {
      // 单条破损就跳过，不影响其余条目
    }
  }
  return items;
}

// --------------------------------------------------------------------------
// 归一化
// --------------------------------------------------------------------------

function cleanText(value) {
  if (!value) return "";
  return String(value)
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isHttpUrl(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

/**
 * 百度把图源分成三套，清晰度差很多，而且**稳定性差很多**：
 *
 * - `original`（replaceUrl[].ObjURL）：真原图，但常指向第三方站点
 *   （抖音/微博/bcebos/zcool…）。这些站要么缺 nosniff、要么防盗链、要么 URL 带
 *   时效签名，浏览器 `![](url)` 直连失败率很高（实测约一半，报 ERR_BLOCKED_BY_ORB）。
 * - `cdn`（middleURL/thumbURL）：百度自家 CDN（img*.baidu.com）的副本，
 *   尺寸略小但**浏览器直连几乎总能显示**——这才是给用户展示的首选。
 * - `primary`：下载首选（原图缺失时才退 CDN），供插件自己取字节用，
 *   不代表"适合展示"。
 */
function pickUrls(raw) {
  let cdn = "";
  for (const key of ["middleURL", "thumbURL", "hoverURL"]) {
    if (isHttpUrl(raw[key])) {
      cdn = raw[key];
      break;
    }
  }

  let original = "";
  for (const entry of raw.replaceUrl || []) {
    if (entry && isHttpUrl(entry.ObjURL)) {
      original = entry.ObjURL;
      break;
    }
  }
  if (!original && !cdn) {
    for (const entry of raw.replaceUrl || []) {
      if (entry && isHttpUrl(entry.FromURL)) {
        cdn = entry.FromURL;
        break;
      }
    }
  }

  return { original, cdn, primary: original || cdn };
}

/** 是否百度自家域名：这类地址浏览器直连稳定，适合放进 Markdown 展示 */
function isBaiduHosted(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return /(^|\.)(baidu\.com|bdstatic\.com|bdimg\.com|bcebos\.com)$/.test(host);
  } catch {
    return false;
  }
}

/**
 * 挑一个"适合展示给用户"的地址。
 *
 * 优先级：百度 CDN 副本 > 百度自家其他域名（bdstatic/bcebos）> 原图。
 * 原图只在没有百度副本时才用——它是第三方站地址，界面里裂图概率高。
 */
function pickDisplayUrl(urls) {
  const { original, cdn } = urls;
  if (cdn && isBaiduHosted(cdn)) return cdn;
  if (original && isBaiduHosted(original)) return original;
  return cdn || original;
}

/** fromURL 有时是混淆串，只接受真正的 http(s)，否则退化到可点开的页面 */
function pickPageUrl(raw, host, query) {
  const candidates = [raw.fromURL];
  for (const entry of raw.replaceUrl || []) {
    if (entry) candidates.push(entry.FromURL);
  }
  for (const candidate of candidates) {
    if (isHttpUrl(candidate)) return candidate;
  }
  if (host) return `https://${String(host).replace(/^\/+/, "")}`;
  return `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`;
}

function toDimension(value) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function normalizeItem(raw, query) {
  const urls = pickUrls(raw);
  if (!urls.primary) return null;
  const host = cleanText(raw.fromURLHost);
  return {
    title: cleanText(raw.fromPageTitleEnc || raw.fromPageTitle),
    image_url: urls.primary,
    original_url: urls.original,
    cdn_url: urls.cdn,
    /** 适合放进 Markdown 给用户看的地址（优先百度自家 CDN，直连不易裂图） */
    display_url: pickDisplayUrl(urls),
    width: toDimension(raw.width),
    height: toDimension(raw.height),
    type: cleanText(raw.type),
    host,
    page_url: pickPageUrl(raw, host, query),
    query,
  };
}

function buildSearchParams(query, pn, rn) {
  return new URLSearchParams({
    tn: "resultjson_com",
    logid: String(Math.floor(1e12 + Math.random() * 9e12)),
    ipn: "rj",
    ct: "201326592",
    is: "",
    fp: "result",
    fr: "",
    word: query,
    queryWord: query,
    cl: "2",
    lm: "-1",
    ie: "utf-8",
    oe: "utf-8",
    st: "-1",
    z: "",
    ic: "",
    hd: "",
    latest: "",
    copyright: "",
    s: "",
    se: "",
    tab: "",
    width: "",
    height: "",
    face: "0",
    istype: "2",
    qc: "",
    nc: "1",
    expermode: "",
    nojc: "",
    isAsync: "",
    pn: String(pn),
    rn: String(rn),
    gsm: "1e",
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 搜索百度图片。
 *
 * @param {string} query
 * @param {{ count?: number, page?: number, signal?: AbortSignal }} options
 * @returns {Promise<{ query: string, total: number, items: Array<object> }>}
 */
async function searchImages(query, options = {}) {
  const text = String(query || "").trim();
  if (!text) throw new Error("query is required");

  const count = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.trunc(Number(options.count) || 8)));
  const page = Math.max(0, Math.min(29, Math.trunc(Number(options.page) || 0)));
  const signal = options.signal;

  const run = async () => {
    const wait = MIN_SEARCH_INTERVAL_MS - (Date.now() - lastSearchAt);
    if (wait > 0) await sleep(wait);
    lastSearchAt = Date.now();

    const items = [];
    const seen = new Set();
    let total = 0;
    let pn = page * Math.min(MAX_PAGE_SIZE, Math.max(count, 12));
    let emptyRounds = 0;

    while (items.length < count) {
      if (signal?.aborted) throw new Error("search cancelled");

      const rn = Math.min(MAX_PAGE_SIZE, Math.max(count - items.length, 12));
      const url = `${ACJSON_URL}?${buildSearchParams(text, pn, rn).toString()}`;
      const response = await getPublicUrl(url, {
        headers: SEARCH_HEADERS,
        timeoutMs: SEARCH_TIMEOUT_MS,
        maxBytes: 8 * 1024 * 1024,
        signal,
      });
      if (response.statusCode !== 200) {
        throw new Error(`Baidu Image search returned HTTP ${response.statusCode}`);
      }

      const body = response.body.toString("utf8");
      let payload;
      try {
        payload = parseJsonLenient(body);
      } catch (error) {
        // 整包解析失败（如某条里出现无法判定的引号、响应被截断）：
        // 逐条抢救 data 数组，能拿多少算多少，避免整批丢弃。
        const salvaged = salvageDataItems(body);
        if (!salvaged.length) {
          throw new Error(
            `Baidu Image search returned unparsable JSON: ${error.message} (${body.length} bytes)`,
          );
        }
        payload = { data: salvaged };
      }

      if (!total) {
        total = toDimension(payload.listNum ?? payload.displayNum);
      }

      const raws = Array.isArray(payload.data) ? payload.data.filter(Boolean) : [];
      if (!raws.length) {
        emptyRounds += 1;
        if (emptyRounds >= 2) break;
      }

      let added = 0;
      for (const raw of raws) {
        const item = normalizeItem(raw, text);
        if (!item || seen.has(item.image_url)) continue;
        seen.add(item.image_url);
        items.push(item);
        added += 1;
        if (items.length >= count) break;
      }
      if (added === 0 && raws.length) break;

      pn += rn;
      if (pn > 30 * MAX_PAGE_SIZE) break; // 太深只有重复内容
      if (items.length < count) await sleep(400);
    }

    return { query: text, total, items: items.slice(0, count) };
  };

  const task = searchChain.then(run);
  searchChain = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

// --------------------------------------------------------------------------
// 下载（带缓存）
// --------------------------------------------------------------------------

function sniffImage(buffer) {
  for (const entry of IMAGE_SIGNATURES) {
    if (buffer.subarray(0, entry.magic.length).equals(entry.magic)) {
      // RIFF 只有 WEBP 才算图片（其余是 wav/avi）
      if (entry.ext === "webp" && buffer.subarray(8, 12).toString("ascii") !== "WEBP") continue;
      return { mime: entry.mime, ext: entry.ext };
    }
  }
  // AVIF 是 ISO-BMFF（ftyp 盒）；HEIC 不认——多数视觉模型与 sharp 构建都不支持，
  // 让它当作"非图片"走 CDN 副本回退，而不是存一个模型读不了的附件。
  if (buffer.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = buffer.subarray(8, 12).toString("ascii");
    if (brand === "avif" || brand === "avis") return { mime: "image/avif", ext: "avif" };
  }
  return null;
}

function cacheDir(dataDir) {
  return path.join(dataDir, "image-cache");
}

async function pruneCache(dir) {
  let names;
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return;
  }
  if (names.length <= MAX_CACHED_FILES) return;

  const stats = [];
  for (const name of names) {
    try {
      const stat = await fs.promises.stat(path.join(dir, name));
      if (stat.isFile()) stats.push({ name, mtime: stat.mtimeMs });
    } catch {
      // 并发删除/权限问题：忽略单个文件
    }
  }
  stats.sort((a, b) => a.mtime - b.mtime);
  for (const entry of stats.slice(0, Math.max(0, stats.length - MAX_CACHED_FILES))) {
    await fs.promises.unlink(path.join(dir, entry.name)).catch(() => undefined);
  }
}

async function fetchImage(url, referer, signal) {
  // 公网校验（含 DNS 解析结果与重定向每一跳）统一在 getPublicUrl 内完成
  const response = await getPublicUrl(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8,*/*;q=0.5",
      Referer: referer || HOME_URL,
    },
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
    maxBytes: MAX_DOWNLOAD_BYTES,
    signal,
  });
  if (response.statusCode !== 200) {
    throw new HttpError(`HTTP ${response.statusCode}`);
  }
  const buffer = response.body;
  if (!buffer.length) throw new HttpError("empty response");

  const contentType = String(response.headers["content-type"] || "").toLowerCase();
  const sniffed = sniffImage(buffer);
  if (!sniffed && !contentType.startsWith("image/")) {
    throw new HttpError(`response is not an image (${contentType || "unknown type"})`);
  }
  return {
    buffer,
    mediaType: sniffed?.mime || contentType.split(";")[0].trim(),
    ext: sniffed?.ext || "bin",
  };
}

/**
 * 下载候选地址的优先顺序。
 *
 * 默认预览优先（宿主物化还会压到工具图预算，拉原图纯浪费）；
 * 显式 preferOriginal 时才原图优先。抽成纯函数便于单测锁定这个策略。
 */
function orderDownloadSources(item, options = {}) {
  const ordered = options.preferOriginal
    ? [item.image_url, item.cdn_url]
    : [item.cdn_url, item.image_url];
  return [...new Set(ordered.filter(isHttpUrl))];
}

/**
 * 按"要附几张图"决定每张的长边预算。
 *
 * 为什么按张数收缩：模型的图片成本 ≈ 张数 × 单图像素，8 张各 1024px 会把单轮
 * 上下文顶掉一大块。张数越多单张越小，总量控制在近似恒定的水平：
 *
 *   4 张 → 768px（约 590K px × 4）
 *   6 张 → 640px（约 410K px × 6）
 *   8 张 → 512px（约 260K px × 8）
 *
 * 512px 仍足以看清"这张图讲的是什么"（缩略图参考的典型用途）；
 * 需要细节时模型按结果里的 Full-size 地址自取，不受这个预算约束。
 */
function resolvePreviewEdge(count) {
  const n = Math.max(1, Math.trunc(Number(count) || 1));
  if (n <= 2) return 1024;
  if (n <= 4) return 768;
  if (n <= 6) return 640;
  return 512;
}

/** 缩放后单张目标体积（字节）：张数越多，单张越小 */
function resolvePreviewTargetBytes(count) {
  const n = Math.max(1, Math.trunc(Number(count) || 1));
  if (n <= 2) return 120 * 1024;
  if (n <= 4) return 90 * 1024;
  if (n <= 6) return 70 * 1024;
  return 55 * 1024;
}

/**
 * 把图片缩到长边 ≤ maxEdge 并转 JPEG。
 *
 * 只在**需要时**才动像素：已经足够小且体积达标则原样返回（零编码），
 * 避免对 CDN 预览图做无谓的二次有损压缩。
 * 解码失败（罕见格式/损坏）时返回原字节，让宿主的物化链兜底，不整条丢弃。
 */
async function shrinkImage(buffer, mediaType, maxEdge, targetBytes) {
  let sharp;
  try {
    sharp = require("sharp");
  } catch {
    // 打包环境缺 sharp：退回原图，至少还能用（体积由宿主转码兜底）
    return { buffer, mediaType };
  }

  try {
    const image = sharp(buffer, { limitInputPixels: 64 * 1024 * 1024 });
    const meta = await image.metadata();
    const width = meta.width || 0;
    const height = meta.height || 0;
    const longest = Math.max(width, height);

    const alreadySmall = longest > 0 && longest <= maxEdge;
    // JPEG 且体积已达标：直接复用原字节（省一次有损编码）
    if (alreadySmall && buffer.length <= targetBytes && mediaType === "image/jpeg") {
      return { buffer, mediaType };
    }

    let pipeline = sharp(buffer, { limitInputPixels: 64 * 1024 * 1024 }).rotate(); // 修 EXIF 方向
    if (longest > maxEdge) {
      pipeline = pipeline.resize({
        width: maxEdge,
        height: maxEdge,
        fit: "inside",
        withoutEnlargement: true,
      });
    }

    // 质量阶梯：先保画质，超预算再降，最多试三档
    for (const quality of [80, 70, 60]) {
      const out = await pipeline
        .flatten({ background: "#ffffff" }) // JPEG 无 alpha，透明区压白底（否则变黑）
        .jpeg({ quality, optimize: true, mozjpeg: true })
        .toBuffer();
      if (out.length <= targetBytes || quality === 60) {
        return { buffer: out, mediaType: "image/jpeg" };
      }
    }
    return { buffer, mediaType };
  } catch {
    return { buffer, mediaType };
  }
}

/**
 * 下载一张搜索结果图片到插件数据目录。
 *
 * 默认取 **CDN 预览图**（500~800px），再按张数预算缩到更小的长边：
 * 宿主物化时也会转码，但那时像素已经定了，图片 token 成本下不来——
 * 缩像素这一步必须在插件侧做。原图直链由工具文本回给模型，需要高清自取。
 *
 * 预览图取不到（少数条目没有 middleURL/thumbURL）才退回原图，避免整条丢掉。
 *
 * @param {{ image_url: string, cdn_url?: string, page_url?: string, title?: string }} item
 * @param {string} dataDir 插件数据目录（api.getDataDir()）
 * @param {{ signal?: AbortSignal, preferOriginal?: boolean, maxEdge?: number, targetBytes?: number }} options
 */
async function downloadImage(item, dataDir, options = {}) {
  const candidates = orderDownloadSources(item, options);
  if (!candidates.length) throw new Error("no downloadable image URL");

  const dir = cacheDir(dataDir);
  await fs.promises.mkdir(dir, { recursive: true });

  const maxEdge = Number.isFinite(options.maxEdge) ? options.maxEdge : 768;
  const targetBytes = Number.isFinite(options.targetBytes) ? options.targetBytes : 90 * 1024;

  let lastError = null;
  for (const url of candidates.slice(0, 2)) {
    // 缓存键含目标尺寸：同一 URL 在不同张数预算下产出不同文件，不能互相命中
    const digest = crypto
      .createHash("sha1")
      .update(`${url}|${maxEdge}x${targetBytes}`)
      .digest("hex")
      .slice(0, 20);
    try {
      // 缓存命中：同一 URL + 同一预算不重复下载
      const hit = await findCached(dir, digest);
      if (hit) return hit;

      const fetched = await fetchImage(url, item.page_url, options.signal);
      const shrunk = await shrinkImage(
        fetched.buffer,
        fetched.mediaType,
        maxEdge,
        targetBytes,
      );
      const ext = MIME_BY_EXT_INV[shrunk.mediaType] || fetched.ext;
      const name = `${digest}.${ext}`;
      const filePath = path.join(dir, name);
      // 原子落盘：先写 .part 再 rename，避免宿主物化时读到半截文件
      const tmpPath = `${filePath}.part`;
      await fs.promises.writeFile(tmpPath, shrunk.buffer);
      await fs.promises.rename(tmpPath, filePath);
      await pruneCache(dir);
      return {
        path: filePath,
        mediaType: shrunk.mediaType,
        bytes: shrunk.buffer.length,
        name,
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("download failed");
}

/** 查缓存：扩展名在下载前未知，按 digest 前缀匹配 */
async function findCached(dir, digest) {
  let names;
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return null;
  }
  const match = names.find((name) => name.startsWith(`${digest}.`) && !name.endsWith(".part"));
  if (!match) return null;
  const filePath = path.join(dir, match);
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile() || stat.size === 0) return null;
    const ext = path.extname(match).slice(1);
    return {
      path: filePath,
      mediaType: MIME_BY_EXT[ext] || `image/${ext}`,
      bytes: stat.size,
      name: match,
    };
  } catch {
    return null;
  }
}

/**
 * 占位图 SVG：图片取不到时给用户一个可读提示，而不是空白或裂图图标。
 */
function placeholderSvg(message) {
  const text = String(message || "图片不可用").slice(0, 40);
  const safe = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200">` +
      `<rect width="320" height="200" fill="#f3f4f6"/>` +
      `<rect x="8" y="8" width="304" height="184" rx="8" fill="none" stroke="#d1d5db" stroke-dasharray="6 4"/>` +
      `<text x="160" y="104" text-anchor="middle" font-family="system-ui,sans-serif" font-size="13" fill="#9ca3af">${safe}</text>` +
      `</svg>`,
    "utf8",
  );
}

module.exports = {
  searchImages,
  downloadImage,
  resolvePreviewEdge,
  resolvePreviewTargetBytes,
  placeholderSvg,
  isBaiduHosted,
  pickDisplayUrl,
  /**
   * 取一张公网图片的字节（供图片代理路由使用）。
   * 校验公网地址、限制体积、只接受图片响应；成功返回 { buffer, mediaType }。
   */
  async fetchPublicImage(url, options = {}) {
    const fetched = await fetchImage(url, options.referer, options.signal);
    return { buffer: fetched.buffer, mediaType: fetched.mediaType };
  },
  // 导出内部函数供本地验证脚本使用
  _internal: {
    repairJson,
    parseJsonLenient,
    salvageDataItems,
    pickUrls,
    pickPageUrl,
    normalizeItem,
    sniffImage,
    buildSearchParams,
    orderDownloadSources,
    shrinkImage,
    pickDisplayUrl,
    isBaiduHosted,
  },
};
