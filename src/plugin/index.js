(function (root) {
  'use strict';

  var STATE_KEY = 'opencode.plugin.state.v1';
  var DEFAULT_USERNAME = 'opencode';
  var DEFAULT_TITLE = 'New session';
  var PAGE_LIMIT = 50;
  var MAX_PAGES = 50;
  var DEFAULT_REPLY_COUNT = 10;
  var MAX_REPLY_COUNT = 20;
  var DELIVERY_MODES = ['queue', 'steer'];
  var DEFAULT_DELIVERY = 'queue';
  var MAX_ATTENTION_CHATS = 50;
  var requestCounter = 0;

  function makeError(code, message, httpStatus) {
    var err = new Error(message);
    err.code = code;
    if (httpStatus) err.httpStatus = httpStatus;
    return err;
  }

  function safeError(err) {
    var codes = ['INVALID_REQUEST', 'INVALID_ARGS', 'PERMISSION_DENIED', 'AUTH_REQUIRED', 'RATE_LIMITED', 'PLUGIN_UNAVAILABLE'];
    if (err && codes.indexOf(err.code) !== -1) return { code: err.code, message: err.message };
    return { code: 'PLUGIN_UNAVAILABLE', message: 'Request failed.' };
  }

  function utf8Bytes(value) {
    var encoded;
    try {
      encoded = encodeURIComponent(value).replace(/%([0-9A-F]{2})/g, function (_, hex) {
        return String.fromCharCode(parseInt(hex, 16));
      });
    } catch (_) {
      throw makeError('INVALID_ARGS', 'Text contains invalid Unicode.');
    }
    var bytes = [];
    for (var i = 0; i < encoded.length; i += 1) bytes.push(encoded.charCodeAt(i));
    return bytes;
  }

  function base64(value) {
    var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    var bytes = utf8Bytes(value);
    var out = '';
    for (var i = 0; i < bytes.length; i += 3) {
      var a = bytes[i];
      var hasB = i + 1 < bytes.length;
      var hasC = i + 2 < bytes.length;
      var b = hasB ? bytes[i + 1] : 0;
      var c = hasC ? bytes[i + 2] : 0;
      out += alphabet.charAt(a >> 2) + alphabet.charAt(((a & 3) << 4) | (b >> 4));
      out += hasB ? alphabet.charAt(((b & 15) << 2) | (c >> 6)) : '=';
      out += hasC ? alphabet.charAt(c & 63) : '=';
    }
    return out;
  }

  function base64url(value) {
    return base64(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function cleanURL(value) {
    if (typeof value !== 'string') throw makeError('INVALID_ARGS', 'Enter a valid server URL.');
    var url = value.trim();
    if (!url || /[\u0000-\u0020\u007f\\]/.test(url) || /[?#]/.test(url)) {
      throw makeError('INVALID_ARGS', 'Enter a valid server URL.');
    }
    var match = /^(https?):\/\/([^/]+)(\/.*)?$/i.exec(url);
    if (!match || match[2].indexOf('@') !== -1 || /%/.test(match[2])) {
      throw makeError('INVALID_ARGS', 'Server URL must use HTTP or HTTPS without credentials.');
    }
    var authority = match[2];
    var authorityMatch = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?$/i.exec(authority);
    if (!authorityMatch) throw makeError('INVALID_ARGS', 'Enter a valid server URL.');
    if (authorityMatch[2] && (+authorityMatch[2] < 1 || +authorityMatch[2] > 65535)) {
      throw makeError('INVALID_ARGS', 'Enter a valid server URL.');
    }
    var host = authorityMatch[1];
    if (host.charAt(0) !== '[') {
      if (host.length > 253 || host.charAt(0) === '.' || host.charAt(host.length - 1) === '.') {
        throw makeError('INVALID_ARGS', 'Enter a valid server URL.');
      }
      var labels = host.split('.');
      for (var i = 0; i < labels.length; i += 1) {
        if (!labels[i] || labels[i].length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(labels[i])) {
          throw makeError('INVALID_ARGS', 'Enter a valid server URL.');
        }
      }
    }
    var path = match[3] || '';
    var decodedPath;
    try { decodedPath = decodeURIComponent(path); } catch (_) { throw makeError('INVALID_ARGS', 'Server URL path is invalid.'); }
    if (/[\\\u0000-\u001f\u007f]/.test(decodedPath) || /(^|\/)\.\.?($|\/)/.test(decodedPath)) {
      throw makeError('INVALID_ARGS', 'Server URL path is invalid.');
    }
    return url.replace(/\/+$/, '');
  }

  // OpenCode V2 server route uses normalized server URL as the server key.
  function sessionURL(server, id) {
    return server + '/server/' + base64url(server) + '/session/' + encodeURIComponent(id);
  }

  function emptyState() {
    return {
      url: '', username: DEFAULT_USERNAME, password: '', version: '', mode: 'default_chat',
      directory: '', selected: null, lastSessionID: null, nicknames: {}, reply_count: DEFAULT_REPLY_COUNT,
      default_delivery: DEFAULT_DELIVERY, auth_method: '', last_seen: {}
    };
  }

  function validDelivery(value) {
    return DELIVERY_MODES.indexOf(value) !== -1;
  }

  function createService(options) {
    options = options || {};
    var storage = options.storage;
    var fetcher = options.fetch;
    var now = options.now || Date.now;
    var random = options.random;
    if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function' ||
        typeof storage.removeItem !== 'function' || typeof fetcher !== 'function') {
      throw new TypeError('storage and fetch are required');
    }

    async function load() {
      var raw;
      try { raw = await storage.getItem(STATE_KEY); } catch (_) { throw makeError('PLUGIN_UNAVAILABLE', 'Secure storage is unavailable.'); }
      if (!raw) return emptyState();
      try {
        var stored = typeof raw === 'string' ? JSON.parse(raw) : raw;
        var state = emptyState();
        Object.keys(state).forEach(function (key) {
          if (stored && stored[key] !== undefined) state[key] = stored[key];
        });
        if (!state.nicknames || typeof state.nicknames !== 'object' || Array.isArray(state.nicknames)) state.nicknames = {};
        if (!state.last_seen || typeof state.last_seen !== 'object' || Array.isArray(state.last_seen)) state.last_seen = {};
        if (!Number.isInteger(state.reply_count) || state.reply_count < 1 || state.reply_count > MAX_REPLY_COUNT) {
          state.reply_count = DEFAULT_REPLY_COUNT;
        }
        if (!validDelivery(state.default_delivery)) state.default_delivery = DEFAULT_DELIVERY;
        if (!state.password) state.auth_method = '';
        else if (state.auth_method !== 'pair') state.auth_method = 'password';
        return state;
      } catch (_) { return emptyState(); }
    }

    async function save(state) {
      try { await storage.setItem(STATE_KEY, JSON.stringify(state)); }
      catch (_) { throw makeError('PLUGIN_UNAVAILABLE', 'Secure storage is unavailable.'); }
    }

    function refresh() {
      if (root.Pebble && typeof root.Pebble.refreshSources === 'function') {
        try { root.Pebble.refreshSources(['agent/chats', 'agent/configured', 'opencode/active_session', 'opencode/activity', 'opencode/reply', 'opencode/replies', 'opencode/chat_status', 'opencode/permission', 'opencode/question', 'opencode/job']); } catch (_) {}
      }
    }

    function configured(state) {
      return !!(state.url && state.username && state.password && /^2\./.test(state.version) &&
        ((state.mode === 'default_chat' && state.selected) || (state.mode === 'new_chat' && state.directory)));
    }

    function status(state) {
      return {
        connected: !!(state.url && state.password && state.version),
        configured: configured(state), url: state.url || '', username: state.username || DEFAULT_USERNAME,
        version: state.version || '', mode: state.mode || 'default_chat', directory: state.directory || '',
        selected: state.selected || null, nicknames: state.nicknames || {},
        reply_count: state.reply_count, default_delivery: state.default_delivery || DEFAULT_DELIVERY,
        auth_method: state.auth_method || ''
      };
    }

    function requireConnection(state) {
      if (!state.url || !state.username || !state.password || !/^2\./.test(state.version)) {
        throw makeError('AUTH_REQUIRED', 'Connect to an OpenCode V2 server first.');
      }
    }

    async function request(state, path, method, body, expectedStatus) {
      if (!state.url || !state.username || !state.password) {
        throw makeError('AUTH_REQUIRED', 'Connect to an OpenCode V2 server first.');
      }
      var response;
      var init = { method: method || 'GET', headers: { Accept: 'application/json' }, redirect: 'error' };
      init.headers.Authorization = 'Basic ' + base64(state.username + ':' + state.password);
      if (body !== undefined) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      try { response = await fetcher(state.url + path, init); }
      catch (fetchError) {
        if (fetchError && fetchError.name === 'NotAllowedError') throw makeError('PERMISSION_DENIED', 'OpenCode access is not permitted.');
        throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode request failed.');
      }
      if (!response || typeof response.status !== 'number') throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned an invalid response.');
      if (response.status < 200 || response.status >= 300) {
        var code = response.status === 401 ? 'AUTH_REQUIRED' : response.status === 403 ? 'PERMISSION_DENIED' :
          response.status === 429 ? 'RATE_LIMITED' : 'PLUGIN_UNAVAILABLE';
        var message = response.status === 409 ? 'OpenCode reported a conflict; request was not retried.' :
          (response.status >= 500 ? 'OpenCode is unavailable.' : 'OpenCode request was rejected.');
        throw makeError(code, message, response.status);
      }
      if (expectedStatus !== undefined && response.status !== expectedStatus) {
        throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned an unexpected success status.');
      }
      if (response.status === 204) return null;
      try { return await response.json(); }
      catch (_) { throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid JSON.'); }
    }

    function api(state, path, method, body, expectedStatus) { return request(state, '/api' + path, method, body, expectedStatus); }

    async function redeemPairingLink(value) {
      var link;
      try { link = cleanURL(value); }
      catch (_) { throw makeError('INVALID_ARGS', 'Enter an OpenCode pairing link.'); }
      var match = /^(https?:\/\/[^/]+)\/auth\/connect\/[^/]+$/.exec(link);
      if (!match) throw makeError('INVALID_ARGS', 'Enter an OpenCode pairing link.');
      var response;
      try {
        response = await fetcher(link, {
          method: 'GET', headers: { Accept: 'application/json' }, redirect: 'error'
        });
      } catch (fetchError) {
        if (fetchError && fetchError.name === 'NotAllowedError') throw makeError('PERMISSION_DENIED', 'OpenCode access is not permitted.');
        throw makeError('PLUGIN_UNAVAILABLE', 'Pairing request failed.');
      }
      if (!response || typeof response.status !== 'number') throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned an invalid pairing response.');
      if (response.status === 400 || response.status === 401 || response.status === 404 || response.status === 410) {
        throw makeError('INVALID_ARGS', 'Pairing link is invalid or expired. Run opencode pair again.');
      }
      if (response.status === 403) throw makeError('PERMISSION_DENIED', 'OpenCode access is not permitted.');
      if (response.status === 429) throw makeError('RATE_LIMITED', 'OpenCode rate limit reached.');
      if (response.status < 200 || response.status >= 300) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode pairing request was rejected.');
      var body;
      try { body = await response.json(); }
      catch (_) { throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned an invalid pairing response.'); }
      if (!body || typeof body.token !== 'string' || !body.token || body.token.length > 4096) {
        throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned an invalid pairing response.');
      }
      return { origin: match[1], token: body.token };
    }

    function sessionID(id) { return typeof id === 'string' && /^ses[A-Za-z0-9_-]{1,160}$/.test(id); }
    function sessionPath(id) { return '/session/' + encodeURIComponent(id); }
    function titleOf(session) { return typeof session.title === 'string' && session.title ? session.title : 'Untitled session'; }
    function archived(session) { return !!(session.time && session.time.archived); }

    function validSession(session) {
      if (!session || typeof session !== 'object' || !sessionID(session.id) ||
          (session.title !== undefined && typeof session.title !== 'string') ||
          !session.location || typeof session.location.directory !== 'string' ||
          !session.time || typeof session.time !== 'object') {
        throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid session data.');
      }
      return session;
    }

    async function getSession(state, id) {
      var response = await api(state, sessionPath(id));
      var session = response && response.data;
      session = validSession(session);
      if (session.id !== id) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned a different session.');
      return session;
    }

    function validateCursor(cursor) {
      if (cursor === undefined || cursor === null) return null;
      if (typeof cursor !== 'string' || cursor.length > 4096) throw makeError('INVALID_ARGS', 'Invalid session cursor.');
      return cursor;
    }

    async function sessionsPage(state, cursor) {
      var params = 'limit=' + PAGE_LIMIT + '&parentID=null&archived=false';
      if (cursor !== null) params += '&cursor=' + encodeURIComponent(cursor);
      else params += '&order=desc';
      var response = await api(state, '/session?' + params);
      if (!response || !Array.isArray(response.data) || !response.cursor || typeof response.cursor !== 'object' ||
          (response.cursor.next !== undefined && response.cursor.next !== null && typeof response.cursor.next !== 'string')) {
        throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid session data.');
      }
      if (response.cursor.next === undefined) response.cursor.next = null;
      return response;
    }

    function isRootUnarchived(session) {
      return !archived(session) && !(session.parentID || session.parentId || session.parent_id);
    }

    function validateListSession(session) {
      validSession(session);
      if (!isRootUnarchived(session)) return false;
      return true;
    }

    async function allSessions(state) {
      var all = [];
      var ids = Object.create(null);
      var seenCursors = Object.create(null);
      var cursor = null;
      for (var page = 0; page < MAX_PAGES; page += 1) {
        var response = await sessionsPage(state, cursor);
        response.data.forEach(function (item) {
          if (!validateListSession(item)) return;
          if (!ids[item.id]) { ids[item.id] = true; all.push(item); }
        });
        var next = response.cursor.next;
        if (next === null || next === '') return all;
        if (typeof next !== 'string' || next.length > 4096 || seenCursors[next]) {
          throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid pagination data.');
        }
        if (page === MAX_PAGES - 1) throw makeError('PLUGIN_UNAVAILABLE', 'Too many sessions to resolve chat safely.');
        seenCursors[next] = true;
        cursor = next;
      }
      return all;
    }

    async function chatRows(state, cursor) {
      cursor = validateCursor(cursor);
      var page = await sessionsPage(state, cursor);
      var sessions = [];
      page.data.forEach(function (item) {
        if (!validateListSession(item)) return;
        sessions.push({
          session_id: item.id,
          title: titleOf(item),
          nickname: state.nicknames[item.id] || '',
          updated_at: Number(item.time.updated || item.time.created) || 0,
          directory: item.location.directory,
          url: sessionURL(state.url, item.id),
          isDefault: !!(state.selected && state.selected.session_id === item.id)
        });
      });
      return { sessions: sessions, next_cursor: page.cursor.next };
    }

    function isPlainObject(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      var prototype = Object.getPrototypeOf(value);
      return prototype === Object.prototype || prototype === null;
    }

    function unicodePrefix(value, limit) {
      var result = '';
      var count = 0;
      for (var i = 0; i < value.length && count < limit; count += 1) {
        var first = value.charCodeAt(i);
        if (first >= 0xd800 && first <= 0xdbff && i + 1 < value.length) {
          var second = value.charCodeAt(i + 1);
          if (second >= 0xdc00 && second <= 0xdfff) {
            result += value.slice(i, i + 2);
            i += 2;
            continue;
          }
        }
        result += value.charAt(i);
        i += 1;
      }
      return result;
    }

    function createLimiter(maxConcurrent) {
      var running = 0;
      var waiting = [];
      var stopped = false;
      var failure = null;

      function stop(reason) {
        if (stopped) return;
        stopped = true;
        failure = reason || makeError('PLUGIN_UNAVAILABLE', 'OpenCode scan failed.');
        while (waiting.length) waiting.shift().reject(failure);
      }

      function release() {
        running -= 1;
        if (!stopped && waiting.length) schedule(waiting.shift());
      }

      function schedule(entry) {
        if (stopped) {
          entry.reject(failure);
          return;
        }
        running += 1;
        Promise.resolve().then(entry.task).then(function (value) {
          entry.resolve(value);
          release();
        }, function (err) {
          stop(err);
          entry.reject(err);
          release();
        });
      }

      function limited(task) {
        return new Promise(function (resolve, reject) {
          var entry = { task: task, resolve: resolve, reject: reject };
          if (stopped) reject(failure);
          else if (running < maxConcurrent) schedule(entry);
          else waiting.push(entry);
        });
      }
      limited.stop = stop;
      return limited;
    }

    async function activeSnapshot(state, onValidated) {
      requireConnection(state);
      var response = await api(state, '/session/active');
      var activeMap = response && response.data;
      if (!isPlainObject(activeMap)) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid active session data.');
      var activeIDs = Object.keys(activeMap);
      if (activeIDs.length > 100) throw makeError('PLUGIN_UNAVAILABLE', 'Too many active sessions to inspect safely.');
      activeIDs.forEach(function (id) {
        if (!sessionID(id) || !isPlainObject(activeMap[id]) || activeMap[id].type !== 'running') {
          throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid active session data.');
        }
      });
      if (onValidated) onValidated();
      if (activeIDs.length === 0) return { sessions: [], attention: [], roots: [], attentionRoots: [] };

      var limitRequest = createLimiter(4);
      var metadata = Object.create(null);
      var metadataCount = 0;
      function fetchMetadata(id) {
        if (metadata[id]) return metadata[id];
        metadataCount += 1;
        if (metadataCount > 200) throw makeError('PLUGIN_UNAVAILABLE', 'Too many sessions to inspect safely.');
        metadata[id] = limitRequest(function () { return getSession(state, id); });
        return metadata[id];
      }
      function parentOf(session) {
        if (session.parentID === undefined || session.parentID === null) return null;
        if (!sessionID(session.parentID)) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid parent session data.');
        return session.parentID;
      }
      async function ancestry(session) {
        var reverse = [session.id];
        var seen = Object.create(null);
        seen[session.id] = true;
        var current = session;
        var hops = 0;
        var parentID = parentOf(current);
        while (parentID !== null) {
          hops += 1;
          if (hops > 32 || seen[parentID]) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid parent session data.');
          seen[parentID] = true;
          var parent = await fetchMetadata(parentID);
          if (parent.id !== parentID) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned mismatched parent session data.');
          reverse.push(parent.id);
          current = parent;
          parentID = parentOf(current);
        }
        reverse.reverse();
        return reverse;
      }
      async function attentionFor(id) {
        var responses = await Promise.all([
          limitRequest(function () { return api(state, sessionPath(id) + '/permission'); }),
          limitRequest(function () { return api(state, sessionPath(id) + '/form'); })
        ]);
        var permissions = responses[0] && responses[0].data;
        var forms = responses[1] && responses[1].data;
        function validRequests(items) {
          if (!Array.isArray(items)) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid attention data.');
          items.forEach(function (item) {
            if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.id !== 'string' || item.sessionID !== id) {
              throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid attention data.');
            }
          });
          return items.length > 0;
        }
        var hasPermissions = validRequests(permissions);
        var hasForms = validRequests(forms);
        if (hasPermissions) return 'permission';
        return hasForms ? 'form' : null;
      }

      var details;
      try {
        details = await Promise.all(activeIDs.map(async function (id) {
          var session = await fetchMetadata(id);
          if (session.id !== id) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned mismatched active session data.');
          var parentID = parentOf(session);
          var [path, attention] = await Promise.all([ancestry(session), attentionFor(id)]);
          return { session: session, parentID: parentID, path: path, attention: attention };
        }));
      } catch (scanError) {
        limitRequest.stop(scanError);
        throw scanError;
      }
      details.sort(function (a, b) {
        var length = Math.min(a.path.length, b.path.length);
        for (var i = 0; i < length; i += 1) {
          if (a.path[i] < b.path[i]) return -1;
          if (a.path[i] > b.path[i]) return 1;
        }
        return a.path.length - b.path.length;
      });
      var rootIDs = Object.create(null);
      var attentionRoots = Object.create(null);
      details.forEach(function (detail) {
        var rootID = detail.path[0];
        rootIDs[rootID] = true;
        if (detail.attention) attentionRoots[rootID] = true;
      });
      return {
        sessions: details,
        attention: details.map(function (detail) { return detail.attention; }),
        roots: Object.keys(rootIDs),
        attentionRoots: Object.keys(attentionRoots)
      };
    }

    function activeInstance(state, detail) {
      var session = detail.session;
      var attention = detail.attention;
      var statusText = attention === 'permission' ? 'Approve' : attention === 'form' ? 'Input' : 'Running';
      var statusLong = attention === 'permission' ? 'Waiting for approval' : attention === 'form' ? 'Waiting for input' : 'Running';
      var name = state.nicknames[session.id] || titleOf(session);
      var properties = {
        name: { shortText: { text: unicodePrefix(name, 7) }, longText: { text: name } },
        title: { longText: { text: titleOf(session) } },
        status: { shortText: { text: statusText }, longText: { text: statusLong } },
        directory: { longText: { text: session.location.directory } },
        url: { longText: { text: sessionURL(state.url, session.id) } },
        is_subagent: { boolean: { value: Boolean(detail.parentID) } }
      };
      if (typeof session.agent === 'string') properties.agent = { longText: { text: session.agent } };
      if (session.model && typeof session.model.providerID === 'string' && session.model.providerID &&
          typeof session.model.id === 'string' && session.model.id) {
        properties.model = { longText: { text: session.model.providerID + '/' + session.model.id } };
      }
      var updated = session.time && session.time.updated;
      if (typeof updated === 'number' && Number.isFinite(updated) && updated >= 0) {
        properties.updated = { timestamp: { value: Math.floor(updated / 1000) } };
      }
      return { instanceId: session.id, properties: properties };
    }

    function nonemptyID(value, max) {
      return typeof value === 'string' && value.length > 0 && value.length <= (max || 200) && !/[\u0000-\u001f\u007f]/.test(value);
    }

    async function latestAssistantReply(state, id) {
      var response = await api(state, sessionPath(id) + '/message?type=assistant&order=desc&limit=20');
      if (!response || !Array.isArray(response.data) || response.data.length > 20 || !response.cursor || typeof response.cursor !== 'object') {
        throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid assistant messages.');
      }
      var chosen = null;
      var chosenText = '';
      response.data.forEach(function (message) {
        if (!message || message.type !== 'assistant' || !nonemptyID(message.id, 200) ||
            (message.sessionID !== undefined && message.sessionID !== id) || !message.time || typeof message.time !== 'object' ||
            typeof message.time.created !== 'number' || !Number.isFinite(message.time.created) || message.time.created < 0 ||
            (message.time.completed !== undefined && (typeof message.time.completed !== 'number' || !Number.isFinite(message.time.completed) || message.time.completed < 0)) ||
            !Array.isArray(message.content)) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid assistant messages.');
        var text = '';
        message.content.forEach(function (part) {
          if (!isPlainObject(part) || ['text', 'reasoning', 'tool'].indexOf(part.type) === -1) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid assistant messages.');
          if (part.type === 'text') {
            if (typeof part.text !== 'string') throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid assistant messages.');
            text += part.text;
          }
        });
        if (!chosen && text) { chosen = message; chosenText = text; }
      });
      if (!chosen) return null;
      return { message: chosen, text: chosenText };
    }

    function replyStatus(message) {
      var failed = !!message.error || message.finish === 'error';
      var complete = typeof message.time.completed === 'number';
      return failed ? 'Error' : complete ? 'Done' : 'Writing';
    }

    function replyInstances(state, id) {
      return getSession(state, id).then(async function (session) {
        var reply = await latestAssistantReply(state, id);
        if (!reply) return [];
        var chosen = reply.message;
        var title = state.nicknames[id] || (state.selected && state.selected.session_id === id && state.selected.title) || titleOf(session);
        var complete = typeof chosen.time.completed === 'number';
        var updated = complete ? chosen.time.completed : chosen.time.created;
        return [{ instanceId: id, properties: {
          name: { shortText: { text: unicodePrefix(title, 7) }, longText: { text: title } },
          session_id: { longText: { text: id } }, message_id: { longText: { text: chosen.id } },
          text: { shortText: { text: unicodePrefix(reply.text, 7) }, longText: { text: unicodePrefix(reply.text, 4096) } },
          updated: { timestamp: { value: Math.floor(updated / 1000) } },
          complete: { boolean: { value: complete } },
          status: { shortText: { text: replyStatus(chosen) }, longText: { text: replyStatus(chosen) } },
          url: { longText: { text: sessionURL(state.url, id) } }
        }}];
      });
    }

    function repliesInstance(state, meta, reply, defaultID) {
      var name = meta.nickname || meta.title;
      var properties = {
        name: { shortText: { text: unicodePrefix(name, 7) }, longText: { text: name } },
        title: { longText: { text: meta.title } },
        session_id: { longText: { text: meta.session_id } },
        is_default: { boolean: { value: meta.session_id === defaultID } },
        url: { longText: { text: meta.url } }
      };
      if (reply) {
        var complete = typeof reply.message.time.completed === 'number';
        var updated = complete ? reply.message.time.completed : reply.message.time.created;
        var statusText = replyStatus(reply.message);
        properties.message_id = { longText: { text: reply.message.id } };
        properties.text = { shortText: { text: unicodePrefix(reply.text, 7) }, longText: { text: unicodePrefix(reply.text, 4096) } };
        properties.updated = { timestamp: { value: Math.floor(updated / 1000) } };
        properties.complete = { boolean: { value: complete } };
        properties.status = { shortText: { text: statusText }, longText: { text: statusText } };
      } else {
        properties.status = { shortText: { text: 'Idle' }, longText: { text: 'No reply' } };
      }
      return { instanceId: meta.session_id, properties: properties };
    }

    async function repliesInstances(state) {
      var page = await chatRows(state, null);
      var recent = page.sessions;
      var byID = Object.create(null);
      recent.forEach(function (row) {
        if (!byID[row.session_id]) byID[row.session_id] = row;
      });
      var defaultID = state.mode === 'default_chat' && state.selected && sessionID(state.selected.session_id) ? state.selected.session_id : null;
      var lastID = sessionID(state.lastSessionID) ? state.lastSessionID : null;
      var ordered = [];
      var seenIDs = Object.create(null);
      function addFocus(id) {
        if (!id || seenIDs[id]) return;
        seenIDs[id] = true;
        ordered.push(byID[id] ? { meta: byID[id] } : { id: id });
      }
      addFocus(defaultID);
      addFocus(lastID);
      recent.forEach(function (row) {
        if (seenIDs[row.session_id]) return;
        seenIDs[row.session_id] = true;
        ordered.push({ meta: row });
      });
      ordered = ordered.slice(0, state.reply_count);

      var limit = createLimiter(4);
      var instances;
      try {
        instances = await Promise.all(ordered.map(function (entry) {
          return limit(async function () {
            var meta = entry.meta;
            if (!meta) {
              var session = await getSession(state, entry.id);
              meta = {
                session_id: session.id,
                title: titleOf(session),
                nickname: state.nicknames[session.id] || '',
                url: sessionURL(state.url, session.id)
              };
            }
            var reply = await latestAssistantReply(state, meta.session_id);
            return repliesInstance(state, meta, reply, defaultID);
          });
        }));
      } catch (err) {
        limit.stop(err);
        throw err;
      }
      return { validUntilMs: now() + 60000, instances: instances };
    }

    function validPermissionRequest(item) {
      if (!isPlainObject(item) || !nonemptyID(item.id) || !sessionID(item.sessionID) ||
          typeof item.action !== 'string' || !item.action || !Array.isArray(item.resources) ||
          item.resources.some(function (resource) { return typeof resource !== 'string'; }) ||
          (item.message !== undefined && typeof item.message !== 'string')) {
        throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid permission data.');
      }
      return item;
    }

    async function pendingPermissions(state) {
      var response = await api(state, '/permission/request');
      if (!response || !Array.isArray(response.data)) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid permission data.');
      return response.data.map(validPermissionRequest);
    }

    function validFormSummary(item) {
      if (!isPlainObject(item) || !nonemptyID(item.id) || !sessionID(item.sessionID) ||
          typeof item.title !== 'string' || !Array.isArray(item.fields)) {
        throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid question data.');
      }
      return item;
    }

    async function pendingForms(state) {
      var response = await api(state, '/form');
      if (!response || !Array.isArray(response.data)) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid question data.');
      return response.data.map(validFormSummary);
    }

    function metaFromRow(row) {
      return {
        session_id: row.session_id, title: row.title, nickname: row.nickname || '',
        updated: row.updated_at || 0, is_subagent: false
      };
    }

    function metaFromSession(state, session) {
      return {
        session_id: session.id, title: titleOf(session), nickname: state.nicknames[session.id] || '',
        updated: Number(session.time.updated || session.time.created) || 0,
        is_subagent: Boolean(session.parentID)
      };
    }

    async function sessionMetas(state, ids, recentMap) {
      var metas = Object.create(null);
      ids.forEach(function (id) {
        if (recentMap[id]) metas[id] = metaFromRow(recentMap[id]);
      });
      var missing = ids.filter(function (id) { return !metas[id]; });
      var limit = createLimiter(4);
      try {
        await Promise.all(missing.map(async function (id) {
          var session = await limit(function () { return getSession(state, id); });
          metas[id] = metaFromSession(state, session);
        }));
      } catch (err) {
        limit.stop(err);
        throw err;
      }
      return metas;
    }

    function chatStatusInstance(state, meta, reply, permissionCount, questionCount, defaultID) {
      var name = meta.nickname || meta.title;
      var unread = !!(reply && state.last_seen[meta.session_id] !== reply.message.id);
      var reason = permissionCount > 0 ? 'permission' : questionCount > 0 ? 'question' : unread ? 'unread' : 'none';
      var shortReason = reason === 'permission' ? 'Perm' : reason === 'question' ? 'Ask' : reason === 'unread' ? 'Unread' : 'None';
      var longReason = reason === 'permission' ? 'Permission' : reason === 'question' ? 'Question' : reason === 'unread' ? 'Unread' : 'None';
      var properties = {
        name: { shortText: { text: unicodePrefix(name, 7) }, longText: { text: name } },
        title: { longText: { text: meta.title } },
        session_id: { longText: { text: meta.session_id } },
        needs_action: { boolean: { value: reason !== 'none' } },
        reason: { shortText: { text: shortReason }, longText: { text: longReason } },
        permission_count: { numericValue: { value: permissionCount, min: 0 }, shortText: { text: String(permissionCount) } },
        question_count: { numericValue: { value: questionCount, min: 0 }, shortText: { text: String(questionCount) } },
        unread: { boolean: { value: unread } },
        is_default: { boolean: { value: meta.session_id === defaultID } },
        is_subagent: { boolean: { value: meta.is_subagent } },
        url: { longText: { text: sessionURL(state.url, meta.session_id) } }
      };
      if (reply) properties.message_id = { longText: { text: reply.message.id } };
      var updated = reply ? (typeof reply.message.time.completed === 'number' ? reply.message.time.completed : reply.message.time.created) : meta.updated;
      if (typeof updated === 'number' && Number.isFinite(updated) && updated >= 0) {
        properties.updated = { timestamp: { value: Math.floor(updated / 1000) } };
      }
      return { instanceId: meta.session_id, properties: properties };
    }

    async function chatStatusInstances(state) {
      var loaded = await Promise.all([chatRows(state, null), pendingPermissions(state), pendingForms(state)]);
      var recent = loaded[0].sessions;
      var permissions = loaded[1];
      var forms = loaded[2];
      var recentMap = Object.create(null);
      recent.forEach(function (row) { if (!recentMap[row.session_id]) recentMap[row.session_id] = row; });
      var permissionCounts = Object.create(null);
      var questionCounts = Object.create(null);
      permissions.forEach(function (item) { permissionCounts[item.sessionID] = (permissionCounts[item.sessionID] || 0) + 1; });
      forms.forEach(function (item) { questionCounts[item.sessionID] = (questionCounts[item.sessionID] || 0) + 1; });
      var defaultID = state.mode === 'default_chat' && state.selected && sessionID(state.selected.session_id) ? state.selected.session_id : null;
      var lastID = sessionID(state.lastSessionID) ? state.lastSessionID : null;
      var ids = [];
      var seen = Object.create(null);
      function add(id) {
        if (!id || seen[id]) return;
        seen[id] = true;
        ids.push(id);
      }
      add(defaultID);
      add(lastID);
      recent.slice(0, state.reply_count).forEach(function (row) { add(row.session_id); });
      permissions.forEach(function (item) { add(item.sessionID); });
      forms.forEach(function (item) { add(item.sessionID); });
      if (ids.length > MAX_ATTENTION_CHATS) throw makeError('PLUGIN_UNAVAILABLE', 'Too many chats to inspect safely.');
      var metas = await sessionMetas(state, ids, recentMap);
      var limit = createLimiter(4);
      var instances;
      try {
        instances = await Promise.all(ids.map(function (id) {
          return limit(async function () {
            var reply = await latestAssistantReply(state, id);
            return chatStatusInstance(state, metas[id], reply, permissionCounts[id] || 0, questionCounts[id] || 0, defaultID);
          });
        }));
      } catch (err) {
        limit.stop(err);
        throw err;
      }
      return { validUntilMs: now() + 20000, instances: instances };
    }

    async function permissionInstances(state) {
      var permissions = await pendingPermissions(state);
      if (!permissions.length) return { validUntilMs: now() + 20000, instances: [] };
      if (permissions.length > MAX_ATTENTION_CHATS) throw makeError('PLUGIN_UNAVAILABLE', 'Too many permission requests to inspect safely.');
      var recent = await chatRows(state, null);
      var recentMap = Object.create(null);
      recent.sessions.forEach(function (row) { if (!recentMap[row.session_id]) recentMap[row.session_id] = row; });
      var ids = [];
      permissions.forEach(function (item) { if (ids.indexOf(item.sessionID) === -1) ids.push(item.sessionID); });
      var metas = await sessionMetas(state, ids, recentMap);
      permissions.sort(function (a, b) {
        return a.sessionID < b.sessionID ? -1 : a.sessionID > b.sessionID ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
      return { validUntilMs: now() + 20000, instances: permissions.map(function (item) {
        var meta = metas[item.sessionID];
        var name = meta.nickname || meta.title;
        var properties = {
          name: { shortText: { text: unicodePrefix(name, 7) }, longText: { text: name } },
          title: { longText: { text: meta.title } },
          session_id: { longText: { text: item.sessionID } },
          request_id: { longText: { text: item.id } },
          action: { shortText: { text: unicodePrefix(item.action, 7) }, longText: { text: item.action } },
          url: { longText: { text: sessionURL(state.url, item.sessionID) } }
        };
        var resources = JSON.stringify(item.resources);
        if (resources.length > 16000) throw makeError('PLUGIN_UNAVAILABLE', 'Permission resources exceed safe display size.');
        properties.resources = { longText: { text: resources } };
        if (typeof item.message === 'string' && item.message) properties.message = { longText: { text: item.message } };
        return { instanceId: item.sessionID + ':' + item.id, properties: properties };
      }) };
    }

    async function jobInstances(state) {
      var response;
      try { response = await api(state, '/experimental/job'); }
      catch (err) {
        if (err && (err.httpStatus === 404 || err.httpStatus === 405)) throw makeError('PLUGIN_UNAVAILABLE', 'Background jobs are not supported by this OpenCode server.');
        throw err;
      }
      if (!response || !Array.isArray(response.data) || response.data.length > 200) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid background jobs.');
      var seen = Object.create(null);
      var jobs = response.data.map(function (job) {
        if (!job || ['shell', 'subagent', 'image'].indexOf(job.kind) === -1 || !nonemptyID(job.id, 200) ||
            !sessionID(job.sessionID) || ['running', 'completed', 'error', 'cancelled'].indexOf(job.status) === -1 ||
            !job.time || typeof job.time.started !== 'number' || !Number.isFinite(job.time.started) || job.time.started < 0 ||
            (job.title !== undefined && typeof job.title !== 'string') ||
            (job.kind === 'subagent' && job.childSessionID !== undefined && !sessionID(job.childSessionID))) {
          throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid background jobs.');
        }
        var key = job.kind + ':' + job.id;
        if (seen[key]) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned duplicate background jobs.');
        seen[key] = true;
        return job;
      });
      jobs.sort(function (a, b) { return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
      return jobs.map(function (job) {
        var title = typeof job.title === 'string' && job.title ? job.title : job.kind + ' job';
        var props = {
          name: { shortText: { text: unicodePrefix(title, 7) }, longText: { text: title } },
          job_id: { longText: { text: job.id } }, session_id: { longText: { text: job.sessionID } },
          kind: { shortText: { text: unicodePrefix(job.kind, 7) } }, status: { shortText: { text: unicodePrefix(job.status, 7) }, longText: { text: job.status } },
          started: { timestamp: { value: Math.floor(job.time.started / 1000) } },
          url: { longText: { text: sessionURL(state.url, job.sessionID) } }
        };
        if (job.kind === 'subagent' && sessionID(job.childSessionID)) props.child_session_id = { longText: { text: job.childSessionID } };
        return { instanceId: job.kind + ':' + job.id, properties: props };
      });
    }

    function validForm(form, id) {
      if (!isPlainObject(form) || !nonemptyID(form.id) || form.sessionID !== id || typeof form.title !== 'string' ||
          !Array.isArray(form.fields) || form.fields.length < 1 || form.fields.length > 50) {
        throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid question data.');
      }
      var keys = Object.create(null);
      var external = false;
      var hiddenRequired = false;
      function invalidFields() { throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid question fields.'); }
      function integerBound(value) { return Number.isInteger(value) && value >= 0; }
      function numericBound(value) {
        return typeof value === 'number' && Number.isFinite(value) || value === 'Infinity' || value === '-Infinity';
      }
      function numericValue(value) {
        return typeof value === 'number' && Number.isFinite(value) || value === 'Infinity' || value === '-Infinity';
      }
      function boundNumber(value) { return value === 'Infinity' ? Infinity : value === '-Infinity' ? -Infinity : value; }
      form.fields.forEach(function (field) {
        if (!isPlainObject(field) || !nonemptyID(field.key) || ['__proto__', 'prototype', 'constructor'].indexOf(field.key) !== -1 || keys[field.key] ||
            ['string', 'number', 'integer', 'boolean', 'multiselect', 'external'].indexOf(field.type) === -1 ||
            (field.required !== undefined && typeof field.required !== 'boolean') || (field.hidden !== undefined && typeof field.hidden !== 'boolean') ||
            (field.custom !== undefined && typeof field.custom !== 'boolean') ||
            (field.title !== undefined && typeof field.title !== 'string') || (field.description !== undefined && typeof field.description !== 'string')) invalidFields();
        keys[field.key] = true;
        if (field.type === 'external') {
          external = true;
          if (typeof field.url !== 'string' || !field.url) invalidFields();
        }
        if (field.hidden && field.required) hiddenRequired = true;
        if (field.options !== undefined) {
          if (!Array.isArray(field.options)) invalidFields();
          var optionValues = Object.create(null);
          field.options.forEach(function (option) {
            if (!isPlainObject(option) || typeof option.value !== 'string' || typeof option.label !== 'string' || optionValues[option.value]) invalidFields();
            optionValues[option.value] = true;
          });
        }
        if (field.type === 'multiselect' && !Array.isArray(field.options)) invalidFields();
        if (field.when !== undefined) {
          if (!Array.isArray(field.when)) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid question conditions.');
          field.when.forEach(function (when) {
            if (!isPlainObject(when) || !nonemptyID(when.key) || ['__proto__', 'prototype', 'constructor'].indexOf(when.key) !== -1 ||
                ['eq', 'neq'].indexOf(when.op) === -1 ||
                !(typeof when.value === 'string' || typeof when.value === 'number' && Number.isFinite(when.value) || typeof when.value === 'boolean')) {
              throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid question conditions.');
            }
          });
        }
        if (field.type === 'string') {
          if ((field.minLength !== undefined && !integerBound(field.minLength)) || (field.maxLength !== undefined && !integerBound(field.maxLength)) ||
              (field.minLength !== undefined && field.maxLength !== undefined && field.minLength > field.maxLength) ||
              (field.default !== undefined && typeof field.default !== 'string')) invalidFields();
        } else if (field.type === 'number' || field.type === 'integer') {
          if ((field.minimum !== undefined && !numericBound(field.minimum)) || (field.maximum !== undefined && !numericBound(field.maximum)) ||
              (field.minimum !== undefined && field.maximum !== undefined && boundNumber(field.minimum) > boundNumber(field.maximum)) ||
              (field.default !== undefined && !numericValue(field.default))) invalidFields();
        } else if (field.type === 'boolean') {
          if (field.default !== undefined && typeof field.default !== 'boolean') invalidFields();
        } else if (field.type === 'multiselect') {
          if ((field.minItems !== undefined && !integerBound(field.minItems)) || (field.maxItems !== undefined && !integerBound(field.maxItems)) ||
              (field.minItems !== undefined && field.maxItems !== undefined && field.minItems > field.maxItems) ||
              (field.default !== undefined && (!Array.isArray(field.default) || !field.default.every(function (value) { return typeof value === 'string'; })))) invalidFields();
        } else if (field.default !== undefined) invalidFields();
      });
      form.fields.forEach(function (field) {
        if (field.when && field.when.some(function (when) { return !keys[when.key]; })) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid question conditions.');
      });
      return { form: form, external: external, hiddenRequired: hiddenRequired };
    }

    async function questionInstances(state) {
      var response = await api(state, '/session/active');
      var active = response && response.data;
      if (!isPlainObject(active) || Object.keys(active).length > 100) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid active session data.');
      var ids = Object.keys(active);
      ids.forEach(function (id) {
        if (!sessionID(id) || !isPlainObject(active[id]) || active[id].type !== 'running') throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid active session data.');
      });
      var focus = state.mode === 'default_chat' && state.selected && sessionID(state.selected.session_id) ? state.selected.session_id : state.lastSessionID;
      if (sessionID(focus) && ids.indexOf(focus) === -1) ids.push(focus);
      var limit = createLimiter(4);
      var total = 0;
      var result;
      try {
        result = await Promise.all(ids.map(function (id) {
          return limit(async function () {
            var formsResponse = await api(state, sessionPath(id) + '/form');
            if (!formsResponse || !Array.isArray(formsResponse.data)) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid question data.');
            total += formsResponse.data.length;
            if (total > 200) throw makeError('PLUGIN_UNAVAILABLE', 'Too many questions to inspect safely.');
            return formsResponse.data.map(function (form) { return validForm(form, id); });
          });
        }));
      } catch (err) { limit.stop(err); throw err; }
      var forms = [];
      var formIDs = Object.create(null);
      result.forEach(function (list) {
        list.forEach(function (item) {
          var key = item.form.sessionID + '\u0000' + item.form.id;
          if (formIDs[key]) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned duplicate questions.');
          formIDs[key] = true;
          forms.push(item);
        });
      });
      forms.sort(function (a, b) { return a.form.sessionID < b.form.sessionID ? -1 : a.form.sessionID > b.form.sessionID ? 1 : a.form.id < b.form.id ? -1 : a.form.id > b.form.id ? 1 : 0; });
      return forms.map(function (item) {
        var f = item.form;
        var fields = JSON.stringify(f.fields);
        if (fields.length > 16000) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode question fields exceed safe display size.');
        return { instanceId: f.sessionID + ':' + f.id, properties: {
          name: { shortText: { text: unicodePrefix(f.title, 7) }, longText: { text: f.title } },
          session_id: { longText: { text: f.sessionID } }, form_id: { longText: { text: f.id } },
          question: { longText: { text: f.title } }, fields: { longText: { text: fields } },
          answerable: { boolean: { value: !item.external && !item.hiddenRequired } }, url: { longText: { text: sessionURL(state.url, f.sessionID) } }
        }};
      });
    }

    function activityInstance(checkedAt, connected, snapshot, failure) {
      var properties = {
        name: { shortText: { text: 'OpenCode' }, longText: { text: 'OpenCode' } },
        connected: { boolean: { value: connected } },
        checked_at: { timestamp: { value: checkedAt } }
      };
      if (failure) {
        var summary = failure === 'setup' ? ['Setup', 'Connect to an OpenCode server'] :
          failure === 'auth' ? ['Sign in', 'OpenCode authentication required'] :
          failure === 'permission' ? ['Blocked', 'OpenCode network access denied'] :
          ['Unknown', 'Activity unavailable'];
        properties.summary = { shortText: { text: summary[0] }, longText: { text: summary[1] } };
      } else {
        var activeCount = snapshot.roots.length;
        var attentionCount = snapshot.attentionRoots.length;
        var shortSummary = activeCount === 0 ? 'Idle' : String(activeCount) + ' act';
        var longSummary = activeCount === 0 ? 'No active sessions' :
          String(activeCount) + ' active' + (attentionCount ? ', ' + String(attentionCount) + ' needs attention' : '');
        properties.active_count = { numericValue: { value: activeCount, min: 0 }, shortText: { text: String(activeCount) } };
        properties.attention_count = { numericValue: { value: attentionCount, min: 0 }, shortText: { text: String(attentionCount) } };
        properties.summary = { shortText: { text: unicodePrefix(shortSummary, 7) }, longText: { text: longSummary } };
      }
      return { instanceId: 'opencode', properties: properties };
    }

    function directoryPath(value) {
      return typeof value === 'string' && !/[\u0000-\u001f\u007f]/.test(value) &&
        (/^\/(?:[^\u0000-\u001f\u007f]*)$/.test(value) || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value));
    }

    async function config(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw makeError('INVALID_REQUEST', 'Invalid configuration request.');
      var state = await load();
      var type = input.type;
      if (type === 'status' || type === undefined) return status(state);

      if (type === 'connect') {
        var url = cleanURL(input.url);
        var username = typeof input.username === 'string' && input.username.trim() ? input.username.trim() : DEFAULT_USERNAME;
        if (/[\u0000-\u001f\u007f:]/.test(username)) throw makeError('INVALID_ARGS', 'Username must not contain colons or control characters.');
        if (typeof input.password !== 'string' || !input.password) throw makeError('INVALID_ARGS', 'Password is required.');
        var candidate = Object.assign({}, state, { url: url, username: username, password: input.password, auth_method: 'password' });
        var info = await api(candidate, '/info');
        var version = info && info.version;
        if (typeof version !== 'string' || !/^2\./.test(version)) throw makeError('INVALID_ARGS', 'OpenCode V2 server required.');
        if (state.url !== url || state.username !== username) {
          candidate.directory = '';
          candidate.selected = null;
          candidate.lastSessionID = null;
          candidate.nicknames = {};
          candidate.last_seen = {};
          candidate.mode = 'default_chat';
        }
        candidate.version = version;
        await save(candidate);
        refresh();
        return status(candidate);
      }

      if (type === 'pair') {
        if (typeof input.link !== 'string' || !input.link.trim()) throw makeError('INVALID_ARGS', 'Enter an OpenCode pairing link.');
        var paired = await redeemPairingLink(input.link.trim());
        var pairCandidate = Object.assign({}, state, {
          url: paired.origin, username: DEFAULT_USERNAME, password: paired.token, auth_method: 'pair'
        });
        var pairInfo;
        try { pairInfo = await api(pairCandidate, '/info'); }
        catch (pairError) {
          if (pairError && pairError.code === 'AUTH_REQUIRED') {
            throw makeError('INVALID_ARGS', 'Pairing token was rejected by the server.');
          }
          throw pairError;
        }
        var pairVersion = pairInfo && pairInfo.version;
        if (typeof pairVersion !== 'string' || !/^2\./.test(pairVersion)) throw makeError('INVALID_ARGS', 'OpenCode V2 server required.');
        if (state.url !== paired.origin || state.username !== DEFAULT_USERNAME) {
          pairCandidate.directory = '';
          pairCandidate.selected = null;
          pairCandidate.lastSessionID = null;
          pairCandidate.nicknames = {};
          pairCandidate.last_seen = {};
          pairCandidate.mode = 'default_chat';
        }
        pairCandidate.version = pairVersion;
        await save(pairCandidate);
        refresh();
        return status(pairCandidate);
      }

      if (type === 'disconnect') {
        try { await storage.removeItem(STATE_KEY); }
        catch (_) { throw makeError('PLUGIN_UNAVAILABLE', 'Secure storage is unavailable.'); }
        refresh();
        return status(emptyState());
      }

      if (type === 'test') {
        requireConnection(state);
        var tested = await api(state, '/info');
        var testedVersion = tested && tested.version;
        if (typeof testedVersion !== 'string' || !/^2\./.test(testedVersion)) throw makeError('INVALID_ARGS', 'OpenCode V2 server required.');
        state.version = testedVersion;
        await save(state);
        return status(state);
      }

      if (type === 'list') {
        requireConnection(state);
        var list = await chatRows(state, input.cursor);
        return { sessions: list.sessions, next_cursor: list.next_cursor };
      }

      if (type === 'projects') {
        requireConnection(state);
        var projectResponse = await api(state, '/project');
        if (!Array.isArray(projectResponse)) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid projects.');
        return { projects: projectResponse.map(function (project) {
          if (!project || typeof project.id !== 'string' || typeof project.canonical !== 'string') {
            throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid projects.');
          }
          return { id: project.id, name: typeof project.name === 'string' ? project.name : project.canonical, directory: project.canonical };
        }) };
      }

      if (type === 'mode') {
        if (input.mode !== 'default_chat' && input.mode !== 'new_chat') throw makeError('INVALID_ARGS', 'Invalid mode.');
        state.mode = input.mode;
        await save(state);
        refresh();
        return status(state);
      }

      if (type === 'reply_count') {
        if (!Number.isInteger(input.count) || input.count < 1 || input.count > MAX_REPLY_COUNT) {
          throw makeError('INVALID_ARGS', 'Reply session count must be a whole number from 1 to 20.');
        }
        state.reply_count = input.count;
        await save(state);
        refresh();
        return status(state);
      }

      if (type === 'default_delivery') {
        if (!validDelivery(input.delivery)) throw makeError('INVALID_ARGS', 'Delivery must be queue or steer.');
        state.default_delivery = input.delivery;
        await save(state);
        return status(state);
      }

      if (type === 'directory') {
        if (!directoryPath(input.directory)) throw makeError('INVALID_ARGS', 'Directory must be an absolute server path.');
        state.directory = input.directory;
        await save(state);
        refresh();
        return status(state);
      }

      if (type === 'select') {
        requireConnection(state);
        if (!sessionID(input.session_id)) throw makeError('INVALID_ARGS', 'Invalid session ID.');
        var selected = await getSession(state, input.session_id);
        if (archived(selected)) throw makeError('INVALID_ARGS', 'Archived sessions cannot be selected.');
        state.selected = { session_id: selected.id, title: titleOf(selected) };
        state.mode = 'default_chat';
        await save(state);
        refresh();
        return status(state);
      }

      if (type === 'save_session') {
        requireConnection(state);
        if (!sessionID(input.session_id) || typeof input.nickname !== 'string') throw makeError('INVALID_ARGS', 'Invalid session nickname.');
        var namedSession = await getSession(state, input.session_id);
        if (archived(namedSession)) throw makeError('INVALID_ARGS', 'Archived sessions cannot be saved.');
        var nickname = input.nickname.trim();
        if (nickname.length > 40 || /^(new|new chat)$/i.test(nickname)) throw makeError('INVALID_ARGS', 'Nickname is reserved or too long.');
        Object.keys(state.nicknames).forEach(function (id) {
          if (id !== input.session_id && nickname && state.nicknames[id].toLowerCase() === nickname.toLowerCase()) {
            throw makeError('INVALID_ARGS', 'Nickname already in use.');
          }
        });
        if (nickname) state.nicknames[input.session_id] = nickname;
        else delete state.nicknames[input.session_id];
        await save(state);
        refresh();
        return status(state);
      }

      throw makeError('INVALID_REQUEST', 'Unsupported configuration request.');
    }

    async function source(input) {
      if (!input || typeof input.category !== 'string' || typeof input.item !== 'string') {
        throw makeError('INVALID_REQUEST', 'Unsupported source request.');
      }
      var state = await load();
      if (input.category === 'agent' && input.item === 'configured') {
        var name = state.mode === 'new_chat' ? DEFAULT_TITLE :
          (state.selected ? (state.nicknames[state.selected.session_id] || state.selected.title) : DEFAULT_TITLE);
        var ready = configured(state);
        return { validUntilMs: now() + 60000, instances: [{ instanceId: 'opencode', properties: {
          name: { shortText: { text: name || DEFAULT_TITLE } },
          configured: { boolean: { value: ready }, shortText: { text: ready ? 'Configured' : 'Not configured' } }
        } }] };
      }
      if (input.category === 'agent' && input.item === 'chats') {
        requireConnection(state);
        var page = await chatRows(state, input.cursor);
        var chatInstances = page.sessions.map(function (session) {
          return { instanceId: session.session_id, properties: {
            name: { shortText: { text: session.nickname || session.title } },
            title: { shortText: { text: session.title } },
            url: { longText: { text: session.url } }
          } };
        });
        if (directoryPath(state.directory)) {
          chatInstances.push({ instanceId: 'new', properties: {
            name: { shortText: { text: 'New' } },
            title: { shortText: { text: 'New session' } }
          } });
        }
        return {
          validUntilMs: now() + 900000,
          instances: chatInstances
        };
      }
      if (input.category === 'opencode' && input.item === 'active_session') {
        var active = await activeSnapshot(state);
        return {
          validUntilMs: now() + 20000,
          instances: active.sessions.map(function (detail) { return activeInstance(state, detail); })
        };
      }
      if (input.category === 'opencode' && input.item === 'activity') {
        var checkedAt = Math.floor(now() / 1000);
        var connected = false;
        var summary;
        if (!state.url || !state.username || !state.password || !/^2\./.test(state.version)) {
          summary = 'setup';
        } else {
          try {
            var activity = await activeSnapshot(state, function () { connected = true; });
            return {
              validUntilMs: now() + 20000,
              instances: [activityInstance(checkedAt, true, activity, null)]
            };
          } catch (activityError) {
            if (activityError && activityError.code === 'AUTH_REQUIRED') summary = 'auth';
            else if (activityError && activityError.code === 'PERMISSION_DENIED') summary = 'permission';
            else summary = 'unavailable';
          }
        }
        return {
          validUntilMs: now() + 20000,
          instances: [activityInstance(checkedAt, connected, null, summary)]
        };
      }
      if (input.category === 'opencode' && input.item === 'reply') {
        requireConnection(state);
        var replyID = state.mode === 'default_chat' && state.selected && sessionID(state.selected.session_id) ? state.selected.session_id :
          (sessionID(state.lastSessionID) ? state.lastSessionID : null);
        return { validUntilMs: now() + 20000, instances: replyID ? await replyInstances(state, replyID) : [] };
      }
      if (input.category === 'opencode' && input.item === 'replies') {
        requireConnection(state);
        return await repliesInstances(state);
      }
      if (input.category === 'opencode' && input.item === 'chat_status') {
        requireConnection(state);
        return await chatStatusInstances(state);
      }
      if (input.category === 'opencode' && input.item === 'permission') {
        requireConnection(state);
        return await permissionInstances(state);
      }
      if (input.category === 'opencode' && input.item === 'job') {
        requireConnection(state);
        return { validUntilMs: now() + 20000, instances: await jobInstances(state) };
      }
      if (input.category === 'opencode' && input.item === 'question') {
        requireConnection(state);
        return { validUntilMs: now() + 20000, instances: await questionInstances(state) };
      }
      throw makeError('INVALID_REQUEST', 'Unsupported source request.');
    }

    function makeMessageID() {
      var bytes;
      try {
        if (root.crypto && typeof root.crypto.getRandomValues === 'function') {
          bytes = new Uint8Array(16);
          root.crypto.getRandomValues(bytes);
          var hex = '';
          for (var i = 0; i < bytes.length; i += 1) hex += ('0' + bytes[i].toString(16)).slice(-2);
          return 'msg_' + hex;
        }
      } catch (_) {}
      requestCounter += 1;
      var fallback = String(now()) + '_' + String(random ? random() : Math.random().toString(36).slice(2)) + '_' + requestCounter;
      return 'msg_' + fallback.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 100);
    }

    function validReceipt(message, id, text, delivery) {
      return !!(message && message.id === id && message.sessionID === text.sessionID &&
        message.type === 'user' && message.payload && message.payload.text === text.text &&
        (delivery === undefined || message.delivery === delivery));
    }

    function receiptShape(message, id, text) {
      return !!(message && message.id === id && message.sessionID === text.sessionID &&
        message.type === 'user' && message.payload && message.payload.text === text.text);
    }

    async function verifyDelivery(state, sessionId, messageId, text, delivery) {
      try {
        var direct = await api(state, sessionPath(sessionId) + '/message/' + encodeURIComponent(messageId));
        var directMessage = direct && direct.data;
        if (directMessage && directMessage.id === messageId && directMessage.type === 'user' && directMessage.text === text &&
            (directMessage.delivery === undefined || directMessage.delivery === delivery)) return true;
      } catch (_) {}
      try {
        var inbox = await api(state, sessionPath(sessionId) + '/inbox');
        var messages = inbox && inbox.data;
        if (Array.isArray(messages)) {
          for (var i = 0; i < messages.length; i += 1) {
            if (validReceipt(messages[i], messageId, { sessionID: sessionId, text: text }, delivery)) return true;
          }
        }
      } catch (_) {}
      return false;
    }

    var refreshedActions = ['agent/chats', 'opencode/active_session', 'opencode/activity', 'opencode/reply', 'opencode/replies', 'opencode/chat_status', 'opencode/permission', 'opencode/question', 'opencode/job'];

    async function approvePermissionAction(state, args) {
      if (!isPlainObject(args)) throw makeError('INVALID_ARGS', 'Invalid permission response.');
      Object.keys(args).forEach(function (key) {
        if (key !== 'session_id' && key !== 'request_id' && key !== 'decision' && key !== 'message') {
          throw makeError('INVALID_ARGS', 'Unexpected action argument.');
        }
      });
      if (!sessionID(args.session_id) || !nonemptyID(args.request_id)) throw makeError('INVALID_ARGS', 'Invalid permission request.');
      var decision = args.decision === undefined ? 'once' : args.decision;
      if (decision !== 'once' && decision !== 'reject') throw makeError('INVALID_ARGS', 'Decision must be once or reject.');
      if (args.message !== undefined && (typeof args.message !== 'string' || args.message.length > 2000)) {
        throw makeError('INVALID_ARGS', 'Permission message is invalid.');
      }
      var session = await getSession(state, args.session_id);
      if (archived(session)) throw makeError('INVALID_ARGS', 'Archived sessions cannot receive permission responses.');
      var detail;
      try { detail = await api(state, sessionPath(args.session_id) + '/permission/' + encodeURIComponent(args.request_id)); }
      catch (err) {
        if (err && err.httpStatus === 404) throw makeError('INVALID_ARGS', 'Permission request not found or already settled. Refresh first.');
        throw err;
      }
      var request = validPermissionRequest(detail && detail.data);
      if (request.id !== args.request_id || request.sessionID !== args.session_id) {
        throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned a different permission request.');
      }
      var body = { decision: decision };
      if (args.message) body.message = args.message;
      try {
        await api(state, sessionPath(args.session_id) + '/permission/' + encodeURIComponent(args.request_id) + '/reply', 'POST', body, 204);
      } catch (err) {
        if (err && err.httpStatus === 400) throw makeError('INVALID_ARGS', 'OpenCode rejected the permission response.');
        if (err && err.httpStatus === 404) throw makeError('INVALID_ARGS', 'Permission request not found or already settled. Refresh first.');
        if (err && err.httpStatus === 409) throw makeError('INVALID_ARGS', 'Permission request already settled. Refresh first.');
        if (err && (err.code === 'PERMISSION_DENIED' || err.code === 'AUTH_REQUIRED' || err.code === 'RATE_LIMITED')) throw err;
        if (err && err.httpStatus && err.httpStatus < 500) throw err;
        throw makeError('PLUGIN_UNAVAILABLE', 'Permission response uncertain. Inspect OpenCode before retrying.');
      }
      return {
        text: (decision === 'once' ? 'Permission approved: ' : 'Permission rejected: ') + request.action,
        refreshed: refreshedActions
      };
    }

    async function markChatReadAction(state, args) {
      if (!isPlainObject(args)) throw makeError('INVALID_ARGS', 'Invalid read request.');
      Object.keys(args).forEach(function (key) {
        if (key !== 'session_id' && key !== 'message_id') throw makeError('INVALID_ARGS', 'Unexpected action argument.');
      });
      if (!sessionID(args.session_id)) throw makeError('INVALID_ARGS', 'Invalid session ID.');
      if (args.message_id !== undefined && !nonemptyID(args.message_id)) throw makeError('INVALID_ARGS', 'Invalid message ID.');
      var session = await getSession(state, args.session_id);
      var messageID = args.message_id;
      if (!messageID) {
        var reply = await latestAssistantReply(state, session.id);
        if (!reply) return { text: 'Chat has no reply to mark read: ' + titleOf(session), refreshed: ['opencode/chat_status'] };
        messageID = reply.message.id;
      }
      var fresh = await load();
      if (!fresh.last_seen || typeof fresh.last_seen !== 'object' || Array.isArray(fresh.last_seen)) fresh.last_seen = {};
      fresh.last_seen[session.id] = messageID;
      await save(fresh);
      return { text: 'Chat marked read: ' + titleOf(session), refreshed: ['opencode/chat_status'] };
    }

    async function interruptAction(state, args) {
      if (!isPlainObject(args) || Object.keys(args).length !== 1 || !sessionID(args.session_id)) throw makeError('INVALID_ARGS', 'Invalid session ID.');
      var session = await getSession(state, args.session_id);
      if (archived(session)) throw makeError('INVALID_ARGS', 'Archived sessions cannot be interrupted.');
      var response;
      try { response = await api(state, sessionPath(session.id) + '/interrupt?resume=false', 'POST'); }
      catch (err) {
        if (err && (err.code === 'PERMISSION_DENIED' || err.code === 'AUTH_REQUIRED' || err.code === 'RATE_LIMITED')) throw err;
        if (err && err.httpStatus && err.httpStatus < 500) throw err;
        throw makeError('PLUGIN_UNAVAILABLE', 'Interrupt outcome uncertain. Inspect OpenCode before retrying.');
      }
      if (!response || typeof response.interrupted !== 'boolean') throw makeError('PLUGIN_UNAVAILABLE', 'Interrupt outcome uncertain. Inspect OpenCode before retrying.');
      return { text: response.interrupted ? 'Interrupted OpenCode session: ' + titleOf(session) : 'OpenCode session is already idle: ' + titleOf(session), refreshed: refreshedActions };
    }

    function answerValue(value) {
      return typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) ||
        Array.isArray(value) && value.every(function (entry) { return typeof entry === 'string'; });
    }

    function validateAnswerShape(answer) {
      if (!isPlainObject(answer) || Object.keys(answer).length > 50) throw makeError('INVALID_ARGS', 'Answer must be an object with at most 50 fields.');
      Object.keys(answer).forEach(function (key) {
        if (!nonemptyID(key) || ['__proto__', 'prototype', 'constructor'].indexOf(key) !== -1 || !answerValue(answer[key])) {
          throw makeError('INVALID_ARGS', 'Answer contains an invalid field.');
        }
      });
      var serialized;
      try { serialized = JSON.stringify(answer); } catch (_) { throw makeError('INVALID_ARGS', 'Answer is invalid.'); }
      if (!serialized || serialized.length > 16000) throw makeError('INVALID_ARGS', 'Answer exceeds safe size.');
    }

    function validateAnswer(form, answer) {
      validateAnswerShape(answer);
      var fields = Object.create(null);
      form.fields.forEach(function (field) { fields[field.key] = field; });
      Object.keys(answer).forEach(function (key) {
        if (!nonemptyID(key) || ['__proto__', 'prototype', 'constructor'].indexOf(key) !== -1 ||
            !Object.prototype.hasOwnProperty.call(fields, key) || !answerValue(answer[key])) throw makeError('INVALID_ARGS', 'Answer contains an invalid field.');
        var field = fields[key];
        if (field.hidden || field.type === 'external') throw makeError('INVALID_ARGS', 'Answer contains a hidden or unsupported field.');
      });
      function condition(field, values) {
        if (!field.when) return true;
        return field.when.every(function (when) {
          if (!Object.prototype.hasOwnProperty.call(fields, when.key)) throw makeError('INVALID_ARGS', 'Question has unsupported conditions.');
          var actual = Object.prototype.hasOwnProperty.call(values, when.key) ? values[when.key] : undefined;
          if (actual === undefined) return false;
          var equal = JSON.stringify(actual) === JSON.stringify(when.value);
          return when.op === 'eq' ? equal : when.op === 'neq' ? !equal : false;
        });
      }
      form.fields.forEach(function (field) {
        var supplied = Object.prototype.hasOwnProperty.call(answer, field.key);
        if (supplied && !condition(field, answer)) throw makeError('INVALID_ARGS', 'Answer contains an inactive field.');
        if (!supplied && !field.hidden && condition(field, answer) && field.required) throw makeError('INVALID_ARGS', 'Answer is missing a required field.');
        if (!supplied) return;
        var value = answer[field.key];
        // Format and pattern remain server-validated; avoid running unbounded regexes locally.
        if (field.type === 'string' && (typeof value !== 'string' || field.minLength !== undefined && value.length < field.minLength || field.maxLength !== undefined && value.length > field.maxLength)) {
          throw makeError('INVALID_ARGS', 'Answer does not match question fields.');
        }
        if ((field.type === 'number' || field.type === 'integer') && (typeof value !== 'number' || !Number.isFinite(value) || field.type === 'integer' && !Number.isInteger(value) ||
            field.minimum !== undefined && value < Number(field.minimum) || field.maximum !== undefined && value > Number(field.maximum))) throw makeError('INVALID_ARGS', 'Answer does not match question fields.');
        if (field.type === 'boolean' && typeof value !== 'boolean') throw makeError('INVALID_ARGS', 'Answer does not match question fields.');
        if (field.type === 'multiselect') {
          if (!Array.isArray(value) || !value.every(function (v) { return typeof v === 'string'; }) || new Set(value).size !== value.length ||
              field.minItems !== undefined && value.length < field.minItems || field.maxItems !== undefined && value.length > field.maxItems) throw makeError('INVALID_ARGS', 'Answer does not match question fields.');
        }
        var options = field.options;
        if (options && field.custom !== true) {
          var allowed = options.map(function (option) { return option.value; });
          var choices = Array.isArray(value) ? value : [value];
          choices.forEach(function (choice) { if (allowed.indexOf(choice) === -1) throw makeError('INVALID_ARGS', 'Answer does not match question options.'); });
        }
      });
    }

    async function answerAction(state, args) {
      if (!isPlainObject(args) || Object.keys(args).length !== 3 || !sessionID(args.session_id) || !nonemptyID(args.form_id) || !isPlainObject(args.answer)) {
        throw makeError('INVALID_ARGS', 'Invalid question answer.');
      }
      validateAnswerShape(args.answer);
      var response;
      try { response = await api(state, sessionPath(args.session_id) + '/form/' + encodeURIComponent(args.form_id)); }
      catch (err) {
        if (err && err.httpStatus === 404) throw makeError('INVALID_ARGS', 'Question not found.');
        throw err;
      }
      var checked = validForm(response && response.data, args.session_id);
      var detail = checked.form;
      if (detail.id !== args.form_id) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned a different question.');
      var formStatus = isPlainObject(detail.state) ? detail.state.status : null;
      if (['pending', 'answered', 'cancelled'].indexOf(formStatus) === -1) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid question state.');
      if (formStatus !== 'pending') throw makeError('INVALID_ARGS', 'Question already settled. Refresh before answering.');
      if (checked.external) throw makeError('INVALID_ARGS', 'This question requires external interaction and cannot be answered here.');
      if (checked.hiddenRequired) throw makeError('INVALID_ARGS', 'This question requires a hidden field; answer it in OpenCode desktop.');
      validateAnswer(detail, args.answer);
      try { await api(state, sessionPath(args.session_id) + '/form/' + encodeURIComponent(args.form_id) + '/reply', 'POST', { answer: args.answer }, 204); }
      catch (err) {
        if (err && err.httpStatus === 400) throw makeError('INVALID_ARGS', 'OpenCode rejected the answer. Refresh the question and check its fields.');
        if (err && err.httpStatus === 409) throw makeError('INVALID_ARGS', 'Question already settled. Refresh before answering.');
        if (err && err.httpStatus === 404) throw makeError('INVALID_ARGS', 'Question not found.');
        if (err && (err.code === 'PERMISSION_DENIED' || err.code === 'AUTH_REQUIRED' || err.code === 'RATE_LIMITED')) throw err;
        if (err && err.httpStatus && err.httpStatus < 500) throw err;
        throw makeError('PLUGIN_UNAVAILABLE', 'Answer outcome uncertain. Inspect OpenCode before retrying.');
      }
      return { text: 'Answer submitted to OpenCode.', refreshed: refreshedActions };
    }

    async function action(input) {
      if (input && ['interrupt_session', 'answer_question', 'approve_permission', 'mark_chat_read'].indexOf(input.action) !== -1) {
        if (!input.args || typeof input.args !== 'object' || Array.isArray(input.args)) throw makeError('INVALID_ARGS', 'Invalid action request.');
        var controlState = await load();
        requireConnection(controlState);
        if (input.action === 'interrupt_session') return interruptAction(controlState, input.args);
        if (input.action === 'answer_question') return answerAction(controlState, input.args);
        if (input.action === 'approve_permission') return approvePermissionAction(controlState, input.args);
        return markChatReadAction(controlState, input.args);
      }
      if (!input || typeof input !== 'object' || input.action !== 'send_to_agent' ||
          !input.args || typeof input.args !== 'object' || Array.isArray(input.args)) {
        throw makeError('INVALID_ARGS', 'Invalid action request.');
      }
      var args = input.args;
      Object.keys(args).forEach(function (key) {
        if (key !== 'message' && key !== 'chat_id' && key !== 'delivery') throw makeError('INVALID_ARGS', 'Unexpected action argument.');
      });
      if (args.delivery !== undefined && !validDelivery(args.delivery)) {
        throw makeError('INVALID_ARGS', 'Delivery must be queue or steer.');
      }
      var message = args.message;
      if (typeof message !== 'string' || !message.trim() || message.length > 16000 ||
          (args.chat_id !== undefined && args.chat_id !== null && typeof args.chat_id !== 'string')) {
        throw makeError('INVALID_ARGS', 'Message or chat_id is invalid.');
      }
      var state = await load();
      requireConnection(state);
      var delivery = args.delivery === undefined ? state.default_delivery : args.delivery;
      var target = args.chat_id === undefined || args.chat_id === null || args.chat_id.trim() === '' ? null : args.chat_id.trim();
      if (target === null) {
        if (state.mode === 'new_chat') target = 'new';
        else if (state.selected) target = state.selected.session_id;
        else throw makeError('INVALID_ARGS', 'Choose a default session or new-chat directory first.');
      }
      var create = /^(new|new chat)$/i.test(target);
      var session;
      if (!create) {
        var id = null;
        if (sessionID(target)) id = target;
        else {
          var lower = target.toLowerCase();
          var nicknameIDs = Object.keys(state.nicknames).filter(function (key) {
            return state.nicknames[key].toLowerCase() === lower;
          });
          if (nicknameIDs.length > 1) throw makeError('INVALID_ARGS', 'Chat nickname is ambiguous.');
          if (nicknameIDs.length === 1) id = nicknameIDs[0];
          if (!id) {
            var partialNickIDs = Object.keys(state.nicknames).filter(function (key) {
              return state.nicknames[key].toLowerCase().indexOf(lower) !== -1;
            });
            if (partialNickIDs.length > 1) throw makeError('INVALID_ARGS', 'Chat nickname is ambiguous.');
            if (partialNickIDs.length === 1) id = partialNickIDs[0];
          }
          if (!id) {
            var all = await allSessions(state);
            var titleMatches = all.filter(function (item) { return titleOf(item).toLowerCase().indexOf(lower) !== -1; });
            if (titleMatches.length !== 1) throw makeError('INVALID_ARGS', titleMatches.length ? 'Chat title is ambiguous.' : 'Chat not found.');
            id = titleMatches[0].id;
          }
        }
        if (!sessionID(id)) throw makeError('INVALID_ARGS', 'Invalid session ID.');
        session = await getSession(state, id);
        if (archived(session)) throw makeError('INVALID_ARGS', 'Archived sessions cannot receive messages.');
      } else {
        if (!directoryPath(state.directory)) throw makeError('INVALID_ARGS', 'Set an absolute server directory before creating a session.');
        var created = await api(state, '/session', 'POST', { title: 'Pebble', location: { directory: state.directory } });
        session = validSession(created && created.data);
        if (archived(session)) throw makeError('INVALID_ARGS', 'Archived sessions cannot receive messages.');
      }

      var messageID = makeMessageID();
      var receipt;
      var deliveryVerified = false;
      var receiptText = { sessionID: session.id, text: message };
      try {
        receipt = await api(state, sessionPath(session.id) + '/prompt', 'POST', {
          id: messageID, text: message, delivery: delivery
        });
      } catch (sendError) {
        if (sendError && (sendError.code === 'PERMISSION_DENIED' || sendError.code === 'AUTH_REQUIRED' || sendError.code === 'RATE_LIMITED')) throw sendError;
        if (sendError && sendError.httpStatus && sendError.httpStatus < 500 && sendError.httpStatus !== 409) throw sendError;
        if (sendError && sendError.httpStatus === 409) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode reported a conflict; inspect desktop before retrying.');
        if (!await verifyDelivery(state, session.id, messageID, message, delivery)) {
          throw makeError('PLUGIN_UNAVAILABLE', 'Delivery uncertain. Inspect OpenCode desktop before retrying.');
        }
        deliveryVerified = true;
        receipt = null;
      }
      var result = receipt && receipt.data;
      if (receipt && validReceipt(result, messageID, receiptText, delivery)) {
        deliveryVerified = true;
      } else if (receipt && receiptShape(result, messageID, receiptText)) {
        throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode accepted the message with a different delivery mode. Inspect desktop before retrying.');
      }
      if (!deliveryVerified) {
        if (!await verifyDelivery(state, session.id, messageID, message, delivery)) {
          throw makeError('PLUGIN_UNAVAILABLE', 'Delivery uncertain. Inspect OpenCode desktop before retrying.');
        }
        deliveryVerified = true;
      }
      var focusWarning = false;
      try {
        var freshState = await load();
        if (freshState.url !== state.url || freshState.username !== state.username || !freshState.password || !/^2\./.test(freshState.version)) {
          focusWarning = true;
        } else {
          freshState.lastSessionID = session.id;
          await save(freshState);
        }
      } catch (_) { focusWarning = true; }
      return {
        text: (delivery === 'steer' ? 'Message steered into OpenCode: ' : 'Message queued for OpenCode: ') + titleOf(session) + (focusWarning ? ' Focus not saved.' : ''),
        refreshed: refreshedActions
      };
    }

    return { config: config, source: source, action: action };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { createService: createService };

  if (root.Pebble && typeof root.Pebble.registerSourceHandler === 'function' &&
      typeof root.Pebble.registerActionHandler === 'function' && typeof root.Pebble.registerConfigHandler === 'function' &&
      root.Pebble.secureStorage && typeof root.fetch === 'function') {
    var service = createService({ storage: root.Pebble.secureStorage, fetch: root.fetch.bind(root) });
    root.Pebble.registerSourceHandler(function (request, respond) {
      return service.source(request).then(function (data) { respond.data(data); }, function (err) {
        var safe = safeError(err);
        respond.error(safe.code, safe.message);
      });
    });
    root.Pebble.registerActionHandler(function (request, respond) {
      return service.action(request).then(function (result) { respond.ok(result); }, function (err) {
        var safe = safeError(err);
        respond.error(safe.code, safe.message);
      });
    });
    root.Pebble.registerConfigHandler(function (message, respond) {
      return service.config(message).then(function (result) { respond(result); }, function (err) {
        respond({ error: safeError(err) });
      });
    });
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
