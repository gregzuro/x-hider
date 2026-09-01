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

Accounts whose profile is unknown are never hidden. That is deliberate: a stub record
must not silently whitelist an account, so a profile with no usable text counts as
unknown rather than clean.

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

32 cases covering keyword compilation, emoji normalization, groups, flags, ZWJ
sequences, field scoping, and display-name matching. The tests pull the pure sections
out of the userscript, so they run without a browser.

## License

MIT, see [LICENSE](LICENSE).
