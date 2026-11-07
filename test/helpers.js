'use strict';

const { createService } = require('../src/plugin/index.js');

class MemoryStorage {
  constructor(values = new Map()) { this.values = values; }
  async getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  async setItem(key, value) { this.values.set(key, value); }
  async removeItem(key) { this.values.delete(key); }
}

function response(value, status = 200) {
  return { status, async json() { return value; } };
}

function harness() {
  const storage = new MemoryStorage();
  const requests = [];
  const routes = [];
  const unexpected = [];
  const fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    const req = { url, path: parsed.pathname, search: parsed.searchParams, method: options.method || 'GET', headers: options.headers || {}, body: options.body === undefined ? undefined : JSON.parse(options.body) };
    requests.push(req);
    const index = routes.findIndex(route => route.method === req.method && route.match(req));
    if (index < 0) {
      const message = `Unexpected request: ${req.method} ${parsed.pathname}${parsed.search}`;
      unexpected.push(message);
      throw new Error(message);
    }
    const [route] = routes.splice(index, 1);
    return typeof route.result === 'function' ? route.result(req) : route.result;
  };
  const route = (method, match, result) => routes.push({ method, match: typeof match === 'string' ? req => req.path === match : match, result });
  let tick = 1700000000000;
  let rand = 0;
  const service = createService({ storage, fetch, now: () => tick, random: () => `r${++rand}` });
  return { service, storage, requests, routes, unexpected, route, setNow(value) { tick = value; } };
}

function session(id, title = 'Pebble', extra = {}) {
  return { id, title, location: { directory: '/workspace' }, time: { created: 1700000000, updated: 1700000001 }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, projectID: 'project-1', ...extra };
}
function page(rows, next = null, previous = null) { return { data: rows, cursor: { previous, next } }; }
function makeAck(id, msgId, text) { return { data: { id: msgId, sessionID: id, type: 'user', payload: { text }, delivery: 'queue', time: { created: 1700000000 } } }; }
function addConnect(h, result = response({ version: '2.2.1' }), params = {}) {
  h.route('GET', '/api/info', result);
  return h.service.config({ type: 'connect', url: 'http://localhost:4096', username: 'opencode', password: 'pässword', ...params });
}
async function connected(h) { const result = await addConnect(h); if (result && result.error) throw Error(result.error.message); return result; }
function addLiveSession(h, id, s = session(id)) { h.route('GET', `/api/session/${id}`, response({ data: s })); }
function addPrompt(h, id, title, text = 'hello') {
  addLiveSession(h, id, session(id, title));
  h.route('POST', `/api/session/${id}/prompt`, req => response(makeAck(id, req.body.id, text)));
}

module.exports = { MemoryStorage, response, harness, session, page, makeAck, addConnect, connected, addLiveSession, addPrompt };
