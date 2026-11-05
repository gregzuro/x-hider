# X Profile Keyword Blocker

A userscript that hides posts on x.com from accounts whose **profile** matches your
keywords. It filters on the author's bio, display name, location, link, or the
emoji they use.

It is confirmed working in Violentmonkey and Tampermonkey.

## Install

1. Install [Violentmonkey](https://violentmonkey.github.io/) or
   [Tampermonkey](https://www.tampermonkey.net/).
2. [Install the script](https://raw.githubusercontent.com/gregzuro/x-hider/main/x-profile-keyword-blocker.user.js).
   Your userscript manager will intercept that link and offer to install it.
3. Reload x.com. A hard reload matters: the hook has to be in place before the first
   timeline request.

### Needs the 'page world'

| World | When | What works |
| --- | --- | --- |
| `page` | Any manager, on a load that hit the network | Everything: network hook plus React props |
| `xray` | Firefox content world: what any manager falls back to on a cached load | React props, confirmed to filter a live timeline on its own. The network hook is installed only if `exportFunction` accepts it, and skipped otherwise - see below |
| `isolated` | Chrome + Violentmonkey, injection refused | Only profiles already in the local cache. Enable the toggle below |

**Chrome:** if diagnostics say `isolated`, go to `chrome://extensions`, open
Violentmonkey's *Details*, and enable **Allow user scripts** (on Chrome older than 138,
turn on *Developer mode* at the top right of the same page instead). That is what lets
Violentmonkey use Chrome's `userScripts` API. Restart the browser after flipping it.

**Firefox:** getting into the page world on x.com means relaxing its CSP, and a manager
can only do that by rewriting the document's response headers. A page served from cache
never delivers them again, so a soft reload, a reopened tab or a back/forward cannot be
injected into the page. **This is a browser limit, not a Violentmonkey one: Tampermonkey
behaves the same way.** What you see is the manager's inline `<script>` being refused,
logged against its own extension UUID:

```
Content-Security-Policy: The page's settings blocked an inline script (script-src-elem)
  a2d0e484-91db-41e1-9c40-b7f40fd3d5fa:19:51
```

A hard reload (Ctrl/Cmd+Shift+R) forces a real request and the page world works again.

## Keywords

One per line. Everything is case-insensitive by default.

| Keyword | Matches |
| --- | --- |
| `crypto` | the text, anywhere in the searched fields |
| `✝` | that symbol, pasted directly |
| `emoji:latin cross` | the same symbol, by name |
| `:latin_cross:` | shortcode form of the same |
| `U+271D` | by code point (`U+1F1FA U+1F1E6` for sequences) |
| `flag:MC` | a country flag, from its ISO code |
| `emoji:cross` | a whole family: `✝ ✞ ✟ ✠ ☦ ☧ ☨ ☩` |
| `#crypto` | `#crypto` and plain `crypto`, since the leading hash is optional |

Emoji group names: `cross`, `christian`, `religion`, `crypto`.
`xpkbEmojiNames()` lists every name.

### Hashtags

Bios are written both ways, `Christian` and `#Christian`, and you get both either way.

Word mode still refuses a substring, so `#Christian` does not match `unChristian`. Regex
mode lets you be explicit and matches `#` exactly as written.

If a keyword you expect to hit a hashtag is not hitting it, the matcher is usually not
the reason. Run `xpkbFind("christian")`: it ignores your keyword list and reports which
*field* that text is actually in across every profile learned so far, and whether that
field is being searched. A hashtag in someone's display name is invisible with the
default settings, which looks exactly like broken matching.

### Lookalike characters

X bios are full of text that reads as one thing and is encoded as another, some of it
decorative and some of it deliberate evasion:

| Looks like | Actually is |
| --- | --- |
| `Israel` | `Іsrael` with a Cyrillic capital I |
| `Israel` | `Israel` with a zero-width joiner wedged in the middle |
| `Israel` | `𝐈𝐬𝐫𝐚𝐞𝐥` in mathematical bold, one of dozens of styled runs |
| `Israel` | `Ｉｓｒａｅｌ` in fullwidth Latin |

Any of these will match all of these.
Zero-width characters are dropped, styled and fullwidth Latin and accents are normalised,
and Cyrillic and Greek lookalikes are mapped to their Latin twins.

Untick "Match lookalike characters" in settings to turn it off.

### When a keyword does not fire

Out of the box only the **bio** is searched. 
You can enable location and or display name to expand the search to those areas. 

If any known profile matches a keyword
in a field that is switched off, it warns in the console after 15 seconds and names the
field and the profile. `xpkbDiag()` has a `near misses` line with the list.
`xpkbNearMisses()` prints the lot on demand, and `xpkbFind("israel")` tells where 
the text was found.

When you want the whole decision for one account, **`xpkbExplain("DeniseInCanada")`**
prints what is stored in every field with non-ASCII shown as `\uXXXX`, which fields are
searched, every compiled keyword regex, and for each keyword-and-field pair whether it was
tested and whether it hit.

You can either tick the field in settings, which widens every unscoped keyword, or 
scope that one keyword and leave the rest alone:

```
location:Israel      # only their location, other keywords unaffected
name:Israel          # only their display name
```

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

This helps when mixing text and emoji rules. Ticking the global "Display name" box
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
| `API payloads seen: 0` while both hooks say `installed: yes` | The hook went onto an object the page does not read. Before 1.8.2 it was installed on `unsafeWindow`, which in Violentmonkey's content mode is a sandbox, not the page global - so it installed cleanly and never fired. Fixed by targeting `window.wrappedJSObject`. If you still see it, the hook was installed too late: hard-reload the tab. |
| `profiles WITH a bio: 0 of N` | The bio is not where the extractor looks. The `raw User object shapes` section of the report shows where X actually put it. |
| Posts still visible | `xpkbWhy()` prints a row per post on screen: handle, stored bio, display name, and verdict. |
| A keyword that should obviously match, does not | `xpkbFind("that text")` ignores your keyword list and says which field the text is really in, and whether that field is searched. Most often it is the display name or the location, both off by default. |
| `near misses: N profile(s) match in a field that is switched OFF` | Exactly that. `xpkbNearMisses()` lists them. Tick the field, or scope the keyword to it. |
| A keyword matches when pasted from a profile but not when typed | Lookalike characters. Handled by default now; `xpkbExplain("handle")` shows the stored text with non-ASCII escaped so you can see exactly which character it is. |
| Violentmonkey says "could not inject some scripts" on a soft reload or a reopened tab | Page-world injection needs the CSP relaxed, which needs response headers a cached load never re-delivers. Since 1.8.0 the script asks for `auto` and runs in the content world instead of not running, so this is a warning rather than a failure. A hard reload gets the page world back. Tampermonkey is not a way around it. See [The page world](#the-page-world). |
| `JS world: isolated` | Chrome + Violentmonkey with page-world injection refused, and Chrome's content world has no route to page data. Enable **Allow user scripts**, see [The page world](#the-page-world). |

Accounts whose profile is unknown are never hidden. 

## Updating

**Update in place. Do not remove and reinstall.** An in-place update keeps the script's
stored settings; a remove-and-reinstall throws them away, because your manager deletes a
script's values along with the script. Any of these are in place:

- **Let it update itself.** `@updateURL` points at the raw file on `main`, so once
  `@version` goes up your manager picks it up on its own schedule. To not wait, open the
  Violentmonkey dashboard and use the update action on the script (or "Check for updates
  for all scripts").
- **Reinstall over the top from the same URL.** Because `@name` and `@namespace` match,
  your manager recognises it as the same script and offers to update rather than adding a
  second one. Settings are kept.
- **Paste over it in the editor.** Open the script in the Violentmonkey editor, select
  all, paste the new source, save. Same script record, same settings. This is the
  quickest loop when the source is a local file.

If your manager offers to track a local file, that is the tidiest development loop of
all, but availability varies by browser and version, so check yours.

## Settings, and keeping them

Settings survive an in-place update on their own: your manager leaves a script's stored
values alone. Two things do lose them, and both are handled.

The first is a **schema change**. A config written by an older version is loaded by
starting from the current defaults and overlaying only the keys that are recognised, at
the type expected, so a key added in a later version gets its default and a stale one is
dropped. Your keywords come through untouched.

The second is **GM storage being orphaned**. It is keyed on the script's `@name` and
`@namespace`, so changing either of those, or removing and reinstalling rather than
updating, leaves the old values stranded under a key nothing reads. Against that the
script keeps a second copy in x.com's own `localStorage`, which knows nothing about
userscripts and survives all of it. It is refreshed on every page load, not just when you
press Save, since the copy has to already exist before the reinstall that orphans the
original. It is read only when GM storage comes back empty, and is written straight back
to GM storage when it is, so the recovery happens once and the console says so.

This only protects you from the version that introduced it onwards. If you are about to
reinstall and are not sure a mirror exists yet, open the settings panel first and copy the
Backup line out.

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

111 cases covering keyword compilation, emoji normalization, groups, flags, ZWJ
sequences, hashtags, lookalike characters, field scoping, display-name matching, near
misses, the three JS worlds, and settings persistence. The tests pull the pure sections out of the userscript, so they run without
a browser. The world cases build a stand-in for each of `page`, `xray` and `isolated` and
check that a user object buried in React props is found through the right access path in
each; the persistence cases load a 1.4.0-shaped config and recover an orphaned one.

## License

MIT, see [LICENSE](LICENSE).
