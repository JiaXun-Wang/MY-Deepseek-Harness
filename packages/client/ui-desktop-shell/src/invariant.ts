/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-desktop-shell`.
 * @module @deepseek-ai/dsh-client-ui-desktop-shell/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-desktop-shell'

/** Cordis companion plugin name. */
export const name = 'client-ui-desktop-shell-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: desktop-shell UI is a leaf render that owns no mutable
 * data relation to assert, and its behavior is covered by the render spec.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
