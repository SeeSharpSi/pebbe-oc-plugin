'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const manifest = require('../package.json').pebble;
const { harness: newHarness, response, session, connected } = require('./helpers');

const activeHarnesses = [];
function harness() { const h = newHarness(); activeHarnesses.push(h); return h; }
test.afterEach(() => {
  for (const h of activeHarnesses.splice(0)) assert.deepEqual(h.unexpected, [], 'strict mock saw unexpected activity request');
});

function activeMap(...ids) { return Object.fromEntries(ids.map(id => [id, { type: 'running' }])); }
function live(id, extra = {}) { return session(id, `Title ${id}`, extra); }
function addActive(h, ids) { h.route('GET', '/api/session/active', response({ data: ids })); }
function addMetadata(h, id, value = live(id)) { h.route('GET', `/api/session/${id}`, response({ data: value })); }
function addPending(h, id, permissions = [], forms = []) {
  h.route('GET', `/api/session/${id}/permission`, response({ data: permissions }));
  h.route('GET', `/api/session/${id}/form`, response({ data: forms }));
}
async function ready(h) { await connected(h); }
async function source(h, item = 'active_session') { return h.service.source({ category: 'opencode', item }); }

test('manifest appends activity sources without changing agent source declarations', () => {
  const sources = manifest.plugin.sources;
  assert.deepEqual(sources.slice(0, 2).map(source => [source.category, source.items]), [['agent', ['chats']], ['agent', ['configured']]]);
  assert.deepEqual(sources[2], {
    category: 'opencode', items: ['active_session'],
    properties: {
      name: ['shortText', 'longText'], title: ['longText'], status: ['shortText', 'longText'],
      directory: ['longText'], agent: ['longText'], model: ['longText'], updated: ['timestamp'],
      url: ['longText'], is_subagent: ['boolean']
    }, supportsMultiple: true, callerPermissions: [], suggestedRefreshIntervalSec: 20
  });
  assert.deepEqual(sources[3], {
    category: 'opencode', items: ['activity'],
    properties: {
      name: ['shortText', 'longText'], active_count: ['numericValue', 'shortText'],
      attention_count: ['numericValue', 'shortText'], summary: ['shortText', 'longText'],
      connected: ['boolean'], checked_at: ['timestamp']
    }, supportsMultiple: false, callerPermissions: [], suggestedRefreshIntervalSec: 20
  });
});

test('healthy empty scan returns empty active source and activity counts with no session reads', async () => {
  const h = harness(); await ready(h); addActive(h, {});
  const instances = await source(h);
  assert.deepEqual(instances, { validUntilMs: 1700000020000, instances: [] });
  addActive(h, {});
  const activity = await source(h, 'activity');
  assert.equal(activity.validUntilMs, 1700000020000);
  assert.equal(activity.instances.length, 1);
  assert.equal(activity.instances[0].instanceId, 'opencode');
  const props = activity.instances[0].properties;
  assert.equal(props.active_count.numericValue.value, 0);
  assert.equal(props.attention_count.numericValue.value, 0);
  assert.equal(props.summary.shortText.text, 'Idle');
  assert.equal(props.summary.longText.text, 'No active sessions');
  assert.equal(props.connected.boolean.value, true);
  assert.equal(h.requests.filter(req => req.path !== '/api/info' && req.path !== '/api/session/active').length, 0);
});

test('active row maps live metadata fields, provider/model, URL, and epoch seconds', async () => {
  const h = harness(); await ready(h); addActive(h, activeMap('ses_live'));
  const row = live('ses_live', { title: 'Do work', location: { directory: '/repo' }, agent: 'build', model: { providerID: 'anthropic', id: 'claude', variant: 'fast' }, time: { updated: 1700000123456 } });
  addMetadata(h, 'ses_live', row); addPending(h, 'ses_live');
  const result = await source(h);
  const instance = result.instances[0]; const props = instance.properties;
  assert.equal(instance.instanceId, 'ses_live');
  assert.equal(props.title.longText.text, 'Do work');
  assert.equal(props.directory.longText.text, '/repo');
  assert.equal(props.agent.longText.text, 'build');
  assert.equal(props.model.longText.text, 'anthropic/claude');
  assert.equal(props.updated.timestamp.value, 1700000123);
  assert.equal(props.is_subagent.boolean.value, false);
  assert.equal(props.status.shortText.text, 'Running');
  assert.equal(props.url.longText.text, `http://localhost:4096/server/${Buffer.from('http://localhost:4096').toString('base64url')}/session/ses_live`);
});

test('metadata memoizes shared ancestry and orders parent before child independent of active map order', async () => {
  const h = harness(); await ready(h); addActive(h, activeMap('ses_c', 'ses_a', 'ses_b'));
  addMetadata(h, 'ses_root', live('ses_root'));
  addMetadata(h, 'ses_a', live('ses_a', { parentID: 'ses_root' }));
  addMetadata(h, 'ses_b', live('ses_b', { parentID: 'ses_root' }));
  addMetadata(h, 'ses_c', live('ses_c', { parentID: 'ses_root' }));
  for (const id of ['ses_a', 'ses_b', 'ses_c']) addPending(h, id);
  const result = await source(h);
  assert.deepEqual(result.instances.map(item => item.instanceId), ['ses_a', 'ses_b', 'ses_c']);
  assert.equal(h.requests.filter(req => req.path === '/api/session/ses_root').length, 1);
  assert.equal(result.instances.every(item => item.properties.is_subagent.boolean.value), true);
  assert.equal(result.instances.some(item => item.instanceId === 'ses_root'), false);
});

test('permuted multi-level lineages keep ancestry order stable across metadata changes', async () => {
  const h = harness(); await ready(h);
  const configureScan = (titles, updated) => {
    addActive(h, activeMap('ses_zchild', 'ses_unrelated', 'ses_root', 'ses_grand'));
    addMetadata(h, 'ses_root', live('ses_root', { title: titles[0], time: { updated } }));
    addMetadata(h, 'ses_zchild', live('ses_zchild', { title: titles[1], parentID: 'ses_root', time: { updated } }));
    addMetadata(h, 'ses_grand', live('ses_grand', { title: titles[2], parentID: 'ses_zchild', time: { updated } }));
    addMetadata(h, 'ses_unrelated', live('ses_unrelated', { title: titles[3], time: { updated } }));
    for (const id of ['ses_root', 'ses_zchild', 'ses_grand', 'ses_unrelated']) addPending(h, id);
  };
  configureScan(['Root one', 'Child one', 'Grand one', 'Other one'], 1);
  const first = await source(h);
  configureScan(['Root two', 'Child two', 'Grand two', 'Other two'], 2000);
  const second = await source(h);
  assert.deepEqual(first.instances.map(item => item.instanceId), ['ses_root', 'ses_zchild', 'ses_grand', 'ses_unrelated']);
  assert.deepEqual(second.instances.map(item => item.instanceId), first.instances.map(item => item.instanceId));
  assert.equal(h.requests.filter(req => req.path === '/api/session/ses_root').length, 2);
  assert.equal(h.requests.filter(req => req.path === '/api/session/ses_zchild').length, 2);
});

test('root and active descendants count as one lineage and attention counts roots once', async () => {
  const h = harness(); await ready(h); addActive(h, activeMap('ses_root', 'ses_child', 'ses_grand'));
  addMetadata(h, 'ses_root', live('ses_root'));
  addMetadata(h, 'ses_child', live('ses_child', { parentID: 'ses_root' }));
  addMetadata(h, 'ses_grand', live('ses_grand', { parentID: 'ses_child' }));
  for (const id of ['ses_root', 'ses_child', 'ses_grand']) addPending(h, id, id === 'ses_child' ? [{ id: 'per_1', sessionID: id }] : []);
  const result = await source(h, 'activity'); const props = result.instances[0].properties;
  assert.equal(props.active_count.numericValue.value, 1);
  assert.equal(props.attention_count.numericValue.value, 1);
  assert.equal(props.summary.longText.text, '1 active, 1 needs attention');
});

test('multiple waiting members across one root lineage count as one attention group', async () => {
  const h = harness(); await ready(h); addActive(h, activeMap('ses_root', 'ses_child', 'ses_grand'));
  addMetadata(h, 'ses_root');
  addMetadata(h, 'ses_child', live('ses_child', { parentID: 'ses_root' }));
  addMetadata(h, 'ses_grand', live('ses_grand', { parentID: 'ses_child' }));
  addPending(h, 'ses_root');
  addPending(h, 'ses_child', [{ id: 'per_1', sessionID: 'ses_child' }]);
  addPending(h, 'ses_grand', [], [{ id: 'frm_1', sessionID: 'ses_grand' }]);
  const props = (await source(h, 'activity')).instances[0].properties;
  assert.equal(props.active_count.numericValue.value, 1);
  assert.equal(props.attention_count.numericValue.value, 1);
});

test('active child with inactive parent emits child only and counts its lineage', async () => {
  const h = harness(); await ready(h); addActive(h, activeMap('ses_child'));
  addMetadata(h, 'ses_parent', live('ses_parent'));
  addMetadata(h, 'ses_child', live('ses_child', { parentID: 'ses_parent' })); addPending(h, 'ses_child');
  const sessions = await source(h);
  assert.deepEqual(sessions.instances.map(item => item.instanceId), ['ses_child']);
  assert.equal(sessions.instances[0].properties.is_subagent.boolean.value, true);
  addActive(h, activeMap('ses_child')); addMetadata(h, 'ses_parent');
  addMetadata(h, 'ses_child', live('ses_child', { parentID: 'ses_parent' })); addPending(h, 'ses_child');
  const activity = await source(h, 'activity');
  assert.equal(activity.instances[0].properties.active_count.numericValue.value, 1);
});

test('multiple unrelated active roots each count once', async () => {
  const h = harness(); await ready(h); addActive(h, activeMap('ses_a', 'ses_b'));
  for (const id of ['ses_a', 'ses_b']) { addMetadata(h, id); addPending(h, id); }
  const activity = await source(h, 'activity');
  assert.equal(activity.instances[0].properties.active_count.numericValue.value, 2);
});

test('permission has status precedence over form; both waiting types group once', async () => {
  const h = harness(); await ready(h); addActive(h, activeMap('ses_a', 'ses_b'));
  for (const id of ['ses_a', 'ses_b']) addMetadata(h, id);
  addPending(h, 'ses_a', [{ id: 'per_a', sessionID: 'ses_a' }], [{ id: 'frm_a', sessionID: 'ses_a' }]);
  addPending(h, 'ses_b', [], [{ id: 'frm_b', sessionID: 'ses_b' }]);
  const sessions = await source(h);
  assert.deepEqual(sessions.instances.map(item => item.properties.status.shortText.text), ['Approve', 'Input']);
  addActive(h, activeMap('ses_a', 'ses_b'));
  for (const id of ['ses_a', 'ses_b']) addMetadata(h, id);
  addPending(h, 'ses_a', [{ id: 'per_a', sessionID: 'ses_a' }], [{ id: 'frm_a', sessionID: 'ses_a' }]);
  addPending(h, 'ses_b', [], [{ id: 'frm_b', sessionID: 'ses_b' }]);
  const activity = await source(h, 'activity');
  assert.equal(activity.instances[0].properties.attention_count.numericValue.value, 2);
});

test('short nickname truncates at seven Unicode code points while long name keeps full nickname', async () => {
  const h = harness(); await ready(h);
  const nickname = '\u{10400}\u{10401}\u{10402}\u{10403}\u{10404}\u{10405}\u{10406}\u{10407}';
  const id = 'ses_nick'; addMetadata(h, id); await h.service.config({ type: 'save_session', session_id: id, nickname });
  addActive(h, activeMap(id)); addMetadata(h, id); addPending(h, id);
  const props = (await source(h)).instances[0].properties;
  assert.equal([...props.name.shortText.text].length, 7);
  assert.equal(props.name.shortText.text, [...nickname].slice(0, 7).join(''));
  assert.equal(props.name.longText.text, nickname);
});

test('missing optional metadata omitted and missing title falls back to Untitled session', async () => {
  const h = harness(); await ready(h); addActive(h, activeMap('ses_sparse'));
  const sparse = { id: 'ses_sparse', location: { directory: '/workspace' }, time: { updated: -1 } };
  addMetadata(h, 'ses_sparse', sparse); addPending(h, 'ses_sparse');
  const props = (await source(h)).instances[0].properties;
  assert.equal(props.name.longText.text, 'Untitled session');
  assert.ok([...props.name.shortText.text].length <= 7);
  assert.equal(props.directory.longText.text, '/workspace');
  for (const key of ['agent', 'model', 'updated']) assert.equal(props[key], undefined, key);
});

test('missing required session directory fails active scan and activity omits counts', async () => {
  const h = harness(); await ready(h); addActive(h, activeMap('ses_sparse'));
  addMetadata(h, 'ses_sparse', { id: 'ses_sparse', title: 'Sparse', location: {}, time: { updated: 1 } });
  await assert.rejects(source(h), error => error.code === 'PLUGIN_UNAVAILABLE');
  addActive(h, activeMap('ses_sparse'));
  addMetadata(h, 'ses_sparse', { id: 'ses_sparse', title: 'Sparse', location: {}, time: { updated: 1 } });
  const props = (await source(h, 'activity')).instances[0].properties;
  assert.equal(props.connected.boolean.value, true);
  assert.equal(props.active_count, undefined);
  assert.equal(props.attention_count, undefined);
});

test('activity checked_at reports attempt time in epoch seconds', async () => {
  const h = harness(); await ready(h); h.setNow(1700000099123); addActive(h, {});
  const props = (await source(h, 'activity')).instances[0].properties;
  assert.equal(props.checked_at.timestamp.value, 1700000099);
});

test('active source disconnected rejects; activity disconnected is unavailable and omits counts', async () => {
  const h = harness();
  await assert.rejects(source(h), error => error.code === 'AUTH_REQUIRED');
  const props = (await source(h, 'activity')).instances[0].properties;
  assert.equal(props.connected.boolean.value, false);
  assert.equal(props.active_count, undefined);
  assert.equal(props.attention_count, undefined);
  assert.equal(h.requests.length, 0);
});

test('active endpoint network error rejects source and activity omits counts without fake zero', async () => {
  const h = harness(); await ready(h);
  h.route('GET', '/api/session/active', () => { throw Error('private transport data'); });
  await assert.rejects(source(h), error => error.code === 'PLUGIN_UNAVAILABLE' && !error.message.includes('private'));
  h.route('GET', '/api/session/active', () => { throw Error('private transport data'); });
  const props = (await source(h, 'activity')).instances[0].properties;
  assert.equal(props.connected.boolean.value, false);
  assert.equal(props.active_count, undefined);
  assert.equal(props.summary.shortText.text, 'Unknown');
});

for (const [name, status, code] of [['auth', 401, 'AUTH_REQUIRED'], ['denied', 403, 'PERMISSION_DENIED']]) {
  test(`active ${name} failure maps safely and activity does not report zero`, async () => {
    const h = harness(); await ready(h); h.route('GET', '/api/session/active', response({ detail: 'private prompt credential' }, status));
    await assert.rejects(source(h), error => error.code === code && !/private|credential/.test(error.message));
    h.route('GET', '/api/session/active', response({ detail: 'private prompt credential' }, status));
    const props = (await source(h, 'activity')).instances[0].properties;
    assert.equal(props.active_count, undefined);
    assert.equal(props.attention_count, undefined);
    assert.equal(props.connected.boolean.value, false);
  });
}

test('active NotAllowedError is denied and does not leak browser error detail', async () => {
  const h = harness(); await ready(h);
  h.route('GET', '/api/session/active', () => { const e = Error('private credential'); e.name = 'NotAllowedError'; throw e; });
  await assert.rejects(source(h), error => error.code === 'PERMISSION_DENIED' && !error.message.includes('private'));
});

test('malformed JSON active response rejects source and activity marks status unavailable', async () => {
  const h = harness(); await ready(h);
  const bad = { status: 200, async json() { throw Error('secret payload'); } };
  h.route('GET', '/api/session/active', bad);
  await assert.rejects(source(h), error => error.code === 'PLUGIN_UNAVAILABLE');
  h.route('GET', '/api/session/active', bad);
  const props = (await source(h, 'activity')).instances[0].properties;
  assert.equal(props.connected.boolean.value, false);
  assert.equal(props.active_count, undefined);
});

for (const [description, payload] of [
  ['array instead of active map', { data: [] }],
  ['invalid session ID', { data: { bad: { type: 'running' } } }],
  ['unknown status type', { data: { ses_unknown: { type: 'mystery' } } }]
]) {
  test(`malformed active map (${description}) fails safely`, async () => {
    const h = harness(); await ready(h); h.route('GET', '/api/session/active', response(payload));
    await assert.rejects(source(h), error => error.code === 'PLUGIN_UNAVAILABLE');
    h.route('GET', '/api/session/active', response(payload));
    const props = (await source(h, 'activity')).instances[0].properties;
    assert.equal(props.active_count, undefined);
  });
}

test('active metadata failure rejects active source but activity keeps connected and omits counts', async () => {
  const h = harness(); await ready(h); addActive(h, activeMap('ses_live'));
  h.route('GET', '/api/session/ses_live', response({ error: 'private prompt' }, 500));
  await assert.rejects(source(h), error => error.code === 'PLUGIN_UNAVAILABLE');
  addActive(h, activeMap('ses_live'));
  h.route('GET', '/api/session/ses_live', response({ error: 'private prompt' }, 500));
  const props = (await source(h, 'activity')).instances[0].properties;
  assert.equal(props.connected.boolean.value, true);
  assert.equal(props.active_count, undefined);
  assert.equal(props.attention_count, undefined);
});

test('each active session validates both pending endpoint payloads; mismatch marks scan incomplete', async () => {
  const h = harness(); await ready(h); addActive(h, activeMap('ses_live')); addMetadata(h, 'ses_live');
  h.route('GET', '/api/session/ses_live/permission', response({ data: [{ id: 'per_x', sessionID: 'ses_other' }] }));
  h.route('GET', '/api/session/ses_live/form', response({ data: [] }));
  await assert.rejects(source(h), error => error.code === 'PLUGIN_UNAVAILABLE');
  addActive(h, activeMap('ses_live')); addMetadata(h, 'ses_live');
  h.route('GET', '/api/session/ses_live/permission', response({ data: [] }));
  h.route('GET', '/api/session/ses_live/form', response({ data: 'not-an-array' }));
  const props = (await source(h, 'activity')).instances[0].properties;
  assert.equal(props.connected.boolean.value, true);
  assert.equal(props.active_count, undefined);
});

test('valid permission cannot mask malformed or mismatched form payload', async t => {
  for (const [caseName, formValue] of [
    ['non-array form data', { data: { id: 'frm_1' } }],
    ['form session mismatch', { data: [{ id: 'frm_1', sessionID: 'ses_other' }] }]
  ]) await t.test(caseName, async () => {
    const h = harness(); await ready(h); addActive(h, activeMap('ses_live')); addMetadata(h, 'ses_live');
    h.route('GET', '/api/session/ses_live/permission', response({ data: [{ id: 'per_1', sessionID: 'ses_live' }] }));
    h.route('GET', '/api/session/ses_live/form', response(formValue));
    await assert.rejects(source(h), error => error.code === 'PLUGIN_UNAVAILABLE');
    addActive(h, activeMap('ses_live')); addMetadata(h, 'ses_live');
    h.route('GET', '/api/session/ses_live/permission', response({ data: [{ id: 'per_1', sessionID: 'ses_live' }] }));
    h.route('GET', '/api/session/ses_live/form', response(formValue));
    const props = (await source(h, 'activity')).instances[0].properties;
    assert.equal(props.connected.boolean.value, true);
    assert.equal(props.active_count, undefined);
    assert.equal(props.attention_count, undefined);
  });
});

test('pending endpoint 404 is incomplete, never a fabricated Running session', async () => {
  const h = harness(); await ready(h); addActive(h, activeMap('ses_live')); addMetadata(h, 'ses_live');
  h.route('GET', '/api/session/ses_live/permission', response({}, 404));
  h.route('GET', '/api/session/ses_live/form', response({ data: [] }));
  await assert.rejects(source(h), error => error.code === 'PLUGIN_UNAVAILABLE');
});

test('pending permission and form checks are GET-only and expose no pending content', async () => {
  const h = harness(); await ready(h); addActive(h, activeMap('ses_live')); addMetadata(h, 'ses_live');
  addPending(h, 'ses_live', [{ id: 'per_1', sessionID: 'ses_live', title: 'secret approval text' }], [{ id: 'frm_1', sessionID: 'ses_live', title: 'secret input' }]);
  const props = (await source(h)).instances[0].properties;
  assert.equal(props.status.shortText.text, 'Approve');
  assert.equal(JSON.stringify(props).includes('secret'), false);
  assert.ok(h.requests.every(req => req.method === 'GET'));
});

test('cycles, missing ancestors, and invalid parent IDs fail whole scan safely', async t => {
  await t.test('cycle', async () => {
    const h = harness(); await ready(h); addActive(h, activeMap('ses_a'));
    addMetadata(h, 'ses_a', live('ses_a', { parentID: 'ses_b' })); addMetadata(h, 'ses_b', live('ses_b', { parentID: 'ses_a' }));
    addPending(h, 'ses_a');
    await assert.rejects(source(h), error => error.code === 'PLUGIN_UNAVAILABLE');
  });
  await t.test('missing ancestor', async () => {
    const h = harness(); await ready(h); addActive(h, activeMap('ses_child'));
    addMetadata(h, 'ses_child', live('ses_child', { parentID: 'ses_missing' }));
    h.route('GET', '/api/session/ses_missing', response({}, 404));
    addPending(h, 'ses_child');
    await assert.rejects(source(h), error => error.code === 'PLUGIN_UNAVAILABLE');
  });
  await t.test('malformed parent ID', async () => {
    const h = harness(); await ready(h); addActive(h, activeMap('ses_child'));
    addMetadata(h, 'ses_child', live('ses_child', { parentID: '../bad' }));
    await assert.rejects(source(h), error => error.code === 'PLUGIN_UNAVAILABLE');
  });
});

test('ancestry depth limit fails closed', async () => {
  const h = harness(); await ready(h); addActive(h, activeMap('ses_0'));
  for (let i = 0; i <= 33; i++) addMetadata(h, `ses_${i}`, live(`ses_${i}`, i === 33 ? {} : { parentID: `ses_${i + 1}` }));
  addPending(h, 'ses_0');
  await assert.rejects(source(h), error => error.code === 'PLUGIN_UNAVAILABLE');
});

test('active ID and metadata limits fail closed', async t => {
  await t.test('more than 100 active IDs', async () => {
    const h = harness(); await ready(h); addActive(h, activeMap(...Array.from({ length: 101 }, (_, i) => `ses_${i}`)));
    await assert.rejects(source(h), error => error.code === 'PLUGIN_UNAVAILABLE');
  });
  await t.test('more than 200 distinct metadata rows', async () => {
    const h = harness(); await ready(h); addActive(h, activeMap(...Array.from({ length: 100 }, (_, i) => `ses_${i}`)));
    for (let i = 0; i < 100; i++) addMetadata(h, `ses_${i}`, live(`ses_${i}`, { parentID: `ses_parent_${i}` }));
    for (let i = 0; i < 101; i++) addMetadata(h, `ses_parent_${i}`, live(`ses_parent_${i}`, { parentID: `ses_grand_${i}` }));
    for (let i = 0; i < 101; i++) addMetadata(h, `ses_grand_${i}`);
    for (let i = 0; i < 100; i++) addPending(h, `ses_${i}`);
    await assert.rejects(source(h), error => error.code === 'PLUGIN_UNAVAILABLE');
  });
});

test('each source call rescans active API without cross-request cache', async () => {
  const h = harness(); await ready(h); addActive(h, {}); await source(h);
  addActive(h, activeMap('ses_new')); addMetadata(h, 'ses_new'); addPending(h, 'ses_new');
  const second = await source(h);
  assert.equal(second.instances[0].instanceId, 'ses_new');
  assert.equal(h.requests.filter(req => req.path === '/api/session/active').length, 2);
});

test('per-scan HTTP concurrency is bounded at four across active metadata and pending reads', async () => {
  const h = harness(); await ready(h);
  let inFlight = 0; let peak = 0;
  const delayed = value => async () => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise(resolve => setImmediate(resolve));
    inFlight--;
    return response(value);
  };
  const ids = Array.from({ length: 8 }, (_, index) => `ses_parallel_${index}`);
  h.route('GET', '/api/session/active', delayed({ data: activeMap(...ids) }));
  for (const id of ids) {
    h.route('GET', `/api/session/${id}`, delayed({ data: live(id) }));
    h.route('GET', `/api/session/${id}/permission`, delayed({ data: [] }));
    h.route('GET', `/api/session/${id}/form`, delayed({ data: [] }));
  }
  const result = await source(h);
  assert.equal(result.instances.length, ids.length);
  assert.ok(peak > 1);
  assert.ok(peak <= 4, `observed ${peak} simultaneous requests`);
});

test('unknown opencode source dispatch rejects while agent source contract remains available', async () => {
  const h = harness(); await ready(h);
  await assert.rejects(h.service.source({ category: 'opencode', item: 'unknown' }), error => error.code === 'INVALID_REQUEST');
  h.route('GET', '/api/session', response({ data: [], cursor: { previous: null, next: null } }));
  const chats = await h.service.source({ category: 'agent', item: 'chats' });
  assert.deepEqual(chats.instances, []);
});
