/**
 * dsh-feishu-bridge — a Feishu (Lark) bridge for DeepSeek Harness.
 *
 * Owns one Feishu app long connection and exposes a DSH session to a phone:
 *
 *   - inbound text is injected into one session through `agent.followup()`
 *   - committed assistant text is pushed back to the same Feishu chat
 *   - `/sessions`, `/open <id>`, `/unbind` list and bind the desktop GUI's
 *     persisted sessions, so the phone and the desktop share one conversation
 *   - `approval/request` is answered from a Feishu card, with the desktop
 *     prompt raised alongside it
 *
 * Only DSH's public seams are used (session persistence and query, the agent
 * registry, the approval waterfall, `apiProxy.respond`) plus the Feishu SDK, so
 * a harness upgrade needs a review of those seams rather than a patch of a
 * vendored bundle. There is no build step: this file is the artifact.
 *
 * Bridge-created sessions use colon-free ids (`feishu-dm-<chatId>`): Windows
 * refuses `:` in a file name, and newer harness builds name one storage file
 * per session after its raw id.
 *
 * @module dsh-feishu-bridge
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'dsh-feishu-bridge'
export const inject = ['credentials', 'agents']

/** Feishu event carrying an inbound message. */
const EVENT_MESSAGE = 'im.message.receive_v1'
/** Feishu event carrying an interactive-card action. */
const EVENT_CARD_ACTION = 'card.action.trigger'

/** Deployment-varying knobs; every one is overridable from the profile patch. */
const DEFAULTS = {
  /** Master switch: `false` leaves the plugin loaded but idle. */
  enabled: true,
  /** Credential reference holding `{appId, appSecret, domain}` JSON. */
  credentialRef: 'LARK_LINK_APP',
  /** Feishu or Lark tenant, when the stored credential carries no domain. */
  domain: 'feishu',
  /** Working directory for sessions this bridge creates. */
  workspaceRoot: '',
  /** Agent preset mounted into sessions this bridge creates or resumes. */
  agentPreset: 'code',
  /** How long a card stays tappable before the request delegates onward. */
  approvalTimeoutMs: 300000,
  /** Add an emoji receipt to each accepted inbound message. */
  reactOnReceive: true,
  /** Render markdown replies as cards instead of plain text. */
  markdownCards: true,
}

/** This deployment's bridge state: which chat owns which shared session. */
const STATE_FILENAME = 'state.json'

/**
 * Resolve the bridge's state directory under the harness home.
 * @returns absolute path to `<DSH_HOME>/feishu-bridge`.
 */
function bridgeStateDir() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'feishu-bridge')
}

/**
 * Concatenate the text blocks of a message's content.
 * @param blocks - assistant or user content blocks.
 * @returns the concatenated text, or `''` when the message carries none.
 */
function textOf(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('')
}

/**
 * Read one session's metadata out of `sessionPersistence.list()`.
 *
 * The list row changed shape upstream: current builds return `SessionHeader`
 * rows directly, newer builds return `SessionPersistenceSnapshot` rows carrying
 * the same header under `.header`. Normalizing here keeps `/sessions` and
 * `/open` working across that change instead of silently listing nothing.
 *
 * @param row - one element of the `list()` result.
 * @returns the session header fields this bridge reads.
 */
function sessionHeaderOf(row) {
  return row?.header ?? row
}

/**
 * Whether a reply is worth rendering as a markdown card rather than plain text.
 * @param text - the committed assistant text.
 * @returns true when the text carries block-level markdown.
 */
function looksLikeMarkdown(text) {
  const t = text.trim()
  if (!t) return false
  return /(^|\n)\s*(#{1,6}\s|[-*+]\s|\d+\.\s|```|>\s|\*\*|\|.*\|)/.test(t) || t.includes('\n\n')
}

/**
 * Build the interactive card Feishu renders for a markdown reply.
 * @param markdown - committed assistant text.
 * @param header - optional card title.
 * @returns the CardKit 2.0 card body.
 */
function markdownCard(markdown, header) {
  return {
    schema: '2.0',
    ...header ? { header: { title: { tag: 'plain_text', content: header }, template: 'blue' } } : {},
    body: { elements: [{ tag: 'markdown', content: markdown }] },
  }
}

/**
 * Build one CardKit 2.0 button whose callback echoes `value`.
 * @param text - button label.
 * @param value - value delivered to the `card.action.trigger` handler.
 * @param style - `primary`, `danger`, or undefined for the default style.
 * @returns the button element.
 */
function button(text, value, style) {
  return {
    tag: 'button',
    width: 'fill',
    text: { tag: 'plain_text', content: text },
    ...style ? { type: style } : {},
    behaviors: [{ type: 'callback', value }],
  }
}

/**
 * Build the approval card for one pending request.
 * @param req - the approval request being answered.
 * @param id - the bridge's pending-approval id.
 * @returns the interactive card.
 */
function approvalCard(req, id) {
  const lines = [`**工具**：\`${req.toolName}\``]
  if (req.reason) lines.push(`**原因**：${req.reason}`)
  lines.push('', '这条操作需要你的授权才能继续。')
  return {
    schema: '2.0',
    header: { title: { tag: 'plain_text', content: '🔐 操作授权请求' }, template: 'orange' },
    body: {
      elements: [
        { tag: 'markdown', content: lines.join('\n') },
        button('✅ 允许这次', { op: `apv:${id}:allow` }, 'primary'),
        button('⛔ 拒绝', { op: `apv:${id}:reject` }, 'danger'),
      ],
    },
  }
}

/**
 * Write one diagnostic line to stderr. The harness owns stdout in some launch
 * modes, so plugin diagnostics stay on stderr.
 * @param level - severity used in the prefix.
 * @param message - text to log.
 */
function log(level, message) {
  process.stderr.write(`[feishu-bridge] ${level}: ${message}\n`)
}

/**
 * Register the Feishu bridge on this context.
 * @param ctx - the plugin context, carrying the injected credentials and agents services.
 * @param config - profile-supplied overrides of {@link DEFAULTS}.
 */
export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) }
  // Deployment overrides are read here rather than through loader expressions:
  // a `!!js` patch value does not reliably arrive as an evaluated scalar, and a
  // literal fallback keeps the plugin usable from any profile.
  if (process.env.DSH_FEISHU_BRIDGE_ENABLED === 'false') cfg.enabled = false
  const envRef = process.env.DSH_FEISHU_CREDENTIAL_REF
  if (typeof envRef === 'string' && envRef.trim()) cfg.credentialRef = envRef.trim()
  if (typeof cfg.credentialRef !== 'string' || !cfg.credentialRef.trim()) cfg.credentialRef = DEFAULTS.credentialRef
  if (cfg.enabled === false) {
    log('info', 'disabled by config')
    return
  }

  const dir = bridgeStateDir()
  mkdirSync(dir, { recursive: true })
  const statePath = join(dir, STATE_FILENAME)
  const state = { sharedSessionId: '', ownerChatId: '', bridgeSessionId: '' }
  try {
    Object.assign(state, JSON.parse(readFileSync(statePath, 'utf8')))
  } catch {
    // First run (or an unreadable file): the defaults above stay in effect.
  }
  const saveState = () => {
    try {
      writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 })
    } catch (err) {
      log('warn', `state save failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** chatId -> live agent handle this bridge owns, plus its event subscription. */
  const bound = new Map()
  /** approval id -> pending Feishu decision. */
  const pendingApprovals = new Map()
  /** Answerable approval frames pushed to the browser, by approval id. */
  const approvalFrames = new Map()

  const apiProxy = ctx.get('apiProxy')
  let client
  let stopped = false

  /** Current default model selection, used for resume and create. */
  function agentOptions() {
    try {
      const current = ctx.get('agentDefaultModel')?.currentSelection?.()
      if (current?.provider && current.model) return { provider: current.provider, model: current.model }
    } catch {
      // Selection is optional: a session whose log already carries a route still runs.
    }
    return undefined
  }

  /** The AgentScope setup every session this bridge publishes runs through. */
  function setupFor(presetId) {
    return async (agentCtx) => {
      const presets = ctx.get('agentPresets')
      if (presets?.mount) await presets.mount(agentCtx, presetId)
    }
  }

  /**
   * Read the stored Feishu app credential.
   * @returns app credentials, or undefined when the reference resolves to nothing usable.
   */
  async function credentials() {
    try {
      const value = await ctx.credentials?.resolve?.(cfg.credentialRef)
      const raw = value?.value ?? value
      if (!raw) return undefined
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
      if (!parsed?.appId || !parsed?.appSecret) return undefined
      return { appId: parsed.appId, appSecret: parsed.appSecret, domain: parsed.domain ?? cfg.domain }
    } catch (err) {
      log('warn', `credential resolve failed: ${err instanceof Error ? err.message : String(err)}`)
      return undefined
    }
  }

  /** Send one plain-text message to a chat. */
  async function sendText(chatId, text) {
    if (!client) return
    await client.rest.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) },
    })
  }

  /** Send one interactive card to a chat. */
  async function sendCard(chatId, card) {
    if (!client) return
    await client.rest.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(card) },
    })
  }

  /** Reply to a chat, rendering markdown as a card when configured. */
  async function reply(chatId, text) {
    try {
      if (cfg.markdownCards && looksLikeMarkdown(text)) await sendCard(chatId, markdownCard(text))
      else await sendText(chatId, text)
    } catch (err) {
      log('warn', `reply failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** Add the "received" emoji receipt to an inbound message. */
  function acknowledge(messageId) {
    if (!cfg.reactOnReceive || !client) return
    client.rest.im.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: 'DONE' } },
    }).catch(() => undefined)
  }

  /**
   * Resolve the session a chat talks to, creating or resuming it as needed.
   * @param chatId - the Feishu chat identity.
   * @returns the live agent for that chat.
   */
  async function agentFor(chatId) {
    const existing = bound.get(chatId)
    if (existing && ctx.agents.get?.(existing.sessionId)) return existing.agent

    const cwd = cfg.workspaceRoot || process.cwd()
    const options = agentOptions()
    const setup = setupFor(cfg.agentPreset)
    const isShared = Boolean(state.sharedSessionId) && chatId === state.ownerChatId
    const sessionId = isShared ? state.sharedSessionId : `feishu-dm-${chatId}`

    const live = ctx.agents.get?.(sessionId)
    let handle
    if (live) handle = { agent: live, dispose: async () => undefined }
    else {
      try {
        handle = await ctx.agents.resume({
          resumeSessionId: sessionId,
          ...options ? { agentOptions: options } : {},
          setup,
        })
      } catch (err) {
        if (isShared) throw err
        handle = await ctx.agents.create({
          sessionId,
          meta: { cwd, agentPreset: cfg.agentPreset },
          ...options ? { agentOptions: options } : {},
          setup,
        })
      }
    }

    const agent = handle.agent
    const record = { agent, sessionId, dispose: handle.dispose, chatId, detach: undefined }
    record.detach = agent.ctx.on('session/event', (_session, event) => {
      if (event?.type !== 'assistant/message') return
      const text = textOf(event.data?.message?.content)
      if (text.trim()) void reply(chatId, text)
    })
    bound.set(chatId, record)
    log('info', `session ${sessionId} bound to chat ${chatId}`)
    return agent
  }

  /** List the persisted sessions a phone can open, newest first. */
  async function listSessions() {
    const persistence = ctx.get('sessionPersistence')
    if (!persistence?.list) return { error: '会话持久化服务不可用' }
    const query = ctx.get('sessionQuery')
    let headers
    try {
      headers = await persistence.list()
    } catch (err) {
      return { error: `列出会话失败：${err instanceof Error ? err.message : String(err)}` }
    }
    const rows = headers
      .map(sessionHeaderOf)
      .filter((h) => h?.id && h.origin !== 'subagent' && !h.parentSession)
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    const lines = []
    for (const h of rows.slice(0, 30)) {
      let title = ''
      try {
        title = (await query?.readTitle?.(h.id))?.title ?? ''
      } catch {
        // A session without a title still lists by id.
      }
      const mark = h.id === state.sharedSessionId ? '✅ ' : ''
      const when = h.createdAt ? new Date(h.createdAt).toLocaleString() : '?'
      lines.push(`• ${mark}${title ? `📝 ${title}` : `💬 ${h.id}`}\n   id: \`${h.id}\`\n   时间: ${when}`)
    }
    return { headers: rows, lines }
  }

  /**
   * Answer one bridge command.
   * @param chatId - the Feishu chat that sent it.
   * @param text - the raw command line, including its leading slash.
   * @returns true when the text was a bridge command and was answered.
   */
  async function handleCommand(chatId, text) {
    const [rawName, ...rest] = text.trim().split(/\s+/)
    const command = (rawName ?? '').replace(/^\/+/, '').toLowerCase()
    const arg = rest.join(' ').trim()
    if (!command) return false

    if (command === 'help') {
      await reply(chatId, [
        '**飞书桥命令**',
        '',
        '- `/status` 连接与绑定状态',
        '- `/sessions` 列出电脑上的历史会话',
        '- `/open <id>` 绑定一个会话（手机与电脑共享同一对话）',
        '- `/unbind` 解除绑定',
        '- `/new` 新开一个桥会话（需先解除绑定）',
        '- 其他内容直接发给 agent',
      ].join('\n'))
      return true
    }

    if (command === 'status') {
      const model = agentOptions()
      await reply(chatId, [
        '**飞书桥状态**',
        '',
        `- 连接: ${client ? `已连接（${client.botName ?? 'bot'}）` : '未连接'}`,
        `- 凭据: ${cfg.credentialRef}`,
        `- 绑定会话: ${state.sharedSessionId ? `\`${state.sharedSessionId}\`` : '（未绑定）'}`,
        `- 当前聊天会话: \`${bound.get(chatId)?.sessionId ?? '（尚未开始）'}\``,
        `- 模型: ${model ? `${model.provider}/${model.model}` : '（未选择）'}`,
      ].join('\n'))
      return true
    }

    if (command === 'sessions') {
      const result = await listSessions()
      if (result.error) {
        await reply(chatId, result.error)
        return true
      }
      if (result.lines.length === 0) {
        await reply(chatId, '还没有历史会话。')
        return true
      }
      const bindLine = state.sharedSessionId
        ? `\n\n当前已绑定：✅ \`${state.sharedSessionId}\``
        : '\n\n当前未绑定。发 `/open <id>` 把手机和电脑接到同一个对话。'
      await reply(chatId, `**历史会话 (${result.headers.length})**\n\n${result.lines.join('\n')}${bindLine}`)
      return true
    }

    if (command === 'open') {
      if (!arg) {
        await reply(chatId, '用法：`/open <sessionId>`，先用 `/sessions` 查看可选会话。')
        return true
      }
      const persistence = ctx.get('sessionPersistence')
      let meta
      try {
        meta = (await persistence?.list?.() ?? []).map(sessionHeaderOf).find((h) => h?.id === arg)
      } catch {
        meta = undefined
      }
      if (!meta || meta.origin === 'subagent' || meta.parentSession) {
        await reply(chatId, `未找到可打开的会话 \`${arg}\`（子代理会话不可打开）。`)
        return true
      }
      state.sharedSessionId = meta.id
      state.ownerChatId = chatId
      saveState()
      try {
        const previous = bound.get(chatId)
        if (previous && previous.sessionId !== meta.id) {
          previous.detach?.()
          bound.delete(chatId)
        }
        await agentFor(chatId)
      } catch (err) {
        state.sharedSessionId = ''
        state.ownerChatId = ''
        saveState()
        await reply(chatId, `恢复会话失败：${err instanceof Error ? err.message : String(err)}`)
        return true
      }
      await reply(chatId, `已绑定共享会话 \`${meta.id}\`。\n\n之后你在飞书发的消息都会进入这个会话——和电脑上是同一个对话。重启后依然有效，解除用 \`/unbind\`。`)
      return true
    }

    if (command === 'unbind') {
      const previous = state.sharedSessionId
      if (!previous) {
        await reply(chatId, '当前没有绑定共享会话。')
        return true
      }
      const record = bound.get(chatId)
      if (record) {
        record.detach?.()
        bound.delete(chatId)
      }
      state.sharedSessionId = ''
      state.ownerChatId = ''
      saveState()
      await reply(chatId, `已解除对 \`${previous}\` 的绑定。`)
      return true
    }

    if (command === 'new') {
      if (state.sharedSessionId) {
        await reply(chatId, `当前已绑定 \`${state.sharedSessionId}\`，/new 不会生效。先 \`/unbind\` 再开新会话。`)
        return true
      }
      const record = bound.get(chatId)
      if (record) {
        record.detach?.()
        bound.delete(chatId)
      }
      await reply(chatId, '下一条消息将开始一个新的桥会话。')
      return true
    }

    return false
  }

  /**
   * Handle one inbound Feishu message.
   * @param data - the raw `im.message.receive_v1` payload.
   */
  async function onMessage(data) {
    const message = data?.message
    if (!message) return
    const chatId = message.chat_id
    const chatType = message.chat_type
    const messageId = message.message_id
    if (chatType !== 'p2p') {
      log('info', `ignored a ${chatType ?? 'unknown'} message (only direct chats are bridged)`)
      return
    }
    let text = ''
    try {
      const content = JSON.parse(message.content ?? '{}')
      text = String(content.text ?? '').trim()
    } catch {
      // Non-text messages (image, file, post) carry no plain text for this bridge.
    }
    if (!text) {
      await reply(chatId, '目前只处理文本消息。')
      return
    }
    acknowledge(messageId)

    try {
      if (await handleCommand(chatId, text)) return
    } catch (err) {
      log('warn', `command failed: ${err instanceof Error ? err.message : String(err)}`)
    }

    try {
      const agent = await agentFor(chatId)
      agent.followup(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }))
    } catch (err) {
      log('warn', `delivery failed: ${err instanceof Error ? err.message : String(err)}`)
      await reply(chatId, `处理失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** Which chat a pending approval belongs to, when this bridge owns it. */
  function approvalChatId(req) {
    const sessionId = String(req?.agent?.session?.id ?? req?.agent?.id ?? '')
    for (const record of bound.values()) if (record.sessionId === sessionId) return record.chatId
    if (state.sharedSessionId && sessionId === state.sharedSessionId) return state.ownerChatId
    return undefined
  }

  /**
   * Present one approval on the phone.
   * @returns `'allow'`, `'reject'`, or undefined when the phone did not decide.
   */
  function requestApproval(req, chatId) {
    const id = `apv-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    let resolveDecision
    const promise = new Promise((resolve) => {
      resolveDecision = resolve
    })
    const settle = (value) => {
      const entry = pendingApprovals.get(id)
      if (!entry || entry.settled) return
      clearTimeout(entry.timer)
      entry.settled = true
      resolveDecision(value)
    }
    const timer = setTimeout(() => settle(undefined), cfg.approvalTimeoutMs)
    timer.unref?.()
    pendingApprovals.set(id, { resolve: settle, chatId, timer, settled: false, frame: undefined })
    req.signal?.addEventListener?.('abort', () => settle(undefined), { once: true })
    sendCard(chatId, approvalCard(req, id)).catch((err) => {
      log('warn', `approval card failed: ${err instanceof Error ? err.message : String(err)}`)
      settle(undefined)
    })
    return {
      promise,
      close: () => settle(undefined),
      /**
       * Withdraw the desktop prompt through the proxy's own resolution channel.
       * Fire-and-forget: the phone's decision must never wait on this.
       */
      dismissDesktop(allow) {
        const frame = pendingApprovals.get(id)?.frame
        if (!frame || !apiProxy?.respond) return
        apiProxy.respond({
          type: 'client-response',
          rpcId: frame.rpcId,
          result: { ok: true, value: { sessionId: frame.sessionId, approvalId: frame.approvalId, outcome: allow ? 'allowed-once' : 'rejected' } },
        }).catch((err) => log('warn', `approval dismiss failed: ${err instanceof Error ? err.message : String(err)}`))
      },
    }
  }

  /** Handle one interactive-card action. */
  function onCardAction(data) {
    const value = data?.action?.value
    const op = typeof value?.op === 'string' ? value.op : ''
    if (!op.startsWith('apv:')) return
    const [, approvalId, decision] = op.split(':')
    const entry = pendingApprovals.get(approvalId)
    if (!entry) return
    const allow = decision === 'allow'
    if (entry.settled) {
      void sendText(entry.chatId, '这条授权已经处理过了 ✅')
      pendingApprovals.delete(approvalId)
      return
    }
    void sendText(entry.chatId, allow ? '已允许这一次 ✅' : '已拒绝 ⛔')
    entry.resolve(allow ? 'allow' : 'reject')
    entry.dismissDesktop(allow)
    pendingApprovals.delete(approvalId)
  }

  // A phone tap answers through the proxy's own channel so its broadcast clears
  // the desktop prompt; the frame carrying that channel's rpcId is captured from
  // the mux stream, since rpcId is minted inside the proxy.
  if (apiProxy?.events?.mux) {
    const abort = new AbortController()
    const consume = async () => {
      try {
        for await (const frame of apiProxy.events.mux({ rpcId: `feishu-bridge-${Date.now()}`, payload: {} }, abort.signal)) {
          const payload = frame?.payload
          if (payload?.type === 'approval/requested') {
            approvalFrames.set(String(payload.approvalId), {
              rpcId: frame.rpcId,
              sessionId: payload.sessionId,
              approvalId: payload.approvalId,
              callId: payload.callId,
              claimed: false,
            })
          } else if (payload?.type === 'approval/resolved') {
            approvalFrames.delete(String(payload.approvalId))
          }
        }
      } catch (err) {
        if (!abort.signal.aborted) log('warn', `mux subscription ended: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    void consume()
    ctx.effect(() => () => abort.abort(), 'feishu-bridge: approval mux subscription')
  }

  /** Claim the pushed frame matching a request so a phone answer can travel it. */
  async function claimApprovalFrame(req) {
    const sessionId = String(req?.agent?.session?.id ?? req?.agent?.id ?? '')
    for (let attempt = 0; attempt < 20; attempt += 1) {
      for (const frame of approvalFrames.values()) {
        if (frame.claimed) continue
        if (String(frame.sessionId) !== sessionId) continue
        if ((frame.callId ?? null) !== (req?.callId ?? null)) continue
        frame.claimed = true
        return frame
      }
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 100)
        t.unref?.()
      })
    }
    return undefined
  }

  // Ask both surfaces at once: the phone card and the desktop prompt raised by
  // the rest of the chain. The first decisive answer wins.
  ctx.on('approval/request', async (req, next) => {
    let chatId
    try {
      chatId = approvalChatId(req)
    } catch (err) {
      log('warn', `approval routing failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!chatId) return await next()
    const feishu = requestApproval(req, chatId)
    const desktop = next()
    desktop.then((outcome) => {
      if (outcome && outcome !== 'unavailable') feishu.close()
    }).catch(() => undefined)
    claimApprovalFrame(req).then((frame) => {
      const entry = [...pendingApprovals.values()].find((e) => e.frame === undefined && e.chatId === chatId)
      if (frame && entry) entry.frame = frame
    }).catch(() => undefined)
    let picked
    try {
      picked = await feishu.promise
    } catch (err) {
      log('warn', `approval failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (picked === 'allow') return 'allowed-once'
    if (picked === 'reject') return 'rejected'
    return await desktop.catch(() => 'unavailable')
  })

  /** Open the Feishu long connection and start servicing messages. */
  async function start() {
    const resolved = await credentials()
    if (!resolved) {
      log('warn', `no usable credential at ${cfg.credentialRef}; bridge stays idle (run the Feishu setup flow to store one)`)
      return
    }
    const sdk = await import('@larksuiteoapi/node-sdk')
    // A deployment environment proxy breaks the long connection; the bridge
    // talks to Feishu directly.
    if (sdk.defaultHttpInstance?.defaults) sdk.defaultHttpInstance.defaults.proxy = false
    const options = {
      appId: resolved.appId,
      appSecret: resolved.appSecret,
      appType: sdk.AppType.SelfBuild,
      domain: resolved.domain === 'lark' ? sdk.Domain.Lark : sdk.Domain.Feishu,
      loggerLevel: sdk.LoggerLevel.error,
    }
    const rest = new sdk.Client(options)
    const dispatcher = new sdk.EventDispatcher({ loggerLevel: sdk.LoggerLevel.error })
    const ws = new sdk.WSClient(options)
    dispatcher.register({ [EVENT_MESSAGE]: (data) => { void onMessage(data) } })
    dispatcher.register({ [EVENT_CARD_ACTION]: (data) => { onCardAction(data) } })

    let botName
    try {
      const res = await rest.request({ url: '/open-apis/bot/v3/info', method: 'GET' })
      botName = res?.bot?.app_name ?? res?.data?.bot?.app_name
    } catch (err) {
      log('warn', `bot info failed: ${err instanceof Error ? err.message : String(err)}`)
    }

    client = { rest, ws, botName }
    ws.start({ eventDispatcher: dispatcher })
    log('info', `connected as ${botName ?? resolved.appId}`)
  }

  ctx.effect(() => () => {
    if (stopped) return
    stopped = true
    try {
      client?.ws?.stop?.()
    } catch (err) {
      log('warn', `ws stop failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    for (const record of bound.values()) record.detach?.()
    bound.clear()
  }, 'feishu-bridge: teardown')

  start().catch((err) => {
    log('error', `start failed: ${err instanceof Error ? err.message : String(err)}`)
  })
}
