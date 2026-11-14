'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  harness: makeHarness, response, session, page, makeAck, connected
} = require('./helpers');

const activeHarnesses = [];
function harness() { const h = makeHarness(); activeHarnesses.push(h); return h; }
test.afterEach(() => {
  for (const h of activeHarnesses.splice(0)) assert.deepEqual(h.unexpected, [], 'strict mock saw unexpected new-session request');
});

function addList(h, rows = []) {
  h.route('GET', req => req.path === '/api/session' && !req.search.has('cursor'), response(page(rows)));
}
function addReadyState(h, directory = '') {
  h.storage.values.set('opencode.plugin.state.v1', JSON.stringify({
    url: 'http://localhost:4096', username: 'opencode', password: 'secret', version: '2.2.1',
    mode: 'default_chat', directory, selected: null, nicknames: {}
  }));
}

test('chat source appends one exact virtual target after real rows when saved directory exists', async () => {
  const h = harness(); await connected(h);
  await h.service.config({ type: 'directory', directory: '/workspace' });
  addList(h, [session('ses_real', 'Existing')]);
  const result = await h.service.source({ category: 'agent', item: 'chats' });
  assert.equal(result.validUntilMs, 1700000900000);
  assert.deepEqual(result.instances.map(item => item.instanceId), ['ses_real', 'new']);
  assert.deepEqual(result.instances[0].properties, {
    name: { shortText: { text: 'Existing' } },
    title: { shortText: { text: 'Existing' } },
    url: { longText: { text: `http://localhost:4096/server/${Buffer.from('http://localhost:4096').toString('base64url')}/session/ses_real` } }
  });
  assert.deepEqual(result.instances[1], { instanceId: 'new', properties: {
    name: { shortText: { text: 'New' } }, title: { shortText: { text: 'New session' } }
  } });
  assert.equal(Object.hasOwn(result.instances[1].properties, 'url'), false);
});

test('saved POSIX, drive-letter, and UNC directories enable virtual target', async t => {
  for (const directory of ['/srv/project', 'C:\\workspace', '\\\\server\\share']) await t.test(directory, async () => {
    const h = harness(); await connected(h);
    const saved = await h.service.config({ type: 'directory', directory });
    assert.equal(saved.directory, directory);
    addList(h);
    const result = await h.service.source({ category: 'agent', item: 'chats' });
    assert.deepEqual(result.instances.map(item => item.instanceId), ['new']);
  });
});

test('without saved directory source contains real sessions only and does not create sessions', async () => {
  const h = harness(); await connected(h); addList(h, [session('ses_existing')]);
  const result = await h.service.source({ category: 'agent', item: 'chats' });
  assert.deepEqual(result.instances.map(item => item.instanceId), ['ses_existing']);
  assert.equal(h.requests.some(req => req.method === 'POST'), false);
});

test('unverified or disconnected state never offers virtual target', async t => {
  await t.test('disconnected', async () => {
    const h = harness();
    await assert.rejects(h.service.source({ category: 'agent', item: 'chats' }), error => error.code === 'AUTH_REQUIRED');
    assert.equal(h.requests.length, 0);
  });
  await t.test('unverified saved URL', async () => {
    const h = harness(); addReadyState(h, '/workspace');
    const raw = JSON.parse(h.storage.values.get('opencode.plugin.state.v1')); raw.version = '';
    h.storage.values.set('opencode.plugin.state.v1', JSON.stringify(raw));
    await assert.rejects(h.service.source({ category: 'agent', item: 'chats' }), error => error.code === 'AUTH_REQUIRED');
    assert.equal(h.requests.length, 0);
  });
});

test('invalid persisted relative directory does not offer synthetic target', async () => {
  const h = harness(); addReadyState(h, 'relative/path'); addList(h, [session('ses_real')]);
  const result = await h.service.source({ category: 'agent', item: 'chats' });
  assert.deepEqual(result.instances.map(item => item.instanceId), ['ses_real']);
});

test('list configuration remains real sessions only when directory is saved', async () => {
  const h = harness(); await connected(h); await h.service.config({ type: 'directory', directory: '/workspace' });
  h.route('GET', req => req.path === '/api/session' && !req.search.has('cursor'), response(page([session('ses_real')])));
  const listed = await h.service.config({ type: 'list' });
  assert.deepEqual(listed.sessions.map(item => item.session_id), ['ses_real']);
  assert.equal(listed.sessions.some(item => item.session_id === 'new'), false);
});

test('virtual picker remains available in default mode when directory saved', async () => {
  const h = harness(); await connected(h); await h.service.config({ type: 'directory', directory: '/workspace' });
  addList(h);
  const result = await h.service.source({ category: 'agent', item: 'chats' });
  assert.deepEqual(result.instances.map(item => item.instanceId), ['new']);
});

test('configured source reports ready in new-chat mode with directory and no default', async () => {
  const h = harness(); await connected(h);
  await h.service.config({ type: 'directory', directory: '/workspace' });
  await h.service.config({ type: 'mode', mode: 'new_chat' });
  const configured = await h.service.source({ category: 'agent', item: 'configured' });
  assert.equal(configured.instances[0].properties.configured.boolean.value, true);
  assert.equal(configured.instances[0].properties.name.shortText.text, 'New session');
});

test('repeated source reads append exactly one virtual item and never mutate API rows', async () => {
  const h = harness(); await connected(h); await h.service.config({ type: 'directory', directory: '/workspace' });
  const rows = [session('ses_real', 'Existing')];
  addList(h, rows); addList(h, rows);
  const first = await h.service.source({ category: 'agent', item: 'chats' });
  const second = await h.service.source({ category: 'agent', item: 'chats' });
  assert.equal(first.instances.filter(item => item.instanceId === 'new').length, 1);
  assert.equal(second.instances.filter(item => item.instanceId === 'new').length, 1);
  assert.deepEqual(first.instances.map(item => item.instanceId), second.instances.map(item => item.instanceId));
  assert.deepEqual(rows.map(item => item.id), ['ses_real']);
  assert.equal(h.requests.filter(req => req.method === 'POST').length, 0);
});

test('failed session list rejects source rather than returning a fabricated virtual picker', async () => {
  const h = harness(); await connected(h); await h.service.config({ type: 'directory', directory: '/workspace' });
  h.route('GET', req => req.path === '/api/session', response({ error: 'private credential data' }, 500));
  await assert.rejects(h.service.source({ category: 'agent', item: 'chats' }), error => error.code === 'PLUGIN_UNAVAILABLE' && !error.message.includes('private'));
  assert.equal(h.requests.some(req => req.method === 'POST'), false);
});

test('empty real page with directory yields exactly virtual target and reads only list endpoint', async () => {
  const h = harness(); await connected(h); await h.service.config({ type: 'directory', directory: '/workspace' }); addList(h);
  const result = await h.service.source({ category: 'agent', item: 'chats' });
  assert.deepEqual(result.instances.map(item => item.instanceId), ['new']);
  assert.deepEqual(h.requests.filter(req => req.path !== '/api/info').map(req => [req.method, req.path]), [['GET', '/api/session']]);
  assert.equal(h.requests.some(req => req.method === 'POST'), false);
});

test('selected virtual ID creates one session and queues one prompt with all source refreshes', async () => {
  const h = harness(); await connected(h); await h.service.config({ type: 'directory', directory: '/workspace' });
  addList(h, [session('ses_existing', 'Existing')]);
  const picker = await h.service.source({ category: 'agent', item: 'chats' });
  const selected = picker.instances.find(item => item.instanceId === 'new');
  assert.ok(selected, 'picker exposes documented new-session target');
  assert.deepEqual(selected.properties, { name: { shortText: { text: 'New' } }, title: { shortText: { text: 'New session' } } });
  h.route('POST', '/api/session', response({ data: session('ses_created', 'Pebble') }));
  h.route('POST', '/api/session/ses_created/prompt', req => response(makeAck('ses_created', req.body.id, req.body.text)));
  const result = await h.service.action({ action: 'send_to_agent', args: { message: 'create from picker', chat_id: selected.instanceId } });
  assert.deepEqual(h.requests.filter(req => req.method === 'POST').map(req => req.path), ['/api/session', '/api/session/ses_created/prompt']);
  assert.deepEqual(h.requests.find(req => req.method === 'POST' && req.path === '/api/session').body,
    { title: 'Pebble', location: { directory: '/workspace' } });
  assert.deepEqual(result.refreshed, ['agent/chats', 'opencode/active_session', 'opencode/activity', 'opencode/reply', 'opencode/replies', 'opencode/chat_status', 'opencode/permission', 'opencode/question', 'opencode/job', 'opencode/execution', 'opencode/queue', 'opencode/shell', 'opencode/command']);
});
