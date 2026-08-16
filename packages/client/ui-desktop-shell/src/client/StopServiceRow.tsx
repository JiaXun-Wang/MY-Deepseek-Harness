/**
 * Desktop-shell "Stop service" row for the General settings section.
 *
 * Rendered only inside the packaged desktop app — the injected
 * `window.desktopShell` bridge exists solely there. Clicking stops the
 * background dsh web service and quits the Electron app via IPC.
 */
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './StopServiceRow.module.css'

/** Desktop shell bridge as exposed by desktop/preload.js. */
interface DesktopShellBridge {
  isDesktopApp?: boolean
  stopService?: () => void
}

/** Full component props (General-section item share only; no host data). */
export type StopServiceRowProps = PropsRuntime<'settings.general.item'>

/**
 * Render the "stop service and quit" row, or null when not in the desktop app.
 * @param props - composed slot props.
 * @returns the row element tree, or null outside the desktop shell.
 */
export function StopServiceRow(_props: StopServiceRowProps) {
  const desktop = typeof window !== 'undefined'
    ? (window as unknown as { desktopShell?: DesktopShellBridge }).desktopShell
    : undefined
  if (!desktop?.isDesktopApp) return null
  return (
    <div className={css.row}>
      <div className={css.rowText}>
        <div className={css.title}>停止后台服务并退出桌面端</div>
        <div className={css.desc}>停止本机 5180 端口监听的服务并关闭桌面应用（历史保存在本地，不会丢失）。</div>
      </div>
      <button type="button" className={css.button} onClick={() => desktop.stopService?.()}>
        停止服务并退出
      </button>
    </div>
  )
}
