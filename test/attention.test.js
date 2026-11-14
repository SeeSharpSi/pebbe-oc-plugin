'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const manifest = require('../package.json').pebble;
const { harness: newHarness, response, session, page } = require('./helpers');

const KEY = 'opencode.plugin.state.v1';
const activeHarnesses = [];
function harness(state = {}) {
  const h = newHarness();
  activeHarnesses.push(h);
  h.storage.values.set(KEY, {
    url: 'http://localhost:4096', username: 'opencode', password: 'pässword', version: '2.2.1',
    mode: 'default_chat', directory: '/workspace', selected: null, lastSessionID: null,
    nicknames: {}, reply_count: 10, default_delivery: 'queue', auth_method: 'password', last_seen: {}, ...state
  });
  return h;
}
test.afterEach(() => {
  for (const h of activeHarnesses.splice(0)) assert.deepEqual(h.unexpected, [], 'strict mock saw unexpected attention request');
});

const source = (h, item) => h.service.source({ category: 'opencode', item });
const messagePath = id => `/api/session/${id}/message`;
function addList(h, rows) {
  h.route('GET', req => req.path === '/api/session' && !req.search.has('cursor'), response(page(rows)));
}
function addPending(h, permissions = [], forms = []) {
  h.route('GET', '/api/permission/request', response({ location: {}, data: permissions }));
  h.route('GET', '/api/form', response({ location: {}, data: forms }));
}
function addSession(h, id, title = `Session ${id}`, extra = {}) {
  h.route('GET', `/api/session/${id}`, response({ data: session(id, title, extra) }));
}
function addMessages(h, id, messages) {
  h.route('GET', req => req.path === messagePath(id), response({ data: messages, cursor: { next: null, previous: null } }));
}
function textMessage(id, text, time = { created: 1700000000000, completed: 1700000001000 }) {
  return { id, type: 'assistant', time, content: [{ type: 'text', text }] };
}
function permission(id, sessionID, action = 'shell', resources = ['git push']) {
  return { id, sessionID, action, resources };
}
function form(id, sessionID, title = 'Question') {
  return { id, sessionID, title, fields: [{ key: 'answer', type: 'string' }] };
}
function action(h, name, args) { return h.service.action({ action: name, args }); }

test('manifest declares chat status, permission source, and attention actions', () => {
  const sources = manifest.plugin.sources;
  const status = sources.find(item => item.items[0] === 'chat_status');
  assert.ok(status);
  assert.equal(status.supportsMultiple, true);
  assert.equal(status.suggestedRefreshIntervalSec, 20);
  assert.deepEqual(status.properties, {
    name: ['shortText', 'longText'], title: ['longText'], session_id: ['longText'],
    message_id: ['longText'], needs_action: ['boolean'], reason: ['shortText', 'longText'],
    permission_count: ['numericValue', 'shortText'], question_count: ['numericValue', 'shortText'],
    unread: ['boolean'], updated: ['timestamp'], is_default: ['boolean'],
    is_subagent: ['boolean'], url: ['longText'], outcome: ['shortText', 'longText'], cost: ['numericValue', 'shortText'],
    tokens_input: ['numericValue'], tokens_output: ['numericValue'], tokens_reasoning: ['numericValue'],
    tokens_cache_read: ['numericValue'], tokens_cache_write: ['numericValue'], agent: ['longText'], model: ['longText']
  });
  const permissions = sources.find(item => item.items[0] === 'permission');
  assert.ok(permissions);
  assert.equal(permissions.supportsMultiple, true);
  assert.deepEqual(permissions.properties, {
    name: ['shortText', 'longText'], title: ['longText'], session_id: ['longText'],
    request_id: ['longText'], action: ['shortText', 'longText'], resources: ['longText'],
    message: ['longText'], url: ['longText']
  });
  const approve = manifest.plugin.actions.find(item => item.name === 'approve_permission');
  assert.deepEqual(approve.parameters.properties.decision.enum, ['once', 'reject']);
  assert.equal(approve.destructive, true);
  assert.equal(approve.requiresConfirmation, true);
  const read = manifest.plugin.actions.find(item => item.name === 'mark_chat_read');
  assert.deepEqual(read.parameters.required, ['session_id']);
  assert.equal(read.destructive, false);
  assert.deepEqual(manifest.plugin.actions.find(item => item.name === 'answer_question').targets, ['opencode/question', 'opencode/chat_status']);
});

test('attention sources require authentication before HTTP', async () => {
  const h = newHarness();
  await assert.rejects(source(h, 'chat_status'), error => error.code === 'AUTH_REQUIRED');
  await assert.rejects(source(h, 'permission'), error => error.code === 'AUTH_REQUIRED');
  assert.equal(h.requests.length, 0);
});

test('healthy empty attention sources return empty lists', async () => {
  const h = harness();
  addList(h, []);
  addPending(h);
  assert.deepEqual(await source(h, 'chat_status'), { validUntilMs: 1700000020000, instances: [] });
  assert.equal(h.requests.filter(req => req.method === 'GET').length, 3);
  h.route('GET', '/api/permission/request', response({ location: {}, data: [] }));
  assert.deepEqual(await source(h, 'permission'), { validUntilMs: 1700000020000, instances: [] });
});

test('chat status orders chats and combines permission, question, unread, and subagent state', async () => {
  const h = harness({
    selected: { session_id: 'ses_default', title: 'Default' },
    lastSessionID: 'ses_last',
    nicknames: { ses_default: 'Pinned' },
    reply_count: 2,
    last_seen: { ses_default: 'msg_default' }
  });
  addList(h, [
    session('ses_recent1', 'Recent one'),
    session('ses_recent2', 'Recent two'),
    session('ses_default', 'Default'),
    session('ses_last', 'Last')
  ]);
  addPending(h, [permission('perm_1', 'ses_recent1')], [
    form('form_default', 'ses_default'),
    form('form_child', 'ses_child')
  ]);
  addSession(h, 'ses_child', 'Child', { parentID: 'ses_default' });
  addMessages(h, 'ses_default', [textMessage('msg_default', 'default answer')]);
  addMessages(h, 'ses_last', [textMessage('msg_last', 'last answer')]);
  addMessages(h, 'ses_recent1', [textMessage('msg_recent1', 'recent answer')]);
  addMessages(h, 'ses_recent2', []);
  addMessages(h, 'ses_child', []);

  const result = await source(h, 'chat_status');
  assert.equal(result.validUntilMs, 1700000020000);
  assert.deepEqual(result.instances.map(item => item.instanceId), ['ses_default', 'ses_last', 'ses_recent1', 'ses_recent2', 'ses_child']);
  const byID = Object.fromEntries(result.instances.map(item => [item.instanceId, item.properties]));
  assert.equal(byID.ses_default.name.shortText.text, 'Pinned');
  assert.equal(byID.ses_default.is_default.boolean.value, true);
  assert.deepEqual([byID.ses_default.reason.longText.text, byID.ses_default.question_count.numericValue.value, byID.ses_default.unread.boolean.value], ['Question', 1, false]);
  assert.deepEqual([byID.ses_last.reason.longText.text, byID.ses_last.unread.boolean.value, byID.ses_last.needs_action.boolean.value], ['Unread', true, true]);
  assert.equal(byID.ses_last.message_id.longText.text, 'msg_last');
  assert.equal(Object.hasOwn(byID.ses_recent2, 'message_id'), false);
  assert.deepEqual([byID.ses_recent1.reason.longText.text, byID.ses_recent1.permission_count.numericValue.value], ['Permission', 1]);
  assert.deepEqual([byID.ses_recent2.reason.longText.text, byID.ses_recent2.needs_action.boolean.value], ['None', false]);
  assert.deepEqual([byID.ses_child.reason.longText.text, byID.ses_child.is_subagent.boolean.value], ['Question', true]);
  assert.ok(result.instances.every(item => item.properties.updated.timestamp.value >= 0));
});

test('mark_chat_read stores the latest message and clears unread status', async () => {
  const h = harness({ selected: { session_id: 'ses_a', title: 'Alpha' }, last_seen: {} });
  addList(h, [session('ses_a', 'Alpha')]);
  addPending(h);
  addMessages(h, 'ses_a', [textMessage('msg_a', 'answer')]);
  assert.equal((await source(h, 'chat_status')).instances[0].properties.unread.boolean.value, true);

  addSession(h, 'ses_a', 'Alpha');
  addMessages(h, 'ses_a', [textMessage('msg_a', 'answer')]);
  const marked = await action(h, 'mark_chat_read', { session_id: 'ses_a' });
  assert.match(marked.text, /marked read/i);
  assert.deepEqual(marked.refreshed, ['opencode/chat_status']);
  assert.equal(JSON.parse(h.storage.values.get(KEY)).last_seen.ses_a, 'msg_a');

  addList(h, [session('ses_a', 'Alpha')]);
  addPending(h);
  addMessages(h, 'ses_a', [textMessage('msg_a', 'answer')]);
  assert.equal((await source(h, 'chat_status')).instances[0].properties.unread.boolean.value, false);
});

test('permission source lists request details in stable order', async () => {
  const h = harness();
  addPending(h, [permission('perm_b', 'ses_b', 'edit', ['src/app.js']), permission('perm_a', 'ses_a', 'shell', ['git push'])]);
  addList(h, [session('ses_a', 'Alpha')]);
  addSession(h, 'ses_b', 'Beta');
  const result = await source(h, 'permission');
  assert.deepEqual(result.instances.map(item => item.instanceId), ['ses_a:perm_a', 'ses_b:perm_b']);
  const first = result.instances[0].properties;
  assert.equal(first.name.shortText.text, 'Alpha');
  assert.equal(first.request_id.longText.text, 'perm_a');
  assert.equal(first.action.longText.text, 'shell');
  assert.equal(first.resources.longText.text, '["git push"]');
  assert.match(first.url.longText.text, /session\/ses_a$/);
});

test('approve_permission checks fresh detail and sends one exact once response', async () => {
  const h = harness();
  addSession(h, 'ses_a', 'Alpha');
  h.route('GET', '/api/session/ses_a/permission/perm_a', response({ data: permission('perm_a', 'ses_a', 'shell', ['git push']) }));
  h.route('POST', '/api/session/ses_a/permission/perm_a/reply', req => {
    assert.deepEqual(req.body, { decision: 'once', message: 'Approved for this push' });
    return response(null, 204);
  });
  const result = await action(h, 'approve_permission', { session_id: 'ses_a', request_id: 'perm_a', message: 'Approved for this push' });
  assert.match(result.text, /approved/i);
  assert.equal(h.requests.filter(req => req.method === 'POST').length, 1);
});

test('approve_permission rejects invalid decisions before HTTP and maps stale requests safely', async () => {
  const h = harness();
  for (const args of [null, {}, { session_id: 'ses_a', request_id: 'perm_a', decision: 'always' }, { session_id: 'ses_a', request_id: 'perm_a', decision: null }, { session_id: 'ses_a', request_id: '', decision: 'once' }]) {
    await assert.rejects(action(h, 'approve_permission', args), error => error.code === 'INVALID_ARGS');
  }
  assert.equal(h.requests.length, 0);
  addSession(h, 'ses_a', 'Alpha');
  h.route('GET', '/api/session/ses_a/permission/perm_a', response({}, 404));
  await assert.rejects(action(h, 'approve_permission', { session_id: 'ses_a', request_id: 'perm_a' }), error => error.code === 'INVALID_ARGS');
  assert.equal(h.requests.filter(req => req.method === 'POST').length, 0);
});

test('approve_permission failure never retries the reply POST', async () => {
  for (const [status, code] of [[400, 'INVALID_ARGS'], [404, 'INVALID_ARGS'], [403, 'PERMISSION_DENIED'], [429, 'RATE_LIMITED'], [500, 'PLUGIN_UNAVAILABLE']]) {
    const h = harness();
    addSession(h, 'ses_a', 'Alpha');
    h.route('GET', '/api/session/ses_a/permission/perm_a', response({ data: permission('perm_a', 'ses_a') }));
    h.route('POST', '/api/session/ses_a/permission/perm_a/reply', response({ detail: 'private' }, status));
    await assert.rejects(action(h, 'approve_permission', { session_id: 'ses_a', request_id: 'perm_a', decision: 'reject' }), error => error.code === code && !error.message.includes('private'));
    assert.equal(h.requests.filter(req => req.method === 'POST').length, 1);
  }
});

test('malformed pending lists fail attention sources instead of fabricating state', async () => {
  const h = harness();
  addList(h, []);
  h.route('GET', '/api/permission/request', response({ data: { bad: true } }));
  h.route('GET', '/api/form', response({ location: {}, data: [] }));
  await assert.rejects(source(h, 'chat_status'), error => error.code === 'PLUGIN_UNAVAILABLE');

  const p = harness();
  p.route('GET', '/api/permission/request', response({ location: {}, data: [{ id: 'perm', sessionID: 'bad', action: 'shell', resources: [] }] }));
  await assert.rejects(source(p, 'permission'), error => error.code === 'PLUGIN_UNAVAILABLE');
});
