// The state contract of the cache-expiry-handoff mod.

/** What the mod does when the prompt cache is about to expire. */
export type CacheMode = 'notify' | 'warm' | 'handoff' | 'warm-handoff'

/** The cache lifetime: detected, or fixed by the person. */
export type CacheTtlChoice = 'auto' | '5m' | '1h'

export type CacheSettings = {
  mode: CacheMode
  /** Seconds before expiry the action runs. */
  leadSec: number
  /** Minutes of idle time keep-warm covers before it stops (or hands off). */
  warmForMin: number
  /** Slash command or skill run by the handoff modes, without the slash. */
  skill: string
  /** Arguments passed to the handoff skill. */
  skillArgs: string
  ttl: CacheTtlChoice
  /** Contexts smaller than this are not kept warm or handed off. */
  minTokens: number
  toast: boolean
  systemNotify: boolean
  /** Ask before sending a message that would rewrite an expired cache. */
  guard: boolean
  /** What happens once the handoff skill's turn finishes: keep the session, or /clear it. */
  afterHandoff: 'stay' | 'clear'
}

/** The main thread's last model request, as the cache sees it. */
export type CacheSnapshot = {
  /** `$.clock.now()` of the last request that touched the cache; 0 before any. */
  lastAt: number
  read: number
  wrote: number
  fresh: number
  model: string
  /** The detected lifetime and why. */
  autoTtlMs: number
  autoTtlSource: string
}

export type CacheRun = {
  /** True after a person's prompt; an action disarms it until the next one. */
  armed: boolean
  /** When the person last sent something: keep-warm counts its budget from here. */
  activeSince: number
  pings: number
  pingRead: number
  isWorking: boolean
  isActing: boolean
  paused: boolean
  /** The `lastAt` an expiry was already reported for. */
  expiredFor: number
  /** True from running the handoff skill until its turn completes. */
  handoffPending?: boolean
  /** What the mod will or did do, for the band. */
  phase: 'idle' | 'warming' | 'handed-off' | 'notified' | 'stopped'
}

/**
 * The server-side experiment Claude Code has cached for the session's model
 * (`data.atis` of its client-data slot in ~/.claude.json). Only the first
 * three characters of the ID are kept.
 */
export type CacheExperiment = {
  /** `active`: an ID is cached; `none`: the slot has no ID; `unknown`: no slot or unreadable. */
  state: 'active' | 'none' | 'unknown'
  id: string
  model: string
  /** When Claude Code last cached the slot; 0 when unknown. */
  updatedAt: number
  /** When this mod first saw this ID for this model; 0 when not active. */
  firstSeenAt: number
}

export type CacheLogKind = 'warm' | 'handoff' | 'notify' | 'expired' | 'error' | 'guard' | 'ttl'

export type CacheLogEntry = { at: number; kind: CacheLogKind; text: string }

declare module 'claude-code' {
  interface PluginState {
    'cache-expiry-handoff': {
      settings: Shaped<CacheSettings>
      snap: Shaped<CacheSnapshot>
      run: Shaped<CacheRun>
      log: Shaped<CacheLogEntry[]>
      now: number
      skills: string[]
      exp: CacheExperiment
    }
  }
}
