# 百度图片搜索（Baidu Image Search）插件

给对话加一个「找参考图」的工具：搜索百度图片，返回标题、尺寸、来源页和可直接展示的图片地址；
需要时把最多 8 张预览图附到当前会话，交给视觉模型直接看。

不需要任何 API Key ——走的是百度图片**网页端**接口（`image.baidu.com/search/acjson`）。

## 能力

| 项 | 说明 |
| --- | --- |
| 工具名 | `baidu_image_search` |
| 类型 | 只读（计划模式下可用） |
| 工具包 | `baidu_image_search`，`eager` 加载 |
| 网络 | 仅公网 http(s)，拒绝内网/回环地址（含重定向每一跳） |
| 缓存 | 插件数据目录下 `image-cache/`，最多保留 200 个文件 |

### 结果里的三个地址

每条结果给出 `Image`（展示用）与可选的 `Full-size image`（高清用）：

| 字段 | 用途 | 特点 |
| --- | --- | --- |
| `Image` | 放进 Markdown 展示给用户 | 优先百度自有 CDN（`img*.baidu.com`），浏览器直连稳定 |
| `Full-size image` | 需要高清细节时自取 | 常是第三方站原图，可能因防盗链/时效签名/ORB 拦截而失败，体积也大 |

实测同一批结果：直接引用第三方原图 **6 张里只有 3 张能在浏览器显示**（其余报
`net::ERR_BLOCKED_BY_ORB`）；改用百度 CDN 后 **6/6 全部正常**。这就是 `Image` 字段存在的原因。

## 参数

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `query` | string | 必填 | 搜索关键词，1–120 字符 |
| `count` | int | 8 | 返回条数，1–12；**附图数量跟随它**（封顶 8） |
| `page` | int | 0 | 起始页（0 基），0–29 |
| `min_width` | int | 0 | 过滤宽度小于该值的图，0 = 不过滤 |
| `include_images` | bool | false | 是否附上预览图 |

刻意**不**暴露给模型的调参项：

- **图片分辨率**（原 `max_side`）：模型无从判断"长边该给多少"，改由**张数自动决定**
  （见下表），既省 token 又不用模型猜。

### 附图数量与分辨率的联动

搜索结果前几条常是广告或低质图，所以附图数量跟随 `count`（最多 8 张），多给几张才有挑选余地。
单张分辨率随张数自动收缩，让**单轮图片总成本近似恒定**：

| 附图张数 | 长边 | 单张预算 | 实测合计 |
| --- | --- | --- | --- |
| 1–2 | 1024px | 120KB | — |
| 3–4 | 768px | 90KB | 187KB（4 张，平均 47KB） |
| 5–6 | 640px | 70KB | — |
| 7–8 | 512px | 55KB | 192KB（8 张，平均 24KB） |

实测 8 张和 4 张的总量几乎相同（192KB vs 187KB），但 8 张多覆盖了一倍候选——
这正是"提高数量、降低分辨率"想要的效果。

需要高清细节时，模型按结果里的 `Full-size image` 地址自行下载，不受这个预算约束。

`include_images=true` 时，图片以 `imageRefs`（`refType: "local"`）返回，由宿主聊天引擎
统一物化进会话图片目录；插件已按上表缩好像素（CDN 的 `w/h` 参数实测无效，只能自己转）。

## 安装

插件市场：

```text
github:donggua-zen/guada-plugin-baidu-image-search#main
```

本地源码安装（开发用）：

```http
POST /api/v1/plugins/install
Content-Type: application/json

{ "source": "local:D:/AI/guada_plugins/guada-plugin-baidu-image-search" }
```

`category` 为 `user`，安装后默认关闭，需要在插件列表里手动启用。

## 使用

对话里直接说需求即可，模型会自动调用：

```text
帮我找几张敦煌壁画的参考图
```

```text
找 4 张柯基的照片，我要看看它们的样子
```

第二种说法会让模型带上 `include_images=true`，图片会作为附件出现在会话里。

## 开发者验证

```bash
# 逻辑单测（44 项，不联网）
NODE_PATH=/d/AI/ai_chat/backend-ts/node_modules node --test test/*.test.js

# 离线结构校验（manifest / 工具 / schema 形状）
NODE_PATH=/d/AI/ai_chat/backend-ts/node_modules node scripts/verify.js

# 加上真实联网验收（会请求百度并下载 1–3 张图）
NODE_PATH=/d/AI/ai_chat/backend-ts/node_modules node scripts/verify.js --online
```

下载的图片在临时目录，验证脚本结束时会删掉，不会污染插件数据目录。

## 实现要点

- **JSON 容错**：百度返回体偶尔含非法转义（`\x` 之类），`repairJson` 逐字符修复后再解析。
- **原图优先**：`replaceUrl[].ObjURL` 是真原图（常是 PNG），`middleURL/thumbURL` 只是
  500–800px 的 CDN 副本；下载默认取预览（省流量），预览缺失才退回原图。
  实测同一张图：原图 216KB vs 预览 25KB（约 8.6 倍）。
- **插件侧缩像素**：CDN 的 `?w=&h=` 参数实测被忽略（改小仍是同体积），
  所以分辨率控制只能靠本地 `sharp` 转码。sharp 是宿主后端自带依赖，
  经 loader 的 require fallback 解析；缺失时退回原图，由宿主转码兜底。
- **来源页兜底**：`fromURL` 有时是混淆串（`ippr_z2C$qAzdH3F...`），只接受真正的 http(s)，
  否则退化到站点首页或百度网页搜索，保证链接点得开。
- **SSRF 防护**：每次请求（含重定向）都重新解析 DNS 并拒绝非公网地址，再把已校验 IP
  通过自定义 `lookup` 钉到本次连接，避免 DNS 重绑定绕过。
- **限流**：进程内搜索串行化 + 最小间隔 1.2s；翻页有深度上限，重复结果按图片地址去重。

## 已知限制

- 走百度网页端**非公开**接口，百度随时可能改参数或加验证码；失效时抓一次浏览器请求对比。
- 可能被限流：返回空结果时工具会提示等待，不要连续重试。
- 图片版权归原作者，插件会在结果里带上来源页，商用前需自行确认授权。
- 首版不支持按颜色、尺寸、图片类型（GIF/PNG）等检索条件筛选，也不做图片反查。
- 不注册前端页面/命令，纯工具能力；禁用插件后工具即从模型可用列表中消失。

## 后续可加

- 配置项：默认条数、是否默认附图、下载并发与最小间隔；
- 按 `type`（GIF/PNG）与宽高比过滤，对齐百度网页端的筛选参数；
- 结果卡片渲染（`display.renderer`），在会话里直接显示图片网格；
- 图片反查（以图搜图）与相似推荐。
