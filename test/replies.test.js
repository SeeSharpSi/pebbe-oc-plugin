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
    mode: 'default_chat', directory: '/workspace', selected: null, lastSessionID: null, nicknames: {}, ...state
  });
  return h;
}
test.afterEach(() => {
  for (const h of activeHarnesses.splice(0)) assert.deepEqual(h.unexpected, [], 'strict fetch mock saw unexpected replies request');
});

const source = h => h.service.source({ category: 'opencode', item: 'replies' });
const messagePath = id => `/api/session/${id}/message`;

function addList(h, rows) {
  h.route('GET', req => req.path === '/api/session' && !req.search.has('cursor'), response(page(rows)));
}
function addSession(h, id, title = `Session ${id}`) {
  h.route('GET', `/api/session/${id}`, response({ data: session(id, title) }));
}
function addMessages(h, id, messages) {
  function pageRoute() {
    h.route('GET', req => req.path === messagePath(id), req => {
      assert.equal(req.search.get('type'), 'assistant');
      const limit = Number(req.search.get('limit'));
      assert.ok(limit > 0 && limit <= 5);
      const offset = req.search.has('cursor') ? Number(req.search.get('cursor')) : 0;
      assert.equal(req.search.get('order'), offset === 0 ? 'desc' : null);
      const data = messages.slice(offset, offset + limit);
      const next = offset + limit < messages.length ? String(offset + limit) : null;
      if (next !== null) pageRoute();
      return response({ data, cursor: { next, previous: null } });
    });
  }
  pageRoute();
}
function textMessage(id, text, time = { created: 1700000000000, completed: 1700000001000 }) {
  return { id, type: 'assistant', time, content: [{ type: 'text', text }] };
}

test('replies manifest declares exact multiple-source contract, properties, and refresh', () => {
  const declared = manifest.plugin.sources.find(item => item.category === 'opencode' && item.items.length === 1 && item.items[0] === 'replies');
  assert.ok(declared);
  assert.deepEqual(declared, {
    category: 'opencode',
    items: ['replies'],
    properties: {
      name: ['shortText', 'longText'],
      title: ['longText'],
      session_id: ['longText'],
      message_id: ['longText'],
      text: ['shortText', 'longText'],
      updated: ['timestamp'],
      complete: ['boolean'],
      status: ['shortText', 'longText'],
      outcome: ['shortText', 'longText'],
      cost: ['numericValue', 'shortText'],
      tokens_input: ['numericValue'],
      tokens_output: ['numericValue'],
      tokens_reasoning: ['numericValue'],
      tokens_cache_read: ['numericValue'],
      tokens_cache_write: ['numericValue'],
      agent: ['longText'],
      model: ['longText'],
      is_default: ['boolean'],
      url: ['longText']
    },
    supportsMultiple: true,
    callerPermissions: [],
    suggestedRefreshIntervalSec: 60
  });
});

test('replies requires authentication before any request even with no focus', async () => {
  const h = newHarness();
  await assert.rejects(source(h), error => error.code === 'AUTH_REQUIRED');
  assert.equal(h.requests.length, 0);
});

test('no focus and empty recent list returns empty source after only the list GET', async () => {
  const h = harness();
  addList(h, []);
  const result = await source(h);
  assert.deepEqual(result, { validUntilMs: 1700000060000, instances: [] });
  assert.deepEqual(h.requests.map(req => [req.method, req.path]), [['GET', '/api/session']]);
});

test('orders default then last then recent root unarchived chats and deduplicates', async () => {
  const h = harness({
    selected: { session_id: 'ses_default', title: 'Default' },
    lastSessionID: 'ses_last',
    nicknames: { ses_default: 'Pinned' },
    reply_count: 10
  });
  addList(h, [
    session('ses_recent1', 'Recent one'),
    session('ses_default', 'Default', { time: { created: 1, updated: 2 } }),
    session('ses_recent2', 'Recent two'),
    session('ses_last', 'Last', { time: { created: 1, updated: 2 } }),
    session('ses_recent3', 'Recent three'),
    session('ses_child', 'Child', { parentID: 'ses_default' }),
    session('ses_archived', 'Archived', { time: { archived: 1700000000 } })
  ]);
  addSession(h, 'ses_default', 'Default');
  addSession(h, 'ses_last', 'Last');
  for (const id of ['ses_default', 'ses_last', 'ses_recent1', 'ses_recent2', 'ses_recent3']) {
    addMessages(h, id, [textMessage(`msg_${id}`, `answer ${id}`)]);
  }
  const result = await source(h);
  assert.equal(result.validUntilMs, 1700000060000);
  assert.deepEqual(result.instances.map(item => item.instanceId), ['ses_default', 'ses_last', 'ses_recent1', 'ses_recent2', 'ses_recent3']);
  assert.equal(result.instances[0].properties.is_default.boolean.value, true);
  assert.ok(result.instances.slice(1).every(item => item.properties.is_default.boolean.value === false));
  assert.deepEqual(h.requests.filter(req => req.path === messagePath('ses_default') || req.path === messagePath('ses_last')).length, 2);
  assert.ok(h.requests.every(req => req.method === 'GET'));
});

test('focus outside recent chats uses live session lookup while retaining priority order', async () => {
  const h = harness({
    selected: { session_id: 'ses_default', title: 'Stale selected title' },
    lastSessionID: 'ses_last',
    reply_count: 4
  });
  addList(h, [session('ses_recent', 'Recent')]);
  addSession(h, 'ses_default', 'Live default title');
  addSession(h, 'ses_last', 'Live last title');
  for (const [id, title] of [['ses_default', 'Live default title'], ['ses_last', 'Live last title'], ['ses_recent', 'Recent']]) {
    addMessages(h, id, [textMessage(`msg_${id}`, `answer ${id}`)]);
  }
  const result = await source(h);
  assert.deepEqual(result.instances.map(item => item.instanceId), ['ses_default', 'ses_last', 'ses_recent']);
  assert.equal(result.instances[0].properties.title.longText.text, 'Live default title');
  assert.equal(result.instances[1].properties.title.longText.text, 'Live last title');
  assert.ok(h.requests.some(req => req.path === '/api/session/ses_default'));
  assert.ok(h.requests.some(req => req.path === '/api/session/ses_last'));
});

test('uses default count 10, configured lower counts, and caps at 20', async t => {
  await t.test('default 10', async () => {
    const h = harness();
    const rows = Array.from({ length: 12 }, (_, index) => session(`ses_d${index}`, `Default ${index}`));
    addList(h, rows);
    for (const row of rows) addMessages(h, row.id, [textMessage(`msg_${row.id}`, `answer ${row.id}`)]);
    const result = await source(h);
    assert.deepEqual(result.instances.map(item => item.instanceId), rows.slice(0, 10).map(row => row.id));
  });
  await t.test('configured count 3', async () => {
    const h = harness({ reply_count: 3 });
    const rows = Array.from({ length: 5 }, (_, index) => session(`ses_c${index}`, `Configured ${index}`));
    addList(h, rows);
    for (const row of rows) addMessages(h, row.id, [textMessage(`msg_${row.id}`, `answer ${row.id}`)]);
    assert.deepEqual((await source(h)).instances.map(item => item.instanceId), rows.slice(0, 3).map(row => row.id));
  });
  await t.test('maximum 20', async () => {
    const h = harness({ reply_count: 20 });
    const rows = Array.from({ length: 25 }, (_, index) => session(`ses_m${index}`, `Maximum ${index}`));
    addList(h, rows);
    for (const row of rows) addMessages(h, row.id, [textMessage(`msg_${row.id}`, `answer ${row.id}`)]);
    const result = await source(h);
    assert.equal(result.instances.length, 20);
    assert.deepEqual(result.instances.map(item => item.instanceId), rows.slice(0, 20).map(row => row.id));
  });
  await t.test('configured count 1', async () => {
    const h = harness({ reply_count: 1 });
    addList(h, [session('ses_one', 'One'), session('ses_two', 'Two')]);
    addMessages(h, 'ses_one', [textMessage('msg_one', 'answer one')]);
    assert.deepEqual((await source(h)).instances.map(item => item.instanceId), ['ses_one']);
  });
});

test('one instance is emitted per included session even when no reply text exists', async t => {
  await t.test('textless history', async () => {
    const h = harness({ selected: { session_id: 'ses_idle', title: 'Idle title' } });
    addList(h, []);
    addSession(h, 'ses_idle', 'Idle title');
    addMessages(h, 'ses_idle', [
      { id: 'msg_tool', type: 'assistant', time: { created: 1000 }, content: [{ type: 'tool', state: { output: 'private tool output' } }] }
    ]);
    const result = await source(h);
    assert.equal(result.instances.length, 1);
    const instance = result.instances[0];
    assert.equal(instance.instanceId, 'ses_idle');
    assert.deepEqual(Object.keys(instance.properties).sort(), ['cost', 'is_default', 'name', 'session_id', 'status', 'title', 'tokens_cache_read', 'tokens_cache_write', 'tokens_input', 'tokens_output', 'tokens_reasoning', 'url']);
    assert.equal(instance.properties.status.shortText.text, 'Idle');
    assert.equal(instance.properties.status.longText.text, 'No reply');
    assert.equal(instance.properties.is_default.boolean.value, true);
    assert.equal(JSON.stringify(instance.properties).includes('private'), false);
  });
  await t.test('empty history', async () => {
    const h = harness({ selected: { session_id: 'ses_empty', title: 'Empty title' } });
    addList(h, []);
    addSession(h, 'ses_empty', 'Empty title');
    addMessages(h, 'ses_empty', []);
    const instance = (await source(h)).instances[0];
    assert.equal(instance.properties.status.shortText.text, 'Idle');
    assert.equal(instance.properties.status.longText.text, 'No reply');
    assert.equal(Object.hasOwn(instance.properties, 'message_id'), false);
    assert.equal(Object.hasOwn(instance.properties, 'text'), false);
    assert.equal(Object.hasOwn(instance.properties, 'updated'), false);
    assert.equal(Object.hasOwn(instance.properties, 'complete'), false);
  });
});

test('extracts the newest text-bearing assistant message without leaking reasoning or tool payloads', async () => {
  const id = 'ses_text';
  const unicodeName = Array.from({ length: 8 }, (_, index) => String.fromCodePoint(0x1f600 + index)).join('');
  const h = harness({ selected: { session_id: id, title: 'Session title' }, nicknames: { [id]: unicodeName } });
  addList(h, []);
  addSession(h, id, 'Session title');
  addMessages(h, id, [
    { id: 'msg_textless', type: 'assistant', time: { created: 1700000009000, completed: 1700000009500 }, content: [
      { type: 'reasoning', text: 'private reasoning marker' },
      { type: 'tool', state: { output: 'private tool marker' } }
    ] },
    { id: 'msg_new', type: 'assistant', time: { created: 1700000123456, completed: 1700000456789 }, content: [
      { type: 'reasoning', text: 'private reasoning marker' },
      { type: 'tool', state: { output: 'private tool marker' } },
      { type: 'text', text: 'hello ' },
      { type: 'text', text: 'world' }
    ] },
    textMessage('msg_old', 'older answer', { created: 1000 })
  ]);
  const result = await source(h);
  assert.equal(result.validUntilMs, 1700000060000);
  const props = result.instances[0].properties;
  assert.equal([...props.name.shortText.text].length, 7);
  assert.equal(props.name.shortText.text, [...unicodeName].slice(0, 7).join(''));
  assert.equal(props.name.longText.text, unicodeName);
  assert.equal(props.title.longText.text, 'Session title');
  assert.equal(props.session_id.longText.text, id);
  assert.equal(props.is_default.boolean.value, true);
  assert.equal(props.message_id.longText.text, 'msg_new');
  assert.equal(props.text.shortText.text, 'hello w');
  assert.equal(props.text.longText.text, 'hello world');
  assert.equal(props.updated.timestamp.value, 1700000456);
  assert.equal(props.complete.boolean.value, true);
  assert.deepEqual([props.status.shortText.text, props.status.longText.text], ['Done', 'Done']);
  assert.match(props.url.longText.text, /session\/ses_text$/);
  assert.equal(JSON.stringify(props).includes('private'), false);
  assert.ok(h.requests.every(req => req.method === 'GET'));
});

test('maps streaming, error, and long reply text using the shared reply contract', async t => {
  await t.test('writing', async () => {
    const id = 'ses_stream';
    const h = harness({ selected: { session_id: id, title: 'Stream' } });
    addList(h, []);
    addSession(h, id, 'Stream');
    addMessages(h, id, [{ id: 'msg_stream', type: 'assistant', time: { created: 1700000123456 }, content: [{ type: 'text', text: 'partial' }] }]);
    const props = (await source(h)).instances[0].properties;
    assert.equal(props.updated.timestamp.value, 1700000123);
    assert.equal(props.complete.boolean.value, false);
    assert.deepEqual([props.status.shortText.text, props.status.longText.text], ['Writing', 'Writing']);
  });
  await t.test('error', async () => {
    const id = 'ses_error';
    const h = harness({ selected: { session_id: id, title: 'Error' } });
    addList(h, []);
    addSession(h, id, 'Error');
    addMessages(h, id, [{ id: 'msg_error', type: 'assistant', time: { created: 12000, completed: 13000 }, error: { message: 'private error marker' }, content: [{ type: 'text', text: 'answer' }] }]);
    const props = (await source(h)).instances[0].properties;
    assert.equal(props.updated.timestamp.value, 13);
    assert.equal(props.complete.boolean.value, true);
    assert.deepEqual([props.status.shortText.text, props.status.longText.text], ['Error', 'Error']);
    assert.equal(JSON.stringify(props).includes('private'), false);
  });
  await t.test('finish error', async () => {
    const id = 'ses_finish_error';
    const h = harness({ selected: { session_id: id, title: 'Finish error' } });
    addList(h, []);
    addSession(h, id, 'Finish error');
    addMessages(h, id, [{ id: 'msg_finish', type: 'assistant', time: { created: 12000, completed: 13000 }, finish: 'error', content: [{ type: 'text', text: 'answer' }] }]);
    assert.equal((await source(h)).instances[0].properties.status.shortText.text, 'Error');
  });
  await t.test('long Unicode text clips at 4096 code points', async () => {
    const id = 'ses_long';
    const text = Array.from({ length: 5000 }, (_, index) => String.fromCodePoint(0x1f600 + index % 50)).join('');
    const h = harness({ selected: { session_id: id, title: 'Long' } });
    addList(h, []);
    addSession(h, id, 'Long');
    addMessages(h, id, [textMessage('msg_long', text)]);
    const props = (await source(h)).instances[0].properties;
    assert.equal([...props.text.longText.text].length, 4096);
    assert.equal(props.text.longText.text, [...text].slice(0, 4096).join(''));
    assert.equal([...props.text.shortText.text].length, 7);
  });
});

test('malformed list or message responses reject the whole source instead of returning partial rows', async t => {
  await t.test('malformed list envelope', async () => {
    const h = harness();
    h.route('GET', '/api/session', response({ data: [] }));
    await assert.rejects(source(h), error => error.code === 'PLUGIN_UNAVAILABLE');
  });
  await t.test('malformed list data', async () => {
    const h = harness();
    h.route('GET', '/api/session', response({ data: { id: 'bad' }, cursor: { next: null, previous: null } }));
    await assert.rejects(source(h), error => error.code === 'PLUGIN_UNAVAILABLE');
  });
  await t.test('one malformed message response rejects valid siblings', async () => {
    const h = harness();
    addList(h, [session('ses_ok', 'OK'), session('ses_bad', 'Bad')]);
    addMessages(h, 'ses_ok', [textMessage('msg_ok', 'answer')]);
    h.route('GET', req => req.path === messagePath('ses_bad'), response({ data: { id: 'bad' }, cursor: {} }));
    await assert.rejects(source(h), error => error.code === 'PLUGIN_UNAVAILABLE');
  });
  await t.test('unsupported content part rejects', async () => {
    const h = harness();
    addList(h, [session('ses_part', 'Part')]);
    addMessages(h, 'ses_part', [{ id: 'msg_part', type: 'assistant', time: { created: 1000 }, content: [{ type: 'image', path: 'private.png' }] }]);
    await assert.rejects(source(h), error => error.code === 'PLUGIN_UNAVAILABLE');
  });
});

test('bounds message request concurrency to four and uses only GET', async () => {
  const h = harness({ reply_count: 20 });
  const ids = Array.from({ length: 8 }, (_, index) => `ses_${index}`);
  addList(h, ids.map(id => session(id, `Session ${id}`)));
  let inFlight = 0;
  let peak = 0;
  const delayed = payload => async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise(resolve => setImmediate(resolve));
    inFlight -= 1;
    return response(payload);
  };
  for (const id of ids) {
    h.route('GET', req => req.path === messagePath(id), delayed({ data: [textMessage(`msg_${id}`, `answer ${id}`)], cursor: { next: null, previous: null } }));
  }
  const result = await source(h);
  assert.equal(result.instances.length, ids.length);
  assert.ok(peak <= 4, `peak concurrency ${peak} exceeded 4`);
  assert.ok(h.requests.every(req => req.method === 'GET'));
  assert.equal(h.requests.filter(req => req.path !== '/api/session').length, ids.length);
});
