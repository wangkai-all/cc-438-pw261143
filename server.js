'use strict';
/**
 * 浏览器埋点接收服务（零依赖）
 *
 * 核心语义：
 * - 按 (deviceId, sessionId, seq) 去重，重复事件直接丢弃但仍返回确认（幂等）
 * - 每个会话维护连续接收水位 watermark：只有 seq === watermark + 1 才能入库
 * - 乱序事件（seq 超前）进入待处理区并保留原因；缺口补齐后自动晋升
 * - 批次级部分确认：响应里只 ack 已受理的事件，客户端只能重试未确认部分
 * - 故障模拟（确定性随机，种子可重置）：
 *     rejectRate   单条事件被拒绝（不入库、不确认）→ 客户端稍后重试
 *     ackDropRate  整批已提交但响应丢失（HTTP 500）→ 客户端重试 → 触发服务端去重
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_LOG = 300;
const DEFAULT_SEED = 20261118;

/* ---------------- 确定性工具 ---------------- */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/* ---------------- 状态 ---------------- */

function createStore(seed) {
  return {
    seed,
    rng: mulberry32(seed),
    config: { flaky: false, rejectRate: 0.35, ackDropRate: 0.25 },
    sessions: new Map(), // key = deviceId|sessionId
    counters: {
      batches: 0,          // 收到的批次数
      eventsReceived: 0,   // 收到的事件总条数（含重复）
      stored: 0,           // 实际入库条数（含待处理区晋升）
      duplicates: 0,       // 重复丢弃条数
      outOfOrder: 0,       // 进入待处理区的乱序条数
      promoted: 0,         // 缺口补齐后晋升条数
      rejected: 0,         // 故障模拟拒绝条数
      ackDroppedBatches: 0,// 已提交但响应丢失的批次数
    },
    oooDistances: [], // 每次乱序的缺口长度（直方图数据）
    dupLog: [],       // {ts, session, seq, where}
    pendingLog: [],   // {ts, session, seq, reason, resolved}
    retryLog: [],     // {ts, session, seq, attempt} 服务端观察到的补发
  };
}

function getSession(store, deviceId, sessionId) {
  const key = deviceId + '|' + sessionId;
  let s = store.sessions.get(key);
  if (!s) {
    s = {
      key, deviceId, sessionId,
      watermark: 0, storedCount: 0, maxSeqSeen: 0,
      pending: new Map(), // seq -> {seq, reason, arrivedAt, event}
      duplicates: 0, promoted: 0,
    };
    store.sessions.set(key, s);
  }
  return s;
}

function pushLog(arr, item) {
  arr.push(item);
  if (arr.length > MAX_LOG) arr.splice(0, arr.length - MAX_LOG);
}

function drainPending(store, sess) {
  let n = 0;
  while (sess.pending.has(sess.watermark + 1)) {
    const next = sess.watermark + 1;
    sess.pending.delete(next);
    sess.watermark = next;
    sess.storedCount++;
    store.counters.stored++;
    store.counters.promoted++;
    sess.promoted++;
    n++;
    pushLog(store.pendingLog, {
      ts: Date.now(), session: sess.key, seq: next,
      reason: '缺口补齐，从待处理区晋升入库', resolved: true,
    });
  }
  return n;
}

function ingestOne(store, sess, ev) {
  const seq = ev && ev.seq;
  if (!Number.isInteger(seq) || seq < 1) {
    store.counters.rejected++;
    return { seq, status: 'rejected', reason: '非法事件序号' };
  }
  if (Number.isInteger(ev.attempt) && ev.attempt > 1) {
    pushLog(store.retryLog, { ts: Date.now(), session: sess.key, seq, attempt: ev.attempt });
  }
  sess.maxSeqSeen = Math.max(sess.maxSeqSeen, seq);

  // 已入库（stored 恒等于 1..watermark，故 seq <= watermark 即已入库）
  if (seq <= sess.watermark) {
    store.counters.duplicates++; sess.duplicates++;
    pushLog(store.dupLog, { ts: Date.now(), session: sess.key, seq, where: '已入库，丢弃' });
    return { seq, status: 'duplicate', reason: '序号已入库' };
  }
  // 已在待处理区
  if (sess.pending.has(seq)) {
    store.counters.duplicates++; sess.duplicates++;
    pushLog(store.dupLog, { ts: Date.now(), session: sess.key, seq, where: '已在待处理区，丢弃' });
    return { seq, status: 'duplicate', reason: '序号已在待处理区' };
  }
  // 恰好是下一条 → 入库并尝试晋升待处理区
  if (seq === sess.watermark + 1) {
    sess.watermark = seq;
    sess.storedCount++;
    store.counters.stored++;
    const promoted = drainPending(store, sess);
    return { seq, status: 'stored', promoted };
  }
  // 超前 → 乱序，进入待处理区并保留原因
  const gap = seq - sess.watermark - 1;
  const reason = `缺口 ${gap} 个：当前水位 ${sess.watermark}，等待序号 ${sess.watermark + 1}`;
  sess.pending.set(seq, { seq, reason, arrivedAt: Date.now(), event: ev });
  store.counters.outOfOrder++;
  store.oooDistances.push(gap);
  pushLog(store.pendingLog, { ts: Date.now(), session: sess.key, seq, reason, resolved: false });
  return { seq, status: 'pending', reason };
}

function ingestBatch(store, body) {
  const deviceId = String(body.deviceId || '');
  const sessionId = String(body.sessionId || '');
  const events = Array.isArray(body.events) ? body.events : [];
  const sess = getSession(store, deviceId, sessionId);
  store.counters.batches++;

  // 整批“确认丢失”：照常处理，但最后返回 500，客户端只能重试
  const dropAck = store.config.flaky && events.length > 0 &&
    store.rng() < store.config.ackDropRate;

  const results = [];
  for (const ev of events) {
    store.counters.eventsReceived++;
    if (store.config.flaky && store.rng() < store.config.rejectRate) {
      store.counters.rejected++;
      results.push({ seq: ev && ev.seq, status: 'rejected', reason: '服务端模拟故障，未受理' });
      continue;
    }
    results.push(ingestOne(store, sess, ev));
  }
  if (dropAck) store.counters.ackDroppedBatches++;

  const acked = dropAck ? [] : results.filter(r => r.status !== 'rejected').map(r => r.seq);
  return { dropAck, results, acked, watermark: sess.watermark };
}

/* ---------------- 快照与校验 ---------------- */

function snapshot(store) {
  const sessions = [...store.sessions.values()].map(s => ({
    key: s.key,
    deviceId: s.deviceId,
    sessionId: s.sessionId,
    watermark: s.watermark,
    storedCount: s.storedCount,
    maxSeqSeen: s.maxSeqSeen,
    pendingCount: s.pending.size,
    duplicates: s.duplicates,
    promoted: s.promoted,
    pending: [...s.pending.values()]
      .map(p => ({ seq: p.seq, reason: p.reason, arrivedAt: p.arrivedAt }))
      .sort((a, b) => a.seq - b.seq),
  }));
  const bucketDefs = [['1', 1, 1], ['2', 2, 2], ['3', 3, 3], ['4', 4, 4], ['5', 5, 5], ['6-10', 6, 10], ['11+', 11, Infinity]];
  const oooHistogram = bucketDefs.map(([label, lo, hi]) => ({
    label, count: store.oooDistances.filter(d => d >= lo && d <= hi).length,
  }));
  const tail = a => a.slice(-80).reverse();
  return {
    seed: store.seed,
    config: store.config,
    counters: store.counters,
    sessions,
    oooHistogram,
    dupLog: tail(store.dupLog),
    pendingLog: tail(store.pendingLog),
    retryLog: tail(store.retryLog),
  };
}

function verifyStore(store) {
  const sessions = [...store.sessions.values()].map(s => ({
    key: s.key,
    watermark: s.watermark,
    storedCount: s.storedCount,
    pendingCount: s.pending.size,
    duplicates: s.duplicates,
    promoted: s.promoted,
    consistent: s.storedCount === s.watermark, // 入库必须连续无缺口
  }));
  // 哈希只覆盖确定性内容（水位/计数/乱序序列），不含时间戳
  const payload = JSON.stringify({
    sessions, counters: store.counters, ooo: store.oooDistances,
  });
  return {
    hash: fnv1a(payload),
    sessions,
    counters: store.counters,
    allConsistent: sessions.every(s => s.consistent),
  };
}

/* ---------------- HTTP 层 ---------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

function createServer(seed = DEFAULT_SEED) {
  const ref = { store: createStore(seed) };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/api/events' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}');
        if (!body.deviceId || !body.sessionId || !Array.isArray(body.events) ||
            body.events.length === 0 || body.events.length > 500) {
          sendJson(res, 400, { error: '需要 deviceId、sessionId 和 1..500 条 events' });
          return;
        }
        const out = ingestBatch(ref.store, body);
        if (out.dropAck) {
          // 已提交，但模拟响应丢失
          sendJson(res, 500, { error: 'simulated ack loss（批次已提交，确认丢失）' });
          return;
        }
        sendJson(res, 200, {
          batchId: body.batchId || null,
          acked: out.acked,
          results: out.results,
          watermark: out.watermark,
        });
        return;
      }
      if (url.pathname === '/api/stats' && req.method === 'GET') {
        sendJson(res, 200, snapshot(ref.store));
        return;
      }
      if (url.pathname === '/api/verify' && req.method === 'GET') {
        sendJson(res, 200, verifyStore(ref.store));
        return;
      }
      if (url.pathname === '/api/reset' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}');
        ref.store = createStore(Number.isInteger(body.seed) ? body.seed : DEFAULT_SEED);
        sendJson(res, 200, { ok: true, seed: ref.store.seed });
        return;
      }
      if (url.pathname === '/api/config' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}');
        const c = ref.store.config;
        if (typeof body.flaky === 'boolean') c.flaky = body.flaky;
        if (typeof body.rejectRate === 'number') c.rejectRate = Math.min(1, Math.max(0, body.rejectRate));
        if (typeof body.ackDropRate === 'number') c.ackDropRate = Math.min(1, Math.max(0, body.ackDropRate));
        sendJson(res, 200, { ok: true, config: c });
        return;
      }
      if (req.method === 'GET') { serveStatic(res, url.pathname); return; }
      sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      sendJson(res, 400, { error: String(err && err.message || err) });
    }
  });
  server.getStore = () => ref.store; // 便于测试
  return server;
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  createServer().listen(port, () => {
    console.log(`埋点接收服务已启动: http://localhost:${port}`);
  });
}

module.exports = { createServer, createStore, ingestBatch, verifyStore, snapshot, mulberry32, fnv1a, DEFAULT_SEED };
