// 完整初始化 + syncAllUpstreams
import { initDb, db } from '../dist/db.js';
import { syncAllUpstreams } from '../dist/sync.js';

initDb();  // 真正初始化 db

console.log('=== DB status ===');
try {
  db.prepare('SELECT 1').get();
  console.log('DB OK');
} catch (e) {
  console.error('DB FAIL:', e.message);
  process.exit(1);
}

console.log('\n=== syncAllUpstreams start ===');
try {
  const stats = await syncAllUpstreams();
  console.log('syncAllUpstreams DONE');
  // 打印 stats
  if (typeof stats === 'object') {
    for (const [k, v] of Object.entries(stats)) {
      console.log(`  ${k}: ${JSON.stringify(v).slice(0, 200)}`);
    }
  }
} catch (e) {
  console.error('syncAllUpstreams FAILED:', e);
  console.error(e.stack);
  process.exit(1);
}

console.log('\n=== SCHEMA DIFF: ad_campaign_report ===');
const row = db.prepare("SELECT input_schema FROM tools WHERE tool_id='ad_campaign_report' AND upstream='lingxing'").get();
if (row) {
  const s = JSON.parse(row.input_schema);
  console.log('  required:', JSON.stringify(s.required));
  console.log('  properties:', Object.keys(s.properties || {}).join(', '));
}

console.log('\n=== SCHEMA DIFF: warehouse_order_plan_list ===');
const row2 = db.prepare("SELECT input_schema FROM tools WHERE tool_id='warehouse_order_plan_list' AND upstream='lingxing'").get();
if (row2) {
  const s = JSON.parse(row2.input_schema);
  console.log('  required:', JSON.stringify(s.required));
  console.log('  properties:', Object.keys(s.properties || {}).join(', '));
}

console.log('\n=== DONE ===');
