'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createService } = require('../src/plugin/index.js');
const { harness, response, session, page } = require('./helpers');

const STATE = 'opencode.plugin.state.v1';
const CACHE = 'opencode.plugin.cache.v1';
const active = h => h.service.source({ category: 'opencode', item: 'active_session' });

function setConnected(h, extra = {}) {
  h.storage.values.set(STATE, {
    url: 'http://localhost:4096', username: 'opencode', password: 'pässword', version: '2.2.1',
    mode: 'default_chat', directory: '/workspace', selected: null, lastSessionID: null, nicknames: {}, cache_generation: 'gen', ...extra
  });
}

function countCacheReads(h) {
  const counter = { count: 0 };
  const original = h.storage.getItem.bind(h.storage);
  h.storage.getItem = async key => {
    const value = await original(key);
    if (key === CACHE) counter.count += 1;
    return value;
  };
  return counter;
}

function readCache(h) {
  const raw = h.storage.values.get(CACHE);
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

function writeCache(h, cache) {
  h.storage.values.set(CACHE, JSON.stringify(cache));
}

function addFreshReplyRoutes(h, ids) {
  ids.forEach((id, index) => h.route('GET', req => req.path === `/api/session/${id}/message`, response({
    data: [{ id: `msg_fresh_${index}`, type: 'assistant', time: { created: 900, completed: 1000 }, content: [{ type: 'text', text: `fresh ${index}` }] }], cursor: { next: null }
  })));
}

function addActiveRoutes(h, count = 20) {
  for (let index = 0; index < count; index += 1) h.route('GET', '/api/session/active', response({ data: {} }));
}

async function populateWarmReplies(h, ids) {
  const rows = ids.map(id => session(id, id, { time: { created: 1, updated: 1005 } }));
  setConnected(h, { reply_count: ids.length, selected: { session_id: ids[0], title: ids[0] } });
  h.route('GET', '/api/session', response(page(rows)));
  ids.forEach((id, index) => h.route('GET', req => req.path === `/api/session/${id}/message`, response({
    data: [{ id: `msg_${id}`, type: 'assistant', time: { created: 900, completed: 1000 }, content: [{ type: 'text', text: `reply ${index}` }] }], cursor: { next: null }
  })));
  await h.service.source({ category: 'opencode', item: 'replies' });
  const cache = readCache(h);
  cache.entries['active-map'] = { expires: 1700000060000, written: 1700000000000, value: { ids: [] } };
  writeCache(h, cache);
  return { rows, cache };
}

test('active snapshot shares in-flight scan within one plugin instance', async () => {
  const h = harness();
  setConnected(h);
  let count = 0;
  h.route('GET', '/api/session/active', async () => {
    count += 1;
    await new Promise(resolve => setImmediate(resolve));
    return response({ data: {} });
  });
  const [left, right] = await Promise.all([active(h), active(h)]);
  assert.deepEqual(left.instances, []);
  assert.deepEqual(right.instances, []);
  assert.equal(count, 1);
});

test('malformed secure snapshot cache falls back to fresh active scan without clearing settings', async () => {
  const h = harness();
  setConnected(h);
  h.storage.values.set(CACHE, '{bad json');
  h.route('GET', '/api/session/active', response({ data: {} }));
  assert.deepEqual((await active(h)).instances, []);
  const persisted = h.storage.values.get(STATE);
  assert.equal((typeof persisted === 'string' ? JSON.parse(persisted) : persisted).password, 'pässword');
  assert.deepEqual(h.unexpected, []);
});

test('legacy source load never writes credential state and cannot restore it after disconnect', async () => {
  const h = harness();
  setConnected(h, { cache_generation: undefined });
  const originalGet = h.storage.getItem.bind(h.storage);
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let delayFirstStateRead = true;
  h.storage.getItem = async key => {
    const value = await originalGet(key);
    if (key === STATE && delayFirstStateRead) {
      delayFirstStateRead = false;
      entered();
      await gate;
    }
    return value;
  };
  h.route('GET', '/api/session/active', response({ data: {} }));
  const pendingSource = active(h);
  await started;
  await h.service.config({ type: 'disconnect' });
  release();
  await pendingSource;
  assert.equal(h.storage.values.has(STATE), false);
  assert.equal(h.storage.values.has(CACHE), false);
});

test('nonfinite expiry and oversized cache are ignored in favor of fresh source data', async t => {
  await t.test('nonfinite expiry', async () => {
    const h = harness();
    setConnected(h);
    h.storage.values.set(CACHE, { version: 1, generation: 'gen', url: 'http://localhost:4096', username: 'opencode', entries: {
      'active-map': { expires: Infinity, written: 1700000000000, value: { ids: [] } }
    } });
    h.route('GET', '/api/session/active', response({ data: {} }));
    assert.deepEqual((await active(h)).instances, []);
    assert.equal(h.requests.filter(req => req.path === '/api/session/active').length, 1);
  });
  await t.test('oversized serialized cache', async () => {
    const h = harness();
    setConnected(h);
    h.storage.values.set(CACHE, 'x'.repeat(262145));
    h.route('GET', '/api/session/active', response({ data: {} }));
    assert.deepEqual((await active(h)).instances, []);
    assert.equal(h.requests.filter(req => req.path === '/api/session/active').length, 1);
  });
  await t.test('cache storage unavailable', async () => {
    const h = harness();
    setConnected(h);
    const get = h.storage.getItem.bind(h.storage);
    h.storage.getItem = async key => {
      if (key === CACHE) throw new Error('storage unavailable');
      return get(key);
    };
    h.route('GET', '/api/session/active', response({ data: {} }));
    assert.deepEqual((await active(h)).instances, []);
    assert.equal(h.requests.filter(req => req.path === '/api/session/active').length, 1);
  });
});

test('reconnect and server-version change rotate cache generation', async () => {
  const h = harness();
  setConnected(h);
  h.storage.values.set(CACHE, { version: 1, generation: 'gen', url: 'http://localhost:4096', username: 'opencode', entries: {} });
  h.route('GET', '/api/info', response({ version: '2.2.2' }));
  await h.service.config({ type: 'connect', url: 'http://localhost:4096', username: 'opencode', password: 'new-password' });
  const rawAfterReconnect = h.storage.values.get(STATE);
  const afterReconnect = typeof rawAfterReconnect === 'string' ? JSON.parse(rawAfterReconnect) : rawAfterReconnect;
  assert.notEqual(afterReconnect.cache_generation, 'gen');
  assert.equal(h.storage.values.has(CACHE), false);

  const generation = afterReconnect.cache_generation;
  h.route('GET', '/api/info', response({ version: '2.3.0' }));
  await h.service.config({ type: 'test' });
  const rawAfterTest = h.storage.values.get(STATE);
  assert.notEqual((typeof rawAfterTest === 'string' ? JSON.parse(rawAfterTest) : rawAfterTest).cache_generation, generation);
  assert.equal(h.storage.values.has(CACHE), false);
});

test('late cache write after reconnect is rejected by persisted generation', async () => {
  const h = harness();
  setConnected(h);
  const originalSet = h.storage.setItem.bind(h.storage);
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let delayCacheWrite = true;
  h.storage.setItem = async (key, value) => {
    if (key === CACHE && delayCacheWrite) {
      delayCacheWrite = false;
      entered();
      await gate;
    }
    return originalSet(key, value);
  };
  h.route('GET', '/api/session/active', response({ data: {} }));
  const pendingSource = active(h);
  await started;
  h.route('GET', '/api/info', response({ version: '2.2.1' }));
  await h.service.config({ type: 'connect', url: 'http://localhost:4096', username: 'opencode', password: 'rotated' });
  release();
  await pendingSource;
  const rawLateCache = h.storage.values.get(CACHE);
  const lateCache = typeof rawLateCache === 'string' ? JSON.parse(rawLateCache) : rawLateCache;
  const rawFinalState = h.storage.values.get(STATE);
  const finalState = typeof rawFinalState === 'string' ? JSON.parse(rawFinalState) : rawFinalState;
  assert.notEqual(lateCache && lateCache.generation, finalState.cache_generation);

  h.route('GET', '/api/session/active', response({ data: {} }));
  await active(h);
  assert.equal(h.requests.filter(req => req.path === '/api/session/active').length, 2);
});

test('active-session metric properties match declared value shapes and omit unknown outcome', async () => {
  const h = harness();
  setConnected(h, { directory: '/workspace' });
  h.route('GET', '/api/session/active', response({ data: { ses_metrics: { type: 'running' } } }));
  h.route('GET', '/api/session/ses_metrics', response({ data: session('ses_metrics', 'Metrics', {
    outcome: 'unknown', cost: 1.25, tokens: { input: 2, output: 3, reasoning: 4, cache: { read: 5, write: 6 } }
  }) }));
  h.route('GET', '/api/session/ses_metrics/permission', response({ data: [] }));
  h.route('GET', '/api/session/ses_metrics/form', response({ data: [] }));
  const result = await h.service.source({ category: 'opencode', item: 'active_session' });
  const props = result.instances[0].properties;
  assert.equal(props.outcome, undefined);
  assert.deepEqual(props.cost.numericValue, { value: 1.25, min: 0, unit: 'USD' });
  assert.equal(props.cost.shortText.text, '$1.25');
  for (const key of ['tokens_input', 'tokens_output', 'tokens_reasoning', 'tokens_cache_read', 'tokens_cache_write']) {
    assert.deepEqual(Object.keys(props[key]), ['numericValue']);
    assert.deepEqual(props[key].numericValue, { value: { tokens_input: 2, tokens_output: 3, tokens_reasoning: 4, tokens_cache_read: 5, tokens_cache_write: 6 }[key], min: 0 });
  }
  assert.equal(h.requests.filter(req => req.path === '/api/session/active').length, 1);
});

test('shell exit property is numeric-only', async () => {
  const h = harness();
  setConnected(h, { selected: { session_id: 'ses_shell', title: 'Shell' } });
  h.route('GET', '/api/session/ses_shell', response({ data: session('ses_shell', 'Shell') }));
  h.route('GET', '/api/shell', response({ location: { directory: '/workspace' }, data: [{
    id: 'sh_metric', status: 'running', command: 'c'.repeat(5000), cwd: '/workspace', time: { started: 1699999999000 }, exit: 0
  }] }));
  const result = await h.service.source({ category: 'opencode', item: 'shell' });
  const props = result.instances[0].properties;
  assert.deepEqual(props.exit, { numericValue: { value: 0 } });
  assert.equal(props.command.longText.text.length, 4096);
  assert.equal(props.duration.numericValue.unit, 's');
});

test('nickname save refreshes configured chats and permission labels', async () => {
  const h = harness();
  setConnected(h);
  h.route('GET', '/api/session/ses_nick', response({ data: session('ses_nick', 'Nick') }));
  const previous = global.Pebble;
  const refreshed = [];
  global.Pebble = { refreshSources: sources => refreshed.push(sources) };
  try { await h.service.config({ type: 'save_session', session_id: 'ses_nick', nickname: 'Pinned' }); }
  finally { if (previous === undefined) delete global.Pebble; else global.Pebble = previous; }
  assert.equal(refreshed.length, 1);
  assert.ok(refreshed[0].includes('agent/configured'));
  assert.ok(refreshed[0].includes('opencode/permission'));
  assert.ok(refreshed[0].includes('opencode/question'));
});

test('mode and selection refresh focus-dependent sources without global active scans', async t => {
  await t.test('mode', async () => {
    const h = harness();
    setConnected(h);
    const previous = global.Pebble;
    const refreshed = [];
    global.Pebble = { refreshSources: sources => refreshed.push(sources) };
    try { await h.service.config({ type: 'mode', mode: 'new_chat' }); }
    finally { if (previous === undefined) delete global.Pebble; else global.Pebble = previous; }
    assert.deepEqual(refreshed, [['agent/configured', 'opencode/reply', 'opencode/replies', 'opencode/chat_status', 'opencode/question', 'opencode/execution', 'opencode/queue', 'opencode/shell', 'opencode/command']]);
  });
  await t.test('select', async () => {
    const h = harness();
    setConnected(h);
    h.route('GET', '/api/session/ses_select', response({ data: session('ses_select', 'Selected') }));
    const previous = global.Pebble;
    const refreshed = [];
    global.Pebble = { refreshSources: sources => refreshed.push(sources) };
    try { await h.service.config({ type: 'select', session_id: 'ses_select' }); }
    finally { if (previous === undefined) delete global.Pebble; else global.Pebble = previous; }
    assert.deepEqual(refreshed, [['agent/configured', 'opencode/reply', 'opencode/replies', 'opencode/chat_status', 'opencode/question', 'opencode/execution', 'opencode/queue', 'opencode/shell', 'opencode/command']]);
  });
});

test('send target resolution bypasses cached title list and rejects newly ambiguous title', async () => {
  const h = harness();
  setConnected(h);
  h.route('GET', '/api/session', response(page([session('ses_alpha', 'Alpha')])));
  await h.service.source({ category: 'agent', item: 'chats' });
  h.route('GET', '/api/session', response(page([session('ses_alpha', 'Alpha'), session('ses_alphabet', 'Alpha extra')])));
  await assert.rejects(h.service.action({ action: 'send_to_agent', args: { message: 'hello', chat_id: 'Alpha' } }), error => error.code === 'INVALID_ARGS' && /ambiguous/i.test(error.message));
  assert.equal(h.requests.filter(req => req.path === '/api/session').length, 2);
  assert.equal(h.requests.some(req => req.method === 'POST'), false);
});

test('completed readable reply cache reuses exact session.updated snapshot after service recreation', async () => {
  const h = harness();
  setConnected(h, { selected: { session_id: 'ses_reply', title: 'Reply' } });
  const svc = () => createService({ storage: h.storage, fetch: async (url, options) => {
    const parsed = new URL(url);
    const req = { path: parsed.pathname, method: options.method || 'GET', search: parsed.searchParams };
    h.requests.push(req);
    const index = h.routes.findIndex(route => route.method === req.method && route.match(req));
    if (index < 0) { h.unexpected.push(`Unexpected request: ${req.method} ${parsed.pathname}${parsed.search}`); throw new Error('unexpected'); }
    const [route] = h.routes.splice(index, 1);
    return typeof route.result === 'function' ? route.result(req) : route.result;
  }, now: () => 1700000000000 });
  const message = { id: 'msg_done', type: 'assistant', time: { created: 900, completed: 1000 }, native: { private: 'native secret' }, content: [
    { type: 'reasoning', text: 'private reasoning' }, { type: 'tool', state: { output: 'private tool output' } }, { type: 'text', text: 'Done' }
  ] };
  const addSession = () => h.route('GET', '/api/session/ses_reply', response({ data: session('ses_reply', 'Reply', { time: { created: 1, updated: 1005 } }) }));
  addSession();
  h.route('GET', req => req.path === '/api/session/ses_reply/message', req => response({ data: [message], cursor: { next: null } }));
  assert.equal((await h.service.source({ category: 'opencode', item: 'reply' })).instances[0].properties.text.longText.text, 'Done');
  addSession();
  h.route('GET', '/api/session/active', response({ data: {} }));
  assert.equal((await svc().source({ category: 'opencode', item: 'reply' })).instances[0].properties.text.longText.text, 'Done');
  assert.equal(h.requests.filter(req => req.path === '/api/session/ses_reply/message').length, 1);
  const serializedCache = JSON.stringify(h.storage.values.get(CACHE));
  for (const secret of ['password', 'native secret', 'private reasoning', 'private tool output']) assert.equal(serializedCache.includes(secret), false);
});

test('completed reply cache expires after sixty seconds', async () => {
  const h = harness();
  setConnected(h, { selected: { session_id: 'ses_expire', title: 'Expiry' } });
  const addSession = () => h.route('GET', '/api/session/ses_expire', response({ data: session('ses_expire', 'Expiry', { time: { created: 1, updated: 1000 } }) }));
  const addMessage = () => h.route('GET', '/api/session/ses_expire/message', response({ data: [
    { id: 'msg_expire', type: 'assistant', time: { created: 900, completed: 1000 }, content: [{ type: 'text', text: 'stable' }] }
  ], cursor: { next: null } }));
  addSession(); addMessage();
  await h.service.source({ category: 'opencode', item: 'reply' });
  h.setNow(1700000060001);
  addSession(); addMessage();
  await h.service.source({ category: 'opencode', item: 'reply' });
  assert.equal(h.requests.filter(req => req.path === '/api/session/ses_expire/message').length, 2);
});

test('twenty completed reply cache hits share one active-map read and fit bounded cache', async () => {
  const h = harness();
  const ids = Array.from({ length: 20 }, (_, index) => `ses_cache${index}`);
  const rows = ids.map(id => session(id, id, { time: { created: 1, updated: 1005 } }));
  setConnected(h, { reply_count: 20, selected: { session_id: ids[0], title: ids[0] } });
  h.route('GET', '/api/session', response(page(rows)));
  ids.forEach((id, index) => h.route('GET', req => req.path === `/api/session/${id}/message`, response({
    data: [{ id: `msg_cache${index}`, type: 'assistant', time: { created: 900, completed: 1000 }, content: [{ type: 'text', text: `reply ${index}` }] }], cursor: { next: null }
  })));
  await h.service.source({ category: 'opencode', item: 'replies' });
  const cachedRaw = h.storage.values.get(CACHE);
  const cached = typeof cachedRaw === 'string' ? JSON.parse(cachedRaw) : cachedRaw;
  assert.equal(Object.keys(cached.entries).filter(key => key.startsWith('reply:')).length, 20);

  const nextService = createService({ storage: h.storage, fetch: async (url, options) => {
    const parsed = new URL(url);
    const req = { path: parsed.pathname, method: options.method || 'GET', search: parsed.searchParams };
    h.requests.push(req);
    const index = h.routes.findIndex(route => route.method === req.method && route.match(req));
    if (index < 0) { h.unexpected.push(`Unexpected request: ${req.method} ${parsed.pathname}${parsed.search}`); throw new Error('unexpected'); }
    const [route] = h.routes.splice(index, 1);
    return typeof route.result === 'function' ? route.result(req) : route.result;
  }, now: () => 1700000000000 });
  h.route('GET', '/api/session/active', response({ data: {} }));
  const result = await nextService.source({ category: 'opencode', item: 'replies' });
  assert.equal(result.instances.length, 20);
  assert.equal(h.requests.filter(req => req.path === '/api/session/active').length, 1);
  assert.equal(h.requests.filter(req => req.path.includes('/message')).length, 20);
  assert.ok(Buffer.byteLength(String(h.storage.values.get(CACHE)), 'utf8') <= 262144);
});

test('warm completed reply cache reads CACHE once per source call', async () => {
  const h = harness();
  const ids = Array.from({ length: 20 }, (_, index) => `ses_warm${index}`);
  await populateWarmReplies(h, ids);
  const reads = countCacheReads(h);

  const first = await h.service.source({ category: 'opencode', item: 'replies' });
  assert.equal(first.instances.length, 20);
  assert.deepEqual(h.unexpected, []);
  assert.equal(reads.count, 1);

  reads.count = 0;
  const second = await h.service.source({ category: 'opencode', item: 'replies' });
  assert.equal(second.instances.length, 20);
  assert.equal(reads.count, 1);
});

test('concurrent warm source calls keep isolated request cache contexts', async () => {
  const h = harness();
  const ids = Array.from({ length: 20 }, (_, index) => `ses_parallel${index}`);
  await populateWarmReplies(h, ids);
  const reads = countCacheReads(h);

  const [left, right] = await Promise.all([
    h.service.source({ category: 'opencode', item: 'replies' }),
    h.service.source({ category: 'opencode', item: 'replies' })
  ]);
  assert.equal(left.instances.length, 20);
  assert.equal(right.instances.length, 20);
  assert.deepEqual(h.unexpected, []);
  assert.equal(reads.count, 2);
});

test('cache writes merge persisted entries written by a concurrent request', async () => {
  const h = harness();
  setConnected(h, { mode: 'new_chat', selected: null, lastSessionID: 'ses_merge', reply_count: 1 });
  writeCache(h, {
    version: 1, generation: 'gen', url: 'http://localhost:4096', username: 'opencode',
    entries: {
      'sessions:first': { expires: 1700000060000, written: 1700000000000, value: page([session('ses_merge', 'Merge', { time: { created: 1, updated: 1005 } })]) },
      'active-map': { expires: 1700000060000, written: 1700000000000, value: { ids: [] } }
    }
  });
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let gated = false;
  h.route('GET', req => req.path === '/api/session/ses_merge/message', async () => {
    if (!gated) { gated = true; entered(); await gate; }
    return response({ data: [{ id: 'msg_merge', type: 'assistant', time: { created: 900, completed: 1000 }, content: [{ type: 'text', text: 'merged reply' }] }], cursor: { next: null } });
  });

  const pending = h.service.source({ category: 'opencode', item: 'replies' });
  await started;
  h.route('GET', '/api/session/active', response({ data: {} }));
  await h.service.source({ category: 'opencode', item: 'active_session' });
  release();

  const result = await pending;
  assert.equal(result.instances[0].properties.text.longText.text, 'merged reply');
  const cache = readCache(h);
  assert.ok(cache.entries.active, 'concurrent active snapshot entry was dropped');
  assert.ok(cache.entries['reply:ses_merge'], 'reply entry missing after merge');
});

test('generation rotation or disconnect during a request drops the memoized envelope', async t => {
  for (const mode of ['rotate', 'disconnect']) {
    await t.test(mode, async () => {
      const h = harness();
      const ids = Array.from({ length: 20 }, (_, index) => `ses_${mode}${index}`);
      await populateWarmReplies(h, ids);
      const messagesBefore = h.requests.filter(req => req.path.endsWith('/message')).length;
      addFreshReplyRoutes(h, ids);
      addActiveRoutes(h);

      const original = h.storage.getItem.bind(h.storage);
      let mutated = false;
      h.storage.getItem = async key => {
        const value = await original(key);
        if (key === CACHE && !mutated) {
          mutated = true;
          if (mode === 'rotate') {
            const state = h.storage.values.get(STATE);
            h.storage.values.set(STATE, { ...(typeof state === 'string' ? JSON.parse(state) : state), cache_generation: 'gen-rotated' });
          } else {
            h.storage.values.delete(STATE);
          }
        }
        return value;
      };

      const result = await h.service.source({ category: 'opencode', item: 'replies' });
      assert.equal(result.instances.length, 20);
      assert.deepEqual(result.instances.map(instance => instance.properties.text.longText.text), ids.map((_, index) => `fresh ${index}`));
      assert.equal(h.requests.filter(req => req.path.endsWith('/message')).length - messagesBefore, 20);
      if (mode === 'rotate') {
        assert.equal(readCache(h).generation, 'gen');
        const state = h.storage.values.get(STATE);
        assert.equal((typeof state === 'string' ? JSON.parse(state) : state).cache_generation, 'gen-rotated');
      } else {
        assert.equal(h.storage.values.has(STATE), false);
      }
    });
  }
});

test('cache expiry is checked with the current clock inside one request', async () => {
  const h = harness();
  const ids = Array.from({ length: 20 }, (_, index) => `ses_expired${index}`);
  const { rows } = await populateWarmReplies(h, ids);
  const pagesBefore = h.requests.filter(req => req.path === '/api/session').length;
  h.route('GET', '/api/session', response(page(rows)));
  addFreshReplyRoutes(h, ids);
  addActiveRoutes(h);

  const original = h.storage.getItem.bind(h.storage);
  let advanced = false;
  h.storage.getItem = async key => {
    const value = await original(key);
    if (key === CACHE && !advanced) {
      advanced = true;
      h.setNow(1700000060001);
    }
    return value;
  };

  const result = await h.service.source({ category: 'opencode', item: 'replies' });
  assert.equal(result.instances.length, 20);
  assert.deepEqual(result.instances.map(instance => instance.properties.text.longText.text), ids.map((_, index) => `fresh ${index}`));
  assert.equal(h.requests.filter(req => req.path === '/api/session').length - pagesBefore, 1);
  const entry = readCache(h).entries['reply:' + ids[0]];
  assert.equal(entry.expires, 1700000120001);
});

test('active session bypasses completed reply cache and refreshes messages', async () => {
  const h = harness();
  setConnected(h, { selected: { session_id: 'ses_live', title: 'Live' }, cache_generation: 'gen' });
  h.storage.values.set(CACHE, {
    version: 1, generation: 'gen', url: 'http://localhost:4096', username: 'opencode',
    entries: { 'reply:ses_live': { expires: 1700000060000, value: { id: 'msg_old', text: 'old', created: 900, completed: 1000, updated: 1000, finish: 'stop' } } }
  });
  h.route('GET', '/api/session/ses_live', response({ data: session('ses_live', 'Live', { time: { created: 1, updated: 1000 } }) }));
  h.route('GET', '/api/session/active', response({ data: { ses_live: { type: 'running' } } }));
  h.route('GET', req => req.path === '/api/session/ses_live/message', response({ data: [{ id: 'msg_current', type: 'assistant', time: { created: 1001 }, content: [{ type: 'text', text: 'current' }] }], cursor: { next: null } }));
  const result = await h.service.source({ category: 'opencode', item: 'reply' });
  assert.equal(result.instances[0].properties.text.longText.text, 'current');
});

test('execution source prioritizes live active map over stale succeeded outcome and hides tool payload', async () => {
  const h = harness();
  setConnected(h, { selected: { session_id: 'ses_exec', title: 'Execution' } });
  h.route('GET', '/api/session/ses_exec', response({ data: session('ses_exec', 'Execution', { outcome: 'succeeded' }) }));
  h.route('GET', '/api/session/active', response({ data: { ses_exec: { type: 'running' } } }));
  h.route('GET', '/api/session/ses_exec/message', response({ data: [{
    id: 'msg_exec', type: 'assistant', time: { created: 10 }, content: [{
      type: 'tool', id: 'call_1', name: 'bash', time: { created: 10 }, state: { status: 'running', input: { secret: 'hidden' }, metadata: {} }
    }]
  }], cursor: { next: null, previous: null } }));
  const result = await h.service.source({ category: 'opencode', item: 'execution' });
  const props = result.instances[0].properties;
  assert.equal(props.status.shortText.text, 'Running');
  assert.equal(props.tool.longText.text, 'bash');
  assert.equal(JSON.stringify(result).includes('hidden'), false);
});

test('execution source exposes retry and compaction outcomes from validated timeline', async () => {
  const retryHarness = harness();
  setConnected(retryHarness, { selected: { session_id: 'ses_retry', title: 'Retry' } });
  retryHarness.route('GET', '/api/session/ses_retry', response({ data: session('ses_retry', 'Retry') }));
  retryHarness.route('GET', '/api/session/active', response({ data: {} }));
  retryHarness.route('GET', '/api/session/ses_retry/message', response({ data: [{
    id: 'msg_retry', type: 'assistant', time: { created: 10 }, retry: { attempt: 1, at: 1700000001000, error: { type: 'provider', message: 'private failure' } }, content: []
  }], cursor: { next: null, previous: null } }));
  const retry = await retryHarness.service.source({ category: 'opencode', item: 'execution' });
  assert.equal(retry.instances[0].properties.status.shortText.text, 'Retrying');
  assert.equal(retry.instances[0].properties.retry_at.timestamp.value, 1700000001);

  const compactHarness = harness();
  setConnected(compactHarness, { selected: { session_id: 'ses_compact', title: 'Compact' } });
  compactHarness.route('GET', '/api/session/ses_compact', response({ data: session('ses_compact', 'Compact') }));
  compactHarness.route('GET', '/api/session/active', response({ data: {} }));
  compactHarness.route('GET', '/api/session/ses_compact/message', response({ data: [
    { id: 'msg_compact', type: 'compaction', status: 'completed', reason: 'auto', time: { created: 10 }, summary: 'private summary' }
  ], cursor: { next: null, previous: null } }));
  const compact = await compactHarness.service.source({ category: 'opencode', item: 'execution' });
  assert.equal(compact.instances[0].properties.status.shortText.text, 'Idle');
  assert.equal(JSON.stringify(compact).includes('private summary'), false);
});
