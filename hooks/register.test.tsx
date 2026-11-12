import { describe, expect, test } from 'claude-code/testing'

import {
  DEFAULT_SETTINGS,
  EMPTY_SNAP,
  IDLE_RUN,
  MIN,
  TTL_1H,
  TTL_5M,
  decide,
  experimentRow,
  fmtModel,
  inferTtl,
  leadMs,
  liveRecord,
  nextAction,
  normalizeSettings,
  readExperiment,
  rowNotes,
  schedule,
} from './logic'

const NOW = 10_000_000

const snap = (over = {}) => ({ ...EMPTY_SNAP, lastAt: NOW, read: 150_000, wrote: 2_000, fresh: 300, model: 'm', ...over })
const run = (over = {}) => ({ ...IDLE_RUN, armed: true, activeSince: NOW, ...over })

describe('companion status', () => {
  test('names the next action and when it runs', async () => {
    const s = { ...DEFAULT_SETTINGS, mode: 'warm-handoff' as const, warmForMin: 30, leadSec: 120 }
    expect(nextAction(s, snap(), run())).toEqual({ kind: 'warm', at: NOW + TTL_5M - 2 * MIN })
    expect(nextAction(s, snap(), run({ activeSince: NOW - 40 * MIN }))).toEqual({ kind: 'handoff', at: NOW + TTL_5M - 2 * MIN })
    expect(nextAction({ ...s, mode: 'handoff' }, snap({ read: 5_000 }), run())?.kind).toBe('notify')
  })

  test('has no next action mid-turn, paused or once acted', async () => {
    expect(nextAction(DEFAULT_SETTINGS, snap(), run({ isWorking: true }))).toBe(null)
    expect(nextAction(DEFAULT_SETTINGS, snap(), run({ paused: true }))).toBe(null)
    expect(nextAction(DEFAULT_SETTINGS, snap(), run({ armed: false }))).toBe(null)
  })

  test('reports expiry, tokens and where the session runs', async () => {
    const live = liveRecord(DEFAULT_SETTINGS, snap({ autoTtlMs: TTL_1H, autoTtlSource: 'subscription' }), run(), {
      sessionId: 'abc',
      cwd: 'C:/p',
      orcaPane: 'tab:pane',
      entrypoint: 'cli',
    })
    expect(live.expiresAt).toBe(NOW + TTL_1H)
    expect(live.tokens).toBe(152_300)
    expect(live.ttlSource).toBe('subscription')
    expect(live.orcaPane).toBe('tab:pane')
    expect(liveRecord(DEFAULT_SETTINGS, EMPTY_SNAP, IDLE_RUN, { sessionId: 'x', cwd: '', orcaPane: '', entrypoint: '' }).expiresAt).toBe(0)
  })
})

describe('decide', () => {
  test('does nothing until the lead time', async () => {
    expect(decide(NOW + 2 * MIN, DEFAULT_SETTINGS, snap(), run()).kind).toBe('none')
  })

  test('notifies once inside the lead time, then waits for the person', async () => {
    const at = NOW + TTL_5M - 50_000
    expect(decide(at, DEFAULT_SETTINGS, snap(), run()).kind).toBe('notify')
    expect(decide(at, DEFAULT_SETTINGS, snap(), run({ armed: false })).kind).toBe('none')
  })

  test('keeps warm inside the idle budget, then hands off', async () => {
    const s = { ...DEFAULT_SETTINGS, mode: 'warm-handoff' as const, warmForMin: 30 }
    const at = NOW + TTL_5M - 50_000
    expect(decide(at, s, snap(), run()).kind).toBe('warm')
    expect(decide(at, s, snap(), run({ activeSince: NOW - 40 * MIN })).kind).toBe('handoff')
  })

  test('only notifies for a small context', async () => {
    const s = { ...DEFAULT_SETTINGS, mode: 'handoff' as const }
    expect(decide(NOW + TTL_5M - 50_000, s, snap({ read: 5_000 }), run()).kind).toBe('notify')
  })

  test('reports an expiry once and never acts while a turn runs', async () => {
    const at = NOW + TTL_5M + 1
    expect(decide(at, DEFAULT_SETTINGS, snap(), run()).kind).toBe('expired')
    expect(decide(at, DEFAULT_SETTINGS, snap(), run({ expiredFor: NOW })).kind).toBe('none')
    expect(decide(NOW + TTL_5M - 50_000, DEFAULT_SETTINGS, snap(), run({ isWorking: true })).kind).toBe('none')
  })

  test('keeps the lead inside the lifetime', async () => {
    expect(leadMs({ ...DEFAULT_SETTINGS, leadSec: 600 }, TTL_5M)).toBe(TTL_5M - 30_000)
  })
})

describe('inferTtl', () => {
  const usage = { read: 150_000, wrote: 500, fresh: 100, model: 'm' }

  test('a hit after a long gap proves a 1-hour cache', async () => {
    expect(inferTtl(snap(), usage, NOW + 20 * MIN, undefined, []).source).toBe('observed')
    expect(inferTtl(snap(), usage, NOW + 20 * MIN, undefined, []).ms).toBe(TTL_1H)
  })

  test('a subscription or Claude sign-in reads as 1 hour, an API key as 5 minutes', async () => {
    expect(inferTtl(snap(), usage, NOW + MIN, undefined, ['five_hour']).ms).toBe(TTL_1H)
    expect(inferTtl(snap(), usage, NOW + MIN, undefined, [], true).ms).toBe(TTL_5M)
    expect(inferTtl(snap(), usage, NOW + MIN, undefined, []).ms).toBe(TTL_1H)
  })

  test('an explicit setting wins', async () => {
    const explicit = { ms: TTL_5M, source: 'FORCE_PROMPT_CACHING_5M' }
    expect(inferTtl(snap(), usage, NOW + 20 * MIN, explicit, ['five_hour']).ms).toBe(TTL_5M)
  })
})

const BAND = {
  plugin: 'cache-expiry-handoff',
  component: 'AbovePrompt',
  requestId: 'band',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const STORED: Record<string, unknown> = {
  snap: { shape: 'snap-1', value: snap({ autoTtlMs: TTL_5M, autoTtlSource: 'API default' }) },
  run: { shape: 'run-1', value: run() },
  settings: { shape: 'settings-1', value: DEFAULT_SETTINGS },
  now: NOW + 2 * MIN,
  exp: { state: 'active', id: '34e', model: 'claude-opus-5-5', updatedAt: NOW, firstSeenAt: NOW },
}

describe('experiment', () => {
  const slot = (over: Record<string, unknown>) => ({ model: 'claude-opus-5-5', org: 'o1', entrypoint: 'cli', at: 1, data: {}, ...over })
  const config = (...slots: Record<string, unknown>[]) => ({
    oauthAccount: { organizationUuid: 'o1' },
    clientDataCacheSlots: Object.fromEntries(slots.map((s, i) => [`k${i}`, s])),
  })

  test('takes the newest slot of the model and org, keeping three characters', async () => {
    const c = config(
      slot({ at: 5, data: { atis: '34e0aa11ff' } }),
      slot({ at: 9, data: { atis: 'eab0bb22ee' } }),
      slot({ at: 99, org: 'other', data: { atis: '763' } }),
      slot({ at: 99, model: 'claude-haiku-5-5', data: { atis: 'dba' } }),
    )
    expect(readExperiment(c, 'claude-opus-5-5[1m]', 'cli')).toEqual({
      state: 'active',
      id: 'eab',
      model: 'claude-opus-5-5',
      updatedAt: 9,
      firstSeenAt: 0,
    })
  })

  test("prefers the session's own entrypoint, and a slot without an ID is no experiment", async () => {
    const c = config(slot({ at: 9, data: { atis: '34e000' } }), slot({ at: 5, entrypoint: 'claude-desktop' }))
    expect(readExperiment(c, 'claude-opus-5-5', 'claude-desktop').state).toBe('none')
    expect(readExperiment(c, 'claude-opus-5-5', 'sdk-ts').id).toBe('34e')
  })

  test('no slot, or no config, is unknown', async () => {
    expect(readExperiment(config(), 'claude-opus-5-5', 'cli').state).toBe('unknown')
    expect(readExperiment(null, 'claude-opus-5-5').state).toBe('unknown')
  })

  test('the row names the model and when it was seen', async () => {
    expect(fmtModel('claude-opus-5-5')).toBe('Opus 5.5')
    expect(fmtModel('claude-fable-5-2')).toBe('Fable 5.2')
    expect(experimentRow(NOW + 3 * TTL_1H, { state: 'none', id: '', model: 'claude-opus-5-5', updatedAt: NOW, firstSeenAt: 0 })).toEqual({
      value: 'None',
      note: 'Opus 5.5 · updated 3h 0m ago',
    })
    expect(experimentRow(NOW, { state: 'unknown', id: '', model: '', updatedAt: 0, firstSeenAt: 0 }).value).toBe('Unknown')
  })
})

test('the band shows the countdown on terminal and desktop', async ($, on) => {
  on('state.get', (_, e) => {
    const key = (e as { key: string }).key
    return key in STORED ? { value: { value: STORED[key], version: 1 } } : { value: { value: undefined, version: 0 } }
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /^3:00$/ }))?.text).toBe('3:00')
    expect(await ui.find({ type: 'Text', text: /notifies at 2:00/ })).toBeDefined()
    await ui.unmount()
  }
})

test('the band stays out of the way before the first reply', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await ui.unmount()
})

const PANE = {
  plugin: 'cache-expiry-handoff',
  component: 'Pane',
  requestId: 'cache',
  props: {
    title: 'Prompt cache',
    isFocused: true,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

test('the settings pane draws every mode on terminal and desktop', async ($, on) => {
  let mode = 'notify'
  on('state.get', (_, e) => {
    const key = (e as { key: string }).key
    if (key === 'settings') return { value: { value: { shape: 'settings-1', value: { ...DEFAULT_SETTINGS, mode } }, version: 1 } }
    if (key === 'skills') return { value: { value: ['handoff', 'smart-handoff', ...Array.from({ length: 120 }, (_, i) => `skill-${i}`)], version: 1 } }
    return key in STORED ? { value: { value: STORED[key], version: 1 } } : { value: { value: undefined, version: 0 } }
  })
  for (const m of ['notify', 'warm', 'handoff', 'warm-handoff']) {
    mode = m
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(await ui.find({ type: 'Text', text: /Before it expires/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^3:00 left$/ })).toBeDefined()
      if (m !== 'notify') expect(await ui.find({ key: 'min' })).toBeDefined()
      if (m === 'handoff') expect(await ui.find({ key: 'skill' })).toBeDefined()
      if (m === 'warm') expect(await ui.find({ type: 'Text', text: /^Keeps warm in 1 min$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^34e$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^Opus 5\.5 · first seen / })).toBeDefined()
      await ui.unmount()
    }
  }
})

test('settings keep a valid Afterwards choice and drop a bad one', async () => {
  expect(normalizeSettings({ afterHandoff: 'clear' }).afterHandoff).toBe('clear')
  expect(normalizeSettings({ afterHandoff: 'nuke' }).afterHandoff).toBe('stay')
})

test('a saved lead under 2 minutes rises to 2 minutes', async () => {
  expect(normalizeSettings({ leadSec: 60 }).leadSec).toBe(120)
  expect(normalizeSettings({ leadSec: 300 }).leadSec).toBe(300)
})

describe('schedule and row notes', () => {
  const hour = { ...DEFAULT_SETTINGS, ttl: '1h' as const, mode: 'warm-handoff' as const, warmForMin: 60 }

  test('a 1-hour cache kept warm for 1 h: one keep-warm, then the handoff at 1 h 56 min', async () => {
    const plan = schedule(0, hour, EMPTY_SNAP, IDLE_RUN)
    expect(plan).toEqual({ isLive: false, firstIn: 58 * MIN, pings: 1, thenIn: 116 * MIN })
    const notes = rowNotes(0, hour, EMPTY_SNAP, IDLE_RUN)
    expect(notes.when).toBe('Keeps warm 58 min after each reply')
    expect(notes.then).toBe('Runs /handoff 1 h 56 min after each reply')
  })

  test('a 5-minute cache kept warm for 1 h pings every 3 minutes', async () => {
    expect(schedule(0, { ...hour, ttl: '5m' }, EMPTY_SNAP, IDLE_RUN).pings).toBe(19)
  })

  test('a budget shorter than the cache needs no keep-warm', async () => {
    const notes = rowNotes(0, { ...hour, warmForMin: 15 }, EMPTY_SNAP, IDLE_RUN)
    expect(notes.away).toBe('No keep-warm fits: the 1 hour cache outlasts it.')
    expect(notes.when).toBe('Runs /handoff 58 min after each reply')
    expect(notes.then).toBeUndefined()
  })

  test('a live session counts from now and prices the keep-warms', async () => {
    const notes = rowNotes(NOW + 10 * MIN, hour, snap(), run())
    expect(notes.when).toBe('Keeps warm in 48 min')
    expect(notes.then).toBe('Runs /handoff in 1 h 46 min')
    expect(notes.away).toBe('1 keep-warm ≈ 15k tokens at full price')
    expect(notes.skip).toBe('This session: 152k tokens')
    expect(notes.cold).toBe('Rewriting 152k tokens costs ≈ 20× a warm read.')
  })

  test('a small session only notifies, and a spent action waits for a message', async () => {
    expect(rowNotes(NOW, hour, snap({ read: 5_000, wrote: 0, fresh: 0 }), run()).when).toBe('Notifies you in 58 min')
    expect(rowNotes(NOW, hour, snap(), run({ armed: false })).when).toBe('Waits for your next message.')
    // Mid-turn the last request is older than the message: no countdown from it.
    const midTurn = rowNotes(NOW + 4 * TTL_1H, hour, snap(), run({ activeSince: NOW + 4 * TTL_1H, isWorking: true }))
    expect(midTurn.when).toBe('Keeps warm 58 min after each reply')
    expect(midTurn.away).toBe('1 keep-warm ≈ 15k tokens at full price')
  })
})
