# X Profile Keyword Blocker

A userscript that hides posts on x.com from accounts whose **profile** matches your
keywords. Not the post text - the author's bio, display name, location, link, or the
emoji they use.

Works in Violentmonkey and Tampermonkey.

## Why this is not trivial

X does not put author bios in the timeline DOM, so no amount of reading the page will
find them. This script hooks `fetch` and `XMLHttpRequest`, reads the profile objects
that X's own GraphQL responses already carry for every post author, and builds a
`screen_name -> profile` map. The map is what keyword matching runs against.

Because the data arrives in the same response as the posts, matching happens before
render, so hidden posts do not flash into view.

Display names are additionally read straight off the page, since those are rendered.

## Install

1. Install [Violentmonkey](https://violentmonkey.github.io/) or
   [Tampermonkey](https://www.tampermonkey.net/).
2. [Install the script](https://raw.githubusercontent.com/gregzuro/x-hider/main/x-profile-keyword-blocker.user.js).
   Your userscript manager will intercept that link and offer to install it.
3. Reload x.com. A hard reload matters: the hook has to be in place before the first
   timeline request.

### The page world

x.com's CSP sends a `script-src` nonce, which makes the browser ignore the
`'unsafe-inline'` sitting next to it in the same header. So nothing can drop a plain
`<script>` into x.com's own JS world, and that world is where the network hook wants to
be. Getting there is browser-specific and can fail, so the script does not insist: it
declares `@inject-into auto`, works out which world it actually landed in, and adapts.
`xpkbDiag()` reports which one on the `JS world` line.

| World | When | What works |
| --- | --- | --- |
| `page` | Tampermonkey anywhere; Violentmonkey when injection succeeds | Everything: network hook plus React props |
| `xray` | Firefox + Violentmonkey, injection refused | React props, plus the network hook via `exportFunction` |
| `isolated` | Chrome + Violentmonkey, injection refused | Only profiles already in the local cache. Enable the toggle below |

**Chrome:** if diagnostics say `isolated`, go to `chrome://extensions`, open
Violentmonkey's *Details*, and enable **Allow user scripts** (on Chrome older than 138,
turn on *Developer mode* at the top right of the same page instead). That is what lets
Violentmonkey use Chrome's `userScripts` API. Restart the browser after flipping it.

**Firefox:** Violentmonkey's CSP workaround depends on seeing the document's response
headers, and a page served from cache never delivers them again, so soft reloads and
reopened tabs land in the content world. Firefox is generous there in a way Chrome is
not: `unsafeWindow` is a real handle on the page window and DOM nodes expose
`.wrappedJSObject`, so the script reads author profiles straight off React's fibers on
the rendered posts, and re-exports its `fetch` wrapper through `exportFunction`. It
keeps working; profiles are just learned as posts render rather than as responses
arrive, so a post can occasionally appear for a frame before it is hidden.

Open settings from the extension's toolbar menu ("Profile Keyword Blocker: settings"),
or run `xpkbSettings()` in the console.

## Keywords

One per line. Everything is case-insensitive by default.

| Keyword | Matches |
| --- | --- |
| `crypto` | the text, anywhere in the searched fields |
| `✝` | that symbol, pasted directly |
| `emoji:latin cross` | the same symbol, by name |
| `:latin_cross:` | shortcode form of the same |
| `U+271D` | by code point (`U+1F1FA U+1F1E6` for sequences) |
| `flag:UA` | a country flag, from its ISO code |
| `emoji:cross` | a whole family: `✝ ✞ ✟ ✠ ☦ ☧ ☨ ☩` |

Emoji group names: `cross`, `christian`, `religion`, `crypto`, `pride`.
`xpkbEmojiNames()` lists every name.

### Field prefixes

By default keywords search the fields ticked in settings (bio only, out of the box).
Prefix a keyword to restrict it to one field instead:

```
Christian            # bio only, per the checkboxes
name:flag:US         # only the display name
bio:crypto           # only the bio
link:substack.com    # only their website
any:web3             # every field, regardless of checkboxes
```

Prefixes: `bio:` `name:` `handle:` `location:` `link:` `professional:` `any:`

This matters when mixing text and emoji rules. Ticking the global "Display name" box
would make a keyword like `Christian` start hiding everyone *named* Christian;
scoping keeps each rule where it belongs.

### Emoji normalization

`✝` (U+271D) and `✝️` (U+271D U+FE0F) render identically but are different strings,
and bios contain both. Variation selectors and skin-tone modifiers are stripped from
both sides before matching, so one keyword catches every spelling and
`emoji:christian` also matches `🙏🏽`. There is a settings toggle if you want exact
bytes.

Symbol keywords always match as substrings, even in whole-word mode, since a word
boundary next to an emoji is meaningless and `✝Christian` still has to match.

## Settings

- **Match mode** - substring, whole word, or regular expression
- **Fields** - bio, display name, handle, location, link, professional category
- **Action** - collapse to a one-line notice with a Show button, or remove entirely
- **Scope** - also match the reposter, quoted authors, and user lists / who to follow
- **Fetch profiles not seen in the feed** - off by default, see Privacy

## Finding what to block

`xpkbEmojiScan()` (also a menu command) tabulates every emoji across the profiles seen
so far, with a count, where it appears, and a paste-ready keyword:

```
emoji  profiles  found_in       codepoints        name           keyword
🇺🇸     14        name:14        U+1F1FA U+1F1F8   (not in table) name:U+1F1FA U+1F1F8
✝      6         bio:5 name:1   U+271D            latin cross    emoji:latin cross
```

## Troubleshooting

Run `xpkbDiag()`, or use the diagnostics menu command.

| Symptom | Cause |
| --- | --- |
| `runs in page world: NO` | The script is in an isolated world and cannot see x.com traffic. In Violentmonkey set "Inject into" to `page`. |
| `API payloads seen: 0` | The hook was installed too late. Hard-reload the tab. |
| `profiles WITH a bio: 0 of N` | The bio is not where the extractor looks. The `raw User object shapes` section of the report shows where X actually put it. |
| Posts still visible | `xpkbWhy()` prints a row per post on screen: handle, stored bio, display name, and verdict. |
| Violentmonkey says "could not inject some scripts" on a soft reload or a reopened tab | Expected on Firefox, and handled: page-world injection needs the CSP worked around, which hangs off response headers a cached load never re-delivers. Since 1.5.0 the script runs in the content world instead and reads profiles off React's fibers. `xpkbDiag()` will say `JS world: xray`. To stop the warning entirely, open the script in Violentmonkey, Settings tab, and set "Inject into" to `content`: on Firefox that costs nothing but the pre-render head start. |
| `JS world: isolated` | Chrome + Violentmonkey with page-world injection refused, and Chrome's content world has no route to page data. Enable **Allow user scripts**, see [The page world](#the-page-world). |

Accounts whose profile is unknown are never hidden. That is deliberate: a stub record
must not silently whitelist an account, so a profile with no usable text counts as
unknown rather than clean.

## Settings, and keeping them

Settings survive an update on their own: your manager updates the script in place and
leaves its stored values alone. Two things do lose them, and both are handled.

The first is a **schema change**. A config written by an older version is loaded by
starting from the current defaults and overlaying only the keys that are recognised, at
the type expected, so a key added in a later version gets its default and a stale one is
dropped. Your keywords come through untouched.

The second is **GM storage being orphaned**. It is keyed on the script's `@name` and
`@namespace`, so changing either of those, or removing and reinstalling rather than
updating, leaves the old values stranded under a key nothing reads. Against that the
script keeps a second copy in x.com's own `localStorage`, which knows nothing about
userscripts and survives all of it. That copy is only read when GM storage comes back
empty, and it is written straight back to GM storage when it is, so the recovery happens
once and the console says so.

For anything those do not cover - a new browser, a new machine, or just wanting a copy
somewhere safe - the settings panel has a **Backup** box holding your whole config as one
line of JSON. Copy it out to save it; paste one in and press Restore to load it.

## Privacy

Profiles are cached locally through GM storage (2500 entries, oldest dropped) so
filtering works instantly on reload. Nothing is sent anywhere.

The optional "fetch profiles not seen in the feed" setting is **off by default**. When
enabled, it replays x.com's own profile endpoint using credentials already present in
the page, for handles that never appeared in a timeline response. It stays idle until
it has observed one such request to learn the endpoint.

## Development

```
node test/run.js
```

63 cases covering keyword compilation, emoji normalization, groups, flags, ZWJ
sequences, field scoping, display-name matching, the three JS worlds, and settings
persistence. The tests pull the pure sections out of the userscript, so they run without
a browser. The world cases build a stand-in for each of `page`, `xray` and `isolated` and
check that a user object buried in React props is found through the right access path in
each; the persistence cases load a 1.4.0-shaped config and recover an orphaned one.

## License

MIT, see [LICENSE](LICENSE).
