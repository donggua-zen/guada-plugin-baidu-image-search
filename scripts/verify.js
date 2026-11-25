'use strict';

/**
 * 手动验收脚本（本地开发用，不随插件分发到用户）
 *
 *   node scripts/verify.js            # 只做离线结构校验
 *   node scripts/verify.js --online    # 额外做一次真实百度搜索
 *
 * 离线部分：用假 api 捕获注册结果，核对 manifest/工具/提示词形状与宿主契约一致。
 * 联网部分：真实请求百度图片接口 + 下载 1 张图，输出耗时与文件大小。
 */

const os = require("os");
const path = require("path");
const fs = require("fs");

const Plugin = require("../index");

function makeCaptureApi(dataDir) {
  const captured = { kits: [], tools: [], prompts: [], manifest: null };
  const handle = {
    id: "",
    name: "",
    registerTool(def) {
      captured.tools.push(def);
    },
    registerPrompt(def) {
      captured.prompts.push(def);
    },
    registerSkill(def) {
      captured.prompts.push({ __skill: def });
    },
  };
  const api = {
    getDataDir() {
      return dataDir;
    },
    getPluginDir() {
      return path.join(__dirname, "..");
    },
    registerToolKit(def) {
      captured.kits.push(def);
      handle.id = def.id;
      handle.name = def.name;
      if (typeof def.onLoad === "function") def.onLoad(handle);
      return handle;
    },
  };
  return { api, captured };
}

async function offline() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "baidu-img-plugin-"));
  const { api, captured } = makeCaptureApi(dataDir);
  const instance = new Plugin();
  await instance.onLoad(api);

  const problems = [];
  if (!instance.manifest.id || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(instance.manifest.id)) {
    problems.push("manifest.id 不合法");
  }
  if (!(instance.manifest.apiVersion <= 4)) problems.push("apiVersion 超出宿主支持范围");
  if (captured.kits.length !== 1) problems.push("应注册 1 个工具包");
  const kit = captured.kits[0];
  if (kit.loadMode !== "eager") problems.push("工具包应为 eager（否则工具不进 function list）");
  if (captured.tools.length !== 1) problems.push("应注册 1 个工具");
  const tool = captured.tools[0];
  if (tool.name !== "baidu_image_search") problems.push("工具名应为 baidu_image_search");
  if (tool.readOnly !== true) problems.push("工具应声明 readOnly");
  if (!tool.inputSchema) problems.push("工具应提供 Zod inputSchema");
  if (!captured.prompts.length) problems.push("应注册使用说明提示词");

  // 命名全局唯一性：跨插件同名工具会先注册者胜，这里至少保证不与内置 web_search 撞名
  if (tool.name === "web_search" || tool.name === "web_parser") {
    problems.push("工具名与内置搜索工具冲突");
  }

  console.log("[offline] manifest:", JSON.stringify(instance.manifest));
  console.log("[offline] kit:", kit.id, "loadMode =", kit.loadMode);
  console.log("[offline] tool:", tool.name, "readOnly =", tool.readOnly);
  console.log("[offline] prompt chars:", captured.prompts[0].content.length);
  const schema = require("zod").z.toJSONSchema(tool.inputSchema);
  console.log("[offline] schema properties:", Object.keys(schema.properties).join(", "));
  console.log("[offline] required:", JSON.stringify(schema.required));

  fs.rmSync(dataDir, { recursive: true, force: true });

  if (problems.length) {
    console.error("[offline] FAILED:", problems.join("; "));
    return false;
  }
  console.log("[offline] OK");
  return true;
}

async function online() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "baidu-img-online-"));
  const instance = new Plugin();
  const startedAt = Date.now();
  const response = await instance.search(
    { query: "布偶猫", count: 3, include_images: true },
    { getDataDir: () => dataDir },
  );
  const elapsed = Date.now() - startedAt;

  console.log(`[online] elapsed ${elapsed}ms`);
  console.log("[online] imageRefs:", (response.imageRefs || []).length);
  for (const ref of response.imageRefs || []) {
    const exists = fs.existsSync(ref.url);
    const size = exists ? fs.statSync(ref.url).size : 0;
    console.log(`[online]  ${ref.media_type} ${size}B exists=${exists} ${path.basename(ref.url)}`);
  }
  console.log("[online] content head:\n" + response.content.split("\n").slice(0, 12).join("\n"));

  fs.rmSync(dataDir, { recursive: true, force: true });

  if (!(response.imageRefs || []).length) {
    console.error("[online] FAILED: 没有拿到任何图片（可能被限流/网络不通）");
    return false;
  }
  console.log("[online] OK");
  return true;
}

(async () => {
  const okOffline = await offline();
  if (!okOffline) process.exit(1);
  if (process.argv.includes("--online")) {
    const ok = await online();
    if (!ok) process.exit(2);
  }
})().catch((error) => {
  console.error("verify failed:", error);
  process.exit(1);
});
