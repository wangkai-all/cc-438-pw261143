'use strict';
/* 端到端自测：去重 / 乱序待处理 / 部分确认重试 / 确认丢失 / 回放稳定性 */
const assert = require('node:assert/strict');
const { createServer, mulberry32 } = require('../server.js');

const SERVER_SEED = 20261118;
const CLIENT_SEED = 7;

let base;

async function post(path, body, expectOk = true) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (expectOk) assert.equal(res.status, 200, `${path} -> ${res.status}`);
  return { status: res.status, body: await res.json() };
}
const get = async path => (await fetch(base + path)).json();

const ev = (seq, attempt = 1) => ({ seq, name: 'click', ts: 1700000000000 + seq, attempt });
const batch = (seqs, opts = {}) => ({
  deviceId: 'dev-t', sessionId: 'sess-t',
  events: seqs.map(s => ev(s, opts.attempt || 1)),
});

async function reset() { await post('/api/reset', { seed: SERVER_SEED }); }
async function setConfig(c) { await post('/api/config', c); }

/* 简易客户端：模拟“只重试未确认部分” */
async function sendAndRetry(events, maxRounds = 60) {
  let pending = events.map(e => ({ ...e, attempts: 0 }));
  let retries = 0;
  for (let round = 0; round < maxRounds && pending.length; round++) {
    const slice = pending.slice(0, 10);
    slice.forEach(e => e.attempts++);
    const res = await fetch(base + '/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'dev-t', sessionId: 'sess-t', events: slice }),
    });
    if (!res.ok) { retries++; continue; } // 确认丢失：整批保留
    const { acked } = await res.json();
    const ackedSet = new Set(acked);
    const unacked = slice.filter(e => !ackedSet.has(e.seq));
    if (unacked.length) retries++;
    // 关键断言：未确认的一定是 rejected 之外的；客户端只保留未确认部分
    pending = [...unacked, ...pending.slice(10)];
  }
  assert.equal(pending.length, 0, '所有事件最终都应被确认');
  return retries;
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('顺序批次全部入库，水位推进', async () => {
  await reset();
  const { body } = await post('/api/events', batch([1, 2, 3, 4, 5]));
  assert.deepEqual(body.acked, [1, 2, 3, 4, 5]);
  assert.equal(body.watermark, 5);
  const st = await get('/api/stats');
  assert.equal(st.counters.stored, 5);
  assert.equal(st.counters.outOfOrder, 0);
});

test('乱序事件进入待处理区并保留原因，缺口补齐后自动晋升', async () => {
  await reset();
  let r = await post('/api/events', batch([1, 2, 4, 5, 8]));
  assert.equal(body2status(r.body, 4), 'pending');
  assert.equal(body2status(r.body, 8), 'pending');
  const reason4 = r.body.results.find(x => x.seq === 4).reason;
  assert.match(reason4, /缺口 1 个/); // 等 3 来了 4
  let st = await get('/api/stats');
  assert.equal(st.sessions[0].pendingCount, 3);
  assert.equal(st.sessions[0].watermark, 2);

  r = await post('/api/events', batch([3]));
  assert.equal(body2status(r.body, 3), 'stored');
  st = await get('/api/stats');
  assert.equal(st.sessions[0].watermark, 5, '3 到达后 4、5 应晋升');
  assert.equal(st.counters.promoted, 2);
  assert.equal(st.sessions[0].pendingCount, 1, '8 仍在等 6、7');

  await post('/api/events', batch([6, 7]));
  st = await get('/api/stats');
  assert.equal(st.sessions[0].watermark, 8);
  assert.equal(st.sessions[0].pendingCount, 0);
});

test('重复事件被丢弃并计数，但仍返回确认（幂等）', async () => {
  await reset();
  await post('/api/events', batch([1, 2, 3]));
  const { body } = await post('/api/events', batch([2, 3, 4]));
  assert.equal(body2status(body, 2), 'duplicate');
  assert.equal(body2status(body, 3), 'duplicate');
  assert.equal(body2status(body, 4), 'stored');
  assert.deepEqual(body.acked, [2, 3, 4], '重复也要确认，客户端不应再重试');
  const st = await get('/api/stats');
  assert.equal(st.counters.duplicates, 2);
  assert.equal(st.counters.stored, 4);
});

test('故障拒绝 → 部分确认 → 只重试未确认部分，最终全部入库', async () => {
  await reset();
  await setConfig({ flaky: true, rejectRate: 0.5, ackDropRate: 0 });
  const events = Array.from({ length: 30 }, (_, i) => ev(i + 1));
  const retries = await sendAndRetry(events);
  assert.ok(retries > 0, '应当发生过重试');
  await setConfig({ flaky: false });
  const st = await get('/api/stats');
  assert.equal(st.sessions[0].watermark, 30);
  assert.equal(st.sessions[0].storedCount, 30);
  assert.equal(st.counters.rejected > 0, true);
  const v = await get('/api/verify');
  assert.equal(v.allConsistent, true);
});

test('确认丢失（500）→ 客户端重试 → 服务端去重，状态不重复入库', async () => {
  await reset();
  await setConfig({ flaky: true, rejectRate: 0, ackDropRate: 1 }); // 每批都丢确认
  const res = await fetch(base + '/api/events', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(batch([1, 2, 3])),
  });
  assert.equal(res.status, 500, '确认丢失应表现为请求失败');
  await setConfig({ flaky: false });
  const { body } = await post('/api/events', batch([1, 2, 3], { attempt: 2 }));
  assert.deepEqual(body.results.map(r => r.status), ['duplicate', 'duplicate', 'duplicate']);
  const st = await get('/api/stats');
  assert.equal(st.counters.stored, 3, '不能因重试重复入库');
  assert.equal(st.counters.duplicates, 3);
  assert.equal(st.counters.ackDroppedBatches, 1);
});

test('一键回放剧本：3 轮最终状态哈希完全一致', async () => {
  const hashes = [];
  for (let round = 0; round < 3; round++) {
    await reset();
    const rng = mulberry32(CLIENT_SEED);
    const gen = n => Array.from({ length: n }, () => null); // 占位，序号由发送器维护
    let seq = 1;
    const take = n => Array.from({ length: n }, () => ev(seq++));
    let cache = [];
    const flush = async () => {
      for (let i = 0; i < 120 && cache.length; i++) {
        const slice = cache.slice(0, 10);
        const res = await fetch(base + '/api/events', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceId: 'dev-t', sessionId: 'sess-t', events: slice }),
        });
        if (!res.ok) continue;
        const { acked } = await res.json();
        const s = new Set(acked);
        cache = cache.filter(e => !s.has(e.seq));
      }
      assert.equal(cache.length, 0);
    };
    cache.push(...take(30)); await flush();                       // 正常
    cache.push(...take(25));                                      // “离线”累积
    await flush();                                                // 重连补发
    await setConfig({ flaky: true, rejectRate: 0.35, ackDropRate: 0.25 });
    cache.push(...take(45)); await flush();                       // 故障重试
    await setConfig({ flaky: false });
    await flush();
    const v = await get('/api/verify');
    assert.equal(v.allConsistent, true);
    hashes.push(v.hash);
  }
  assert.equal(hashes[0], hashes[1]);
  assert.equal(hashes[1], hashes[2]);
  console.log('  回放哈希:', hashes[0]);
});

function body2status(body, seq) {
  return body.results.find(r => r.seq === seq).status;
}

(async () => {
  const server = createServer(SERVER_SEED);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log('✓', name);
    } catch (err) {
      failed++;
      console.error('✗', name);
      console.error(' ', err.message);
    }
  }
  server.close();
  if (failed) { console.error(`\n${failed} 个测试失败`); process.exit(1); }
  console.log(`\n全部 ${tests.length} 个测试通过`);
})();
