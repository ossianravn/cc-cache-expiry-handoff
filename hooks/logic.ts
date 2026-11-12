// Pure logic of the mod: defaults, the cache lifetime, the decision of what to
// do before expiry, and formatting. No `$` here, so it is easy to test.

import type { CacheExperiment, CacheLive, CacheLogEntry, CacheMode, CacheRun, CacheSettings, CacheSnapshot, CacheTtlChoice } from '../types'

export const MIN = 60_000
export const TTL_5M = 5 * MIN
export const TTL_1H = 60 * MIN

/** The earliest an action may run before expiry: a keep-warm or handoff needs time to finish. */
export const MIN_LEAD_SEC = 120

/** Keep-warm question sent over the session's own transcript (`$.model.fork`). */
export const PING_PROMPT = 'Reply with the single word: warm'

export const DEFAULT_SETTINGS: CacheSettings = {
  mode: 'notify',
  leadSec: MIN_LEAD_SEC,
  warmForMin: 60,
  skill: 'handoff',
  skillArgs:
    'The prompt cache is about to expire. Write the handoff now so a fresh session can continue this work.',
  ttl: 'auto',
  minTokens: 20_000,
  toast: true,
  systemNotify: true,
  guard: false,
  afterHandoff: 'stay',
}

export const EMPTY_SNAP: CacheSnapshot = {
  lastAt: 0,
  read: 0,
  wrote: 0,
  fresh: 0,
  model: '',
  autoTtlMs: TTL_5M,
  autoTtlSource: 'default',
}

export const IDLE_RUN: CacheRun = {
  armed: false,
  activeSince: 0,
  pings: 0,
  pingRead: 0,
  isWorking: false,
  isActing: false,
  paused: false,
  expiredFor: 0,
  phase: 'idle',
}

export const MODES: readonly { value: CacheMode; label: string }[] = [
  { value: 'notify', label: 'Notify' },
  { value: 'warm', label: 'Keep warm' },
  { value: 'handoff', label: 'Hand off' },
  { value: 'warm-handoff', label: 'Warm, then hand off' },
]

const MODE_VALUES = MODES.map(m => m.value) as readonly string[]
const TTL_VALUES: readonly string[] = ['auto', '5m', '1h']

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Reads stored settings, keeping each field only when it has the right shape. */
export function normalizeSettings(raw: unknown): CacheSettings {
  const s = { ...DEFAULT_SETTINGS }
  if (raw === null || typeof raw !== 'object') return s
  const r = raw as Record<string, unknown>
  if (typeof r.mode === 'string' && MODE_VALUES.includes(r.mode)) s.mode = r.mode as CacheMode
  if (isNum(r.leadSec)) s.leadSec = Math.min(Math.max(Math.round(r.leadSec), MIN_LEAD_SEC), 30 * 60)
  if (isNum(r.warmForMin)) s.warmForMin = Math.min(Math.max(Math.round(r.warmForMin), 1), 7 * 24 * 60)
  if (typeof r.skill === 'string' && r.skill.trim()) s.skill = r.skill.trim().replace(/^\//, '')
  if (typeof r.skillArgs === 'string') s.skillArgs = r.skillArgs
  if (typeof r.ttl === 'string' && TTL_VALUES.includes(r.ttl)) s.ttl = r.ttl as CacheTtlChoice
  if (isNum(r.minTokens)) s.minTokens = Math.max(0, Math.round(r.minTokens))
  if (typeof r.toast === 'boolean') s.toast = r.toast
  if (typeof r.systemNotify === 'boolean') s.systemNotify = r.systemNotify
  if (typeof r.guard === 'boolean') s.guard = r.guard
  if (r.afterHandoff === 'stay' || r.afterHandoff === 'clear') s.afterHandoff = r.afterHandoff
  return s
}

export function ttlMs(s: CacheSettings, snap: CacheSnapshot): number {
  if (s.ttl === '5m') return TTL_5M
  if (s.ttl === '1h') return TTL_1H
  return snap.autoTtlMs
}

export function ttlSource(s: CacheSettings, snap: CacheSnapshot): string {
  return s.ttl === 'auto' ? snap.autoTtlSource : 'set by you'
}

/** The lead time, kept inside the cache lifetime so an action never fires right after a reply. */
export function leadMs(s: CacheSettings, ttl: number): number {
  return Math.min(Math.max(s.leadSec, MIN_LEAD_SEC) * 1000, ttl - 30_000)
}

export function prefixTokens(snap: CacheSnapshot): number {
  return snap.read + snap.wrote + snap.fresh
}

export function hitRate(snap: CacheSnapshot): number {
  const total = prefixTokens(snap)
  return total > 0 ? snap.read / total : 0
}

export function remainingMs(now: number, s: CacheSettings, snap: CacheSnapshot): number {
  return snap.lastAt + ttlMs(s, snap) - now
}

/** Explicit lifetime from the environment or settings, when the person set one. */
export type ExplicitTtl = { ms: number; source: string } | undefined

export function explicitTtl(env: {
  force5m?: string
  enable1h?: string
  ttlVar?: string
  setting?: unknown
}): ExplicitTtl {
  const parse = (v: unknown) => {
    if (typeof v !== 'string') return undefined
    const t = v.trim().toLowerCase()
    if (t === '5m' || t === '300' || t === '5min') return TTL_5M
    if (t === '1h' || t === '3600' || t === '60m') return TTL_1H
    return undefined
  }
  const on = (v?: string) => v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false'
  if (on(env.force5m)) return { ms: TTL_5M, source: 'FORCE_PROMPT_CACHING_5M' }
  const fromVar = parse(env.ttlVar)
  if (fromVar) return { ms: fromVar, source: 'CLAUDE_CODE_PROMPT_CACHE_TTL' }
  const fromSetting = parse(env.setting)
  if (fromSetting) return { ms: fromSetting, source: 'promptCacheTtl setting' }
  if (on(env.enable1h)) return { ms: TTL_1H, source: 'ENABLE_PROMPT_CACHING_1H' }
  return undefined
}

export type StepUsage = { read: number; wrote: number; fresh: number; model: string }

/**
 * The detected lifetime after a request: explicit settings first, then what the
 * traffic proves, then the account kind (a subscription reports rate-limit windows).
 */
export function inferTtl(
  prev: CacheSnapshot,
  u: StepUsage,
  now: number,
  explicit: ExplicitTtl,
  rateLimitKinds: readonly string[],
  usesApiBilling = false,
): { ms: number; source: string } {
  if (explicit) return explicit
  const gap = prev.lastAt > 0 ? now - prev.lastAt : 0
  const prevTotal = prefixTokens(prev)
  // A hit after more than five idle minutes can only come from a 1-hour entry.
  if (gap > TTL_5M + 20_000 && u.read >= 1024 && u.wrote < 0.25 * u.read) {
    return { ms: TTL_1H, source: 'observed' }
  }
  if (prev.autoTtlSource === 'observed' && prev.autoTtlMs === TTL_1H) return { ms: TTL_1H, source: 'observed' }
  // A miss 5 to 55 minutes later, same model, same-sized prompt: the entry was 5 minutes.
  if (
    gap > TTL_5M + 20_000 &&
    gap < 55 * MIN &&
    u.model === prev.model &&
    prevTotal > 4096 &&
    u.read < 0.1 * prevTotal &&
    u.read + u.wrote + u.fresh >= 0.8 * prevTotal
  ) {
    return { ms: TTL_5M, source: 'observed' }
  }
  if (prev.autoTtlSource === 'observed') return { ms: prev.autoTtlMs, source: 'observed' }
  if (rateLimitKinds.some(k => k === 'five_hour' || k === 'seven_day')) {
    return { ms: TTL_1H, source: 'subscription' }
  }
  // No rate-limit windows yet: an API key or a cloud provider means 5 minutes,
  // a Claude account sign-in means 1 hour.
  return usesApiBilling ? { ms: TTL_5M, source: 'API key' } : { ms: TTL_1H, source: 'Claude account' }
}

export type Action =
  | { kind: 'none' }
  | { kind: 'expired' }
  | { kind: 'warm' }
  | { kind: 'handoff' }
  | { kind: 'notify'; reason?: string }

/** What to do now. Runs every second; only one action per armed idle stretch, except keep-warm. */
export function decide(now: number, s: CacheSettings, snap: CacheSnapshot, run: CacheRun): Action {
  if (snap.lastAt === 0 || run.paused || run.isWorking || run.isActing) return { kind: 'none' }
  const ttl = ttlMs(s, snap)
  const left = snap.lastAt + ttl - now
  if (left <= 0) return run.expiredFor === snap.lastAt ? { kind: 'none' } : { kind: 'expired' }
  if (!run.armed || left > leadMs(s, ttl)) return { kind: 'none' }

  const isSmall = prefixTokens(snap) < s.minTokens
  const mode = s.mode
  if (mode === 'notify') return { kind: 'notify' }
  if (isSmall) return { kind: 'notify', reason: 'small' }
  if (mode === 'handoff') return { kind: 'handoff' }

  // Keep-warm modes: ping while the idle budget lasts.
  const idleFor = now - run.activeSince
  if (idleFor < s.warmForMin * MIN) return { kind: 'warm' }
  return mode === 'warm-handoff' ? { kind: 'handoff' } : { kind: 'notify', reason: 'budget' }
}

/**
 * When the before-expiry actions will run, as `decide` would run them.
 *
 * Live (armed, with data): counted from now. Otherwise from the end of a reply,
 * assuming the reply came right after the person's message.
 */
export type Schedule = {
  isLive: boolean
  /** Until the first action: from now when live, else from a reply. */
  firstIn: number
  /** Keep-warms still to come before the idle budget runs out (warm modes). */
  pings: number
  /** Until the budget's end, when Then runs (warm modes). */
  thenIn: number
}

/** Armed, idle and counting from a reply: mid-turn the last request predates the message. */
export function isArmedIdle(snap: CacheSnapshot, run: CacheRun): boolean {
  return snap.lastAt > 0 && run.armed && !run.paused && !run.isWorking && snap.lastAt >= run.activeSince
}

export function schedule(now: number, s: CacheSettings, snap: CacheSnapshot, run: CacheRun): Schedule {
  const ttl = ttlMs(s, snap)
  const cycle = ttl - leadMs(s, ttl)
  const isLive = isArmedIdle(snap, run)
  const lastAt = isLive ? snap.lastAt : 0
  const since = isLive ? run.activeSince : 0
  const from = isLive ? now : 0
  // Keep-warms run at lastAt + k·cycle while (that − since) < budget; the first k past it runs Then.
  const k = Math.max(1, Math.ceil((since + s.warmForMin * MIN - lastAt) / cycle))
  return {
    isLive,
    firstIn: Math.max(0, lastAt + cycle - from),
    pings: k - 1,
    thenIn: Math.max(0, lastAt + k * cycle - from),
  }
}

/** The next before-expiry action and when it runs, as `decide` will run it; null when none is due. */
export function nextAction(s: CacheSettings, snap: CacheSnapshot, run: CacheRun): CacheLive['next'] {
  if (!isArmedIdle(snap, run)) return null
  const ttl = ttlMs(s, snap)
  const at = snap.lastAt + ttl - leadMs(s, ttl)
  if (s.mode === 'notify' || prefixTokens(snap) < s.minTokens) return { kind: 'notify', at }
  if (s.mode === 'handoff') return { kind: 'handoff', at }
  if (at - run.activeSince < s.warmForMin * MIN) return { kind: 'warm', at }
  return { kind: s.mode === 'warm-handoff' ? 'handoff' : 'notify', at }
}

/** The status a companion reads; `updatedAt` and `endedAt` are the caller's. */
export function liveRecord(
  s: CacheSettings,
  snap: CacheSnapshot,
  run: CacheRun,
  meta: { sessionId: string; cwd: string; orcaPane: string; entrypoint: string },
): Omit<CacheLive, 'updatedAt' | 'endedAt'> {
  const ttl = ttlMs(s, snap)
  return {
    v: 1,
    ...meta,
    model: snap.model,
    tokens: prefixTokens(snap),
    hit: Math.round(hitRate(snap) * 100) / 100,
    lastAt: snap.lastAt,
    ttlMs: ttl,
    ttlSource: ttlSource(s, snap),
    expiresAt: snap.lastAt > 0 ? snap.lastAt + ttl : 0,
    mode: s.mode,
    next: nextAction(s, snap, run),
    phase: run.phase,
    paused: run.paused,
    working: run.isWorking,
    pings: run.pings,
  }
}

/** The line under each settings row: what that setting will do with this session, now. */
export type RowNotes = {
  when?: string
  away?: string
  then?: string
  afterHandoff?: string
  skip?: string
  cold: string
}

export function rowNotes(now: number, s: CacheSettings, snap: CacheSnapshot, run: CacheRun): RowNotes {
  const ttl = ttlMs(s, snap)
  const lead = leadMs(s, ttl)
  const plan = schedule(now, s, snap, run)
  const hasData = snap.lastAt > 0
  const tokens = prefixTokens(snap)
  const at = (ms: number) => (plan.isLive ? (ms > 0 ? `in ${fmtSpan(ms)}` : 'now') : `${fmtSpan(ms)} after each reply`)
  const skill = `/${s.skill}`
  const isWarm = s.mode === 'warm' || s.mode === 'warm-handoff'
  const isSmall = hasData && tokens < s.minTokens

  const thenVerb = s.mode === 'warm-handoff' ? `Runs ${skill}` : 'Notifies you'
  // With no keep-warm inside the budget, the first thing to run is Then.
  const first =
    s.mode === 'notify' || isSmall
      ? 'Notifies you'
      : s.mode === 'handoff'
        ? `Runs ${skill}`
        : plan.pings === 0
          ? thenVerb
          : 'Keeps warm'
  const capped = s.leadSec * 1000 > lead ? `Capped at ${fmtClock(lead)} for a ${fmtTtl(ttl)} cache. ` : ''
  const when = run.paused
    ? 'Paused for this session.'
    : hasData && !run.armed
      ? 'Waits for your next message.'
      : `${capped}${first} ${at(plan.firstIn)}`

  let away: string | undefined
  let then: string | undefined
  if (isWarm && !isSmall) {
    const n = plan.pings
    away =
      n === 0
        ? `No keep-warm fits: the ${fmtTtl(ttl)} cache outlasts it.`
        : `${n} keep-warm${n === 1 ? '' : 's'}${hasData ? ` ≈ ${fmtTokens(Math.round((n * tokens) / 10))} tokens at full price` : ''}`
    then = run.paused || (hasData && !run.armed) || n === 0 ? undefined : `${thenVerb} ${at(plan.thenIn)}`
  }

  const skip =
    s.mode === 'notify'
      ? undefined
      : hasData
        ? `This session: ${fmtTokens(tokens)} tokens${isSmall ? ', so it only notifies' : ''}`
        : 'Smaller sessions only get a notification.'

  const multiple = coldMultiple(ttl)
  return {
    when,
    away,
    then,
    afterHandoff: s.afterHandoff === 'clear' ? `Runs /clear once ${skill} finishes.` : undefined,
    skip,
    cold: `Rewriting ${hasData ? `${fmtTokens(tokens)} tokens` : 'an expired cache'} costs ≈ ${multiple}× a warm read.`,
  }
}

// ---------- experiment ----------

export const EMPTY_EXP: CacheExperiment = { state: 'unknown', id: '', model: '', updatedAt: 0, firstSeenAt: 0 }

/** `claude-opus-5-5[1m]` → `claude-opus-5-5`: the slots key on the bare model id. */
export const bareModel = (model: string) => model.replace(/\[[^\]]*\]$/, '').trim()

/**
 * The experiment ID cached for `model` in the parsed ~/.claude.json: the newest
 * slot of the signed-in organisation, preferring the session's own entrypoint
 * (`cli`, `claude-desktop`, ...). Only the ID's first three characters leave here.
 */
export function readExperiment(config: unknown, model: string, entrypoint?: string): CacheExperiment {
  const want = bareModel(model)
  if (!want || config === null || typeof config !== 'object') return { ...EMPTY_EXP, model: want }
  const c = config as { oauthAccount?: { organizationUuid?: unknown }; clientDataCacheSlots?: unknown }
  const org = typeof c.oauthAccount?.organizationUuid === 'string' ? c.oauthAccount.organizationUuid : undefined
  const raw = c.clientDataCacheSlots
  type Slot = { model?: unknown; org?: unknown; entrypoint?: unknown; at?: unknown; data?: { atis?: unknown } }
  const slots = (raw !== null && typeof raw === 'object' ? (Object.values(raw) as Slot[]) : []).filter(
    s => s !== null && typeof s === 'object' && s.model === want && (org === undefined || s.org === org),
  )
  const own = slots.filter(s => s.entrypoint === entrypoint)
  const pool = own.length > 0 ? own : slots
  const at = (s: Slot) => (isNum(s.at) ? s.at : 0)
  const newest = pool.reduce<Slot | undefined>((best, s) => (best === undefined || at(s) > at(best) ? s : best), undefined)
  if (!newest) return { ...EMPTY_EXP, model: want }
  const atis = newest.data?.atis
  const id = typeof atis === 'string' ? atis.trim().slice(0, 3) : ''
  return { state: id ? 'active' : 'none', id, model: want, updatedAt: at(newest), firstSeenAt: 0 }
}

/** `claude-opus-5-5` → `Opus 5.5`; anything else as given. */
export function fmtModel(model: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(bareModel(model))
  const [, family = '', major = '', minor] = m ?? []
  if (!family) return model
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${major}${minor ? `.${minor}` : ''}`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `Nov 8`, in the engine's local time. */
export function fmtDay(ms: number): string {
  const d = new Date(ms)
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`
}

/** The Experiment row: its value and the line under it. */
export function experimentRow(now: number, exp: CacheExperiment): { value: string; note: string } {
  const model = exp.model ? fmtModel(exp.model) : 'this model'
  if (exp.state === 'active') {
    return { value: exp.id, note: `${model} · first seen ${fmtDay(exp.firstSeenAt || exp.updatedAt)}` }
  }
  if (exp.state === 'none') {
    return { value: 'None', note: exp.updatedAt > 0 ? `${model} · updated ${fmtAgo(now - exp.updatedAt)}` : model }
  }
  return { value: 'Unknown', note: exp.model ? `Nothing cached for ${model}` : 'Shown after the first reply' }
}

// ---------- formatting ----------

/** A span to the minute: `58 min`, `1 h 56 min`, `24 h`. */
export function fmtSpan(ms: number): string {
  const m = Math.max(1, Math.round(ms / MIN))
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`
}

export function fmtClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const sec = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

export function fmtTokens(n: number): string {
  if (n >= 999_500) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

export function fmtAgo(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m ago`
}

export function fmtDuration(sec: number): string {
  if (sec < 60) return `${sec} s`
  const m = sec / 60
  if (m < 60) return `${Number.isInteger(m) ? m : m.toFixed(1)} min`
  const h = m / 60
  return `${Number.isInteger(h) ? h : h.toFixed(1)} h`
}

export function fmtTtl(ms: number): string {
  return ms >= TTL_1H ? '1 hour' : `${Math.round(ms / MIN)} min`
}

export function fmtTtlShort(ms: number): string {
  return ms >= TTL_1H ? '1h' : `${Math.round(ms / MIN)}m`
}

/** How many times a cache write costs what the same tokens cost read from cache. */
export function coldMultiple(ttl: number): number {
  return ttl >= TTL_1H ? 20 : 12.5
}

export function pushLog(list: readonly CacheLogEntry[], entry: CacheLogEntry): CacheLogEntry[] {
  return [entry, ...list].slice(0, 40)
}
