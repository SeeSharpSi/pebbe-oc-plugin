'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createService } = require('../src/plugin/index.js');
const { harness, response, session } = require('./helpers');

const STATE = 'opencode.plugin.state.v1';
const CACHE = 'opencode.plugin.cache.v1';
const META = 'opencode.plugin.cache.meta.v1';

function connected(h, extra = {}) {
  h.storage.values.set(STATE, {
    url: 'http://localhost:4096', username: 'opencode', password: 'old-secret', version: '2.2.1',
    mode: 'default_chat', directory: '/workspace', selected: { session_id: 'ses_focus', title: 'Focus' },
    lastSessionID: 'ses_last', nicknames: {}, ...extra
  });
}

function recreated(h) {
  return createService({ storage: h.storage, now: () => 1700000000000, fetch: async (url, options = {}) => {
    const parsed = new URL(url);
    const req = { path: parsed.pathname, method: options.method || 'GET', search: parsed.searchParams, body: options.body && JSON.parse(options.body) };
    h.requests.push(req);
    const index = h.routes.findIndex(route => route.method === req.method && route.match(req));
    if (index < 0) {
      h.unexpected.push(`Unexpected request: ${req.method} ${parsed.pathname}${parsed.search}`);
      throw new Error('unexpected request');
    }
    const [route] = h.routes.splice(index, 1);
    return typeof route.result === 'function' ? route.result(req) : route.result;
  } });
}

test('legacy sources persist private cache identity, reuse cache after recreation, and leave credential bytes unchanged', async () => {
  const h = harness();
  const legacy = {
    url: 'http://localhost:4096', username: 'opencode', password: 'legacy-password', version: '2.2.1',
    mode: 'default_chat', directory: '/workspace', selected: null, lastSessionID: null, nicknames: {}
  };
  const rawState = JSON.stringify(legacy);
  h.storage.values.set(STATE, rawState);
  h.route('GET', '/api/session/active', response({ data: {} }));

  assert.deepEqual((await h.service.source({ category: 'opencode', item: 'active_session' })).instances, []);
  const metaRaw = h.storage.values.get(META);
  const metadata = typeof metaRaw === 'string' ? JSON.parse(metaRaw) : metaRaw;
  assert.deepEqual(Object.keys(metadata).sort(), ['generation', 'url', 'username', 'version']);
  assert.equal(JSON.stringify(metadata).includes('legacy-password'), false);
  assert.equal(h.storage.values.get(STATE), rawState);

  const next = recreated(h);
  assert.deepEqual((await next.source({ category: 'opencode', item: 'active_session' })).instances, []);
  assert.equal(h.requests.filter(req => req.path === '/api/session/active').length, 1);
  assert.equal(h.storage.values.get(STATE), rawState);
});

test('legacy metadata write racing disconnect and reconnect cannot replace new identity or cache', async () => {
  const h = harness();
  connected(h, { cache_generation: undefined });
  const oldRaw = JSON.stringify(h.storage.values.get(STATE));
  h.storage.values.set(STATE, oldRaw);
  const originalSet = h.storage.setItem.bind(h.storage);
  let signal;
  const started = new Promise(resolve => { signal = resolve; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let holdMeta = true;
  h.storage.setItem = async (key, value) => {
    if (key === META && holdMeta) {
      holdMeta = false;
      signal();
      await gate;
    }
    return originalSet(key, value);
  };
  h.route('GET', '/api/session/active', response({ data: {} }));
  const sourcePromise = h.service.source({ category: 'opencode', item: 'active_session' });
  await started;
  await h.service.config({ type: 'disconnect' });
  h.route('GET', '/api/info', response({ version: '2.2.1' }));
  await h.service.config({ type: 'connect', url: 'http://localhost:4096', username: 'opencode', password: 'new-secret' });
  release();
  await sourcePromise;
  const savedRaw = h.storage.values.get(STATE);
  const saved = typeof savedRaw === 'string' ? JSON.parse(savedRaw) : savedRaw;
  assert.equal(saved.password, 'new-secret');
  assert.ok(saved.cache_generation);
  assert.equal(h.storage.values.has(META), false);
  assert.equal(h.storage.values.has(CACHE), false);
  assert.deepEqual(h.unexpected, []);
});

test('queue preserves per-session server order, groups default before last, displays session names, and supports all kinds safely', async () => {
  const h = harness();
  connected(h);
  h.route('GET', '/api/session/ses_focus', response({ data: session('ses_focus', 'Focused title') }));
  h.route('GET', '/api/session/ses_last', response({ data: session('ses_last', 'Last title') }));
  h.route('GET', '/api/session/ses_focus/inbox', response({ data: [
    { id: 'msg_user', sessionID: 'ses_focus', type: 'user', payload: { text: 'user text', metadata: { secret: 'private' } }, delivery: 'queue', time: { created: 30 } },
    { id: 'msg_synth', sessionID: 'ses_focus', type: 'synthetic', payload: { text: 'synthetic text' }, delivery: 'steer', time: { created: 10 } },
    { id: 'msg_compact', sessionID: 'ses_focus', type: 'compaction', payload: 'opaque non-object', delivery: 'queue', time: { created: 20 } },
    { id: 'msg_move', sessionID: 'ses_focus', type: 'move', payload: { projectID: 'p', location: { directory: '/other' } }, delivery: 'queue', time: { created: 1 } }
  ] }));
  h.route('GET', '/api/session/ses_last/inbox', response({ data: [
    { id: 'msg_last', sessionID: 'ses_last', type: 'user', payload: { text: 'last text' }, delivery: 'queue', time: { created: 0 } }
  ] }));
  const result = await h.service.source({ category: 'opencode', item: 'queue' });
  assert.deepEqual(result.instances.map(row => row.properties.inbox_id.longText.text), ['msg_user', 'msg_synth', 'msg_compact', 'msg_move', 'msg_last']);
  assert.deepEqual(result.instances.map(row => row.properties.name.longText.text), ['Focused title', 'Focused title', 'Focused title', 'Focused title', 'Last title']);
  assert.deepEqual(result.instances.map(row => row.properties.text.longText.text), ['user text', 'synthetic text', 'Compaction', 'Session moved', 'last text']);
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('queue accepts desktop prompts above send limit, clips source text, and allows cancellation preflight', async () => {
  const h = harness();
  connected(h);
  const queued = { id: 'msg_long', sessionID: 'ses_focus', type: 'user', payload: { text: 'x'.repeat(20000) }, delivery: 'queue', time: { created: 30 } };
  h.route('GET', '/api/session/ses_focus', response({ data: session('ses_focus', 'Focused title') }));
  h.route('GET', '/api/session/ses_focus/inbox', response({ data: [queued] }));
  h.route('GET', '/api/session/ses_last', response({ data: session('ses_last', 'Last title') }));
  h.route('GET', '/api/session/ses_last/inbox', response({ data: [] }));
  const source = await h.service.source({ category: 'opencode', item: 'queue' });
  assert.equal(source.instances[0].properties.text.longText.text.length, 4096);

  h.route('GET', '/api/session/ses_focus', response({ data: session('ses_focus', 'Focused title') }));
  h.route('GET', '/api/session/ses_focus/inbox', response({ data: [queued] }));
  h.route('DELETE', '/api/session/ses_focus/inbox/msg_long', response(undefined, 204));
  const result = await h.service.action({ action: 'cancel_queued_message', args: { session_id: 'ses_focus', inbox_id: 'msg_long' } });
  assert.match(result.text, /cancelled/i);
  assert.equal(h.requests.filter(req => req.method === 'DELETE').length, 1);
});

test('queue rejects duplicate and oversized inbox pages without partial source output', async t => {
  await t.test('duplicate ID', async () => {
    const h = harness();
    connected(h);
    h.route('GET', '/api/session/ses_focus', response({ data: session('ses_focus', 'Focused') }));
    const duplicate = { id: 'msg_dup', sessionID: 'ses_focus', type: 'user', payload: { text: 'x' }, delivery: 'queue', time: { created: 1 } };
    h.route('GET', '/api/session/ses_focus/inbox', response({ data: [duplicate, duplicate] }));
    await assert.rejects(h.service.source({ category: 'opencode', item: 'queue' }), error => error.code === 'PLUGIN_UNAVAILABLE');
  });
  await t.test('oversized page rejected before record validation', async () => {
    const h = harness();
    connected(h);
    h.route('GET', '/api/session/ses_focus', response({ data: session('ses_focus', 'Focused') }));
    h.route('GET', '/api/session/ses_focus/inbox', response({ data: Array(201).fill(null) }));
    await assert.rejects(h.service.source({ category: 'opencode', item: 'queue' }), error => error.code === 'PLUGIN_UNAVAILABLE');
  });
});

test('command and location validation rejects malformed siblings and oversized locations before mutation lookup', async t => {
  await t.test('malformed command sibling fails entire source', async () => {
    const h = harness();
    connected(h);
    h.route('GET', '/api/session/ses_focus', response({ data: session('ses_focus', 'Focus') }));
    h.route('GET', '/api/command', response({ location: { directory: '/workspace' }, data: [
      { name: 'deploy', description: 'ok' }, { name: 'bad\nname' }
    ] }));
    await assert.rejects(h.service.source({ category: 'opencode', item: 'command' }), error => error.code === 'PLUGIN_UNAVAILABLE');
  });
  await t.test('malformed command sibling blocks matching mutation', async () => {
    const h = harness();
    connected(h);
    h.route('GET', '/api/session/ses_focus', response({ data: session('ses_focus', 'Focus') }));
    h.route('GET', '/api/command', response({ location: { directory: '/workspace' }, data: [
      { name: 'deploy' }, { name: 'deploy' }
    ] }));
    await assert.rejects(h.service.action({ action: 'run_command', args: { session_id: 'ses_focus', command: 'deploy' } }), error => error.code === 'PLUGIN_UNAVAILABLE');
    assert.equal(h.requests.some(req => req.method === 'POST'), false);
  });
  await t.test('command description output is clipped to four thousand ninety-six code points', async () => {
    const h = harness();
    connected(h);
    h.route('GET', '/api/session/ses_focus', response({ data: session('ses_focus', 'Focus') }));
    h.route('GET', '/api/command', response({ location: { directory: '/workspace' }, data: [{ name: 'deploy', description: 'd'.repeat(5000) }] }));
    const result = await h.service.source({ category: 'opencode', item: 'command' });
    assert.equal(result.instances[0].properties.description.longText.text.length, 4096);
  });
  await t.test('invalid session directory blocks command list lookup', async () => {
    const h = harness();
    connected(h);
    h.route('GET', '/api/session/ses_focus', response({ data: session('ses_focus', 'Focus', { location: { directory: 'relative/path' } }) }));
    await assert.rejects(h.service.action({ action: 'run_command', args: { session_id: 'ses_focus', command: 'deploy' } }), error => error.code === 'INVALID_ARGS');
    assert.deepEqual(h.requests.map(req => req.path), ['/api/session/ses_focus']);
  });
  await t.test('oversized shell directory rejects before HTTP', async () => {
    const h = harness();
    connected(h);
    await assert.rejects(h.service.action({ action: 'stop_shell', args: { shell_id: 'sh_shell', directory: '/' + 'x'.repeat(4096) } }), error => error.code === 'INVALID_ARGS');
    assert.deepEqual(h.requests, []);
  });
  await t.test('invalid command Unicode and controls reject before session lookup', async () => {
    for (const command of ['bad\nname', '\ud800', ' ']) {
      const h = harness();
      connected(h);
      await assert.rejects(h.service.action({ action: 'run_command', args: { session_id: 'ses_focus', command } }), error => error.code === 'INVALID_ARGS');
      assert.deepEqual(h.requests, []);
    }
  });
});

test('execution skips switch metadata, honors interrupted fallback, bounds timeline, and does not leak older errors past newest user', async t => {
  await t.test('switch metadata and inactive terminal outcome', async () => {
    const h = harness();
    connected(h);
    h.route('GET', '/api/session/ses_focus', response({ data: session('ses_focus', 'Focus', { outcome: 'interrupted' }) }));
    h.route('GET', '/api/session/active', response({ data: {} }));
    h.route('GET', '/api/session/ses_focus/message', response({ data: [
      { id: 'msg_agent_switch', type: 'agent-switched', agent: 'build', time: { created: 20 } },
      { id: 'msg_model_switch', type: 'model-switched', model: { providerID: 'test', id: 'model' }, time: { created: 10 } }
    ], cursor: { next: null } }));
    const result = await h.service.source({ category: 'opencode', item: 'execution' });
    assert.equal(result.instances[0].properties.status.shortText.text, 'Interrupted');
    const messageRequest = h.requests.find(req => req.path.endsWith('/message'));
    assert.equal(messageRequest.search.get('limit'), '5');
  });
  await t.test('newest user does not inherit older assistant failure', async () => {
    const h = harness();
    connected(h);
    h.route('GET', '/api/session/ses_focus', response({ data: session('ses_focus', 'Focus') }));
    h.route('GET', '/api/session/active', response({ data: {} }));
    h.route('GET', '/api/session/ses_focus/message', response({ data: [
      { id: 'msg_user_current', type: 'user', sessionID: 'ses_focus', time: { created: 20 } },
      { id: 'msg_error_old', type: 'assistant', sessionID: 'ses_focus', time: { created: 10, completed: 15 }, finish: 'error', error: { type: 'APIError', message: 'old failure secret' }, content: [] }
    ], cursor: { next: null } }));
    const result = await h.service.source({ category: 'opencode', item: 'execution' });
    assert.equal(result.instances[0].properties.status.shortText.text, 'Waiting');
    assert.equal(JSON.stringify(result).includes('old failure secret'), false);
  });
  await t.test('current retry and latest running tool override active-map fallback', async () => {
    for (const current of [
      { id: 'msg_retry', type: 'assistant', sessionID: 'ses_focus', time: { created: 20 }, content: [], retry: { attempt: 2, at: 1700000005000, error: { type: 'APIError', message: 'temporary failure ' + 'x'.repeat(1000) } } },
      { id: 'msg_tool', type: 'assistant', sessionID: 'ses_focus', time: { created: 20 }, content: [
        { type: 'tool', state: { status: 'completed' } },
        { type: 'tool', name: 'latest_tool', state: { status: 'streaming' } }
      ] }
    ]) {
      const h = harness();
      connected(h);
      h.route('GET', '/api/session/ses_focus', response({ data: session('ses_focus', 'Focus') }));
      h.route('GET', '/api/session/active', response({ data: { ses_focus: { type: 'running' } } }));
      h.route('GET', '/api/session/ses_focus/message', response({ data: [current], cursor: { next: null } }));
      const result = await h.service.source({ category: 'opencode', item: 'execution' });
      const props = result.instances[0].properties;
      if (current.id === 'msg_retry') {
        assert.equal(props.status.shortText.text, 'Retrying');
        assert.equal(props.retry_at.timestamp.value, 1700000005);
        assert.match(props.detail.longText.text, /temporary failure/);
        assert.ok(props.detail.longText.text.length <= 512);
      } else {
        assert.equal(props.status.shortText.text, 'Running');
        assert.equal(props.tool.longText.text, 'latest_tool');
      }
    }
  });
  await t.test('active map overrides stale terminal, idle marker, and completed assistant states', async () => {
    const timelines = [
      { session: { outcome: 'failed' }, messages: [] },
      { session: { outcome: 'interrupted' }, messages: [] },
      { session: { outcome: 'failed' }, messages: [{ id: 'msg_idle', type: 'idle', outcome: 'failed', time: { created: 20 } }] },
      { session: {}, messages: [{ id: 'msg_done', type: 'assistant', sessionID: 'ses_focus', time: { created: 20, completed: 21 }, finish: 'stop', content: [] }] }
    ];
    for (const item of timelines) {
      const h = harness();
      connected(h);
      h.route('GET', '/api/session/ses_focus', response({ data: session('ses_focus', 'Focus', item.session) }));
      h.route('GET', '/api/session/active', response({ data: { ses_focus: { type: 'running' } } }));
      h.route('GET', '/api/session/ses_focus/message', response({ data: item.messages, cursor: { next: null } }));
      const result = await h.service.source({ category: 'opencode', item: 'execution' });
      assert.equal(result.instances[0].properties.status.shortText.text, 'Running');
      assert.equal(result.instances[0].properties.detail.longText.text, 'Running');
    }
  });
  await t.test('failure detail is bounded and provider response body stays private', async () => {
    const h = harness();
    connected(h);
    h.route('GET', '/api/session/ses_focus', response({ data: session('ses_focus', 'Focus') }));
    h.route('GET', '/api/session/active', response({ data: {} }));
    h.route('GET', '/api/session/ses_focus/message', response({ data: [{
      id: 'msg_failed', type: 'assistant', sessionID: 'ses_focus', time: { created: 20, completed: 21 }, finish: 'error',
      error: { type: 'APIError', message: 'E'.repeat(1000), response: { body: 'private provider response' } }, content: []
    }], cursor: { next: null } }));
    const result = await h.service.source({ category: 'opencode', item: 'execution' });
    assert.equal(result.instances[0].properties.status.shortText.text, 'Failed');
    assert.ok(result.instances[0].properties.detail.longText.text.length <= 512);
    assert.equal(JSON.stringify(result).includes('private provider response'), false);
  });
});
