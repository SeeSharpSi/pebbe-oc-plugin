(function (root) {
  'use strict';

  var STATE_KEY = 'opencode.plugin.state.v1';
  var DEFAULT_USERNAME = 'opencode';
  var DEFAULT_TITLE = 'New session';
  var PAGE_LIMIT = 50;
  var MAX_PAGES = 50;
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
      directory: '', selected: null, nicknames: {}
    };
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
        return state;
      } catch (_) { return emptyState(); }
    }

    async function save(state) {
      try { await storage.setItem(STATE_KEY, JSON.stringify(state)); }
      catch (_) { throw makeError('PLUGIN_UNAVAILABLE', 'Secure storage is unavailable.'); }
    }

    function refresh() {
      if (root.Pebble && typeof root.Pebble.refreshSources === 'function') {
        try { root.Pebble.refreshSources(['agent/chats', 'agent/configured']); } catch (_) {}
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
        selected: state.selected || null, nicknames: state.nicknames || {}
      };
    }

    function requireConnection(state) {
      if (!state.url || !state.username || !state.password || !/^2\./.test(state.version)) {
        throw makeError('AUTH_REQUIRED', 'Connect to an OpenCode V2 server first.');
      }
    }

    async function request(state, path, method, body) {
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
      if (response.status === 204) return null;
      try { return await response.json(); }
      catch (_) { throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid JSON.'); }
    }

    function api(state, path, method, body) { return request(state, '/api' + path, method, body); }
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
        var candidate = Object.assign({}, state, { url: url, username: username, password: input.password });
        var info = await api(candidate, '/info');
        var version = info && info.version;
        if (typeof version !== 'string' || !/^2\./.test(version)) throw makeError('INVALID_ARGS', 'OpenCode V2 server required.');
        if (state.url !== url || state.username !== username) {
          candidate.directory = '';
          candidate.selected = null;
          candidate.nicknames = {};
          candidate.mode = 'default_chat';
        }
        candidate.version = version;
        await save(candidate);
        refresh();
        return status(candidate);
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
      if (!input || input.category !== 'agent' || (input.item !== 'chats' && input.item !== 'configured')) {
        throw makeError('INVALID_REQUEST', 'Unsupported source request.');
      }
      var state = await load();
      if (input.item === 'configured') {
        var name = state.mode === 'new_chat' ? DEFAULT_TITLE :
          (state.selected ? (state.nicknames[state.selected.session_id] || state.selected.title) : DEFAULT_TITLE);
        var ready = configured(state);
        return { validUntilMs: now() + 60000, instances: [{ instanceId: 'opencode', properties: {
          name: { shortText: { text: name || DEFAULT_TITLE } },
          configured: { boolean: { value: ready }, shortText: { text: ready ? 'Configured' : 'Not configured' } }
        } }] };
      }
      requireConnection(state);
      var page = await chatRows(state, input.cursor);
      return {
        validUntilMs: now() + 900000,
        instances: page.sessions.map(function (session) {
          return { instanceId: session.session_id, properties: {
            name: { shortText: { text: session.nickname || session.title } },
            title: { shortText: { text: session.title } },
            url: { longText: { text: session.url } }
          } };
        })
      };
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

    function validReceipt(message, id, text) {
      return !!(message && message.id === id && message.sessionID === text.sessionID &&
        message.type === 'user' && message.payload && message.payload.text === text.text);
    }

    async function verifyDelivery(state, sessionId, messageId, text) {
      try {
        var direct = await api(state, sessionPath(sessionId) + '/message/' + encodeURIComponent(messageId));
        var directMessage = direct && direct.data;
        if (directMessage && directMessage.id === messageId && directMessage.type === 'user' && directMessage.text === text) return true;
      } catch (_) {}
      try {
        var inbox = await api(state, sessionPath(sessionId) + '/inbox');
        var messages = inbox && inbox.data;
        if (Array.isArray(messages)) {
          for (var i = 0; i < messages.length; i += 1) {
            if (validReceipt(messages[i], messageId, { sessionID: sessionId, text: text })) return true;
          }
        }
      } catch (_) {}
      return false;
    }

    async function action(input) {
      if (!input || typeof input !== 'object' || input.action !== 'send_to_agent' ||
          !input.args || typeof input.args !== 'object' || Array.isArray(input.args)) {
        throw makeError('INVALID_ARGS', 'Invalid action request.');
      }
      var args = input.args;
      Object.keys(args).forEach(function (key) {
        if (key !== 'message' && key !== 'chat_id') throw makeError('INVALID_ARGS', 'Unexpected action argument.');
      });
      var message = args.message;
      if (typeof message !== 'string' || !message.trim() || message.length > 16000 ||
          (args.chat_id !== undefined && args.chat_id !== null && typeof args.chat_id !== 'string')) {
        throw makeError('INVALID_ARGS', 'Message or chat_id is invalid.');
      }
      var state = await load();
      requireConnection(state);
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
      try {
        receipt = await api(state, sessionPath(session.id) + '/prompt', 'POST', {
          id: messageID, text: message, delivery: 'queue'
        });
      } catch (sendError) {
        if (sendError && (sendError.code === 'PERMISSION_DENIED' || sendError.code === 'AUTH_REQUIRED' || sendError.code === 'RATE_LIMITED')) throw sendError;
        if (sendError && sendError.httpStatus && sendError.httpStatus < 500 && sendError.httpStatus !== 409) throw sendError;
        if (sendError && sendError.httpStatus === 409) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode reported a conflict; inspect desktop before retrying.');
        if (!await verifyDelivery(state, session.id, messageID, message)) {
          throw makeError('PLUGIN_UNAVAILABLE', 'Delivery uncertain. Inspect OpenCode desktop before retrying.');
        }
        deliveryVerified = true;
        receipt = null;
      }
      var result = receipt && receipt.data;
      if (receipt && validReceipt(result, messageID, { sessionID: session.id, text: message })) {
        deliveryVerified = true;
      }
      if (!deliveryVerified) {
        if (!await verifyDelivery(state, session.id, messageID, message)) {
          throw makeError('PLUGIN_UNAVAILABLE', 'Delivery uncertain. Inspect OpenCode desktop before retrying.');
        }
        deliveryVerified = true;
      }
      return { text: 'Message submitted to OpenCode: ' + titleOf(session), refreshed: ['agent/chats'] };
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
