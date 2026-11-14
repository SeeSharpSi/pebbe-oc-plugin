'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { harness: newHarness, response, session, makeAck } = require('./helpers');

const activeHarnesses = [];
function harness(state = {}) {
  const h = newHarness();
  activeHarnesses.push(h);
  h.storage.values.set('opencode.plugin.state.v1', {
    url: 'http://localhost:4096', username: 'opencode', password: 'pässword', version: '2.2.1',
    mode: 'default_chat', directory: '/workspace', selected: null, lastSessionID: null, nicknames: {}, ...state
  });
  return h;
}
test.afterEach(() => {
  for (const h of activeHarnesses.splice(0)) assert.deepEqual(h.unexpected, [], 'strict mock saw unexpected source request');
});

const sessionResponse = id => response({ data: session(id, 'Reply target') });
const replyPath = id => `/api/session/${id}/message`;
const addReply = (h, id, messages) => {
  function routePage() {
    h.route('GET', req => req.path === replyPath(id), req => {
      assert.equal(req.search.get('type'), 'assistant');
      const limit = Number(req.search.get('limit'));
      assert.ok(limit > 0 && limit <= 5);
      const offset = req.search.has('cursor') ? Number(req.search.get('cursor')) : 0;
      assert.equal(req.search.get('order'), offset === 0 ? 'desc' : null);
      const data = messages.slice(offset, offset + limit);
      const next = offset + limit < messages.length ? String(offset + limit) : null;
      if (next !== null) routePage();
      return response({ data, cursor: { next, previous: null } });
    });
  }
  routePage();
};
const source = (h, item) => h.service.source({ category: 'opencode', item });

test('reply requires authentication even when there is no focused session', async () => {
  const h = newHarness();
  await assert.rejects(source(h, 'reply'), error => error.code === 'AUTH_REQUIRED');
  assert.equal(h.requests.length, 0);
});

test('reply with no focus returns empty list without HTTP', async () => {
  const h = harness();
  const result = await source(h, 'reply');
  assert.deepEqual(result, { validUntilMs: 1700000020000, instances: [] });
  assert.equal(h.requests.length, 0);
});

test('reply reads selected session in default mode and extracts newest assistant text safely', async () => {
  const id = 'ses_reply';
  const unicodeName = Array.from({ length: 8 }, (_, index) => String.fromCodePoint(0x1f600 + index)).join('');
  const h = harness({ selected: { session_id: id, title: 'Selected' }, lastSessionID: 'ses_other', nicknames: { [id]: unicodeName } });
  h.route('GET', `/api/session/${id}`, sessionResponse(id));
  addReply(h, id, [
    { id: 'msg_new', type: 'assistant', time: { created: 1700000123456, completed: 1700000456789 }, content: [
      { type: 'reasoning', text: 'private reasoning marker' }, { type: 'tool', state: { output: 'private tool marker' } },
      { type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }
    ] },
    { id: 'msg_old', type: 'assistant', time: { created: 1000 }, content: [{ type: 'text', text: 'older answer' }] }
  ]);
  const result = await source(h, 'reply');
  assert.equal(result.validUntilMs, 1700000020000);
  assert.equal(result.instances.length, 1);
  const instance = result.instances[0];
  const props = instance.properties;
  assert.equal(instance.instanceId, id);
  assert.equal(props.name.shortText.text, [...unicodeName].slice(0, 7).join(''));
  assert.equal([...props.name.shortText.text].length, 7);
  assert.equal(props.name.longText.text, unicodeName);
  assert.equal(props.session_id.longText.text, id);
  assert.equal(props.message_id.longText.text, 'msg_new');
  assert.equal(props.text.longText.text, 'hello world');
  assert.equal(props.updated.timestamp.value, 1700000456);
  assert.equal(props.complete.boolean.value, true);
  assert.equal(props.status.shortText.text, 'Done');
  assert.equal(JSON.stringify(props).includes('private'), false);
  assert.ok(h.requests.every(req => req.method === 'GET'));
});

test('reply new-chat mode focuses last delivered session, not stale selected session', async () => {
  const h = harness({ mode: 'new_chat', selected: { session_id: 'ses_old', title: 'Old' }, lastSessionID: 'ses_new' });
  h.route('GET', '/api/session/ses_new', sessionResponse('ses_new'));
  addReply(h, 'ses_new', [{ id: 'msg_new', type: 'assistant', time: { created: 1700000000000 }, content: [{ type: 'text', text: 'new target' }] }]);
  const result = await source(h, 'reply');
  assert.equal(result.instances[0].instanceId, 'ses_new');
  assert.equal(result.instances[0].properties.text.longText.text, 'new target');
});

test('reply falls back to last session when selected ID is invalid', async () => {
  const h = harness({ selected: { session_id: '../invalid', title: 'Stale' }, lastSessionID: 'ses_last' });
  h.route('GET', '/api/session/ses_last', sessionResponse('ses_last'));
  addReply(h, 'ses_last', [{ id: 'msg_last', type: 'assistant', time: { created: 1000 }, content: [{ type: 'text', text: 'fallback' }] }]);
  assert.equal((await source(h, 'reply')).instances[0].instanceId, 'ses_last');
});

test('reply handles streaming, error, missing completion, textless and empty histories', async t => {
  await t.test('streaming response uses created time and Writing status', async () => {
    const h = harness({ selected: { session_id: 'ses_stream', title: 'Stream' } });
    h.route('GET', '/api/session/ses_stream', sessionResponse('ses_stream'));
    addReply(h, 'ses_stream', [{ id: 'msg_stream', type: 'assistant', time: { created: 1700000123456 }, content: [{ type: 'text', text: 'partial' }] }]);
    const props = (await source(h, 'reply')).instances[0].properties;
    assert.equal(props.updated.timestamp.value, 1700000123);
    assert.equal(props.complete.boolean.value, false);
    assert.equal(props.status.shortText.text, 'Writing');
  });
  await t.test('error reports status without leaking error body', async () => {
    const h = harness({ selected: { session_id: 'ses_error', title: 'Error' } });
    h.route('GET', '/api/session/ses_error', sessionResponse('ses_error'));
    addReply(h, 'ses_error', [{ id: 'msg_err', type: 'assistant', time: { created: 12000, completed: 13000 }, error: { message: 'private error marker' }, content: [{ type: 'text', text: 'answer' }] }]);
    const props = (await source(h, 'reply')).instances[0].properties;
    assert.equal(props.status.shortText.text, 'Error');
    assert.equal(props.complete.boolean.value, true);
    assert.equal(JSON.stringify(props).includes('private'), false);
  });
  await t.test('textless and empty result emit no instance', async () => {
    const h = harness({ selected: { session_id: 'ses_empty', title: 'Empty' } });
    h.route('GET', '/api/session/ses_empty', sessionResponse('ses_empty'));
    addReply(h, 'ses_empty', [{ id: 'msg_tool', type: 'assistant', time: { created: 1000 }, content: [{ type: 'tool', state: { output: 'hidden' } }] }]);
    assert.deepEqual((await source(h, 'reply')).instances, []);
    h.route('GET', '/api/session/ses_empty', sessionResponse('ses_empty'));
    addReply(h, 'ses_empty', []);
    assert.deepEqual((await source(h, 'reply')).instances, []);
  });
});

test('reply caps selected history at 20 and uses newest text-bearing assistant message', async () => {
  const h = harness({ selected: { session_id: 'ses_many', title: 'Many' } });
  h.route('GET', '/api/session/ses_many', sessionResponse('ses_many'));
  const rows = Array.from({ length: 20 }, (_, index) => ({ id: `msg_${index}`, type: 'assistant', time: { created: index * 1000 }, content: index === 19 ? [{ type: 'text', text: 'within window' }] : [{ type: 'tool' }] }));
  addReply(h, 'ses_many', rows);
  const props = (await source(h, 'reply')).instances[0].properties;
  assert.equal(props.message_id.longText.text, 'msg_19');
  assert.equal(props.text.longText.text, 'within window');
});

test('reply rejects malformed response instead of emitting empty source', async () => {
  const h = harness({ selected: { session_id: 'ses_bad', title: 'Bad' } });
  h.route('GET', '/api/session/ses_bad', sessionResponse('ses_bad'));
  h.route('GET', req => req.path === '/api/session/ses_bad/message', response({ data: { id: 'bad' }, cursor: {} }));
  await assert.rejects(source(h, 'reply'), error => error.code === 'PLUGIN_UNAVAILABLE');
});

test('reply rejects legacy wrappers and role-shaped messages instead of accepting fallbacks', async t => {
  for (const [label, message] of [
    ['legacy info wrapper', { info: { id: 'msg_legacy', role: 'assistant', time: { created: 1000 } }, parts: [] }],
    ['role instead of native type', { id: 'msg_role', role: 'assistant', time: { created: 1000 }, content: [{ type: 'text', text: 'must reject' }] }]
  ]) await t.test(label, async () => {
    const h = harness({ selected: { session_id: 'ses_bad_shape', title: 'Bad shape' } });
    h.route('GET', '/api/session/ses_bad_shape', sessionResponse('ses_bad_shape'));
    addReply(h, 'ses_bad_shape', [message]);
    await assert.rejects(source(h, 'reply'), error => error.code === 'PLUGIN_UNAVAILABLE');
  });
});

test('reply rejects invalid timestamps and malformed or unsupported V2 content parts', async t => {
  const valid = { id: 'msg_invalid', type: 'assistant', time: { created: 1000 }, content: [{ type: 'text', text: 'answer' }] };
  const cases = [
    ['NaN created time', { ...valid, time: { created: NaN } }],
    ['negative created time', { ...valid, time: { created: -1 } }],
    ['string completed time', { ...valid, time: { created: 1000, completed: 'done' } }],
    ['non-string text part', { ...valid, content: [{ type: 'text', text: 42 }] }],
    ['unsupported content part', { ...valid, content: [{ type: 'image', path: '/private/image.png' }] }]
  ];
  for (const [label, message] of cases) await t.test(label, async () => {
    const h = harness({ selected: { session_id: 'ses_invalid_message', title: 'Invalid' } });
    h.route('GET', '/api/session/ses_invalid_message', sessionResponse('ses_invalid_message'));
    addReply(h, 'ses_invalid_message', [message]);
    await assert.rejects(source(h, 'reply'), error => error.code === 'PLUGIN_UNAVAILABLE');
  });
});

test('reply clips long Unicode text by code point without splitting surrogate pairs', async () => {
  const id = 'ses_long_text';
  const text = Array.from({ length: 4100 }, (_, index) => String.fromCodePoint(0x1f600 + index % 50)).join('');
  const h = harness({ selected: { session_id: id, title: 'Long text' } });
  h.route('GET', `/api/session/${id}`, sessionResponse(id));
  addReply(h, id, [{ id: 'msg_long', type: 'assistant', time: { created: 1700000000000 }, content: [{ type: 'text', text }] }]);
  const props = (await source(h, 'reply')).instances[0].properties;
  assert.equal([...props.text.longText.text].length, 4096);
  assert.equal(props.text.longText.text, [...text].slice(0, 4096).join(''));
  assert.equal([...props.text.shortText.text].length, 7);
  for (const value of [props.text.shortText.text, props.text.longText.text]) {
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        assert.ok(index + 1 < value.length && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff);
        index += 1;
      } else assert.ok(code < 0xdc00 || code > 0xdfff);
    }
  }
});

test('reply inspects newest 20 assistant messages across adaptive pages', async () => {
  const h = harness({ selected: { session_id: 'ses_many', title: 'Many' } });
  h.route('GET', '/api/session/ses_many', sessionResponse('ses_many'));
  const rows = Array.from({ length: 21 }, (_, index) => ({ id: `msg_${index}`, type: 'assistant', time: { created: 1000 }, content: index === 19 ? [{ type: 'text', text: 'answer' }] : [{ type: 'tool', state: { status: 'completed' } }] }));
  addReply(h, 'ses_many', rows);
  const result = await source(h, 'reply');
  assert.equal(result.instances[0].properties.message_id.longText.text, 'msg_19');
  assert.equal(h.requests.filter(req => req.path === '/api/session/ses_many/message').length, 4);
});

test('job source maps supported kinds and statuses, sorts stable IDs, and omits payload secrets', async () => {
  const h = harness();
  h.route('GET', '/api/experimental/job', response({ data: [
    { id: 'job_z', sessionID: 'ses_z', kind: 'shell', shellID: 'shell_1', status: 'running', time: { started: 1700000020000 }, command: 'private command marker', output: 'private output marker' },
    { id: 'job_b', sessionID: 'ses_b', kind: 'image', status: 'completed', time: { started: 1700000010000 }, path: '/private/image.png', model: 'image-model' },
    { id: 'job_a', sessionID: 'ses_a', kind: 'subagent', status: 'error', time: { started: 1700000030000 }, title: 'Review changes', childSessionID: 'ses_child', agent: 'reviewer', description: 'private description', error: 'private error' },
    { id: 'job_c', sessionID: 'ses_c', kind: 'subagent', status: 'cancelled', time: { started: 1700000040000 }, childSessionID: 'ses_child_c', agent: 'tester', description: 'Cancelled task' }
  ] }));
  const result = await source(h, 'job');
  assert.equal(result.validUntilMs, 1700000020000);
  assert.deepEqual(result.instances.map(row => row.instanceId), ['image:job_b', 'shell:job_z', 'subagent:job_a', 'subagent:job_c']);
  const byId = Object.fromEntries(result.instances.map(row => [row.instanceId, row.properties]));
  assert.equal(byId['shell:job_z'].status.shortText.text, 'running');
  assert.equal(byId['image:job_b'].status.shortText.text, 'complet');
  assert.equal(byId['image:job_b'].status.longText.text, 'completed');
  assert.equal(byId['subagent:job_c'].status.shortText.text, 'cancell');
  assert.equal(byId['subagent:job_c'].kind.shortText.text, 'subagen');
  assert.equal(byId['subagent:job_a'].name.longText.text, 'Review changes');
  assert.ok([...byId['subagent:job_a'].name.shortText.text].length <= 7);
  assert.equal(byId['subagent:job_a'].child_session_id.longText.text, 'ses_child');
  assert.equal(byId['image:job_b'].started.timestamp.value, 1700000010);
  assert.equal(JSON.stringify(result.instances).includes('private'), false);
  assert.equal(JSON.stringify(result.instances).includes('/private/image.png'), false);
  assert.ok(h.requests.every(req => req.method === 'GET'));
});

test('healthy empty jobs returns empty source; unsupported endpoint maps safely', async t => {
  await t.test('empty jobs', async () => {
    const h = harness(); h.route('GET', '/api/experimental/job', response({ data: [] }));
    assert.deepEqual((await source(h, 'job')).instances, []);
  });
  await t.test('404 signals unavailable background jobs', async () => {
    const h = harness(); h.route('GET', '/api/experimental/job', response({ private: 'payload' }, 404));
    await assert.rejects(source(h, 'job'), error => error.code === 'PLUGIN_UNAVAILABLE' && /background/i.test(error.message) && !error.message.includes('payload'));
  });
  await t.test('405 signals unavailable background jobs', async () => {
    const h = harness(); h.route('GET', '/api/experimental/job', response({}, 405));
    await assert.rejects(source(h, 'job'), error => error.code === 'PLUGIN_UNAVAILABLE' && /background/i.test(error.message));
  });
});

test('job auth, rate limit, server failures and malformed JSON fail without partial rows', async t => {
  for (const [status, code] of [[401, 'AUTH_REQUIRED'], [403, 'PERMISSION_DENIED'], [429, 'RATE_LIMITED'], [500, 'PLUGIN_UNAVAILABLE']]) {
    await t.test(`HTTP ${status}`, async () => {
      const h = harness(); h.route('GET', '/api/experimental/job', response({ detail: 'private payload' }, status));
      await assert.rejects(source(h, 'job'), error => error.code === code && !error.message.includes('private'));
    });
  }
  await t.test('malformed list data', async () => {
    const h = harness(); h.route('GET', '/api/experimental/job', { status: 200, async json() { throw Error('private JSON failure'); } });
    await assert.rejects(source(h, 'job'), error => error.code === 'PLUGIN_UNAVAILABLE');
  });
});

test('job rejects malformed, duplicate, and oversized lists without partial results', async t => {
  for (const [label, rows] of [
    ['non-array data', { id: 'job' }],
    ['invalid kind', [{ id: 'job', sessionID: 'ses_x', kind: 'unknown', status: 'running', time: { started: 1 } }]],
    ['duplicate key', [0, 1].map(() => ({ id: 'job', sessionID: 'ses_x', kind: 'shell', status: 'running', time: { started: 1 } }))],
    ['over limit', Array.from({ length: 201 }, (_, i) => ({ id: `job_${i}`, sessionID: 'ses_x', kind: 'shell', status: 'running', time: { started: 1 } }))]
  ]) await t.test(label, async () => {
    const h = harness(); h.route('GET', '/api/experimental/job', response({ data: rows }));
    await assert.rejects(source(h, 'job'), error => error.code === 'PLUGIN_UNAVAILABLE');
  });
});

test('job rejects malformed title and invalid native childSessionID', async t => {
  const base = { id: 'job_sub', sessionID: 'ses_parent', kind: 'subagent', status: 'running', time: { started: 1700000000000 }, childSessionID: 'ses_child', agent: 'worker', description: 'Valid child job' };
  for (const [label, job] of [
    ['non-string title', { ...base, title: 123 }],
    ['invalid childSessionID', { ...base, childSessionID: '../bad' }]
  ]) await t.test(label, async () => {
    const h = harness(); h.route('GET', '/api/experimental/job', response({ data: [job] }));
    await assert.rejects(source(h, 'job'), error => error.code === 'PLUGIN_UNAVAILABLE');
  });
});

test('job requires authentication before HTTP when disconnected', async () => {
  const h = newHarness();
  await assert.rejects(source(h, 'job'), error => error.code === 'AUTH_REQUIRED');
  assert.equal(h.requests.length, 0);
});

test('job rejects invalid status and non-finite or negative start time', async t => {
  const valid = { id: 'job_invalid', sessionID: 'ses_job', kind: 'shell', shellID: 'shell_1', command: 'run', status: 'running', time: { started: 1700000000000 } };
  for (const [label, job] of [
    ['unknown status', { ...valid, status: 'queued' }],
    ['non-finite start', { ...valid, time: { started: NaN } }],
    ['negative start', { ...valid, time: { started: -1 } }]
  ]) await t.test(label, async () => {
    const h = harness(); h.route('GET', '/api/experimental/job', response({ data: [job] }));
    await assert.rejects(source(h, 'job'), error => error.code === 'PLUGIN_UNAVAILABLE');
  });
});

function addSendTarget(h, id) {
  h.route('GET', `/api/session/${id}`, response({ data: session(id, 'Sent target') }));
}
function storedState(h) {
  const value = h.storage.values.get('opencode.plugin.state.v1');
  return typeof value === 'string' ? JSON.parse(value) : value;
}

test('successful send reloads persisted state before setting lastSessionID', async () => {
  const id = 'ses_sent';
  const h = harness({ selected: { session_id: id, title: 'Sent target' } });
  addSendTarget(h, id);
  h.route('POST', `/api/session/${id}/prompt`, async req => {
    const latest = {
      ...storedState(h), mode: 'new_chat', directory: '/changed/directory',
      selected: { session_id: 'ses_other', title: 'Other selection' },
      nicknames: { ses_other: 'Other nickname' }, password: 'rotated-password', lastSessionID: 'ses_previous'
    };
    await h.storage.setItem('opencode.plugin.state.v1', JSON.stringify(latest));
    return response(makeAck(id, req.body.id, req.body.text));
  });

  await h.service.action({ action: 'send_to_agent', args: { message: 'deliver once', chat_id: id } });
  const saved = storedState(h);
  assert.equal(saved.mode, 'new_chat');
  assert.equal(saved.directory, '/changed/directory');
  assert.deepEqual(saved.selected, { session_id: 'ses_other', title: 'Other selection' });
  assert.deepEqual(saved.nicknames, { ses_other: 'Other nickname' });
  assert.equal(saved.password, 'rotated-password');
  assert.equal(saved.lastSessionID, id);
  assert.equal(h.requests.filter(req => req.path.endsWith('/prompt')).length, 1);
});

test('successful send after disconnect warns without restoring persisted state', async () => {
  const id = 'ses_disconnected';
  const h = harness({ selected: { session_id: id, title: 'Disconnect target' } });
  addSendTarget(h, id);
  h.route('POST', `/api/session/${id}/prompt`, async req => {
    await h.storage.removeItem('opencode.plugin.state.v1');
    return response(makeAck(id, req.body.id, req.body.text));
  });

  const result = await h.service.action({ action: 'send_to_agent', args: { message: 'deliver once', chat_id: id } });
  assert.match(result.text, /focus not saved/i);
  assert.equal(h.storage.values.has('opencode.plugin.state.v1'), false);
  assert.equal(h.requests.filter(req => req.path.endsWith('/prompt')).length, 1);
});

test('successful send after server identity change preserves new identity without old focus', async () => {
  const id = 'ses_old_server';
  const h = harness({ selected: { session_id: id, title: 'Old server target' } });
  addSendTarget(h, id);
  h.route('POST', `/api/session/${id}/prompt`, async req => {
    const latest = {
      ...storedState(h), url: 'http://other:4096', username: 'other-user', password: 'other-password',
      version: '2.3.0', selected: null, lastSessionID: null, nicknames: {}, directory: '/other'
    };
    await h.storage.setItem('opencode.plugin.state.v1', JSON.stringify(latest));
    return response(makeAck(id, req.body.id, req.body.text));
  });

  const result = await h.service.action({ action: 'send_to_agent', args: { message: 'deliver once', chat_id: id } });
  assert.match(result.text, /focus not saved/i);
  const saved = storedState(h);
  assert.equal(saved.url, 'http://other:4096');
  assert.equal(saved.username, 'other-user');
  assert.equal(saved.password, 'other-password');
  assert.equal(saved.directory, '/other');
  assert.equal(saved.lastSessionID, null);
  assert.equal(h.requests.filter(req => req.path.endsWith('/prompt')).length, 1);
});

test('focus persistence failure after verified send warns and never retries prompt', async () => {
  const id = 'ses_storage_failure';
  const h = harness({ selected: { session_id: id, title: 'Storage target' } });
  addSendTarget(h, id);
  h.route('POST', `/api/session/${id}/prompt`, req => {
    h.storage.setItem = async () => { throw Error('private storage failure'); };
    return response(makeAck(id, req.body.id, req.body.text));
  });

  const result = await h.service.action({ action: 'send_to_agent', args: { message: 'deliver once', chat_id: id } });
  assert.match(result.text, /focus not saved/i);
  assert.equal(result.text.includes('private storage failure'), false);
  assert.equal(h.requests.filter(req => req.path.endsWith('/prompt')).length, 1);
});

test('connecting to a different URL or username resets server-scoped focus', async t => {
  for (const [label, connection] of [
    ['URL change', { url: 'http://other:4096', username: 'opencode' }],
    ['username change', { url: 'http://localhost:4096', username: 'different-user' }]
  ]) await t.test(label, async () => {
    const h = harness({ lastSessionID: 'ses_old_focus', selected: { session_id: 'ses_old_focus', title: 'Old' }, directory: '/old', nicknames: { ses_old_focus: 'Old' } });
    h.route('GET', '/api/info', response({ version: '2.2.1' }));
    await h.service.config({ type: 'connect', ...connection, password: 'new-secret' });
    const saved = storedState(h);
    assert.equal(saved.lastSessionID, null);
    assert.equal(saved.selected, null);
    assert.equal(saved.directory, '');
    assert.deepEqual(saved.nicknames, {});
  });
});

test('same URL and username credential update preserves focus; status exposes neither focus nor password', async () => {
  const h = harness({ lastSessionID: 'ses_keep_focus', selected: { session_id: 'ses_keep_focus', title: 'Keep' } });
  h.route('GET', '/api/info', response({ version: '2.2.1' }));
  await h.service.config({ type: 'connect', url: 'http://localhost:4096', username: 'opencode', password: 'rotated-secret' });
  assert.equal(storedState(h).lastSessionID, 'ses_keep_focus');
  const status = await h.service.config({ type: 'status' });
  assert.equal(Object.hasOwn(status, 'lastSessionID'), false);
  assert.equal(Object.hasOwn(status, 'password'), false);
  assert.equal(JSON.stringify(status).includes('rotated-secret'), false);
});
