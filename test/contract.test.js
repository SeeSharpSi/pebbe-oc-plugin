'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const helpers = require('./helpers');
const { response, session, page, makeAck, addConnect, connected, addLiveSession, addPrompt } = helpers;
const activeHarnesses = [];
function harness() { const h = helpers.harness(); activeHarnesses.push(h); return h; }
test.afterEach(() => {
  for (const h of activeHarnesses.splice(0)) assert.deepEqual(h.unexpected, [], 'strict fetch mock saw unexpected request');
});

const manifest = require('../package.json').pebble;

test('manifest and source/action declarations match public contract', () => {
  assert.equal(manifest.projectType, 'plugin');
  assert.equal(manifest.manifestVersion, 2);
  assert.deepEqual(manifest.usesPermissions, ['Internet', 'LocalNetwork']);
  const [chats, configured] = manifest.plugin.sources;
  assert.deepEqual([chats.category, chats.items, chats.properties, chats.suggestedRefreshIntervalSec], ['agent', ['chats'], { name: ['shortText'], title: ['shortText'], url: ['longText'] }, 900]);
  assert.deepEqual([configured.category, configured.items, configured.properties, configured.suggestedRefreshIntervalSec], ['agent', ['configured'], { name: ['shortText'], configured: ['boolean', 'shortText'] }, 60]);
  const action = manifest.plugin.actions.find(item => item.name === 'send_to_agent');
  assert.deepEqual(action.targets, ['agent/chats']);
  assert.deepEqual(action.parameters.required, ['message']);
  assert.equal(action.parameters.properties.message.maxLength, 16000);
  assert.deepEqual(action.parameters.properties.chat_id.type, ['string', 'null']);
  assert.equal(action.parameters.properties.delivery.type, 'string');
  assert.deepEqual(action.parameters.properties.delivery.enum, ['queue', 'steer']);
  assert.equal(typeof action.parameters.properties.delivery.description, 'string');
  assert.equal(Object.prototype.hasOwnProperty.call(action.parameters.properties.delivery, 'default'), false);
  assert.equal(action.parameters.additionalProperties, false);
});

test('status has exact public shape and omits secret', async () => {
  const h = harness();
  assert.deepEqual(await h.service.config({ type: 'status' }), { connected: false, configured: false, url: '', username: 'opencode', version: '', mode: 'default_chat', directory: '', selected: null, nicknames: {}, reply_count: 10, default_delivery: 'queue', auth_method: '' });
});

test('reply_count defaults to 10, accepts only integers 1..20, and persists without network', async () => {
  const h = harness();
  assert.equal((await h.service.config({ type: 'status' })).reply_count, 10);
  for (const count of [1, 3, 20]) {
    assert.equal((await h.service.config({ type: 'reply_count', count })).reply_count, count);
    assert.equal(h.requests.length, 0);
  }
  assert.equal(JSON.parse(h.storage.values.get('opencode.plugin.state.v1')).reply_count, 20);
  const { createService } = require('../src/plugin/index.js');
  const next = createService({ storage: h.storage, fetch: async () => response(null) });
  assert.equal((await next.config({ type: 'status' })).reply_count, 20);
  for (const count of [0, 21, -1, 1.5, '3', null, true, undefined, NaN]) {
    await assert.rejects(h.service.config({ type: 'reply_count', count }), error => error.code === 'INVALID_ARGS');
  }
  assert.equal((await h.service.config({ type: 'status' })).reply_count, 20);
  assert.equal(h.requests.length, 0);
});

test('connect requires password and verifies server before saving', async () => {
  const h = harness();
  const noPass = await h.service.config({ type: 'connect', url: 'http://localhost:4096' }).catch(e => e);
  assert.ok(noPass instanceof Error);
  assert.equal(h.requests.length, 0);
  const state = await addConnect(h);
  assert.equal(state.connected, true);
  assert.equal(state.version, '2.2.1');
  assert.equal(h.requests[0].headers.Authorization, `Basic ${Buffer.from('opencode:pässword').toString('base64')}`);
  assert.equal(JSON.stringify(state).includes('pässword'), false);
});

test('config rejects invalid V1 server and retains prior connection', async () => {
  const h = harness(); await connected(h);
  h.route('GET', '/api/info', response({ version: '1.9.0' }));
  await assert.rejects(h.service.config({ type: 'connect', url: 'http://other:4096', password: 'other' }));
  assert.equal((await h.service.config({ type: 'status' })).url, 'http://localhost:4096');
});

test('different server URL resets server-scoped target state', async () => {
  const h = harness(); await connected(h);
  await h.service.config({ type: 'directory', directory: '/workspace' });
  h.route('GET', '/api/info', response({ version: '2.3.0' }));
  const state = await h.service.config({ type: 'connect', url: 'http://other:4096', password: 'other' });
  assert.deepEqual([state.directory, state.selected, state.nicknames, state.mode], ['', null, {}, 'default_chat']);
});

test('reconnecting same server preserves selected session, directory, nickname, and mode', async () => {
  const h = harness(); await connected(h);
  addLiveSession(h, 'ses_keep');
  await h.service.config({ type: 'select', session_id: 'ses_keep' });
  addLiveSession(h, 'ses_keep');
  await h.service.config({ type: 'save_session', session_id: 'ses_keep', nickname: 'Keep' });
  await h.service.config({ type: 'directory', directory: '/workspace' });
  await h.service.config({ type: 'mode', mode: 'new_chat' });
  h.route('GET', '/api/info', response({ version: '2.2.1' }));
  const state = await h.service.config({ type: 'connect', url: 'http://localhost:4096/', username: 'opencode', password: 'pässword' });
  assert.deepEqual([state.selected.session_id, state.directory, state.nicknames.ses_keep, state.mode], ['ses_keep', '/workspace', 'Keep', 'new_chat']);
});

test('persistent secure state survives service recreation; disconnect removes it', async () => {
  const h = harness(); await connected(h);
  const { createService } = require('../src/plugin/index.js');
  const next = createService({ storage: h.storage, fetch: async () => response(null) });
  assert.equal((await next.config({ type: 'status' })).connected, true);
  await next.config({ type: 'disconnect' });
  assert.equal(h.storage.values.size, 0);
});

for (const url of ['ftp://localhost', 'http://user:pass@host', 'http://host?x=1', 'http://host#x', 'http://host/../x', 'http://host/%2e%2e/x', 'http://host\\x', 'http://host:99999', 'http://host:0', 'http://u:ser@host', 'http://host/..%2fsecret']) {
  test(`connect rejects unsafe or invalid URL: ${url}`, async () => {
    const h = harness();
    await assert.rejects(h.service.config({ type: 'connect', url, password: 'x' }));
    assert.equal(h.requests.length, 0);
  });
}

test('valid uppercase host and bracketed IPv6 URL are accepted and normalized', async () => {
  for (const url of ['http://LOCALHOST:4096/', 'http://[::1]:4096/']) {
    const h = harness();
    h.route('GET', '/api/info', response({ version: '2.2.1' }));
    const state = await h.service.config({ type: 'connect', url, password: 'secret' });
    assert.equal(state.connected, true);
    assert.equal(state.url, url.replace(/\/$/, ''));
  }
});

test('username colon and control characters reject before network', async () => {
  for (const username of ['bad:name', 'bad\nname', 'bad\u007fname']) {
    const h = harness();
    await assert.rejects(h.service.config({ type: 'connect', url: 'http://localhost', username, password: 'secret' }));
    assert.equal(h.requests.length, 0);
  }
});

test('directory accepts POSIX and Windows absolute server paths, rejects relative paths', async () => {
  const h = harness(); await connected(h);
  assert.equal((await h.service.config({ type: 'directory', directory: '/srv/project' })).directory, '/srv/project');
  assert.equal((await h.service.config({ type: 'directory', directory: 'C:\\workspace' })).directory, 'C:\\workspace');
  assert.equal((await h.service.config({ type: 'directory', directory: '\\\\server\\share' })).directory, '\\\\server\\share');
  await assert.rejects(h.service.config({ type: 'directory', directory: 'relative/path' }));
});

test('projects returns canonical server project directories', async () => {
  const h = harness(); await connected(h);
  h.route('GET', '/api/project', response([{ id: 'p1', name: 'Project', canonical: '/canonical', time: { created: 1, updated: 2 }, sandboxes: [] }]));
  const result = await h.service.config({ type: 'projects' });
  assert.equal(result.projects[0].directory, '/canonical');
});

test('config list consumes V2 page shape and pagination cursor', async () => {
  const h = harness(); await connected(h);
  h.route('GET', req => req.path === '/api/session' && !req.search.has('cursor'), response(page([session('ses_a')], 'cursor /?')));
  const first = await h.service.config({ type: 'list' });
  assert.equal(first.sessions[0].session_id, 'ses_a');
  assert.equal(first.next_cursor, 'cursor /?');
  h.route('GET', req => req.path === '/api/session' && req.search.get('cursor') === 'cursor /?', response(page([session('ses_b')])));
  const second = await h.service.config({ type: 'list', cursor: first.next_cursor });
  assert.equal(second.sessions[0].session_id, 'ses_b');
});

test('list excludes archived and child sessions and maps canonical directory', async () => {
  const h = harness(); await connected(h);
  h.route('GET', req => req.path === '/api/session', response(page([session('ses_a', 'A'), session('ses_b', 'B', { time: { archived: 1700000000 } }), session('ses_c', 'C', { parentID: 'ses_a' })])));
  const result = await h.service.config({ type: 'list' });
  assert.deepEqual(result.sessions.map(row => row.session_id), ['ses_a']);
  assert.equal(result.sessions[0].directory, '/workspace');
});

test('select validates live session and rejects archived session', async () => {
  const h = harness(); await connected(h);
  addLiveSession(h, 'ses_live');
  assert.equal((await h.service.config({ type: 'select', session_id: 'ses_live' })).selected.session_id, 'ses_live');
  addLiveSession(h, 'ses_old', session('ses_old', 'Old', { time: { archived: 1700000000 } }));
  await assert.rejects(h.service.config({ type: 'select', session_id: 'ses_old' }));
});

test('nickname collision and reserved names reject; blank nickname removes saved value', async () => {
  const h = harness(); await connected(h);
  for (const id of ['ses_a', 'ses_b']) addLiveSession(h, id);
  await h.service.config({ type: 'save_session', session_id: 'ses_a', nickname: 'Alpha' });
  addLiveSession(h, 'ses_b');
  await assert.rejects(h.service.config({ type: 'save_session', session_id: 'ses_b', nickname: 'alpha' }));
  addLiveSession(h, 'ses_b');
  await assert.rejects(h.service.config({ type: 'save_session', session_id: 'ses_b', nickname: 'new chat' }));
  addLiveSession(h, 'ses_a');
  const removed = await h.service.config({ type: 'save_session', session_id: 'ses_a', nickname: ' ' });
  assert.deepEqual(removed.nicknames, {});
});

test('disconnected and configured sources expose required envelope, values, and TTL without network', async () => {
  const h = harness();
  const disconnected = await h.service.source({ category: 'agent', item: 'configured' });
  assert.deepEqual(Object.keys(disconnected).sort(), ['instances', 'validUntilMs']);
  assert.equal(disconnected.validUntilMs, 1700000060000);
  assert.equal(disconnected.instances[0].instanceId, 'opencode');
  assert.equal(disconnected.instances[0].properties.configured.boolean.value, false);
  assert.equal(disconnected.instances[0].properties.name.shortText.text, 'New session');
  assert.equal(h.requests.length, 0);
});

test('new-chat configured source says New session even when prior default exists', async () => {
  const h = harness(); await connected(h);
  addLiveSession(h, 'ses_default');
  await h.service.config({ type: 'select', session_id: 'ses_default' });
  await h.service.config({ type: 'directory', directory: '/workspace' });
  await h.service.config({ type: 'mode', mode: 'new_chat' });
  const source = await h.service.source({ category: 'agent', item: 'configured' });
  assert.equal(source.instances[0].properties.name.shortText.text, 'New session');
  assert.equal(source.instances[0].properties.configured.boolean.value, true);
});

test('chat source emits exact instance properties, stable IDs, and 900-second TTL', async () => {
  const h = harness(); await connected(h);
  h.route('GET', '/api/session', response(page([session('ses_a', 'Alpha')])));
  const source = await h.service.source({ category: 'agent', item: 'chats' });
  assert.deepEqual(Object.keys(source).sort(), ['instances', 'validUntilMs']);
  assert.equal(source.validUntilMs, 1700000900000);
  assert.equal(source.instances[0].instanceId, 'ses_a');
  assert.deepEqual(Object.keys(source.instances[0].properties).sort(), ['name', 'title', 'url']);
  assert.equal(source.instances[0].properties.url.longText.text, `http://localhost:4096/server/${Buffer.from('http://localhost:4096').toString('base64url')}/session/ses_a`);
});

test('chat source uses fallback title when server omits optional title', async () => {
  const h = harness(); await connected(h);
  const missingTitle = session('ses_missing'); delete missingTitle.title;
  h.route('GET', '/api/session', response(page([missingTitle])));
  const source = await h.service.source({ category: 'agent', item: 'chats' });
  assert.equal(source.instances[0].properties.title.shortText.text, 'Untitled session');
});

test('direct ID send, returns queued receipt description and does not include model answer', async () => {
  const h = harness(); await connected(h); addPrompt(h, 'ses_a', 'Alpha');
  const result = await h.service.action({ action: 'send_to_agent', args: { message: 'hello', chat_id: 'ses_a' } });
  assert.match(result.text, /Alpha/);
  assert.deepEqual(result.refreshed, ['agent/chats', 'opencode/active_session', 'opencode/activity', 'opencode/reply', 'opencode/replies', 'opencode/chat_status', 'opencode/permission', 'opencode/question', 'opencode/job']);
  assert.equal(h.requests.filter(req => req.method === 'POST' && req.path.endsWith('/prompt')).length, 1);
  assert.deepEqual(h.requests.find(req => req.path.endsWith('/prompt')).body, { id: h.requests.find(req => req.path.endsWith('/prompt')).body.id, text: 'hello', delivery: 'queue' });
  assert.match(h.requests.find(req => req.path.endsWith('/prompt')).body.id, /^msg_/);
});

test('default target resolves selected session and list is not needed', async () => {
  const h = harness(); await connected(h); addLiveSession(h, 'ses_a');
  await h.service.config({ type: 'select', session_id: 'ses_a' });
  addPrompt(h, 'ses_a', 'Default');
  await h.service.action({ action: 'send_to_agent', args: { message: 'hello' } });
  assert.equal(h.requests.some(req => req.path === '/api/session' && req.method === 'GET'), false);
});

test('exact nickname resolves saved ID without listing', async () => {
  const h = harness(); await connected(h); addLiveSession(h, 'ses_a');
  await h.service.config({ type: 'save_session', session_id: 'ses_a', nickname: 'Work' });
  addPrompt(h, 'ses_a', 'Work');
  await h.service.action({ action: 'send_to_agent', args: { message: 'hello', chat_id: 'work' } });
  assert.equal(h.requests.some(req => req.path === '/api/session' && req.method === 'GET'), false);
});

test('title matching searches later pages and detects ambiguity there', async () => {
  const h = harness(); await connected(h);
  h.route('GET', req => req.path === '/api/session' && !req.search.has('cursor'), response(page([session('ses_a', 'Roadmap')], 'c2')));
  h.route('GET', req => req.path === '/api/session' && req.search.get('cursor') === 'c2', response(page([session('ses_b', 'Roadmap followup')])));
  await assert.rejects(h.service.action({ action: 'send_to_agent', args: { message: 'hello', chat_id: 'roadmap' } }));
  assert.equal(h.requests.some(req => req.method === 'POST'), false);
});

test('unique partial nickname resolves without title listing and ambiguous partial nickname never posts', async () => {
  const h = harness(); await connected(h); addLiveSession(h, 'ses_a');
  await h.service.config({ type: 'save_session', session_id: 'ses_a', nickname: 'Work project' });
  addPrompt(h, 'ses_a', 'Work project');
  await h.service.action({ action: 'send_to_agent', args: { message: 'hello', chat_id: 'Work' } });
  assert.equal(h.requests.some(req => req.path === '/api/session' && req.method === 'GET'), false);
  const postsBeforeAmbiguous = h.requests.filter(req => req.method === 'POST').length;
  addLiveSession(h, 'ses_b');
  await h.service.config({ type: 'save_session', session_id: 'ses_b', nickname: 'Work items' });
  h.route('GET', '/api/session', response(page([session('ses_a'), session('ses_b')])));
  await assert.rejects(h.service.action({ action: 'send_to_agent', args: { message: 'hello', chat_id: 'Work' } }), error => error.code === 'INVALID_ARGS');
  assert.equal(h.requests.filter(req => req.method === 'POST').length, postsBeforeAmbiguous);
});

test('duplicate IDs across pages are deduplicated before unique title match', async () => {
  const h = harness(); await connected(h);
  h.route('GET', req => req.path === '/api/session' && !req.search.has('cursor'), response(page([session('ses_a', 'Target')], 'c2')));
  h.route('GET', req => req.path === '/api/session' && req.search.get('cursor') === 'c2', response(page([session('ses_a', 'Target')])));
  addPrompt(h, 'ses_a', 'Target');
  await h.service.action({ action: 'send_to_agent', args: { message: 'hello', chat_id: 'Target' } });
  assert.equal(h.requests.filter(req => req.path.endsWith('/prompt')).length, 1);
});

test('repeated pagination cursor fails safe without sending', async () => {
  const h = harness(); await connected(h);
  h.route('GET', req => req.path === '/api/session' && !req.search.has('cursor'), response(page([session('ses_a', 'Target')], 'again')));
  h.route('GET', req => req.path === '/api/session' && req.search.get('cursor') === 'again', response(page([session('ses_b', 'Target')], 'again')));
  await assert.rejects(h.service.action({ action: 'send_to_agent', args: { message: 'hello', chat_id: 'Target' } }));
  assert.equal(h.requests.some(req => req.method === 'POST'), false);
});

test('title scan stops safely at 50-page limit', async () => {
  const h = harness(); await connected(h);
  for (let pageNumber = 1; pageNumber <= 50; pageNumber++) {
    const expectedCursor = pageNumber === 1 ? null : `cursor-${pageNumber - 1}`;
    h.route('GET', req => req.path === '/api/session' && (req.search.get('cursor') || null) === expectedCursor,
      response(page([session(`ses_${pageNumber}`, pageNumber === 50 ? 'Unique target' : `Other ${pageNumber}`)], `cursor-${pageNumber}`)));
  }
  await assert.rejects(h.service.action({ action: 'send_to_agent', args: { message: 'hello', chat_id: 'Unique target' } }));
  assert.equal(h.requests.filter(req => req.path === '/api/session' && req.method === 'GET').length, 50);
  assert.equal(h.requests.some(req => req.method === 'POST'), false);
});

test('new chat creates session in selected directory and sends once', async () => {
  const h = harness(); await connected(h);
  await h.service.config({ type: 'directory', directory: '/workspace' });
  h.route('POST', '/api/session', response({ data: session('ses_new', 'Pebble') }));
  h.route('POST', '/api/session/ses_new/prompt', req => response(makeAck('ses_new', req.body.id, 'hello')));
  await h.service.action({ action: 'send_to_agent', args: { message: 'hello', chat_id: 'NeW' } });
  assert.deepEqual(h.requests.find(req => req.path === '/api/session' && req.method === 'POST').body, { title: 'Pebble', location: { directory: '/workspace' } });
  assert.equal(h.requests.filter(req => req.path.endsWith('/prompt')).length, 1);
});

test('new chat without directory does not create or prompt', async () => {
  const h = harness(); await connected(h);
  await assert.rejects(h.service.action({ action: 'send_to_agent', args: { message: 'hello', chat_id: 'new' } }));
  assert.equal(h.requests.some(req => req.method === 'POST'), false);
});

test('invalid args, unknown action, blank/oversized prompt, and partial session ID never post', async () => {
  const h = harness(); await connected(h);
  for (const input of [
    { action: 'unknown', args: { message: 'x' } },
    { action: 'send_to_agent', args: { message: ' ', extra: true } },
    { action: 'send_to_agent', args: { message: 'x'.repeat(16001) } }
  ]) await assert.rejects(h.service.action(input));
  h.route('GET', '/api/session', response(page([])));
  await assert.rejects(h.service.action({ action: 'send_to_agent', args: { message: 'hello', chat_id: 'ses' } }), error => error.code === 'INVALID_ARGS');
  assert.equal(h.requests.some(req => req.method === 'POST'), false);
});

test('archived explicit target never receives prompt', async () => {
  const h = harness(); await connected(h);
  addLiveSession(h, 'ses_old', session('ses_old', 'Old', { time: { archived: 1700000000 } }));
  await assert.rejects(h.service.action({ action: 'send_to_agent', args: { message: 'hello', chat_id: 'ses_old' } }));
  assert.equal(h.requests.some(req => req.method === 'POST'), false);
});

test('live-session response with wrong ID rejects before prompt', async () => {
  const h = harness(); await connected(h);
  h.route('GET', '/api/session/ses_requested', response({ data: session('ses_other') }));
  await assert.rejects(h.service.action({ action: 'send_to_agent', args: { message: 'hello', chat_id: 'ses_requested' } }));
  assert.equal(h.requests.some(req => req.method === 'POST'), false);
});

test('generated message IDs are unique across sends with deterministic injected randomness', async () => {
  const h = harness(); await connected(h);
  addPrompt(h, 'ses_a', 'Alpha'); addPrompt(h, 'ses_a', 'Alpha');
  for (let i = 0; i < 2; i++) await h.service.action({ action: 'send_to_agent', args: { message: 'hello', chat_id: 'ses_a' } });
  const ids = h.requests.filter(req => req.path.endsWith('/prompt')).map(req => req.body.id);
  assert.equal(new Set(ids).size, 2);
});

test('malformed prompt acknowledgment verifies direct message using V2 receipt shape', async () => {
  const h = harness(); await connected(h); addLiveSession(h, 'ses_a', session('ses_a', 'Alpha'));
  h.route('POST', '/api/session/ses_a/prompt', response({ nonsense: true }));
  h.route('GET', req => req.path.startsWith('/api/session/ses_a/message/'), req => {
    const id = req.path.split('/').pop(); return response({ data: { id, type: 'user', text: 'hello', time: { created: 1700000000 } } });
  });
  const result = await h.service.action({ action: 'send_to_agent', args: { message: 'hello', chat_id: 'ses_a' } });
  assert.match(result.text, /Alpha|ses_a/);
  assert.equal(h.requests.filter(req => req.path.endsWith('/prompt')).length, 1);
});

test('uncertain network failure checks inbox and accepts exact matching queued item without resend', async () => {
  const h = harness(); await connected(h); addLiveSession(h, 'ses_a');
  h.route('POST', '/api/session/ses_a/prompt', () => { throw Error('network down'); });
  h.route('GET', req => req.path.startsWith('/api/session/ses_a/message/'), response(null, 404));
  h.route('GET', '/api/session/ses_a/inbox', req => {
    const sent = h.requests.find(row => row.path.endsWith('/prompt'));
    return response({ data: [{ id: sent.body.id, sessionID: 'ses_a', type: 'user', payload: { text: 'hello' }, delivery: 'queue' }] });
  });
  await h.service.action({ action: 'send_to_agent', args: { message: 'hello', chat_id: 'ses_a' } });
  assert.equal(h.requests.filter(req => req.path.endsWith('/prompt')).length, 1);
  assert.equal(h.requests.filter(req => req.path.startsWith('/api/session/ses_a/message/')).length, 1);
  assert.equal(h.requests.filter(req => req.path === '/api/session/ses_a/inbox').length, 1);
});

for (const [label, result] of [
  ['JSON null', response(null)],
  ['204 no body', response(null, 204)],
  ['JSON false', response(false)],
  ['JSON zero', response(0)]
]) {
  test(`prompt ${label} requires delivery proof and reports uncertainty without resend`, async () => {
    const h = harness(); await connected(h); addLiveSession(h, 'ses_a');
    h.route('POST', '/api/session/ses_a/prompt', result);
    h.route('GET', req => req.path.startsWith('/api/session/ses_a/message/'), response(null, 404));
    h.route('GET', '/api/session/ses_a/inbox', response({ data: [] }));
    await assert.rejects(h.service.action({ action: 'send_to_agent', args: { message: 'hello', chat_id: 'ses_a' } }), error => error.code === 'PLUGIN_UNAVAILABLE');
    assert.equal(h.requests.filter(req => req.path.endsWith('/prompt')).length, 1);
    assert.equal(h.requests.filter(req => req.path.startsWith('/api/session/ses_a/message/')).length, 1);
    assert.equal(h.requests.filter(req => req.path === '/api/session/ses_a/inbox').length, 1);
  });
}

test('null prompt acknowledgment succeeds only when direct lookup proves matching delivery', async () => {
  const h = harness(); await connected(h); addLiveSession(h, 'ses_a');
  h.route('POST', '/api/session/ses_a/prompt', response(null));
  h.route('GET', req => req.path.startsWith('/api/session/ses_a/message/'), req => {
    const id = req.path.split('/').pop(); return response({ data: { id, type: 'user', text: 'hello', time: { created: 1 } } });
  });
  const result = await h.service.action({ action: 'send_to_agent', args: { message: 'hello', chat_id: 'ses_a' } });
  assert.ok(result.text);
  assert.equal(h.requests.filter(req => req.path.endsWith('/prompt')).length, 1);
  assert.equal(h.requests.filter(req => req.path === '/api/session/ses_a/inbox').length, 0);
});

test('mismatched uncertain receipt fails safe and never resends', async () => {
  const h = harness(); await connected(h); addLiveSession(h, 'ses_a');
  h.route('POST', '/api/session/ses_a/prompt', response(null, 503));
  h.route('GET', req => req.path.startsWith('/api/session/ses_a/message/'), response({ data: { id: 'other', type: 'user', text: 'different' } }));
  h.route('GET', '/api/session/ses_a/inbox', response({ data: [] }));
  await assert.rejects(h.service.action({ action: 'send_to_agent', args: { message: 'hello', chat_id: 'ses_a' } }));
  assert.equal(h.requests.filter(req => req.path.endsWith('/prompt')).length, 1);
});

test('NotAllowedError maps to permission denied and is not treated as uncertain delivery', async () => {
  const h = harness(); await connected(h); addLiveSession(h, 'ses_a');
  h.route('POST', '/api/session/ses_a/prompt', () => { const error = Error('blocked'); error.name = 'NotAllowedError'; throw error; });
  await assert.rejects(h.service.action({ action: 'send_to_agent', args: { message: 'hello', chat_id: 'ses_a' } }), error => error.code === 'PERMISSION_DENIED');
  assert.equal(h.requests.some(req => req.path.endsWith('/inbox') || req.path.includes('/message/')), false);
});

test('malformed prompt JSON triggers verification but never a second prompt', async () => {
  const h = harness(); await connected(h); addLiveSession(h, 'ses_a');
  h.route('POST', '/api/session/ses_a/prompt', { status: 200, async json() { throw Error('invalid JSON'); } });
  h.route('GET', req => req.path.startsWith('/api/session/ses_a/message/'), response(null, 404));
  h.route('GET', '/api/session/ses_a/inbox', response({ data: [] }));
  await assert.rejects(h.service.action({ action: 'send_to_agent', args: { message: 'hello', chat_id: 'ses_a' } }));
  assert.equal(h.requests.filter(req => req.path.endsWith('/prompt')).length, 1);
});

for (const [status, code] of [[401, 'AUTH_REQUIRED'], [403, 'PERMISSION_DENIED'], [429, 'RATE_LIMITED'], [409, 'PLUGIN_UNAVAILABLE']]) {
  test(`prompt HTTP ${status} maps to ${code} without automatic resend`, async () => {
    const h = harness(); await connected(h); addLiveSession(h, 'ses_a');
    h.route('POST', '/api/session/ses_a/prompt', response({ detail: 'private error' }, status));
    await assert.rejects(h.service.action({ action: 'send_to_agent', args: { message: 'hello', chat_id: 'ses_a' } }), error => error.code === code && !error.message.includes('private error'));
    assert.equal(h.requests.filter(req => req.path.endsWith('/prompt')).length, 1);
  });
}

test('5xx errors never echo prompt or credential and verification exhaustion never retries', async () => {
  const h = harness(); await connected(h); addLiveSession(h, 'ses_a');
  h.route('POST', '/api/session/ses_a/prompt', response({ error: 'secret pässword and hello' }, 500));
  h.route('GET', req => req.path.startsWith('/api/session/ses_a/message/'), response(null, 404));
  h.route('GET', '/api/session/ses_a/inbox', response({ data: [] }));
  await assert.rejects(h.service.action({ action: 'send_to_agent', args: { message: 'hello', chat_id: 'ses_a' } }), error => !/pässword|hello/.test(error.message));
  assert.equal(h.requests.filter(req => req.path.endsWith('/prompt')).length, 1);
});

test('runtime registers config, source, and action handlers without Node globals', async () => {
  const calls = [];
  const secureValues = new Map();
  const pebble = { secureStorage: {
    async getItem(key) { return secureValues.has(key) ? secureValues.get(key) : null; },
    async setItem(key, value) { secureValues.set(key, value); },
    async removeItem(key) { secureValues.delete(key); }
  }, refreshSources() {} };
  for (const name of ['registerConfigHandler', 'registerSourceHandler', 'registerActionHandler']) pebble[name] = handler => { calls.push([name, handler]); };
  const context = vm.createContext({ Pebble: pebble, fetch: async (url, options = {}) => {
    if (url.endsWith('/api/info')) return response({ version: '2.2.1' });
    if (url.endsWith('/api/session/ses_vm') && options.method !== 'POST') return response({ data: session('ses_vm', 'VM session') });
    if (url.endsWith('/api/session/ses_vm/prompt')) {
      const body = JSON.parse(options.body);
      return response(makeAck('ses_vm', body.id, body.text));
    }
    throw Error(`Unexpected VM fetch ${options.method || 'GET'} ${url}`);
  }, console, Promise, JSON, Math, Date, encodeURIComponent, decodeURIComponent, escape, unescape });
  const code = fs.readFileSync(path.join(__dirname, '../src/plugin/index.js'), 'utf8');
  vm.runInContext(code, context);
  assert.deepEqual(calls.map(row => row[0]).sort(), ['registerActionHandler', 'registerConfigHandler', 'registerSourceHandler']);
  assert.ok(calls.every(row => typeof row[1] === 'function'));
  const configHandler = calls.find(row => row[0] === 'registerConfigHandler')[1];
  const invokeConfig = request => new Promise(resolve => configHandler(request, resolve));
  let configReply;
  configReply = await invokeConfig({ type: 'status' });
  assert.equal(configReply.connected, false);
  await invokeConfig({ type: 'connect', url: 'http://localhost:4096', username: 'opencode', password: 'secret' });
  await invokeConfig({ type: 'select', session_id: 'ses_vm' });
  const sourceHandler = calls.find(row => row[0] === 'registerSourceHandler')[1];
  let sourceReply;
  await sourceHandler({ category: 'agent', item: 'configured' }, { data: value => { sourceReply = value; }, error: (code, message) => { throw Error(`${code}: ${message}`); } });
  assert.equal(sourceReply.instances[0].properties.configured.boolean.value, true);
  let sourceError;
  await sourceHandler({ category: 'agent', item: 'invalid' }, { data() {}, error: code => { sourceError = code; } });
  assert.equal(typeof sourceError, 'string');
  const configFailure = await invokeConfig({ type: 'connect', url: 'not a URL', password: 'secret' });
  assert.equal(typeof configFailure.error.code, 'string');
  const actionHandler = calls.find(row => row[0] === 'registerActionHandler')[1];
  let actionError;
  await actionHandler({ action: 'unknown', args: { message: 'hello' } }, { ok() {}, error: code => { actionError = code; } });
  assert.equal(typeof actionError, 'string');
  let actionResult;
  let actionFailure;
  await actionHandler({ action: 'send_to_agent', args: { message: 'hello' } }, {
    ok: value => { actionResult = value; }, error: code => { actionFailure = code; }
  });
  assert.equal(actionFailure, undefined);
  assert.match(actionResult.text, /VM session/);
});

test('settings inline scripts parse and settings page uses Pebble plugin message APIs safely', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/config.html'), 'utf8');
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
  assert.ok(scripts.length > 0);
  for (const script of scripts) new vm.Script(script);
  assert.match(html, /Pebble\.addEventListener\(['"]ready['"]/);
  assert.match(html, /sendMessage/);
  assert.match(html, /type="password"/);
  assert.match(html, /HTTP sends your password and pairing tokens in cleartext/);
  assert.doesNotMatch(html, /innerHTML\s*=/);
});
