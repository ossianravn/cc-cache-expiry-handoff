import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, Timer } from 'claude-code'

import type { CacheLogEntry, CacheLogKind, CacheMode, CacheRun, CacheSettings, CacheSnapshot, CacheTtlChoice } from '../types'
import {
  DEFAULT_SETTINGS,
  EMPTY_SNAP,
  IDLE_RUN,
  MODES,
  PING_PROMPT,
  coldMultiple,
  decide,
  explicitTtl,
  fmtAgo,
  fmtClock,
  fmtDuration,
  fmtTokens,
  fmtTtl,
  fmtTtlShort,
  hitRate,
  inferTtl,
  leadMs,
  normalizeSettings,
  prefixTokens,
  pushLog,
  remainingMs,
  ttlMs,
  ttlSource,
} from './logic'
import type { ExplicitTtl } from './logic'

type $ = EngineInterface

const PANE = 'cache'

/** The Action control: keep-warm's follow-up is its own choice, so three short options fit one row. */
const ACTIONS: readonly { value: CacheMode; label: string }[] = [
  { value: 'notify', label: 'Notify' },
  { value: 'warm', label: 'Keep warm' },
  { value: 'handoff', label: 'Hand off' },
]
const THEN: readonly { value: CacheMode; label: string }[] = [
  { value: 'warm', label: 'Notify' },
  { value: 'warm-handoff', label: 'Hand off' },
]
const COMMAND = 'cache-expiry'

const settingsA = atom({ plugin: 'cache-expiry-handoff', key: 'settings' } as const, DEFAULT_SETTINGS, {
  shape: 'settings-1',
})
const snapA = atom({ plugin: 'cache-expiry-handoff', key: 'snap' } as const, EMPTY_SNAP, { shape: 'snap-1' })
const runA = atom({ plugin: 'cache-expiry-handoff', key: 'run' } as const, IDLE_RUN, { shape: 'run-1' })
const logA = atom({ plugin: 'cache-expiry-handoff', key: 'log' } as const, [], { shape: 'log-1' })
const nowA = atom({ plugin: 'cache-expiry-handoff', key: 'now' } as const, 0)
const skillsA = atom({ plugin: 'cache-expiry-handoff', key: 'skills' } as const, [])

// ---------- state helpers ----------

const patchRun = ($: $, patch: Partial<CacheRun>) => update($, runA, r => ({ ...r, ...patch }))

async function log($: $, kind: CacheLogKind, text: string) {
  const at = await $.clock.now()
  await update($, logA, list => pushLog(list, { at, kind, text }))
}

// The snapshot is also kept in the store under the session id, so a reload or a
// resumed session starts from the last request instead of an empty band.
let sessionId = ''

async function setSnap($: $, change: (v: CacheSnapshot) => CacheSnapshot) {
  const next = await update($, snapA, change)
  if (!sessionId) return
  const saved = await $.store.get('snaps')
  const all: Record<string, CacheSnapshot> =
    saved !== null && typeof saved === 'object' ? { ...(saved as Record<string, CacheSnapshot>) } : {}
  if (next.lastAt === 0) delete all[sessionId]
  else all[sessionId] = next
  const kept = Object.entries(all)
    .sort((a, b) => b[1].lastAt - a[1].lastAt)
    .slice(0, 30)
  await $.store.set('snaps', Object.fromEntries(kept))
}

async function restoreSnap($: $): Promise<boolean> {
  const cur = await read($, snapA)
  if (cur.lastAt > 0 || !sessionId) return cur.lastAt > 0
  const saved = await $.store.get('snaps')
  const one = saved !== null && typeof saved === 'object' ? (saved as Record<string, unknown>)[sessionId] : undefined
  if (one === null || typeof one !== 'object') return false
  const snap = { ...EMPTY_SNAP, ...(one as Partial<CacheSnapshot>) }
  if (typeof snap.lastAt !== 'number' || snap.lastAt <= 0) return false
  await update($, snapA, () => snap)
  return true
}

async function setSettings($: $, patch: Partial<CacheSettings>) {
  let next = DEFAULT_SETTINGS
  await update($, settingsA, s => (next = normalizeSettings({ ...s, ...patch })))
  await $.store.set('settings', next)
}

async function alert($: $, s: CacheSettings, text: string) {
  if (s.toast) $.ui.toast(text)
  if (s.systemNotify) void $.ui.notify(text, { title: 'Prompt cache' }).catch(() => undefined)
}

async function refreshSkills($: $) {
  const list = await $.command.list()
  const names = list
    .filter(c => c.source === 'user' || c.source === 'plugin')
    .map(c => c.name)
    .filter(n => n !== COMMAND)
  const rank = (n: string) => (/hand-?off/i.test(n) ? 0 : 1)
  const sorted = [...new Set(names)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).slice(0, 300)
  await update($, skillsA, () => sorted)
}

// ---------- actions ----------

async function warmNow($: $, s: CacheSettings, isManual = false) {
  await patchRun($, { isActing: true })
  try {
    const r = await $.model.fork({ prompt: PING_PROMPT })
    const at = await $.clock.now()
    if (r.isAnswered && r.usage.cache_read_input_tokens > 0) {
      const readTokens = r.usage.cache_read_input_tokens
      await setSnap($, v => ({ ...v, lastAt: at }))
      await update($, runA, (v): CacheRun => ({ ...v, pings: v.pings + 1, pingRead: v.pingRead + readTokens, phase: 'warming' }))
      const wrote = r.usage.cache_creation_input_tokens
      await log($, 'warm', `Kept warm · read ${fmtTokens(readTokens)}${wrote > 1000 ? ` · wrote ${fmtTokens(wrote)}` : ''}`)
      if (isManual) $.ui.toast(`Cache kept warm: ${fmtTokens(readTokens)} tokens, timer reset`)
      return true
    }
    const why = r.isAnswered ? 'the cache had already lapsed' : r.reason.replace(/-/g, ' ')
    await log($, 'error', `Keep-warm failed: ${why}`)
    await patchRun($, { armed: false, phase: 'stopped' })
    await alert($, s, `Couldn't keep the prompt cache warm (${why}).`)
    return false
  } finally {
    await patchRun($, { isActing: false })
  }
}

async function handOffNow($: $, s: CacheSettings) {
  await patchRun($, { isActing: true, armed: false })
  try {
    if (s.toast) $.ui.toast(`Cache expires soon: running /${s.skill}`)
    await $.command.run({ command: s.skill, args: s.skillArgs })
    await patchRun($, { phase: 'handed-off' })
    await log($, 'handoff', `Ran /${s.skill}`)
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    await log($, 'error', `/${s.skill} did not run: ${why.slice(0, 120)}`)
    await patchRun($, { phase: 'notified' })
    await alert($, s, `Couldn't run /${s.skill}. The prompt cache expires soon: send a message to keep it.`)
  } finally {
    await patchRun($, { isActing: false })
  }
}

async function tick($: $) {
  const [s, snap, run] = await Promise.all([read($, settingsA), read($, snapA), read($, runA)])
  const now = await $.clock.now()
  if (snap.lastAt > 0) await update($, nowA, () => now)
  const action = decide(now, s, snap, run)
  const tokens = fmtTokens(prefixTokens(snap))
  switch (action.kind) {
    case 'none':
      return
    case 'expired':
      await patchRun($, { expiredFor: snap.lastAt, armed: false, phase: run.phase === 'handed-off' ? 'handed-off' : 'idle' })
      await log($, 'expired', `Cache expired · ${tokens} tokens`)
      if (s.toast && run.phase !== 'handed-off') $.ui.toast(`Prompt cache expired: the next message rewrites ${tokens} tokens`)
      return
    case 'notify': {
      await patchRun($, { armed: false, phase: 'notified' })
      const left = fmtClock(remainingMs(now, s, snap))
      const why =
        action.reason === 'budget' ? ` Keep-warm stopped after ${fmtDuration(s.warmForMin * 60)} idle.` : ''
      await log($, 'notify', `Notified · ${left} left${why ? ' · keep-warm budget used' : ''}`)
      await alert($, s, `Prompt cache expires in ${left}: send a message to keep ${tokens} tokens cached.${why}`)
      return
    }
    case 'warm':
      await warmNow($, s)
      return
    case 'handoff':
      await handOffNow($, s)
      return
  }
}

// ---------- the module ----------

let ticker: Timer | undefined
let explicit: ExplicitTtl

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    sessionId = await $.session.id()
    const restored = await restoreSnap($)
    const stored = await $.store.get('settings')
    await update($, settingsA, () => normalizeSettings(stored))
    explicit = explicitTtl({
      force5m: await $.env.get('FORCE_PROMPT_CACHING_5M'),
      enable1h: await $.env.get('ENABLE_PROMPT_CACHING_1H'),
      ttlVar: await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL'),
      setting: await $.settings.read({ key: 'promptCacheTtl' }),
    })
    await $.command.register({
      name: COMMAND,
      description: 'Prompt cache: countdown, before-expiry action and settings',
      argumentHint: '[warm | handoff | pause | resume | mode <notify|warm|handoff|warm-handoff>]',
    })
    ticker?.cancel()
    ticker = $.clock.every(1000, () => void tick($).catch(() => undefined))
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await setSnap($, () => EMPTY_SNAP)
      await update($, runA, r => ({ ...IDLE_RUN, paused: r.paused }))
      await update($, logA, () => [])
    }
    return next(e)
  })

  // Every model request of the main thread reads or writes the cache: record it.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const u = result.usage
    if (e.agentId === undefined && u) {
      const now = await $.clock.now()
      const prev = await read($, snapA)
      const { rateLimits } = await $.session.usage()
      const usage = {
        read: u.cache_read_input_tokens,
        wrote: u.cache_creation_input_tokens,
        fresh: u.input_tokens,
        model: u.model,
      }
      const ttl = inferTtl(prev, usage, now, explicit, rateLimits.map(r => r.kind))
      if (prev.lastAt > 0 && (ttl.ms !== prev.autoTtlMs || ttl.source !== prev.autoTtlSource)) {
        await log($, 'ttl', `Cache lifetime: ${fmtTtl(ttl.ms)} (${ttl.source})`)
      }
      await setSnap($, () => ({ lastAt: now, ...usage, autoTtlMs: ttl.ms, autoTtlSource: ttl.source }))
      await update($, nowA, () => now)
    }
    return result
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) await patchRun($, { isWorking: true })
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) await patchRun($, { isWorking: false })
    return next(e)
  })

  // A person's message arms the before-expiry action; the optional guard asks before a cold send.
  on('prompt.submit', async ($, e, next) => {
    const origin = e.origin as { kind: string; name?: string } | undefined
    const isOwn = origin?.kind === 'plugin' && origin.name === $.plugin.name
    if (isOwn) return next(e)
    const now = await $.clock.now()
    const [s, snap] = await Promise.all([read($, settingsA), read($, snapA)])
    const tokens = prefixTokens(snap)
    const isCold = snap.lastAt > 0 && remainingMs(now, s, snap) <= 0
    if (s.guard && isCold && e.command === undefined && tokens >= Math.max(s.minTokens, 1)) {
      const ttl = ttlMs(s, snap)
      const answer = await $.ui.ask(
        `The prompt cache expired ${fmtAgo(now - snap.lastAt - ttl)}. This message rewrites ${fmtTokens(tokens)} tokens, about ${coldMultiple(ttl)}× what reading them from a warm cache costs.`,
        { header: 'Cache', options: ['Send anyway', "Don't send"] },
      )
      if (answer === "Don't send") {
        await log($, 'guard', `Held a cold send of ${fmtTokens(tokens)} tokens`)
        return { drop: 'Not sent: the prompt cache had expired. /compact or /clear first makes the rewrite smaller.' }
      }
    }
    await patchRun($, { armed: true, activeSince: now, phase: 'idle' })
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: COMMAND }, async ($, e) => {
    const [sub = '', arg = ''] = e.args.trim().split(/\s+/)
    const s = await read($, settingsA)
    switch (sub.toLowerCase()) {
      case '':
      case 'settings':
        await refreshSkills($)
        await $.ui.open({ id: PANE, title: 'Prompt cache', focus: true, closeOnEscape: true, rows: 30, columns: 64 })
        return { text: await statusText($) }
      case 'warm':
        return { text: (await warmNow($, s, true)) ? 'Kept the prompt cache warm.' : 'Keep-warm failed; see /cache-expiry.' }
      case 'handoff':
        await handOffNow($, s)
        return { text: `Ran /${s.skill}.` }
      case 'pause':
        await patchRun($, { paused: true })
        return { text: 'Cache actions paused for this session.' }
      case 'resume':
        await patchRun($, { paused: false })
        return { text: 'Cache actions resumed.' }
      case 'mode': {
        const mode = MODES.find(m => m.value === arg)
        if (!mode) return { text: `Modes: ${MODES.map(m => m.value).join(', ')}` }
        await setSettings($, { mode: mode.value })
        return { text: `Before expiry: ${mode.label}.` }
      }
      case 'status':
        return { text: await statusText($) }
      default:
        return { text: 'Usage: /cache-expiry [warm | handoff | pause | resume | status | mode <notify|warm|handoff|warm-handoff>]' }
    }
  })

  // ---------- the band above the prompt ----------

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const snap = await read($, snapA)
    if (snap.lastAt === 0) return next(e)
    const [s, run, tickNow] = await Promise.all([read($, settingsA), read($, runA), read($, nowA)])
    const now = Math.max(tickNow, snap.lastAt)
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui

    const ttl = ttlMs(s, snap)
    const left = remainingMs(now, s, snap)
    const lead = leadMs(s, ttl)
    const isLive = e.props.isWorking || run.isWorking
    const isCold = !isLive && left <= 0
    const tone = run.paused ? 'subtle' : isCold ? 'error' : !isLive && left <= lead ? 'warning' : 'success'
    const fill = isLive ? 1 : Math.max(0, Math.min(1, left / ttl))
    const hit = Math.round(hitRate(snap) * 100)
    const tokens = fmtTokens(prefixTokens(snap))

    const time = isLive ? 'in use' : isCold ? `expired ${fmtAgo(-left)}` : fmtClock(left)
    const meta = isCold
      ? `next message rewrites ${tokens} tokens`
      : `${fmtTtlShort(ttl)} · ${hit}% hit · ${tokens} cached`
    const plan = planText(s, run, lead)

    const bar =
      e.surface === 'desktop' && 'Svg' in ui ? (
        <ui.Svg source={barSvg(fill, tone)} alt={`${Math.round(fill * 100)}% of the cache lifetime left`} width={88} height={6} />
      ) : (
        <Text>
          <Text color={tone}>{'█'.repeat(Math.round(fill * 12))}</Text>
          <Text dimColor>{'░'.repeat(12 - Math.round(fill * 12))}</Text>
        </Text>
      )

    // The label, bar and time keep their size; only the details shrink, then truncate.
    return (
      <Box flexDirection="row" gap={1} alignItems="center">
        <Box flexDirection="row" gap={1} flexShrink={0} alignItems="center">
          <Text color={tone}>●</Text>
          <Text weight="semibold">Cache</Text>
          <Box flexShrink={0} width={e.surface === 'terminal' ? 12 : undefined}>
            {bar}
          </Box>
          <Text tabular color={isCold ? 'error' : undefined} wrap="truncate-end">
            {time}
          </Text>
        </Box>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Text dimColor wrap="truncate-end">
            {meta}
            {plan ? ` · ${plan}` : ''}
          </Text>
        </Box>
        <Box flexShrink={0}>
          <Button key="open" label="Settings" dimColor onPress={() => openPane($)} />
        </Box>
      </Box>
    )
  })

  // ---------- the settings pane ----------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const [s, snap, run, logs, tickNow, skills] = await Promise.all([
      read($, settingsA),
      read($, snapA),
      read($, runA),
      read($, logA),
      read($, nowA),
      read($, skillsA),
    ])
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const Select = 'Select' in ui ? ui.Select : undefined
    const Input = 'Input' in ui ? ui.Input : undefined
    const now = Math.max(tickNow, snap.lastAt)
    const width = Math.min(e.props.bodyColumns, 72)
    const ttl = ttlMs(s, snap)
    const lead = leadMs(s, ttl)
    const left = remainingMs(now, s, snap)
    const isLive = run.isWorking
    const hasData = snap.lastAt > 0

    const set = (patch: Partial<CacheSettings>) => () => void setSettings($, patch)

    const segmented = <T extends string>(key: string, options: readonly { value: T; label: string }[], value: T, pick: (v: T) => void) => (
      <Box flexDirection="row" flexWrap="wrap" columnGap={1} rowGap={0}>
        {options.map(o => (
          <Button key={`${key}:${o.value}`} label={o.label} variant={o.value === value ? 'primary' : 'secondary'} onPress={() => pick(o.value)} />
        ))}
      </Box>
    )
    const onOff = (key: string, value: boolean, field: 'toast' | 'systemNotify' | 'guard') =>
      segmented(key, [{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }] as const, value ? 'on' : 'off', v =>
        void setSettings($, { [field]: v === 'on' }),
      )
    // Labels centre on their control; a hint sits under the control, not under the pair.
    const labelWidth = e.surface === 'terminal' ? 18 : 13
    const row = (label: string, control: RenderChildren, hint?: string) => (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={2} alignItems="center">
          <Box width={labelWidth} flexShrink={0}>
            <Text dimColor>{label}</Text>
          </Box>
          <Box flexShrink={1}>{control}</Box>
        </Box>
        {hint ? (
          <Box marginLeft={labelWidth + 2}>
            <Text dimColor size="footnote">
              {hint}
            </Text>
          </Box>
        ) : null}
      </Box>
    )
    const select = (key: string, options: { value: string; label: string }[], value: string, pick: (v: string) => void) =>
      Select ? (
        <Box width={Math.max(...options.map(o => o.label.length)) + 6}>
          <Select key={key} options={options} value={value} onSelect={pick} />
        </Box>
      ) : (
        <Text>{options.find(o => o.value === value)?.label ?? value}</Text>
      )

    const isWarm = s.mode === 'warm' || s.mode === 'warm-handoff'
    const isHandoff = s.mode === 'handoff' || s.mode === 'warm-handoff'

    const leadOptions = [15, 30, 60, 120, 180, 300, 600, 900].map(v => ({ value: String(v), label: `${fmtDuration(v)} before` }))
    if (!leadOptions.some(o => o.value === String(s.leadSec))) leadOptions.push({ value: String(s.leadSec), label: `${fmtDuration(s.leadSec)} before` })
    const warmOptions = [15, 30, 60, 120, 240, 480, 1440].map(v => ({ value: String(v), label: fmtDuration(v * 60) }))
    if (!warmOptions.some(o => o.value === String(s.warmForMin))) warmOptions.push({ value: String(s.warmForMin), label: fmtDuration(s.warmForMin * 60) })
    const minOptions = [0, 10_000, 20_000, 50_000, 100_000].map(v => ({ value: String(v), label: v === 0 ? 'Any size' : `${fmtTokens(v)} tokens` }))
    if (!minOptions.some(o => o.value === String(s.minTokens))) minOptions.push({ value: String(s.minTokens), label: `${fmtTokens(s.minTokens)} tokens` })
    // A Select takes at most 64 options: handoff-like skills rank first, and the chosen one always stays.
    const shown = skills.slice(0, 64)
    const skillNames = shown.includes(s.skill) ? shown : [s.skill, ...shown.slice(0, 63)]
    const skillOptions = skillNames.map(n => ({
      value: n,
      label: `/${n}${skills.length > 0 && !skills.includes(n) ? ' (not found)' : ''}`,
    }))
    const isSkillMissing = skills.length > 0 && !skills.includes(s.skill)
    const isCapped = s.leadSec * 1000 > lead

    const ttlOptions: { value: CacheTtlChoice; label: string }[] = [
      { value: 'auto', label: 'Auto' },
      { value: '5m', label: '5 min' },
      { value: '1h', label: '1 hour' },
    ]

    const status = !hasData
      ? 'Waiting for the first reply'
      : isLive
        ? 'In use'
        : left <= 0
          ? `Expired ${fmtAgo(-left)}`
          : `${fmtClock(left)} left`
    const tone = !hasData ? 'subtle' : isLive ? 'success' : left <= 0 ? 'error' : left <= lead ? 'warning' : 'success'

    // Terminal rows sit tight so the pane fits inline above the prompt; graphical surfaces get air.
    const rowGap = e.surface === 'terminal' ? 0 : 1
    const warmLabel = run.isActing ? 'Working…' : 'Warm now'

    return (
      <Box flexDirection="column" gap={1} width={width}>
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1} alignItems="center">
            <Text color={tone}>●</Text>
            <Text size="heading" weight="semibold" tabular>
              {status}
            </Text>
          </Box>
          {hasData ? (
            <Text dimColor wrap="truncate-end">
              {fmtTtl(ttl)} cache ({ttlSource(s, snap)}) · {Math.round(hitRate(snap) * 100)}% hit · {fmtTokens(prefixTokens(snap))} tokens
            </Text>
          ) : null}
          {hasData ? (
            <Text dimColor wrap="truncate-end">
              Last reply {fmtAgo(now - snap.lastAt)} · {planText(s, run, lead) || 'nothing scheduled'}
            </Text>
          ) : null}
        </Box>

        <Box flexDirection="column" gap={0}>
          <Box flexDirection="row" flexWrap="wrap" gap={1}>
            {hasData ? <Button key="warm-now" label={warmLabel} variant="primary" onPress={() => void warmNow($, s, true)} /> : null}
            <Button key="handoff-now" label={`Run /${s.skill}`} onPress={() => void handOffNow($, s)} />
            <Button key="pause" label={run.paused ? 'Resume' : 'Pause'} onPress={() => void patchRun($, { paused: !run.paused })} />
          </Box>
          {logs.slice(0, 3).map((l: CacheLogEntry, i: number) => (
            <Box flexDirection="row" gap={2}>
              <Box width={9} flexShrink={0}>
                <Text dimColor tabular>
                  {fmtAgo(now - l.at)}
                </Text>
              </Box>
              <Text color={l.kind === 'error' ? 'error' : undefined} dimColor={i > 0} wrap="truncate-end">
                {l.text}
              </Text>
            </Box>
          ))}
          {run.pings > 0 ? (
            <Text dimColor wrap="truncate-end">
              Kept warm {run.pings}× · {fmtTokens(run.pingRead)} cached tokens read ≈ {fmtTokens(Math.round(run.pingRead / 10))} at full price
            </Text>
          ) : null}
        </Box>

        <Box flexDirection="column" gap={rowGap}>
          <Text weight="semibold">Before it expires</Text>
          {row(
            'Action',
            segmented('mode', ACTIONS, isWarm ? 'warm' : s.mode, (v: CacheMode) =>
              void setSettings($, { mode: v === 'warm' && s.mode === 'warm-handoff' ? 'warm-handoff' : v }),
            ),
          )}
          {row(
            'When',
            select('lead', leadOptions, String(s.leadSec), v => void setSettings($, { leadSec: Number(v) })),
            isCapped ? `Capped at ${fmtClock(lead)} before for a ${fmtTtl(ttl)} cache.` : undefined,
          )}
          {isWarm
            ? row(
                'Keep warm for',
                select('warmFor', warmOptions, String(s.warmForMin), v => void setSettings($, { warmForMin: Number(v) })),
              )
            : null}
          {isWarm
            ? row(
                'Then',
                segmented('then', THEN, s.mode, (v: CacheMode) => void setSettings($, { mode: v })),
              )
            : null}
          {isHandoff
            ? row(
                'Handoff skill',
                select('skill', skillOptions, s.skill, v => void setSettings($, { skill: v })),
                isSkillMissing ? `No /${s.skill} in this session.` : undefined,
              )
            : null}
          {isHandoff && Input
            ? row(
                'Instructions',
                <Input key="args" value={s.skillArgs} placeholder="Arguments for the skill" rows={2} submitLabel="save" onSubmit={v => void setSettings($, { skillArgs: v })} />,
              )
            : null}
          {s.mode !== 'notify'
            ? row(
                'Only above',
                select('min', minOptions, String(s.minTokens), v => void setSettings($, { minTokens: Number(v) })),
                'Smaller contexts get a notification instead.',
              )
            : null}
        </Box>

        <Box flexDirection="column" gap={rowGap}>
          <Text weight="semibold">Cache</Text>
          {row(
            'Lifetime',
            segmented('ttl', ttlOptions, s.ttl, (v: CacheTtlChoice) => void setSettings($, { ttl: v })),
            s.ttl === 'auto' ? `Detected: ${fmtTtl(snap.autoTtlMs)} (${snap.autoTtlSource})` : undefined,
          )}
          {row('Toasts', onOff('toast', s.toast, 'toast'))}
          {row('System alerts', onOff('system', s.systemNotify, 'systemNotify'))}
          {row('Confirm cold send', onOff('guard', s.guard, 'guard'))}
        </Box>
      </Box>
    )
  })
}

// ---------- shared view helpers ----------

async function openPane($: $) {
  await refreshSkills($)
  await $.ui.open({ id: PANE, title: 'Prompt cache', focus: true, closeOnEscape: true, rows: 30, columns: 64 })
}

function planText(s: CacheSettings, run: CacheRun, lead: number): string {
  if (run.paused) return 'paused'
  if (run.phase === 'handed-off') return `handed off to /${s.skill}`
  if (run.phase === 'notified') return 'you were notified'
  if (run.phase === 'stopped') return 'keep-warm stopped'
  const warmed = run.phase === 'warming' && run.pings > 0 ? `kept warm ×${run.pings}` : ''
  if (!run.armed) return warmed
  const at = fmtClock(lead)
  const action =
    s.mode === 'notify'
      ? `notifies at ${at}`
      : s.mode === 'handoff'
        ? `/${s.skill} at ${at}`
        : `warms at ${at}`
  return warmed ? `${warmed} · ${action}` : action
}

const TONE_HEX: Record<string, string> = {
  success: '#34C759',
  warning: '#FF9F0A',
  error: '#FF3B30',
  subtle: '#8E8E93',
}

function barSvg(fill: number, tone: string): string {
  const w = 88
  const filled = Math.max(fill > 0 ? 3 : 0, Math.round(fill * w))
  const color = TONE_HEX[tone] ?? TONE_HEX.success
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="6" viewBox="0 0 ${w} 6"><rect width="${w}" height="6" rx="3" fill="#8E8E93" fill-opacity="0.28"/><rect width="${filled}" height="6" rx="3" fill="${color}"/></svg>`
}

async function statusText($: $): Promise<string> {
  const [s, snap, run] = await Promise.all([read($, settingsA), read($, snapA), read($, runA)])
  if (snap.lastAt === 0) return 'Prompt cache: waiting for the first reply.'
  const now = await $.clock.now()
  const ttl = ttlMs(s, snap)
  const left = remainingMs(now, s, snap)
  const mode = MODES.find(m => m.value === s.mode)?.label ?? s.mode
  const when = left > 0 ? `${fmtClock(left)} left` : `expired ${fmtAgo(-left)}`
  return `Prompt cache: ${when} of ${fmtTtl(ttl)} (${ttlSource(s, snap)}), ${fmtTokens(prefixTokens(snap))} tokens, ${Math.round(hitRate(snap) * 100)}% hit. Before expiry: ${mode}, ${fmtDuration(Math.round(leadMs(s, ttl) / 1000))} before.${run.paused ? ' Paused.' : ''}`
}
