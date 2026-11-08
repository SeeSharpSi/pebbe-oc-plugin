'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const manifest = require('../package.json').pebble;
const { harness: newHarness, response, session } = require('./helpers');

const activeHarnesses = [];
function harness() {
  const h = newHarness();
  activeHarnesses.push(h);
  h.storage.values.set('opencode.plugin.state.v1', {
    url: 'http://localhost:4096', username: 'opencode', password: 'pässword', version: '2.2.1',
    mode: 'default_chat', directory: '/workspace', selected: null, lastSessionID: null, nicknames: {}
  });
  return h;
}
test.afterEach(() => {
  for (const h of activeHarnesses.splice(0)) assert.deepEqual(h.unexpected, [], 'strict mock saw unexpected interrupt request');
});

function addSession(h, id, value = session(id, 'Interrupt target')) {
  h.route('GET', `/api/session/${id}`, response({ data: value }));
}
function call(h, args) { return h.service.action({ action: 'interrupt_session', args }); }

test('interrupt manifest declares exact destructive confirmation contract', () => {
  const action = manifest.plugin.actions.find(item => item.name === 'interrupt_session');
  assert.ok(action);
  assert.deepEqual(action.targets, ['opencode/active_session', 'agent/chats', 'opencode/reply']);
  assert.equal(action.destructive, true);
  assert.equal(action.requiresConfirmation, true);
  assert.deepEqual(action.parameters.required, ['session_id']);
  assert.deepEqual(Object.keys(action.parameters.properties), ['session_id']);
  assert.equal(action.parameters.additionalProperties, false);
});

test('interrupt validates exact required session_id before any HTTP', async () => {
  const h = harness();
  for (const args of [undefined, {}, { session_id: 'ses_x', id: 'ses_x' }, { session_id: 'ses_x', chat_id: 'ses_x' }, { session_id: 'bad/id' }, { session_id: 'ses' }]) {
    await assert.rejects(call(h, args), error => error.code === 'INVALID_ARGS');
  }
  assert.equal(h.requests.length, 0);
});

test('interrupt rejects without network when disconnected', async () => {
  const h = newHarness();
  await assert.rejects(call(h, { session_id: 'ses_x' }), error => error.code === 'AUTH_REQUIRED');
  assert.equal(h.requests.length, 0);
});

test('interrupt validates live matching unarchived session before one bodyless POST', async () => {
  const h = harness();
  addSession(h, 'ses_live');
  h.route('POST', req => req.path === '/api/session/ses_live/interrupt' && req.search.get('resume') === 'false', req => {
    assert.equal(req.body, undefined);
    return response({ interrupted: true });
  });
  const result = await call(h, { session_id: 'ses_live' });
  assert.match(result.text, /interrupted/i);
  assert.deepEqual(result.refreshed, ['agent/chats', 'opencode/active_session', 'opencode/activity', 'opencode/reply', 'opencode/question', 'opencode/job']);
  assert.deepEqual(h.requests.map(req => [req.method, req.path]), [
    ['GET', '/api/session/ses_live'], ['POST', '/api/session/ses_live/interrupt']
  ]);
});

test('interrupt false response reports already idle', async () => {
  const h = harness(); addSession(h, 'ses_idle');
  h.route('POST', '/api/session/ses_idle/interrupt', response({ interrupted: false }));
  const result = await call(h, { session_id: 'ses_idle' });
  assert.match(result.text, /already idle/i);
  assert.equal(h.requests.filter(req => req.method === 'POST').length, 1);
});

test('interrupt rejects archived or mismatched sessions before POST', async t => {
  await t.test('archived', async () => {
    const h = harness(); addSession(h, 'ses_old', session('ses_old', 'Old', { time: { archived: 1700000000 } }));
    await assert.rejects(call(h, { session_id: 'ses_old' }));
    assert.equal(h.requests.some(req => req.method === 'POST'), false);
  });
  await t.test('mismatched ID', async () => {
    const h = harness(); addSession(h, 'ses_requested', session('ses_other'));
    await assert.rejects(call(h, { session_id: 'ses_requested' }), error => error.code === 'PLUGIN_UNAVAILABLE');
    assert.equal(h.requests.some(req => req.method === 'POST'), false);
  });
});

test('interrupt HTTP errors preserve auth/rate-limit and never retry POST', async t => {
  for (const [status, code] of [[401, 'AUTH_REQUIRED'], [403, 'PERMISSION_DENIED'], [429, 'RATE_LIMITED'], [400, 'PLUGIN_UNAVAILABLE'], [500, 'PLUGIN_UNAVAILABLE']]) {
    await t.test(String(status), async () => {
      const h = harness(); addSession(h, 'ses_failure');
      h.route('POST', '/api/session/ses_failure/interrupt', response({ detail: 'private server payload' }, status));
      await assert.rejects(call(h, { session_id: 'ses_failure' }), error => error.code === code && !error.message.includes('private'));
      assert.equal(h.requests.filter(req => req.method === 'POST').length, 1);
    });
  }
});

test('interrupt network and malformed success responses fail uncertainly without retry', async t => {
  await t.test('network failure', async () => {
    const h = harness(); addSession(h, 'ses_uncertain');
    h.route('POST', '/api/session/ses_uncertain/interrupt', () => { throw Error('private transport'); });
    await assert.rejects(call(h, { session_id: 'ses_uncertain' }), error => error.code === 'PLUGIN_UNAVAILABLE' && /inspect/i.test(error.message));
    assert.equal(h.requests.filter(req => req.method === 'POST').length, 1);
  });
  await t.test('malformed 2xx result', async () => {
    const h = harness(); addSession(h, 'ses_uncertain');
    h.route('POST', '/api/session/ses_uncertain/interrupt', response({ interrupted: 'yes' }));
    await assert.rejects(call(h, { session_id: 'ses_uncertain' }), error => error.code === 'PLUGIN_UNAVAILABLE' && /inspect/i.test(error.message));
    assert.equal(h.requests.filter(req => req.method === 'POST').length, 1);
  });
});
