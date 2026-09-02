// ==UserScript==
// @name         X Profile Keyword Blocker
// @namespace    https://github.com/gregzuro/x-hider
// @version      1.5.0
// @description  Hide posts on x.com from accounts whose profile matches your keywords - bio, display name, location, link or emoji.
// @author       Greg Zuro
// @license      MIT
// @homepageURL  https://github.com/gregzuro/x-hider
// @supportURL   https://github.com/gregzuro/x-hider/issues
// @downloadURL  https://raw.githubusercontent.com/gregzuro/x-hider/main/x-profile-keyword-blocker.user.js
// @updateURL    https://raw.githubusercontent.com/gregzuro/x-hider/main/x-profile-keyword-blocker.user.js
// @match        https://x.com/*
// @match        https://twitter.com/*
// @match        https://mobile.x.com/*
// @match        https://mobile.twitter.com/*
// @match        https://pro.x.com/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @grant        unsafeWindow
// @inject-into  auto
// @noframes
// ==/UserScript==

/*
 * How it works
 * ------------
 * X never puts an author's bio in the timeline DOM, so keyword matching cannot
 * be done by reading the page alone. This script hooks window.fetch and
 * XMLHttpRequest, scans X's own GraphQL responses (which do carry every
 * author's profile object), and builds a screen_name -> profile map. A
 * MutationObserver then hides or collapses any rendered post whose author
 * profile matches your keywords. Display names are additionally read straight
 * off the page, since those are rendered.
 *
 * The hook wants to run in the page's own JS world. x.com's CSP sends a
 * script-src nonce, which makes the browser ignore the 'unsafe-inline' next to
 * it, so getting there is browser-specific and can fail. On Chrome,
 * Violentmonkey needs "Allow user scripts" enabled at chrome://extensions
 * (Developer mode before Chrome 138). On Firefox its CSP workaround hangs off
 * the document's response headers, which a cached load - soft reload, reopened
 * tab - never delivers again. Tampermonkey depends on neither.
 *
 * So the script does not insist. "@inject-into auto" lets the manager put it
 * wherever it can, and the script works out which world it landed in:
 *
 *   page     everything works, as described above.
 *   xray     Firefox content world. unsafeWindow is a waived wrapper on the
 *            real page window and DOM nodes expose .wrappedJSObject, so both
 *            fetch and React's fibers are still reachable - anything the page
 *            calls back into just has to go through exportFunction first.
 *   isolated Chrome content world. No route to page data at all, so only
 *            profiles already in the local cache can still be matched.
 *            Diagnostics and the 12s self-check say so rather than failing
 *            quietly.
 *
 * Menu commands (Violentmonkey / Tampermonkey toolbar icon):
 *   settings, diagnostics, list emoji in known profiles, clear profile cache
 *
 * Console helpers: xpkbSettings() xpkbDiag() xpkbWhy() xpkbEmojiScan()
 *                  xpkbEmojiNames() xpkbSample()
 *
 * Data: profiles seen are cached locally via GM storage (2500 entries max) so
 * filtering works immediately on reload. Nothing is sent anywhere. The optional
 * "fetch profiles not seen in the feed" setting is off by default; when on, it
 * replays x.com's own profile endpoint using credentials already in the page.
 */

(function () {
  'use strict';

  var W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
  var VERSION = (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || 'dev';

  /* ------------------------------------------------------------------ *
   * which JS world did we land in?
   *
   * Firefox's content world still reaches the page through Xray waivers, so
   * it is a usable fallback when injection into the page itself is refused.
   * Chrome's content world is not: unsafeWindow is just window there.
   * ------------------------------------------------------------------ */
  // A separate window object plus Firefox's exportFunction is the signature of
  // running outside the page's compartment with a way back in. Deliberately not
  // probing the DOM for it: this runs at document-start, and a missing
  // documentElement would silently disable the fallback for the whole session.
  var xrayOK = false;
  try {
    xrayOK = W !== window && typeof exportFunction === 'function';
  } catch (e) { xrayOK = false; }

  // Firefox refuses to let page code call a content-world function unless it
  // has been exported. Identity everywhere else, so one code path covers both.
  function toPage(fn) {
    if (!xrayOK) return fn;
    try { return exportFunction(fn, W); } catch (e) { return fn; }
  }

  // The waived view of a DOM node, which is where React hangs its __reactFiber$
  // expando. Same node when there is no wrapper in the way.
  function waive(node) {
    if (!xrayOK || !node) return node;
    try { return node.wrappedJSObject || node; } catch (e) { return node; }
  }

  // A value handed back to page code has to be cloned across the compartment
  // boundary, or the page gets an object it is not allowed to touch.
  function toPageValue(v) {
    if (!xrayOK) return v;
    try { return cloneInto(v, W); } catch (e) { return undefined; }
  }

  function noop() {}

  /* ------------------------------------------------------------------ *
   * storage shim (works without GM_* if a manager is stingy with grants)
   * ------------------------------------------------------------------ */
  var store = {
    get: function (key, fallback) {
      try {
        if (typeof GM_getValue === 'function') return GM_getValue(key, fallback);
        var raw = localStorage.getItem('xpkb:' + key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch (e) { return fallback; }
    },
    set: function (key, value) {
      try {
        if (typeof GM_setValue === 'function') { GM_setValue(key, value); return; }
        localStorage.setItem('xpkb:' + key, JSON.stringify(value));
      } catch (e) { /* quota, private mode, whatever */ }
    }
  };

  function addStyle(css) {
    if (typeof GM_addStyle === 'function') { GM_addStyle(css); return; }
    var el = document.createElement('style');
    el.textContent = css;
    (document.head || document.documentElement).appendChild(el);
  }

  /* ------------------------------------------------------------------ *
   * config
   * ------------------------------------------------------------------ */
  var DEFAULTS = {
    keywords: [],
    matchMode: 'substring',        // substring | word | regex
    caseSensitive: false,
    fields: {
      bio: true,
      name: false,
      handle: false,
      location: false,
      links: false,
      professional: false
    },
    v: 1,                          // schema version, for future migrations
    action: 'collapse',            // collapse | hide
    checkRetweeter: true,
    checkQuoted: false,
    filterUserCells: true,
    lookupUnknown: false,   // off by default: it issues requests as the user
    normalizeEmoji: true,
    debug: false
  };

  /* ------------------------------------------------------------------ *
   * settings persistence
   *
   * Two independent copies, because they fail in different ways.
   *
   * GM storage is the primary. It survives an in-place update, but it is keyed
   * on the script's identity - @name and @namespace - so changing either of
   * those, or removing and reinstalling the script, orphans everything under
   * the old key. NEVER change @name or @namespace.
   *
   * The mirror is x.com's own localStorage, which knows nothing about the
   * script and so survives all of that. It is only read when GM storage comes
   * back empty, which means either a genuinely fresh install or an orphaning.
   * Either way the mirror is the better answer than silently reverting to
   * defaults and quietly stopping filtering.
   *
   * normalizeConfig() is what makes a config from an older version safe to
   * load: it starts from DEFAULTS and overlays only the keys it recognises, at
   * the type it expects, so keys added in a later version get their default and
   * anything stale is dropped.
   * ------------------------------------------------------------------ */
  var CONFIG_KEY = 'config';
  var CONFIG_MIRROR = 'xpkb:config';
  var SCHEMA = 1;

  function readMirror() {
    try {
      var raw = localStorage.getItem(CONFIG_MIRROR);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function writeMirror(value) {
    try { localStorage.setItem(CONFIG_MIRROR, JSON.stringify(value)); } catch (e) { /* ignore */ }
  }

  function loadConfig() {
    var primary = null;
    try {
      if (typeof GM_getValue === 'function') primary = GM_getValue(CONFIG_KEY, null);
    } catch (e) { /* ignore */ }

    if (primary && typeof primary === 'object') {
      var current = normalizeConfig(primary);
      // Refresh the mirror on every load, not just on save. Someone who never
      // reopens the settings panel still needs a copy sitting outside GM
      // storage before the reinstall that orphans it, not after.
      writeMirror(current);
      return current;
    }

    var mirror = readMirror();
    if (mirror && typeof mirror === 'object') {
      var recovered = normalizeConfig(mirror);
      // Put it back where it belongs so the next load is a plain read.
      try { if (typeof GM_setValue === 'function') GM_setValue(CONFIG_KEY, recovered); } catch (e) { /* ignore */ }
      console.info('[xpkb] settings restored from the x.com-side backup copy');
      return recovered;
    }
    return normalizeConfig(null);
  }

  function saveConfig() {
    cfg.v = SCHEMA;
    store.set(CONFIG_KEY, cfg);
    writeMirror(cfg);
  }

  function normalizeConfig(raw) {
    var out = JSON.parse(JSON.stringify(DEFAULTS));
    if (!raw || typeof raw !== 'object') return out;
    if (Array.isArray(raw.keywords)) out.keywords = raw.keywords.slice();
    if (typeof raw.matchMode === 'string') out.matchMode = raw.matchMode;
    ['caseSensitive', 'checkRetweeter', 'checkQuoted', 'filterUserCells', 'lookupUnknown',
      'normalizeEmoji', 'debug']
      .forEach(function (k) { if (typeof raw[k] === 'boolean') out[k] = raw[k]; });
    if (raw.action === 'hide' || raw.action === 'collapse') out.action = raw.action;
    // 0 means "written before the schema was versioned", which is still valid.
    out.v = typeof raw.v === 'number' ? raw.v : 0;
    if (raw.fields && typeof raw.fields === 'object') {
      Object.keys(out.fields).forEach(function (k) {
        if (typeof raw.fields[k] === 'boolean') out.fields[k] = raw.fields[k];
      });
    }
    return out;
  }

  var cfg = loadConfig();

  function log() {
    if (!cfg.debug) return;
    var args = ['[xpkb]'].concat(Array.prototype.slice.call(arguments));
    console.log.apply(console, args);
  }

  var stats = {
    payloads: 0,      // API responses that contained profile data
    harvested: 0,     // profiles learned this session
    fiber: 0,         // profiles recovered from React props
    articles: 0,      // posts evaluated
    unknown: 0,       // posts whose author profile is still unknown
    lookups: 0
  };

  /* ------------------------------------------------------------------ *
   * emoji
   *
   * Emoji cannot be matched as plain text: the same symbol appears with and
   * without a variation selector (U+271D vs U+271D U+FE0F both render as a
   * latin cross) and with skin-tone modifiers, so a pasted keyword often fails
   * to match a visually identical bio. Both sides are normalized before
   * matching, and keywords can name a symbol instead of containing it.
   * ------------------------------------------------------------------ */
  var EMOJI_NAMES = {
    // christian
    'latin cross': '✝',
    'shadowed white latin cross': '✞',
    'outlined latin cross': '✟',
    'maltese cross': '✠',
    'orthodox cross': '☦',
    'chi rho': '☧',
    'cross of lorraine': '☨',
    'cross of jerusalem': '☩',
    'church': '⛪',
    'dove': '\u{1F54A}',
    'fish': '\u{1F41F}',
    'folded hands': '\u{1F64F}',
    'praying hands': '\u{1F64F}',
    'open book': '\u{1F4D6}',
    'angel': '\u{1F607}',
    'baby angel': '\u{1F47C}',
    // other faiths
    'star of david': '✡',
    'menorah': '\u{1F54E}',
    'synagogue': '\u{1F54D}',
    'star and crescent': '☪',
    'mosque': '\u{1F54C}',
    'kaaba': '\u{1F54B}',
    'om': '\u{1F549}',
    'hindu temple': '\u{1F6D5}',
    'wheel of dharma': '☸',
    'khanda': '☬',
    'yin yang': '☯',
    'place of worship': '\u{1F6D0}',
    'prayer beads': '\u{1F4FF}',
    'dotted six pointed star': '\u{1F52F}',
    // politics
    'peace symbol': '☮',
    'hammer and sickle': '☭',
    'triangular flag': '\u{1F6A9}',
    'white flag': '\u{1F3F3}',
    'black flag': '\u{1F3F4}',
    'rainbow': '\u{1F308}',
    'rainbow flag': '\u{1F3F3}️‍\u{1F308}',
    'transgender symbol': '⚧',
    'transgender flag': '\u{1F3F3}️‍⚧️',
    'eagle': '\u{1F985}',
    'sunflower': '\u{1F33B}',
    'watermelon': '\u{1F349}',
    'raised fist': '✊',
    'red heart': '❤',
    'blue heart': '\u{1F499}',
    'yellow heart': '\u{1F49B}',
    // crypto and money
    'bitcoin sign': '₿',
    'coin': '\u{1FA99}',
    'rocket': '\u{1F680}',
    'gem stone': '\u{1F48E}',
    'chart increasing': '\u{1F4C8}',
    'link': '\u{1F517}',
    'money bag': '\u{1F4B0}',
    'money with wings': '\u{1F4B8}',
    // misc bio furniture
    'fire': '\u{1F525}',
    'crown': '\u{1F451}',
    'brain': '\u{1F9E0}',
    'flexed biceps': '\u{1F4AA}',
    'graduation cap': '\u{1F393}',
    'microphone': '\u{1F3A4}',
    'writing hand': '✍',
    'books': '\u{1F4DA}',
    'syringe': '\u{1F489}',
    'dna': '\u{1F9EC}',
    'sparkles': '✨',
    'star': '⭐',
    'check mark': '✅',
    'globe': '\u{1F30D}'
  };

  var EMOJI_GROUPS = {
    'cross': ['✝', '✞', '✟', '✠', '☦', '☧', '☨', '☩'],
    'christian': ['✝', '✞', '✟', '☦', '☧', '⛪', '\u{1F54A}',
                  '\u{1F41F}', '\u{1F64F}', '\u{1F4D6}'],
    'religion': ['✝', '✞', '✟', '✠', '☦', '☧', '☨', '☩',
                 '✡', '☪', '☬', '☯', '☸', '\u{1F549}', '\u{1F54E}',
                 '\u{1F52F}', '\u{1F6D0}', '⛪', '\u{1F54C}', '\u{1F54D}', '\u{1F54B}',
                 '\u{1F6D5}', '\u{1F4FF}'],
    'crypto': ['₿', '\u{1FA99}', '\u{1F680}', '\u{1F48E}', '\u{1F4C8}', '\u{1F517}'],
    'pride': ['\u{1F308}', '\u{1F3F3}️‍\u{1F308}', '⚧',
              '\u{1F3F3}️‍⚧️']
  };

  // Matches one emoji cluster: a flag pair, or a pictograph with its modifiers
  // and any ZWJ-joined continuation. U+20BF is a currency symbol, not So, so it
  // is listed on its own.
  var EMOJI_CLUSTER = /[\u{1F1E6}-\u{1F1FF}]{2}|₿|(?:\p{Extended_Pictographic}|\p{So})(?:[\u{1F3FB}-\u{1F3FF}]|️)*(?:‍(?:\p{Extended_Pictographic}|\p{So})(?:[\u{1F3FB}-\u{1F3FF}]|️)*)*/gu;

  function normText(str) {
    if (!cfg.normalizeEmoji) return str;
    return String(str)
      .replace(/[︎️]/g, '')                 // variation selectors
      .replace(/[\u{1F3FB}-\u{1F3FF}]/gu, '');        // skin tone modifiers
  }

  function emojiName(ch) {
    var norm = normText(ch);
    for (var name in EMOJI_NAMES) {
      if (normText(EMOJI_NAMES[name]) === norm) return name;
    }
    return '';
  }

  function codePointsOf(str) {
    var out = [];
    for (var i = 0; i < str.length;) {
      var cp = str.codePointAt(i);
      out.push('U+' + cp.toString(16).toUpperCase());
      i += cp > 0xFFFF ? 2 : 1;
    }
    return out.join(' ');
  }

  /* ------------------------------------------------------------------ *
   * matchers
   * ------------------------------------------------------------------ */
  var matchers = [];
  var fieldsInUse = {};

  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  var FIELD_ALIAS = {
    'bio': 'bio', 'desc': 'bio', 'description': 'bio',
    'name': 'name', 'display name': 'name', 'displayname': 'name',
    'handle': 'handle', 'username': 'handle', 'user': 'handle',
    'location': 'location', 'loc': 'location',
    'link': 'links', 'links': 'links', 'url': 'links', 'website': 'links',
    'professional': 'professional', 'pro': 'professional', 'category': 'professional',
    'any': '*', 'all': '*'
  };

  // "name:🇺🇸" restricts one keyword to one field, so enabling a field globally
  // does not widen every other keyword along with it.
  function splitFieldPrefix(token) {
    var m = /^([a-z ]+)\s*:\s*(.+)$/i.exec(token);
    if (!m) return { field: null, rest: token };
    var key = m[1].trim().toLowerCase().replace(/\s+/g, ' ');
    var field = FIELD_ALIAS[key];
    if (!field) return { field: null, rest: token };
    return { field: field, rest: m[2].trim() };
  }

  // Returns an array of literal strings for an emoji keyword, or null if the
  // token is ordinary text. An empty array means "named something unknown".
  function resolveEmojiToken(token) {
    var named = /^(?:emoji\s*:\s*(.+)|:([a-z0-9_+\- ]+):)$/i.exec(token);
    if (named) {
      var name = (named[1] || named[2]).trim().toLowerCase().replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ');
      if (EMOJI_GROUPS[name]) return EMOJI_GROUPS[name].slice();
      if (EMOJI_NAMES[name]) return [EMOJI_NAMES[name]];
      console.warn('[xpkb] unknown emoji name "' + name + '". Run xpkbEmojiNames() for the list, ' +
        'or use U+XXXX, or paste the character itself.');
      return [];
    }
    var flag = /^flag\s*:\s*([a-z]{2})$/i.exec(token);
    if (flag) {
      var cc = flag[1].toUpperCase();
      return [String.fromCodePoint(0x1F1E6 + cc.charCodeAt(0) - 65, 0x1F1E6 + cc.charCodeAt(1) - 65)];
    }
    if (/^u\+[0-9a-f]{1,6}(\s+u\+[0-9a-f]{1,6})*$/i.test(token)) {
      var cps = token.match(/u\+([0-9a-f]{1,6})/gi).map(function (t) {
        return parseInt(t.slice(2), 16);
      });
      try { return [String.fromCodePoint.apply(String, cps)]; }
      catch (e) { console.warn('[xpkb] bad code point in:', token); return []; }
    }
    return null;
  }

  function buildMatchers() {
    matchers = [];
    cfg.keywords.forEach(function (raw) {
      var full = String(raw).trim();
      if (!full) return;
      var scoped = splitFieldPrefix(full);
      var token = scoped.rest;

      var literals = resolveEmojiToken(token);
      if (literals && !literals.length) return;      // named symbol we could not resolve

      var flags = cfg.caseSensitive ? '' : 'i';
      var re;
      try {
        if (literals) {
          // Symbols always match as a substring: a word boundary next to an
          // emoji is meaningless, and "✝Christian" must still match.
          re = new RegExp(literals.map(function (lit) {
            return escapeRe(normText(lit));
          }).join('|'), flags + 'u');
        } else if (cfg.matchMode === 'regex') {
          // Regex mode is the user being explicit. Leave "#" alone there.
          re = new RegExp(normText(token), flags);
        } else {
          // Bios are written both ways: "Christian" and "#Christian". A bare
          // keyword already catches the hashtag form, because "#" is not a word
          // character and substring matching does not care. The reverse needed
          // help: a keyword copied straight out of a bio, hash and all, would
          // only ever find the hashtag. So a leading "#" on a keyword is
          // treated as optional and both forms match either way.
          var hashed = /^#+(.+)$/.exec(token);          // "#" alone stays literal
          var body = hashed ? hashed[1] : token;
          var lead = hashed ? '#*' : '';
          if (cfg.matchMode === 'word' && /[\p{L}\p{N}]/u.test(body)) {
            re = new RegExp('(^|[^\\p{L}\\p{N}_])' + lead + escapeRe(normText(body)) +
              '($|[^\\p{L}\\p{N}_])', flags + 'u');
          } else {
            re = new RegExp(lead + escapeRe(normText(body)), flags + 'u');
          }
        }
      } catch (e) {
        console.warn('[xpkb] bad keyword pattern, skipped:', token, e.message);
        return;
      }
      matchers.push({ raw: full, re: re, field: scoped.field, chars: literals || null });
    });

    // A field is searched if it is enabled globally or named by a scoped keyword.
    fieldsInUse = {};
    Object.keys(cfg.fields).forEach(function (k) { fieldsInUse[k] = cfg.fields[k]; });
    matchers.forEach(function (m) {
      if (m.field === '*') Object.keys(fieldsInUse).forEach(function (k) { fieldsInUse[k] = true; });
      else if (m.field) fieldsInUse[m.field] = true;
    });
  }
  buildMatchers();

  /* ------------------------------------------------------------------ *
   * profile store (+ persistent cache so hides land instantly on reload)
   * ------------------------------------------------------------------ */
  var users = new Map();          // handleLower -> {handle,name,bio,location,links,prof}
  var shapeSamples = [];          // raw field names of the first few User objects seen
  var CACHE_MAX = 2500;
  var cacheDirty = false;

  (function loadCache() {
    var raw = store.get('cache', null);
    if (!raw || typeof raw !== 'object') return;
    Object.keys(raw).forEach(function (k) {
      var v = raw[k];
      if (v && typeof v === 'object') users.set(k, v);
    });
    log('cache loaded', users.size);
  })();

  var saveTimer = null;
  function scheduleCacheSave() {
    cacheDirty = true;
    if (saveTimer) return;
    saveTimer = setTimeout(function () {
      saveTimer = null;
      if (!cacheDirty) return;
      cacheDirty = false;
      var entries = Array.from(users.entries());
      if (entries.length > CACHE_MAX) {
        entries.sort(function (a, b) { return (b[1].t || 0) - (a[1].t || 0); });
        entries = entries.slice(0, CACHE_MAX);
      }
      var obj = {};
      entries.forEach(function (e) { obj[e[0]] = e[1]; });
      store.set('cache', obj);
      log('cache saved', entries.length);
    }, 8000);
  }

  function pick() {
    for (var i = 0; i < arguments.length; i++) {
      if (typeof arguments[i] === 'string' && arguments[i].length) return arguments[i];
    }
    return '';
  }

  function recordUser(node, screenName) {
    var legacy = node.legacy || {};
    var core = node.core || {};
    var key = String(screenName).toLowerCase();

    var bio = pick(
      legacy.description,
      node.description,
      node.profile_bio && node.profile_bio.description,
      core.description
    );
    var name = pick(core.name, legacy.name, node.name);
    var location = pick(
      node.location && node.location.location,
      legacy.location,
      core.location
    );

    var links = [];
    function collectUrls(entities) {
      if (!entities || typeof entities !== 'object') return;
      ['url', 'description'].forEach(function (slot) {
        var bucket = entities[slot];
        if (!bucket || !Array.isArray(bucket.urls)) return;
        bucket.urls.forEach(function (u) {
          var v = pick(u.expanded_url, u.display_url, u.url);
          if (v) links.push(v);
        });
      });
    }
    collectUrls(legacy.entities);
    collectUrls(node.entities);
    if (node.website && typeof node.website === 'object') {
      var w = pick(node.website.expanded_url, node.website.url, node.website.display_url);
      if (w) links.push(w);
    }

    var prof = '';
    var professional = node.professional || legacy.professional;
    if (professional && typeof professional === 'object') {
      var bits = [];
      if (typeof professional.professional_type === 'string') bits.push(professional.professional_type);
      if (Array.isArray(professional.category)) {
        professional.category.forEach(function (c) { if (c && c.name) bits.push(c.name); });
      }
      prof = bits.join(' ');
    }

    if (shapeSamples.length < 4 && node.__typename === 'User') {
      try {
        shapeSamples.push({
          handle: screenName,
          bioChars: bio.length,
          top: Object.keys(node).join(','),
          legacy: Object.keys(legacy).join(','),
          core: Object.keys(core).join(',')
        });
      } catch (e) { /* ignore */ }
    }

    var prev = users.get(key);
    var next = {
      h: pick(screenName, prev && prev.h),
      n: pick(name, prev && prev.n),
      b: pick(bio, prev && prev.b),
      l: pick(location, prev && prev.l),
      u: links.length ? links.join(' ') : ((prev && prev.u) || ''),
      p: pick(prof, prev && prev.p),
      t: Date.now()
    };

    var isNew = !prev || prev.b !== next.b || prev.n !== next.n ||
      prev.l !== next.l || prev.u !== next.u || prev.p !== next.p;

    users.set(key, next);
    if (isNew) {
      stats.harvested++;
      scheduleCacheSave();
      scheduleScan();
    }
    return isNew;
  }

  /* ------------------------------------------------------------------ *
   * response harvesting
   * ------------------------------------------------------------------ */
  function looksLikeUser(node) {
    if (node.__typename === 'User') return true;
    if (node.legacy && typeof node.legacy.description === 'string') return true;
    if (node.profile_bio && typeof node.profile_bio.description === 'string') return true;
    if (typeof node.description === 'string' && typeof node.screen_name === 'string') return true;
    return false;
  }

  function harvest(node, depth) {
    if (!node || typeof node !== 'object' || depth > 32) return;
    if (Array.isArray(node)) {
      for (var i = 0; i < node.length; i++) harvest(node[i], depth + 1);
      return;
    }
    var sn = (node.core && node.core.screen_name) ||
      (node.legacy && node.legacy.screen_name) ||
      node.screen_name;
    if (typeof sn === 'string' && sn && looksLikeUser(node)) {
      try { recordUser(node, sn); } catch (e) { log('record failed', e); }
    }
    for (var k in node) {
      if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
      var v = node[k];
      if (v && typeof v === 'object') harvest(v, depth + 1);
    }
  }

  function scanPayload(text) {
    if (typeof text !== 'string' || text.length < 32) return;
    if (text.indexOf('"screen_name"') === -1) return;   // cheap prefilter
    var data;
    try { data = JSON.parse(text); } catch (e) { return; }
    stats.payloads++;
    harvest(data, 0);
  }

  function isApiUrl(url) {
    if (typeof url !== 'string') return false;
    return url.indexOf('/i/api/graphql/') !== -1 ||
      url.indexOf('/i/api/2/') !== -1 ||
      url.indexOf('/i/api/1.1/') !== -1 ||
      url.indexOf('/graphql/') !== -1;
  }

  /* ------------------------------------------------------------------ *
   * network hooks
   * ------------------------------------------------------------------ */
  var apiCreds = { headers: null, userByScreenName: null };

  function rememberHeaders(headers) {
    if (!headers) return;
    var out = apiCreds.headers ? Object.assign({}, apiCreds.headers) : {};
    var touched = false;
    function put(k, v) {
      if (typeof v !== 'string' || !v) return;
      k = k.toLowerCase();
      if (k === 'authorization' || k === 'x-csrf-token' || k.indexOf('x-twitter-') === 0) {
        out[k] = v; touched = true;
      }
    }
    try {
      if (typeof headers.forEach === 'function' && !Array.isArray(headers)) {
        // Headers, including a page-world one seen through an Xray wrapper,
        // which would fail an instanceof against our own Headers.
        headers.forEach(function (v, k) { put(k, v); });
      } else if (Array.isArray(headers)) {
        headers.forEach(function (pair) { put(pair[0], pair[1]); });
      } else if (typeof headers === 'object') {
        Object.keys(headers).forEach(function (k) { put(k, headers[k]); });
      }
    } catch (e) { /* ignore */ }
    if (touched) apiCreds.headers = out;
  }

  function rememberEndpoint(url) {
    if (typeof url !== 'string') return;
    if (url.indexOf('UserByScreenName') === -1) return;
    apiCreds.userByScreenName = url;
  }

  // Every function the page will end up calling - the replacement itself, and
  // each promise/event callback handed back to page objects - goes through
  // toPage(). In the page world that is a no-op; in Firefox's content world it
  // is what makes the hook legal at all.
  var origFetch = W.fetch;
  var fetchHooked = false;
  if (typeof origFetch === 'function') {
    try {
      W.fetch = toPage(function (input, init) {
        var url = '';
        try {
          url = typeof input === 'string' ? input : (input && input.url) || '';
          if (init && init.headers) rememberHeaders(init.headers);
          else if (input && input.headers) rememberHeaders(input.headers);
          rememberEndpoint(url);
        } catch (e) { /* ignore */ }

        var result = origFetch.apply(this || W, arguments);
        try {
          if (isApiUrl(url) && result && typeof result.then === 'function') {
            result.then(toPage(function (res) {
              try {
                if (!res || typeof res.clone !== 'function') return;
                res.clone().text().then(toPage(scanPayload)).catch(toPage(noop));
              } catch (e) { /* ignore */ }
            })).catch(toPage(noop));
          }
        } catch (e) { /* ignore */ }
        return result;
      });
      fetchHooked = true;
    } catch (e) { log('fetch hook refused', e && e.message); }
  }

  var xhrHooked = false;
  try {
    var XHR = W.XMLHttpRequest;
    if (XHR && XHR.prototype) {
      var origOpen = XHR.prototype.open;
      var origSend = XHR.prototype.send;
      var origSetHeader = XHR.prototype.setRequestHeader;

      XHR.prototype.open = toPage(function (method, url) {
        try { this.__xpkbUrl = String(url); rememberEndpoint(String(url)); } catch (e) { /* ignore */ }
        return origOpen.apply(this, arguments);
      });
      XHR.prototype.setRequestHeader = toPage(function (k, v) {
        try {
          var h = {}; h[k] = v; rememberHeaders(h);
        } catch (e) { /* ignore */ }
        return origSetHeader.apply(this, arguments);
      });
      XHR.prototype.send = toPage(function () {
        try {
          if (isApiUrl(this.__xpkbUrl || '')) {
            this.addEventListener('load', toPage(function () {
              try {
                if (this.responseType === '' || this.responseType === 'text') scanPayload(this.responseText);
                else if (this.responseType === 'json' && this.response) scanPayload(JSON.stringify(this.response));
              } catch (e) { /* ignore */ }
            }));
          }
        } catch (e) { /* ignore */ }
        return origSend.apply(this, arguments);
      });
      xhrHooked = true;
    }
  } catch (e) { log('xhr hook refused', e && e.message); }

  /* ------------------------------------------------------------------ *
   * best-effort profile lookup for handles never seen in a payload
   * (uses the endpoint + auth headers learned from the page's own traffic)
   * ------------------------------------------------------------------ */
  var lookupQueue = [];
  var lookupSeen = new Set();
  var lookupBusy = false;

  function queueLookup(handle) {
    if (!cfg.lookupUnknown) return;
    if (!apiCreds.userByScreenName || !apiCreds.headers) return;
    if (lookupSeen.has(handle) || lookupQueue.indexOf(handle) !== -1) return;
    if (lookupQueue.length > 40) return;
    lookupQueue.push(handle);
    drainLookups();
  }

  function drainLookups() {
    if (lookupBusy || !lookupQueue.length) return;
    lookupBusy = true;
    var handle = lookupQueue.shift();
    lookupSeen.add(handle);
    stats.lookups++;
    var done = function () {
      lookupBusy = false;
      if (lookupQueue.length) setTimeout(drainLookups, 600);
    };
    var url;
    try {
      url = new URL(apiCreds.userByScreenName, location.origin);
      url.searchParams.set('variables', JSON.stringify({
        screen_name: handle,
        withSafetyModeUserFields: true
      }));
    } catch (e) { done(); return; }

    var headers = Object.assign({}, apiCreds.headers, { 'content-type': 'application/json' });
    var f = origFetch || W.fetch;
    try {
      f.call(W, url.toString(), { credentials: 'include', headers: headers })
        .then(toPage(function (r) { return r.text(); }))
        .then(toPage(function (t) { scanPayload(t); log('looked up', handle); }))
        .catch(toPage(function (e) { log('lookup failed', handle, e && e.message); }))
        .then(toPage(done), toPage(done));
    } catch (e) { done(); }
  }

  /* ------------------------------------------------------------------ *
   * React props fallback
   *
   * If the script loaded after some timeline data already arrived (soft
   * navigation, script updated mid-session), the network hook missed it. The
   * data is still hanging off the rendered nodes as React props, so pull it
   * from there.
   *
   * On Firefox this is also the primary source rather than a backstop: when
   * injection into the page world was refused, waive() still reaches React's
   * expandos even though the script is in the content world. Chrome's content
   * world has no equivalent, so there this really is only a backstop.
   * ------------------------------------------------------------------ */
  function reactKey(node) {
    if (!node) return null;
    try {
      for (var k in node) {
        if (k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0) return k;
      }
    } catch (e) { /* wrapper can refuse enumeration */ }
    return null;
  }

  var pageWorld = false;
  function detectPageWorld() {
    if (pageWorld) return true;
    var probes = document.querySelectorAll('article, #react-root > div, [data-testid="primaryColumn"], #react-root');
    for (var i = 0; i < probes.length && i < 12; i++) {
      if (reactKey(probes[i])) { pageWorld = true; return true; }
    }
    return false;
  }

  // 'page' | 'xray' | 'isolated'. Only settles once the timeline has rendered,
  // since the page-world probe needs a React node to look at.
  function worldName() {
    if (detectPageWorld()) return 'page';
    return xrayOK ? 'xray' : 'isolated';
  }

  function fiberReachable() { return detectPageWorld() || xrayOK; }

  var FIBER_SKIP = {
    stateNode: 1, 'return': 1, child: 1, sibling: 1, alternate: 1,
    _owner: 1, _store: 1, ref: 1, dependencies: 1, updateQueue: 1,
    memoizedState: 1, pendingProps: 1, _debugOwner: 1
  };

  function walkProps(node, depth, seen, budget) {
    if (!node || typeof node !== 'object' || depth > 7) return;
    if (budget.n-- < 0) return;
    // Duck-typed rather than `instanceof Node`, which is false for a page-world
    // node seen from the content world.
    try {
      if (typeof node.nodeType === 'number' && typeof node.nodeName === 'string') return;
    } catch (e) { return; }
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (var i = 0; i < node.length && i < 200; i++) walkProps(node[i], depth + 1, seen, budget);
      return;
    }
    try {
      var sn = (node.core && node.core.screen_name) ||
        (node.legacy && node.legacy.screen_name) ||
        node.screen_name;
      if (typeof sn === 'string' && sn && looksLikeUser(node)) {
        if (recordUser(node, sn)) stats.fiber++;
      }
    } catch (e) { /* getters can throw */ }

    for (var k in node) {
      if (FIBER_SKIP[k]) continue;
      var v;
      try { v = node[k]; } catch (e) { continue; }
      if (v && typeof v === 'object') walkProps(v, depth + 1, seen, budget);
    }
  }

  function harvestFromFiber(article) {
    if (!fiberReachable()) return false;
    var el = waive(article);
    var key = reactKey(el);
    if (!key) return false;
    var before = users.size;
    var fiber;
    try { fiber = el[key]; } catch (e) { return false; }
    var seen = new WeakSet();
    // Property reads through an Xray waiver are not free, and in that world
    // this runs for every post rather than the occasional straggler.
    var budget = { n: pageWorld ? 8000 : 4000 };
    var hops = 0;
    while (fiber && hops++ < 25 && budget.n > 0) {
      if (fiber.memoizedProps) walkProps(fiber.memoizedProps, 0, seen, budget);
      fiber = fiber['return'];
    }
    return users.size !== before;
  }

  /* ------------------------------------------------------------------ *
   * DOM: handle extraction
   * ------------------------------------------------------------------ */
  var RESERVED = new Set([
    'i', 'home', 'explore', 'notifications', 'messages', 'settings', 'compose',
    'search', 'hashtag', 'intent', 'login', 'logout', 'signup', 'tos', 'privacy',
    'about', 'status', 'share', 'account', 'jobs', 'topics', 'lists', 'bookmarks',
    'communities', 'premium_sign_up', 'download'
  ]);

  function handleFromHref(href) {
    if (!href) return null;
    var m = /^(?:https?:\/\/(?:www\.|mobile\.|pro\.)?(?:x|twitter)\.com)?\/(@?[A-Za-z0-9_]{1,15})(?:[/?#]|$)/.exec(href);
    if (!m) return null;
    var h = m[1].replace(/^@/, '').toLowerCase();
    return RESERVED.has(h) ? null : h;
  }

  function firstHandleIn(root) {
    if (!root) return null;
    var links = root.querySelectorAll('a[href]');
    for (var i = 0; i < links.length; i++) {
      var h = handleFromHref(links[i].getAttribute('href'));
      if (h) return h;
    }
    return null;
  }

  // X renders emoji in display names as <img alt="✝️">, so textContent silently
  // drops exactly the characters we are looking for. Rebuild from the alt text.
  function richText(node) {
    var out = '';
    for (var i = 0; i < node.childNodes.length; i++) {
      var c = node.childNodes[i];
      if (c.nodeType === 3) out += c.nodeValue;
      else if (c.nodeType === 1) {
        if (c.tagName === 'IMG') out += c.getAttribute('alt') || '';
        else out += richText(c);
      }
    }
    return out;
  }

  // The display name is on the page, so it never needs the API.
  function domDisplayName(root) {
    var un = root.querySelector('[data-testid="User-Name"]');
    if (!un) return '';
    var link = un.querySelector('a[role="link"]') || un.querySelector('a');
    var text = richText(link || un);
    return text.split('@')[0].replace(/\s+/g, ' ').trim();
  }

  function authorOf(article) {
    var nameBlock = article.querySelector('[data-testid="User-Name"]');
    var h = firstHandleIn(nameBlock || article);
    if (h) return h;
    var text = (nameBlock && nameBlock.textContent) || '';
    var m = /@([A-Za-z0-9_]{1,15})/.exec(text);
    return m ? m[1].toLowerCase() : null;
  }

  function retweeterOf(article) {
    var ctx = article.querySelector('[data-testid="socialContext"]');
    if (!ctx) return null;
    var link = ctx.closest('a[href]') || ctx.querySelector('a[href]');
    return link ? handleFromHref(link.getAttribute('href')) : null;
  }

  function quotedOf(article) {
    var quote = article.querySelector('div[role="link"]');
    if (!quote) return null;
    var nameBlock = quote.querySelector('[data-testid="User-Name"]');
    return firstHandleIn(nameBlock || quote);
  }

  /* ------------------------------------------------------------------ *
   * evaluation
   * ------------------------------------------------------------------ */
  var FIELD_LABEL = {
    bio: 'bio', name: 'display name', handle: 'handle',
    location: 'location', links: 'link', professional: 'category'
  };

  function evaluate(handle, extra) {
    if (!handle) return { state: 'ok' };
    if (!matchers.length) return { state: 'ok' };
    var u = users.get(handle);
    var domName = (extra && extra.name) || '';
    if (!u && !domName) { queueLookup(handle); return { state: 'unknown' }; }
    u = u || {};

    var values = {
      bio: [u.b],
      name: [u.n, domName],
      handle: [u.h || handle],
      location: [u.l],
      links: [u.u],
      professional: [u.p]
    };

    var anyValue = false;
    for (var field in values) {
      if (!fieldsInUse[field]) continue;
      var vals = values[field];
      for (var i = 0; i < vals.length; i++) {
        if (!vals[i]) continue;
        if (cfg.fields[field]) anyValue = true;
        var hay = normText(vals[i]);
        for (var j = 0; j < matchers.length; j++) {
          var m = matchers[j];
          // Scoped keywords run only on their own field; unscoped ones run only
          // on the globally enabled fields.
          if (m.field ? (m.field !== '*' && m.field !== field) : !cfg.fields[field]) continue;
          m.re.lastIndex = 0;
          if (m.re.test(hay)) {
            return { state: 'match', handle: handle, keyword: m.raw, field: field };
          }
        }
      }
    }
    // Every globally searched field is blank: we have a record but no usable
    // text, so this is "unknown", not "clean". Otherwise a stub profile
    // silently whitelists an account forever.
    if (!anyValue) { queueLookup(handle); return { state: 'unknown' }; }
    return { state: 'ok' };
  }

  /* ------------------------------------------------------------------ *
   * hiding
   * ------------------------------------------------------------------ */
  var hiddenCount = 0;

  addStyle([
    '.xpkb-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;',
    'padding:11px 16px;font:13px/1.35 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;',
    'color:#71767b;border-bottom:1px solid rgba(128,128,128,.28)}',
    '.xpkb-bar b{color:#8b98a5;font-weight:600}',
    '.xpkb-bar button{all:unset;cursor:pointer;color:#1d9bf0;font-weight:600;padding:2px 6px;border-radius:4px}',
    '.xpkb-bar button:hover{background:rgba(29,155,240,.12)}',
    '.xpkb-overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:2147483646;',
    'display:flex;align-items:center;justify-content:center;',
    'font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}',
    '.xpkb-panel{background:#15181c;color:#e7e9ea;border:1px solid #2f3336;border-radius:14px;',
    'width:min(560px,92vw);max-height:88vh;overflow:auto;padding:20px 22px;box-shadow:0 12px 40px rgba(0,0,0,.5)}',
    '.xpkb-panel h2{margin:0 0 4px;font-size:18px}',
    '.xpkb-panel p.xpkb-sub{margin:0 0 16px;color:#8b98a5;font-size:12px}',
    '.xpkb-panel label{display:block;margin:12px 0 5px;font-weight:600;font-size:13px}',
    '.xpkb-panel textarea{width:100%;box-sizing:border-box;min-height:130px;background:#0b0e11;color:#e7e9ea;',
    'border:1px solid #2f3336;border-radius:8px;padding:9px;font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;resize:vertical}',
    '.xpkb-panel select{background:#0b0e11;color:#e7e9ea;border:1px solid #2f3336;border-radius:8px;padding:6px 8px}',
    '.xpkb-row{display:flex;flex-wrap:wrap;gap:12px 18px;margin-top:6px}',
    '.xpkb-row span{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:#c9cdd1}',
    '.xpkb-actions{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:20px}',
    '.xpkb-actions .xpkb-right{display:flex;gap:10px}',
    '.xpkb-actions button{cursor:pointer;border-radius:999px;border:1px solid #536471;background:transparent;',
    'color:#e7e9ea;padding:8px 16px;font-weight:600;font-size:13px}',
    '.xpkb-actions button.primary{background:#1d9bf0;border-color:#1d9bf0;color:#fff}',
    '.xpkb-stats{color:#8b98a5;font-size:12px}',
    '.xpkb-panel textarea.xpkb-backup{min-height:0;height:52px;font-size:11px;color:#8b98a5}',
    '.xpkb-note{margin:5px 0 0;color:#8b98a5;font-size:12px}',
    '.xpkb-note.bad{color:#f4212e}',
    '.xpkb-inline{all:unset;cursor:pointer;color:#1d9bf0;font-weight:600}'
  ].join(''));

  function cellOf(node) {
    return node.closest('div[data-testid="cellInnerDiv"]') || node.parentElement || node;
  }

  function conceal(article, hit) {
    var cell = cellOf(article);
    hiddenCount++;
    cell.setAttribute('data-xpkb-cell', cfg.action);
    cell.setAttribute('data-xpkb-handle', hit.handle);

    if (cfg.action === 'hide') {
      cell.style.setProperty('display', 'none', 'important');
      return;
    }

    article.style.setProperty('display', 'none', 'important');
    var bar = document.createElement('div');
    bar.className = 'xpkb-bar';
    bar.setAttribute('data-xpkb-bar', '1');

    var text = document.createElement('span');
    var strong = document.createElement('b');
    strong.textContent = '@' + hit.handle;
    text.appendChild(document.createTextNode('Hidden post from '));
    text.appendChild(strong);
    text.appendChild(document.createTextNode(
      ' - ' + (FIELD_LABEL[hit.field] || hit.field) + ' matches "' + hit.keyword + '"'
    ));
    bar.appendChild(text);

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Show';
    btn.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      restore(cell, true);
    });
    bar.appendChild(btn);

    cell.insertBefore(bar, cell.firstChild);
  }

  function restore(cell, allow) {
    var bar = cell.querySelector(':scope > [data-xpkb-bar]');
    if (bar) bar.remove();
    cell.style.removeProperty('display');
    cell.removeAttribute('data-xpkb-cell');
    cell.removeAttribute('data-xpkb-handle');
    var articles = cell.querySelectorAll('article');
    for (var i = 0; i < articles.length; i++) {
      articles[i].style.removeProperty('display');
      articles[i].dataset.xpkbState = 'ok';
      if (allow) articles[i].dataset.xpkbAllow = '1';
    }
    var userCells = cell.querySelectorAll('[data-testid="UserCell"]');
    for (var k = 0; k < userCells.length; k++) {
      delete userCells[k].dataset.xpkbState;
      if (allow) userCells[k].dataset.xpkbAllow = '1';
    }
    if (cell.matches && cell.matches('[data-testid="UserCell"]')) {
      delete cell.dataset.xpkbState;
      if (allow) cell.dataset.xpkbAllow = '1';
    }
  }

  /* ------------------------------------------------------------------ *
   * scanning
   * ------------------------------------------------------------------ */
  function handlesFor(article) {
    var list = [];
    var a = authorOf(article);
    if (a) list.push(a);
    if (cfg.checkRetweeter) { var r = retweeterOf(article); if (r && list.indexOf(r) === -1) list.push(r); }
    if (cfg.checkQuoted) { var q = quotedOf(article); if (q && list.indexOf(q) === -1) list.push(q); }
    return list;
  }

  function decide(handles, extra) {
    var unknown = false;
    for (var i = 0; i < handles.length; i++) {
      // The DOM name belongs to the author only, not the reposter.
      var v = evaluate(handles[i], i === 0 ? extra : null);
      if (v.state === 'match') return v;
      if (v.state === 'unknown') unknown = true;
    }
    return { state: unknown ? 'unknown' : 'ok' };
  }

  function processArticle(article) {
    if (article.dataset.xpkbAllow === '1') return;
    var state = article.dataset.xpkbState;
    if (state === 'ok' || state === 'hidden') return;

    var handles = handlesFor(article);
    if (!handles.length) return;                 // not rendered yet, retry next pass

    if (article.dataset.xpkbSeen !== '1') {
      article.dataset.xpkbSeen = '1';
      stats.articles++;
    }
    var extra = { name: domDisplayName(article) };
    var verdict = decide(handles, extra);

    // With a live network hook the fibers are a rare straggler check, so one
    // pass is enough. When they are the only source a post can render before
    // its author object is attached, so give it a couple more chances.
    var tries = parseInt(article.dataset.xpkbFiber || '0', 10) || 0;
    var maxTries = xrayOK && !pageWorld ? 3 : 1;
    if (verdict.state === 'unknown' && tries < maxTries) {
      article.dataset.xpkbFiber = String(tries + 1);
      if (harvestFromFiber(article)) verdict = decide(handles, extra);
    }

    if (verdict.state === 'match') {
      article.dataset.xpkbState = 'hidden';
      conceal(article, verdict);
      log('hid', verdict.handle, verdict.field, verdict.keyword);
      return;
    }
    if (verdict.state === 'unknown' && article.dataset.xpkbCounted !== '1') {
      article.dataset.xpkbCounted = '1';
      stats.unknown++;
      log('unknown author profile', handles.join(','));
    }
    article.dataset.xpkbState = verdict.state;
  }

  function processUserCell(cellEl) {
    if (cellEl.dataset.xpkbAllow === '1') return;
    var state = cellEl.dataset.xpkbState;
    if (state === 'ok' || state === 'hidden') return;
    var h = firstHandleIn(cellEl);
    if (!h) return;
    var v = evaluate(h, { name: domDisplayName(cellEl) });
    if (v.state === 'match') {
      cellEl.dataset.xpkbState = 'hidden';
      hiddenCount++;
      var target = cellEl.closest('div[data-testid="cellInnerDiv"]') || cellEl;
      target.setAttribute('data-xpkb-cell', 'hide');
      target.setAttribute('data-xpkb-handle', h);
      target.style.setProperty('display', 'none', 'important');
      return;
    }
    cellEl.dataset.xpkbState = v.state;
  }

  // X recycles DOM nodes, so a cell we hid can be reused for a different post.
  function reverify(cell) {
    var stored = cell.getAttribute('data-xpkb-handle');
    var article = cell.querySelector('article');
    var current, extra = null;
    if (article) {
      current = handlesFor(article);
      extra = { name: domDisplayName(article) };
    } else {
      var uc = cell.querySelector('[data-testid="UserCell"]') ||
        (cell.matches && cell.matches('[data-testid="UserCell"]') ? cell : null);
      if (!uc) return;
      var h = firstHandleIn(uc);
      current = h ? [h] : [];
      extra = { name: domDisplayName(uc) };
    }
    if (!current.length) return;
    if (current.indexOf(stored) !== -1 && decide(current, extra).state === 'match') return;
    log('recycled cell restored', stored, '->', current.join(','));
    restore(cell, false);
  }

  function scan() {
    var articles = document.querySelectorAll('article');
    for (var i = 0; i < articles.length; i++) processArticle(articles[i]);

    if (cfg.filterUserCells) {
      var cells = document.querySelectorAll('[data-testid="UserCell"]');
      for (var j = 0; j < cells.length; j++) processUserCell(cells[j]);
    }

    var hiddenCells = document.querySelectorAll('[data-xpkb-cell]');
    for (var k = 0; k < hiddenCells.length; k++) reverify(hiddenCells[k]);
  }

  var scanTimer = null;
  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(function () {
      scanTimer = null;
      requestAnimationFrame(function () {
        try { scan(); } catch (e) { console.warn('[xpkb] scan error', e); }
      });
    }, 80);
  }

  function resetAll() {
    var hiddenCells = document.querySelectorAll('[data-xpkb-cell]');
    for (var i = 0; i < hiddenCells.length; i++) restore(hiddenCells[i], false);
    var marked = document.querySelectorAll(
      '[data-xpkb-state], [data-xpkb-allow], [data-xpkb-seen], [data-xpkb-counted], [data-xpkb-fiber]');
    for (var j = 0; j < marked.length; j++) {
      delete marked[j].dataset.xpkbState;
      delete marked[j].dataset.xpkbAllow;
      delete marked[j].dataset.xpkbSeen;
      delete marked[j].dataset.xpkbCounted;
      delete marked[j].dataset.xpkbFiber;
    }
    hiddenCount = 0;
    stats.articles = 0;
    stats.unknown = 0;
    scheduleScan();
  }

  function startObserver() {
    var target = document.body || document.documentElement;
    new MutationObserver(scheduleScan).observe(target, { childList: true, subtree: true });
    scheduleScan();
  }

  if (document.body) startObserver();
  else document.addEventListener('DOMContentLoaded', startObserver, { once: true });

  /* ------------------------------------------------------------------ *
   * settings UI
   * ------------------------------------------------------------------ */
  function checkbox(labelText, checked) {
    var span = document.createElement('span');
    var input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!checked;
    span.appendChild(input);
    span.appendChild(document.createTextNode(labelText));
    return { wrap: span, input: input };
  }

  function openSettings() {
    if (document.querySelector('.xpkb-overlay')) return;

    var overlay = document.createElement('div');
    overlay.className = 'xpkb-overlay';
    var panel = document.createElement('div');
    panel.className = 'xpkb-panel';
    overlay.appendChild(panel);

    var h2 = document.createElement('h2');
    h2.textContent = 'Profile Keyword Blocker';
    panel.appendChild(h2);

    var sub = document.createElement('p');
    sub.className = 'xpkb-sub';
    sub.textContent = 'Posts are hidden when the author profile matches one of your keywords.';
    panel.appendChild(sub);

    var kwLabel = document.createElement('label');
    kwLabel.textContent = 'Keywords (one per line)';
    panel.appendChild(kwLabel);
    var kw = document.createElement('textarea');
    kw.value = cfg.keywords.join('\n');
    kw.spellcheck = false;
    kw.placeholder = 'crypto\nweb3\n✝\nemoji:latin cross\nU+271D\nflag:UA';
    panel.appendChild(kw);

    var kwHelp = document.createElement('p');
    kwHelp.className = 'xpkb-sub';
    kwHelp.style.margin = '6px 0 0';
    kwHelp.textContent =
      'Emoji: paste the character, or write emoji:latin cross, :latin_cross:, U+271D, or flag:UA. ' +
      'Group names match a whole family: cross, christian, religion, crypto, pride. ' +
      'Prefix any keyword with a field to restrict it to that field: name:flag:UA, bio:crypto, ' +
      'link:substack.com, any:web3. Unprefixed keywords use the field checkboxes below. ' +
      'Run xpkbEmojiNames() for every name, or xpkbEmojiScan() to list the emoji actually ' +
      'present in the profiles seen so far.';
    panel.appendChild(kwHelp);

    var modeLabel = document.createElement('label');
    modeLabel.textContent = 'Match mode';
    panel.appendChild(modeLabel);
    var modeRow = document.createElement('div');
    modeRow.className = 'xpkb-row';
    var mode = document.createElement('select');
    [
      ['substring', 'Substring (anywhere in the text)'],
      ['word', 'Whole word'],
      ['regex', 'Regular expression']
    ].forEach(function (opt) {
      var o = document.createElement('option');
      o.value = opt[0];
      o.textContent = opt[1];
      if (cfg.matchMode === opt[0]) o.selected = true;
      mode.appendChild(o);
    });
    modeRow.appendChild(mode);
    var cs = checkbox('Case sensitive', cfg.caseSensitive);
    modeRow.appendChild(cs.wrap);
    panel.appendChild(modeRow);

    var fieldsLabel = document.createElement('label');
    fieldsLabel.textContent = 'Profile fields to search';
    panel.appendChild(fieldsLabel);
    var fieldsRow = document.createElement('div');
    fieldsRow.className = 'xpkb-row';
    var fieldInputs = {};
    [
      ['bio', 'Bio'], ['name', 'Display name'], ['handle', 'Handle'],
      ['location', 'Location'], ['links', 'Link / website'], ['professional', 'Pro category']
    ].forEach(function (f) {
      var c = checkbox(f[1], cfg.fields[f[0]]);
      fieldInputs[f[0]] = c.input;
      fieldsRow.appendChild(c.wrap);
    });
    panel.appendChild(fieldsRow);

    var actLabel = document.createElement('label');
    actLabel.textContent = 'When a post matches';
    panel.appendChild(actLabel);
    var actRow = document.createElement('div');
    actRow.className = 'xpkb-row';
    var action = document.createElement('select');
    [
      ['collapse', 'Collapse to a one-line notice with a Show button'],
      ['hide', 'Remove it completely (no trace)']
    ].forEach(function (opt) {
      var o = document.createElement('option');
      o.value = opt[0];
      o.textContent = opt[1];
      if (cfg.action === opt[0]) o.selected = true;
      action.appendChild(o);
    });
    actRow.appendChild(action);
    panel.appendChild(actRow);

    var scopeLabel = document.createElement('label');
    scopeLabel.textContent = 'Scope';
    panel.appendChild(scopeLabel);
    var scopeRow = document.createElement('div');
    scopeRow.className = 'xpkb-row';
    var rt = checkbox('Also match the reposter', cfg.checkRetweeter);
    var qt = checkbox('Also match quoted authors', cfg.checkQuoted);
    var uc = checkbox('Also filter user lists / who to follow', cfg.filterUserCells);
    var lu = checkbox('Fetch profiles not seen in the feed (extra API requests)', cfg.lookupUnknown);
    var ne = checkbox('Ignore emoji skin tones and variation selectors', cfg.normalizeEmoji);
    var dbg = checkbox('Debug logging', cfg.debug);
    [rt, qt, uc, lu, ne, dbg].forEach(function (c) { scopeRow.appendChild(c.wrap); });
    panel.appendChild(scopeRow);

    var backupLabel = document.createElement('label');
    backupLabel.textContent = 'Backup';
    panel.appendChild(backupLabel);
    var backup = document.createElement('textarea');
    backup.className = 'xpkb-backup';
    backup.spellcheck = false;
    backup.value = JSON.stringify(cfg);
    panel.appendChild(backup);
    var backupNote = document.createElement('p');
    backupNote.className = 'xpkb-note';
    var importBtn = document.createElement('button');
    importBtn.type = 'button';
    importBtn.className = 'xpkb-inline';
    importBtn.textContent = 'Restore';
    backupNote.appendChild(document.createTextNode(
      'Copy this out to move your settings to another browser or keep them somewhere safe. ' +
      'Paste one back in and press '));
    backupNote.appendChild(importBtn);
    backupNote.appendChild(document.createTextNode('.'));
    panel.appendChild(backupNote);

    importBtn.addEventListener('click', function () {
      var parsed;
      try { parsed = JSON.parse(backup.value); } catch (e) { parsed = null; }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        backupNote.className = 'xpkb-note bad';
        backupNote.textContent = 'That is not a settings backup. Paste the whole line, braces and all.';
        return;
      }
      cfg = normalizeConfig(parsed);
      saveConfig();
      buildMatchers();
      close();
      resetAll();
      openSettings();      // reopen so the restored values are visible
    });

    var actions = document.createElement('div');
    actions.className = 'xpkb-actions';
    var stats = document.createElement('div');
    stats.className = 'xpkb-stats';
    stats.textContent = 'Hidden this session: ' + hiddenCount + '. Profiles known: ' + users.size + '.';
    actions.appendChild(stats);
    var right = document.createElement('div');
    right.className = 'xpkb-right';
    var cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    var save = document.createElement('button');
    save.type = 'button';
    save.className = 'primary';
    save.textContent = 'Save';
    right.appendChild(cancel);
    right.appendChild(save);
    actions.appendChild(right);
    panel.appendChild(actions);

    function close() {
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
    }
    function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    cancel.addEventListener('click', close);

    save.addEventListener('click', function () {
      cfg.keywords = kw.value.split('\n').map(function (s) { return s.trim(); })
        .filter(function (s) { return s.length; });
      cfg.matchMode = mode.value;
      cfg.caseSensitive = cs.input.checked;
      Object.keys(fieldInputs).forEach(function (k) { cfg.fields[k] = fieldInputs[k].checked; });
      cfg.action = action.value;
      cfg.checkRetweeter = rt.input.checked;
      cfg.checkQuoted = qt.input.checked;
      cfg.filterUserCells = uc.input.checked;
      cfg.lookupUnknown = lu.input.checked;
      cfg.normalizeEmoji = ne.input.checked;
      cfg.debug = dbg.input.checked;
      saveConfig();
      buildMatchers();
      close();
      resetAll();
    });

    (document.body || document.documentElement).appendChild(overlay);
    kw.focus();
  }

  /* ------------------------------------------------------------------ *
   * diagnostics
   * ------------------------------------------------------------------ */
  function worldDescription() {
    var w = worldName();
    if (w === 'page') return 'page (full access)';
    if (w === 'xray') {
      return 'Firefox content world, Xray fallback - profiles from React props' +
        (fetchHooked ? ' and an exported fetch hook' : ' only, fetch hook was refused');
    }
    return 'isolated  <- cannot read new profiles (cached ones still apply)';
  }

  function diagReport() {
    var withBio = 0;
    var samples = [];
    users.forEach(function (u, k) {
      if (u.b) {
        withBio++;
        if (samples.length < 3) samples.push('@' + k + ': ' + u.b.replace(/\s+/g, ' ').slice(0, 70));
      }
    });

    var unknownHandles = [];
    var arts = document.querySelectorAll('article[data-xpkb-state="unknown"]');
    for (var i = 0; i < arts.length && unknownHandles.length < 8; i++) {
      var h = authorOf(arts[i]);
      if (h && unknownHandles.indexOf(h) === -1) unknownHandles.push(h);
    }
    return [
      'X Profile Keyword Blocker ' + VERSION,
      '',
      'WORKING            : ' + (stats.payloads || stats.harvested || stats.fiber
        ? 'yes' : 'NO - nothing has been learned this session'),
      'JS world           : ' + worldDescription(),
      'fetch hook installed: ' + (fetchHooked ? 'yes' : 'NO'),
      'xhr hook installed : ' + (xhrHooked ? 'yes' : 'no'),
      'API payloads seen  : ' + stats.payloads,
      'profiles known     : ' + users.size + ' (' + stats.harvested + ' learned this session, ' +
        stats.fiber + ' from React props)',
      'profiles WITH a bio: ' + withBio + ' of ' + users.size +
        (users.size && !withBio ? '   <- bio field is not being extracted' : ''),
      'posts evaluated    : ' + stats.articles,
      'posts with unknown author: ' + stats.unknown,
      'posts hidden       : ' + hiddenCount,
      'profile lookups    : ' + stats.lookups,
      'learned lookup URL : ' + (apiCreds.userByScreenName ? 'yes' : 'no'),
      '',
      'keywords (' + matchers.length + ' active): ' + (matchers.map(function (m) { return m.raw; }).join(', ') || '(none)'),
      'match mode         : ' + cfg.matchMode + (cfg.caseSensitive ? ', case sensitive' : ', case insensitive'),
      'fields             : ' + Object.keys(cfg.fields).filter(function (k) { return cfg.fields[k]; }).join(', '),
      'action             : ' + cfg.action,
      '',
      'sample unknown authors: ' + (unknownHandles.length ? unknownHandles.join(', ') : '(none)'),
      '',
      'sample stored bios:',
      samples.length ? '  ' + samples.join('\n  ') : '  (none - no profile has a bio stored)',
      '',
      'raw User object shapes seen this session:',
      shapeSamples.length
        ? shapeSamples.map(function (x) {
            return '  @' + x.handle + ' bio=' + x.bioChars + ' chars\n' +
              '    top: ' + x.top + '\n' +
              '    legacy: ' + (x.legacy || '(none)') + '\n' +
              '    core: ' + (x.core || '(none)');
          }).join('\n')
        : '  (none captured yet - scroll the timeline and re-open)'
    ].join('\n');
  }

  // Aggregates every emoji found in the bios we know about, so a block list can
  // be built from what is actually there rather than guessed at.
  function emojiScan() {
    var counts = new Map();
    users.forEach(function (u) {
      [['bio', u.b], ['name', u.n]].forEach(function (pair) {
        var text = normText(pair[1] || '');
        if (!text) return;
        var seenHere = new Set();
        var m;
        EMOJI_CLUSTER.lastIndex = 0;
        while ((m = EMOJI_CLUSTER.exec(text)) !== null) {
          if (seenHere.has(m[0])) continue;    // count profiles, not repetitions
          seenHere.add(m[0]);
          var rec = counts.get(m[0]) || { n: 0, where: {} };
          rec.n++;
          rec.where[pair[0]] = (rec.where[pair[0]] || 0) + 1;
          counts.set(m[0], rec);
        }
      });
    });
    var rows = Array.from(counts.entries())
      .sort(function (a, b) { return b[1].n - a[1].n; })
      .map(function (e) {
        var name = emojiName(e[0]);
        var where = Object.keys(e[1].where).map(function (k) {
          return k + ':' + e[1].where[k];
        }).join(' ');
        var token = name ? 'emoji:' + name : codePointsOf(e[0]);
        // Suggest the scoped form when the symbol only ever shows up in names.
        var onlyName = !e[1].where.bio && e[1].where.name;
        return {
          emoji: e[0],
          profiles: e[1].n,
          found_in: where,
          codepoints: codePointsOf(e[0]),
          name: name || '(not in name table)',
          keyword: onlyName ? 'name:' + token : token
        };
      });
    if (console.table) console.table(rows); else console.log(rows);
    console.log('[xpkb] ' + rows.length + ' distinct emoji across ' + users.size + ' known profiles.');
    return rows;
  }

  function openDiagnostics() {
    var text = diagReport();
    console.log('[xpkb]\n' + text);
    if (document.querySelector('.xpkb-overlay')) return;
    var overlay = document.createElement('div');
    overlay.className = 'xpkb-overlay';
    var panel = document.createElement('div');
    panel.className = 'xpkb-panel';
    var h2 = document.createElement('h2');
    h2.textContent = 'Diagnostics';
    var pre = document.createElement('pre');
    pre.style.cssText = 'white-space:pre-wrap;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;' +
      'background:#0b0e11;border:1px solid #2f3336;border-radius:8px;padding:12px;margin:12px 0 0;overflow:auto';
    pre.textContent = text;
    var actions = document.createElement('div');
    actions.className = 'xpkb-actions';
    var spacer = document.createElement('div');
    var right = document.createElement('div');
    right.className = 'xpkb-right';
    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'primary';
    close.textContent = 'Close';
    close.addEventListener('click', function () { overlay.remove(); });
    right.appendChild(close);
    actions.appendChild(spacer);
    actions.appendChild(right);
    panel.appendChild(h2);
    panel.appendChild(pre);
    panel.appendChild(actions);
    overlay.appendChild(panel);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.remove(); });
    (document.body || document.documentElement).appendChild(overlay);
  }

  // Loud, one-off warning if the interception layer is dead: without it there is
  // no bio data at all and the script can only ever sit there doing nothing.
  setTimeout(function () {
    // Deliberately NOT users.size: the profile cache is restored from storage
    // at startup, so on any tab but the very first it is non-empty even when
    // the interception layer is stone dead. Only what was learned this session
    // says the script is actually working.
    if (stats.payloads > 0 || stats.harvested > 0 || stats.fiber > 0) return;
    var w = worldName();
    console.warn(
      '[xpkb] No profile data captured after 12s.\n' +
      (w === 'page'
        ? 'The script is in the page world but saw no X API responses. Reload the tab (the hook must be in place before the first timeline request).'
        : w === 'xray'
          ? 'Running in the Firefox content-world fallback, where profiles are read off rendered\n' +
            'posts rather than the network. Scroll the timeline and check again. If it stays empty,\n' +
            'open the script in Violentmonkey, Settings tab, and set "Inject into" to "page".'
          : 'The script is NOT running in the page JS world, so it cannot see x.com traffic.\n' +
            'On Chrome: chrome://extensions, Violentmonkey, Details, enable "Allow user scripts"\n' +
            '(or Developer mode before Chrome 138), then restart the browser.\n' +
            'In Tampermonkey: make sure @grant unsafeWindow is allowed and the script is not in a strict sandbox.') +
      '\nRun xpkbDiag() for details.'
    );
  }, 12000);

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('Profile Keyword Blocker: settings', openSettings);
    GM_registerMenuCommand('Profile Keyword Blocker: diagnostics', openDiagnostics);
    GM_registerMenuCommand('Profile Keyword Blocker: list emoji in known profiles', function () {
      emojiScan();
      console.log('[xpkb] table printed above. Copy a value from the "keyword" column into your keyword list.');
    });
    GM_registerMenuCommand('Profile Keyword Blocker: clear profile cache', function () {
      users.clear();
      store.set('cache', {});
      lookupSeen.clear();
      resetAll();
      console.log('[xpkb] profile cache cleared');
    });
  }

  // Escape hatch if the manager menu is unavailable: run xpkbSettings() in the console.
  try {
    W.xpkbSettings = toPage(openSettings);
    W.xpkbDiag = toPage(function () { console.log('[xpkb]\n' + diagReport()); return toPageValue(stats); });
    // Per-post breakdown of what the script knows about everything on screen.
    W.xpkbWhy = toPage(function () {
      var rows = [];
      var arts = document.querySelectorAll('article');
      for (var i = 0; i < arts.length; i++) {
        var h = authorOf(arts[i]);
        if (!h) continue;
        var u = users.get(h) || {};
        var dn = domDisplayName(arts[i]);
        rows.push({
          handle: '@' + h,
          known: users.has(h),
          bio: (u.b || '').replace(/\s+/g, ' ').slice(0, 80),
          name: u.n || dn,
          nameFromPage: dn,
          verdict: evaluate(h, { name: dn }).state
        });
      }
      if (console.table) console.table(rows); else console.log(rows);
      return rows.length;
    });
    W.xpkbSample = toPage(function () { console.log(shapeSamples); return toPageValue(shapeSamples); });
    W.xpkbEmojiScan = toPage(emojiScan);
    W.xpkbEmojiNames = toPage(function () {
      var rows = Object.keys(EMOJI_NAMES).sort().map(function (n) {
        return { name: n, emoji: EMOJI_NAMES[n], keyword: 'emoji:' + n };
      });
      var groups = Object.keys(EMOJI_GROUPS).map(function (g) {
        return { name: g + ' (group)', emoji: EMOJI_GROUPS[g].join(' '), keyword: 'emoji:' + g };
      });
      rows = groups.concat(rows);
      if (console.table) console.table(rows); else console.log(rows);
      return rows.length;
    });
  } catch (e) { /* ignore */ }

  log('ready', cfg);
})();
