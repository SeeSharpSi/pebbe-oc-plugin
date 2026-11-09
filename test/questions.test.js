'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { harness: newHarness, response, connected } = require('./helpers');

const KEY = 'opencode.plugin.state.v1';
const activeHarnesses = [];
function harness() { const h = newHarness(); activeHarnesses.push(h); return h; }
test.afterEach(() => {
  for (const h of activeHarnesses.splice(0)) assert.deepEqual(h.unexpected, [], 'strict fetch mock saw unexpected question request');
});

async function ready(h, changes = {}) {
  await connected(h);
  const state = JSON.parse(await h.storage.getItem(KEY));
  await h.storage.setItem(KEY, JSON.stringify({ ...state, ...changes }));
}
function form(id, sessionID, fields = [{ key: 'choice', type: 'string', title: 'Choose', options: [{ value: 'one', label: 'One' }] }], extra = {}) {
  return { id, sessionID, title: `Question ${id}`, fields, ...extra };
}
function addActive(h, ...ids) { h.route('GET', '/api/session/active', response({ data: Object.fromEntries(ids.map(id => [id, { type: 'running' }])) })); }
function addForms(h, id, forms) { h.route('GET', `/api/session/${encodeURIComponent(id)}/form`, response({ data: forms })); }
function source(h) { return h.service.source({ category: 'opencode', item: 'question' }); }
function detail(h, id, formID, fields, status = 'pending', overrides = {}) {
  h.route('GET', `/api/session/${encodeURIComponent(id)}/form/${encodeURIComponent(formID)}`,
    response({ data: { ...form(formID, id, fields), state: { status }, ...overrides } }));
}
function action(h, args) { return h.service.action({ action: 'answer_question', args }); }

test('question source scans active plus focused sessions, excludes idle unrelated sessions, sorts composite IDs, and encodes URLs', async () => {
  const h = harness(); await ready(h, { selected: { session_id: 'ses_focus' } });
  addActive(h, 'ses_z');
  addForms(h, 'ses_z', [form('frm same', 'ses_z')]);
  addForms(h, 'ses_focus', [form('frm same', 'ses_focus')]);
  const result = await source(h);
  assert.equal(result.validUntilMs, 1700000020000);
  assert.deepEqual(result.instances.map(row => row.instanceId), ['ses_focus:frm same', 'ses_z:frm same']);
  const fields = JSON.stringify([{ key: 'choice', type: 'string', title: 'Choose', options: [{ value: 'one', label: 'One' }] }]);
  assert.equal(result.instances[0].properties.fields.longText.text, fields);
  assert.equal(result.instances[0].properties.answerable.boolean.value, true);
  assert.match(result.instances[0].properties.url.longText.text, /session\/ses_focus$/);
  assert.deepEqual(h.requests.filter(row => row.path.includes('/form')).map(row => row.path), ['/api/session/ses_z/form', '/api/session/ses_focus/form']);
  assert.ok(h.requests.every(row => row.method === 'GET'));
});

test('question source uses last session in new-chat mode, Unicode name truncation, and marks external forms unanswerable', async () => {
  const h = harness(); await ready(h, { mode: 'new_chat', lastSessionID: 'ses_last' }); addActive(h);
  const title = String.fromCodePoint(0x1f600).repeat(8) + 'Long title';
  const fields = [{ key: 'external', type: 'external', title: 'Open', url: 'https://example.test' }];
  addForms(h, 'ses_last', [form('frm_external', 'ses_last', fields, { title })]);
  const row = (await source(h)).instances[0];
  assert.equal(row.instanceId, 'ses_last:frm_external');
  assert.equal([...row.properties.name.shortText.text].length, 7);
  assert.equal(row.properties.name.longText.text, title);
  assert.equal(row.properties.answerable.boolean.value, false);
});

test('question source healthy empty scan is empty; malformed and failed scans never fabricate empty results', async t => {
  await t.test('empty', async () => { const h = harness(); await ready(h); addActive(h); assert.deepEqual((await source(h)).instances, []); });
  for (const [label, result] of [
    ['malformed envelope', response({ data: [] })],
    ['auth', response({}, 401)],
    ['server error', response({}, 500)]
  ]) await t.test(label, async () => {
    const h = harness(); await ready(h); h.route('GET', '/api/session/active', result);
    await assert.rejects(source(h), error => error.code !== undefined);
  });
});

test('question source rejects malformed form records, duplicate field keys, and oversized field JSON', async t => {
  for (const [label, rows] of [
    ['wrong session', [form('frm_a', 'ses_other')]],
    ['duplicate form ID in session', [form('frm_a', 'ses_a'), form('frm_a', 'ses_a')]],
    ['duplicate fields', [form('frm_a', 'ses_a', [{ key: 'x', type: 'string' }, { key: 'x', type: 'boolean' }])]],
    ['unsafe field key', [form('frm_a', 'ses_a', [{ key: '__proto__', type: 'string' }])]],
    ['malformed condition', [form('frm_a', 'ses_a', [{ key: 'x', type: 'string', when: [{ key: 'other', op: 'wat', value: true }] }])]],
    ['object condition', [form('frm_a', 'ses_a', [{ key: 'x', type: 'string', when: { key: 'other', op: 'eq', value: true } }])]],
    ['external missing URL', [form('frm_a', 'ses_a', [{ key: 'x', type: 'external', title: 'External' }])]],
    ['multiselect missing options', [form('frm_a', 'ses_a', [{ key: 'x', type: 'multiselect' }])]],
    ['invalid field bounds', [form('frm_a', 'ses_a', [{ key: 'x', type: 'number', minimum: 5, maximum: 2 }])]],
    ['empty field list', [form('frm_a', 'ses_a', [])]],
    ['too many fields', [form('frm_a', 'ses_a', Array.from({ length: 51 }, (_, i) => ({ key: `k${i}`, type: 'string' }))) ]],
    ['oversized fields JSON', [form('frm_a', 'ses_a', [{ key: 'x', type: 'string', description: 'x'.repeat(16001) }])]]
  ]) await t.test(label, async () => {
    const h = harness(); await ready(h); addActive(h, 'ses_a'); addForms(h, 'ses_a', rows);
    await assert.rejects(source(h), error => error.code === 'PLUGIN_UNAVAILABLE');
  });
});

test('question source caps active IDs, forms, and request concurrency', async () => {
  const h = harness(); await ready(h); const ids = Array.from({ length: 8 }, (_, i) => `ses_${i}`);
  let inFlight = 0; let peak = 0;
  const delayed = payload => async () => { inFlight++; peak = Math.max(peak, inFlight); await new Promise(resolve => setImmediate(resolve)); inFlight--; return response(payload); };
  h.route('GET', '/api/session/active', delayed({ data: Object.fromEntries(ids.map(id => [id, { type: 'running' }])) }));
  for (const id of ids) h.route('GET', `/api/session/${id}/form`, delayed({ data: [form('frm_a', id)] }));
  assert.equal((await source(h)).instances.length, 8); assert.ok(peak <= 4);
  const tooMany = harness(); await ready(tooMany); addActive(tooMany, 'ses_a');
  addForms(tooMany, 'ses_a', Array.from({ length: 201 }, (_, i) => form(`frm_${i}`, 'ses_a')));
  await assert.rejects(source(tooMany), error => error.code === 'PLUGIN_UNAVAILABLE');
  const tooManyActive = harness(); await ready(tooManyActive);
  addActive(tooManyActive, ...Array.from({ length: 101 }, (_, i) => `ses_${i}`));
  await assert.rejects(source(tooManyActive), error => error.code === 'PLUGIN_UNAVAILABLE');
});

test('answer_question posts exact answer once after fresh pending detail and refreshes dependent sources', async () => {
  const h = harness(); await ready(h); const fields = [
    { key: 'choice', type: 'string', required: true, options: [{ value: 'one', label: 'One' }] },
    { key: 'explain', type: 'string', required: true, when: [{ key: 'choice', op: 'eq', value: 'one' }] },
    { key: 'tags', type: 'multiselect', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
    { key: 'ok', type: 'boolean' }, { key: 'count', type: 'integer', minimum: 0, maximum: 10 }
  ];
  const answer = { choice: 'one', explain: 'free form', tags: ['b', 'a'], ok: false, count: 0 };
  detail(h, 'ses_a', 'frm/a', fields);
  h.route('POST', '/api/session/ses_a/form/frm%2Fa/reply', req => { assert.deepEqual(req.body, { answer }); return response(null, 204); });
  const result = await action(h, { session_id: 'ses_a', form_id: 'frm/a', answer });
  assert.deepEqual(result.refreshed, ['agent/chats', 'opencode/active_session', 'opencode/activity', 'opencode/reply', 'opencode/replies', 'opencode/question', 'opencode/job']);
  assert.equal(h.requests.filter(row => row.method === 'POST').length, 1);
  assert.ok(h.requests.every(row => row.method === 'GET' || row.method === 'POST'));
});

test('answer_question rejects invalid arguments and locally invalid choices without posting', async () => {
  const h = harness(); await ready(h);
  for (const args of [null, {}, { session_id: 'bad', form_id: 'f', answer: {} }, { session_id: 'ses_a', form_id: '', answer: {} },
    { session_id: 'ses_a', form_id: 'f', answer: [] }, { session_id: 'ses_a', form_id: 'f', answer: { x: 'x'.repeat(16001) } },
    { session_id: 'ses_a', form_id: 'f', answer: JSON.parse('{"__proto__":"x"}') },
    { session_id: 'ses_a', form_id: 'f', answer: JSON.parse('{"constructor":"x"}') },
    { session_id: 'ses_a', form_id: 'f', answer: JSON.parse('{"prototype":"x"}') },
    { session_id: 'ses_a', form_id: 'f', answer: { x: NaN } }, { session_id: 'ses_a', form_id: 'f', answer: { x: Infinity } }]) {
    await assert.rejects(action(h, args), error => error.code === 'INVALID_ARGS');
  }
  detail(h, 'ses_a', 'f', [{ key: 'x', type: 'string', required: true, options: [{ value: 'yes', label: 'Yes' }] }]);
  await assert.rejects(action(h, { session_id: 'ses_a', form_id: 'f', answer: { x: 'no' } }), error => error.code === 'INVALID_ARGS');
  assert.equal(h.requests.some(row => row.method === 'POST'), false);
});

test('answer_question refuses external, settled, malformed, or mismatched detail without posting', async t => {
  for (const [label, detailOverride, status, expected] of [
    ['external field', { fields: [{ key: 'x', type: 'external', url: 'https://example.test' }] }, 'pending', 'INVALID_ARGS'],
    ['answered', {}, 'answered', 'INVALID_ARGS'], ['cancelled', {}, 'cancelled', 'INVALID_ARGS'],
    ['wrong identity', { sessionID: 'ses_other' }, 'pending', 'PLUGIN_UNAVAILABLE']
  ]) await t.test(label, async () => {
    const h = harness(); await ready(h);
    const fields = detailOverride.fields || [{ key: 'x', type: 'string' }];
    detail(h, 'ses_a', 'f', fields, status, detailOverride);
    await assert.rejects(action(h, { session_id: 'ses_a', form_id: 'f', answer: { x: 'ok' } }), error => error.code === expected);
    assert.equal(h.requests.some(row => row.method === 'POST'), false);
  });
  for (const [label, overrides] of [
    ['missing state', { state: undefined, status: 'pending' }],
    ['wrong form ID', { id: 'frm_other' }]
  ]) await t.test(label, async () => {
    const h = harness(); await ready(h);
    detail(h, 'ses_a', 'f', [{ key: 'x', type: 'string' }], 'pending', overrides);
    await assert.rejects(action(h, { session_id: 'ses_a', form_id: 'f', answer: { x: 'ok' } }), error => error.code === 'PLUGIN_UNAVAILABLE');
    assert.equal(h.requests.some(row => row.method === 'POST'), false);
  });
});

test('source marks required hidden fields desktop-only; optional hidden fields remain answerable', async () => {
  const h = harness(); await ready(h); addActive(h, 'ses_a');
  addForms(h, 'ses_a', [
    form('frm_required_hidden', 'ses_a', [{ key: 'secret', type: 'string', title: 'Secret', required: true, hidden: true, default: 'hint' }]),
    form('frm_optional_hidden', 'ses_a', [{ key: 'optional', type: 'string', title: 'Optional', required: false, hidden: true }])
  ]);
  const rows = (await source(h)).instances;
  assert.equal(rows.find(row => row.properties.form_id.longText.text === 'frm_required_hidden').properties.answerable.boolean.value, false);
  assert.equal(rows.find(row => row.properties.form_id.longText.text === 'frm_optional_hidden').properties.answerable.boolean.value, true);
  detail(h, 'ses_a', 'frm_required_hidden', [{ key: 'secret', type: 'string', title: 'Secret', required: true, hidden: true, default: 'hint' }]);
  await assert.rejects(action(h, { session_id: 'ses_a', form_id: 'frm_required_hidden', answer: {} }), error => error.code === 'INVALID_ARGS');
  assert.equal(h.requests.some(row => row.method === 'POST'), false);
});

test('answer_question rejects unknown, hidden, inactive, and missing required answers before posting', async t => {
  const cases = [
    ['unknown key', [{ key: 'shown', type: 'string' }], { other: 'x' }],
    ['hidden field', [{ key: 'secret', type: 'string', hidden: true }], { secret: 'x' }],
    ['inactive conditional field', [{ key: 'gate', type: 'boolean' }, { key: 'child', type: 'string', when: [{ key: 'gate', op: 'eq', value: true }] }], { gate: false, child: 'x' }],
    ['missing required field', [{ key: 'needed', type: 'string', required: true }], {}],
    ['missing conditional required field', [{ key: 'gate', type: 'boolean' }, { key: 'child', type: 'string', required: true, when: [{ key: 'gate', op: 'neq', value: false }] }], { gate: true }]
  ];
  for (const [label, fields, answer] of cases) await t.test(label, async () => {
    const h = harness(); await ready(h); detail(h, 'ses_a', 'f', fields);
    await assert.rejects(action(h, { session_id: 'ses_a', form_id: 'f', answer }), error => error.code === 'INVALID_ARGS');
    assert.equal(h.requests.some(row => row.method === 'POST'), false);
  });
});

test('defaults are UI hints only: required fields need explicit answers and are never injected', async t => {
  await t.test('omitted defaulted required field rejects', async () => {
    const h = harness(); await ready(h);
    detail(h, 'ses_a', 'f', [{ key: 'choice', type: 'string', title: 'Choice', required: true, default: 'blue', options: [{ value: 'blue', label: 'Blue' }] }]);
    await assert.rejects(action(h, { session_id: 'ses_a', form_id: 'f', answer: {} }), error => error.code === 'INVALID_ARGS');
    assert.equal(h.requests.some(row => row.method === 'POST'), false);
  });
  await t.test('explicit default-valued choice posts original answer', async () => {
    const h = harness(); await ready(h);
    const answer = { choice: 'blue' };
    detail(h, 'ses_a', 'f', [{ key: 'choice', type: 'string', title: 'Choice', required: true, default: 'blue', options: [{ value: 'blue', label: 'Blue' }] }]);
    h.route('POST', '/api/session/ses_a/form/f/reply', req => { assert.deepEqual(req.body, { answer }); return response(null, 204); });
    await action(h, { session_id: 'ses_a', form_id: 'f', answer });
  });
});

test('conditions use explicit answer values only, not field defaults', async t => {
  const fields = [
    { key: 'choice', type: 'string', title: 'Choice', default: 'red', options: [{ value: 'red', label: 'Red' }, { value: 'blue', label: 'Blue' }] },
    { key: 'note', type: 'string', title: 'Note', required: true, when: [{ key: 'choice', op: 'eq', value: 'red' }] }
  ];
  await t.test('omitted default choice does not activate required condition', async () => {
    const h = harness(); await ready(h); detail(h, 'ses_a', 'f', fields);
    h.route('POST', '/api/session/ses_a/form/f/reply', req => { assert.deepEqual(req.body, { answer: {} }); return response(null, 204); });
    await action(h, { session_id: 'ses_a', form_id: 'f', answer: {} });
  });
  await t.test('explicit red activates required child', async () => {
    const h = harness(); await ready(h); detail(h, 'ses_a', 'f', fields);
    await assert.rejects(action(h, { session_id: 'ses_a', form_id: 'f', answer: { choice: 'red' } }), error => error.code === 'INVALID_ARGS');
    assert.equal(h.requests.some(row => row.method === 'POST'), false);
  });
  await t.test('explicit blue bypasses conditional child', async () => {
    const h = harness(); await ready(h); detail(h, 'ses_a', 'f', fields);
    h.route('POST', '/api/session/ses_a/form/f/reply', req => { assert.deepEqual(req.body, { answer: { choice: 'blue' } }); return response(null, 204); });
    await action(h, { session_id: 'ses_a', form_id: 'f', answer: { choice: 'blue' } });
  });
});

test('answer_question enforces field types, scalar and array bounds, and option membership', async t => {
  const cases = [
    ['string type', [{ key: 'x', type: 'string' }], { x: false }],
    ['string minimum', [{ key: 'x', type: 'string', minLength: 2 }], { x: 'a' }],
    ['string maximum', [{ key: 'x', type: 'string', maxLength: 2 }], { x: 'abc' }],
    ['string option', [{ key: 'x', type: 'string', options: [{ value: 'yes', label: 'Yes' }] }], { x: 'no' }],
    ['boolean type', [{ key: 'x', type: 'boolean' }], { x: 0 }],
    ['number type', [{ key: 'x', type: 'number' }], { x: '1' }],
    ['number minimum', [{ key: 'x', type: 'number', minimum: 1 }], { x: 0 }],
    ['number maximum', [{ key: 'x', type: 'number', maximum: 2 }], { x: 3 }],
    ['infinite encoded minimum', [{ key: 'x', type: 'number', minimum: 'Infinity' }], { x: 0 }],
    ['infinite encoded maximum', [{ key: 'x', type: 'number', maximum: '-Infinity' }], { x: 0 }],
    ['integer type', [{ key: 'x', type: 'integer' }], { x: 1.5 }],
    ['multiselect type', [{ key: 'x', type: 'multiselect', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }], { x: 'a' }],
    ['multiselect duplicates', [{ key: 'x', type: 'multiselect', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }], { x: ['a', 'a'] }],
    ['multiselect minimum', [{ key: 'x', type: 'multiselect', minItems: 2, options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }], { x: ['a'] }],
    ['multiselect maximum', [{ key: 'x', type: 'multiselect', maxItems: 1, options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }], { x: ['a', 'b'] }],
    ['multiselect option', [{ key: 'x', type: 'multiselect', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }], { x: ['c'] }]
  ];
  for (const [label, fields, answer] of cases) await t.test(label, async () => {
    const h = harness(); await ready(h); detail(h, 'ses_a', 'f', fields);
    await assert.rejects(action(h, { session_id: 'ses_a', form_id: 'f', answer }), error => error.code === 'INVALID_ARGS');
    assert.equal(h.requests.some(row => row.method === 'POST'), false);
  });
  const custom = harness(); await ready(custom);
  detail(custom, 'ses_a', 'f', [{ key: 'x', type: 'string', custom: true, options: [{ value: 'yes', label: 'Yes' }] }]);
  custom.route('POST', '/api/session/ses_a/form/f/reply', response(null, 204));
  await action(custom, { session_id: 'ses_a', form_id: 'f', answer: { x: 'other' } });
  assert.equal(custom.requests.filter(row => row.method === 'POST').length, 1);
  const customMulti = harness(); await ready(customMulti);
  detail(customMulti, 'ses_a', 'f', [{ key: 'x', type: 'multiselect', custom: true, options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }]);
  customMulti.route('POST', '/api/session/ses_a/form/f/reply', response(null, 204));
  await action(customMulti, { session_id: 'ses_a', form_id: 'f', answer: { x: ['custom'] } });
  assert.equal(customMulti.requests.filter(row => row.method === 'POST').length, 1);
  const openBounds = harness(); await ready(openBounds);
  detail(openBounds, 'ses_a', 'f', [{ key: 'x', type: 'number', minimum: '-Infinity', maximum: 'Infinity' }]);
  openBounds.route('POST', '/api/session/ses_a/form/f/reply', req => { assert.deepEqual(req.body, { answer: { x: 0 } }); return response(null, 204); });
  await action(openBounds, { session_id: 'ses_a', form_id: 'f', answer: { x: 0 } });
  assert.equal(openBounds.requests.filter(row => row.method === 'POST').length, 1);
});

test('answer_question maps reply failures safely and never retries', async () => {
  for (const [status, code] of [[400, 'INVALID_ARGS'], [404, 'INVALID_ARGS'], [409, 'INVALID_ARGS'], [401, 'AUTH_REQUIRED'], [403, 'PERMISSION_DENIED'], [429, 'RATE_LIMITED'], [500, 'PLUGIN_UNAVAILABLE']]) {
    const h = harness(); await ready(h); detail(h, 'ses_a', 'f', [{ key: 'x', type: 'string' }]);
    h.route('POST', '/api/session/ses_a/form/f/reply', response({ detail: 'secret server response' }, status));
    await assert.rejects(action(h, { session_id: 'ses_a', form_id: 'f', answer: { x: 'ok' } }), error => error.code === code && !error.message.includes('secret'));
    assert.equal(h.requests.filter(row => row.method === 'POST').length, 1);
  }
});

test('uncertain or malformed reply success never retries answer POST', async t => {
  for (const [label, result] of [
    ['transport failure', () => { throw Error('private transport detail'); }],
    ['malformed success JSON', { status: 200, async json() { throw Error('private malformed body'); } }],
    ['unexpected JSON success', response({ accepted: true }, 200)]
  ]) await t.test(label, async () => {
    const h = harness(); await ready(h); detail(h, 'ses_a', 'f', [{ key: 'x', type: 'string' }]);
    h.route('POST', '/api/session/ses_a/form/f/reply', result);
    await assert.rejects(action(h, { session_id: 'ses_a', form_id: 'f', answer: { x: 'ok' } }), error => error.code === 'PLUGIN_UNAVAILABLE');
    assert.equal(h.requests.filter(row => row.method === 'POST').length, 1);
  });
});
