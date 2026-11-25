'use strict';

/**
 * 逻辑单测（node:test，零依赖）
 *
 *   node --test test/
 *
 * 不联网：只验证解析/归一化/安全校验这些确定性逻辑；
 * 真实联网抓取容易受百度限流影响，放入手动验收（见 README）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const plugin = require('../index');
const search = require('../lib/baidu-search');
const http = require('../lib/http');

const { repairJson, parseJsonLenient, salvageDataItems, pickUrls, pickPageUrl, normalizeItem, sniffImage, orderDownloadSources } =
  search._internal;

test('repairJson 修复非法转义后可解析', () => {
  const broken = '{"title":"a\\xb"}';
  assert.throws(() => JSON.parse(broken));
  assert.deepEqual(parseJsonLenient(broken), { title: 'a\\xb' });
});

test('parseJsonLenient 对合法 JSON 保持原样', () => {
  assert.deepEqual(parseJsonLenient('{"a":1}'), { a: 1 });
});

test('repairJson 不破坏合法转义与中文', () => {
  const raw = '{"t":"换行\\n引用\\"引号","u":"https:\\/\\/a.test"}';
  assert.deepEqual(parseJsonLenient(raw), {
    t: '换行\n引用"引号',
    u: 'https://a.test',
  });
});

test('repairJson 转义字符串内的裸控制字符（真实报错来源）', () => {
  // 百度把标题原样拼进 JSON，标题里的换行/制表符会成为裸控制字符
  const broken = '{"data":[{"fromPageTitle":"第一行\n第二行\t结尾"}]}';
  assert.throws(() => JSON.parse(broken), /Bad control character/);

  const fixed = parseJsonLenient(broken);
  assert.equal(fixed.data[0].fromPageTitle, '第一行\n第二行\t结尾');
});

test('repairJson 处理其余 C0 控制符', () => {
  const broken = '{"t":"a\u0001b\u001fc"}';
  assert.throws(() => JSON.parse(broken));
  assert.equal(parseJsonLenient(broken).t, 'a\u0001b\u001fc');
});

test('repairJson 去掉 BOM', () => {
  const withBom = '\uFEFF{"a":1}';
  assert.throws(() => JSON.parse(withBom));
  assert.deepEqual(parseJsonLenient(withBom), { a: 1 });
});

test('salvageDataItems 在整包无法修复时逐条抢回', () => {
  // 第二条缺失收尾引号 → 修复也无能为力，但第一条仍可救回
  const broken = '{"listNum":100,"data":[{"t":"ok","u":"https://a.test/1.jpg"},{"t":"bad,}],' + '"more":1}';
  assert.throws(() => parseJsonLenient(broken));

  const items = salvageDataItems(broken);
  assert.equal(items.length, 1);
  assert.equal(items[0].t, 'ok');
});

test('salvageDataItems 处理被截断的响应', () => {
  const truncated =
    '{"data":[{"t":"a","u":"https://a.test/1.jpg"},{"t":"b","u":"https://a.test/2.jpg"},{"t":"c"';
  const items = salvageDataItems(truncated);
  assert.equal(items.length, 2);
  assert.deepEqual(
    items.map((x) => x.t),
    ['a', 'b'],
  );
});

test('salvageDataItems 忽略花括号出现在字符串里的干扰', () => {
  const broken = '{"data":[{"t":"a{b}c}d","u":"https://a.test/1.jpg"}],}';
  const items = salvageDataItems(broken);
  assert.equal(items.length, 1);
  assert.equal(items[0].t, 'a{b}c}d');
});

test('salvageDataItems 没有 data 数组时返回空', () => {
  assert.deepEqual(salvageDataItems('{"error":"no data"}'), []);
  assert.deepEqual(salvageDataItems('<html>blocked</html>'), []);
});

test('pickUrls 原图优先，缺失时退回 CDN', () => {  const withOriginal = pickUrls({
    middleURL: 'https://cdn.test/a.jpg',
    replaceUrl: [{ ObjURL: 'https://img.test/a.png' }],
  });
  assert.equal(withOriginal.primary, 'https://img.test/a.png');
  assert.equal(withOriginal.cdn, 'https://cdn.test/a.jpg');

  const cdnOnly = pickUrls({
    thumbURL: 'https://cdn.test/b.jpg',
    replaceUrl: [{ ObjURL: 'ippr_z2C$qAzdH3F' }],
  });
  assert.equal(cdnOnly.original, '');
  assert.equal(cdnOnly.primary, 'https://cdn.test/b.jpg');
});

test('pickUrls 拒绝非 http(s) 的混淆地址', () => {
  const urls = pickUrls({ replaceUrl: [{ ObjURL: 'javascript:alert(1)' }] });
  assert.equal(urls.primary, '');
});

test('pickPageUrl 跳过混淆串并退化到可点开的页面', () => {
  assert.equal(
    pickPageUrl({ fromURL: 'ippr_z2C$qAzdH3F' }, 'example.com', '猫'),
    'https://example.com',
  );
  assert.equal(
    pickPageUrl({ fromURL: 'ippr_z2C$qAzdH3F' }, '', '布偶猫'),
    'https://www.baidu.com/s?wd=%E5%B8%83%E5%81%B6%E7%8C%AB',
  );
  assert.equal(
    pickPageUrl({ fromURL: 'https://real.test/post' }, 'example.com', 'x'),
    'https://real.test/post',
  );
});

test('normalizeItem 清洗标题并保留尺寸', () => {
  const item = normalizeItem(
    {
      fromPageTitleEnc: '<b>布偶猫</b>&nbsp;图片',
      middleURL: 'https://cdn.test/c.jpg',
      width: '800',
      height: '600',
      fromURLHost: 'cat.test',
      fromURL: 'https://cat.test/post',
    },
    '布偶猫',
  );
  assert.equal(item.title, '布偶猫 图片');
  assert.equal(item.width, 800);
  assert.equal(item.height, 600);
  assert.equal(item.host, 'cat.test');
  assert.equal(item.page_url, 'https://cat.test/post');
});

test('normalizeItem 无可用地址时返回 null', () => {
  assert.equal(normalizeItem({ fromPageTitle: 'x' }, 'x'), null);
});

test('sniffImage 只认真实图片魔数', () => {
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0])).mime, 'image/jpeg');
  assert.equal(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d])).mime, 'image/png');
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]);
  assert.equal(sniffImage(webp).mime, 'image/webp');
  // RIFF 但不是 WEBP（如 wav）不算图片
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')]);
  assert.equal(sniffImage(wav), null);
  assert.equal(sniffImage(Buffer.from('<html>')), null);
});

test('sniffImage 识别 AVIF，但不认 HEIC（模型读不了，应退回 CDN）', () => {
  const avif = Buffer.concat([
    Buffer.from([0, 0, 0, 0x20]),
    Buffer.from('ftypavif'),
    Buffer.alloc(4),
  ]);
  assert.equal(sniffImage(avif).mime, 'image/avif');
  assert.equal(sniffImage(avif).ext, 'avif');

  const heic = Buffer.concat([
    Buffer.from([0, 0, 0, 0x18]),
    Buffer.from('ftypheic'),
    Buffer.alloc(4),
  ]);
  assert.equal(sniffImage(heic), null);
});

test('isPrivateAddress 覆盖常见非公网段', () => {
  for (const address of [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    '::ffff:127.0.0.1',
    'fd00::1',
    'fe80::1',
  ]) {
    assert.equal(http.isPrivateAddress(address), true, address);
  }
  for (const address of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2400:3200::1']) {
    assert.equal(http.isPrivateAddress(address), false, address);
  }
});

test('resolvePublicHost 拒绝 localhost 与内网直连地址', async () => {
  await assert.rejects(() => http.resolvePublicHost('localhost'), /non-public/);
  await assert.rejects(() => http.resolvePublicHost('192.168.1.1'), /non-public/);
  await assert.rejects(() => http.resolvePublicHost(''), /no hostname/);
});

test('插件导出可在无宿主环境下实例化并注册工具', async () => {
  const instance = new plugin();
  assert.equal(instance.manifest.id, 'baidu-image-search');
  assert.ok(instance.manifest.apiVersion <= 4);

  const captured = { kits: [], tools: [], prompts: [] };
  const handle = {
    id: '',
    name: '',
    registerTool(def) {
      captured.tools.push(def);
    },
    registerPrompt(def) {
      captured.prompts.push(def);
    },
  };
  const api = {
    getDataDir: () => require('node:os').tmpdir(),
    registerToolKit(def) {
      captured.kits.push(def);
      handle.id = def.id;
      handle.name = def.name;
      def.onLoad(handle);
      return handle;
    },
  };

  await instance.onLoad(api);

  assert.equal(captured.kits.length, 1);
  assert.equal(captured.kits[0].id, 'baidu_image_search');
  assert.equal(captured.tools.length, 1);
  assert.equal(captured.tools[0].name, 'baidu_image_search');
  assert.equal(captured.tools[0].readOnly, true);
  assert.equal(captured.tools[0].inputSchema.safeParse({ query: '' }).success, false);
  assert.equal(captured.tools[0].inputSchema.safeParse({ query: '猫' }).success, true);
  assert.equal(
    captured.tools[0].inputSchema.safeParse({ query: '猫', count: 99 }).success,
    false,
  );
  assert.equal(captured.prompts.length, 1);
});

test('工具在空结果时返回可读提示且不发图片', async () => {
  const instance = new plugin({
    searchImages: async () => ({ query: '不存在的关键词', total: 0, items: [] }),
  });
  const response = await instance.search(
    { query: '不存在的关键词', count: 3 },
    { getDataDir: () => require('node:os').tmpdir() },
  );
  assert.match(response.content, /No Baidu Image results/);
  assert.equal(response.imageRefs, undefined);
});

test('include_images=false 只返回元数据，不会触发下载', async () => {
  let downloads = 0;
  const instance = new plugin({
    searchImages: async (query) => ({
      query,
      total: 42,
      items: [
        {
          title: '布偶猫',
          image_url: 'https://img.test/a.jpg',
          cdn_url: 'https://cdn.test/a.jpg',
          width: 800,
          height: 600,
          host: 'cat.test',
          page_url: 'https://cat.test/post',
          query,
        },
      ],
    }),
    downloadImage: async () => {
      downloads += 1;
      throw new Error('should not be called');
    },
  });

  const response = await instance.search(
    { query: '布偶猫', include_images: false },
    { getDataDir: () => require('node:os').tmpdir() },
  );

  assert.equal(downloads, 0);
  assert.equal(response.imageRefs, undefined);
  assert.match(response.content, /about 42 matches/);
  assert.match(response.content, /\[1\] 布偶猫/);
  assert.match(response.content, /800x600/);
  assert.match(response.content, /Source page: https:\/\/cat\.test\/post/);
});

test('include_images=true 返回 local imageRefs 并限制下载张数', async () => {
  const items = Array.from({ length: 8 }, (_, i) => ({
    title: `图 ${i + 1}`,
    image_url: `https://img.test/${i}.jpg`,
    cdn_url: '',
    width: 800,
    height: 600,
    host: 'img.test',
    page_url: `https://img.test/${i}`,
    query: '猫',
  }));
  const requested = [];
  const instance = new plugin({
    searchImages: async (query) => ({ query, total: 8, items }),
    downloadImage: async (item, dataDir) => {
      requested.push(item.image_url);
      return {
        path: `${dataDir}/image-cache/${requested.length}.jpg`,
        mediaType: 'image/jpeg',
        bytes: 1024,
        name: `${requested.length}.jpg`,
      };
    },
  });

  const response = await instance.search(
    { query: '猫', count: 8, include_images: true },
    { getDataDir: () => '/tmp/plugin-data' },
  );

  assert.equal(requested.length, 8);
  assert.equal(response.imageRefs.length, 8);
  assert.deepEqual(response.imageRefs[0], {
    url: '/tmp/plugin-data/image-cache/1.jpg',
    refType: 'local',
    media_type: 'image/jpeg',
    bytes: 1024,
    name: '1.jpg',
  });
  // 8 条结果全部附上，不触发截断提示
  assert.doesNotMatch(response.content, /Only the first/);
});

test('单张下载失败不影响其余图片并留下失败说明', async () => {
  let calls = 0;
  const instance = new plugin({
    searchImages: async (query) => ({
      query,
      total: 2,
      items: [
        {
          title: '坏图',
          image_url: 'https://img.test/bad.jpg',
          cdn_url: '',
          width: 0,
          height: 0,
          host: 'img.test',
          page_url: 'https://img.test/bad',
          query,
        },
        {
          title: '好图',
          image_url: 'https://img.test/ok.jpg',
          cdn_url: '',
          width: 1200,
          height: 800,
          host: 'img.test',
          page_url: 'https://img.test/ok',
          query,
        },
      ],
    }),
    downloadImage: async (item, dataDir) => {
      calls += 1;
      if (item.title === '坏图') throw new Error('HTTP 403');
      return { path: `${dataDir}/ok.jpg`, mediaType: 'image/jpeg', bytes: 10, name: 'ok.jpg' };
    },
  });

  const response = await instance.search(
    { query: '猫', include_images: true },
    { getDataDir: () => '/tmp/plugin-data' },
  );

  // 坏图在列表里（宽度 0 视为未知，不按小图过滤），下载失败只影响自己
  assert.equal(calls, 2);
  assert.equal(response.imageRefs.length, 1);
  assert.match(response.content, /could not be attached: 坏图: HTTP 403/);
});

test('展示地址优先百度 CDN，原图另给一行供取高清', async () => {
  const instance = new plugin({
    searchImages: async (query) => ({
      query,
      total: 1,
      items: [
        {
          title: '示例',
          image_url: 'https://img1.baidu.com/it/u=1,2&f=JPEG',
          original_url: 'https://p9-pc-sign.douyinpic.com/obj/x.webp',
          cdn_url: 'https://img1.baidu.com/it/u=1,2&f=JPEG',
          display_url: 'https://img1.baidu.com/it/u=1,2&f=JPEG',
          width: 1200,
          height: 800,
          host: 'douyin.com',
          page_url: 'https://www.douyin.com/x',
          query,
        },
      ],
    }),
  });

  const response = await instance.search(
    { query: '猫' },
    { getDataDir: () => require('node:os').tmpdir() },
  );

  // 展示行必须是百度 CDN（浏览器直连稳定）
  assert.match(response.content, /^Image: https:\/\/img1\.baidu\.com/m);
  // 第三方原图单独一行，供需要高清时取
  assert.match(response.content, /Full-size image: https:\/\/p9-pc-sign\.douyinpic\.com/);
});

test('展示地址与原图相同时只输出一行 Image', async () => {
  const instance = new plugin({
    searchImages: async (query) => ({
      query,
      total: 1,
      items: [
        {
          title: '示例',
          image_url: 'https://img1.baidu.com/a.jpg',
          original_url: 'https://img1.baidu.com/a.jpg',
          cdn_url: 'https://img1.baidu.com/a.jpg',
          display_url: 'https://img1.baidu.com/a.jpg',
          width: 0,
          height: 0,
          host: 'baidu.com',
          page_url: 'https://baidu.com/post',
          query,
        },
      ],
    }),
  });

  const response = await instance.search(
    { query: '猫' },
    { getDataDir: () => require('node:os').tmpdir() },
  );

  assert.match(response.content, /Image: https:\/\/img1\.baidu\.com\/a\.jpg/);
  assert.doesNotMatch(response.content, /Full-size image/);
  assert.match(response.content, /unknown size/);
});

test('pickDisplayUrl 优先百度自有域名，其次原图', () => {
  const { pickDisplayUrl, isBaiduHosted } = search;

  // 百度 CDN 副本可用 → 选它（即便原图是第三方）
  assert.equal(
    pickDisplayUrl({
      original: 'https://p9-pc-sign.douyinpic.com/x.webp',
      cdn: 'https://img1.baidu.com/it/u=1,2',
    }),
    'https://img1.baidu.com/it/u=1,2',
  );

  // 没有 CDN 副本，但原图本身在百度域名 → 用原图
  assert.equal(
    pickDisplayUrl({ original: 'https://pic.rmb.bdstatic.com/a.jpeg', cdn: '' }),
    'https://pic.rmb.bdstatic.com/a.jpeg',
  );

  // 两者都不是百度域名 → 退化为 cdn 或原图（尽力而为）
  assert.equal(
    pickDisplayUrl({ original: 'https://x.test/a.jpg', cdn: '' }),
    'https://x.test/a.jpg',
  );

  // 域名判定
  assert.equal(isBaiduHosted('https://img1.baidu.com/a'), true);
  assert.equal(isBaiduHosted('https://pic.rmb.bdstatic.com/a'), true);
  assert.equal(isBaiduHosted('https://iknow-pic.cdn.bcebos.com/a'), true);
  assert.equal(isBaiduHosted('https://douyinpic.com/a'), false);
  // 防域名后缀伪造
  assert.equal(isBaiduHosted('https://evilbaidu.com/a'), false);
  assert.equal(isBaiduHosted('not a url'), false);
});

test('下载默认取 CDN 预览图，不拉原图（宿主还会再压到 150KB）', () => {
  const order = orderDownloadSources({
    image_url: 'https://img.test/full.png',
    cdn_url: 'https://img.test/preview.jpg',
  });
  assert.deepEqual(order, ['https://img.test/preview.jpg', 'https://img.test/full.png']);
});

test('预览图缺失时退回原图，不整条丢弃', () => {
  const order = orderDownloadSources({
    image_url: 'https://img.test/full.png',
    cdn_url: '',
  });
  assert.deepEqual(order, ['https://img.test/full.png']);
});

test('preferOriginal 时优先原图（保留给需要高清的场景）', () => {
  const order = orderDownloadSources(
    { image_url: 'https://img.test/full.png', cdn_url: 'https://img.test/preview.jpg' },
    { preferOriginal: true },
  );
  assert.deepEqual(order, ['https://img.test/full.png', 'https://img.test/preview.jpg']);
});

test('候选地址会去重并过滤非 http(s)', () => {
  const order = orderDownloadSources({
    image_url: 'https://img.test/same.jpg',
    cdn_url: 'https://img.test/same.jpg',
  });
  assert.deepEqual(order, ['https://img.test/same.jpg']);

  assert.deepEqual(
    orderDownloadSources({ image_url: 'javascript:alert(1)', cdn_url: '' }),
    [],
  );
});

test('min_width 过滤窄图（参数保留给模型判断用途）', async () => {
  const instance = new plugin({
    searchImages: async (query) => ({
      query,
      total: 2,
      items: [
        { title: '窄', image_url: 'https://img.test/1.jpg', width: 400, height: 300, host: 'a', page_url: 'https://a.test', query },
        { title: '宽', image_url: 'https://img.test/2.jpg', width: 1920, height: 1080, host: 'a', page_url: 'https://a.test', query },
      ],
    }),
  });

  const response = await instance.search(
    { query: '壁纸', min_width: 1200 },
    { getDataDir: () => require('node:os').tmpdir() },
  );

  assert.match(response.content, /\[1\] 宽/);
  assert.doesNotMatch(response.content, /窄/);
});

test('min_width=0 时不过滤', async () => {
  const instance = new plugin({
    searchImages: async (query) => ({
      query,
      total: 2,
      items: [
        { title: '窄', image_url: 'https://img.test/1.jpg', width: 200, height: 150, host: 'a', page_url: 'https://a.test', query },
        { title: '宽', image_url: 'https://img.test/2.jpg', width: 1920, height: 1080, host: 'a', page_url: 'https://a.test', query },
      ],
    }),
  });

  const response = await instance.search(
    { query: '猫' },
    { getDataDir: () => require('node:os').tmpdir() },
  );

  assert.match(response.content, /窄/);
  assert.match(response.content, /宽/);
});

test('附图数量跟随 count，最多 8 张', async () => {
  const makeItems = (n) =>
    Array.from({ length: n }, (_, i) => ({
      title: `图${i + 1}`,
      image_url: `https://img.test/${i}.jpg`,
      cdn_url: '',
      width: 1200,
      height: 800,
      host: 'a',
      page_url: 'https://a.test',
      query: '猫',
    }));

  for (const [count, expected] of [
    [3, 3],
    [6, 6],
    [8, 8],
  ]) {
    let downloaded = 0;
    const instance = new plugin({
      searchImages: async (query) => ({ query, total: count, items: makeItems(count) }),
      downloadImage: async (item, dataDir) => {
        downloaded += 1;
        return { path: `${dataDir}/${downloaded}.jpg`, mediaType: 'image/jpeg', bytes: 1000, name: `${downloaded}.jpg` };
      },
    });

    const response = await instance.search(
      { query: '猫', count, include_images: true },
      { getDataDir: () => '/tmp/pd' },
    );

    assert.equal(downloaded, expected, `count=${count}`);
    assert.equal(response.imageRefs.length, expected);
  }
});

test('搜索 12 条但附图封顶 8 张，并提示截断', async () => {
  const items = Array.from({ length: 12 }, (_, i) => ({
    title: `图${i + 1}`,
    image_url: `https://img.test/${i}.jpg`,
    cdn_url: '',
    width: 1200,
    height: 800,
    host: 'a',
    page_url: 'https://a.test',
    query: '猫',
  }));

  let downloaded = 0;
  const instance = new plugin({
    searchImages: async (query) => ({ query, total: 12, items }),
    downloadImage: async (item, dataDir) => {
      downloaded += 1;
      return { path: `${dataDir}/${downloaded}.jpg`, mediaType: 'image/jpeg', bytes: 1000, name: 'x.jpg' };
    },
  });

  const response = await instance.search(
    { query: '猫', count: 12, include_images: true },
    { getDataDir: () => '/tmp/pd' },
  );

  assert.equal(downloaded, 8);
  assert.equal(response.imageRefs.length, 8);
  assert.match(response.content, /Only the first 8 images were attached/);
});

test('张数越多单张越小（分辨率随数量收缩）', () => {
  const { resolvePreviewEdge, resolvePreviewTargetBytes } = search;

  assert.equal(resolvePreviewEdge(1), 1024);
  assert.equal(resolvePreviewEdge(2), 1024);
  assert.equal(resolvePreviewEdge(4), 768);
  assert.equal(resolvePreviewEdge(6), 640);
  assert.equal(resolvePreviewEdge(8), 512);

  // 单调不增
  const edges = [1, 2, 4, 6, 8, 12].map(resolvePreviewEdge);
  for (let i = 1; i < edges.length; i++) {
    assert.ok(edges[i] <= edges[i - 1], `第 ${i} 项不应增大`);
  }

  const bytes = [1, 2, 4, 6, 8].map(resolvePreviewTargetBytes);
  for (let i = 1; i < bytes.length; i++) {
    assert.ok(bytes[i] <= bytes[i - 1], '单张体积预算应随张数下降');
  }
});

test('附图时会把实际尺寸预算告诉模型', async () => {
  const items = Array.from({ length: 6 }, (_, i) => ({
    title: `图${i + 1}`,
    image_url: `https://img.test/${i}.jpg`,
    cdn_url: '',
    width: 1200,
    height: 800,
    host: 'a',
    page_url: 'https://a.test',
    query: '猫',
  }));

  const instance = new plugin({
    searchImages: async (query) => ({ query, total: 6, items }),
    downloadImage: async (item, dataDir) => ({
      path: `${dataDir}/x.jpg`,
      mediaType: 'image/jpeg',
      bytes: 1000,
      name: 'x.jpg',
    }),
  });

  const response = await instance.search(
    { query: '猫', count: 6, include_images: true },
    { getDataDir: () => '/tmp/pd' },
  );

  // 6 张 → 640px
  assert.match(response.content, /resized to 640px long edge/);
  assert.match(response.content, /Full-size image URL/);
});

test('上传前的 downloadImage 会拿到按张数算出的预算', async () => {
  const items = Array.from({ length: 8 }, (_, i) => ({
    title: `图${i + 1}`,
    image_url: `https://img.test/${i}.jpg`,
    cdn_url: '',
    width: 1200,
    height: 800,
    host: 'a',
    page_url: 'https://a.test',
    query: '猫',
  }));

  const seen = [];
  const instance = new plugin({
    searchImages: async (query) => ({ query, total: 8, items }),
    downloadImage: async (item, dataDir, options) => {
      seen.push({ maxEdge: options?.maxEdge, targetBytes: options?.targetBytes });
      return { path: `${dataDir}/x.jpg`, mediaType: 'image/jpeg', bytes: 1000, name: 'x.jpg' };
    },
  });

  await instance.search(
    { query: '猫', count: 8, include_images: true },
    { getDataDir: () => '/tmp/pd' },
  );

  assert.equal(seen.length, 8);
  for (const s of seen) {
    assert.equal(s.maxEdge, 512);
    assert.ok(s.targetBytes > 0);
  }
});
test('尺寸未知的条目不因阈值被丢掉', async () => {
  const instance = new plugin({
    searchImages: async (query) => ({
      query,
      total: 1,
      items: [
        {
          title: '尺寸未知',
          image_url: 'https://img.test/x.jpg',
          width: 0,
          height: 0,
          host: 'a',
          page_url: 'https://a.test',
          query,
        },
      ],
    }),
  });

  const response = await instance.search(
    { query: '猫' },
    { getDataDir: () => require('node:os').tmpdir() },
  );

  assert.match(response.content, /尺寸未知/);
});

test('提示词要求用 Markdown 图片展示给用户，而不是裸链接', () => {
  const instance = new plugin();
  let prompt = null;
  const handle = { registerTool: () => {}, registerPrompt: (d) => (prompt = d) };
  instance.onLoad({
    getDataDir: () => require('node:os').tmpdir(),
    registerToolKit: (def) => {
      def.onLoad(handle);
      return handle;
    },
  });

  const text = prompt.content;
  // 必须有"用 markdown 图片语法展示"的明确指令
  assert.match(text, /!\[[^\]]*\]\(/);
  // 展示用 Image 字段（百度 CDN 可直连），并明确禁止拿 Full-size 做展示
  assert.match(text, /`Image` 字段/);
  assert.match(text, /不要用 `Full-size image` 做展示/);
  // 来源要写进 alt，避免另起一行把卡片撑得很丑
  assert.match(text, /来源写进 alt/);
  assert.match(text, /内容 \+ 来源/);
  // 不应再出现误导性的 include_images 解释（它只管模型自己看，与展示无关）
  assert.doesNotMatch(text, /除了 `include_images`/);
});

test('工具描述也提到 Markdown 展示方式', () => {
  const instance = new plugin();
  let tool = null;
  const handle = { registerTool: (d) => (tool = d), registerPrompt: () => {} };
  instance.onLoad({
    getDataDir: () => require('node:os').tmpdir(),
    registerToolKit: (def) => {
      def.onLoad(handle);
      return handle;
    },
  });

  assert.match(tool.description, /Markdown `!\[alt\]\(Image url\)`/);
  // 工具描述也要说明来源放 alt、不要另起一行
  assert.match(tool.description, /source inside the alt text/);
});

test('提示词引导批量筛选交给子代理，并给出交付格式', () => {
  const instance = new plugin();
  let prompt = null;
  const handle = { registerTool: () => {}, registerPrompt: (d) => (prompt = d) };
  instance.onLoad({
    getDataDir: () => require('node:os').tmpdir(),
    registerToolKit: (def) => {
      def.onLoad(handle);
      return handle;
    },
  });

  assert.ok(prompt, '应注册使用说明提示词');
  const text = prompt.content;

  // 委派建议必须存在，且引用的是宿主真实工具名
  assert.match(text, /subagent_spawn/);
  // 要说明"只回结论不回图"，否则子代理会把大量预览又搬回主上下文
  assert.match(text, /Full-size/);
  assert.match(text, /不要贴图/);
  // 同时要防止模型对简单请求也绕一层子代理
  assert.match(text, /直接在主对话搜/);
});

test('工具描述里也提示了批量筛选场景', () => {
  const instance = new plugin();
  let tool = null;
  const handle = { registerTool: (d) => (tool = d), registerPrompt: () => {} };
  instance.onLoad({
    getDataDir: () => require('node:os').tmpdir(),
    registerToolKit: (def) => {
      def.onLoad(handle);
      return handle;
    },
  });

  assert.match(tool.description, /subagent_spawn/);
  assert.match(tool.description, /previews are large in context/);
});

test('schema 不向模型暴露 max_side，但保留 min_width', () => {
  const instance = new plugin();
  let capturedTool = null;
  const handle = { registerTool: (d) => (capturedTool = d), registerPrompt: () => {} };
  instance.onLoad({
    getDataDir: () => require('node:os').tmpdir(),
    registerToolKit: (def) => {
      def.onLoad(handle);
      return handle;
    },
  });

  const shape = capturedTool.inputSchema.shape;
  assert.deepEqual(Object.keys(shape).sort(), [
    'count',
    'include_images',
    'min_width',
    'page',
    'query',
  ]);
  // 分辨率不再由模型调参：按张数自动决定
  assert.equal(shape.max_side, undefined);
  assert.equal(shape.max_edge, undefined);
});

