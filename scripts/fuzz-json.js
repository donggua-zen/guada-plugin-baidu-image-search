'use strict';

/**
 * 真实接口压测：连续多次搜索，统计解析成功率与破损类型。
 * 用不同关键词提高命中"标题含换行"这类破损的概率。
 */

const search = require(process.argv[2] || '../lib/baidu-search');
const { repairJson, parseJsonLenient, salvageDataItems } = search._internal;
const { getPublicUrl } = require('../lib/http');

const ACJSON = 'https://image.baidu.com/search/acjson';
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'text/plain, */*; q=0.01',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  Referer: 'https://image.baidu.com/',
  'X-Requested-With': 'XMLHttpRequest',
  Connection: 'keep-alive',
};

const QUERIES = [
  '布偶猫', '敦煌壁画', '樱花', '故宫', '长城', '西湖', '熊猫', '火锅',
  '雪山', '长城日落', '赛博朋克城市', '极光', '沙漠', '竹林', '海浪',
  '猫', '狗', '咖啡', '星空', '森林',
];

function buildUrl(word, pn = 0, rn = 30) {
  const q = new URLSearchParams({
    tn: 'resultjson_com', ipn: 'rj', ct: '201326592', is: '', fp: 'result', fr: '',
    word, queryWord: word, cl: '2', lm: '-1', ie: 'utf-8', oe: 'utf-8', st: '-1',
    z: '', ic: '', hd: '', latest: '', copyright: '', s: '', se: '', tab: '',
    width: '', height: '', face: '0', istype: '2', qc: '', nc: '1', expermode: '',
    nojc: '', isAsync: '', pn: String(pn), rn: String(rn), gsm: '1e',
  });
  return `${ACJSON}?${q.toString()}`;
}

(async () => {
  let strictOk = 0;
  let repairedOk = 0;
  let salvaged = 0;
  let failed = 0;
  const failures = [];

  for (const word of QUERIES) {
    let body;
    try {
      const res = await getPublicUrl(buildUrl(word), {
        headers: HEADERS,
        timeoutMs: 12000,
        maxBytes: 8 * 1024 * 1024,
      });
      if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);
      body = res.body.toString('utf8');
    } catch (err) {
      failed += 1;
      failures.push(`${word}: 请求失败 ${err.message}`);
      continue;
    }

    // 1) 原始 JSON 能否直接解析
    let strict = true;
    try {
      JSON.parse(body);
    } catch {
      strict = false;
    }

    // 2) 走修复
    let payload = null;
    let mode = '';
    try {
      payload = parseJsonLenient(body);
      mode = strict ? 'strict' : 'repaired';
    } catch {
      const items = salvageDataItems(body);
      if (items.length) {
        payload = { data: items };
        mode = 'salvaged';
      }
    }

    const itemCount = Array.isArray(payload?.data) ? payload.data.filter(Boolean).length : 0;
    if (!mode) {
      failed += 1;
      // 记录出错位置附近的内容，便于判断真实破损形态
      try {
        JSON.parse(body);
      } catch (e) {
        const m = /position (\d+)/.exec(e.message);        const pos = m ? Number(m[1]) : 0;
        const snippet = JSON.stringify(body.slice(Math.max(0, pos - 60), pos + 60));
        failures.push(`${word}: ${e.message}\n    附近: ${snippet}`);
      }
      continue;
    }

    if (mode === 'strict') strictOk += 1;
    else if (mode === 'repaired') repairedOk += 1;
    else salvaged += 1;

    console.log(
      `${word.padEnd(14)} ${mode.padEnd(9)} items=${String(itemCount).padStart(2)} bytes=${body.length}`,
    );
    await new Promise((r) => setTimeout(r, 1200));
  }

  const total = QUERIES.length;
  console.log('\n=== 汇总 ===');
  console.log(`样本 ${total}：原始合法 ${strictOk}，修复成功 ${repairedOk}，抢救 ${salvaged}，失败 ${failed}`);
  if (failures.length) {
    console.log('\n失败明细:');
    failures.forEach((f) => console.log(' - ' + f));
  }
  process.exit(failed > 0 ? 1 : 0);
})();
