'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { harness: newHarness, response, connected, addPrompt } = require('./helpers');

const KEY = 'opencode.plugin.state.v1';
const LINK = 'http://localhost:4096/auth/connect/pair-code';
const TOKEN = 'pair-token';

const activeHarnesses = [];
function harness(state = {}) {
  const h = newHarness();
  activeHarnesses.push(h);
  if (Object.keys(state).length) h.storage.values.set(KEY, JSON.stringify(state));
  return h;
}
test.afterEach(() => {
  for (const h of activeHarnesses.splice(0)) assert.deepEqual(h.unexpected, [], 'strict mock saw unexpected pairing request');
});

function addPairLink(h, link = LINK, token = TOKEN) {
  h.route('GET', req => req.url === link, req => {
    assert.equal(req.headers.Authorization, undefined, 'pairing link must not use Basic auth');
    assert.equal(req.headers.Accept, 'application/json');
    return response({ token });
  });
}
function addInfo(h, version = '2.2.1', token = TOKEN, status = 200) {
  h.route('GET', '/api/info', req => {
    assert.equal(req.headers.Authorization, `Basic ${Buffer.from(`opencode:${token}`).toString('base64')}`);
    return status === 200 ? response({ version }) : response({ private: 'payload' }, status);
  });
}

test('pairing link exchanges a token once, verifies the server, and stores pair auth', async () => {
  const h = harness();
  addPairLink(h);
  addInfo(h);
  const status = await h.service.config({ type: 'pair', link: LINK });
  assert.equal(status.connected, true);
  assert.equal(status.configured, false);
  assert.equal(status.url, 'http://localhost:4096');
  assert.equal(status.username, 'opencode');
  assert.equal(status.auth_method, 'pair');
  assert.equal(status.version, '2.2.1');
  assert.equal(JSON.stringify(status).includes(TOKEN), false);
  assert.equal(JSON.stringify(status).includes(LINK), false);
  assert.equal(h.requests.filter(req => req.url === LINK).length, 1);
  const stored = JSON.parse(h.storage.values.get(KEY));
  assert.equal(stored.password, TOKEN);
  assert.equal(stored.auth_method, 'pair');
  assert.equal(stored.url, 'http://localhost:4096');
});

test('password connection still selects password auth method', async () => {
  const h = harness();
  const status = await connected(h);
  assert.equal(status.auth_method, 'password');
  assert.equal(JSON.parse(h.storage.values.get(KEY)).auth_method, 'password');
});

test('older saved password state is reported as password auth', async () => {
  const h = harness({
    url: 'http://localhost:4096', username: 'opencode', password: 'saved-secret', version: '2.2.1',
    mode: 'default_chat', directory: '', selected: null, lastSessionID: null, nicknames: {}
  });
  const status = await h.service.config({ type: 'status' });
  assert.equal(status.connected, true);
  assert.equal(status.auth_method, 'password');
});

test('pairing link rejects malformed links before network', async () => {
  const h = harness();
  for (const link of [
    null, '', 'relative/path', 'ftp://localhost/auth/connect/code',
    'http://user:pass@localhost/auth/connect/code',
    'http://localhost:4096/auth/other/code',
    'http://localhost:4096/auth/connect/code?x=1',
    'http://localhost:4096/auth/connect/code#x',
    'http://localhost:4096/auth/connect/'
  ]) {
    await assert.rejects(h.service.config({ type: 'pair', link }), error => error.code === 'INVALID_ARGS');
  }
  assert.equal(h.requests.length, 0);
});

test('expired, denied, limited, and failed pairing responses never save a connection', async t => {
  for (const [label, result, code] of [
    ['400', response({}, 400), 'INVALID_ARGS'],
    ['401', response({}, 401), 'INVALID_ARGS'],
    ['404', response({}, 404), 'INVALID_ARGS'],
    ['410', response({}, 410), 'INVALID_ARGS'],
    ['403', response({}, 403), 'PERMISSION_DENIED'],
    ['429', response({}, 429), 'RATE_LIMITED'],
    ['500', response({}, 500), 'PLUGIN_UNAVAILABLE']
  ]) await t.test(label, async () => {
    const h = harness();
    h.route('GET', req => req.url === LINK, result);
    await assert.rejects(h.service.config({ type: 'pair', link: LINK }), error => error.code === code);
    assert.equal(h.requests.length, 1);
    assert.equal(h.storage.values.has(KEY), false);
  });
  await t.test('network failure', async () => {
    const h = harness();
    h.route('GET', req => req.url === LINK, () => { throw Error('private network detail'); });
    await assert.rejects(h.service.config({ type: 'pair', link: LINK }), error => error.code === 'PLUGIN_UNAVAILABLE' && !error.message.includes('private'));
    assert.equal(h.storage.values.has(KEY), false);
  });
  await t.test('invalid JSON', async () => {
    const h = harness();
    h.route('GET', req => req.url === LINK, { status: 200, async json() { throw Error('private JSON'); } });
    await assert.rejects(h.service.config({ type: 'pair', link: LINK }), error => error.code === 'PLUGIN_UNAVAILABLE');
    assert.equal(h.storage.values.has(KEY), false);
  });
  await t.test('missing token', async () => {
    const h = harness();
    h.route('GET', req => req.url === LINK, response({ token: '' }));
    await assert.rejects(h.service.config({ type: 'pair', link: LINK }), error => error.code === 'PLUGIN_UNAVAILABLE');
    assert.equal(h.storage.values.has(KEY), false);
  });
});

test('pairing token rejection and V1 server fail after link redemption without saving', async t => {
  for (const [label, infoResult, expected] of [
    ['token rejected', response({}, 401), 'INVALID_ARGS'],
    ['V1 server', response({ version: '1.9.0' }), 'INVALID_ARGS']
  ]) await t.test(label, async () => {
    const h = harness();
    addPairLink(h);
    h.route('GET', '/api/info', infoResult);
    await assert.rejects(h.service.config({ type: 'pair', link: LINK }), error => error.code === expected);
    assert.equal(h.requests.filter(req => req.url === LINK).length, 1);
    assert.equal(h.requests.filter(req => req.path === '/api/info').length, 1);
    assert.equal(h.storage.values.has(KEY), false);
  });
});

test('pairing the same server preserves server-scoped state and changes method', async () => {
  const h = harness({
    url: 'http://localhost:4096', username: 'opencode', password: 'old-secret', version: '2.2.1',
    mode: 'new_chat', directory: '/workspace', selected: { session_id: 'ses_keep', title: 'Keep' },
    lastSessionID: 'ses_last', nicknames: { ses_keep: 'Pinned' }, auth_method: 'password'
  });
  addPairLink(h);
  addInfo(h);
  const status = await h.service.config({ type: 'pair', link: LINK });
  assert.deepEqual([status.mode, status.directory, status.selected.session_id, status.nicknames.ses_keep], ['new_chat', '/workspace', 'ses_keep', 'Pinned']);
  assert.equal(status.auth_method, 'pair');
  const stored = JSON.parse(h.storage.values.get(KEY));
  assert.equal(stored.lastSessionID, 'ses_last');
  assert.equal(stored.password, TOKEN);
});

test('pairing a different server resets server-scoped state', async () => {
  const h = harness({
    url: 'http://other:4096', username: 'other', password: 'old', version: '2.2.1',
    mode: 'new_chat', directory: '/old', selected: { session_id: 'ses_old', title: 'Old' },
    lastSessionID: 'ses_old', nicknames: { ses_old: 'Old' }, auth_method: 'password'
  });
  addPairLink(h);
  addInfo(h);
  const status = await h.service.config({ type: 'pair', link: LINK });
  assert.equal(status.url, 'http://localhost:4096');
  assert.deepEqual([status.mode, status.directory, status.selected, status.nicknames], ['default_chat', '', null, {}]);
  const stored = JSON.parse(h.storage.values.get(KEY));
  assert.equal(stored.lastSessionID, null);
});

test('paired token authenticates later actions and test connection', async () => {
  const h = harness();
  addPairLink(h);
  addInfo(h);
  await h.service.config({ type: 'pair', link: LINK });
  h.route('GET', '/api/info', req => {
    assert.equal(req.headers.Authorization, `Basic ${Buffer.from(`opencode:${TOKEN}`).toString('base64')}`);
    return response({ version: '2.2.1' });
  });
  assert.equal((await h.service.config({ type: 'test' })).auth_method, 'pair');
  addPrompt(h, 'ses_pair', 'Paired', 'hello');
  const result = await h.service.action({ action: 'send_to_agent', args: { message: 'hello', chat_id: 'ses_pair' } });
  assert.match(result.text, /Paired/);
});
