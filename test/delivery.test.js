'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const helpers = require('./helpers');
const { response, makeAck, connected, addLiveSession, addPrompt } = helpers;
const { createService } = require('../src/plugin/index.js');

const activeHarnesses = [];
function harness() { const h = helpers.harness(); activeHarnesses.push(h); return h; }
test.afterEach(() => {
  for (const h of activeHarnesses.splice(0)) assert.deepEqual(h.unexpected, [], 'strict fetch mock saw unexpected request');
});

function prompts(h) {
  return h.requests.filter(req => req.method === 'POST' && req.path.endsWith('/prompt'));
}

function assertPrompt(h, delivery) {
  const posts = prompts(h);
  assert.equal(posts.length, 1, 'exactly one prompt request expected');
  assert.deepEqual(posts[0].body, { id: posts[0].body.id, text: 'hello', delivery });
  assert.match(posts[0].body.id, /^msg_/);
}

function status(state, extra = {}) {
  return { connected: false, configured: false, url: '', username: 'opencode', version: '', mode: 'default_chat', directory: '', selected: null, nicknames: {}, reply_count: 10, default_delivery: 'queue', auth_method: '', reply_alerts: false, notifications_supported: false, ...state, ...extra };
}

test('default delivery is queue, accepts both modes, persists without network, and rejects invalid values', async () => {
  const h = harness();
  const initial = await h.service.config({ type: 'status' });
  assert.equal(initial.default_delivery, 'queue');
  assert.equal(h.requests.length, 0);

  const queued = await h.service.config({ type: 'default_delivery', delivery: 'queue' });
  assert.equal(queued.default_delivery, 'queue');
  const steered = await h.service.config({ type: 'default_delivery', delivery: 'steer' });
  assert.equal(steered.default_delivery, 'steer');
  assert.equal(h.requests.length, 0);

  let calls = 0;
  const next = createService({ storage: h.storage, fetch: async () => { calls += 1; return response(null); } });
  assert.equal((await next.config({ type: 'status' })).default_delivery, 'steer');
  assert.equal((await next.config({ type: 'default_delivery', delivery: 'queue' })).default_delivery, 'queue');
  assert.equal((await next.config({ type: 'status' })).default_delivery, 'queue');
  assert.equal(calls, 0);

  for (const delivery of [null, 1, 0, 'other', 'Queue', 'steer ', true, {}, []]) {
    await assert.rejects(next.config({ type: 'default_delivery', delivery }), error => error.code === 'INVALID_ARGS');
  }
  assert.equal(calls, 0);
  assert.equal((await next.config({ type: 'status' })).default_delivery, 'queue');
});

test('default delivery configuration does not refresh server sources', async () => {
  const h = harness();
  const previous = global.Pebble;
  const refreshed = [];
  global.Pebble = { refreshSources: sources => refreshed.push(sources) };
  try { await h.service.config({ type: 'default_delivery', delivery: 'steer' }); }
  finally { if (previous === undefined) delete global.Pebble; else global.Pebble = previous; }
  assert.deepEqual(refreshed, []);
  assert.equal(h.requests.length, 0);
});

test('status exposes exact default_delivery field', async () => {
  const h = harness();
  assert.deepEqual(await h.service.config({ type: 'status' }), status({}));
  assert.equal((await h.service.config({ type: 'default_delivery', delivery: 'steer' })).default_delivery, 'steer');
  assert.deepEqual(await h.service.config({ type: 'status' }), status({}, { default_delivery: 'steer' }));
});

test('default queue sends queue and reports queued', async () => {
  const h = harness(); await connected(h); addPrompt(h, 'ses_a', 'Alpha');
  const result = await h.service.action({ action: 'send_to_agent', args: { message: 'hello', chat_id: 'ses_a' } });
  assertPrompt(h, 'queue');
  assert.match(result.text, /queued/i);
  assert.doesNotMatch(result.text, /steer/i);
});

test('saved steer default applies when delivery is omitted and matching receipt reports steered', async () => {
  const h = harness(); await connected(h);
  await h.service.config({ type: 'default_delivery', delivery: 'steer' });
  addPrompt(h, 'ses_a', 'Alpha', 'hello', 'steer');
  const result = await h.service.action({ action: 'send_to_agent', args: { message: 'hello', chat_id: 'ses_a' } });
  assertPrompt(h, 'steer');
  assert.match(result.text, /steered/i);
  assert.doesNotMatch(result.text, /queued/i);
});

test('explicit queue overrides saved steer default', async () => {
  const h = harness(); await connected(h);
  await h.service.config({ type: 'default_delivery', delivery: 'steer' });
  addPrompt(h, 'ses_a', 'Alpha', 'hello', 'queue');
  const result = await h.service.action({ action: 'send_to_agent', args: { message: 'hello', chat_id: 'ses_a', delivery: 'queue' } });
  assertPrompt(h, 'queue');
  assert.match(result.text, /queued/i);
});

test('explicit steer overrides saved queue default', async () => {
  const h = harness(); await connected(h);
  addPrompt(h, 'ses_a', 'Alpha', 'hello', 'steer');
  const result = await h.service.action({ action: 'send_to_agent', args: { message: 'hello', chat_id: 'ses_a', delivery: 'steer' } });
  assertPrompt(h, 'steer');
  assert.match(result.text, /steered/i);
});

test('invalid delivery values reject before any prompt request', async () => {
  const h = harness(); await connected(h); addLiveSession(h, 'ses_a');
  for (const delivery of [null, 1, 0, 'other', 'Queue', true, {}, []]) {
    await assert.rejects(h.service.action({ action: 'send_to_agent', args: { message: 'hello', chat_id: 'ses_a', delivery } }), error => error.code === 'INVALID_ARGS');
  }
  assert.equal(h.requests.filter(req => req.method === 'POST').length, 0);
});

test('receipt with different delivery fails as uncertain without a second prompt', async () => {
  const h = harness(); await connected(h); addPrompt(h, 'ses_a', 'Alpha', 'hello', 'steer');
  const rawState = h.storage.values.get('opencode.plugin.state.v1');
  const state = typeof rawState === 'string' ? JSON.parse(rawState) : rawState;
  const previousGeneration = state.cache_generation;
  h.storage.values.set('opencode.plugin.cache.v1', { version: 1, generation: previousGeneration, url: state.url, username: state.username, entries: {} });
  await assert.rejects(h.service.action({ action: 'send_to_agent', args: { message: 'hello', chat_id: 'ses_a' } }), error => error.code === 'PLUGIN_UNAVAILABLE');
  assert.equal(prompts(h).length, 1);
  const finalState = h.storage.values.get('opencode.plugin.state.v1');
  assert.notEqual((typeof finalState === 'string' ? JSON.parse(finalState) : finalState).cache_generation, previousGeneration);
  assert.equal(h.storage.values.has('opencode.plugin.cache.v1'), false);
});

test('transport failure accepts matching steer inbox item', async () => {
  const h = harness(); await connected(h); addLiveSession(h, 'ses_a');
  h.route('POST', '/api/session/ses_a/prompt', () => { throw Error('network down'); });
  h.route('GET', req => req.path.startsWith('/api/session/ses_a/message/'), response(null, 404));
  h.route('GET', '/api/session/ses_a/inbox', () => {
    const sent = prompts(h)[0];
    return response({ data: [makeAck('ses_a', sent.body.id, 'hello', 'steer').data] });
  });
  const result = await h.service.action({ action: 'send_to_agent', args: { message: 'hello', chat_id: 'ses_a', delivery: 'steer' } });
  assert.equal(prompts(h).length, 1);
  assert.match(result.text, /steered/i);
});

test('transport failure rejects inbox item with a different delivery', async () => {
  const h = harness(); await connected(h); addLiveSession(h, 'ses_a');
  h.route('POST', '/api/session/ses_a/prompt', () => { throw Error('network down'); });
  h.route('GET', req => req.path.startsWith('/api/session/ses_a/message/'), response(null, 404));
  h.route('GET', '/api/session/ses_a/inbox', () => {
    const sent = prompts(h)[0];
    return response({ data: [makeAck('ses_a', sent.body.id, 'hello', 'queue').data] });
  });
  await assert.rejects(h.service.action({ action: 'send_to_agent', args: { message: 'hello', chat_id: 'ses_a', delivery: 'steer' } }), error => error.code === 'PLUGIN_UNAVAILABLE');
  assert.equal(prompts(h).length, 1);
});

test('direct fallback accepts missing delivery for steer', async () => {
  const h = harness(); await connected(h); addLiveSession(h, 'ses_a');
  h.route('POST', '/api/session/ses_a/prompt', () => { throw Error('network down'); });
  h.route('GET', req => req.path.startsWith('/api/session/ses_a/message/'), req => {
    const id = req.path.split('/').pop();
    return response({ data: { id, type: 'user', text: 'hello' } });
  });
  const result = await h.service.action({ action: 'send_to_agent', args: { message: 'hello', chat_id: 'ses_a', delivery: 'steer' } });
  assert.equal(prompts(h).length, 1);
  assert.match(result.text, /steered/i);
});

test('direct fallback rejects a present mismatched delivery', async () => {
  const h = harness(); await connected(h); addLiveSession(h, 'ses_a');
  h.route('POST', '/api/session/ses_a/prompt', () => { throw Error('network down'); });
  h.route('GET', req => req.path.startsWith('/api/session/ses_a/message/'), req => {
    const id = req.path.split('/').pop();
    return response({ data: { id, type: 'user', text: 'hello', delivery: 'queue' } });
  });
  h.route('GET', '/api/session/ses_a/inbox', response({ data: [] }));
  await assert.rejects(h.service.action({ action: 'send_to_agent', args: { message: 'hello', chat_id: 'ses_a', delivery: 'steer' } }), error => error.code === 'PLUGIN_UNAVAILABLE');
  assert.equal(prompts(h).length, 1);
});

test('return text distinguishes queued and steered results', async () => {
  const queuedHarness = harness(); await connected(queuedHarness); addPrompt(queuedHarness, 'ses_a', 'Alpha', 'hello', 'queue');
  const queued = await queuedHarness.service.action({ action: 'send_to_agent', args: { message: 'hello', chat_id: 'ses_a' } });
  assert.match(queued.text, /queued/i);

  const steeredHarness = harness(); await connected(steeredHarness); addPrompt(steeredHarness, 'ses_a', 'Alpha', 'hello', 'steer');
  const steered = await steeredHarness.service.action({ action: 'send_to_agent', args: { message: 'hello', chat_id: 'ses_a', delivery: 'steer' } });
  assert.match(steered.text, /steered/i);
});
