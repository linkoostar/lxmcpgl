/* 领星 MCP 网关管理前端 */
'use strict';

const $ = (sel) => document.querySelector(sel);

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
  $('#page-settings').classList.toggle('hidden', name !== 'settings');
  if (name === 'tools') loadTools();
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

/* ---------- 工具列表 ---------- */

const toolState = { q: '', page: 1, pageSize: 50, total: 0 };

async function loadTools() {
  const params = new URLSearchParams({ q: toolState.q, page: toolState.page, page_size: toolState.pageSize });
  const data = await api('/tools?' + params);
  toolState.total = data.total;
  $('#page-info').textContent = `共 ${data.total} 个工具 · 第 ${toolState.page} / ${Math.max(1, Math.ceil(data.total / toolState.pageSize))} 页`;
  const tbody = $('#tools-tbody');
  tbody.innerHTML = '';
  for (const t of data.items) {
    const tr = document.createElement('tr');
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
    td3.innerHTML = t.has_schema ? '<span class="tag ok">已拉取</span>' : '<span class="tag no">缺失</span>';

    const td4 = document.createElement('td');
    const toggle = document.createElement('button');
    toggle.className = 'btn small';
    toggle.textContent = t.enabled ? '启用' : '停用';
    toggle.onclick = async () => {
      try {
        await api(`/tools/${encodeURIComponent(t.tool_id)}/enabled`, { method: 'PUT', body: { enabled: !t.enabled } });
        loadTools();
      } catch (e) { toast(e.message); }
    };
    td4.appendChild(toggle);

    const td5 = document.createElement('td');
    const detail = document.createElement('button');
    detail.className = 'btn small';
    detail.textContent = '详情';
    detail.onclick = () => showToolDetail(t.tool_id);
    td5.appendChild(detail);

    tr.append(td1, td2, td3, td4, td5);
    tbody.appendChild(tr);
  }
  if (!data.items.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:30px">暂无数据，点击右上角「同步工具」从上游拉取</td></tr>';
  }
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

/* ---------- 设置 ---------- */

async function loadSettings() {
  const s = await api('/settings');
  $('#set-url').value = s.upstream_url || '';
  $('#key-masked').textContent = s.upstream_key_set ? `（已设置 ${s.upstream_key_masked}）` : '（未设置）';
  $('#down-key').value = s.downstream_key || '';
  $('#sync-status').textContent = s.last_sync_at ? `上次同步：${new Date(s.last_sync_at).toLocaleString()} · 已缓存 ${s.tool_count} 个工具` : `尚未同步 · 已缓存 ${s.tool_count} 个工具`;
  renderSnippet(s.downstream_key);
}

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
  navigator.clipboard.writeText(text).then(() => toast(msg)).catch(() => toast('复制失败，请手动选择复制'));
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
