(function () {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  let hasGlobalAppKey = false;
  let mappingsCache = [];
  let statusCache = null;

  // ==================== API ====================

  async function api(method, path, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(path, opts);
    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error(`HTTP ${res.status}：响应不是 JSON`);
    }
    if (!res.ok) {
      const msg = data.error || data.message || `HTTP ${res.status}`;
      const err = new Error(msg);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  // ==================== UI helpers ====================

  function toast(message, type = 'info') {
    const container = $('#toastContainer');
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatUptime(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  function syncDirectionLabel(dir) {
    const map = { bidirectional: '双向', push: '推送', pull: '拉取' };
    return map[dir] || dir || '—';
  }

  function parseJsonArray(str) {
    if (!str || !str.trim()) return undefined;
    const parsed = JSON.parse(str);
    if (!Array.isArray(parsed)) throw new Error('必须是 JSON 数组');
    return parsed;
  }

  // ==================== Tabs ====================

  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach((t) => t.classList.remove('active'));
      $$('.panel').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      $(`#panel-${tab.dataset.tab}`).classList.add('active');
    });
  });

  // ==================== Health & meta ====================

  async function loadHealth() {
    const data = await api('GET', '/health');
    const badge = $('#healthBadge');
    badge.className = 'header-status ok';
    badge.querySelector('.label').textContent =
      `v${data.version} · ${data.enabledMappingCount}/${data.mappingCount} 映射 · 运行 ${formatUptime(data.uptime)}`;
    $('#metaInfo').textContent = `PID ${data.pid} · Node ${data.nodeVersion}`;
    return data;
  }

  // ==================== Mappings ====================

  function renderMappings() {
    const tbody = $('#mappingsBody');
    if (mappingsCache.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty">暂无同步映射，点击「新增映射」创建</td></tr>';
      return;
    }

    tbody.innerHTML = mappingsCache
      .map((m) => {
        const st = statusCache?.mappings?.[m.mappingId];
        const syncing = st?.isSyncing;
        const pending = st?.pendingSync;
        let syncBadge = '';
        if (syncing) syncBadge = '<span class="badge badge-sync">同步中</span>';
        else if (pending) syncBadge = '<span class="badge badge-sync">排队</span>';

        return `<tr data-id="${escapeHtml(m.mappingId)}">
          <td class="cell-id">${escapeHtml(m.mappingId)}</td>
          <td><span class="badge ${m.enabled ? 'badge-on' : 'badge-off'}">${m.enabled ? '启用' : '禁用'}</span></td>
          <td class="cell-path" title="${escapeHtml(m.localRoot)}">${escapeHtml(m.localRoot)}</td>
          <td class="cell-path" title="${escapeHtml(m.remoteRootFolderPath || '')}">${escapeHtml(m.remoteRootFolderPath || '—')}</td>
          <td>${syncDirectionLabel(m.syncDirection || statusCache?.config?.syncDirection)}</td>
          <td>${syncBadge || '—'}</td>
          <td class="actions">
            <button type="button" class="btn btn-sm btn-secondary btn-sync-one" ${!m.enabled ? 'disabled' : ''}>同步</button>
            <button type="button" class="btn btn-sm btn-secondary btn-edit">编辑</button>
            <button type="button" class="btn btn-sm btn-danger btn-delete">删除</button>
          </td>
        </tr>`;
      })
      .join('');

    tbody.querySelectorAll('.btn-sync-one').forEach((btn) => {
      btn.addEventListener('click', () => syncOne(btn.closest('tr').dataset.id));
    });
    tbody.querySelectorAll('.btn-edit').forEach((btn) => {
      btn.addEventListener('click', () => openMappingModal(btn.closest('tr').dataset.id));
    });
    tbody.querySelectorAll('.btn-delete').forEach((btn) => {
      btn.addEventListener('click', () => deleteMapping(btn.closest('tr').dataset.id));
    });
  }

  async function loadMappings() {
    const data = await api('GET', '/mappings');
    hasGlobalAppKey = data.hasGlobalAppKey;
    mappingsCache = data.mappings || [];
    renderMappings();
    updateGlobalAppKeyHint();
  }

  async function syncOne(id) {
    try {
      const data = await api('POST', `/sync/${encodeURIComponent(id)}`);
      toast(data.message, 'success');
      await refreshStatus();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function deleteMapping(id) {
    if (!confirm(`确定删除映射「${id}」？此操作不可撤销。`)) return;
    try {
      const data = await api('DELETE', `/mappings/${encodeURIComponent(id)}`);
      toast(data.message, 'success');
      await refreshAll();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  // ==================== Mapping modal ====================

  const modal = $('#mappingModal');
  const mappingForm = $('#mappingForm');

  function openMappingModal(id) {
    const isNew = !id;
    $('#mappingModalTitle').textContent = isNew ? '新增映射' : '编辑映射';
    mappingForm.reset();
    $('input[name="mode"]', mappingForm).value = isNew ? 'create' : 'edit';

    const idField = $('#fieldMappingId');
    idField.readOnly = !isNew;
    idField.required = !isNew;

    if (isNew) {
      idField.value = '';
      $('input[name="enabled"]', mappingForm).checked = true;
    } else {
      const m = mappingsCache.find((x) => x.mappingId === id);
      if (!m) return;
      idField.value = m.mappingId;
      $('input[name="enabled"]', mappingForm).checked = m.enabled;
      $('input[name="localRoot"]', mappingForm).value = m.localRoot || '';
      $('input[name="projectId"]', mappingForm).value = m.projectId || '';
      $('input[name="remoteRootFolderPath"]', mappingForm).value = m.remoteRootFolderPath || '';
      $('input[name="remoteRootFileId"]', mappingForm).value = m.remoteRootFileId || '';
      $('select[name="syncDirection"]', mappingForm).value = m.syncDirection || '';
      $('input[name="filePatterns"]', mappingForm).value =
        m.filePatterns ? JSON.stringify(m.filePatterns) : '';
      $('input[name="excludePatterns"]', mappingForm).value =
        m.excludePatterns ? JSON.stringify(m.excludePatterns) : '';
    }

    modal.showModal();
  }

  function closeMappingModal() {
    modal.close();
  }

  $('#btnAddMapping').addEventListener('click', () => openMappingModal(null));
  $('#btnCloseModal').addEventListener('click', closeMappingModal);
  $('#btnCancelModal').addEventListener('click', closeMappingModal);

  mappingForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(mappingForm);
    const mode = fd.get('mode');
    const mappingId = (fd.get('mappingId') || '').toString().trim();

    const body = {
      enabled: fd.get('enabled') === 'on',
      localRoot: (fd.get('localRoot') || '').toString().trim(),
    };

    const appKey = (fd.get('appKey') || '').toString().trim();
    if (appKey) body.appKey = appKey;

    const projectId = (fd.get('projectId') || '').toString().trim();
    if (projectId) body.projectId = projectId;

    const remotePath = (fd.get('remoteRootFolderPath') || '').toString();
    body.remoteRootFolderPath = remotePath.trim() || '';

    const remoteFileId = (fd.get('remoteRootFileId') || '').toString();
    body.remoteRootFileId = remoteFileId.trim() || '';

    const syncDir = (fd.get('syncDirection') || '').toString();
    if (syncDir) body.syncDirection = syncDir;

    try {
      const fp = parseJsonArray((fd.get('filePatterns') || '').toString());
      if (fp) body.filePatterns = fp;
      const ep = parseJsonArray((fd.get('excludePatterns') || '').toString());
      if (ep) body.excludePatterns = ep;
    } catch (err) {
      toast(err.message, 'error');
      return;
    }

    if (!hasGlobalAppKey && !appKey && mode === 'create') {
      toast('未配置全局 AppKey，请填写本条映射的 AppKey', 'error');
      return;
    }

    try {
      let data;
      if (mode === 'create') {
        if (mappingId) body.mappingId = mappingId;
        data = await api('POST', '/mappings', body);
      } else {
        data = await api('PUT', `/mappings/${encodeURIComponent(mappingId)}`, body);
      }
      toast(data.message + (data.warnings?.length ? ' · ' + data.warnings.join(' ') : ''), 'success');
      closeMappingModal();
      await refreshAll();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // ==================== Global config ====================

  function updateGlobalAppKeyHint() {
    const hint = $('#globalAppKeyHint');
    hint.textContent = hasGlobalAppKey
      ? '已配置全局 AppKey（输入新值可覆盖，留空不修改）'
      : '未配置全局 AppKey，新建映射时需单独填写 AppKey';
  }

  async function loadGlobalConfig() {
    const data = await api('GET', '/config');
    hasGlobalAppKey = data.hasGlobalAppKey;
    const form = $('#globalForm');
    const cfg = data.config;
    for (const [key, val] of Object.entries(cfg)) {
      const input = form.elements.namedItem(key);
      if (input && 'value' in input) input.value = val ?? '';
    }
    $('input[name="appKey"]', form).value = '';
    updateGlobalAppKeyHint();
  }

  $('#btnSaveGlobal').addEventListener('click', async () => {
    const form = $('#globalForm');
    const body = {};
    const fields = [
      'serverUrl', 'syncDirection', 'autoSyncIntervalSec', 'maxConcurrentMappings',
      'maxRequestsPerMinute', 'stateDbPath', 'downloadConcurrency', 'uploadConcurrency',
      'managementPort', 'managementHost',
    ];
    for (const name of fields) {
      const el = form.elements.namedItem(name);
      if (!el) continue;
      if (el.type === 'number') {
        body[name] = Number(el.value);
      } else {
        body[name] = el.value.trim();
      }
    }
    const appKey = form.elements.namedItem('appKey').value.trim();
    if (appKey) body.appKey = appKey;

    try {
      const data = await api('PUT', '/config', body);
      toast(data.message + (data.warnings?.length ? ' · ' + data.warnings[0] : ''), 'success');
      if (data.warnings?.length) toast(data.warnings.join(' '), 'info');
      hasGlobalAppKey = data.hasGlobalAppKey ?? hasGlobalAppKey;
      await loadGlobalConfig();
    } catch (e) {
      toast(e.message, 'error');
    }
  });

  // ==================== Status ====================

  function renderStatus() {
    const grid = $('#statusGrid');
    if (!statusCache?.mappings || Object.keys(statusCache.mappings).length === 0) {
      grid.innerHTML = '<p class="empty">暂无映射运行数据</p>';
      return;
    }

    grid.innerHTML = Object.entries(statusCache.mappings)
      .map(([id, st]) => {
        const ls = st.lastState || {};
        const lastErr = ls.lastError;
        return `<div class="status-card">
          <h4>${escapeHtml(id)}</h4>
          <dl>
            <dt>启用</dt><dd>${st.enabled ? '是' : '否'}</dd>
            <dt>同步中</dt><dd>${st.isSyncing ? '是' : '否'}</dd>
            <dt>排队</dt><dd>${st.pendingSync ? '是' : '否'}</dd>
            <dt>本地目录</dt><dd>${escapeHtml(st.localRoot || '—')}</dd>
            <dt>上次成功</dt><dd>${ls.lastSuccessAt ? new Date(ls.lastSuccessAt).toLocaleString() : '—'}</dd>
            <dt>上次错误</dt><dd>${lastErr ? escapeHtml(lastErr) : '—'}</dd>
          </dl>
          ${lastErr && !st.isSyncing ? `<div class="error">${escapeHtml(lastErr)}</div>` : ''}
        </div>`;
      })
      .join('');
  }

  async function refreshStatus() {
    statusCache = await api('GET', '/status');
    renderMappings();
    renderStatus();
  }

  async function refreshAll() {
    await Promise.all([loadHealth(), loadMappings(), loadGlobalConfig(), refreshStatus()]);
  }

  // ==================== Toolbar actions ====================

  $('#btnRefresh').addEventListener('click', async () => {
    try {
      await refreshAll();
      toast('已刷新', 'success');
    } catch (e) {
      toast(e.message, 'error');
    }
  });

  $('#btnReload').addEventListener('click', async () => {
    try {
      const data = await api('POST', '/reload');
      toast(data.message, 'success');
      await refreshAll();
    } catch (e) {
      toast(e.message, 'error');
    }
  });

  $('#btnSyncAll').addEventListener('click', async () => {
    try {
      const data = await api('POST', '/sync');
      toast(data.message, 'success');
      setTimeout(refreshStatus, 1000);
    } catch (e) {
      toast(e.message, 'error');
    }
  });

  // ==================== Init ====================

  refreshAll().catch((e) => {
    const badge = $('#healthBadge');
    badge.className = 'header-status err';
    badge.querySelector('.label').textContent = '无法连接服务';
    toast(e.message, 'error');
  });

  setInterval(() => {
    refreshStatus().catch(() => {});
  }, 15000);
})();
