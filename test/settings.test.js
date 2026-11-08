'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class FakeElement {
  constructor(id = '') {
    this.id = id; this.value = ''; this.textContent = ''; this.disabled = false; this.checked = false;
    this.hidden = false; this.open = false; this.children = []; this.attributes = {}; this.listeners = new Map();
    this.classList = { add() {}, toggle() {} };
  }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  dispatch(type, event = {}) {
    event.target = event.target || this;
    for (const handler of this.listeners.get(type) || []) handler(event);
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  add(item) { this.children.push(item); }
  reportValidity() { return true; }
}

function setup(initialState) {
  const html = fs.readFileSync(path.join(__dirname, '../src/config.html'), 'utf8');
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
  assert.equal(scripts.length, 1, 'settings page should have one inline runtime script');
  const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
  assert.ok(htmlIds.has('recentSessions'), 'settings HTML must declare recentSessions section');
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!htmlIds.has(id)) return null;
      if (!elements.has(id)) elements.set(id, new FakeElement(id));
      return elements.get(id);
    },
    createElement(tag) { return new FakeElement(tag); },
    querySelectorAll(selector) {
      assert.equal(selector, 'input[name="mode"]');
      return [document.getElementById('modeDefault'), document.getElementById('modeNew')];
    }
  };
  document.getElementById('modeDefault').value = 'default_chat';
  document.getElementById('modeNew').value = 'new_chat';
  const state = structuredClone(initialState);
  const calls = [];
  const readyCallbacks = [];
  const listRows = [{ session_id: 'ses_saved', title: 'Saved session', directory: '/repo', url: 'https://example/session' }];
  const pebble = {
    addEventListener(name, callback) { assert.equal(name, 'ready'); readyCallbacks.push(callback); },
    async sendMessage(target, message) {
      calls.push({ target, message: structuredClone(message) });
      if (target !== 'plugin') throw new Error(`Unexpected message target ${target}`);
      switch (message.type) {
        case 'status':
          return { connected: true, configured: state.mode === 'new_chat' ? Boolean(state.directory) : Boolean(state.selected), url: 'http://localhost:4096', username: 'opencode', version: '2.2.1', mode: state.mode, directory: state.directory, selected: state.selected, nicknames: { ...state.nicknames } };
        case 'mode':
          state.mode = message.mode;
          return { connected: true, configured: state.mode === 'new_chat' ? Boolean(state.directory) : Boolean(state.selected), url: 'http://localhost:4096', username: 'opencode', version: '2.2.1', mode: state.mode, directory: state.directory, selected: state.selected, nicknames: { ...state.nicknames } };
        case 'list':
          return { sessions: listRows.map(row => ({ ...row })), next_cursor: null };
        case 'select':
          state.selected = { session_id: message.session_id, title: listRows.find(row => row.session_id === message.session_id).title };
          return { connected: true, configured: true, url: 'http://localhost:4096', username: 'opencode', version: '2.2.1', mode: state.mode, directory: state.directory, selected: state.selected, nicknames: { ...state.nicknames } };
        case 'directory':
          state.directory = message.directory;
          return { connected: true, configured: state.mode === 'new_chat' ? Boolean(state.directory) : Boolean(state.selected), url: 'http://localhost:4096', username: 'opencode', version: '2.2.1', mode: state.mode, directory: state.directory, selected: state.selected, nicknames: { ...state.nicknames } };
        default:
          throw new Error(`Unexpected plugin message: ${message.type}`);
      }
    }
  };
  const context = vm.createContext({ document, Pebble: pebble, Option: class Option extends FakeElement {
    constructor(label, value) { super('option'); this.textContent = label; this.value = value; }
  }, console, Promise, Set, Map, String, Boolean, Error });
  vm.runInContext(scripts[0], context, { filename: 'config.html:inline-script' });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const fireReady = async target => { readyCallbacks[0]({ target }); await flush(); };
  const chooseMode = async mode => {
    const radio = document.getElementById(mode === 'new_chat' ? 'modeNew' : 'modeDefault');
    radio.checked = true;
    radio.dispatch('change');
    await flush();
  };
  const click = async id => { document.getElementById(id).dispatch('click'); await flush(); };
  return { document, state, calls, readyCallbacks, fireReady, chooseMode, click };
}

function initialNewModeState() {
  return { mode: 'new_chat', directory: '/saved/path', selected: null, nicknames: { ses_saved: 'Pinned' } };
}

test('ready plugin keeps recent-session panel hidden in new mode and avoids list fetch', async () => {
  const ui = setup(initialNewModeState());
  await ui.fireReady('other');
  assert.equal(ui.calls.length, 0, 'non-plugin ready target must not initialize settings');
  await ui.fireReady('plugin');
  assert.equal(ui.document.getElementById('recentSessions').hidden, true);
  assert.match(ui.document.getElementById('configuredText').textContent, /\/saved\/path/);
  assert.deepEqual(ui.calls.map(call => call.message.type), ['status']);
});

test('switching modes loads existing rows once, uses real default, and preserves it on return to new mode', async () => {
  const ui = setup(initialNewModeState());
  await ui.fireReady('plugin');
  await ui.chooseMode('default_chat');
  assert.equal(ui.document.getElementById('recentSessions').hidden, false);
  assert.equal(ui.calls.filter(call => call.message.type === 'list').length, 1);
  assert.equal(ui.calls.some(call => call.message.type === 'select'), false, 'loading list must not silently set default');
  await ui.click('useDefault');
  assert.deepEqual(ui.state.selected, { session_id: 'ses_saved', title: 'Saved session' });
  await ui.chooseMode('new_chat');
  assert.equal(ui.document.getElementById('recentSessions').hidden, true);
  await ui.chooseMode('default_chat');
  assert.equal(ui.document.getElementById('recentSessions').hidden, false);
  assert.deepEqual(ui.state.selected, { session_id: 'ses_saved', title: 'Saved session' });
  assert.equal(ui.state.nicknames.ses_saved, 'Pinned');
  assert.equal(ui.calls.filter(call => call.message.type === 'list').length, 1, 'cached real rows should prevent redundant retrieval');
  assert.equal(ui.calls.filter(call => call.message.type === 'select').length, 1);
});

test('new-mode banner uses saved directory until typed draft is saved', async () => {
  const ui = setup(initialNewModeState());
  await ui.fireReady('plugin');
  const directory = ui.document.getElementById('directory');
  directory.value = '/unsaved/draft';
  assert.match(ui.document.getElementById('configuredText').textContent, /\/saved\/path/);
  assert.doesNotMatch(ui.document.getElementById('configuredText').textContent, /unsaved/);
  await ui.click('saveDirectory');
  assert.match(ui.document.getElementById('configuredText').textContent, /\/unsaved\/draft/);
  assert.equal(ui.state.directory, '/unsaved/draft');
  assert.equal(ui.calls.filter(call => call.message.type === 'directory').length, 1);
  assert.equal(ui.calls.find(call => call.message.type === 'directory').message.directory, '/unsaved/draft');
  assert.equal(ui.document.getElementById('recentSessions').hidden, true);
  assert.equal(ui.calls.some(call => call.message.type === 'list'), false);
});
