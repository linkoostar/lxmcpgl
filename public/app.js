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
  switchPage('tools');
}

function switchPage(name) {
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.page === name));
  $('#page-tools').classList.toggle('hidden', name !== 'tools');
  $('#page-users').classList.toggle('hidden', name !== 'users');
  $('#page-settings').classList.toggle('hidden', name !== 'settings');
  if (name === 'tools') loadTools();
  if (name === 'users') loadUsers();
  if (name === 'settings') loadSettings();
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

const toolState = { q: '', page: 1, pageSize: 50, total: 0, selected: new Set(), selectFiltered: false };

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
    const code = document.createElement('code');
    code.textContent = t.tool_id;
    td1.appendChild(code);

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
    td4.innerHTML = t.has_schema ? '<span class="tag ok">已拉取</span>' : '<span class="tag no">缺失</span>';

    const td5 = document.createElement('td');
    const toggle = document.createElement('button');
    toggle.className = 'btn small';
    toggle.textContent = t.enabled ? '启用' : '停用';
    toggle.onclick = async () => {
      try {
        await api(`/tools/${encodeURIComponent(t.tool_id)}/enabled`, { method: 'PUT', body: { enabled: !t.enabled } });
        loadTools();
      } catch (e) { toast(e.message); }
    };
    td5.appendChild(toggle);

    const td6 = document.createElement('td');
    const detail = document.createElement('button');
    detail.className = 'btn small';
    detail.textContent = '详情';
    detail.onclick = () => showToolDetail(t.tool_id);
    td6.appendChild(detail);

    tr.append(td0, td1, td2, td3, td4, td5, td6);
    tbody.appendChild(tr);
  }
  if (!data.items.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:30px">暂无数据，点击右上角「同步工具」从上游拉取</td></tr>';
  }
  updateBatchBar();
}

$('#btn-search').addEventListener('click', () => {
  toolState.q = $('#tool-search').value.trim();
  toolState.page = 1;
  loadTools().catch((e) => toast(e.message));
});
$('#tool-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-search').click(); });
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

    tr.append(td1, td2, td3, td4, td5, td6, td7, td8);
    tbody.appendChild(tr);
  }
  if (!data.items.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--muted);padding:30px">还没有运营用户，右上角添加</td></tr>';
  }
}

function showNewKey(key, username) {
  $('#new-key-tip').classList.remove('hidden');
  $('#new-key-value').value = key;
  $('#new-key-tip').querySelector('b').textContent = `${username} 的 Key（只显示一次，请立即复制发给运营）：`;
  const cfg = {
    mcpServers: {
      'lingxing-gateway': {
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
  if (!username) { toast('请填写用户名'); return; }
  try {
    const r = await api('/users', { method: 'POST', body: { username, rate_limit: rate } });
    showNewKey(r.downstream_key, username);
    $('#new-user-name').value = '';
    $('#new-user-rate').value = '';
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

async function openUserPerm(u) {
  const detail = await api('/users/' + u.id);
  permState.mode = 'user';
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

  $('#user-modal-save').textContent = '保存权限';
  $('#user-mask').classList.remove('hidden');
}

async function openTemplateEditor() {
  const s = await api('/settings');
  permState.mode = 'template';
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
    label.append(chk, document.createTextNode(`${t.tool_id}（${t.name || ''}）`));
    list.appendChild(label);
  }
  if (!tools.length) list.innerHTML = '<span class="muted">请先在工具列表页同步工具</span>';
}

async function ensureToolsCache() {
  if (permState.toolsCache) return;
  const items = [];
  for (let page = 1; page <= 40; page++) {
    const d = await api('/tools?' + new URLSearchParams({ page, page_size: 50 }));
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
  const shops = permState.shopsCache || [];
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
    label.append(chk, document.createTextNode(`${s.sid} ${s.name}（${s.country}）`));
    list.appendChild(label);
  }
  if (!shops.length) list.innerHTML = '<span class="muted">请先在「系统设置」同步店铺</span>';
}

document.querySelectorAll('input[name="perm-tools"]').forEach((r) =>
  r.addEventListener('change', () => { permState.allTools = r.value === 'all' ? r.checked : !r.checked; })
);
document.querySelectorAll('input[name="perm-shops"]').forEach((r) =>
  r.addEventListener('change', () => { permState.allShops = r.value === 'all' ? r.checked : !r.checked; })
);
$('#perm-tool-search').addEventListener('input', renderPermTools);
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
  $('#set-url').value = s.upstream_url || '';
  $('#key-masked').textContent = s.upstream_key_set ? `（已设置 ${s.upstream_key_masked}）` : '（未设置）';
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
}

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
      'lingxing-gateway': {
        type: 'streamableHttp',
        url: `${location.origin}/mcp`,
        headers: { Authorization: `Bearer ${key}` },
      },
    },
  };
  $('#mcp-snippet').textContent = JSON.stringify(cfg, null, 2);
}

$('#btn-save-settings').addEventListener('click', async () => {
  try {
    const body = { upstream_url: $('#set-url').value.trim() };
    const key = $('#set-key').value.trim();
    if (key) body.upstream_key = key;
    await api('/settings', { method: 'PUT', body });
    $('#set-key').value = '';
    toast('已保存');
    loadSettings().catch(() => {});
  } catch (e) { toast(e.message); }
});

$('#btn-test').addEventListener('click', async () => {
  const el = $('#test-result');
  el.textContent = '测试中…';
  try {
    const body = { upstream_url: $('#set-url').value.trim() };
    const key = $('#set-key').value.trim();
    if (key) body.upstream_key = key;
    const r = await api('/settings/test', { method: 'POST', body });
    el.textContent = r.ok ? `连接成功：${r.serverInfo?.name || '未知服务'} ${r.serverInfo?.version || ''}` : `失败：${r.error}`;
  } catch (e) { el.textContent = '失败：' + e.message; }
});

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

/* ---------- 初始化 ---------- */

(async () => {
  try {
    const me = await api('/me');
    showApp(me.username);
  } catch {
    showLogin();
  }
})();
