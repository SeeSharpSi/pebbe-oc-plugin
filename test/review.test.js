'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const manifest = require('../package.json').pebble;
const { createService } = require('../src/plugin/index.js');
const { harness: newHarness, response, session } = require('./helpers');

const activeHarnesses = [];
function harness(state = {}) {
  const h = newHarness();
  activeHarnesses.push(h);
  h.storage.values.set('opencode.plugin.state.v1', {
    url: 'http://localhost:4096', username: 'opencode', password: 'pässword', version: '2.2.1',
    mode: 'default_chat', directory: '/configured', selected: { session_id: 'ses_focus', title: 'Focused' },
    lastSessionID: null, nicknames: {}, default_delivery: 'queue', ...state
  });
  return h;
}

test.afterEach(() => {
  for (const h of activeHarnesses.splice(0)) assert.deepEqual(h.unexpected, [], 'strict fetch mock saw unexpected request');
});

function addSession(h, id, value = session(id, 'Focused')) {
  h.route('GET', `/api/session/${id}`, response({ data: value }));
}
function action(h, name, args) { return h.service.action({ action: name, args }); }
function source(h, item) { return h.service.source({ category: 'opencode', item }); }
function location(req, directory) {
  assert.equal(req.search.get('location[directory]'), directory);
}
function addExecutionTimeline(h, messages, active = {}, extraSession = {}) {
  addSession(h, 'ses_focus', session('ses_focus', 'Focused', extraSession));
  h.route('GET', '/api/session/active', response({ data: active }));
  h.route('GET', req => req.path === '/api/session/ses_focus/message', response({ data: messages, cursor: { next: null } }));
}
function queueItem(id, created, sessionID = 'ses_focus') {
  return { id, sessionID, type: 'user', payload: { text: id }, delivery: 'queue', time: { created } };
}
function recreatedService(h, clock, storage = h.storage) {
  return createService({
    storage,
    now: () => clock.value,
    random: () => 'review-cache',
    fetch: async (url, options = {}) => {
      const parsed = new URL(url);
      const req = { path: parsed.pathname, search: parsed.searchParams, method: options.method || 'GET' };
      h.requests.push(req);
      const index = h.routes.findIndex(route => route.method === req.method && route.match(req));
      if (index < 0) {
        const message = `Unexpected request: ${req.method} ${parsed.pathname}${parsed.search}`;
        h.unexpected.push(message);
        throw Error(message);
      }
      const [route] = h.routes.splice(index, 1);
      return typeof route.result === 'function' ? route.result(req) : route.result;
    }
  });
}

test('new destructive actions require explicit confirmation and reject additional arguments', async () => {
  for (const name of ['cancel_queued_message', 'set_queued_delivery', 'stop_shell', 'run_command']) {
    const declaration = manifest.plugin.actions.find(item => item.name === name);
    assert.ok(declaration, `${name} manifest declaration exists`);
    assert.equal(declaration.destructive, true);
    assert.equal(declaration.requiresConfirmation, true);
    assert.equal(declaration.parameters.additionalProperties, false);
  }

  const h = harness();
  for (const [name, args] of [
    ['cancel_queued_message', { session_id: 'ses_ok', inbox_id: 'msg_inbox1', control: true }],
    ['set_queued_delivery', { session_id: 'ses_ok', inbox_id: 'msg_inbox1', delivery: 'queue', shell_id: 'sh_1' }],
    ['stop_shell', { shell_id: 'sh_1', directory: '/configured', session_id: 'ses_ok' }],
    ['run_command', { session_id: 'ses_ok', command: 'deploy', text: 'x', arbitrary: true }],
    ['cancel_queued_message', { session_id: 'ses\n_ok', inbox_id: 'msg_inbox1' }],
    ['run_command', { session_id: 'ses_ok', command: 'x'.repeat(201) }],
    ['cancel_queued_message', { session_id: 'ses_ok', inbox_id: '.' }],
    ['cancel_queued_message', { session_id: 'ses_ok', inbox_id: '..' }],
    ['cancel_queued_message', { session_id: 'ses_ok', inbox_id: 'inbox\u0001' }],
    ['cancel_queued_message', { session_id: 'ses_ok', inbox_id: 'i'.repeat(201) }],
    ['stop_shell', { shell_id: '.', directory: '/configured' }],
    ['stop_shell', { shell_id: '..', directory: '/configured' }],
    ['stop_shell', { shell_id: 'shell\u007f1', directory: '/configured' }],
    ['stop_shell', { shell_id: 's'.repeat(201), directory: '/configured' }]
  ]) await assert.rejects(action(h, name, args), error => error.code === 'INVALID_ARGS');
  assert.equal(h.requests.length, 0);
});

test('queue source scopes to default and last-sent sessions and publishes documented properties only', async () => {
  const h = harness({ lastSessionID: 'ses_last' });
  addSession(h, 'ses_focus');
  addSession(h, 'ses_last', session('ses_last', 'Last sent'));
  h.route('GET', req => req.path === '/api/session/ses_focus/inbox', response({ data: [
    { id: 'msg_focus', sessionID: 'ses_focus', type: 'user', payload: { text: 'focus text' }, delivery: 'queue', time: { created: 1 }, privateOutput: 'sensitive output' }
  ] }));
  h.route('GET', '/api/session/ses_last/inbox', response({ data: [
    { id: 'msg_last', sessionID: 'ses_last', type: 'user', payload: { text: 'last text' }, delivery: 'steer', time: { created: 2 } }
  ] }));
  const result = await source(h, 'queue');
  assert.equal(result.instances.length, 2);
  assert.deepEqual(Object.keys(result.instances[0].properties).sort(), ['delivery', 'inbox_id', 'kind', 'name', 'queued_at', 'session_id', 'text', 'url']);
  assert.deepEqual(result.instances.map(row => row.properties.inbox_id.longText.text), ['msg_focus', 'msg_last']);
  assert.deepEqual(result.instances.map(row => row.properties.session_id.longText.text), ['ses_focus', 'ses_last']);
  assert.equal(result.instances[0].properties.text.longText.text, 'focus text');
  assert.equal(JSON.stringify(result).includes('sensitive output'), false);
});

test('queue cancellation revalidates live session and inbox owner before one DELETE', async () => {
  const h = harness();
  addSession(h, 'ses_focus');
  h.route('GET', '/api/session/ses_focus/inbox', response({ data: [
    { id: 'msg_inbox1', sessionID: 'ses_focus', type: 'user', payload: { text: 'hello' }, delivery: 'queue', time: { created: 1 } }
  ] }));
  h.route('DELETE', '/api/session/ses_focus/inbox/msg_inbox1', response(null, 204));
  await action(h, 'cancel_queued_message', { session_id: 'ses_focus', inbox_id: 'msg_inbox1' });
  assert.equal(h.requests.filter(req => req.method === 'DELETE').length, 1);

  const crossSession = harness();
  addSession(crossSession, 'ses_focus');
  crossSession.route('GET', '/api/session/ses_focus/inbox', response({ data: [
    { id: 'msg_foreign', sessionID: 'ses_other', type: 'user', payload: { text: 'private' }, delivery: 'queue', time: { created: 1 } }
  ] }));
  await assert.rejects(action(crossSession, 'cancel_queued_message', { session_id: 'ses_focus', inbox_id: 'msg_foreign' }));
  assert.equal(crossSession.requests.some(req => req.method === 'DELETE'), false);
});

test('stale queue, command, and shell source listings cannot authorize mutations', async () => {
  const queueHarness = harness();
  addSession(queueHarness, 'ses_focus');
  addSession(queueHarness, 'ses_focus');
  const queued = { id: 'msg_stale', sessionID: 'ses_focus', type: 'user', payload: { text: 'stale' }, delivery: 'queue', time: { created: 1 } };
  queueHarness.route('GET', '/api/session/ses_focus/inbox', response({ data: [queued] }));
  queueHarness.route('GET', '/api/session/ses_focus/inbox', response({ data: [] }));
  const listedQueue = await source(queueHarness, 'queue');
  assert.equal(listedQueue.instances.length, 1);
  await assert.rejects(action(queueHarness, 'cancel_queued_message', { session_id: 'ses_focus', inbox_id: 'msg_stale' }));
  assert.equal(queueHarness.requests.some(req => ['DELETE', 'PATCH'].includes(req.method)), false);

  const commandHarness = harness();
  addSession(commandHarness, 'ses_focus');
  addSession(commandHarness, 'ses_focus');
  const commands = directory => response({ location: { directory }, data: [{ name: 'deploy', description: 'Deploy' }] });
  commandHarness.route('GET', req => req.path === '/api/command', req => { location(req, '/workspace'); return commands('/workspace'); });
  commandHarness.route('GET', req => req.path === '/api/command', req => {
    location(req, '/workspace');
    return response({ location: { directory: '/workspace' }, data: [] });
  });
  const listedCommands = await source(commandHarness, 'command');
  assert.equal(listedCommands.instances.length, 1);
  await assert.rejects(action(commandHarness, 'run_command', { session_id: 'ses_focus', command: 'deploy' }));
  assert.equal(commandHarness.requests.some(req => req.method === 'POST'), false);

  const shellHarness = harness();
  addSession(shellHarness, 'ses_focus', session('ses_focus', 'Focused', { location: { directory: '/workspace' } }));
  addSession(shellHarness, 'ses_focus', session('ses_focus', 'Focused', { location: { directory: '/workspace' } }));
  shellHarness.route('GET', req => req.path === '/api/shell', req => {
    location(req, '/workspace');
    return response({ location: { directory: '/workspace' }, data: [{
      id: 'sh_stale', command: 'build', cwd: '/workspace', status: 'running', time: { started: 1 }
    }] });
  });
  shellHarness.route('GET', req => req.path === '/api/shell/sh_stale', req => {
    location(req, '/workspace');
    return response({ location: { directory: '/workspace' }, data: { id: 'sh_stale', status: 'exited' } });
  });
  const listedShells = await source(shellHarness, 'shell');
  assert.equal(listedShells.instances.length, 1);
  await assert.rejects(action(shellHarness, 'stop_shell', { shell_id: 'sh_stale', directory: '/workspace' }));
  assert.equal(shellHarness.requests.some(req => req.method === 'DELETE'), false);
});

test('delivery update validates explicit mode and patches once after live owner check', async () => {
  for (const [saved, explicit, expected] of [['queue', 'queue', 'queue'], ['steer', 'steer', 'steer'], ['steer', 'queue', 'queue']]) {
    const h = harness({ default_delivery: saved });
    addSession(h, 'ses_focus');
    h.route('GET', '/api/session/ses_focus/inbox', response({ data: [
      { id: 'msg_inbox1', sessionID: 'ses_focus', type: 'user', payload: { text: 'hello' }, delivery: 'queue', time: { created: 1 } }
    ] }));
    h.route('PATCH', '/api/session/ses_focus/inbox/msg_inbox1', req => {
      assert.deepEqual(req.body, { delivery: expected });
      return response(null, 204);
    });
    await action(h, 'set_queued_delivery', { session_id: 'ses_focus', inbox_id: 'msg_inbox1', delivery: explicit });
    assert.equal(h.requests.filter(req => req.method === 'PATCH').length, 1);
  }
  const invalid = harness();
  await assert.rejects(action(invalid, 'set_queued_delivery', { session_id: 'ses_focus', inbox_id: 'x', delivery: 'later' }), error => error.code === 'INVALID_ARGS');
  assert.equal(invalid.requests.length, 0);
});

test('archived sessions block queue mutations before mutation', async () => {
  for (const [name, args] of [
    ['cancel_queued_message', { session_id: 'ses_focus', inbox_id: 'msg_inbox1' }],
    ['set_queued_delivery', { session_id: 'ses_focus', inbox_id: 'msg_inbox1', delivery: 'queue' }]
  ]) {
    const h = harness();
    addSession(h, 'ses_focus', session('ses_focus', 'Archived', { time: { archived: 1700000000 } }));
    await assert.rejects(action(h, name, args));
    assert.equal(h.requests.filter(req => req.method === 'GET' && req.path === '/api/session/ses_focus').length, 1);
    assert.equal(h.requests.some(req => ['POST', 'PATCH', 'DELETE'].includes(req.method)), false);
  }
});

test('archived session run_command rediscovers and posts once', async () => {
  const h = harness();
  addSession(h, 'ses_focus', session('ses_focus', 'Archived', { time: { archived: 1700000000 } }));
  h.route('GET', req => req.path === '/api/command', req => {
    location(req, '/workspace');
    return response({ location: { directory: '/workspace' }, data: [{ name: 'deploy' }] });
  });
  h.route('POST', '/api/session/ses_focus/command', req => {
    assert.deepEqual(req.body, { name: 'deploy', text: '', delivery: 'queue' });
    return response(null, 204);
  });
  const result = await action(h, 'run_command', { session_id: 'ses_focus', command: 'deploy' });
  assert.match(result.text, /Command invocation sent/);
  assert.equal(h.requests.filter(req => req.method === 'POST').length, 1);
});

test('shell and command sources use focused session location, not shell cwd, and omit raw output', async () => {
  const h = harness();
  addSession(h, 'ses_focus', session('ses_focus', 'Focused', { location: { directory: '/session/project' } }));
  h.route('GET', req => req.path === '/api/shell', req => {
    location(req, '/session/project');
    return response({ location: { directory: '/session/project' }, data: [{
      id: 'sh_1', command: 'build', directory: '/session/project', cwd: '/different/cwd', status: 'running',
      time: { started: 1, completed: 3 }, exitCode: 0, output: 'SENSITIVE_RAW_OUTPUT'
    }] });
  });
  h.route('GET', req => req.path === '/api/command', req => {
    location(req, '/session/project');
    return response({ location: { directory: '/session/project' }, data: [{ name: 'deploy', description: 'Deploy' }] });
  });
  const shell = await source(h, 'shell');
  addSession(h, 'ses_focus', session('ses_focus', 'Focused', { location: { directory: '/session/project' } }));
  const commands = await source(h, 'command');
  assert.equal(shell.instances.length, 1);
  assert.equal(shell.instances[0].properties.directory.longText.text, '/session/project');
  assert.equal(shell.instances[0].properties.cwd.longText.text, '/different/cwd');
  assert.equal(JSON.stringify([shell, commands]).includes('SENSITIVE_RAW_OUTPUT'), false);
});

test('new-chat command source is scoped to configured absolute creation directory', async () => {
  const h = harness({ mode: 'new_chat', directory: '/configured/project', selected: null });
  h.route('GET', req => req.path === '/api/command', req => {
    location(req, '/configured/project');
    return response({ location: { directory: '/configured/project' }, data: [] });
  });
  await source(h, 'command');
});

test('new-chat shell source is scoped to configured absolute creation directory', async () => {
  const h = harness({ mode: 'new_chat', directory: '/configured/project', selected: null });
  h.route('GET', req => req.path === '/api/shell', req => {
    location(req, '/configured/project');
    return response({ location: { directory: '/configured/project' }, data: [] });
  });
  await source(h, 'shell');
});

test('mismatched shell ID or location never triggers DELETE; ownership uses directory, not cwd', async () => {
  for (const shellValue of [
    { id: 'sh_other', location: { directory: '/project' }, cwd: '/project', status: 'running' },
    { id: 'sh_1', location: { directory: '/elsewhere' }, cwd: '/project', status: 'running' }
  ]) {
    const h = harness();
    addSession(h, 'ses_focus', session('ses_focus', 'Focused', { location: { directory: '/project' } }));
    h.route('GET', req => req.path === '/api/shell/sh_1', req => {
      location(req, '/project');
      return response({ location: shellValue.location, data: shellValue });
    });
    await assert.rejects(action(h, 'stop_shell', { shell_id: 'sh_1', directory: '/project' }));
    assert.equal(h.requests.some(req => req.method === 'DELETE'), false);
  }
  const valid = harness();
  addSession(valid, 'ses_focus', session('ses_focus', 'Focused', { location: { directory: '/project' } }));
  valid.route('GET', req => req.path === '/api/shell/sh_1', req => {
    location(req, '/project');
    return response({ location: { directory: '/project' }, data: { id: 'sh_1', location: { directory: '/project' }, cwd: '/different', status: 'running' } });
  });
  valid.route('DELETE', req => req.path === '/api/shell/sh_1', req => {
    location(req, '/project');
    return response(null, 204);
  });
  await action(valid, 'stop_shell', { shell_id: 'sh_1', directory: '/project' });
  assert.equal(valid.requests.filter(req => req.method === 'DELETE').length, 1);
});

test('run_command rediscovers exact command at live location and posts bounded text once', async () => {
  const h = harness({ default_delivery: 'steer' });
  addSession(h, 'ses_focus', session('ses_focus', 'Focused', { location: { directory: '/session/project' } }));
  h.route('GET', req => req.path === '/api/command', req => {
    location(req, '/session/project');
    return response({ location: { directory: '/session/project' }, data: [{ name: 'deploy' }] });
  });
  h.route('POST', '/api/session/ses_focus/command', req => {
    assert.deepEqual(req.body, { name: 'deploy', text: 'release', delivery: 'steer' });
    return response(null, 204);
  });
  await action(h, 'run_command', { session_id: 'ses_focus', command: 'deploy', text: 'release' });
  assert.equal(h.requests.filter(req => req.method === 'POST').length, 1);
});

test('run_command defaults to queue and explicit delivery overrides saved default', async () => {
  for (const [saved, explicit, expected] of [['queue', undefined, 'queue'], ['queue', 'steer', 'steer'], ['steer', 'queue', 'queue']]) {
    const h = harness({ default_delivery: saved });
    addSession(h, 'ses_focus');
    h.route('GET', req => req.path === '/api/command', req => {
      location(req, '/workspace');
      return response({ location: { directory: '/workspace' }, data: [{ name: 'deploy' }] });
    });
    h.route('POST', '/api/session/ses_focus/command', req => {
      assert.deepEqual(req.body, { name: 'deploy', text: '', delivery: expected });
      return response(null, 204);
    });
    await action(h, 'run_command', { session_id: 'ses_focus', command: 'deploy', ...(explicit ? { delivery: explicit } : {}) });
  }
});

test('registered command names containing slash remain valid body values', async () => {
  const h = harness();
  addSession(h, 'ses_focus', session('ses_focus', 'Focused', { location: { directory: '/workspace' } }));
  h.route('GET', req => req.path === '/api/command', req => {
    location(req, '/workspace');
    return response({ location: { directory: '/workspace' }, data: [{ name: 'foo/bar' }] });
  });
  h.route('POST', '/api/session/ses_focus/command', req => {
    assert.equal(req.body.name, 'foo/bar');
    return response(null, 204);
  });
  await action(h, 'run_command', { session_id: 'ses_focus', command: 'foo/bar' });
});

test('unknown command, mismatched location, and invalid text never POST', async t => {
  await t.test('unknown command', async () => {
    const h = harness(); addSession(h, 'ses_focus');
    h.route('GET', req => req.path === '/api/command', req => {
      location(req, '/workspace');
      return response({ location: { directory: '/workspace' }, data: [{ name: 'known' }] });
    });
    await assert.rejects(action(h, 'run_command', { session_id: 'ses_focus', command: 'unknown' }));
    assert.equal(h.requests.some(req => req.method === 'POST'), false);
  });
  await t.test('location mismatch cannot leak command list', async () => {
    const h = harness(); addSession(h, 'ses_focus', session('ses_focus', 'Focused', { location: { directory: '/expected' } }));
    h.route('GET', req => req.path === '/api/command', req => {
      location(req, '/expected');
      return response({ location: { directory: '/other' }, data: [{ name: 'secret-command' }] });
    });
    await assert.rejects(source(h, 'command'));
  });
  await t.test('invalid text length', async () => {
    const h = harness();
    await assert.rejects(action(h, 'run_command', { session_id: 'ses_focus', command: 'deploy', text: 'x'.repeat(16001) }), error => error.code === 'INVALID_ARGS');
    assert.equal(h.requests.length, 0);
  });
});

test('uncertain mutating requests are not retried or echoed', async t => {
  await t.test('queue delete network failure', async () => {
    const h = harness(); addSession(h, 'ses_focus');
    h.route('GET', '/api/session/ses_focus/inbox', response({ data: [{ id: 'msg_inbox1', sessionID: 'ses_focus', type: 'user', payload: { text: 'secret input' }, delivery: 'queue', time: { created: 1 } }] }));
    h.route('DELETE', '/api/session/ses_focus/inbox/msg_inbox1', () => { throw Error('SENSITIVE_TRANSPORT_DETAIL'); });
    await assert.rejects(action(h, 'cancel_queued_message', { session_id: 'ses_focus', inbox_id: 'msg_inbox1' }), error =>
      !/SENSITIVE/.test(error.message) && /uncertain|inspect|retry/i.test(error.message));
    assert.equal(h.requests.filter(req => req.method === 'DELETE').length, 1);
  });
  await t.test('command post network failure', async () => {
    const h = harness(); addSession(h, 'ses_focus');
    h.route('GET', req => req.path === '/api/command', req => {
      location(req, '/workspace');
      return response({ location: { directory: '/workspace' }, data: [{ name: 'deploy' }] });
    });
    h.route('POST', '/api/session/ses_focus/command', () => { throw Error('SENSITIVE_OUTPUT_DETAIL'); });
    await assert.rejects(action(h, 'run_command', { session_id: 'ses_focus', command: 'deploy', text: 'SENSITIVE_INPUT' }), error =>
      !/SENSITIVE/.test(error.message) && /uncertain|inspect|retry/i.test(error.message));
    assert.equal(h.requests.filter(req => req.method === 'POST').length, 1);
  });
  for (const status of [404, 409]) {
    await t.test(`queue delete HTTP ${status} is not retried`, async () => {
      const h = harness(); addSession(h, 'ses_focus');
      h.route('GET', '/api/session/ses_focus/inbox', response({ data: [
        { id: 'msg_inbox1', sessionID: 'ses_focus', type: 'user', payload: { text: 'hello' }, delivery: 'queue', time: { created: 1 } }
      ] }));
      h.route('DELETE', '/api/session/ses_focus/inbox/msg_inbox1', response({ detail: 'private server response' }, status));
      await assert.rejects(action(h, 'cancel_queued_message', { session_id: 'ses_focus', inbox_id: 'msg_inbox1' }), error =>
        !error.message.includes('private server response'));
      assert.equal(h.requests.filter(req => req.method === 'DELETE').length, 1);
    });
  }
});

test('reply cache reuse requires idle live state; a running session refreshes despite stable succeeded metadata', async () => {
  const h = harness({
    selected: { session_id: 'ses_cache', title: 'Cached reply' },
    cache_generation: 'reply-cache-generation'
  });
  const clock = { value: 1700000000000 };
  const stableSession = () => session('ses_cache', 'Cached reply', {
    outcome: 'succeeded', info: { outcome: 'succeeded' }, time: { created: 1, updated: 1000 }
  });
  const addSession = () => h.route('GET', '/api/session/ses_cache', response({ data: stableSession() }));
  const addMessages = messages => h.route('GET', req => req.path === '/api/session/ses_cache/message', response({ data: messages, cursor: { next: null } }));
  const service = () => recreatedService(h, clock);
  const completed = [{
    id: 'msg_done', type: 'assistant', time: { created: 900, completed: 1000 }, finish: 'stop',
    content: [{ type: 'text', text: 'old completed answer' }]
  }];

  addSession(); addMessages(completed);
  const first = await service().source({ category: 'opencode', item: 'reply' });
  assert.equal(first.instances[0].properties.text.longText.text, 'old completed answer');
  assert.equal(h.requests.filter(req => req.path === '/api/session/ses_cache/message').length, 1);

  clock.value += 1000;
  addSession();
  h.route('GET', '/api/session/active', response({ data: {} }));
  const idle = await service().source({ category: 'opencode', item: 'reply' });
  assert.equal(idle.instances[0].properties.text.longText.text, 'old completed answer');
  assert.equal(h.requests.filter(req => req.path === '/api/session/ses_cache/message').length, 1, 'idle cache hit skips message fetch');

  clock.value += 5000;
  addSession();
  h.route('GET', '/api/session/active', response({ data: { ses_cache: { type: 'running' } } }));
  addMessages([{
    id: 'msg_running', type: 'assistant', time: { created: 6000 },
    content: [{ type: 'text', text: 'new live answer' }]
  }]);
  const running = await service().source({ category: 'opencode', item: 'reply' });
  assert.equal(running.instances[0].properties.text.longText.text, 'new live answer');
  assert.equal(running.instances[0].properties.complete.boolean.value, false);
  assert.equal(h.requests.filter(req => req.path === '/api/session/ses_cache/message').length, 2, 'running state forces fresh assistant page');
});

test('newest textless incomplete assistant prevents caching older completed readable reply', async () => {
  const h = harness({
    selected: { session_id: 'ses_incomplete', title: 'Incomplete reply' },
    cache_generation: 'incomplete-cache-generation'
  });
  const clock = { value: 1700000000000 };
  const stableSession = () => session('ses_incomplete', 'Incomplete reply', {
    outcome: 'succeeded', info: { outcome: 'succeeded' }, time: { created: 1, updated: 1000 }
  });
  const addSession = () => h.route('GET', '/api/session/ses_incomplete', response({ data: stableSession() }));
  const messages = [
    {
      id: 'msg_tool_running', type: 'assistant', time: { created: 1100 },
      content: [{ type: 'tool', id: 'call_running', name: 'shell', state: { status: 'running', input: { private: true } } }]
    },
    {
      id: 'msg_older_done', type: 'assistant', time: { created: 900, completed: 1000 }, finish: 'stop',
      content: [{ type: 'text', text: 'older readable answer' }]
    }
  ];
  const addMessages = () => h.route('GET', req => req.path === '/api/session/ses_incomplete/message', response({ data: messages, cursor: { next: null } }));
  const service = () => recreatedService(h, clock);

  addSession(); addMessages();
  const first = await service().source({ category: 'opencode', item: 'reply' });
  assert.equal(first.instances[0].properties.text.longText.text, 'older readable answer');
  assert.equal(first.instances[0].properties.complete.boolean.value, true);

  clock.value += 1000;
  addSession(); addMessages();
  const second = await service().source({ category: 'opencode', item: 'reply' });
  assert.equal(second.instances[0].properties.text.longText.text, 'older readable answer');
  assert.equal(h.requests.filter(req => req.path === '/api/session/ses_incomplete/message').length, 2,
    'older completed text is not cached while newest assistant message remains incomplete');
});

test('legacy credential state stays untouched by source cache writes and disconnect race', async t => {
  const stateKey = 'opencode.plugin.state.v1';
  const password = 'legacy-secret-password';
  const oldState = {
    url: 'http://localhost:4096', username: 'opencode', password, version: '2.2.1',
    mode: 'default_chat', directory: '/workspace', selected: null, lastSessionID: null, nicknames: {}
  };

  await t.test('source active scan does not migrate or rewrite credential state', async () => {
    const h = newHarness();
    activeHarnesses.push(h);
    h.storage.values.set(stateKey, oldState);
    let stateWrites = 0;
    const storage = {
      getItem: key => h.storage.getItem(key),
      async setItem(key, value) {
        if (key === stateKey) stateWrites += 1;
        return h.storage.setItem(key, value);
      },
      removeItem: key => h.storage.removeItem(key)
    };
    const service = createService({
      storage,
      fetch: async (url, options = {}) => {
        const parsed = new URL(url);
        const req = { path: parsed.pathname, method: options.method || 'GET' };
        h.requests.push(req);
        if (req.method !== 'GET' || req.path !== '/api/session/active') {
          h.unexpected.push(`Unexpected request: ${req.method} ${req.path}`);
          throw Error('unexpected request');
        }
        return response({ data: {} });
      }
    });

    const result = await service.source({ category: 'opencode', item: 'active_session' });
    assert.deepEqual(result.instances, []);
    assert.equal(stateWrites, 0);
    assert.deepEqual(await h.storage.getItem(stateKey), oldState);
    assert.ok(h.requests.every(req => req.method === 'GET'));
    const otherStoredValues = [...h.storage.values.entries()].filter(([key]) => key !== stateKey).map(([, value]) => value);
    assert.equal(JSON.stringify(otherStoredValues).includes(password), false);
  });

  await t.test('in-flight read completing after disconnect cannot restore credential state', async () => {
    const h = newHarness();
    activeHarnesses.push(h);
    h.storage.values.set(stateKey, oldState);
    let stateWrites = 0;
    const storage = {
      getItem: key => h.storage.getItem(key),
      async setItem(key, value) {
        if (key === stateKey) stateWrites += 1;
        return h.storage.setItem(key, value);
      },
      removeItem: key => h.storage.removeItem(key)
    };
    let resolveFetch;
    let notifyStarted;
    const started = new Promise(resolve => { notifyStarted = resolve; });
    const pendingResponse = new Promise(resolve => { resolveFetch = resolve; });
    const service = createService({
      storage,
      fetch: async (url, options = {}) => {
        const parsed = new URL(url);
        const req = { path: parsed.pathname, method: options.method || 'GET' };
        h.requests.push(req);
        if (req.method !== 'GET' || req.path !== '/api/session/active') {
          h.unexpected.push(`Unexpected request: ${req.method} ${req.path}`);
          throw Error('unexpected request');
        }
        notifyStarted();
        return pendingResponse;
      }
    });

    const sourcePromise = service.source({ category: 'opencode', item: 'active_session' });
    await started;
    await service.config({ type: 'disconnect' });
    assert.equal(h.storage.values.has(stateKey), false);
    resolveFetch(response({ data: {} }));
    const result = await sourcePromise;
    assert.deepEqual(result.instances, []);
    assert.equal(h.storage.values.has(stateKey), false);
    assert.equal(stateWrites, 0);
    assert.ok(h.requests.every(req => req.method === 'GET'));
    const otherStoredValues = [...h.storage.values.entries()].filter(([key]) => key !== stateKey).map(([, value]) => value);
    assert.equal(JSON.stringify(otherStoredValues).includes(password), false);
  });
});

test('legacy credentials without cache_generation reuse active snapshot without rewriting STATE', async () => {
  const h = newHarness();
  activeHarnesses.push(h);
  const stateKey = 'opencode.plugin.state.v1';
  const password = 'legacy-private-password';
  const rawState = JSON.stringify({
    url: 'http://localhost:4096', username: 'opencode', password, version: '2.2.1',
    mode: 'default_chat', directory: '/workspace', selected: null, lastSessionID: null, nicknames: {}
  });
  h.storage.values.set(stateKey, rawState);
  let stateWrites = 0;
  const storage = {
    getItem: key => h.storage.getItem(key),
    async setItem(key, value) {
      if (key === stateKey) stateWrites += 1;
      return h.storage.setItem(key, value);
    },
    removeItem: key => h.storage.removeItem(key)
  };
  const clock = { value: 1700000000000 };
  h.route('GET', '/api/session/active', response({ data: {} }));
  h.route('GET', '/api/session/active', response({ data: {} }));

  const first = await recreatedService(h, clock, storage).source({ category: 'opencode', item: 'active_session' });
  assert.deepEqual(first.instances, []);
  assert.equal(stateWrites, 0);
  assert.equal(await storage.getItem(stateKey), rawState);

  clock.value += 1000;
  const second = await recreatedService(h, clock, storage).source({ category: 'opencode', item: 'active_session' });
  assert.deepEqual(second.instances, []);
  assert.equal(h.requests.filter(req => req.path === '/api/session/active').length, 1,
    'fresh service reuses cached active snapshot within five seconds');
  assert.equal(stateWrites, 0);
  assert.equal(await storage.getItem(stateKey), rawState);
  const nonStateValues = [...h.storage.values.entries()].filter(([key]) => key !== stateKey).map(([, value]) => value);
  assert.equal(JSON.stringify(nonStateValues).includes(password), false);
});

test('execution source respects retry, compaction, and running-tool timeline precedence', async t => {
  await t.test('active session with valid retry reports Retrying and retry timestamp', async () => {
    const h = harness();
    addExecutionTimeline(h, [{
      id: 'msg_retry', type: 'assistant', time: { created: 1700000000000 }, content: [],
      retry: { attempt: 2, at: 1700000123456, error: { type: 'APIError', message: 'Temporary failure' } }
    }], { ses_focus: { type: 'running' } });
    const result = await source(h, 'execution');
    assert.equal(result.instances[0].properties.status.shortText.text, 'Retrying');
    assert.equal(result.instances[0].properties.retry_at.timestamp.value, 1700000123);
    assert.ok(h.requests.every(req => req.method === 'GET'));
  });

  await t.test('active compaction reports Compacting rather than Running', async () => {
    const h = harness();
    addExecutionTimeline(h, [{
      id: 'msg_compacting', type: 'compaction', time: { created: 1700000000000 },
      status: 'running', reason: 'manual', summary: 'Compacting conversation'
    }], { ses_focus: { type: 'running' } });
    const result = await source(h, 'execution');
    assert.equal(result.instances[0].properties.status.shortText.text, 'Compacting');
    assert.notEqual(result.instances[0].properties.status.shortText.text, 'Running');
  });

  await t.test('last running tool wins, and tool input/output stay private', async () => {
    const h = harness();
    addExecutionTimeline(h, [{
      id: 'msg_tools', type: 'assistant', time: { created: 1700000000000 }, content: [
        { type: 'tool', id: 'call_done', name: 'finished_tool', state: { status: 'completed', input: { secret: 'hidden input' }, output: 'hidden output' } },
        { type: 'tool', id: 'call_active', name: 'active_tool', state: { status: 'running', input: { secret: 'also hidden' } } }
      ]
    }], { ses_focus: { type: 'running' } });
    const result = await source(h, 'execution');
    const properties = result.instances[0].properties;
    assert.equal(properties.tool && properties.tool.longText.text, 'active_tool');
    assert.doesNotMatch(JSON.stringify(result), /hidden input|hidden output|also hidden/);
  });
});

test('execution source accepts actual switched timeline enums and uses interrupted session outcome', async t => {
  await t.test('agent-switched and model-switched entries with required IDs and times', async () => {
    const h = harness();
    addExecutionTimeline(h, [
      { id: 'msg_agent_switch', type: 'agent-switched', agent: 'build', time: { created: 20 } },
      { id: 'msg_model_switch', type: 'model-switched', model: { providerID: 'test', id: 'model' }, time: { created: 10 } }
    ]);
    const result = await source(h, 'execution');
    assert.equal(result.instances.length, 1);
    assert.ok(h.requests.every(req => req.method === 'GET'));
  });

  await t.test('interrupted outcome with empty inactive timeline does not report Idle', async () => {
    const h = harness();
    addExecutionTimeline(h, [], {}, { outcome: 'interrupted', info: { outcome: 'interrupted' } });
    const result = await source(h, 'execution');
    assert.equal(result.instances[0].properties.status.shortText.text, 'Interrupted');
    assert.notEqual(result.instances[0].properties.status.shortText.text, 'Idle');
  });
});

test('execution source rejects mismatched sessions, duplicate IDs, and malformed content after a tool', async t => {
  await t.test('mismatched explicit message owner', async () => {
    const h = harness();
    addExecutionTimeline(h, [{
      id: 'msg_wrong_owner', sessionID: 'ses_other', type: 'assistant', time: { created: 10 }, content: [{ type: 'text', text: 'not owned' }]
    }]);
    await assert.rejects(source(h, 'execution'));
  });

  await t.test('duplicate timeline IDs', async () => {
    const h = harness();
    addExecutionTimeline(h, [
      { id: 'msg_duplicate', type: 'user', text: '', time: { created: 20 } },
      { id: 'msg_duplicate', type: 'user', text: '', time: { created: 10 } }
    ]);
    await assert.rejects(source(h, 'execution'));
  });

  await t.test('malformed content after first tool is not ignored', async () => {
    const h = harness();
    addExecutionTimeline(h, [{
      id: 'msg_bad_part', type: 'assistant', time: { created: 10 }, content: [
        { type: 'tool', id: 'call_done', name: 'finished_tool', state: { status: 'completed' } },
        { type: 'unsupported', private: 'must not be returned' }
      ]
    }]);
    await assert.rejects(source(h, 'execution'));
  });
});

test('queue source preserves server enqueue order and rejects duplicate or oversized inbox lists', async t => {
  await t.test('preserves response order despite skewed creation timestamps', async () => {
    const h = harness();
    addSession(h, 'ses_focus');
    h.route('GET', '/api/session/ses_focus/inbox', response({ data: [
      queueItem('msg_first', 20), queueItem('msg_second', 10)
    ] }));
    const result = await source(h, 'queue');
    assert.deepEqual(result.instances.map(row => row.properties.inbox_id.longText.text), ['msg_first', 'msg_second']);
    assert.ok(h.requests.every(req => req.method === 'GET'));
  });

  await t.test('rejects duplicate session/message composite IDs', async () => {
    const h = harness();
    addSession(h, 'ses_focus');
    h.route('GET', '/api/session/ses_focus/inbox', response({ data: [
      queueItem('msg_duplicate', 20), queueItem('msg_duplicate', 10)
    ] }));
    await assert.rejects(source(h, 'queue'));
  });

  await t.test('rejects inbox over bound instead of returning partial instances', async () => {
    const h = harness();
    addSession(h, 'ses_focus');
    const tooMany = Array.from({ length: 201 }, (_, index) => queueItem(`msg_item_${index}`, index));
    h.route('GET', '/api/session/ses_focus/inbox', response({ data: tooMany }));
    await assert.rejects(source(h, 'queue'));
  });
});
