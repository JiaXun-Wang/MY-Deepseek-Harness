/**
 * Desktop-shell affordances, browser half.
 *
 * Adds one General-settings row — "Stop service and quit" — that only renders
 * inside the packaged desktop app (where `window.desktopShell` exists), asking
 * the Electron main process via IPC to stop the background dsh web service.
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the settings slot contract types (this registers a row).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { StopServiceRow } from './StopServiceRow.tsx'

export type { StopServiceRowProps } from './StopServiceRow.tsx'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'settings']

/**
 * Client plugin body: register the desktop stop row under General settings.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'desktop-shell',
    order: 100,
  }, StopServiceRow))
}
