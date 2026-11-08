# cache-expiry-handoff

A Claude Code mod that shows how long your prompt cache has left and acts before it expires. It can notify you, keep the cache warm, or run your own handoff skill so a fresh session can pick up the work.

```
● Cache ████████░░░░  3:41  1h · 96% hit · 151k cached · warms at 1:00     Settings
```

## What it does

- **Countdown band above the prompt.** Time left, cache lifetime, hit rate and cached tokens. It turns amber inside the lead time and red once the cache has expired, when it tells you how many tokens the next message rewrites.
- **One action before expiry**, run a chosen time (default 1 minute) before the cache lapses:

  | Action | What happens |
  | --- | --- |
  | Notify | A toast and a system notification. |
  | Keep warm | A silent, tool-less request over the session's own transcript (`$.model.fork`) that reads the cache and resets its timer. Nothing appears in the conversation. It repeats until the idle budget runs out, then notifies. |
  | Hand off | Runs your skill or slash command (default `/handoff`) with the instructions you set, as if you had typed it. |
  | Keep warm, then hand off | Keeps the cache warm for the idle budget, then runs the handoff skill (Keep warm with **Then: Hand off**). |

  With a handoff action, **Afterwards: Clear** runs `/clear` once the handoff skill's turn finishes, so your next prompt starts a fresh session from the handoff instead of rewriting the old cache. An interrupted handoff leaves the session as it is.

  Each action runs once per idle stretch: your next message re-arms it. Contexts below a size you choose get a notification instead of a keep-warm or handoff.
- **Cold send: Ask first** (off by default). When the cache has expired, the mod asks before a message rewrites a large prompt, and can hold the message so you can `/compact` or `/clear` first.
- **Cache lifetime detection.** Set it to 5 minutes or 1 hour, or leave it on Auto. Auto reads `FORCE_PROMPT_CACHING_5M`, `CLAUDE_CODE_PROMPT_CACHE_TTL`, the `promptCacheTtl` setting and `ENABLE_PROMPT_CACHING_1H` first. Without those it treats a Claude account sign-in as 1 hour and an API key, Bedrock, Vertex or Foundry as 5 minutes, and corrects itself from traffic: a cache hit after more than five idle minutes proves a 1-hour cache.

## Settings

Run `/cache-expiry`, or press **Settings** on the band, to open the settings pane: the action, when it runs, the keep-warm budget, the handoff skill, its instructions and what happens afterwards, the size floor, the cache lifetime and alerts. It also has **Warm now**, **Run /handoff** and **Pause** buttons, and a log of what the mod did. Settings are saved across sessions.

| Command | Does |
| --- | --- |
| `/cache-expiry` | Opens the settings pane. |
| `/cache-expiry warm` | Keeps the cache warm now. |
| `/cache-expiry handoff` | Runs the handoff skill now. |
| `/cache-expiry mode <notify\|warm\|handoff\|warm-handoff>` | Sets the action. |
| `/cache-expiry pause`, `/cache-expiry resume` | Pauses or resumes actions for this session. |
| `/cache-expiry status` | Prints the cache state. |

## Costs

Keep-warm requests are billed to your account. Each one reads the cached prompt at the cache-read rate (about a tenth of the normal input price) and answers with one word. The settings pane shows how many tokens keep-warm has read. Writing an expired prompt back to the cache costs about 12× (5-minute cache) or 20× (1-hour cache) what reading it would.

## Install

At the prompt of a terminal session:

```
/plugin install cache-expiry-handoff --marketplace ossianravn/cc-cache-expiry-handoff
```

From a shell:

```bash
claude plugin install cache-expiry-handoff --marketplace ossianravn/cc-cache-expiry-handoff
```

In the desktop app: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `ossianravn/cc-cache-expiry-handoff`, then **Add plugin**.

Needs Claude Code 2.1.306 or later with mods.

## Develop

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

```bash
claude --plugin-dir .
```

`hooks/logic.ts` holds the lifetime detection and the before-expiry decision; `hooks/register.tsx` holds the hooks, the band and the pane.

## Credits

Inspired by [cache-tax](https://github.com/karanb192/cache-tax) (keep-warm and the cold-send guard) and the `prompt-cache-control` mod in [claude-code-templates](https://github.com/davila7/claude-code-templates) (the countdown band and lifetime detection).
