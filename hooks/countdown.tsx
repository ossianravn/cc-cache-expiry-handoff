// The band's countdown, ticking in its own region. The hooks module redraws once a minute; this module
// counts the seconds between those redraws with its own timer and redraws only itself. On the desktop a
// redraw from the hooks module rebuilds every site of the plugin, settings pane included, which drops the
// focus of a text field and redraws an open dropdown; a region's own redraw does not.

import type { ClientModule, ClientSurface } from 'claude-code'

import { fmtAgo, fmtClock } from './logic'

export type CountdownProps = {
  /** The hooks module's clock when it drew: the seconds count from here. */
  now: number
  /** When the cache expires. */
  expiresAt: number
  /** A turn is running: the cache is in use, so nothing counts down. */
  isLive: boolean
}

type State = { base: number; ticks: number }

// The latest `now` each instance was drawn with, for its timer to read.
const drawnAt = new WeakMap<ClientSurface<State>, number>()

const Countdown: ClientModule<CountdownProps, State> = (props, surface) => {
  const { Text } = surface.elements
  if (surface.state === undefined && !drawnAt.has(surface)) {
    surface.every(1000, () => {
      const base = drawnAt.get(surface) ?? props.now
      const st = surface.state
      surface.setState(st !== undefined && st.base === base ? { base, ticks: st.ticks + 1 } : { base, ticks: 1 })
    })
  }
  drawnAt.set(surface, props.now)

  const st = surface.state
  const elapsed = st !== undefined && st.base === props.now ? st.ticks * 1000 : 0
  const left = props.expiresAt - (props.now + elapsed)
  if (props.isLive) return <Text tabular>in use</Text>
  if (left <= 0)
    return (
      <Text tabular color="error" wrap="truncate-end">
        expired {fmtAgo(-left)}
      </Text>
    )
  return <Text tabular>{fmtClock(left)}</Text>
}

export default Countdown
