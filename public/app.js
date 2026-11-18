'use strict';
/* 客户端模拟器 + 服务端看板 */

/* ---------------- 确定性随机（与服务端同算法） ---------------- */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SERVER_SEED = 20261118;
const CLIENT_SEED = 7;
const LS_KEY = 'tracker-sim-v1';

/* ---------------- 客户端模拟器状态 ---------------- */
const sim = {
  deviceId: 'device-A',
  sessionId: 'sess-1',
  nextSeq: 1,
  cache: [],        // {seq, name, ts, attempts, props}
  offline: false,
  auto: false,
  autoTimer: null,
  sending: false,
};
let batchSeq = 1;

const EVENT_NAMES = ['page_view', 'click', 'scroll', 'exposure', 'search', 'add_cart', 'purchase'];
const clientRng = mulberry32(Date.now() & 0xffffffff); // 交互模式用；回放用固定种子

function saveLocal() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      deviceId: sim.deviceId, sessionId: sim.sessionId,
      nextSeq: sim.nextSeq, cache: sim.cache,
    }));
  } catch (_) { /* 忽略 */ }
}
function loadLocal() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    if (d && Array.isArray(d.cache)) {
      sim.deviceId = d.deviceId || sim.deviceId;
      sim.sessionId = d.sessionId || sim.sessionId;
      sim.nextSeq = d.nextSeq || 1;
      sim.cache = d.cache;
    }
  } catch (_) { /* 忽略 */ }
}

/* ---------------- 小工具 ---------------- */
const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmtTime = ts => new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });

function clientLog(msg, kind = '') {
  const ul = $('clientLog');
  const li = document.createElement('li');
  if (kind) li.className = kind;
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = fmtTime(Date.now());
  li.append(t, document.createTextNode(msg));
  ul.prepend(li);
  while (ul.children.length > 120) ul.lastChild.remove();
}

/* ---------------- 事件生成与上报 ---------------- */
function genEvents(n, rng) {
  const r = rng || clientRng;
  for (let i = 0; i < n; i++) {
    sim.cache.push({
      seq: sim.nextSeq++,
      name: EVENT_NAMES[Math.floor(r() * EVENT_NAMES.length)],
      ts: Date.now(),
      attempts: 0,
      props: { page: '/p' + (1 + Math.floor(r() * 5)) },
    });
  }
  saveLocal();
  renderCacheHint();
}

function wireEvent(e) {
  return { seq: e.seq, name: e.name, ts: e.ts, attempt: e.attempts, props: e.props };
}

async function flushOnce(rngLabel) {
  if (sim.sending) return 'busy';
  if (sim.offline) return 'offline';
  if (!sim.cache.length) return 'empty';
  sim.sending = true;
  const batchSize = Math.max(1, Number($('batchSize').value) || 10);
  const batch = sim.cache.slice(0, batchSize);
  batch.forEach(e => e.attempts++);
  const retries = batch.filter(e => e.attempts > 1);
  if (retries.length) {
    clientLog(`补发 ${retries.length} 条（序号 ${retries.map(e => e.seq).join(',')}）`, 'retry');
  }
  const batchId = 'b' + (batchSeq++);
  try {
    const res = await fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: sim.deviceId, sessionId: sim.sessionId, batchId,
        events: batch.map(wireEvent),
      }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const acked = new Set(data.acked);
    sim.cache = sim.cache.filter(e => !acked.has(e.seq));
    const unacked = batch.filter(e => !acked.has(e.seq)).map(e => e.seq);
    if (unacked.length) {
      clientLog(`批次 ${batchId} 部分确认 ${acked.size}/${batch.length}，仅保留未确认序号重试：${unacked.join(',')}`, 'retry');
    } else {
      clientLog(`批次 ${batchId} 全部确认（${batch.length} 条），水位 ${data.watermark}`, 'ok');
    }
  } catch (err) {
    clientLog(`批次 ${batchId} 发送失败（${err.message}），整批 ${batch.length} 条保留待重试`, 'err');
  } finally {
    sim.sending = false;
    saveLocal();
    renderCacheHint();
    refresh();
  }
  return 'ok';
}

async function flushUntilEmpty(maxRounds = 80) {
  for (let i = 0; i < maxRounds && sim.cache.length && !sim.offline; i++) {
    await flushOnce();
    await sleep(60);
  }
  return sim.cache.length === 0;
}

function renderCacheHint() {
  $('cacheHint').textContent =
    `本地缓存 ${sim.cache.length} 条 · 下一序号 ${sim.nextSeq}` +
    (sim.offline ? ' · 离线中' : '');
  const bar = $('cacheBar');
  bar.textContent = '';
  const frag = document.createDocumentFragment();
  for (const e of sim.cache.slice(0, 200)) {
    const s = document.createElement('span');
    if (e.attempts > 0) s.className = 'retry';
    frag.append(s);
  }
  bar.append(frag);
}

/* ---------------- 看板数据 ---------------- */
async function refresh() {
  try {
    const res = await fetch('/api/stats');
    const data = await res.json();
    renderTiles(data.counters, data.sessions);
    renderSessions(data.sessions);
    renderOoo(data.oooHistogram);
    renderPending(data);
    renderDupTable(data);
    $('btnFlaky').textContent = '服务端故障：' + (data.config.flaky ? '开' : '关');
    $('btnFlaky').setAttribute('aria-pressed', String(data.config.flaky));
  } catch (_) { /* 服务未就绪时静默 */ }
}

function renderTiles(c, sessions) {
  const pendingTotal = sessions.reduce((a, s) => a + s.pendingCount, 0);
  const tiles = [
    ['接收事件', c.eventsReceived],
    ['已入库', c.stored],
    ['重复丢弃', c.duplicates],
    ['乱序进入待处理', c.outOfOrder],
    ['待处理中', pendingTotal],
    ['缺口补齐晋升', c.promoted],
    ['服务端拒绝', c.rejected],
    ['确认丢失批次', c.ackDroppedBatches],
  ];
  const box = $('tiles');
  box.textContent = '';
  for (const [label, value] of tiles) {
    const d = document.createElement('div');
    d.className = 'tile';
    const l = document.createElement('div'); l.className = 'label'; l.textContent = label;
    const v = document.createElement('div'); v.className = 'value'; v.textContent = value;
    d.append(l, v);
    box.append(d);
  }
}

/* ---------------- 悬浮提示 ---------------- */
const tooltip = $('tooltip');
function showTip(x, y, valueText, labelText) {
  tooltip.textContent = '';
  const v = document.createElement('div'); v.className = 'v'; v.textContent = valueText;
  const l = document.createElement('div'); l.textContent = labelText;
  tooltip.append(v, l);
  tooltip.hidden = false;
  const w = tooltip.offsetWidth, h = tooltip.offsetHeight;
  tooltip.style.left = Math.min(x + 12, innerWidth - w - 8) + 'px';
  tooltip.style.top = Math.max(y - h - 10, 8) + 'px';
}
function hideTip() { tooltip.hidden = true; }
function bindTip(el, valueText, labelText) {
  el.addEventListener('pointermove', ev => showTip(ev.clientX, ev.clientY, valueText, labelText));
  el.addEventListener('pointerleave', hideTip);
  el.addEventListener('focus', () => {
    const r = el.getBoundingClientRect();
    showTip(r.left + r.width / 2, r.top, valueText, labelText);
  });
  el.addEventListener('blur', hideTip);
}

/* ---------------- 会话卡片 + 序号条带 ---------------- */
const SVG_NS = 'http://www.w3.org/2000/svg';
const STATE_COLORS = {
  stored: 'var(--status-good)',
  pending: 'var(--status-warning)',
  missing: 'var(--baseline)',
};

function renderSessions(sessions) {
  const box = $('sessions');
  box.textContent = '';
  if (!sessions.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = '暂无会话，先在左侧生成并上报事件。';
    box.append(p);
    return;
  }
  for (const s of sessions) {
    const card = document.createElement('div');
    card.className = 'session';

    const head = document.createElement('div');
    head.className = 'session-head';
    const name = document.createElement('span'); name.className = 'name'; name.textContent = s.deviceId + ' / ' + s.sessionId;
    const wm = document.createElement('span'); wm.className = 'wm'; wm.textContent = s.watermark;
    const meta = document.createElement('span'); meta.className = 'meta';
    meta.textContent = `水位 · 已入库 ${s.storedCount} · 最大序号 ${s.maxSeqSeen} · 待处理 ${s.pendingCount} · 重复 ${s.duplicates}`;
    head.append(name, wm, meta);

    const legend = document.createElement('div');
    legend.className = 'legend';
    for (const [label, color] of [['已入库', STATE_COLORS.stored], ['待处理', STATE_COLORS.pending], ['缺失（缺口）', STATE_COLORS.missing]]) {
      const k = document.createElement('span'); k.className = 'key';
      const sw = document.createElement('span'); sw.className = 'swatch'; sw.style.background = color;
      const tx = document.createElement('span'); tx.textContent = label;
      k.append(sw, tx);
      legend.append(k);
    }

    const strip = document.createElement('div');
    strip.className = 'strip';
    strip.append(buildStrip(s));

    card.append(head, legend, strip);
    box.append(card);
  }
}

function buildStrip(s) {
  const pendingSet = new Map(s.pending.map(p => [p.seq, p]));
  const maxSeq = Math.max(s.maxSeqSeen, s.watermark, 1);
  const CAP = 400;
  const from = maxSeq > CAP ? Math.max(1, s.watermark - 100) : 1;
  const to = Math.min(maxSeq, from + CAP - 1);
  const cell = 12, gap = 2, pitch = cell + gap, perRow = 40;
  const rows = Math.ceil((to - from + 1) / perRow);
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${perRow * pitch - gap} ${rows * pitch - gap}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `会话 ${s.key} 序号条带，水位 ${s.watermark}`);
  for (let seq = from; seq <= to; seq++) {
    const i = seq - from;
    const state = seq <= s.watermark ? 'stored' : (pendingSet.has(seq) ? 'pending' : 'missing');
    const r = document.createElementNS(SVG_NS, 'rect');
    r.setAttribute('x', (i % perRow) * pitch);
    r.setAttribute('y', Math.floor(i / perRow) * pitch);
    r.setAttribute('width', cell);
    r.setAttribute('height', cell);
    r.setAttribute('rx', 2);
    r.setAttribute('fill', STATE_COLORS[state]);
    r.setAttribute('tabindex', '0');
    const label = state === 'stored' ? '已入库'
      : state === 'pending' ? '待处理：' + pendingSet.get(seq).reason
      : '缺失（尚未到达）';
    r.setAttribute('aria-label', `序号 ${seq}，${label}`);
    bindTip(r, `序号 ${seq}`, label);
    svg.append(r);
  }
  return svg;
}

/* ---------------- 乱序直方图 ---------------- */
function renderOoo(buckets) {
  const box = $('oooChart');
  box.textContent = '';
  const W = 420, H = 180, top = 16, bottom = 150, left = 36;
  const maxV = Math.max(1, ...buckets.map(b => b.count));
  const nice = niceMax(maxV);
  const slot = (W - left - 8) / buckets.length;
  const barW = Math.min(24, slot - 8);

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', '乱序缺口长度直方图');
  svg.classList.add('chart');

  // 网格线与 Y 轴刻度
  const axis = document.createElementNS(SVG_NS, 'g');
  axis.setAttribute('class', 'axis');
  for (let i = 0; i <= 2; i++) {
    const v = Math.round(nice * i / 2);
    const y = bottom - (v / nice) * (bottom - top);
    const gl = document.createElementNS(SVG_NS, 'line');
    gl.setAttribute('x1', left); gl.setAttribute('x2', W - 8);
    gl.setAttribute('y1', y); gl.setAttribute('y2', y);
    gl.setAttribute('class', i === 0 ? '' : 'gridline');
    if (i === 0) gl.setAttribute('stroke', 'var(--baseline)');
    const tx = document.createElementNS(SVG_NS, 'text');
    tx.setAttribute('x', left - 6); tx.setAttribute('y', y + 3);
    tx.setAttribute('text-anchor', 'end');
    tx.textContent = v;
    axis.append(gl, tx);
  }
  svg.append(axis);

  const maxCount = Math.max(...buckets.map(b => b.count));
  buckets.forEach((b, i) => {
    const h = b.count / nice * (bottom - top);
    const x = left + i * slot + (slot - barW) / 2;
    const y = bottom - h;
    const g = document.createElementNS(SVG_NS, 'g');
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', x);
    rect.setAttribute('y', b.count ? y : bottom - 1);
    rect.setAttribute('width', barW);
    rect.setAttribute('height', Math.max(1, h));
    rect.setAttribute('rx', b.count ? 4 : 0);
    rect.setAttribute('fill', 'var(--series-1)');
    rect.setAttribute('class', 'bar');
    rect.setAttribute('tabindex', '0');
    rect.setAttribute('aria-label', `缺口 ${b.label}，${b.count} 次`);
    bindTip(rect, `${b.count} 次`, `乱序缺口长度 ${b.label}`);
    g.append(rect);
    // 只给最高的柱加数值标签（选择性标注）
    if (b.count > 0 && b.count === maxCount) {
      const cap = document.createElementNS(SVG_NS, 'text');
      cap.setAttribute('x', x + barW / 2);
      cap.setAttribute('y', y - 5);
      cap.setAttribute('text-anchor', 'middle');
      cap.setAttribute('fill', 'var(--text-secondary)');
      cap.setAttribute('font-size', '11');
      cap.textContent = b.count;
      g.append(cap);
    }
    const xl = document.createElementNS(SVG_NS, 'text');
    xl.setAttribute('x', left + i * slot + slot / 2);
    xl.setAttribute('y', bottom + 14);
    xl.setAttribute('text-anchor', 'middle');
    xl.setAttribute('fill', 'var(--text-muted)');
    xl.setAttribute('font-size', '10');
    xl.textContent = b.label;
    g.append(xl);
    svg.append(g);
  });
  box.append(svg);

  // 表格视图（可访问性）
  const table = $('oooTable');
  table.textContent = '';
  const head = document.createElement('tr');
  for (const t of ['缺口长度', '次数']) {
    const th = document.createElement('th'); th.textContent = t; head.append(th);
  }
  table.append(head);
  for (const b of buckets) {
    const tr = document.createElement('tr');
    const a = document.createElement('td'); a.textContent = b.label;
    const c = document.createElement('td'); c.textContent = b.count;
    tr.append(a, c);
    table.append(tr);
  }
}

function niceMax(v) {
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (m * pow >= v) return m * pow;
  }
  return 10 * pow;
}

/* ---------------- 待处理区 / 日志表 ---------------- */
function renderPending(data) {
  const box = $('pendingArea');
  box.textContent = '';
  const items = data.sessions.flatMap(s =>
    s.pending.map(p => ({ session: s.key, ...p })));
  if (!items.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = '待处理区为空。';
    box.append(p);
  } else {
    for (const it of items.sort((a, b) => a.seq - b.seq)) {
      const d = document.createElement('div');
      d.className = 'pending-item';
      const seq = document.createElement('span'); seq.className = 'seq'; seq.textContent = '#' + it.seq;
      const reason = document.createElement('span'); reason.textContent = `${it.reason} · ${it.session} · ${fmtTime(it.arrivedAt)}`;
      d.append(seq, reason);
      box.append(d);
    }
  }
  const ul = $('promotedLog');
  ul.textContent = '';
  for (const p of data.pendingLog.filter(x => x.resolved).slice(0, 30)) {
    const li = document.createElement('li');
    li.className = 'ok';
    const t = document.createElement('span'); t.className = 't'; t.textContent = fmtTime(p.ts);
    li.append(t, document.createTextNode(`序号 ${p.seq} ${p.reason}（${p.session}）`));
    ul.append(li);
  }
}

function renderDupTable(data) {
  const rows = [
    ...data.dupLog.map(d => ({ ts: d.ts, type: '重复丢弃', seq: d.seq, detail: d.where, session: d.session })),
    ...data.retryLog.map(r => ({ ts: r.ts, type: '补发接收', seq: r.seq, detail: `第 ${r.attempt} 次尝试`, session: r.session })),
  ].sort((a, b) => b.ts - a.ts).slice(0, 40);
  const table = $('dupTable');
  table.textContent = '';
  const head = document.createElement('tr');
  for (const t of ['时间', '类型', '会话', '序号', '说明']) {
    const th = document.createElement('th'); th.textContent = t; head.append(th);
  }
  table.append(head);
  for (const r of rows) {
    const tr = document.createElement('tr');
    for (const v of [fmtTime(r.ts), r.type, r.session, r.seq, r.detail]) {
      const td = document.createElement('td'); td.textContent = v; tr.append(td);
    }
    table.append(tr);
  }
}

/* ---------------- 一键回放 ---------------- */
async function runReplay() {
  const btn = $('btnReplay');
  btn.disabled = true;
  const out = $('replayResult');
  out.textContent = '';
  const hashes = [];
  const ROUNDS = 3;
  try {
    for (let round = 1; round <= ROUNDS; round++) {
      // 重置服务端（固定种子）与客户端
      await postJson('/api/reset', { seed: SERVER_SEED });
      clientReset(false);
      const rng = mulberry32(CLIENT_SEED);

      // 剧本：正常 → 断网缓存 → 重连补发 → 故障重试 → 恢复收尾
      genEvents(30, rng);
      await flushUntilEmpty();

      sim.offline = true;
      genEvents(25, rng);
      await flushUntilEmpty();          // 离线中不发送
      sim.offline = false;
      await flushUntilEmpty();          // 重连后补发缓存

      await postJson('/api/config', { flaky: true, rejectRate: 0.35, ackDropRate: 0.25 });
      genEvents(45, rng);
      await flushUntilEmpty(120);       // 部分确认 → 仅重试未确认；确认丢失 → 触发去重
      await postJson('/api/config', { flaky: false });
      await flushUntilEmpty();

      const v = await (await fetch('/api/verify')).json();
      hashes.push(v.hash);
      const div = document.createElement('div');
      div.className = 'round';
      const fields = [
        `第 ${round} 轮`, `哈希 ${v.hash}`, `水位 ${v.sessions.map(s => s.watermark).join('/') || 0}`,
        `入库 ${v.counters.stored}`, `重复 ${v.counters.duplicates}`,
        `乱序 ${v.counters.outOfOrder}`, `晋升 ${v.counters.promoted}`,
        `一致性 ${v.allConsistent ? '✓' : '✗'}`,
      ];
      for (const f of fields) {
        const c = document.createElement('code'); c.textContent = f; div.append(c);
      }
      out.append(div);
    }
    const stable = hashes.every(h => h === hashes[0]);
    const verdict = document.createElement('div');
    verdict.className = 'verdict ' + (stable ? 'ok' : 'bad');
    verdict.textContent = stable
      ? `✓ ${ROUNDS} 轮回放最终状态完全一致（哈希 ${hashes[0]}），结果稳定`
      : `✗ 各轮哈希不一致：${hashes.join(' / ')}`;
    out.append(verdict);
    clientLog(stable ? `回放完成：${ROUNDS} 轮哈希一致 ${hashes[0]}` : '回放结果不一致！', stable ? 'ok' : 'err');
  } catch (err) {
    clientLog('回放失败：' + err.message, 'err');
  } finally {
    btn.disabled = false;
    refresh();
  }
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

function clientReset(clearStorage = true) {
  sim.nextSeq = 1;
  sim.cache = [];
  sim.offline = false;
  sim.deviceId = $('deviceId').value.trim() || 'device-A';
  sim.sessionId = $('sessionId').value.trim() || 'sess-1';
  if (clearStorage) {
    try { localStorage.removeItem(LS_KEY); } catch (_) { /* 忽略 */ }
  }
  saveLocal();
  renderCacheHint();
  updateOfflineBtn();
}

/* ---------------- 控件 ---------------- */
function updateOfflineBtn() {
  $('btnOffline').textContent = sim.offline ? '网络：离线（点击重连）' : '网络：在线';
  $('btnOffline').setAttribute('aria-pressed', String(sim.offline));
  renderCacheHint();
}

function bindControls() {
  $('deviceId').addEventListener('change', () => { sim.deviceId = $('deviceId').value.trim() || 'device-A'; saveLocal(); });
  $('sessionId').addEventListener('change', () => { sim.sessionId = $('sessionId').value.trim() || 'sess-1'; saveLocal(); });
  $('btnGen').addEventListener('click', () => {
    genEvents(Math.max(1, Number($('genCount').value) || 10));
    clientLog(`生成 ${Number($('genCount').value) || 10} 条事件进入本地缓存`);
  });
  $('btnFlush').addEventListener('click', () => flushUntilEmpty(30));
  $('btnOffline').addEventListener('click', () => {
    sim.offline = !sim.offline;
    updateOfflineBtn();
    clientLog(sim.offline ? '网络断开，事件将缓存在本地' : '网络恢复，开始补发缓存', sim.offline ? 'err' : 'ok');
    if (!sim.offline) flushUntilEmpty(60);
  });
  $('btnFlaky').addEventListener('click', async () => {
    const on = $('btnFlaky').getAttribute('aria-pressed') !== 'true';
    await postJson('/api/config', { flaky: on });
    clientLog('服务端故障模式：' + (on ? '开（随机拒绝 + 确认丢失）' : '关'), on ? 'err' : 'ok');
    refresh();
  });
  $('btnAuto').addEventListener('click', () => {
    sim.auto = !sim.auto;
    $('btnAuto').textContent = '自动产生：' + (sim.auto ? '开' : '关');
    $('btnAuto').setAttribute('aria-pressed', String(sim.auto));
    if (sim.auto) {
      sim.autoTimer = setInterval(() => {
        genEvents(1 + Math.floor(clientRng() * 3));
        flushOnce();
      }, 1500);
    } else {
      clearInterval(sim.autoTimer);
    }
  });
  $('btnReset').addEventListener('click', async () => {
    await postJson('/api/reset', { seed: SERVER_SEED });
    clientReset();
    clientLog('已重置服务端与客户端状态');
    refresh();
  });
  $('btnReplay').addEventListener('click', runReplay);
  $('themeToggle').addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme');
    document.documentElement.setAttribute('data-theme', cur === 'dark' ? 'light' : 'dark');
  });
}

/* ---------------- 启动 ---------------- */
loadLocal();
$('deviceId').value = sim.deviceId;
$('sessionId').value = sim.sessionId;
bindControls();
renderCacheHint();
refresh();
setInterval(refresh, 1500);
