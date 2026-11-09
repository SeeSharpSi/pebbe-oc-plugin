'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const manifest = require('../package.json').pebble;
const { harness: newHarness, response, connected } = require('./helpers');

const activeHarnesses = [];
function harness() { const h = newHarness(); activeHarnesses.push(h); return h; }
test.afterEach(() => {
  for (const h of activeHarnesses.splice(0)) assert.deepEqual(h.unexpected, [], 'strict mock saw unexpected Go usage request');
});

const source = h => h.service.source({ category: 'opencode', item: 'usage' });
const meter = (percent, limited = false, resetsAt = 1700000000000) => ({ percent, limited, resetsAt });
function usage(go = { rolling: meter(12.4), weekly: meter(63.6), monthly: meter(30) }, workspace = { id: 'wrk_1', name: 'Work', usageURL: 'https://console.example/usage' }) {
  return { location: {}, data: { workspace, go, budgets: [] } };
}

test('manifest declares one OpenCode Go usage instance with percentage and reset properties', () => {
  const declared = manifest.plugin.sources.find(item => item.items[0] === 'usage');
  assert.ok(declared);
  assert.equal(declared.supportsMultiple, false);
  assert.equal(declared.suggestedRefreshIntervalSec, 60);
  assert.deepEqual(declared.properties, {
    name: ['shortText', 'longText'], workspace_id: ['longText'], usage_url: ['longText'],
    go_rolling_percent: ['numericValue', 'shortText'], go_weekly_percent: ['numericValue', 'shortText'],
    go_monthly_percent: ['numericValue', 'shortText'], go_rolling_resets: ['timestamp'],
    go_weekly_resets: ['timestamp'], go_monthly_resets: ['timestamp'], limited: ['boolean', 'shortText'],
    status: ['shortText', 'longText'], summary: ['shortText', 'longText'], checked_at: ['timestamp']
  });
});

test('Go usage requires authentication before HTTP', async () => {
  const h = newHarness();
  await assert.rejects(source(h), error => error.code === 'AUTH_REQUIRED');
  assert.equal(h.requests.length, 0);
});

test('signed-out or non-Go workspace returns an empty source', async t => {
  for (const [label, payload] of [
    ['signed out', { location: {}, data: null }],
    ['no Go meters', { location: {}, data: { workspace: { id: 'wrk_1', usageURL: '' }, budgets: [] } }]
  ]) await t.test(label, async () => {
    const h = harness(); await connected(h);
    h.route('GET', '/api/experimental/usage/limits', response(payload));
    assert.deepEqual(await source(h), { validUntilMs: 1700000060000, instances: [] });
  });
});

test('Go usage maps meters, resets, workspace, and summary', async () => {
  const h = harness(); await connected(h);
  h.route('GET', '/api/experimental/usage/limits', response(usage()));
  const result = await source(h);
  assert.equal(result.validUntilMs, 1700000060000);
  assert.equal(result.instances.length, 1);
  const instance = result.instances[0];
  assert.equal(instance.instanceId, 'wrk_1');
  const p = instance.properties;
  assert.equal(p.name.shortText.text, 'Work');
  assert.equal(p.workspace_id.longText.text, 'wrk_1');
  assert.equal(p.usage_url.longText.text, 'https://console.example/usage');
  assert.deepEqual([
    p.go_rolling_percent.numericValue.value, p.go_rolling_percent.shortText.text,
    p.go_weekly_percent.numericValue.value, p.go_weekly_percent.shortText.text,
    p.go_monthly_percent.numericValue.value, p.go_monthly_percent.shortText.text
  ], [12.4, '12%', 63.6, '64%', 30, '30%']);
  assert.deepEqual([p.go_rolling_resets.timestamp.value, p.go_weekly_resets.timestamp.value, p.go_monthly_resets.timestamp.value], [1700000000, 1700000000, 1700000000]);
  assert.equal(p.limited.boolean.value, false);
  assert.equal(p.status.shortText.text, 'Active');
  assert.equal(p.summary.shortText.text, '64%');
  assert.equal(p.summary.longText.text, 'Go: 5h 12%, week 64%, month 30%');
  assert.equal(p.checked_at.timestamp.value, 1700000000);
  assert.ok(h.requests.every(req => req.method === 'GET'));
});

test('limited meter sets status and missing workspace name falls back', async () => {
  const h = harness(); await connected(h);
  h.route('GET', '/api/experimental/usage/limits', response(usage(
    { rolling: meter(100, true), weekly: meter(50), monthly: meter(20) },
    { id: 'wrk_2', usageURL: '' }
  )));
  const p = (await source(h)).instances[0].properties;
  assert.equal(p.name.longText.text, 'OpenCode Go');
  assert.equal(p.limited.boolean.value, true);
  assert.equal(p.status.shortText.text, 'Limited');
  assert.equal(p.status.longText.text, 'Go limit reached');
  assert.equal(Object.hasOwn(p, 'usage_url'), false);
});

test('unsupported and malformed Go usage responses fail rather than look empty', async t => {
  for (const [label, result, code] of [
    ['404 unsupported', response({}, 404), 'PLUGIN_UNAVAILABLE'],
    ['405 unsupported', response({}, 405), 'PLUGIN_UNAVAILABLE'],
    ['500 server error', response({}, 500), 'PLUGIN_UNAVAILABLE'],
    ['missing data', response({ location: {} }), 'PLUGIN_UNAVAILABLE'],
    ['bad workspace', response({ data: { workspace: { id: '', usageURL: '' }, go: usage().data.go } }), 'PLUGIN_UNAVAILABLE'],
    ['bad percent', response(usage({ rolling: meter(101), weekly: meter(1), monthly: meter(1) })), 'PLUGIN_UNAVAILABLE'],
    ['bad limited', response(usage({ rolling: { percent: 1, limited: 'no', resetsAt: 1 }, weekly: meter(1), monthly: meter(1) })), 'PLUGIN_UNAVAILABLE'],
    ['bad reset', response(usage({ rolling: meter(1, false, -1), weekly: meter(1), monthly: meter(1) })), 'PLUGIN_UNAVAILABLE']
  ]) await t.test(label, async () => {
    const h = harness(); await connected(h);
    h.route('GET', '/api/experimental/usage/limits', result);
    await assert.rejects(source(h), error => error.code === code);
  });
});
