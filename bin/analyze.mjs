import { createHash } from 'node:crypto';
import fs from 'node:fs';

function md5(s) { return createHash('md5').update(s).digest('hex'); }

const TMP = '/tmp/cmp';

function loadContent(path) {
  const raw = fs.readFileSync(path, 'utf-8');
  if (!raw || raw === 'null') return null;
  let js = null;
  // SSE: 遍历 data: 行
  for (const ln of raw.split(/\r?\n/)) {
    const t = ln.trim();
    if (t.startsWith('data:')) { try { js = JSON.parse(t.slice(5).trim()); } catch {} }
  }
  if (!js) { try { js = JSON.parse(raw); } catch { js = raw; } }
  return js;
}

function extractInner(resp) {
  // 网关 resp: { jsonrpc, result: { content: [{text:"..."}], isError } }
  // 上游 resp: { jsonrpc, result: { content: [{text:"..."}], isError } }
  let inner = null;
  const content = resp?.result?.content;
  if (Array.isArray(content)) {
    const tp = content.find(c => c?.type === 'text');
    if (tp) {
      try { inner = JSON.parse(tp.text); } catch { inner = tp.text; }
    }
  }
  return { isError: resp?.result?.isError, inner };
}

function findList(obj, depth=0, path='') {
  if (depth > 5 || !obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  // 候选路径
  const candidates = [
    { arr: obj.list, path: path + '.list' },
    { arr: obj.data?.list, path: path + '.data.list', total: obj.data?.total ?? obj.data?.recordsFiltered },
    { arr: obj.data?.data?.list, path: path + '.data.data.list', total: obj.data?.data?.total ?? obj.data?.data?.recordsFiltered },
    { arr: obj.data?.data?.records, path: path + '.data.data.records' },
  ];
  for (const c of candidates) {
    if (Array.isArray(c.arr) && c.arr.length > 0) return c;
  }
  // 递归
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'object' && v !== null) {
      const r = findList(v, depth + 1, path + '.' + k);
      if (r) return r;
    }
  }
  return null;
}

function printStruct(obj, indent=0) {
  if (!obj || typeof obj !== 'object') return;
  const pad = '  '.repeat(indent);
  console.log(pad + 'keys: ' + Object.keys(obj).join(', '));
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      console.log(pad + '.' + k + ':');
      printStruct(v, indent + 1);
    } else if (Array.isArray(v)) {
      console.log(pad + '.' + k + ': array(' + v.length + ')');
      if (v.length > 0 && v[0] && typeof v[0] === 'object') {
        console.log(pad + '  first keys: ' + Object.keys(v[0]).slice(0, 10).join(', '));
      }
    } else {
      console.log(pad + '.' + k + ' = ' + JSON.stringify(v).slice(0, 60));
    }
  }
}

function analyze(name, path) {
  const resp = loadContent(path);
  const { isError, inner } = extractInner(resp);
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${name}`);
  console.log(`${'─'.repeat(60)}`);
  console.log(`  isError: ${isError}`);
  if (!inner || typeof inner === 'string') {
    console.log(`  inner (text): ${String(inner).slice(0, 300)}`);
    return null;
  }
  if (inner.error) {
    console.log(`  inner.error: ${JSON.stringify(inner.error).slice(0, 400)}`);
    return null;
  }
  console.log(`  code=${inner.code} success=${inner.success} msg=${(inner.msg || '').slice(0, 100)}`);
  console.log(`  top-level keys: ${Object.keys(inner).join(', ')}`);
  if (inner.data && typeof inner.data === 'object') {
    console.log(`  data keys: ${Object.keys(inner.data).join(', ')}`);
    if (inner.data.data && typeof inner.data.data === 'object') {
      console.log(`  data.data keys: ${Object.keys(inner.data.data).join(', ')}`);
    }
  }

  const list = findList(inner);
  if (!list) {
    console.log('  ❌ 没找到 list 数组!');
    console.log('  完整结构:');
    printStruct(inner, 2);
    return null;
  }
  const first = list.arr[0];
  const last = list.arr[list.arr.length - 1];
  const firstStr = JSON.stringify(first);
  console.log(`  ✅ list path=${list.path} length=${list.arr.length} total=${list.total ?? '?'}`);
  console.log(`  first keys(${Object.keys(first).length}): ${Object.keys(first).slice(0, 15).join(', ')}`);
  console.log(`  first MD5: ${md5(firstStr)} (len=${firstStr.length})`);
  console.log(`  last  MD5: ${md5(JSON.stringify(last))}`);
  // 聚合
  const sumKeys = Object.keys(first).filter(k => typeof first[k] === 'number' && /cost|spend|impression|click|order|sale|revenue|ad_unit|profit|roi|roas/i.test(k));
  for (const k of sumKeys.slice(0, 6)) {
    const sum = list.arr.reduce((s, row) => s + (Number(row[k]) || 0), 0);
    console.log(`  SUM(${k}): ${sum.toFixed(2)}`);
  }
  return { list, first, last, firstStr };
}

// ========== 执行 ==========

const TARGETS = [
  { name: 'ad_campaign_report', upPath: TMP + '/up-campaign.json', gwPath: TMP + '/gw-campaign.json' },
  { name: 'warehouse_order_plan_list', upPath: TMP + '/up-wh.json', gwPath: TMP + '/gw-wh.json' },
];

for (const t of TARGETS) {
  console.log('\n' + '='.repeat(70));
  console.log(`🔍 ${t.name}`);
  console.log('='.repeat(70));

  const up = analyze('📡 直接上游 action', t.upPath);
  const gw = analyze('🚪 网关 tools/call',  t.gwPath);

  if (up && gw) {
    console.log(`\n  📊 对比汇总:`);
    console.log(`  list length: 上游=${up.list.arr.length} 网关=${gw.list.arr.length}`);
    console.log(`  first MD5:   上游=${md5(JSON.stringify(up.first))} 网关=${md5(JSON.stringify(gw.first))} ${md5(JSON.stringify(up.first)) === md5(JSON.stringify(gw.first)) ? '✅ 完全一致' : '❌ 不同!'}`);
    console.log(`  total:       上游=${up.list.total ?? '?'} 网关=${gw.list.total ?? '?'}`);

    // 行对比：网关卡住了上游 5 行中的哪几行
    const gwKeys = new Set(Object.keys(gw.first));
    const upKeys = new Set(Object.keys(up.first));
    const onlyUp = [...upKeys].filter(k => !gwKeys.has(k));
    const onlyGw = [...gwKeys].filter(k => !upKeys.has(k));
    if (onlyUp.length) console.log(`  字段:        上游独有=${onlyUp.join(', ')}`);
    if (onlyGw.length) console.log(`  字段:        网关独有=${onlyGw.join(', ')}`);

    // 同一行逐字段对比（如果长度相同）
    if (up.list.arr.length === gw.list.arr.length) {
      let diffFields = new Set();
      for (let i = 0; i < up.list.arr.length; i++) {
        const uRow = up.list.arr[i];
        const gRow = gw.list.arr[i];
        for (const k of Object.keys(uRow)) {
          const uv = JSON.stringify(uRow[k]);
          const gv = JSON.stringify(gRow[k]);
          if (uv !== gv) diffFields.add(k);
        }
      }
      if (diffFields.size) {
        console.log(`  逐行不同字段(${diffFields.size}): ${[...diffFields].join(', ')}`);
      } else {
        console.log(`  ✅ 所有行逐字段完全一致`);
      }
    }
  }
}
