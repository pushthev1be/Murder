import type { EngineInterface, Register, ThemeSetArgs } from 'claude-code'

import { makeColors } from './make-colors.js'

// Claude orange on four grounds, the same four Session Desk offers.
const ROLES = { accent: '#d97757', danger: '#b8402f', success: '#4e7d3a', warning: '#a86f14', pro: '#7a5aa6' }

type Ground = { label: string; hint: string; build: () => ThemeSetArgs }

function light(label: string, s0: string, s1: string, s2: string, text: string, sub: string, muted: string) {
  return makeColors({
    label,
    roles: ROLES,
    only: 'light',
    light: { gray: { anchors: { 'surface-0': s0, 'surface-1': s1, 'surface-2': s2, 'surface-3': s2, 'text-primary': text, 'text-secondary': sub, 'text-muted': muted } } },
  })
}

const GROUNDS: Record<string, Ground> = {
  milk: {
    label: 'Milk',
    hint: 'clean milk white, no tint (default)',
    build: () => ({ colors: light('Milk', '#f7f7f4', '#fbfbf9', '#ffffff', '#22221f', '#4a4a44', '#66665f').theme, overrideColorScheme: 'light' }),
  },
  sand: {
    label: 'Sand',
    hint: 'warm sand',
    build: () => ({ colors: light('Sand', '#ece2d1', '#f3ebdd', '#f9f4ea', '#2a231c', '#52473b', '#685c4e').theme, overrideColorScheme: 'light' }),
  },
  peach: {
    label: 'Peach',
    hint: 'soft orange glow',
    build: () => ({
      colors: light('Peach', '#f8e4d6', '#fbede3', '#fff6f0', '#2c211b', '#56443a', '#6d584c').theme,
      overrideColorScheme: 'light',
      backdrop: { gradient: { stops: ['#fbe9dc', '#f6d6c1'], angle: 160 } },
    }),
  },
  ember: {
    label: 'Ember',
    hint: 'dark espresso with orange',
    build: () => ({
      colors: makeColors({
        label: 'Ember',
        roles: ROLES,
        only: 'dark',
        dark: { gray: { anchors: { 'surface-0': '#1d1815', 'surface-1': '#26201c', 'surface-2': '#2e2722', 'surface-3': '#352d27', 'text-primary': '#f4ebe3', 'text-secondary': '#d3c6ba', 'text-muted': '#b1a294' } } },
      }).theme,
      overrideColorScheme: 'dark',
      backdrop: { gradient: { stops: ['#1d1815', '#2a1d16'], angle: 160 } },
    }),
  },
}

const DEFAULT = 'milk'

async function apply($: EngineInterface, name: string) {
  const g = GROUNDS[name] ?? GROUNDS[DEFAULT]!
  return $.theme.set(g.build())
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'desk-theme',
      description: 'Switch the background: milk, sand, peach or ember (Claude orange accent)',
    })
    const saved = String((await $.store.get('ground')) ?? DEFAULT)
    try { await apply($, saved) } catch (error) { $.ui.log(String(error)) }
    return next(e)
  })

  on('command.run', { command: 'desk-theme' }, async ($, e) => {
    const want = e.args.trim().toLowerCase()
    const list = Object.entries(GROUNDS).map(([k, g]) => `  ${k.padEnd(6)} ${g.hint}`).join('\n')
    if (!want) {
      const cur = String((await $.store.get('ground')) ?? DEFAULT)
      return { text: `Background: ${cur}\n${list}\nUse /desk-theme <name>.` }
    }
    if (!GROUNDS[want]) return { text: `No background called "${want}". Choose one of:\n${list}` }
    await $.store.set('ground', want)
    try {
      const set = await apply($, want)
      return { text: set.isDrawn ? `Background set to ${GROUNDS[want].label}.` : `Saved ${GROUNDS[want].label}. It shows in the Claude desktop and mobile apps; this terminal draws no backgrounds (${set.reason}).` }
    } catch (error) {
      return { text: `Couldn't set ${want}: ${String(error)}` }
    }
  })
}
