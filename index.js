"use strict";

const { z } = require("zod");
const {
  searchImages,
  downloadImage,
  resolvePreviewEdge,
  resolvePreviewTargetBytes,
  fetchPublicImage,
  placeholderSvg,
} = require("./lib/baidu-search");

const PLUGIN_ID = "baidu-image-search";
const MAX_COUNT = 12;
/**
 * 单次最多附几张图。
 *
 * 与搜索数量对齐（count ≤ 8 时全附），但封顶 8：真实搜索结果前几条常是广告或
 * 低质图，只取 4 张容易全部踩空；8 张既覆盖了这个问题，又不会把单轮上下文塞满
 * （单张像素会随张数自动收缩，见 resolvePreviewEdge）。
 */
const MAX_INCLUDED_IMAGES = 8;

/**
 * 百度图片搜索插件（零 npm 依赖，除宿主自带的 zod）。
 *
 * 首版只提供一个只读工具：默认返回图片元数据 + 来源页；
 * `include_images=true` 时下载最多 4 张原图，以 imageRefs 交给宿主物化，
 * 由 chat 引擎统一转码进会话图片目录（插件不做二次编码）。
 */
class BaiduImageSearchPlugin {
  /**
   * @param {{ searchImages?: Function, downloadImage?: Function }} [deps]
   *   仅供本地测试注入网络实现；宿主加载时不传。
   */
  constructor(deps = {}) {
    this._searchImages = deps.searchImages || searchImages;
    this._downloadImage = deps.downloadImage || downloadImage;
    this.manifest = {
      id: PLUGIN_ID,
      name: "百度图片搜索",
      version: "0.1.0",
      description: "搜索百度图片并可选将少量图片注入当前会话",
      author: "donggua-zen",
      category: "user",
      main: "index.js",
      apiVersion: 4,
      icon: "assets/icon.svg",
      permissions: ["net"],
    };
  }

  async onLoad(api) {
    this.registerMediaRoutes(api);
    api.registerToolKit({
      id: "baidu_image_search",
      name: "百度图片搜索",
      description: "从百度图片搜索参考图；可选把少量图片附到当前会话做视觉分析。",
      loadMode: "eager",
      activator:
        "用户要求查找、搜索、展示参考图片时使用。默认只返回图片信息；只有用户要亲眼查看图片或需要视觉分析时才设置 include_images=true。",
      onLoad: (toolkit) => {
        toolkit.registerTool({
          name: "baidu_image_search",
          description:
            "Search Baidu Images for reference pictures. Returns titles, dimensions, source pages, " +
            "and both preview and full-size image URLs. " +
            "Set include_images=true when the user needs to see the pictures or wants visual analysis: " +
            "it attaches up to 8 previews (one per result, so ask for count=6~8 to have some to choose from — " +
            "the first few hits are often ads or low-quality). Previews are auto-shrunk (1024px→512px as the " +
            "count grows) to keep context small; for fine detail download the 'Full-size image' URL yourself " +
            "instead of searching again. Uses Baidu's unofficial public image endpoint, so it can be rate limited. " +
            "When you need to pick a few good images out of many previews (multi-query comparison, article/cover art " +
            "selection), delegate the screening to `subagent_spawn`: previews are large in context and the sub-agent " +
            "can look at many and report back only the finalists' titles and Full-size URLs. " +
            "When showing images to the user, put them in the reply as Markdown `![alt](Image url)` — " +
            "the `Image` field is Baidu's own CDN and renders reliably. Put the source inside the alt text " +
            "(e.g. `![西域风景 · mbd.baidu.com](url)`) instead of adding a separate '来源：' line — the UI " +
            "already shows alt as the caption under each image. " +
            "Avoid displaying the `Full-size image` URL: it often points at third-party sites that break in " +
            "browsers (hotlink protection, expiring signatures, ORB blocking) and it is much heavier.",
          inputSchema: z.object({
            query: z
              .string()
              .trim()
              .min(1)
              .max(120)
              .describe("Search keywords, e.g. '敦煌壁画 飞天'"),
            count: z
              .number()
              .int()
              .min(1)
              .max(MAX_COUNT)
              .optional()
              .describe(`Maximum number of results (1-${MAX_COUNT}), default 8.`),
            page: z
              .number()
              .int()
              .min(0)
              .max(29)
              .optional()
              .describe("Zero-based result page, 0-29. Default 0."),
            min_width: z
              .number()
              .int()
              .min(0)
              .max(10000)
              .optional()
              .describe(
                "Filter out images narrower than this many pixels (0 = no filtering, default 0). " +
                  "Use 600+ for wallpaper/print use, or to skip small thumbnails.",
              ),
            include_images: z
              .boolean()
              .optional()
              .describe(
                `Attach up to ${MAX_INCLUDED_IMAGES} preview images (one per result) to this conversation. ` +
                  "Previews shrink automatically as the count grows. Default false.",
              ),
          }),
          execute: async (args, _ctx, signal) => this.search(args, api, signal),
          display: {
            text: { executing: "正在搜索百度图片", completed: "百度图片搜索完成" },
            aggregate: { executing: "正在搜索百度图片", completed: "百度图片搜索完成" },
            argsKey: "query",
            icon: "search",
          },
          readOnly: true,
        });

        toolkit.registerPrompt({
          frequency: "REGULAR",
          description: "百度图片搜索工具使用说明",
          content: [
            "## 百度图片搜索",
            "- 需要图片参考时调用 `baidu_image_search`，关键词要具体（主体 + 特征/场景）。",
            "- 用户要看图时设 `include_images=true`：插件会按 `count` 附上同样数量的预览图（最多 8 张）。",
            "  搜索结果前几条常是广告或低质图，所以要看图时建议把 `count` 提到 6~8，多给几张挑。",
            "- 预览图会按张数自动缩小（张数越多单张越小），只够看清「这张图是什么」。",
            "  需要细节时按结果里的 `Full-size image` 地址自行下载再看，不要重复搜索。",
            "- 需要高分辨率素材（壁纸/印刷）时，用 `min_width` 过滤（如 1200）再自行取原图。",
            "",
            "### 展示给用户：输出 Markdown 图片，不要只贴链接",
            "用户要“看看图”时，在回复里直接用 Markdown 展示——只给一串裸链接体验很差：",
            "- 用结果里的 `Image` 字段那个地址写 `![描述](地址)`，一行一张；",
            "  它来自百度自家 CDN，浏览器直连能稳定显示；",
            "- **来源写进 alt，不要另起一行**：`![纳西妲立绘 · 百度百科](地址)`。",
            "  界面会在图片下方显示 alt 作为说明，再单独写一行「来源：[xxx](url)」会让卡片很臃肿；",
            "- alt 用「内容 + 来源」：内容放主体（是什么/谁），来源取 `Site` 或来源页域名，",
            "  如 `![布偶猫 · mbd.baidu.com](地址)`；不要写成文件名或整条 URL；",
            "- **不要用 `Full-size image` 做展示**：多是第三方站原图（抖音/微博/zcool 等），",
            "  常因防盗链、URL 时效签名、浏览器 ORB 拦截而在界面里裂图，而且体积大；",
            "  它只用于用户确实需要高清细节时单独取；",
            "- 图片裂了或用户要看出处时，再在正文里补一条来源页链接，不要每张都挂；",
            "- 图片版权归原作者：来源已写在 alt 里，不要声称图片已获授权。",
            "- 该工具走百度网页端非公开接口，可能被限流或改版；失败时如实说明，不要连续重试。",
            "",
            "### 批量筛选：交给子代理，别占用当前上下文",
            "需要**从大量预览里挑出少数几张**时（多关键词比稿、给文章/封面选配图、",
            "一次要看成百上千张），不要在主对话里反复搜索看图——每张预览都会留在上下文里，",
            "几十张就把主对话挤满了。改用 `subagent_spawn` 委派：",
            "- 把筛选标准写进 task（尺寸下限、风格、构图、要几张、是否要来源页）；",
            "- 让子代理自己多次调用 `baidu_image_search`（可带 `min_width` 与 `include_images=true`）；",
            "- **只让它返回最终候选的标题 + `Full-size image` 链接 + 一句入选理由**，不要贴图；",
            "- 需要图时再由主对话按这些链接取 1~2 张，或用 `include_images` 单独确认。",
            "子代理有独立上下文，看完就丢弃；主对话只拿到结论。",
            "只挑 1~2 张、或用户只是随便看看时，直接在主对话搜即可，别为了省事而多绕一层。",
          ].join("\n"),
        });
      },
    });
  }

  /**
   * 图片代理路由（供 Markdown 直接展示用）。
   *
   * 为什么需要：模型把第三方图片直链塞进 `![]()` 时，浏览器端经常失败——
   * 实测同一批结果约一半裂图，主因是：
   *   - ORB（Opaque Response Blocking）：对方没声明 nosniff / MIME 不规范；
   *   - 防盗链与时效签名：URL 过期后谁都取不到（服务端也一样）。
   * 由插件取回字节再以规范头输出，能吃掉第一类；第二类只能如实报错。
   *
   * 安全：复用 lib/http 的公网校验（拒绝内网/回环，重定向逐跳校验），
   * 只回图片 MIME，限制体积。
   */
  registerMediaRoutes(api) {
    if (typeof api.registerRoute !== "function") return; // 老宿主无 v3 路由能力，静默跳过

    api.registerRoute({
      method: "GET",
      path: "img",
      handler: async (req, res, ctx) => {
        const raw = Array.isArray(ctx.query.u) ? ctx.query.u[0] : ctx.query.u;
        if (!raw) {
          res.status(400).json({ error: "missing u" });
          return;
        }
        let target;
        try {
          target = new URL(String(raw));
        } catch {
          res.status(400).json({ error: "invalid url" });
          return;
        }
        if (target.protocol !== "http:" && target.protocol !== "https:") {
          res.status(400).json({ error: "unsupported protocol" });
          return;
        }

        try {
          const fetched = await fetchPublicImage(target.toString());
          res.setHeader("Content-Type", fetched.mediaType);
          // 关键：明确 MIME + nosniff，ORB 才会放行
          res.setHeader("X-Content-Type-Options", "nosniff");
          res.setHeader("Cache-Control", "public, max-age=86400");
          res.status(200).end(fetched.buffer);
        } catch (error) {
          // 取不到就回占位图（仍是 image/svg+xml），避免界面上出现裂图图标
          const svg = placeholderSvg(`图片不可用：${String(error.message).slice(0, 30)}`);
          res.setHeader("Content-Type", "image/svg+xml");
          res.setHeader("X-Content-Type-Options", "nosniff");
          res.status(200).end(svg);
        }
      },
    });
  }

  async search(args, api, signal) {
    const query = String(args.query || "").trim();
    if (!query) throw new Error("query is required");

    const count = clampInt(args.count, 8, 1, MAX_COUNT);
    const page = clampInt(args.page, 0, 0, 29);
    const minWidth = clampInt(args.min_width, 0, 0, 10000);
    const includeImages = args.include_images === true;

    // 有宽度过滤时多取候选，避免过滤后凑不够
    const result = await this._searchImages(query, {
      count: Math.min(MAX_COUNT, minWidth ? count * 2 : count),
      page,
      signal,
    });

    const items = result.items
      .filter((item) => !minWidth || !item.width || item.width >= minWidth)
      .slice(0, count);

    if (!items.length) {
      return {
        content:
          `No Baidu Image results found for "${query}". ` +
          "The endpoint may be rate limited or blocked; wait a while before trying again.",
      };
    }

    const header = [
      `Baidu Images: ${items.length} result(s) for "${query}"` +
        (result.total ? ` (about ${result.total} matches)` : "") +
        ".",
      "Image copyright belongs to the respective creators; use the source pages for attribution.",
    ];
    const blocks = [...header];
    items.forEach((item, index) => {
      const size =
        item.width && item.height ? `${item.width}x${item.height}` : "unknown size";
      const entry = [
        `[${index + 1}] ${item.title || "(untitled)"}`,
        `Dimensions: ${size}${item.host ? ` | Site: ${item.host}` : ""}`,
        `Source page: ${item.page_url}`,
      ];
      // Show 用展示地址（百度 CDN，浏览器直连稳定）；原图另给一行供取高清。
      // 二者相同就不重复输出。
      const display = item.display_url || item.image_url;
      const full = item.original_url || item.image_url;
      entry.push(`Image: ${display}`);
      if (full && full !== display) entry.push(`Full-size image: ${full}`);
      blocks.push(entry.join("\n"));
    });

    const response = { content: blocks.join("\n\n") };
    if (!includeImages) return response;

    const imageRefs = [];
    const failures = [];
    // 附几张跟随搜索数量（封顶 8）：前几条常是广告/低质图，多附几张才有挑选余地
    const toAttach = items.slice(0, Math.min(items.length, MAX_INCLUDED_IMAGES));
    // 张数越多单张越小，控制单轮图片总成本（见 resolvePreviewEdge）
    const maxEdge = resolvePreviewEdge(toAttach.length);
    const targetBytes = resolvePreviewTargetBytes(toAttach.length);

    for (const item of toAttach) {
      if (signal?.aborted) throw new Error("Image search was cancelled");
      try {
        const downloaded = await this._downloadImage(item, api.getDataDir(), {
          signal,
          maxEdge,
          targetBytes,
        });
        imageRefs.push({
          url: downloaded.path,
          refType: "local",
          media_type: downloaded.mediaType,
          bytes: downloaded.bytes,
          name: downloaded.name,
        });
      } catch (error) {
        if (signal?.aborted) throw new Error("Image search was cancelled");
        failures.push(`${item.title || item.host || "image"}: ${error.message}`);
      }
    }

    if (imageRefs.length) {
      response.imageRefs = imageRefs;
      // 告知实际尺寸预算：模型据此判断"该看附件还是按原图链接自取"
      response.content +=
        `\n\nAttached ${imageRefs.length} preview image(s)` +
        `, resized to ${maxEdge}px long edge to keep context small. ` +
        "Use the Full-size image URL when fine detail matters.";
    }
    if (failures.length) {
      response.content += `\n\nSome images could not be attached: ${failures.join("; ")}`;
    }
    if (items.length > MAX_INCLUDED_IMAGES) {
      response.content += `\nOnly the first ${MAX_INCLUDED_IMAGES} images were attached.`;
    }
    if (!imageRefs.length) {
      response.content += "\nNo image could be downloaded; links above remain usable in a browser.";
    }
    return response;
  }
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

module.exports = BaiduImageSearchPlugin;
module.exports.default = BaiduImageSearchPlugin;
