'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, response, session, page } = require('./helpers');

const KEY = 'opencode.plugin.state.v1';
const ALERTS_KEY = 'opencode.plugin.reply-alerts.v1';
const ENABLED_KEY = 'ocstatus.replyAlerts.enabled.v1';
const LAUNCH_KEY = 'ocstatus.replyLaunch.v1';
const MESSAGE_PATH = '/api/session/ses_reply/message';

class LocalStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

function makeHarness(options = {}, state = {}) {
  const h = harness(options);
  h.storage.values.set(KEY, {
    url: 'http://localhost:4096', username: 'opencode', password: 'pässword', version: '2.2.1',
    mode: 'default_chat', directory: '/workspace', selected: { session_id: 'ses_reply', title: 'Private title' },
    lastSessionID: null, nicknames: {}, reply_count: 10, default_delivery: 'queue',
    auth_method: 'password', reply_alerts: true, ...state
  });
  return h;
}

function addReplies(h, messages, updated = 1700000001) {
  h.route('GET', req => req.path === '/api/session', response(page([
    session('ses_reply', 'Private title', { time: { created: 1, updated } })
  ])));
  h.route('GET', req => req.path === '/api/session/active', response({ data: {} }));
  h.route('GET', req => req.path === MESSAGE_PATH, response({ data: messages, cursor: { next: null } }));
}

function completed(id, text, completedAt = 1700000001000, extra = {}) {
  return { id, type: 'assistant', time: { created: 1700000000000, completed: completedAt }, content: [{ type: 'text', text }], ...extra };
}

function writing(id) {
  return { id, type: 'assistant', time: { created: 1700000000000 }, content: [{ type: 'text', text: 'partial' }] };
}

const source = h => h.service.source({ category: 'opencode', item: 'replies' });

test('first successful replies snapshot seeds silently and later completion notifies once', async () => {
  const notifications = [];
  const h = makeHarness({ showNotification: notification => notifications.push(notification) });
  addReplies(h, [completed('msg_old', 'old private reply', 1700000001000)]);
  await source(h);
  assert.equal(notifications.length, 0);
  assert.ok(h.storage.values.get(ALERTS_KEY), 'baseline bookkeeping should persist');

  h.setNow(1700000060000);
  addReplies(h, [completed('msg_new', 'new private reply', 1700000059000)], 1700000059000);
  await source(h);
  assert.equal(notifications.length, 1);
  assert.deepEqual(notifications[0], {
    layout: {
      type: 'genericNotification', title: 'OpenCode reply ready',
      tinyIcon: 'system://images/NOTIFICATION_GENERIC'
    },
    actions: []
  });
  assert.equal(JSON.stringify(notifications[0]).includes('private'), false, 'notification must not expose reply text or session titles');

  h.setNow(1700000120000);
  addReplies(h, [completed('msg_new', 'new private reply', 1700000059000)], 1700000059000);
  await source(h);
  assert.equal(notifications.length, 1, 'completed reply must not alert twice');
});

test('same message ID alerts when it changes from Writing to Done', async () => {
  const notifications = [];
  const h = makeHarness({ showNotification: notification => notifications.push(notification) });
  addReplies(h, [writing('msg_write')]);
  await source(h);
  assert.equal(notifications.length, 0);

  h.setNow(1700000060000);
  addReplies(h, [completed('msg_write', 'finished', 1700000059000)], 1700000059000);
  await source(h);
  assert.equal(notifications.length, 1);

  h.setNow(1700000120000);
  addReplies(h, [completed('msg_write', 'finished', 1700000059000)], 1700000059000);
  await source(h);
  assert.equal(notifications.length, 1);
});

test('errored and old out-of-order completions are recorded without alerting', async () => {
  const notifications = [];
  const h = makeHarness({ showNotification: notification => notifications.push(notification) });
  addReplies(h, [completed('msg_base', 'baseline', 1700000001000)]);
  await source(h);

  h.setNow(1700000060000);
  addReplies(h, [
    completed('msg_failed', 'failed', 1700000059000, { error: { type: 'provider', message: 'failed' } }),
    completed('msg_old', 'old', 1699999999000)
  ], 1700000059000);
  await source(h);
  assert.equal(notifications.length, 0);

  h.setNow(1700000120000);
  addReplies(h, [completed('msg_failed', 'failed', 1700000059000, { error: { type: 'provider', message: 'failed' } })], 1700000059000);
  await source(h);
  assert.equal(notifications.length, 0);
});

test('reply alerts stay off by default and never notify when disabled', async () => {
  const notifications = [];
  const h = makeHarness({ showNotification: notification => notifications.push(notification) }, { reply_alerts: false });
  addReplies(h, [completed('msg_new', 'reply', 1700000059000)]);
  await source(h);
  assert.equal(notifications.length, 0);
  assert.equal(h.storage.values.has(ALERTS_KEY), false);
});

test('account change seeds a new baseline instead of alerting for the previous account', async () => {
  const notifications = [];
  const h = makeHarness({ showNotification: notification => notifications.push(notification) });
  addReplies(h, [completed('msg_a', 'account a', 1700000001000)]);
  await source(h);
  assert.equal(notifications.length, 0);

  const raw = h.storage.values.get(KEY);
  const saved = typeof raw === 'string' ? JSON.parse(raw) : raw;
  saved.url = 'http://other:4096';
  saved.username = 'other-user';
  h.storage.values.set(KEY, JSON.stringify(saved));
  h.setNow(1700000060000);
  addReplies(h, [completed('msg_b', 'account b', 1700000059000)], 1700000059000);
  await source(h);
  assert.equal(notifications.length, 0, 'new account snapshot must seed silently');
  assert.match(JSON.parse(h.storage.values.get(ALERTS_KEY)).scope, /other:4096/);
});

test('bundled notifications persist a bounded launch route before posting', async () => {
  const local = new LocalStorage();
  const notifications = [];
  const h = makeHarness({
    bundled: true, random: () => 0.25, localStorage: local,
    showNotification: notification => {
      notifications.push(notification);
      const routes = JSON.parse(local.getItem(LAUNCH_KEY));
      assert.deepEqual(routes[String(notification.actions[0].launchCode)], {
        sessionId: 'ses_reply', expiresAt: 1700000060000 + 600000
      });
    }
  });
  addReplies(h, [completed('msg_old', 'old', 1700000001000)]);
  await source(h);
  assert.equal(local.getItem(LAUNCH_KEY), null);

  h.setNow(1700000060000);
  addReplies(h, [completed('msg_new', 'new', 1700000059000)], 1700000059000);
  await source(h);
  assert.equal(notifications.length, 1);
  assert.deepEqual(notifications[0].actions, [{ title: 'Open reply', type: 'openWatchApp', launchCode: 1 }]);
  assert.deepEqual(JSON.parse(local.getItem(LAUNCH_KEY)), {
    '1': { sessionId: 'ses_reply', expiresAt: 1700000060000 + 600000 }
  });
});

test('standalone notifications have no open action and do not write launch routes', async () => {
  const local = new LocalStorage();
  const notifications = [];
  const h = makeHarness({ bundled: false, localStorage: local, showNotification: notification => notifications.push(notification) });
  addReplies(h, [completed('msg_old', 'old', 1700000001000)]);
  await source(h);
  h.setNow(1700000060000);
  addReplies(h, [completed('msg_new', 'new', 1700000059000)], 1700000059000);
  await source(h);
  assert.equal(notifications.length, 1);
  assert.deepEqual(notifications[0].actions, []);
  assert.equal(local.getItem(LAUNCH_KEY), null);
});

test('notification failure and unavailable app storage never fail the replies source', async () => {
  const h = makeHarness({ bundled: true, showNotification: () => { throw new Error('no notifications'); } });
  addReplies(h, [completed('msg_old', 'old', 1700000001000)]);
  await source(h);
  h.setNow(1700000060000);
  addReplies(h, [completed('msg_new', 'new', 1700000059000)], 1700000059000);
  const result = await source(h);
  assert.equal(result.instances.length, 1);
  const book = JSON.parse(h.storage.values.get(ALERTS_KEY));
  assert.equal(book.sessions.ses_reply.ids.includes('msg_new'), false, 'failed notification must remain eligible for retry');
});

test('denied permission skips notifications without consuming candidates until granted', async () => {
  let permission = 'denied';
  const notifications = [];
  const h = makeHarness({
    queryPermission: permissionName => {
      assert.equal(permissionName, 'ShowNotifications');
      return permission;
    },
    showNotification: notification => notifications.push(notification)
  });
  addReplies(h, [completed('msg_old', 'old', 1700000001000)]);
  await source(h);
  assert.equal(notifications.length, 0);

  h.setNow(1700000060000);
  addReplies(h, [completed('msg_new', 'new', 1700000059000)], 1700000059000);
  await source(h);
  assert.equal(notifications.length, 0, 'denied permission must not post');
  assert.equal(JSON.parse(h.storage.values.get(ALERTS_KEY)).sessions.ses_reply.ids.includes('msg_new'), false);

  permission = 'granted';
  addReplies(h, [completed('msg_new', 'new', 1700000059000)], 1700000059000);
  await source(h);
  assert.equal(notifications.length, 1, 'same completion must alert once permission is granted');
  assert.equal(JSON.parse(h.storage.values.get(ALERTS_KEY)).sessions.ses_reply.ids.includes('msg_new'), true);
});

test('throwing or rejected notifications remain eligible and later post', async () => {
  let mode = 'throw';
  const notifications = [];
  const h = makeHarness({
    queryPermission: async () => 'granted',
    showNotification: notification => {
      if (mode === 'throw') throw new Error('notification failed');
      if (mode === 'reject') return Promise.reject(new Error('notification rejected'));
      notifications.push(notification);
    }
  });
  addReplies(h, [completed('msg_old', 'old', 1700000001000)]);
  await source(h);

  h.setNow(1700000060000);
  addReplies(h, [completed('msg_new', 'new', 1700000059000)], 1700000059000);
  await source(h);
  assert.equal(JSON.parse(h.storage.values.get(ALERTS_KEY)).sessions.ses_reply.ids.includes('msg_new'), false);

  mode = 'reject';
  addReplies(h, [completed('msg_new', 'new', 1700000059000)], 1700000059000);
  await source(h);
  assert.equal(notifications.length, 0);
  assert.equal(JSON.parse(h.storage.values.get(ALERTS_KEY)).sessions.ses_reply.ids.includes('msg_new'), false);

  mode = 'ok';
  addReplies(h, [completed('msg_new', 'new', 1700000059000)], 1700000059000);
  await source(h);
  assert.equal(notifications.length, 1, 'same completion must alert after notification recovers');
});

test('granted permission posts once and consumes the completed reply', async () => {
  const notifications = [];
  const h = makeHarness({
    queryPermission: async () => 'granted',
    showNotification: notification => notifications.push(notification)
  });
  addReplies(h, [completed('msg_old', 'old', 1700000001000)]);
  await source(h);
  h.setNow(1700000060000);
  addReplies(h, [completed('msg_new', 'new', 1700000059000)], 1700000059000);
  await source(h);
  assert.equal(notifications.length, 1);
  assert.equal(JSON.parse(h.storage.values.get(ALERTS_KEY)).sessions.ses_reply.ids.includes('msg_new'), true);
  addReplies(h, [completed('msg_new', 'new', 1700000059000)], 1700000059000);
  await source(h);
  assert.equal(notifications.length, 1);
});

test('enabling reply alerts fails clearly when notifications are denied', async () => {
  const local = new LocalStorage();
  const h = makeHarness({
    localStorage: local,
    queryPermission: async () => 'denied',
    showNotification: () => {}
  }, { reply_alerts: false });
  await assert.rejects(h.service.config({ type: 'reply_alerts', enabled: true }),
    error => error.code === 'PERMISSION_DENIED' && /Pebble app/i.test(error.message));
  const stored = h.storage.values.get(KEY);
  const state = typeof stored === 'string' ? JSON.parse(stored) : stored;
  assert.equal(state.reply_alerts, false);
  assert.equal(local.getItem(ENABLED_KEY), null);
});

test('notification setting persists, syncs the app flag, and rejects unsupported devices', async () => {
  const local = new LocalStorage();
  const h = makeHarness({ localStorage: local, showNotification: () => {} });
  const enabled = await h.service.config({ type: 'reply_alerts', enabled: true });
  assert.equal(enabled.reply_alerts, true);
  assert.equal(local.getItem(ENABLED_KEY), '1');
  assert.equal(h.storage.values.get(KEY).reply_alerts, true);
  local.setItem(LAUNCH_KEY, JSON.stringify({ '5': { sessionId: 'ses_reply', expiresAt: 1700000500000 } }));
  await h.service.config({ type: 'reply_alerts', enabled: true });
  assert.ok(local.getItem(LAUNCH_KEY), 'idempotent enable must preserve outstanding tap routes');

  const disabled = await h.service.config({ type: 'reply_alerts', enabled: false });
  assert.equal(disabled.reply_alerts, false);
  assert.equal(local.getItem(ENABLED_KEY), null);

  const unsupported = makeHarness();
  await assert.rejects(unsupported.service.config({ type: 'reply_alerts', enabled: true }),
    error => error.code === 'PLUGIN_UNAVAILABLE');
  assert.equal(unsupported.storage.values.get(KEY).reply_alerts, true, 'stored setting should remain unchanged');
});

test('successful account change and disconnect remove old launch routes', async () => {
  const local = new LocalStorage();
  const h = makeHarness({ bundled: true, localStorage: local, showNotification: () => {} });
  local.setItem(LAUNCH_KEY, JSON.stringify({ '7': { sessionId: 'ses_reply', expiresAt: 1700000500000 } }));
  h.route('GET', '/api/info', response({ version: '2.2.1' }));
  await h.service.config({
    type: 'connect', url: 'http://other:4096', username: 'opencode', password: 'new-password'
  });
  assert.equal(local.getItem(LAUNCH_KEY), null);

  local.setItem(LAUNCH_KEY, JSON.stringify({ '8': { sessionId: 'ses_reply', expiresAt: 1700000500000 } }));
  local.setItem(ENABLED_KEY, '1');
  await h.service.config({ type: 'disconnect' });
  assert.equal(local.getItem(LAUNCH_KEY), null);
  assert.equal(local.getItem(ENABLED_KEY), null);
});
