/* 领星 MCP 网关管理前端 */
'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function toast(msg, ms = 2200) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), ms);
}

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) {
    showLogin();
    throw new Error('未登录');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

/* ---------- 视图切换 ---------- */

function showLogin() {
  $('#view-login').classList.remove('hidden');
  $('#view-app').classList.add('hidden');
}

function showApp(username) {
  $('#view-login').classList.add('hidden');
  $('#view-app').classList.remove('hidden');
  $('#me-name').textContent = username || '';
  // 加载版本号（从 settings API）
  api('/settings').then((s) => {
    const el = $('#app-version');
    if (el && s.version) el.textContent = `v${s.version}`;
  }).catch(() => {});
  switchPage('tools');
}

function switchPage(name) {
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.page === name));
  $('#page-tools').classList.toggle('hidden', name !== 'tools');
  $('#page-users').classList.toggle('hidden', name !== 'users');
  $('#page-settings').classList.toggle('hidden', name !== 'settings');
  $('#page-logs').classList.toggle('hidden', name !== 'logs');
  if (name === 'tools') { populateUpstreamFilter().then(() => loadTools()); }
  if (name === 'users') loadUsers();
  if (name === 'settings') loadSettings();
  if (name === 'logs') loadLogs();
}

/* ---------- 登录 ---------- */

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').classList.add('hidden');
  try {
    await api('/login', { method: 'POST', body: { username: $('#login-user').value, password: $('#login-pass').value } });
    const me = await api('/me');
    showApp(me.username);
  } catch (err) {
    $('#login-error').textContent = err.message === '未登录' ? '登录失败' : err.message;
    $('#login-error').classList.remove('hidden');
  }
});

$('#btn-logout').addEventListener('click', async () => {
  try { await api('/logout', { method: 'POST' }); } catch {}
  showLogin();
});

document.querySelectorAll('.nav-btn').forEach((b) => b.addEventListener('click', () => switchPage(b.dataset.page)));

/* ---------- 工具列表（含批量选择） ---------- */

const toolState = { q: '', page: 1, pageSize: 50, toolType: '', upstream: '', total: 0, selected: new Set(), selectFiltered: false };

/** 工具列表页切到时，把后端 upstream 列表灌进筛选 select（带工具数） */
async function populateUpstreamFilter() {
  try {
    const data = await api('/upstreams');
    const sel = $('#tool-upstream-filter');
    const cur = toolState.upstream;
    sel.innerHTML = '<option value="">全部上游</option>' +
      data.items.map((u) => `<option value="${u.id}" ${cur === u.id ? 'selected' : ''}>${escapeHtml(u.name)} (${u.tool_count})</option>`).join('');
  } catch (e) { /* ignore */ }
}

function updateBatchBar() {
  const n = toolState.selected.size;
  const bar = $('#batch-bar');
  if (n === 0 && !toolState.selectFiltered) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');
  let txt = `已选 ${n} 个`;
  if (toolState.selectFiltered) txt += `（含全部搜索结果：${toolState.total} 个）`;
  $('#batch-info').textContent = txt;
  const pageIds = $$('#tools-tbody input.row-chk').map((c) => c.dataset.id);
  $('#chk-all-page').checked = pageIds.length > 0 && pageIds.every((id) => toolState.selected.has(id));
}

async function loadTools() {
  const params = new URLSearchParams({ q: toolState.q, page: toolState.page, page_size: toolState.pageSize });
  if (toolState.toolType) params.set('tool_type', toolState.toolType);
  if (toolState.upstream) params.set('upstream', toolState.upstream);
  const data = await api('/tools?' + params);
  toolState.total = data.total;
  $('#page-info').textContent = `共 ${data.total} 个工具 · 第 ${toolState.page} / ${Math.max(1, Math.ceil(data.total / toolState.pageSize))} 页`;
  const tbody = $('#tools-tbody');
  tbody.innerHTML = '';
  for (const t of data.items) {
    const tr = document.createElement('tr');

    const td0 = document.createElement('td');
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.className = 'row-chk';
    chk.dataset.id = t.tool_id;
    chk.checked = toolState.selected.has(t.tool_id);
    chk.addEventListener('change', () => {
      if (chk.checked) toolState.selected.add(t.tool_id);
      else {
        toolState.selected.delete(t.tool_id);
        toolState.selectFiltered = false;
      }
      updateBatchBar();
    });
    td0.appendChild(chk);

    const td1 = document.createElement('td');
    td1.innerHTML = `<code>${escapeHtml(t.tool_id)}</code>`;
    if (t.has_schema) {
      const s = document.createElement('div');
      s.className = 'muted';
      s.style.fontSize = '11px';
      s.textContent = 'Schema ✓';
      td1.appendChild(s);
    }

    const td2 = document.createElement('td');
    td2.innerHTML = `<b>${escapeHtml(t.name)}</b>`;
    if (t.description) {
      const d = document.createElement('span');
      d.className = 'desc';
      d.textContent = t.description;
      d.title = t.description;
      td2.appendChild(d);
    }

    const td3 = document.createElement('td');
    if (t.tool_type === 'write') td3.innerHTML = '<span class="tag warn">write</span>';
    else if (t.tool_type === 'read') td3.innerHTML = '<span class="tag ok">read</span>';
    else td3.innerHTML = '<span class="muted">-</span>';

    const td4 = document.createElement('td');
    td4.innerHTML = t.enabled
      ? '<span class="tag ok" title="已启用">● 启用</span>'
      : '<span class="tag no" title="已停用">○ 停用</span>';

    const td5 = document.createElement('td');
    const toggle = document.createElement('button');
    toggle.className = `btn small ${t.enabled ? 'ghost' : 'primary'}`;
    toggle.textContent = t.enabled ? '停用' : '启用';
    toggle.onclick = async () => {
      try {
        await api(`/tools/${encodeURIComponent(t.tool_id)}/enabled`, { method: 'PUT', body: { enabled: !t.enabled } });
        loadTools();
      } catch (e) { toast(e.message); }
    };
    const detail = document.createElement('button');
    detail.className = 'btn small ghost';
    detail.textContent = '详情';
    detail.style.marginLeft = '6px';
    detail.onclick = () => showToolDetail(t.tool_id);
    td5.append(toggle, detail);

    tr.append(td0, td1, td2, td3, td4, td5);
    tbody.appendChild(tr);
  }
  if (!data.items.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:30px">暂无数据，点击右上角「同步工具」从上游拉取</td></tr>';
  }
  updateBatchBar();
}

$('#btn-search').addEventListener('click', () => {
  toolState.q = $('#tool-search').value.trim();
  toolState.toolType = $('#tool-type-filter').value;
  toolState.upstream = $('#tool-upstream-filter').value;
  toolState.page = 1;
  toolState.selected.clear(); toolState.selectFiltered = false; updateBatchBar();
  loadTools().catch((e) => toast(e.message));
});
$('#tool-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-search').click(); });
$('#tool-type-filter').addEventListener('change', () => $('#btn-search').click());
$('#tool-upstream-filter').addEventListener('change', () => $('#btn-search').click());
$('#btn-prev').addEventListener('click', () => {
  if (toolState.page > 1) { toolState.page--; loadTools().catch((e) => toast(e.message)); }
});
$('#btn-next').addEventListener('click', () => {
  if (toolState.page * toolState.pageSize < toolState.total) { toolState.page++; loadTools().catch((e) => toast(e.message)); }
});

$('#chk-all-page').addEventListener('change', (e) => {
  const checked = e.target.checked;
  $$('#tools-tbody input.row-chk').forEach((c) => {
    c.checked = checked;
    if (checked) toolState.selected.add(c.dataset.id);
    else toolState.selected.delete(c.dataset.id);
  });
  if (!checked) toolState.selectFiltered = false;
  updateBatchBar();
});

$('#btn-select-filtered').addEventListener('click', async () => {
  // 把所有页的 id 拉全（最多 2000）
  const ids = [];
  for (let page = 1; page <= 40; page++) {
    const d = await api('/tools?' + new URLSearchParams({ q: toolState.q, page, page_size: 50 }));
    for (const it of d.items) ids.push(it.tool_id);
    if (page * 50 >= d.total) break;
  }
  toolState.selectFiltered = true;
  ids.forEach((id) => toolState.selected.add(id));
  $$('#tools-tbody input.row-chk').forEach((c) => (c.checked = true));
  $('#chk-all-page').checked = true;
  updateBatchBar();
});

$('#btn-clear-select').addEventListener('click', () => {
  toolState.selected.clear();
  toolState.selectFiltered = false;
  $$('#tools-tbody input.row-chk').forEach((c) => (c.checked = false));
  $('#chk-all-page').checked = false;
  updateBatchBar();
});

async function batchApply(enabled) {
  try {
    const body = toolState.selectFiltered
      ? { all: true, q: toolState.q, enabled }
      : { tool_ids: [...toolState.selected], enabled };
    const r = await api('/tools/batch-enabled', { method: 'POST', body });
    toast(`已${enabled ? '启用' : '停用'} ${r.changed} 个工具`);
    toolState.selected.clear();
    toolState.selectFiltered = false;
    loadTools();
  } catch (e) { toast(e.message); }
}
$('#btn-batch-enable').addEventListener('click', () => batchApply(true));
$('#btn-batch-disable').addEventListener('click', () => batchApply(false));

$('#btn-sync').addEventListener('click', async () => {
  const btn = $('#btn-sync');
  btn.disabled = true;
  btn.textContent = '同步中…';
  $('#sync-status').textContent = '正在从上游拉取工具清单与 Schema，请稍候…';
  try {
    const r = await api('/tools/sync', { method: 'POST' });
    $('#sync-status').textContent = `上次同步：${new Date().toLocaleString()}`;
    toast(`同步完成：清单 ${r.total_listed}，入库 ${r.synced}，缺 Schema ${r.schema_missing}，失败 ${r.failed}（${(r.duration_ms / 1000).toFixed(1)}s）`);
    loadTools().catch(() => {});
  } catch (e) {
    $('#sync-status').textContent = '';
    toast(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '同步工具';
  }
});

async function showToolDetail(toolId) {
  try {
    const t = await api('/tools/' + encodeURIComponent(toolId));
    $('#modal-title').textContent = `${t.tool_id}（暴露名: ${t.exposed_name}）`;
    $('#modal-body').textContent = JSON.stringify(t.input_schema ?? { note: '无 Schema，参数以 {type: object} 兜底' }, null, 2);
    $('#modal-mask').classList.remove('hidden');
  } catch (e) { toast(e.message); }
}
$('#modal-close').addEventListener('click', () => $('#modal-mask').classList.add('hidden'));
$('#modal-mask').addEventListener('click', (e) => { if (e.target === $('#modal-mask')) $('#modal-mask').classList.add('hidden'); });

/* ---------- 运营用户 ---------- */

async function loadUsers() {
  const data = await api('/users');
  const tbody = $('#users-tbody');
  tbody.innerHTML = '';
  for (const u of data.items) {
    const tr = document.createElement('tr');

    const td1 = document.createElement('td');
    td1.innerHTML = `<b>${escapeHtml(u.username)}</b>`;

    const td2 = document.createElement('td');
    td2.innerHTML = `<code>${escapeHtml(u.key_prefix)}…</code>`;

    const td3 = document.createElement('td');
    td3.innerHTML = u.enabled ? '<span class="tag ok">启用</span>' : '<span class="tag no">停用</span>';

    const td3b = document.createElement('td');
    const upVal = u.upstream || '';
    td3b.innerHTML = upVal
      ? `<code style="font-size:12px">${escapeHtml(upVal)}</code>`
      : `<span class="muted" style="font-size:12px;color:#16a34a">全部上游</span>`;

    const td4 = document.createElement('td');
    td4.textContent = u.all_tools ? '全部工具' : `白名单 ${u.tool_count} 个`;

    const td5 = document.createElement('td');
    td5.textContent = u.all_shops ? '全部店铺' : `指定 ${u.shop_count} 店`;

    const td6 = document.createElement('td');
    td6.textContent = u.rate_limit > 0 ? `${u.rate_limit}/分钟` : '不限';

    const td7 = document.createElement('td');
    td7.className = 'muted';
    td7.textContent = u.last_used_at ? new Date(u.last_used_at).toLocaleString() : '从未';

    const td8 = document.createElement('td');
    td8.className = 'row';
    const mkBtn = (text, fn, cls = 'btn small') => {
      const b = document.createElement('button');
      b.className = cls;
      b.textContent = text;
      b.onclick = fn;
      return b;
    };
    td8.append(
      mkBtn('权限', () => openUserPerm(u)),
      mkBtn(u.enabled ? '停用' : '启用', async () => {
        try {
          await api(`/users/${u.id}`, { method: 'PUT', body: { enabled: !u.enabled } });
          loadUsers();
        } catch (e) { toast(e.message); }
      }),
      mkBtn('重置Key', async () => {
        if (!confirm(`重置 ${u.username} 的 Key？旧 Key 立即失效。`)) return;
        try {
          const r = await api(`/users/${u.id}/reset-key`, { method: 'POST' });
          showNewKey(r.downstream_key, u.username);
        } catch (e) { toast(e.message); }
      }),
      mkBtn('删除', async () => {
        if (!confirm(`删除用户 ${u.username}？不可恢复。`)) return;
        try {
          await api(`/users/${u.id}`, { method: 'DELETE' });
          loadUsers();
        } catch (e) { toast(e.message); }
      }, 'btn small danger')
    );

    tr.append(td1, td2, td3, td3b, td4, td5, td6, td7, td8);
    tbody.appendChild(tr);
  }
  if (!data.items.length) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--muted);padding:30px">还没有运营用户，右上角添加</td></tr>';
  }
}

function showNewKey(key, username) {
  $('#new-key-tip').classList.remove('hidden');
  $('#new-key-value').value = key;
  $('#new-key-tip').querySelector('b').textContent = `${username} 的 Key（只显示一次，请立即复制发给运营）：`;
  const cfg = {
    mcpServers: {
      'fangzhong-mcp': {
        type: 'streamableHttp',
        url: `${location.origin}/mcp`,
        headers: { Authorization: `Bearer ${key}` },
      },
    },
  };
  $('#new-key-mcp').textContent = JSON.stringify(cfg, null, 2);
  $('#new-key-tip').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
$('#btn-copy-new-key').addEventListener('click', () => copyText($('#new-key-value').value, 'Key 已复制'));
$('#btn-copy-new-key-mcp').addEventListener('click', () => copyText($('#new-key-mcp').textContent, 'MCP 配置已复制'));
$('#btn-dismiss-new-key').addEventListener('click', () => $('#new-key-tip').classList.add('hidden'));

$('#btn-add-user').addEventListener('click', async () => {
  const username = $('#new-user-name').value.trim();
  const rate = parseInt($('#new-user-rate').value, 10) || 0;
  const upstream = $('#new-user-upstream').value.trim();
  if (!username) { toast('请填写用户名'); return; }
  try {
    const r = await api('/users', { method: 'POST', body: { username, rate_limit: rate, upstream } });
    showNewKey(r.downstream_key, username);
    $('#new-user-name').value = '';
    $('#new-user-rate').value = '';
    $('#new-user-upstream').value = '';
    await loadUsers();
    // 自动弹权限弹窗，使用新用户的 id
    await ensureToolsCache();
    openUserPerm({ id: r.id, username });
  } catch (e) { toast(e.message); }
});

/* ---------- 用户权限弹窗 ---------- */

const permState = {
  userId: null, mode: 'user', // mode: 'user' 或 'template'
  allTools: true, toolIds: new Set(), allShops: true, shopIds: new Set(), shopsCache: null
};

function updatePermSummary() {
  const toolsCount = (permState.toolsCache || []).length;
  const shopsCount = (permState.shopsCache || []).length;
  const tTxt = permState.allTools
    ? `全部启用工具（${toolsCount ? `共 ${toolsCount} 个` : ''}）`
    : `已选 ${permState.toolIds.size} 个工具`;
  const sTxt = permState.allShops
    ? `全部店铺${shopsCount ? `（${shopsCount} 店）` : ''}`
    : `已选 ${permState.shopIds.size} 个店铺`;
  const tEl = $('#perm-summary-tools');
  const sEl = $('#perm-summary-shops');
  if (tEl) tEl.textContent = tTxt;
  if (sEl) sEl.textContent = sTxt;
}
// 暴露给 checkbox 回调（renderPermTools 内部 chk.change 会直接改 permState.toolIds/shopIds，渲染完需要刷新摘要）
permState.updateSummary = updatePermSummary;

async function openUserPerm(u) {
  const detail = await api('/users/' + u.id);
  permState.mode = 'user';
  document.getElementById('perm-upstream-section').style.display = '';
  permState.userId = u.id;
  permState.allTools = detail.all_tools;
  permState.toolIds = new Set(detail.tool_ids);
  permState.allShops = detail.all_shops;
  permState.shopIds = new Set(detail.shop_ids);
  $('#user-modal-title').textContent = `权限设置：${u.username}`;
  $('#user-modal-tip').textContent = '';

  if (!permState.shopsCache) {
    const s = await api('/shops');
    permState.shopsCache = s.items;
  }
  renderPermTools();
  renderPermShops();

  document.querySelector('input[name="perm-tools"][value="all"]').checked = detail.all_tools;
  document.querySelector('input[name="perm-tools"][value="custom"]').checked = !detail.all_tools;
  document.querySelector('input[name="perm-shops"][value="all"]').checked = detail.all_shops;
  document.querySelector('input[name="perm-shops"][value="custom"]').checked = !detail.all_shops;
  $('#perm-upstream').value = detail.upstream || '';

  $('#user-modal-save').textContent = '保存权限';
  updatePermSummary();
  $('#user-mask').classList.remove('hidden');
}

async function openTemplateEditor() {
  const s = await api('/settings');
  permState.mode = 'template';
  document.getElementById('perm-upstream-section').style.display = 'none';
  permState.userId = null;
  permState.allTools = !!s.default_tools_all;
  permState.toolIds = new Set(s.default_tools);
  permState.allShops = !!s.default_shops_all;
  permState.shopIds = new Set(s.default_shops);
  $('#user-modal-title').textContent = '默认权限模板（新建运营用户自动继承）';
  $('#user-modal-tip').textContent = '';

  if (!permState.shopsCache) {
    const shops = await api('/shops');
    permState.shopsCache = shops.items;
  }
  renderPermTools();
  renderPermShops();

  document.querySelector('input[name="perm-tools"][value="all"]').checked = permState.allTools;
  document.querySelector('input[name="perm-tools"][value="custom"]').checked = !permState.allTools;
  document.querySelector('input[name="perm-shops"][value="all"]').checked = permState.allShops;
  document.querySelector('input[name="perm-shops"][value="custom"]').checked = !permState.allShops;

  $('#user-modal-save').textContent = '保存模板';
  updatePermSummary();
  $('#user-mask').classList.remove('hidden');
}

function renderPermTools() {
  const q = ($('#perm-tool-search').value || '').toLowerCase();
  const list = $('#perm-tool-list');
  list.innerHTML = '';
  // 全量工具列表（缓存于首次拉取）
  const tools = permState.toolsCache || [];
  for (const t of tools) {
    if (q && !(t.tool_id + ' ' + (t.name || '')).toLowerCase().includes(q)) continue;
    const label = document.createElement('label');
    label.className = 'perm-item';
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.style.width = 'auto';
    chk.checked = permState.toolIds.has(t.tool_id);
    chk.addEventListener('change', () => {
      if (chk.checked) permState.toolIds.add(t.tool_id);
      else permState.toolIds.delete(t.tool_id);
    });
    const text = document.createElement('span');
    text.className = 'text';
    text.textContent = `${t.tool_id}（${t.name || ''}）`;
    label.append(chk, text);
    list.appendChild(label);
  }
  if (!tools.length) list.innerHTML = '<span class="muted">请先在工具列表页同步工具</span>';
  updatePermSummary();
}

async function ensureToolsCache() {
  if (permState.toolsCache) return;
  const items = [];
  for (let page = 1; page <= 40; page++) {
    const d = await api('/tools?' + new URLSearchParams({ page, page_size: 50, enabled: '1' }));
    items.push(...d.items);
    if (page * 50 >= d.total) break;
  }
  permState.toolsCache = items;
}

const _openUserPerm = openUserPerm;
openUserPerm = async function (u) {
  await ensureToolsCache();
  return _openUserPerm(u);
};

function renderPermShops() {
  const list = $('#perm-shop-list');
  list.innerHTML = '';
  const q = ($('#perm-shop-search')?.value || '').toLowerCase();
  const allShops = permState.shopsCache || [];
  const shops = q
    ? allShops.filter((s) => (s.sid + ' ' + s.name + ' ' + (s.country || '')).toLowerCase().includes(q))
    : allShops;
  for (const s of shops) {
    const label = document.createElement('label');
    label.className = 'perm-item';
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.style.width = 'auto';
    chk.checked = permState.shopIds.has(s.sid);
    chk.addEventListener('change', () => {
      if (chk.checked) permState.shopIds.add(s.sid);
      else permState.shopIds.delete(s.sid);
    });
    const st = document.createElement('span');
    st.className = 'text';
    st.textContent = `${s.sid} ${s.name}（${s.country}）`;
    label.append(chk, st);
    list.appendChild(label);
  }
  if (!shops.length) list.innerHTML = '<span class="muted">请先在「系统设置」同步店铺</span>';
  updatePermSummary();
}

document.querySelectorAll('input[name="perm-tools"]').forEach((r) =>
  r.addEventListener('change', () => { permState.allTools = r.value === 'all' ? r.checked : !r.checked; updatePermSummary(); })
);
document.querySelectorAll('input[name="perm-shops"]').forEach((r) =>
  r.addEventListener('change', () => { permState.allShops = r.value === 'all' ? r.checked : !r.checked; updatePermSummary(); })
);
$('#perm-tool-search').addEventListener('input', renderPermTools);
$('#perm-shop-search')?.addEventListener('input', renderPermShops);
$('#perm-tool-all').addEventListener('click', () => {
  (permState.toolsCache || []).forEach((t) => permState.toolIds.add(t.tool_id));
  renderPermTools();
});
$('#perm-tool-none').addEventListener('click', () => {
  permState.toolIds.clear();
  renderPermTools();
});
$('#perm-tool-read').addEventListener('click', () => {
  (permState.toolsCache || []).filter((t) => t.tool_type === 'read').forEach((t) => permState.toolIds.add(t.tool_id));
  renderPermTools();
});
$('#perm-tool-write').addEventListener('click', () => {
  (permState.toolsCache || []).filter((t) => t.tool_type === 'write').forEach((t) => permState.toolIds.add(t.tool_id));
  renderPermTools();
});
$('#perm-shop-all').addEventListener('click', () => {
  (permState.shopsCache || []).forEach((s) => permState.shopIds.add(s.sid));
  renderPermShops();
});
$('#perm-shop-none').addEventListener('click', () => {
  permState.shopIds.clear();
  renderPermShops();
});
$('#user-modal-close').addEventListener('click', () => $('#user-mask').classList.add('hidden'));
$('#user-mask').addEventListener('click', (e) => { if (e.target === $('#user-mask')) $('#user-mask').classList.add('hidden'); });

$('#user-modal-save').addEventListener('click', async () => {
  try {
    const payload = {
      all_tools: document.querySelector('input[name="perm-tools"][value="all"]').checked,
      tool_ids: [...permState.toolIds],
      all_shops: document.querySelector('input[name="perm-shops"][value="all"]').checked,
      shop_ids: [...permState.shopIds],
      upstream: $('#perm-upstream').value.trim(),
    };
    if (permState.mode === 'template') {
      await api('/settings', {
        method: 'PUT',
        body: {
          default_tools_all: payload.all_tools,
          default_shops_all: payload.all_shops,
          default_tools: payload.tool_ids,
          default_shops: payload.shop_ids,
        },
      });
      $('#user-modal-tip').textContent = '模板已保存';
      toast('默认权限模板已保存');
      if ($('#page-settings').classList.contains('hidden') === false) {
        loadSettings().catch(() => {});
      }
    } else {
      if (!permState.userId) return;
      await api('/users/' + permState.userId, { method: 'PUT', body: payload });
      $('#user-modal-tip').textContent = '已保存';
      toast('权限已保存');
      loadUsers();
    }
    setTimeout(() => $('#user-mask').classList.add('hidden'), 500);
  } catch (e) { $('#user-modal-tip').textContent = e.message; }
});

/* ---------- 设置 ---------- */

async function loadSettings() {
  const s = await api('/settings');
  $('#down-key').value = s.downstream_key || '';
  $('#sync-status').textContent = s.last_sync_at ? `上次同步：${new Date(s.last_sync_at).toLocaleString()} · 已缓存 ${s.tool_count} 个工具` : `尚未同步 · 已缓存 ${s.tool_count} 个工具`;
  $('#shop-count').textContent = s.shop_count > 0 ? `已同步 ${s.shop_count} 店` : '未同步';
  $('#chk-block-write').checked = !!s.block_write;
  renderSnippet(s.downstream_key);

  // 默认权限模板摘要
  const tc = s.tool_type_count || { read: 0, write: 0, other: 0 };
  let toolsTxt, shopsTxt;
  if (s.default_tools_all) toolsTxt = `全部启用工具（read ${tc.read} + write ${tc.write}${tc.other ? ` + 其他 ${tc.other}` : ''}）`;
  else toolsTxt = `自定义白名单 ${s.default_tools?.length || 0} 个工具`;
  if (s.default_shops_all) shopsTxt = `全部店铺（${s.shop_count || 0} 店）`;
  else shopsTxt = `指定 ${s.default_shops?.length || 0} 店`;
  $('#tpl-summary').textContent = `模板：${toolsTxt} · ${shopsTxt}`;

  // 加载 upstream 列表
  loadUpstreams().catch(() => {});
}

/* ---------- Upstreams 多上游管理 ---------- */
let editingUpstreamId = null;

async function loadUpstreams() {
  const { items } = await api('/upstreams');
  renderUpstreams(items);
}

function renderUpstreams(items) {
  const host = $('#upstreams-list');
  if (!items.length) { host.innerHTML = '<p class="muted">暂无上游，请点击下方「添加上游」接入</p>'; return; }
  host.innerHTML = items.map((u) => upstreamCardHTML(u)).join('');
  // 绑定每个卡片的按钮
  items.forEach((u) => bindUpstreamCard(u.id));
}

function upstreamCardHTML(u) {
  const isEditing = editingUpstreamId === u.id;
  if (!isEditing) {
    // 展示模式
    return `
      <div class="upstream-card" data-id="${u.id}" style="border:1px solid var(--border);border-radius:10px;padding:12px 16px;margin-bottom:10px;background:var(--bg-soft)">
        <div class="row" style="align-items:center">
          <b>${u.name}</b>
          <span class="muted" style="font-size:12px;margin-left:6px">(${u.id})</span>
          <span style="margin-left:8px;padding:2px 8px;border-radius:10px;font-size:11px;${u.active ? 'background:#dcfce7;color:#166534' : 'background:#fee2e2;color:#991b1b'}">${u.active ? '启用' : '停用'}</span>
          <span class="muted" style="margin-left:6px;font-size:12px">${u.adapter_label} · ${u.tool_count} 工具</span>
          <div class="spacer"></div>
          <button class="btn small" data-act="test" data-id="${u.id}">测试</button>
          <button class="btn small primary" data-act="sync" data-id="${u.id}">同步</button>
          <button class="btn small" data-act="edit" data-id="${u.id}">编辑</button>
          ${u.id === 'lingxing' ? '' : `<button class="btn small danger" data-act="delete" data-id="${u.id}">删除</button>`}
        </div>
        <div class="muted" style="margin-top:4px;font-size:12px">${u.url} · API Key: ${u.api_key_set ? u.api_key_masked : '<span style="color:#b91c1c">未设置</span>'}</div>
        ${u.headers_preview ? `<div class="muted" style="margin-top:2px;font-size:12px">🔑 Headers: ${u.headers_preview}</div>` : ''}
        ${u.notes ? `<div class="muted" style="margin-top:2px;font-size:12px">${u.notes}</div>` : ''}
      </div>`;
  }
  // 编辑模式
  return `
    <div class="upstream-card editing" data-id="${u.id}" style="border:2px solid var(--primary);border-radius:10px;padding:12px 16px;margin-bottom:10px;background:#f0f9ff">
      <div class="row wrap" style="gap:10px">
        <label style="flex-direction:column;flex:1;min-width:100px">显示名<input class="ed-name" value="${escapeHTML(u.name)}" /></label>
        <label style="flex-direction:column;flex:1;min-width:100px">地址<input class="ed-url" value="${escapeHTML(u.url)}" /></label>
      </div>
      <div class="row wrap" style="gap:10px;margin-top:6px">
        <label style="flex-direction:column;flex:1;min-width:100px">适配器
          <select class="ed-adapter" style="padding:7px 8px;border-radius:8px;border:1px solid var(--border)">
            <option value="flat-mcp" ${u.adapter==='flat-mcp'?'selected':''}>标准扁平 MCP</option>
            <option value="lingxing-meta" ${u.adapter==='lingxing-meta'?'selected':''}>领星元工具模式</option>
          </select>
        </label>
        <label style="flex-direction:column;flex:1;min-width:140px">API Key（留空不改）<input class="ed-key" type="password" placeholder="当前: ${u.api_key_set ? u.api_key_masked : '未设置'}" /></label>
        <label style="flex-direction:row;align-items:center;gap:6px;margin:0">
          <input type="checkbox" class="ed-active" ${u.active ? 'checked' : ''} style="width:auto" /> 启用
        </label>
      </div>
      <label style="flex-direction:column;margin-top:6px">备注<input class="ed-notes" value="${escapeHTML(u.notes || '')}" /></label>
      <label style="flex-direction:column;margin-top:6px">Headers（JSON 对象，可选 — 需要自定义鉴权头比如 NocoDB 的 x-api-key 时填）<textarea class="ed-headers" rows="2" style="font-family:monospace;font-size:12px;padding:7px 8px;border-radius:8px;border:1px solid var(--border)">${escapeHTML(u.headers || '{}')}</textarea></label>
      <div class="row" style="margin-top:10px">
        <button class="btn primary small" data-act="save-edit" data-id="${u.id}">保存</button>
        <button class="btn small" data-act="cancel-edit" data-id="${u.id}">取消</button>
        <span class="muted ed-msg" style="margin-left:8px"></span>
      </div>
    </div>`;
}

function escapeHTML(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

function bindUpstreamCard(id) {
  const host = $('#upstreams-list');
  const card = host.querySelector(`.upstream-card[data-id="${CSS.escape(id)}"]`);
  if (!card) return;
  card.querySelectorAll('[data-act]').forEach((btn) => {
    btn.addEventListener('click', () => handleUpstreamAction(btn.dataset.act, id, card));
  });
}

async function handleUpstreamAction(act, id, card) {
  if (act === 'test') {
    const btn = card.querySelector('[data-act="test"]'); if (btn) btn.textContent = '测试中…';
    try {
      const r = await api(`/upstreams/${id}/test`, { method: 'POST' });
      toast(r.ok ? `✅ 连通：${r.tool_count} 个工具` : `❌ ${r.error}`);
    } catch (e) { toast('失败：' + e.message); }
    await loadUpstreams();
  } else if (act === 'sync') {
    card.querySelector('[data-act="sync"]').textContent = '同步中…';
    try {
      const r = await api(`/upstreams/${id}/sync`, { method: 'POST' });
      toast(`✅ ${r.synced}/${r.total_listed} 工具 · ${r.duration_ms}ms`);
      loadSettings().catch(() => {});
    } catch (e) { toast('失败：' + e.message); }
    await loadUpstreams();
  } else if (act === 'edit') {
    editingUpstreamId = id;
    await loadUpstreams();
  } else if (act === 'delete') {
    if (!confirm(`确认删除 upstream ${id}？其工具将被停用但不删除。`)) return;
    try {
      await api(`/upstreams/${id}`, { method: 'DELETE' });
      toast('已删除');
      await loadUpstreams();
    } catch (e) { toast(e.message); }
  } else if (act === 'save-edit') {
    const patch = {
      name: card.querySelector('.ed-name').value.trim(),
      url: card.querySelector('.ed-url').value.trim(),
      adapter: card.querySelector('.ed-adapter').value,
      active: card.querySelector('.ed-active').checked,
      notes: card.querySelector('.ed-notes').value.trim(),
      headers: card.querySelector('.ed-headers').value.trim() || '{}',
    };
    const key = card.querySelector('.ed-key').value.trim();
    if (key) patch.api_key = key;
    try {
      await api(`/upstreams/${id}`, { method: 'PUT', body: patch });
      toast('已保存');
      editingUpstreamId = null;
      await loadUpstreams();
    } catch (e) { card.querySelector('.ed-msg').textContent = e.message; }
  } else if (act === 'cancel-edit') {
    editingUpstreamId = null;
    await loadUpstreams();
  }
}

/* 新增 upstream 表单 */
$('#nu-test').addEventListener('click', async () => {
  const el = $('#nu-test-result');
  el.textContent = '测试中…';
  try {
    const body = {
      url: $('#nu-url').value.trim(),
      api_key: $('#nu-key').value.trim(),
      adapter: $('#nu-adapter').value,
      headers: $('#nu-headers').value.trim() || '{}',
    };
    const r = await api(`/upstreams/${$('#nu-id').value.trim() || 'new'}/test`, { method: 'POST', body });
    el.textContent = r.ok ? `✅ 连通：${r.tool_count} 个工具` : `❌ ${r.error}`;
  } catch (e) { el.textContent = '失败：' + e.message; }
});

$('#nu-save').addEventListener('click', async () => {
  const id = $('#nu-id').value.trim();
  const body = {
    id,
    name: $('#nu-name').value.trim(),
    url: $('#nu-url').value.trim(),
    api_key: $('#nu-key').value.trim(),
    adapter: $('#nu-adapter').value,
    active: $('#nu-active').checked,
    notes: $('#nu-notes').value.trim(),
    headers: $('#nu-headers').value.trim() || '{}',
  };
  try {
    await api('/upstreams', { method: 'POST', body });
    toast('已保存 upstream');
    // 清表单
    $('#nu-id').value = ''; $('#nu-name').value = ''; $('#nu-url').value = '';
    $('#nu-key').value = ''; $('#nu-notes').value = ''; $('#nu-headers').value = '{}';
    $('#nu-test-result').textContent = '';
    $('#upstream-new-form').open = false;
    await loadUpstreams();
    // 如果勾了启用，顺便同步
    if (body.active) {
      try {
        const r = await api(`/upstreams/${id}/sync`, { method: 'POST' });
        toast(`✅ 同步完成：${r.synced}/${r.total_listed}`);
        loadSettings().catch(() => {});
      } catch (e) { toast('自动同步失败：' + e.message); }
    }
  } catch (e) { toast(e.message); }
});

$('#btn-sync-all-up').addEventListener('click', async () => {
  const el = $('#sync-all-result');
  el.textContent = '同步中…';
  try {
    const r = await api('/upstreams/sync-all', { method: 'POST' });
    const parts = Object.entries(r.results).map(([k, v]) => `${k}: ${v.synced}/${v.total_listed}`);
    el.textContent = `✅ 共 ${r.totalSynced} 工具（${parts.join(' · ')}）`;
    loadSettings().catch(() => {});
  } catch (e) { el.textContent = '❌ ' + e.message; }
});

$('#btn-tpl-edit').addEventListener('click', async () => {
  await ensureToolsCache();
  await openTemplateEditor();
});

$('#btn-tpl-readonly').addEventListener('click', async () => {
  if (!confirm('确认把默认模板设为：全部 read 类工具 + 全部店铺？')) return;
  await ensureToolsCache();
  const readIds = (permState.toolsCache || []).filter((t) => t.tool_type === 'read').map((t) => t.tool_id);
  try {
    await api('/settings', {
      method: 'PUT',
      body: {
        default_tools_all: false,
        default_shops_all: true,
        default_tools: readIds,
      },
    });
    toast(`已设为只读模板：${readIds.length} 个 read 工具 + 全部店铺`);
    loadSettings().catch(() => {});
  } catch (e) { toast(e.message); }
});

function renderSnippet(key) {
  const cfg = {
    mcpServers: {
      'fangzhong-mcp': {
        type: 'streamableHttp',
        url: `${location.origin}/mcp`,
        headers: { Authorization: `Bearer ${key}` },
      },
    },
  };
  $('#mcp-snippet').textContent = JSON.stringify(cfg, null, 2);
}

$('#btn-sync-shops').addEventListener('click', async (e) => {
  const btn = e.target;
  btn.disabled = true;
  btn.textContent = '同步中…';
  try {
    const r = await api('/shops/sync', { method: 'POST' });
    $('#shop-count').textContent = `已同步 ${r.count} 店`;
    permState.shopsCache = null;
    toast(`店铺同步完成，共 ${r.count} 店`);
  } catch (err) { toast(err.message); }
  finally { btn.disabled = false; btn.textContent = '同步店铺'; }
});

$('#chk-block-write').addEventListener('change', async (e) => {
  try {
    await api('/settings', { method: 'PUT', body: { block_write: e.target.checked } });
    toast(e.target.checked ? '已禁止运营调用 write 工具' : '已允许运营调用 write 工具');
  } catch (err) {
    toast(err.message);
    e.target.checked = !e.target.checked;
  }
});

$('#btn-copy-key').addEventListener('click', () => copyText($('#down-key').value, 'Key 已复制'));
$('#btn-copy-snippet').addEventListener('click', () => copyText($('#mcp-snippet').textContent, '配置已复制'));

$('#btn-reset-key').addEventListener('click', async () => {
  if (!confirm('重置后所有使用旧 Key 的客户端都会失效，确定重置？')) return;
  try {
    const r = await api('/downstream-key/reset', { method: 'POST' });
    $('#down-key').value = r.downstream_key;
    renderSnippet(r.downstream_key);
    toast('已重置');
  } catch (e) { toast(e.message); }
});

$('#btn-change-pass').addEventListener('click', async () => {
  const el = $('#pass-result');
  try {
    await api('/change-password', { method: 'POST', body: { old_password: $('#old-pass').value, new_password: $('#new-pass').value } });
    el.textContent = '密码已修改';
    $('#old-pass').value = '';
    $('#new-pass').value = '';
  } catch (e) { el.textContent = e.message; }
});

function copyText(text, msg) {
  const fallback = () => {
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      toast(ok ? msg : '复制失败，请手动选择复制');
    } catch { toast('复制失败，请手动选择复制'); }
  };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(() => toast(msg)).catch(fallback);
  } else fallback();
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- 调用日志 ---------- */

const logState = { q: '', caller: '', success: '', since: '', page: 1, pageSize: 50, total: 0 };

async function loadLogs() {
  // 同时拉 stats 和 列表
  const [stats, callers] = await Promise.all([
    api('/call-logs/stats'),
    api('/users'),
  ]);
  renderLogStats(stats);

  // 填充调用者筛选下拉
  const sel = $('#log-caller-filter');
  sel.innerHTML = '<option value="">全部调用者</option>';
  sel.append(new Option('admin', 'admin'));
  for (const u of callers.items) sel.append(new Option(u.username, u.username));

  // 如果是首次进入且没设置筛选，用最近 7 天
  if (!logState.since && !logState.preset) {
    // 首次使用默认查全部
  }
  await loadLogList();
}

function renderLogStats(stats) {
  const root = $('#log-stats');
  const rate = stats.total > 0 ? ((stats.success / stats.total) * 100).toFixed(1) + '%' : '—';
  const topTools = (stats.top_tools || []).slice(0, 8);
  const topCallers = (stats.top_callers || []).slice(0, 5);
  const toolChips = topTools.map((t) => `<span class="chip">${t.tool_id || t.tool_name} <b>×${t.count}</b></span>`).join('') || '<span class="muted">—</span>';
  const callerChips = topCallers.map((t) => `<span class="chip caller">${t.caller} <b>×${t.count}</b></span>`).join('') || '<span class="muted">—</span>';
  root.innerHTML = `
    <div class="log-stat-card"><div class="label">总调用</div><div class="value">${stats.total}</div></div>
    <div class="log-stat-card success"><div class="label">成功</div><div class="value">${stats.success || 0}</div><div class="muted" style="font-size:12px;margin-top:4px">成功率 ${rate}</div></div>
    <div class="log-stat-card failed"><div class="label">失败 / 拒绝</div><div class="value">${stats.failed || 0}</div></div>
    <div class="log-stat-card avg"><div class="label">平均耗时</div><div class="value">${stats.avg_ms != null ? stats.avg_ms + ' ms' : '—'}</div></div>
  `;
  // 独立横列：热门工具 + 调用者（先清旧的再插新的）
  const prev = document.querySelector('.log-stats-detail');
  if (prev) prev.remove();
  const detail = document.createElement('div');
  detail.className = 'log-stats-detail';
  detail.innerHTML = `
    <div class="detail-col">
      <div class="detail-head">🔥 热门工具 <span class="muted">（调用 ${stats.unique_tools || 0} 种）</span></div>
      <div class="chip-row">${toolChips}</div>
    </div>
    <div class="detail-col">
      <div class="detail-head">👤 调用者 <span class="muted">（${stats.unique_callers || 0} 人）</span></div>
      <div class="chip-row">${callerChips}</div>
    </div>
  `;
  root.after(detail);
}

async function loadLogList() {
  const params = new URLSearchParams();
  if (logState.q) params.set('q', logState.q);
  if (logState.caller) params.set('caller', logState.caller);
  if (logState.success) params.set('success', logState.success);
  if (logState.since) params.set('since', logState.since);
  params.set('page', logState.page);
  params.set('page_size', logState.pageSize);

  const { total, items } = await api('/call-logs?' + params.toString());
  logState.total = total;
  $('#log-page-info').textContent = `共 ${total} 条 · 第 ${logState.page} / ${Math.max(1, Math.ceil(total / logState.pageSize))} 页`;
  const tbody = $('#logs-tbody');
  tbody.innerHTML = '';
  for (const l of items) {
    const tr = document.createElement('tr');
    const ts = new Date(l.ts);
    const td0 = document.createElement('td');
    td0.textContent = ts.toLocaleString();

    const td1 = document.createElement('td');
    td1.textContent = l.caller;
    td1.style.fontWeight = l.caller === 'admin' ? '600' : '';

    const td2 = document.createElement('td');
    td2.innerHTML = `<code>${escapeHtml(l.tool_name)}</code>`;
    if (l.tool_id) td2.innerHTML += `<div class="desc">${escapeHtml(l.tool_id)}</div>`;

    const td3 = document.createElement('td');
    if (l.tool_type === 'write') td3.innerHTML = '<span class="tag warn">write</span>';
    else if (l.tool_type === 'read') td3.innerHTML = '<span class="tag ok">read</span>';
    else td3.innerHTML = '<span class="muted">-</span>';

    const td4 = document.createElement('td');
    td4.textContent = l.duration_ms != null ? `${l.duration_ms}ms` : '-';

    const td5 = document.createElement('td');
    if (l.success) td5.innerHTML = '<span class="tag ok">成功</span>';
    else td5.innerHTML = `<span class="tag no">${l.is_error ? '失败' : '拒绝'}</span>`;

    const td6 = document.createElement('td');
    const shops = (() => {
      try { return l.shop_refs ? JSON.parse(l.shop_refs) : null; } catch { return null; }
    })();
    const parts = [];
    if (l.error) parts.push(`<span class="desc" style="color:#dc2626">${escapeHtml(l.error)}</span>`);
    if (shops && shops.length) parts.push(`<span class="muted">店铺: ${shops.join(', ')}</span>`);
    td6.innerHTML = parts.join(' ') || '<span class="muted">—</span>';

    tr.append(td0, td1, td2, td3, td4, td5, td6);
    tbody.appendChild(tr);
  }
  if (!items.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:30px">暂无调用记录，运营或管理员使用 MCP 网关后会自动记录</td></tr>';
  }
}

$('#btn-log-search').addEventListener('click', async () => {
  logState.q = $('#log-search').value.trim();
  logState.caller = $('#log-caller-filter').value;
  logState.success = $('#log-success-filter').value;
  logState.since = $('#log-since-filter').value
    ? new Date(Date.now() - Number($('#log-since-filter').value) * 3600 * 1000).toISOString()
    : '';
  logState.page = 1;
  logState.preset = true;
  try { await loadLogList(); } catch (e) { toast(e.message); }
});
$('#log-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-log-search').click(); });
$('#btn-log-refresh').addEventListener('click', async () => { try { await loadLogs(); } catch (e) { toast(e.message); } });
$('#btn-log-prev').addEventListener('click', () => { if (logState.page > 1) { logState.page--; loadLogList().catch((e) => toast(e.message)); } });
$('#btn-log-next').addEventListener('click', () => { if (logState.page * logState.pageSize < logState.total) { logState.page++; loadLogList().catch((e) => toast(e.message)); } });
$('#btn-log-clean').addEventListener('click', async () => {
  if (!confirm('清理 30 天前的调用日志？此操作不可恢复。')) return;
  try {
    const r = await api('/call-logs?days=30', { method: 'DELETE' });
    toast(`已清理 ${r.deleted} 条旧日志`);
    loadLogs().catch(() => {});
  } catch (e) { toast(e.message); }
});

/* ---------- 初始化 ---------- */

(async () => {
  try {
    const me = await api('/me');
    showApp(me.username);
  } catch {
    showLogin();
  }
})();
