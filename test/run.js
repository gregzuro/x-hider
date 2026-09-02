/*
 * Tests for the matching layer of x-profile-keyword-blocker.user.js.
 *
 * The userscript is one IIFE that needs a browser, so rather than mock a DOM
 * this pulls out the two pure sections - keyword compilation and evaluate() -
 * and exercises them directly. Run with: node test/run.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'x-profile-keyword-blocker.user.js'), 'utf8');

function slice(startMarker, endMarker) {
  const a = SRC.indexOf(startMarker);
  const b = SRC.indexOf(endMarker, a);
  if (a < 0 || b < 0) throw new Error('cannot locate section: ' + startMarker);
  return SRC.slice(a, b + endMarker.length);
}

const body =
  slice('  var EMOJI_NAMES = {', '  buildMatchers();') + '\n' +
  slice('  function evaluate(handle, extra) {', '\n    return { state: \'ok\' };\n  }');

const cfg = {
  keywords: [], matchMode: 'substring', caseSensitive: false, normalizeEmoji: true,
  fields: { bio: true, name: false, handle: false, location: false, links: false, professional: false }
};
const users = new Map();
const api = new Function('cfg', 'users', 'queueLookup', 'stats',
  body + '; return { buildMatchers, evaluate, matchers: () => matchers, normText, emojiName, codePointsOf, EMOJI_CLUSTER };'
)(cfg, users, () => {}, {});

let failures = 0;
function check(label, got, want) {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label.padEnd(44)} want=${String(want).padEnd(8)} got=${got}`);
}

/* ---- keyword compilation and emoji normalization ---- */
function matches(keywords, text, opts) {
  Object.assign(cfg, { matchMode: 'substring', caseSensitive: false, normalizeEmoji: true }, opts || {});
  cfg.keywords = keywords;
  api.buildMatchers();
  const hay = api.normText(text);
  return api.matchers().some(m => { m.re.lastIndex = 0; return m.re.test(hay); });
}

console.log('--- keyword compilation ---');
check('bare keyword vs variation-selector bio', matches(['✝'], 'father ✝️ tx'), true);
check('variation-selector keyword vs bare bio', matches(['✝️'], 'father ✝ tx'), true);
check('emoji by name',                    matches(['emoji:latin cross'], 'Christ ✝️'), true);
check('shortcode form',                   matches([':latin_cross:'], 'Christ ✝'), true);
check('code point',                       matches(['U+271D'], 'jesus ✝'), true);
check('group matches sibling glyph',      matches(['emoji:cross'], 'Orthodox ☦'), true);
check('group, no match',                  matches(['emoji:cross'], 'normal bio'), false);
check('skin tone stripped',               matches(['emoji:christian'], 'pray 🙏🏽'), true);
check('flag by country code',             matches(['flag:UA'], 'Slava 🇺🇦'), true);
check('wrong flag',                       matches(['flag:UA'], 'hello 🇺🇸'), false);
check('currency symbol (not So)',         matches(['emoji:bitcoin sign'], 'long ₿'), true);
check('ZWJ sequence',                     matches(['emoji:pride'], 'she/her 🏳️‍🌈'), true);
check('no word boundary needed for emoji',matches(['✝'], '✝Christian', { matchMode: 'word' }), true);
check('word mode stays strict for text',  matches(['Christian'], 'Christianity', { matchMode: 'word' }), false);
check('substring mode is loose',          matches(['Christian'], 'Christianity'), true);
check('case insensitive by default',      matches(['christian'], 'Christian dad'), true);
check('case sensitive when asked',        matches(['christian'], 'Christian dad', { caseSensitive: true }), false);
check('unknown emoji name matches nothing', matches(['emoji:nonexistent'], 'anything ✝'), false);
check('heavy greek cross is not a latin cross', matches(['emoji:cross'], '3 ✚ 2'), false);

/* ---- field scoping and display names ---- */
users.set('flagdad', { h: 'flagdad', n: 'Mike 🇺🇸🦅', b: 'dad, coach, veteran' });
users.set('christo', { h: 'christo', n: 'Christian Bale', b: 'actor' });
users.set('bioflag', { h: 'bioflag', n: 'Anna', b: 'Kyiv 🇺🇦 journalist' });
users.set('stub',    { h: 'stub' });

function verdict(handle, keywords, fields, domName) {
  cfg.keywords = keywords;
  Object.assign(cfg.fields,
    { bio: true, name: false, handle: false, location: false, links: false, professional: false },
    fields || {});
  api.buildMatchers();
  return api.evaluate(handle, domName ? { name: domName } : null).state;
}

/* ---- hashtags ---- */
console.log('\n--- hashtags ---');
check('bare keyword, bare bio',            matches(['Christian'], 'a Christian dad'), true);
check('bare keyword finds the hashtag',    matches(['Christian'], 'a #Christian dad'), true);
check('hashed keyword finds the bare word',matches(['#Christian'], 'a Christian dad'), true);
check('hashed keyword finds the hashtag',  matches(['#Christian'], 'a #Christian dad'), true);
check('hashed keyword, doubled hash',      matches(['#Christian'], 'a ##Christian dad'), true);
check('hashed keyword, no match at all',   matches(['#Christian'], 'a normal bio'), false);
check('word mode, bare vs hashtag',        matches(['Christian'], 'a #Christian dad', { matchMode: 'word' }), true);
check('word mode, hashed vs bare',         matches(['#Christian'], 'a Christian dad', { matchMode: 'word' }), true);
check('word mode, hashed vs hashtag',      matches(['#Christian'], 'a #Christian dad', { matchMode: 'word' }), true);
check('word mode still refuses a substring', matches(['#Christian'], 'unChristian of him', { matchMode: 'word' }), false);
check('lone hash stays literal',           matches(['#'], 'tagged #crypto'), true);
check('lone hash does not match everything', matches(['#'], 'no tags here'), false);
check('regex mode leaves the hash strict', matches(['#crypto'], 'i love crypto', { matchMode: 'regex' }), false);
check('regex mode matches the hashtag',    matches(['#crypto'], 'i love #crypto', { matchMode: 'regex' }), true);

console.log('\n--- field scoping ---');
check('flag in name, name field off',     verdict('flagdad', ['flag:US']), 'ok');
check('flag in name, name field on',      verdict('flagdad', ['flag:US'], { name: true }), 'match');
check('scoped keyword ignores the checkbox', verdict('flagdad', ['name:flag:US']), 'match');
check('name-scoped text keyword',         verdict('christo', ['name:Christian']), 'match');
check('bio-scoped keyword skips the name',verdict('christo', ['bio:Christian']), 'ok');
check('unscoped keyword stays bio-only',  verdict('christo', ['Christian']), 'ok');
check('unscoped keyword with name field on', verdict('christo', ['Christian'], { name: true }), 'match');
check('flag in bio with default fields',  verdict('bioflag', ['flag:UA']), 'match');
check('name read off the page, no record',verdict('ghost', ['name:flag:US'], {}, 'Bo 🇺🇸'), 'match');
check('unknown handle stays unknown',     verdict('ghost2', ['flag:US']), 'unknown');
check('emoji group scoped to name',       verdict('flagdad', ['name:emoji:eagle']), 'match');
check('any: prefix searches every field', verdict('bioflag', ['any:flag:UA']), 'match');
check('blank profile is unknown, not ok', verdict('stub', ['crypto']), 'unknown');

/* ---- world detection and the Firefox Xray fallback ---- */
/*
 * Builds the harvest + fiber layers against a stand-in for each JS world the
 * script can land in, and checks that a user object buried in React props is
 * found in both. The xray case is the Firefox fallback: the fiber expando is
 * only visible through node.wrappedJSObject, so a run that finds it proves
 * waive() is being applied rather than the node being read directly.
 */
const worldBody =
  slice('  var xrayOK = false;', '  function noop() {}') + '\n' +
  slice('  function pick() {', "url.indexOf('/graphql/') !== -1;\n  }") + '\n' +
  slice('  function reactKey(node) {', '    return users.size !== before;\n  }');

function buildWorld(mode) {
  const userObj = {
    __typename: 'User',
    core: { screen_name: 'Zealot', name: 'Zed' },
    legacy: { description: 'Christian dad, Texas' }
  };
  const fiber = { memoizedProps: { tweet: { user_results: { result: userObj } } }, return: null };
  const KEY = '__reactFiber$q7x';

  const article = { nodeType: 1, nodeName: 'ARTICLE' };
  let pageWin, contentWin, exportFn, docEl;
  if (mode === 'xray') {
    article.wrappedJSObject = { [KEY]: fiber };
    docEl = { wrappedJSObject: {} };
    pageWin = { name: 'page' };
    contentWin = { name: 'content' };
    exportFn = (fn) => { const w = (...a) => fn(...a); w.__exported = true; return w; };
  } else if (mode === 'page') {
    article[KEY] = fiber;
    docEl = {};
    pageWin = contentWin = { name: 'page' };
    exportFn = undefined;
  } else {                                  // chrome content world
    docEl = {};
    pageWin = contentWin = { name: 'page' };
    exportFn = undefined;
  }

  const doc = { documentElement: docEl, querySelectorAll: () => [article] };
  const store = new Map();
  const st = { harvested: 0, fiber: 0, payloads: 0 };
  const env = new Function(
    'W', 'window', 'document', 'exportFunction', 'users', 'stats', 'shapeSamples',
    'scheduleCacheSave', 'scheduleScan', 'log',
    worldBody + '; return { xrayOK, toPage, waive, worldName, harvestFromFiber };'
  )(pageWin, contentWin, doc, exportFn, store, st, [], () => {}, () => {}, () => {});
  return { env, store, stats: st, article };
}

console.log('\n--- JS world fallback ---');
{
  const page = buildWorld('page');
  check('page world detected', page.env.worldName(), 'page');
  check('page world: toPage is identity', page.env.toPage(check) === check, true);
  check('page world: fiber harvest', page.env.harvestFromFiber(page.article), true);
  check('page world: user recorded', (page.store.get('zealot') || {}).b, 'Christian dad, Texas');

  const xray = buildWorld('xray');
  check('firefox content world detected', xray.env.worldName(), 'xray');
  check('xray: toPage exports', !!xray.env.toPage(check).__exported, true);
  check('xray: waive unwraps the node', xray.env.waive(xray.article) === xray.article.wrappedJSObject, true);
  check('xray: fiber harvest through waiver', xray.env.harvestFromFiber(xray.article), true);
  check('xray: user recorded', (xray.store.get('zealot') || {}).n, 'Zed');
  check('xray: display name via fiber', (xray.store.get('zealot') || {}).b, 'Christian dad, Texas');

  const iso = buildWorld('isolated');
  check('chrome content world detected', iso.env.worldName(), 'isolated');
  check('isolated: fiber harvest refused', iso.env.harvestFromFiber(iso.article), false);
  check('isolated: nothing recorded', iso.store.size, 0);
}

/* ---- settings persistence across updates ---- */
/*
 * normalizeConfig() is the forward-compatibility layer: a config written by an
 * older version has to load with new keys defaulted and stale ones dropped.
 * loadConfig() is the recovery path for GM storage being orphaned by a
 * reinstall or an identity change, which is the case that would otherwise
 * silently revert someone to an empty keyword list.
 */
const cfgBody = slice('  var DEFAULTS = {', '    return out;\n  }');

function buildConfig(gmValue, mirrorValue, live) {
  const gm = gmValue === undefined ? {} : { config: gmValue };
  const ls = mirrorValue === undefined ? {} : { 'xpkb:config': JSON.stringify(mirrorValue) };
  const fakeLocal = {
    getItem: k => (k in ls ? ls[k] : null),
    setItem: (k, v) => { ls[k] = v; }
  };
  const env = new Function(
    'GM_getValue', 'GM_setValue', 'localStorage', 'store', 'console', 'cfg',
    cfgBody + '; return { normalizeConfig, loadConfig, saveConfig, DEFAULTS };'
  )(
    (k, d) => (gm[k] === undefined ? d : gm[k]),
    (k, v) => { gm[k] = v; },
    fakeLocal,
    { set: (k, v) => { gm[k] = v; } },
    { info: () => {} },
    live || null
  );
  return { env, gm, ls };
}

console.log('\n--- settings persistence ---');
{
  const { env } = buildConfig();
  const fresh = env.normalizeConfig(null);
  check('fresh config uses defaults', fresh.fields.bio, true);

  // A 1.4.0 config: no schema version, and written before normalizeEmoji existed.
  const old14 = { keywords: ['Christian'], action: 'hide', fields: { name: true } };
  const up = env.normalizeConfig(old14);
  check('old config keeps its keywords', up.keywords.join(), 'Christian');
  check('old config keeps its action', up.action, 'hide');
  check('old config keeps a set field', up.fields.name, true);
  check('unset field falls back to default', up.fields.bio, true);
  check('key added later gets its default', up.normalizeEmoji, true);
  check('unversioned config reads as v0', up.v, 0);
  check('unknown keys are dropped', 'bogus' in env.normalizeConfig({ bogus: 1 }), false);
  check('wrong type is ignored', env.normalizeConfig({ caseSensitive: 'yes' }).caseSensitive, false);
  check('round trip is stable',
    JSON.stringify(env.normalizeConfig(JSON.parse(JSON.stringify(up)))), JSON.stringify(up));
}
{
  // GM storage intact: the mirror is not consulted.
  const { env } = buildConfig({ keywords: ['fromGM'], v: 1 }, { keywords: ['fromMirror'], v: 1 });
  check('GM storage wins when present', env.loadConfig().keywords.join(), 'fromGM');
}
{
  // The mirror has to exist BEFORE the reinstall that orphans GM storage, so a
  // plain load refreshes it even if the settings panel is never opened.
  const { env, ls } = buildConfig({ keywords: ['neverOpenedSettings'], v: 1 });
  check('mirror absent before first load', 'xpkb:config' in ls, false);
  env.loadConfig();
  check('load seeds the mirror', JSON.parse(ls['xpkb:config']).keywords.join(), 'neverOpenedSettings');
}
{
  // GM storage orphaned by a reinstall; only the x.com-side copy is left.
  const { env, gm } = buildConfig(undefined, { keywords: ['fromMirror'], action: 'hide', v: 1 });
  const restored = env.loadConfig();
  check('mirror recovers orphaned settings', restored.keywords.join(), 'fromMirror');
  check('mirror recovery keeps other values', restored.action, 'hide');
  check('recovered config is written back to GM', gm.config.keywords.join(), 'fromMirror');
}
{
  const { env } = buildConfig();
  check('no copy anywhere gives defaults', env.loadConfig().keywords.length, 0);
}
{
  const live = { keywords: ['x'], fields: {} };
  const { env, gm, ls } = buildConfig(undefined, undefined, live);
  env.saveConfig();
  check('save writes GM storage', gm.config.keywords.join(), 'x');
  check('save writes the mirror', JSON.parse(ls['xpkb:config']).keywords.join(), 'x');
  check('save stamps the schema version', gm.config.v, 1);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall cases pass');
process.exit(failures ? 1 : 0);
