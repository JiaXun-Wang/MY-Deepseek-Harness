import { defineTool } from "@deepseek-ai/dsh-tools";
import { basename, dirname, join, resolve } from "node:path";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { gzipSync, zstdDecompressSync } from "node:zlib";
import * as qrcode from "qrcode-terminal";
import QRCode from "qrcode";
import { homedir } from "node:os";
//#region src/sessions/dsh-adapter.ts
function textOf(blocks) {
	return (blocks ?? []).filter((b) => b.type === "text" && b.text !== void 0).map((b) => b.text).join("");
}
function toSessionEventOut(ev) {
	switch (ev.type) {
		case "turn/start": return { type: "turn/start" };
		case "assistant/chunk": {
			const c = ev.data.chunk;
			if (c.type === "text-delta") return {
				type: "assistant/chunk",
				text: c.text
			};
			return;
		}
		case "assistant/message": return {
			type: "assistant/message",
			text: textOf(ev.data.message.content)
		};
		case "turn/end": return {
			type: "turn/end",
			reason: ev.data.reason.kind
		};
		case "tool/call": return {
			type: "tool/call",
			name: ev.data.name
		};
		case "tool/result": return {
			type: "tool/result",
			name: ev.data.message.content?.[0]?.type ?? "?",
			error: ev.data.error
		};
		default: return;
	}
}
function createDshAdapter(deps) {
	const c = deps.ctx;
	const tracked = /* @__PURE__ */ new Map();
	const keyBySession = /* @__PURE__ */ new Map();
	const listeners = /* @__PURE__ */ new Map();
	const disposers = /* @__PURE__ */ new Map();
	const ensureInFlight = /* @__PURE__ */ new Map();
	let runNonce = deps.runNonce ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
	const generations = /* @__PURE__ */ new Map();
	const bridgeKey = (key) => `${deps.sessionPrefix}:${key}:${runNonce}:${generations.get(key) ?? 0}`;
	async function ensureAgent(key) {
		const existing = tracked.get(key);
		if (existing) {
			existing.lastUsedAt = Date.now();
			return existing.handle;
		}
		const inFlight = ensureInFlight.get(key);
		if (inFlight) return inFlight.then((h) => {
			const t = tracked.get(key);
			if (t) t.lastUsedAt = Date.now();
			return h;
		});
		const p = (async () => {
			let sessionId = bridgeKey(key);
			let owned;
			const sel = deps.modelSelection?.current;
			const defaultModel = sel?.provider && sel.model ? sel : void 0;
			const agentOptions = defaultModel ? {
				provider: defaultModel.provider,
				model: defaultModel.model
			} : void 0;
			if (!defaultModel) deps.logger?.warn(`no model selection — bridge agent for ${key} has no provider/model; turns will fail unless one is supplied`);
			const setup = async (agentCtx) => {
				if (deps.modelSelection?.current) installModelSelection(agentCtx, {
					current: deps.modelSelection.current,
					assembled: void 0
				});
				const presets = c.get?.("agentPresets");
				if (presets?.mount) await presets.mount(agentCtx, deps.preset?.() ?? "ptc");
				if (deps.askUserQuestion) {
					const askTool = defineTool({
						name: "ask_user_question",
						description: "Ask the user a concise question when you need confirmation, a choice, or missing information before proceeding. Send one or more questions, each with a stable id that will be echoed in the answer.",
						parameters: { questions: {
							type: "array",
							required: true,
							description: "Questions to ask the user before continuing.",
							items: {
								type: "object",
								additionalProperties: true,
								properties: {
									id: {
										type: "string",
										required: true,
										description: "Stable id for this question; echoed in the answer."
									},
									question: {
										type: "string",
										required: true,
										description: "The specific question to ask the user."
									},
									header: {
										type: "string",
										description: "Optional short heading for the question."
									},
									options: {
										type: "array",
										description: "Optional choices to show the user.",
										items: {
											type: "object",
											additionalProperties: true,
											properties: {
												label: {
													type: "string",
													required: true,
													description: "Short user-facing option label."
												},
												description: {
													type: "string",
													description: "One sentence explaining the tradeoff or impact."
												}
											}
										}
									},
									multi_select: {
										type: "boolean",
										description: "Whether the user may select more than one option. Defaults to false."
									}
								}
							}
						} },
						output: {
							schema: {
								type: "object",
								additionalProperties: false,
								properties: { answers: {
									type: "array",
									required: true,
									items: {
										type: "object",
										additionalProperties: false,
										properties: {
											id: {
												type: "string",
												required: true
											},
											selected: {
												type: "array",
												required: true,
												items: { type: "string" }
											},
											custom: { type: "string" }
										}
									}
								} }
							},
							render: (_args, value) => [{
								type: "text",
								text: JSON.stringify(value)
							}]
						},
						async execute(args, exec) {
							if (!deps.askUserQuestion) return { answers: [] };
							const questions = (args.questions ?? []).map((q) => ({
								id: q.id,
								question: q.question,
								...q.header !== void 0 ? { header: q.header } : {},
								...q.options !== void 0 ? { options: q.options } : {},
								...q.multi_select !== void 0 ? { multiSelect: q.multi_select } : {}
							}));
							const agentId = exec.agent?.id ?? "";
							return deps.askUserQuestion(questions, agentId);
						}
					});
					agentCtx.tools?.register?.(askTool);
				}
			};
			try {
				owned = await c.agents.create({
					sessionId,
					meta: {
						cwd: deps.cwd?.() ?? process.cwd(),
						agentPreset: deps.preset?.() ?? "ptc"
					},
					...agentOptions ? { agentOptions } : {},
					setup
				});
			} catch (err) {
				if (err instanceof Error && /already exists/.test(err.message)) {
					deps.logger?.warn(`session id taken for ${key} — minting fresh session (resume is broken for mismatched logs)`);
					runNonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
					const freshId = bridgeKey(key);
					try {
						owned = await c.agents.create({
							sessionId: freshId,
							meta: {
								cwd: deps.cwd?.() ?? process.cwd(),
								agentPreset: deps.preset?.() ?? "ptc"
							},
							...agentOptions ? { agentOptions } : {},
							setup
						});
					} catch (err2) {
						throw new Error(`failed to mint fresh session for ${key} (was "${sessionId}"): ${err2 instanceof Error ? err2.message : String(err2)}`);
					}
					sessionId = freshId;
				} else throw new Error(`failed to create DSH agent for ${key}: ${err instanceof Error ? err.message : String(err)}`);
			}
			if (!owned?.agent) throw new Error(`DSH agents.create returned no agent for ${key}`);
			const wsCwd = deps.cwd?.() ?? process.cwd();
			try {
				const workspaces = c.get?.("workspaceRegistry");
				if (workspaces?.create) {
					const entity = await workspaces.create(wsCwd, basename(wsCwd));
					deps.logger?.info(`workspace create: ${wsCwd} (${entity ? "entity" : "none"})`);
					if (entity?.attachSession) {
						await entity.attachSession(sessionId);
						deps.logger?.info(`workspace attach: ${sessionId} -> ${wsCwd}`);
					} else deps.logger?.warn(`workspace attach skipped: entity has no attachSession (${wsCwd})`);
				} else deps.logger?.warn(`workspaceRegistry unavailable — session ${sessionId} will show under 未分组`);
			} catch (err) {
				deps.logger?.warn(`workspace create/attach failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
			}
			const agent = owned.agent;
			const handle = {
				agentId: agent.id,
				sessionId,
				async followup(text, attachments) {
					const parts = [text];
					const content = [{
						type: "text",
						text
					}];
					for (const a of attachments ?? []) if (a.kind === "image" && a.imageRef) content.push({
						type: "image",
						attachment: a.imageRef
					});
					else if (a.kind === "file" && a.textPreview) parts.push(`\n\n[附件 ${a.name ?? "文件"} 内容]\n${a.textPreview}`);
					else if (a.kind === "file") parts.push(`\n\n[附件 ${a.name ?? "文件"}（未能提取文本）]`);
					content[0] = {
						type: "text",
						text: parts.join("")
					};
					const message = createUserMessage({
						content,
						source: { kind: "user" }
					});
					agent.followup(message);
				},
				async cancel() {
					agent.cancel({ kind: "user" });
				},
				onEvent(fn) {
					const set = listeners.get(key) ?? /* @__PURE__ */ new Set();
					set.add(fn);
					listeners.set(key, set);
					return () => {
						set.delete(fn);
					};
				},
				isIdle: () => agent.status === "idle",
				async dispose() {
					disposers.get(key)?.();
					disposers.delete(key);
					await owned.dispose();
					tracked.delete(key);
					keyBySession.delete(sessionId);
					listeners.delete(key);
				}
			};
			tracked.set(key, {
				handle,
				lastUsedAt: Date.now()
			});
			keyBySession.set(sessionId, key);
			const disp = agent.ctx.on("session/event", (_session, ev) => {
				const out = toSessionEventOut(ev);
				if (!out) return;
				const set = listeners.get(key);
				if (set) for (const fn of set) fn(out);
			});
			disposers.set(key, disp);
			const errDisp = agent.ctx.on("agent/error", (payload) => {
				deps.logger?.warn(`agent error for ${key}: ${payload.error instanceof Error ? payload.error.message : String(payload.error)}`);
			});
			disposers.set(key, errDisp);
			return handle;
		})();
		ensureInFlight.set(key, p);
		try {
			return await p;
		} finally {
			ensureInFlight.delete(key);
		}
	}
	/**
	 * dsh-lark-link-plus: bind `key` to an existing persisted DSH session.
	 * Prefers the session's LIVE agent so a conversation the desktop GUI is
	 * already driving becomes literally the same conversation (Feishu messages
	 * land in that agent and the GUI renders them); otherwise the session is
	 * resumed. An agent owned elsewhere is never disposed here — only this
	 * bridge's event listeners detach.
	 */
	async function adoptSessionImpl(key, sessionId, opts = {}) {
		const existing = tracked.get(key);
		if (existing) {
			disposers.get(key)?.();
			disposers.delete(key);
			listeners.delete(key);
			tracked.delete(key);
			const oldId = existing.handle.sessionId;
			if (oldId) keyBySession.delete(oldId);
			await existing.handle.dispose();
		}
		const liveAgent = c.agents?.get?.(sessionId);
		let agent;
		let disposeOwned;
		if (liveAgent) {
			agent = liveAgent;
			deps.logger?.info(`session ${sessionId} is live — attaching to the existing agent`);
		} else {
			const sel = deps.modelSelection?.current;
			const agentOptions = sel?.provider && sel.model ? { provider: sel.provider, model: sel.model } : void 0;
			const setup = async (agentCtx) => {
				if (deps.modelSelection?.current) installModelSelection(agentCtx, { current: deps.modelSelection.current, assembled: void 0 });
				const presets = c.get?.("agentPresets");
				if (presets?.mount) await presets.mount(agentCtx, opts.preset ?? "code");
			};
			let owned;
			try {
				owned = await c.agents.resume({
					resumeSessionId: sessionId,
					...agentOptions ? { agentOptions } : {},
					setup
				});
			} catch (err) {
				// The session may have become live between the lookup above and this
				// resume (the GUI opening it, say). Adopt that live agent instead of
				// failing; only a genuinely unresumable session surfaces an error.
				const raced = c.agents?.get?.(sessionId);
				if (!raced) throw new Error(`resume 失败 (${sessionId}): ${err instanceof Error ? err.message : String(err)}`);
				deps.logger?.info(`session ${sessionId} became live during resume — attaching to the existing agent`);
				agent = raced;
				disposeOwned = void 0;
			}
			if (!agent) {
				agent = owned.agent;
				disposeOwned = () => owned.dispose();
			}
		}
		const handle = {
			agentId: agent.id,
			sessionId,
			async followup(text, attachments) {
				const parts = [text];
				for (const a of attachments ?? []) if (a.kind === "file" && a.textPreview) parts.push(`\n\n[附件 ${a.name ?? "文件"} 内容]\n${a.textPreview}`);
				else if (a.kind === "file") parts.push(`\n\n[附件 ${a.name ?? "文件"}（未能提取文本）]`);
				agent.followup(createUserMessage({
					content: [{ type: "text", text: parts.join("") }],
					source: { kind: "user" }
				}));
			},
			async cancel() {
				agent.cancel({ kind: "user" });
			},
			onEvent(fn) {
				const set = listeners.get(key) ?? /* @__PURE__ */ new Set();
				set.add(fn);
				listeners.set(key, set);
				return () => {
					set.delete(fn);
				};
			},
			isIdle: () => agent.status === "idle",
			async dispose() {
				disposers.get(key)?.();
				disposers.delete(key);
				listeners.delete(key);
				tracked.delete(key);
				keyBySession.delete(sessionId);
				if (disposeOwned) await disposeOwned();
			}
		};
		tracked.set(key, { handle, lastUsedAt: Date.now() });
		keyBySession.set(sessionId, key);
		const disp = agent.ctx.on("session/event", (_session, ev) => {
			const out = toSessionEventOut(ev);
			if (!out) return;
			const set = listeners.get(key);
			if (set) for (const fn of set) fn(out);
		});
		disposers.set(key, disp);
		const errDisp = agent.ctx.on("agent/error", (payload) => {
			deps.logger?.warn(`agent error for ${key}: ${payload.error instanceof Error ? payload.error.message : String(payload.error)}`);
		});
		disposers.set(key, errDisp);
		return handle;
	}
	return {
		async ensureAgent(key) {
			const sharedId = deps.sharedSessionId?.();
			if (sharedId) {
				const bound = tracked.get(key);
				// Reuse only while the bound agent is still alive; a session the GUI
				// closed falls through to a fresh adopt/resume instead of a dead handle.
				if (bound && bound.handle.sessionId === sharedId && c.agents?.get?.(sharedId)) {
					bound.lastUsedAt = Date.now();
					return bound.handle;
				}
				const inFlight = ensureInFlight.get(key);
				if (inFlight) return inFlight;
				const p = adoptSessionImpl(key, sharedId, { preset: deps.preset?.() });
				ensureInFlight.set(key, p);
				try {
					return await p;
				} catch (err) {
					deps.logger?.warn(`shared session ${sharedId} unavailable (${err instanceof Error ? err.message : String(err)}) — falling back to a bridge session for ${key}`);
					ensureInFlight.delete(key);
					return ensureAgent(key);
				}
			}
			return ensureAgent(key);
		},
		adoptSession: adoptSessionImpl,
		get: (key) => tracked.get(key)?.handle,
		keyForSessionId: (sessionId) => keyBySession.get(sessionId),
		async listPresets() {
			const presets = c.get?.("agentPresets");
			if (!presets?.list) return [];
			try {
				return (await presets.list()).map((row) => ({
					id: row.id,
					label: row.name ?? row.id,
					...row.trust === void 0 ? {} : { trust: row.trust },
					...row.description === void 0 ? {} : { desc: row.description },
					...row.broken === void 0 ? {} : { broken: row.broken }
				}));
			} catch (err) {
				deps.logger?.warn(`agentPresets.list() failed — /mode falls back to shipped presets: ${String(err)}`);
				return [];
			}
		},
		disposeIdle(idleTtlMs) {
			// A shared-session binding stays subscribed for the process lifetime so
			// turns driven from the desktop GUI keep mirroring into Feishu.
			const sharedId = deps.sharedSessionId?.();
			let n = 0;
			for (const t of tracked.values()) {
				if (sharedId && t.handle.sessionId === sharedId) continue;
				if (t.handle.isIdle() && Date.now() - t.lastUsedAt >= idleTtlMs) {
					t.handle.dispose();
					n++;
				}
			}
			return n;
		},
		size: () => tracked.size,
		rotate(key) {
			runNonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
			generations.delete(key);
			const t = tracked.get(key);
			if (t) {
				disposers.get(key)?.();
				disposers.delete(key);
				listeners.delete(key);
				tracked.delete(key);
				const oldId = t.handle.sessionId;
				if (oldId) keyBySession.delete(oldId);
			}
		},
		async dispose(key) {
			const t = tracked.get(key);
			if (!t) return;
			await t.handle.dispose();
			tracked.delete(key);
		},
		async disposeAll() {
			for (const t of tracked.values()) await t.handle.dispose();
			tracked.clear();
			keyBySession.clear();
		}
	};
}
//#endregion
//#region src/sessions/dsh-session-backend.ts
/** The shipped preset roster, mirrored here so the memory backend (used when
* DSH services are absent) still answers a /mode picker with the four
* official modes. Kept in sync with `AGENT_PRESETS` in presentation/cards. */
const SHIPPED_PRESETS = [
	{
		id: "standard",
		label: "标准模式",
		desc: "全能：文件/Shell/检索/Skills/目标/子代理/工作流",
		trust: "system"
	},
	{
		id: "code",
		label: "PTC 模式",
		desc: "标准能力 + Code Mode（多步操作一次执行，更快）",
		trust: "system"
	},
	{
		id: "minimal",
		label: "极简模式",
		desc: "仅 bash + 文件编辑，轻量省 token",
		trust: "system"
	},
	{
		id: "cordis",
		label: "创造模式",
		desc: "标准能力 + preset 创作工具（面向开发者）",
		trust: "system"
	}
];
function createMemoryDshBackend(opts = {}) {
	const agents = /* @__PURE__ */ new Map();
	const keyBySession = /* @__PURE__ */ new Map();
	let counter = 0;
	const makeAgent = (key) => {
		const agentId = `agent-${++counter}`;
		const sessionId = `session-${counter}`;
		const listeners = /* @__PURE__ */ new Set();
		let busy = false;
		let disposed = false;
		const emit = (e) => {
			for (const fn of listeners) fn(e);
		};
		return {
			agentId,
			sessionId,
			async followup(text, attachments) {
				if (disposed) throw new Error("agent disposed");
				busy = true;
				const reply = opts.autoReply?.(key, text);
				const stream = async () => {
					const content = reply ?? `echo: ${text}`;
					const mid = Math.floor(content.length / 2);
					emit({
						type: "assistant/chunk",
						text: content.slice(0, mid)
					});
					if (opts.latencyMs) await new Promise((r) => setTimeout(r, opts.latencyMs));
					emit({
						type: "assistant/chunk",
						text: content.slice(mid)
					});
					emit({
						type: "assistant/message",
						text: content
					});
					emit({
						type: "turn/end",
						reason: "complete"
					});
					busy = false;
				};
				stream();
			},
			async cancel() {
				busy = false;
			},
			onEvent(fn) {
				listeners.add(fn);
				return () => listeners.delete(fn);
			},
			isIdle: () => !busy,
			async dispose() {
				disposed = true;
				listeners.clear();
				agents.delete(key);
				keyBySession.delete(sessionId);
			}
		};
	};
	return {
		agents,
		async ensureAgent(key) {
			let a = agents.get(key);
			if (!a) {
				a = makeAgent(key);
				agents.set(key, a);
				keyBySession.set(a.sessionId, key);
			}
			return a;
		},
		get: (key) => agents.get(key),
		keyForSessionId: (sessionId) => keyBySession.get(sessionId),
		listPresets: async () => [...SHIPPED_PRESETS],
		disposeIdle(ttlMs) {
			let n = 0;
			for (const [key, a] of agents) if (a.isIdle()) {
				a.dispose();
				agents.delete(key);
				keyBySession.delete(a.sessionId);
				n++;
			}
			return n;
		},
		size: () => agents.size,
		rotate() {},
		async dispose(key) {
			const a = agents.get(key);
			if (a) await a.dispose();
			agents.delete(key);
		},
		async disposeAll() {
			for (const a of agents.values()) await a.dispose();
			agents.clear();
			keyBySession.clear();
		}
	};
}
//#endregion
//#region src/sessions/conversation-manager.ts
function createConversationManager(deps) {
	const queues = /* @__PURE__ */ new Map();
	const hooks = /* @__PURE__ */ new Map();
	const keyFor = (msg) => msg.chatType === "p2p" ? `dm:${msg.chatId}` : `group:${msg.chatId}`;
	const enqueueSerial = (key, task) => {
		const next = (queues.get(key) ?? Promise.resolve()).then(task, task);
		queues.set(key, next.catch(() => void 0));
		return next;
	};
	const ensureUnderCap = async () => {
		if (deps.backend.size() < deps.maxSessions) return;
		deps.backend.disposeIdle(0);
		if (deps.backend.size() >= deps.maxSessions) {
			await new Promise((r) => setTimeout(r, 250));
			deps.backend.disposeIdle(0);
		}
	};
	return {
		keyFor,
		async handleMessage(msg, attachments) {
			const key = keyFor(msg);
			await ensureUnderCap();
			const agent = await deps.backend.ensureAgent(key);
			// Re-attach on every inbound message. The idle sweep or a re-adopt can
			// replace the handle, and a stale registration would silently stop
			// forwarding assistant output back to Feishu.
			hooks.get(key)?.();
			hooks.set(key, agent.onEvent((e) => deps.onEvent?.(key, e)));
			const text = msg.text ?? msg.content ?? "";
			await enqueueSerial(key, async () => {
				try {
					await agent.followup(text, attachments);
				} catch (err) {
					deps.logger?.warn(`followup failed for ${key}: ${String(err)}`);
				}
			});
		},
		async stop(key) {
			const agent = deps.backend.get(key);
			if (agent) await agent.cancel();
		},
		async dispose(key) {
			hooks.get(key)?.();
			hooks.delete(key);
			queues.delete(key);
			await deps.backend.dispose(key);
		},
		async rotate(key) {
			hooks.get(key)?.();
			hooks.delete(key);
			queues.delete(key);
			deps.backend.rotate(key);
		},
		sweep() {
			return deps.backend.disposeIdle(deps.idleTtlMs);
		},
		size: () => deps.backend.size(),
		keys: () => [...queues.keys()],
		async disposeAll() {
			for (const detach of hooks.values()) detach();
			hooks.clear();
			await deps.backend.disposeAll();
			queues.clear();
		}
	};
}
//#endregion
//#region src/sessions/turn-supervisor.ts
function createTurnSupervisor(deps) {
	const now = deps.now ?? Date.now;
	const armed = /* @__PURE__ */ new Map();
	let timer;
	return {
		arm(key) {
			armed.set(key, now());
		},
		disarm(key) {
			armed.delete(key);
		},
		start() {
			if (timer) return;
			timer = setInterval(() => {
				const cutoff = now() - deps.timeoutMs;
				for (const [key, armedAt] of armed) if (armedAt < cutoff) {
					armed.delete(key);
					deps.logger?.warn(`turn timeout for ${key}; disposing agent to unlock`);
					const agent = deps.backend.get(key);
					if (agent) agent.dispose().then(() => {
						deps.logger?.info(`disposed agent for ${key} after turn timeout`);
					});
				}
			}, 1e3);
			timer.unref?.();
		},
		stop() {
			if (timer) clearInterval(timer);
			timer = void 0;
			armed.clear();
		}
	};
}
//#endregion
//#region src/outbound/outbox.ts
/** Unref'd sleep so an idle pump never keeps the process alive. */
function sleep$2(ms) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms).unref?.();
	});
}
function createOutbox(deps) {
	const now = deps.now ?? Date.now;
	const dir = deps.dir;
	mkdirSync(join(dir, "blobs"), { recursive: true });
	/** id -> envelope (all statuses, bounded by prune). */
	const envelopes = /* @__PURE__ */ new Map();
	/** laneKey -> array of envelope ids in FIFO order (pending+failed+sending). */
	const lanes = /* @__PURE__ */ new Map();
	/** dedupeKey -> done/fatal envelope id (idempotency, 30d). */
	const sentKeys = /* @__PURE__ */ new Map();
	const isFatal = deps.isFatalError ?? ((e) => /400|403|invalid|not found/i.test(e));
	let draining = false;
	let stopped = false;
	let pruneTimer;
	const activeDeliveries = /* @__PURE__ */ new Set();
	const laneQueues = /* @__PURE__ */ new Map();
	/** Wake signal for the idle pump (set while it waits). */
	let idleWake;
	const emitStats = () => {
		try {
			let pending = 0;
			let failed = 0;
			for (const env of envelopes.values()) {
				if (env.status === "pending" || env.status === "failed") pending++;
				if (env.status === "failed") failed++;
			}
			deps.onStatsChange?.({
				pending,
				failed
			});
		} catch {}
	};
	const segmentPath = (n) => join(dir, `seg-${n}.jsonl`);
	function loadSegment(file) {
		try {
			const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
			for (const line of lines) try {
				const env = JSON.parse(line);
				envelopes.set(env.id, env);
				if (env.dedupeKey) sentKeys.set(env.dedupeKey, env.id);
				if (env.status === "pending" || env.status === "failed" || env.status === "sending") {
					const lane = lanes.get(env.laneKey) ?? [];
					lane.push(env.id);
					lanes.set(env.laneKey, lane);
				}
			} catch {}
		} catch {}
	}
	function rebuildFromDisk() {
		envelopes.clear();
		lanes.clear();
		sentKeys.clear();
		let segs = [];
		try {
			segs = readdirSync(dir).filter((f) => /^seg-\d+\.jsonl$/.test(f)).sort((a, b) => {
				return Number(basename(a).match(/\d+/)?.[0] ?? 0) - Number(basename(b).match(/\d+/)?.[0] ?? 0);
			});
		} catch {
			segs = [];
		}
		for (const seg of segs) loadSegment(join(dir, seg));
		let changed = false;
		for (const env of envelopes.values()) if (env.status === "sending") {
			env.status = "pending";
			env.updatedAt = now();
			changed = true;
		}
		if (changed) persistAll();
	}
	function persistAll() {
		try {
			const segFile = segmentPath(Math.floor(now() / 1e3));
			const lines = [...envelopes.values()].map((e) => JSON.stringify(e));
			const tmp = `${segFile}.tmp`;
			writeFileSync(tmp, lines.join("\n") + "\n", { mode: 384 });
			renameSync(tmp, segFile);
			const cutoff = now() - deps.cfg.retainDays * 864e5;
			for (const f of readdirSync(dir).filter((x) => /^seg-\d+\.jsonl$/.test(x))) if (Number(basename(f).match(/\d+/)?.[0] ?? 0) * 1e3 < cutoff) try {
				rmSync(join(dir, f));
			} catch {}
		} catch {}
	}
	function spill(payload) {
		if (JSON.stringify(payload).length <= deps.cfg.blobThreshold) return { payload };
		const ref = `${randomUUID()}.json`;
		try {
			writeFileSync(join(dir, "blobs", ref), JSON.stringify(payload), { mode: 384 });
			return { blobRef: ref };
		} catch {
			return { payload };
		}
	}
	function resolvePayload(env) {
		if (env.payload) return env.payload;
		if (env.blobRef) try {
			return JSON.parse(readFileSync(join(dir, "blobs", env.blobRef), "utf8"));
		} catch {
			return;
		}
	}
	function enqueue(input) {
		if (stopped) return void 0;
		if (!input.skipDedupe && sentKeys.has(input.dedupeKey)) return void 0;
		if (envelopes.size >= deps.cfg.pendingCap) return;
		const id = randomUUID();
		const spilled = spill(input.payload);
		const env = {
			id,
			dedupeKey: input.dedupeKey,
			laneKey: input.laneKey,
			route: input.route,
			kind: input.kind,
			status: "pending",
			attempts: 0,
			nextRetryAt: now(),
			createdAt: now(),
			updatedAt: now(),
			...spilled
		};
		envelopes.set(id, env);
		sentKeys.set(input.dedupeKey, id);
		const lane = lanes.get(input.laneKey) ?? [];
		lane.push(id);
		lanes.set(input.laneKey, lane);
		persistAll();
		idleWake?.();
		emitStats();
		return id;
	}
	async function deliverOne(id) {
		const env = envelopes.get(id);
		if (!env || env.status === "done" || env.status === "fatal") return;
		const payload = resolvePayload(env);
		if (!payload) {
			env.status = "fatal";
			env.error = "payload unresolved (blob missing)";
			env.updatedAt = now();
			return;
		}
		env.status = "sending";
		env.updatedAt = now();
		const resolved = {
			...env,
			payload
		};
		const result = await deps.sender.deliver(resolved, payload);
		if (result.ok) {
			env.status = "done";
			env.updatedAt = now();
			if (env.dedupeKey) sentKeys.set(env.dedupeKey, env.id);
		} else {
			env.attempts += 1;
			env.error = result.error;
			env.updatedAt = now();
			if (!result.retryable || isFatal(result.error)) env.status = "fatal";
			else if (env.attempts >= deps.cfg.maxAttempts) env.status = "fatal";
			else {
				env.status = "failed";
				const backoff = Math.min(deps.cfg.backoffMaxMs, 1e3 * 2 ** Math.min(env.attempts - 1, 10));
				env.nextRetryAt = now() + backoff;
			}
		}
		persistAll();
		emitStats();
	}
	/** Drain one lane FIFO. Failed messages fall out; retry sweep picks them up. */
	async function drainLane(laneKey) {
		const ids = lanes.get(laneKey);
		if (!ids || ids.length === 0) return;
		const head = ids.shift();
		lanes.set(laneKey, ids);
		if (head !== void 0) await deliverOne(head);
	}
	/** Retry sweep: re-drain 'failed' envelopes whose nextRetryAt has passed. */
	function retrySweep() {
		let woke = false;
		const due = [];
		for (const env of envelopes.values()) if (env.status === "failed" && env.nextRetryAt <= now()) due.push(env.id);
		for (const id of due) {
			const env = envelopes.get(id);
			if (env) {
				const lane = lanes.get(env.laneKey) ?? [];
				if (!lane.includes(id)) {
					lane.push(id);
					lanes.set(env.laneKey, lane);
					woke = true;
				}
			}
		}
		if (woke) idleWake?.();
	}
	async function pump() {
		if (draining) return;
		draining = true;
		try {
			while (!stopped) {
				retrySweep();
				let worked = false;
				for (const laneKey of lanes.keys()) {
					const ids = lanes.get(laneKey);
					if (ids && ids.length > 0) {
						worked = true;
						const next = (laneQueues.get(laneKey) ?? Promise.resolve()).then(() => drainLane(laneKey));
						laneQueues.set(laneKey, next.catch(() => void 0));
						activeDeliveries.add(next);
						next.finally(() => activeDeliveries.delete(next));
					}
				}
				if (!worked) {
					await new Promise((resolve) => {
						idleWake = resolve;
						setTimeout(() => {
							idleWake = void 0;
							resolve();
						}, 200).unref?.();
					});
					idleWake = void 0;
				} else await sleep$2(25);
			}
		} finally {
			draining = false;
		}
	}
	function doPrune() {
		const cutoff = now() - deps.cfg.retainDays * 864e5;
		let changed = false;
		for (const [id, env] of envelopes) if ((env.status === "done" || env.status === "fatal") && env.updatedAt < cutoff) {
			envelopes.delete(id);
			if (env.blobRef) try {
				rmSync(join(dir, "blobs", env.blobRef));
			} catch {}
			changed = true;
		}
		if (changed) persistAll();
		emitStats();
	}
	return {
		enqueue,
		start() {
			stopped = false;
			const cadence = deps.pruneIntervalMs ?? Math.max(36e5, Math.min(864e5, deps.cfg.retainDays * 36e5));
			doPrune();
			pruneTimer = setInterval(() => doPrune(), cadence);
			if (pruneTimer.unref) pruneTimer.unref();
			pump();
		},
		async stop() {
			stopped = true;
			if (pruneTimer) clearInterval(pruneTimer);
			pruneTimer = void 0;
			await Promise.allSettled([...activeDeliveries]);
		},
		pendingCount() {
			let n = 0;
			for (const env of envelopes.values()) if (env.status === "pending" || env.status === "failed") n++;
			return n;
		},
		failedCount() {
			let n = 0;
			for (const env of envelopes.values()) if (env.status === "failed") n++;
			return n;
		},
		prune: doPrune,
		rebuildFromDisk,
		lanes: () => [...lanes.keys()]
	};
}
//#endregion
//#region src/outbound/event-forwarder.ts
function createEventForwarder(deps) {
	const state = /* @__PURE__ */ new Map();
	const emptyState = () => ({
		acc: "",
		lastFlushAt: Date.now(),
		hasOutput: false,
		doneIssued: false
	});
	const routeRefFor = (route) => ({
		sessionKey: route.sessionKey,
		chatId: route.chatId,
		chatType: route.chatType,
		threadMessageId: route.threadMessageId
	});
	async function onSessionEvent(sessionKey, event) {
		const route = deps.routeFor(sessionKey);
		if (!route) return;
		const st = state.get(sessionKey) ?? emptyState();
		state.set(sessionKey, st);
		switch (event.type) {
			case "turn/start":
				st.hasOutput = false;
				st.doneIssued = false;
				st.acc = "";
				break;
			case "assistant/chunk": {
				const { streamingEnabled } = deps.cfg();
				if (!streamingEnabled) return;
				st.acc += event.text;
				const stream = deps.streamFor(sessionKey)?.ensureStream();
				if (stream) st.stream = stream;
				if (st.stream) await st.stream.patch(event.text);
				break;
			}
			case "assistant/message": {
				const text = st.acc.length > event.text.length ? st.acc : event.text;
				st.acc = "";
				if (!text || text.trim() === "" || text === "No response.") return;
				st.hasOutput = true;
				if (st.stream) try {
					await st.stream.finalize(text);
					st.stream = void 0;
					deps.onDelivered?.(sessionKey);
					return;
				} catch {
					st.stream = void 0;
				}
				await deps.outbox.enqueue({
					dedupeKey: `${sessionKey}:assistant:${text.length}:${Date.now()}`,
					laneKey: sessionKey,
					route: routeRefFor(route),
					kind: "assistant-output",
					payload: {
						kind: "text",
						text
					}
				});
				deps.onDelivered?.(sessionKey);
				break;
			}
			case "turn/end": {
				st.acc = "";
				if (st.stream) {
					try {
						await st.stream.finalize("");
					} catch {}
					st.stream = void 0;
				}
				const target = deps.streamFor(sessionKey);
				if (target && st.hasOutput && !st.doneIssued) {
					st.doneIssued = true;
					await target.markDone();
				}
				break;
			}
		}
	}
	async function finalizeSession(sessionKey) {
		const st = state.get(sessionKey);
		if (!st) return;
		if (st.acc.length > 0 && st.hasOutput === false) {
			const route = deps.routeFor(sessionKey);
			if (route) await deps.outbox.enqueue({
				dedupeKey: `${sessionKey}:finalize:${Date.now()}`,
				laneKey: sessionKey,
				route: routeRefFor(route),
				kind: "assistant-output",
				payload: {
					kind: "text",
					text: st.acc
				}
			});
		}
		if (st.stream) {
			try {
				await st.stream.finalize("");
			} catch {}
			st.stream = void 0;
		}
		state.delete(sessionKey);
	}
	return {
		onSessionEvent,
		finalizeSession
	};
}
//#endregion
//#region src/outbound/outbound-router.ts
function createRouteStore(file, now = Date.now) {
	let routes = /* @__PURE__ */ new Map();
	try {
		const raw = readFileSync(file, "utf8");
		const parsed = JSON.parse(raw);
		routes = new Map(parsed.map((r) => [r.sessionKey, r]));
	} catch {
		routes = /* @__PURE__ */ new Map();
	}
	const persist = () => {
		try {
			writeFileSync(file, JSON.stringify([...routes.values()], null, 2), { mode: 384 });
		} catch {}
	};
	return {
		get(key) {
			return routes.get(key);
		},
		all() {
			return [...routes.values()];
		},
		upsert(route) {
			routes.set(route.sessionKey, route);
			persist();
		},
		touch(key, lastMessageId) {
			const r = routes.get(key);
			if (!r) return;
			r.updatedAt = now();
			if (lastMessageId !== void 0) r.lastMessageId = lastMessageId;
			persist();
		},
		remove(key) {
			routes.delete(key);
			persist();
		},
		prune(maxAgeMs) {
			const cutoff = now() - maxAgeMs;
			let changed = false;
			for (const [k, r] of routes) if (r.updatedAt < cutoff) {
				routes.delete(k);
				changed = true;
			}
			if (changed) persist();
		},
		persist
	};
}
//#endregion
//#region src/inbound/transport.ts
function msgTypeOf(type) {
	switch (type) {
		case "text": return "text";
		case "post": return "post";
		case "image": return "image";
		case "file": return "file";
		case "audio": return "audio";
		case "interactive": return "interactive";
		default: return "unknown";
	}
}
function pickText(contentRaw, msgType) {
	if (!contentRaw) return void 0;
	try {
		const parsed = JSON.parse(contentRaw);
		if (typeof parsed.text === "string") return parsed.text;
		const content = parsed.content;
		if (msgType === "post" && content?.paragraphs) return content.paragraphs.map((p) => (p.elements ?? []).map((e) => e.text_run?.content ?? "").join("")).join("\n");
		if (typeof parsed.content === "string") return parsed.content;
	} catch {
		return contentRaw;
	}
}
function chatModeFor(opts) {
	if (opts.chatType === "p2p") return "p2p";
	if (opts.groupPolicy === "open") return "group_at";
	if (opts.groupPolicy === "mention") return opts.mentionedBot ? "group_at" : "group_all";
	return "group_at";
}
/**
* Normalize a raw Feishu event (any shape) into a FeishuInboundMessage.
* Returns undefined when the event is not a message we should process
* (e.g. non-message events, missing ids).
*/
function normalizeInbound(raw, opts = {}) {
	const msg = raw.message ?? raw;
	const messageId = msg.message_id ?? raw.message_id;
	const chatId = msg.chat_id ?? raw.chat_id;
	if (!messageId || !chatId) return void 0;
	const chatType = (msg.chat_type ?? raw.chat_type ?? "p2p") === "group" ? "group" : "p2p";
	const msgType = msgTypeOf(msg.message_type ?? raw.message_type);
	const senderOpenId = raw.sender?.sender_id?.open_id ?? raw.operator?.operator_id?.open_id ?? "unknown";
	const mentions = (msg.mentions ?? []).map((m) => m.id?.open_id ?? m.id?.user_id ?? m.name ?? "").filter(Boolean);
	return {
		messageId,
		chatId,
		chatType,
		chatMode: chatModeFor({
			chatType,
			mentionedBot: opts.mentionedBot ?? (opts.botOpenId !== void 0 ? mentions.includes(opts.botOpenId) : mentions.length > 0),
			groupPolicy: opts.groupPolicy ?? (chatType === "group" ? "mention" : "open")
		}),
		senderOpenId,
		msgType,
		content: msg.content ?? raw.content ?? "",
		text: pickText(msg.content ?? raw.content, msgType),
		rootId: msg.root_id ?? raw.root_id,
		parentId: msg.parent_id ?? raw.parent_id,
		threadId: msg.thread_id ?? raw.thread_id,
		mentions,
		timestamp: Number(msg.create_time ?? raw.create_time ?? Date.now())
	};
}
/** Event name constants. */
const EVENT_MESSAGE = "im.message.receive_v1";
const EVENT_CARD_ACTION = "card.action.trigger";
function createTransport(deps) {
	let started = false;
	let wsReadyFlag = false;
	let botOpenId;
	const normalize = deps.normalize ?? normalizeInbound;
	const client = () => deps.getClient();
	async function handleEvent(event, data) {
		deps.onEvent?.(event, data);
		if (event !== "im.message.receive_v1") return;
		const msg = normalize(data, { botOpenId });
		if (!msg) return;
		try {
			await deps.onMessage(msg);
		} catch (err) {
			deps.logger?.error(`onMessage failed: ${String(err)}`);
		}
	}
	return {
		async start() {
			if (started) return;
			started = true;
			const c = client();
			if (c.on) {
				c.on(EVENT_MESSAGE, (data) => void handleEvent(EVENT_MESSAGE, data));
				c.on(EVENT_CARD_ACTION, (data) => void handleEvent(EVENT_CARD_ACTION, data));
			}
			try {
				botOpenId = (await c.getBotInfo?.())?.open_id;
			} catch {}
			try {
				await c.ws?.start?.();
				wsReadyFlag = true;
			} catch (err) {
				deps.logger?.error(`ws start failed: ${String(err)}`);
				wsReadyFlag = false;
			}
		},
		async stop() {
			started = false;
			wsReadyFlag = false;
			try {
				await client().ws?.stop?.();
			} catch {}
		},
		isConnected: () => started && wsReadyFlag,
		wsReady: () => wsReadyFlag,
		async probe() {
			try {
				const bot = await client().getBotInfo?.();
				if (bot?.open_id) botOpenId = bot.open_id;
				return true;
			} catch {
				return false;
			}
		},
		botOpenId: () => botOpenId,
		async downloadResource(params) {
			const c = client();
			if (!c.downloadResource) throw new Error("lark client does not support downloadResource");
			return c.downloadResource(params);
		}
	};
}
/**
* Extract an upload key from a Feishu SDK upload response, tolerating BOTH
* the real top-level shape ({file_key}) and the legacy nested shape
* ({data:{file_key}}) — pi-feishu-link 2026-08-14 real-SDK fix.
*/
function extractUploadKey(res, key) {
	if (!res || typeof res !== "object") return void 0;
	const r = res;
	const direct = r[key];
	if (typeof direct === "string" && direct.length > 0) return direct;
	const nested = r.data?.[key];
	return typeof nested === "string" && nested.length > 0 ? nested : void 0;
}
//#endregion
//#region src/inbound/connection-supervisor.ts
const sleep$1 = (ms) => new Promise((r) => {
	setTimeout(r, ms).unref?.();
});
function createConnectionSupervisor(deps) {
	const now = deps.now ?? Date.now;
	let state = "idle";
	let timer;
	let stopped = false;
	let probeFailStreak = 0;
	let reconnectAttempts = 0;
	const setState = (s, detail) => {
		state = s;
		deps.status.setConn(s, detail ? { lastError: detail } : {});
		deps.onStateChange?.(s, detail);
		if (detail) deps.logger?.warn(`conn -> ${s}: ${detail}`);
		else deps.logger?.info(`conn -> ${s}`);
	};
	async function ensureConnected() {
		if (stopped) return;
		if (deps.transport.isConnected()) {
			if (state !== "connected") setState("connected");
			return;
		}
		if (state === "quarantined") return;
		if (deps.quota.tripped()) {
			setState("quarantined", `quota breaker tripped (${deps.cfg.quotaLimit}/${deps.cfg.quotaWindowMinutes}min); retry after reset`);
			return;
		}
		if (reconnectAttempts >= deps.cfg.maxReconnectAttempts) {
			deps.quota.recordFailure();
			setState("quarantined", `reconnect attempts exhausted (${reconnectAttempts}); circuit breaker armed`);
			return;
		}
		setState("connecting");
		deps.quota.recordConnect();
		try {
			await deps.transport.start();
		} catch (err) {
			deps.logger?.error(`transport.start threw: ${String(err)}`);
		}
		if (deps.transport.isConnected()) {
			reconnectAttempts = 0;
			probeFailStreak = 0;
			setState("connected");
		} else {
			reconnectAttempts++;
			deps.quota.recordFailure();
			if (deps.quota.tripped()) {
				setState("quarantined", `quota breaker tripped after ${reconnectAttempts} failed connects`);
				return;
			}
			setState("reconnecting", `connect failed (attempt ${reconnectAttempts}/${deps.cfg.maxReconnectAttempts})`);
		}
	}
	async function tick() {
		if (stopped) return;
		if (state === "quarantined") {
			const liftAt = deps.quota.resetAt();
			if (liftAt === void 0 || now() >= liftAt) {
				deps.logger?.info("quota window reset — auto-recovering from quarantine");
				deps.quota.reset();
				reconnectAttempts = 0;
				if (state === "quarantined") state = "reconnecting";
				await ensureConnected();
			}
			return;
		}
		let ok = false;
		try {
			ok = await Promise.race([deps.transport.probe(), sleep$1(deps.cfg.probeTimeoutMs).then(() => false)]);
		} catch {
			ok = false;
		}
		deps.status.update({
			lastProbeAt: now(),
			lastProbeOk: ok,
			wsReady: deps.transport.wsReady()
		});
		if (ok) {
			probeFailStreak = 0;
			if (!deps.transport.isConnected()) {
				reconnectAttempts = 0;
				await ensureConnected();
			} else if (state !== "connected") setState("connected");
			return;
		}
		probeFailStreak++;
		if (probeFailStreak >= deps.cfg.probeFailThreshold) {
			if (deps.transport.isConnected()) setState("degraded", `probe failed ${probeFailStreak}x`);
			await ensureConnected();
		}
	}
	return {
		async start() {
			stopped = false;
			setState("connecting");
			await ensureConnected();
			timer = setInterval(() => void tick(), deps.cfg.probeIntervalMs);
			timer.unref?.();
		},
		async stop() {
			stopped = true;
			if (timer) clearInterval(timer);
			await deps.transport.stop();
			setState("stopped");
		},
		async tick() {
			await tick();
		},
		state: () => state,
		async reconnect() {
			reconnectAttempts = 0;
			deps.quota.reset();
			await deps.transport.stop();
			await ensureConnected();
		}
	};
}
//#endregion
//#region src/inbound/missed-compensation.ts
/** Replay window: pull messages from the last N minutes of disconnection. */
const REPLAY_WINDOW_MS = 6e5;
function createMissedCompensation(deps) {
	const now = deps.now ?? Date.now;
	const delivered = /* @__PURE__ */ new Set();
	const maxTracked = 5e3;
	return {
		noteDelivered(messageId) {
			delivered.add(messageId);
			if (delivered.size > maxTracked) {
				const arr = [...delivered];
				delivered.clear();
				for (const id of arr.slice(-2500)) delivered.add(id);
			}
		},
		async onRecovered() {
			const until = now();
			const since = until - REPLAY_WINDOW_MS;
			let pulled = 0;
			for (const route of deps.routes.all()) try {
				const items = await deps.listMessages({
					chatId: route.chatId,
					startTimeMs: since,
					endTimeMs: until
				});
				for (const item of items) {
					if (delivered.has(item.messageId)) continue;
					deps.reinject({
						messageId: item.messageId,
						chatId: route.chatId,
						chatType: route.chatType,
						chatMode: route.chatType === "p2p" ? "p2p" : "group_at",
						senderOpenId: "unknown",
						msgType: "text",
						content: "",
						text: "",
						mentions: [],
						timestamp: item.timestampMs
					});
					delivered.add(item.messageId);
					pulled++;
				}
			} catch (err) {
				deps.logger?.warn(`compensation listMessages failed for ${route.chatId}: ${String(err)}`);
			}
			if (pulled > 0) deps.logger?.info(`compensation re-injected ${pulled} missed messages`);
		}
	};
}
//#endregion
//#region src/inbound/group-trigger.ts
function createGroupTrigger(deps) {
	return { shouldTrigger(msg) {
		if (msg.chatType !== "group") return true;
		const { policy, keywords, alsoOnReply } = deps.cfg();
		const botOpenId = deps.botOpenId?.();
		const isReplyToBot = msg.parentId !== void 0 || msg.rootId !== void 0;
		switch (policy) {
			case "open": return true;
			case "mention":
				if (botOpenId !== void 0 && msg.mentions.includes(botOpenId)) return true;
				if (msg.mentions.length > 0 || msg.chatMode === "group_at") return true;
				return alsoOnReply && isReplyToBot;
			case "keywords":
				if (keywords.some((k) => (msg.text ?? "").includes(k))) return true;
				return alsoOnReply && isReplyToBot;
			case "reply": return isReplyToBot;
			default: return false;
		}
	} };
}
//#endregion
//#region src/application/bridge-context.ts
function createBridgeContext(deps) {
	let _conversations;
	let _transport;
	let _outbox;
	let _forwarder;
	let _compensation;
	let _botOpenId;
	let _started = false;
	return {
		get conversations() {
			return _conversations;
		},
		setConversations(v) {
			_conversations = v;
		},
		get backend() {
			return deps.backend;
		},
		get transport() {
			return _transport;
		},
		setTransport(v) {
			_transport = v;
		},
		get outbox() {
			return _outbox;
		},
		setOutbox(v) {
			_outbox = v;
		},
		get router() {
			return deps.router;
		},
		get forwarder() {
			return _forwarder;
		},
		setForwarder(v) {
			_forwarder = v;
		},
		get compensation() {
			return _compensation;
		},
		setCompensation(v) {
			_compensation = v;
		},
		get sender() {
			return deps.sender;
		},
		get attachments() {
			return deps.attachments;
		},
		get logger() {
			return deps.logger;
		},
		get cfg() {
			return deps.cfg;
		},
		get configStore() {
			return deps.configStore;
		},
		get status() {
			return deps.status;
		},
		botOpenId: () => _botOpenId,
		setBotOpenId(v) {
			_botOpenId = v;
		},
		started: () => _started,
		setStarted(v) {
			_started = v;
		},
		conversationKeyFor: (msg) => msg.chatType === "p2p" ? `dm:${msg.chatId}` : `group:${msg.chatId}`,
		routeFor(key) {
			return deps.router?.get(key);
		},
		async markDone(key, triggerMessageId) {
			if (!triggerMessageId || !deps.sender) return;
			const doneEmoji = deps.cfg().reactions.done || "DONE";
			deps.logger.info(`markDone: ${key} -> ${triggerMessageId} (${doneEmoji})`);
			try {
				await deps.sender.addReaction(triggerMessageId, doneEmoji);
			} catch (err) {
				deps.logger.warn(`markDone reaction failed for ${key}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	};
}
//#endregion
//#region src/common/reactions.ts
/** All Feishu-valid emoji_type values (open.feishu.cn …/emojis-introduce). */
const VALID_EMOJI_TYPES = /* @__PURE__ */ new Set([
	"OK",
	"THUMBSUP",
	"THANKS",
	"MUSCLE",
	"FINGERHEART",
	"APPLAUSE",
	"FISTBUMP",
	"JIAYI",
	"DONE",
	"SMILE",
	"BLUSH",
	"LAUGH",
	"SMIRK",
	"LOL",
	"FACEPALM",
	"LOVE",
	"WINK",
	"PROUD",
	"WITTY",
	"SMART",
	"SCOWL",
	"THINKING",
	"SOB",
	"CRY",
	"ERROR",
	"NOSEPICK",
	"HAUGHTY",
	"SLAP",
	"SPITBLOOD",
	"TOASTED",
	"GLANCE",
	"DULL",
	"INNOCENTSMILE",
	"JOYFUL",
	"WOW",
	"TRICK",
	"YEAH",
	"ENOUGH",
	"TEARS",
	"EMBARRASSED",
	"KISS",
	"SMOOCH",
	"DROOL",
	"OBSESSED",
	"MONEY",
	"TEASE",
	"SHOWOFF",
	"COMFORT",
	"CLAP",
	"PRAISE",
	"STRIVE",
	"XBLUSH",
	"SILENT",
	"WAVE",
	"WHAT",
	"FROWN",
	"SHY",
	"DIZZY",
	"LOOKDOWN",
	"CHUCKLE",
	"WAIL",
	"CRAZY",
	"WHIMPER",
	"HUG",
	"BLUBBER",
	"WRONGED",
	"HUSKY",
	"SHHH",
	"SMUG",
	"ANGRY",
	"HAMMER",
	"SHOCKED",
	"TERROR",
	"PETRIFIED",
	"SKULL",
	"SWEAT",
	"SPEECHLESS",
	"SLEEP",
	"DROWSY",
	"YAWN",
	"SICK",
	"PUKE",
	"BETRAYED",
	"HEADSET",
	"EatingFood",
	"MeMeMe",
	"Sigh",
	"Typing",
	"Lemon",
	"Get",
	"LGTM",
	"OnIt",
	"OneSecond",
	"VRHeadset",
	"YouAreTheBest",
	"SALUTE",
	"SHAKE",
	"HIGHFIVE",
	"UPPERLEFT",
	"ThumbsDown",
	"SLIGHT",
	"TONGUE",
	"EYESCLOSED",
	"RoarForYou",
	"CALF",
	"BEAR",
	"BULL",
	"RAINBOWPUKE",
	"ROSE",
	"HEART",
	"PARTY",
	"LIPS",
	"BEER",
	"CAKE",
	"GIFT",
	"CUCUMBER",
	"Drumstick",
	"Pepper",
	"CANDIEDHAWS",
	"BubbleTea",
	"Coffee",
	"Yes",
	"No",
	"OKR",
	"CheckMark",
	"CrossMark",
	"MinusOne",
	"Hundred",
	"AWESOMEN",
	"Pin",
	"Alarm",
	"Loudspeaker",
	"Trophy",
	"Fire",
	"BOMB",
	"Music",
	"XmasTree",
	"Snowman",
	"XmasHat",
	"FIREWORKS",
	"REDPACKET",
	"FORTUNE",
	"LUCK",
	"FIRECRACKER",
	"StickyRiceBalls",
	"HEARTBROKEN",
	"POOP",
	"StatusFlashOfInspiration",
	"CLEAVER",
	"Soccer",
	"Basketball",
	"GeneralDoNotDisturb",
	"Status_PrivateMessage",
	"GeneralInMeetingBusy",
	"StatusReading",
	"StatusInFlight",
	"GeneralBusinessTrip",
	"GeneralWorkFromHome",
	"StatusEnjoyLife",
	"GeneralTravellingCar",
	"StatusBus",
	"GeneralSun",
	"GeneralMoonRest",
	"MoonRabbit",
	"Mooncake",
	"JubilantRabbit",
	"TV",
	"Movie",
	"Pumpkin",
	"BeamingFace",
	"Delighted",
	"ColdSweat",
	"FullMoonFace",
	"Partying",
	"GoGoGo",
	"ThanksFace",
	"SaluteFace",
	"Shrug",
	"ClownFace",
	"HappyDragon"
]);
/** Completion marker — never part of the random pool. */
const DONE_EMOJI = "DONE";
/**
* Default random receipt pool (all Feishu-valid). 2026-08-08 pi fix:
* FIRE → Fire (case-sensitive); ROCKET/SUN/WHITE_CHECK_MARK are NOT valid
* Feishu emoji_type values and cause addReaction 231001.
*/
const DEFAULT_RANDOM_POOL = [
	"THUMBSUP",
	"OK",
	"HEART",
	"LAUGH",
	"SMILE",
	"WOW",
	"CLAP",
	"Fire"
];
/**
* Build a reaction picker from a configured pool. Filters out any type not in
* VALID_EMOJI_TYPES (fail-safe: a stale config cannot 400 the bridge) AND the
* DONE marker (completion marker never participates in the random pool);
* falls back to the default pool when nothing valid remains.
*/
function createReactionPicker(pool, done) {
	const validPool = pool.filter((t) => VALID_EMOJI_TYPES.has(t) && t !== done);
	const effectivePool = validPool.length > 0 ? validPool : DEFAULT_RANDOM_POOL.filter((t) => t !== done);
	const effectiveDone = VALID_EMOJI_TYPES.has(done) ? done : DONE_EMOJI;
	return {
		pickRandom() {
			if (effectivePool.length === 0) return void 0;
			return effectivePool[Math.floor(Math.random() * effectivePool.length)];
		},
		done: () => effectiveDone
	};
}
//#endregion
//#region src/application/message-handler.ts
/** Sniff image media type from magic bytes (feishu im resources are raw). */
function sniffImageType(buf) {
	if (buf.length >= 8 && buf[0] === 137 && buf[1] === 80) return "image/png";
	if (buf.length >= 3 && buf[0] === 255 && buf[1] === 216) return "image/jpeg";
	if (buf.length >= 12 && buf.slice(0, 4).every((b, i) => b === [
		82,
		73,
		70,
		70
	][i]) && buf.slice(8, 12).every((b, i) => b === [
		87,
		69,
		66,
		80
	][i])) return "image/webp";
	if (buf.length >= 6 && buf[0] === 71 && buf[1] === 73) return "image/gif";
	return "image/png";
}
/** File extension (including dot) for an image media type. */
function imgExt(m) {
	switch (m) {
		case "image/png": return ".png";
		case "image/webp": return ".webp";
		case "image/gif": return ".gif";
		default: return ".jpg";
	}
}
/**
* Resolve inbound Feishu attachments (M6): image → download → attachment
* store (ImageBlock for the visual model); file → download → bounded text
* extraction. Failures degrade to text-only (never drop the message).
*/
async function resolveInboundAttachments(msg, ctx, inboundDir) {
	const out = [];
	if (!msg.messageId) return out;
	try {
		if (msg.msgType === "image") {
			const key = JSON.parse(msg.content ?? "{}").image_key;
			if (!key || !ctx.transport) return out;
			const buf = await ctx.transport.downloadResource({
				messageId: msg.messageId,
				fileKey: key,
				type: "image"
			});
			if (!buf || buf.length === 0) return out;
			let localPath;
			if (inboundDir) try {
				const ext = imgExt(sniffImageType(buf));
				const name = `feishu-${msg.messageId}-${Date.now()}${ext}`;
				mkdirSync(join(inboundDir, "media"), { recursive: true });
				const path = join(inboundDir, "media", name);
				writeFileSync(path, buf);
				localPath = path;
			} catch (err) {
				ctx.logger.warn(`inbound image persist failed: ${err instanceof Error ? err.message : String(err)}`);
			}
			const attach = {
				path: localPath ?? "feishu://image",
				kind: "image",
				name: localPath ?? "feishu-image"
			};
			const store = ctx.attachments;
			if (store?.saveImage) attach.imageRef = await store.saveImage({
				data: buf,
				mediaType: sniffImageType(buf),
				name: attach.name
			});
			out.push(attach);
		} else if (msg.msgType === "file") {
			const parsed = JSON.parse(msg.content ?? "{}");
			const key = parsed.file_key;
			const name = parsed.file_name ?? "附件";
			if (key && ctx.transport) {
				const buf = await ctx.transport.downloadResource({
					messageId: msg.messageId,
					fileKey: key,
					type: "file"
				});
				if (buf && buf.length > 0) {
					let localPath;
					if (inboundDir) try {
						mkdirSync(join(inboundDir, "media"), { recursive: true });
						const path = join(inboundDir, "media", `feishu-${msg.messageId}-${Date.now()}-${name}`);
						writeFileSync(path, buf);
						localPath = path;
					} catch (err) {
						ctx.logger.warn(`inbound file persist failed: ${err instanceof Error ? err.message : String(err)}`);
					}
					out.push({
						path: localPath ?? "feishu://file",
						kind: "file",
						name
					});
					if (buf.length <= 15e4) {
						const text = buf.toString("utf8");
						if (text && !text.includes("�")) out.push({
							path: "feishu://file-text",
							kind: "file",
							name: `${name} 内容提取`,
							textPreview: text
						});
					}
				}
			}
		}
	} catch (err) {
		ctx.logger.warn(`inbound attachment resolve failed: ${err instanceof Error ? err.message : String(err)}`);
	}
	return out;
}
function createMessageHandler(deps) {
	const logger = deps.ctx.logger;
	async function handle(msg, compensated) {
		if (!compensated && !deps.dedupe.add(msg.messageId)) {
			logger.info(`drop: duplicate ${msg.messageId}`);
			return "dropped";
		}
		const allowlist = deps.allowlist();
		if (allowlist.length > 0 && !allowlist.includes(msg.senderOpenId)) {
			logger.info(`drop: sender ${msg.senderOpenId} not in allowlist`);
			return "dropped";
		}
		if (!deps.groupTrigger.shouldTrigger(msg)) {
			logger.info(`drop: group policy for ${msg.chatId}`);
			return "dropped";
		}
		const reactions = deps.ctx.cfg().reactions;
		if (reactions.enabled) {
			const pick = createReactionPicker(reactions.pool, reactions.done).pickRandom();
			if (pick) try {
				await deps.ctx.sender?.addReaction(msg.messageId, pick);
			} catch {
				logger.warn(`receipt reaction failed for ${msg.messageId}`);
			}
		}
		if (await deps.commands.route(msg) === "agent") {
			const cm = deps.ctx.conversations;
			if (!cm) {
				logger.error("message dropped: conversations not assembled (late wiring?)");
				return "dropped";
			}
			const sessionKey = cm.keyFor(msg);
			deps.ctx.router?.upsert({
				sessionKey,
				chatId: msg.chatId,
				chatType: msg.chatType,
				lastMessageId: msg.messageId,
				updatedAt: Date.now()
			});
			const attachments = await resolveInboundAttachments(msg, deps.ctx, deps.inboundDir);
			if ((msg.msgType === "text" || (msg.text ?? "").trim() !== "") && !compensated && deps.wal) try {
				deps.wal.accept({
					messageId: msg.messageId,
					sessionKey,
					chatId: msg.chatId,
					chatType: msg.chatType,
					senderOpenId: msg.senderOpenId,
					text: (msg.text ?? msg.content ?? "").slice(0, 8e3)
				});
			} catch (err) {
				logger.warn(`inbound-wal accept failed: ${err instanceof Error ? err.message : String(err)}`);
			}
			try {
				await cm.handleMessage(msg, attachments);
			} catch (err) {
				logger.error(`conversation handling failed: ${String(err)}`);
				return "dropped";
			}
		}
		if (compensated) deps.onReinjected?.(msg);
		return "processed";
	}
	return {
		async handleInbound(msg) {
			return handle(msg, false);
		},
		async handleCompensated(msg) {
			await handle(msg, true);
		}
	};
}
//#endregion
//#region src/application/command-router.ts
const BRIDGE_COMMANDS = /* @__PURE__ */ new Set([
	"status",
	"workspace",
	"stop",
	"support",
	"doctor",
	"sessions",
	"lark-config",
	"help",
	"feishu-config",
	"model",
	"mode",
	"permission",
	"open",
	"unbind",
	"new"
]);
function createCommandRouter(deps) {
	return {
		isCommand(text) {
			return /^\//.test(text.trim());
		},
		async route(msg) {
			const text = (msg.text ?? msg.content ?? "").trim();
			if (text === "") return "skipped";
			if (!this.isCommand(text)) return "agent";
			const tokens = text.split(/\s+/);
			const cmdName = (tokens[0] ?? "").replace(/^\/+/, "").toLowerCase();
			const rawInput = tokens.slice(1).join(" ");
			if (BRIDGE_COMMANDS.has(cmdName) || cmdName === "lark") {
				const handled = await deps.bridgeHandler(cmdName, rawInput, msg);
				if (handled) {
					const cfg = deps.ctx.cfg();
					if (cfg.reactions.enabled) deps.ctx.sender?.addReaction(msg.messageId, cfg.reactions.done || "DONE").catch(() => void 0);
				}
				return handled ? "bridge" : "agent";
			}
			const key2 = deps.ctx.conversationKeyFor(msg);
			let agent = deps.ctx.backend?.get(key2);
			if (!agent) try {
				agent = await deps.ctx.backend?.ensureAgent?.(key2);
			} catch {}
			const agentId = agent?.agentId ?? "";
			if (agentId && deps.commands.has(cmdName, agentId)) try {
				const result = await deps.commands.run(cmdName, rawInput, agentId);
				const key = deps.ctx.conversationKeyFor(msg);
				if (result.kind === "success" && result.text) await deps.ctx.outbox?.enqueue({
					dedupeKey: `${key}:cmd:${cmdName}:${msg.messageId}`,
					laneKey: key,
					route: {
						sessionKey: key,
						chatId: msg.chatId,
						chatType: msg.chatType
					},
					kind: "command-reply",
					payload: {
						kind: "text",
						text: result.text
					}
				});
				else if (result.kind === "error" && result.text) await deps.ctx.outbox?.enqueue({
					dedupeKey: `${key}:cmd:${cmdName}:${msg.messageId}`,
					laneKey: key,
					route: {
						sessionKey: key,
						chatId: msg.chatId,
						chatType: msg.chatType
					},
					kind: "command-reply",
					payload: {
						kind: "text",
						text: `⚠️ ${result.text}`
					}
				});
				return "dsh";
			} catch {
				return "agent";
			}
			return "agent";
		}
	};
}
//#endregion
//#region src/application/status-formatter.ts
function formatStatusLine(s) {
	const parts = [
		`连接: ${s.connState.toUpperCase()}${s.wsReady ? " (WS)" : ""}`,
		`outbox: ${s.outboxPending} 待发 / ${s.outboxFailed} 失败`,
		`会话: ${s.sessions}`
	];
	if (s.inboundPending > 0) parts.push(`补发: ${s.inboundPending} 条未完成`);
	if (s.quarantinedUntil) {
		const mins = Math.ceil((s.quarantinedUntil - Date.now()) / 6e4);
		parts.push(`熔断: ${Math.max(0, mins)}min 后重试`);
	}
	if (s.lastError) parts.push(`最近错误: ${s.lastError}`);
	return parts.join(" · ");
}
function statusDetailLines(s) {
	const lines = [
		`状态: ${s.connState}`,
		`WS 就绪: ${s.wsReady}`,
		`上次探活: ${s.lastProbeAt ? new Date(s.lastProbeAt).toISOString() : "—"} (${s.lastProbeOk === void 0 ? "?" : s.lastProbeOk ? "正常" : "失败"})`,
		`outbox 待发: ${s.outboxPending}`,
		`outbox 失败: ${s.outboxFailed}`,
		`入站补发待处理: ${s.inboundPending}`,
		`活跃会话: ${s.sessions}`
	];
	if (s.connectedAt) lines.push(`连接时间: ${new Date(s.connectedAt).toISOString()}`);
	if (s.quarantinedUntil) lines.push(`熔断至: ${new Date(s.quarantinedUntil).toISOString()} (${s.quarantinedReason ?? ""})`);
	if (s.owner) lines.push(`持有者: pid ${s.owner.pid} @ ${s.owner.host} (${new Date(s.owner.startedAt).toISOString()})`);
	return lines;
}
/** Mask secrets in a diagnostics dump (config/credentials redaction). */
function redactSecrets(input, secrets) {
	let out = input;
	for (const secret of secrets) {
		if (!secret) continue;
		out = out.split(secret).join("***");
	}
	out = out.replace(/\b[0-9A-Za-z_\-]{32,}\b/g, "***");
	return out;
}
//#endregion
//#region src/application/diagnostics-service.ts
function createDiagnosticsService(deps) {
	return { async build() {
		const s = deps.ctx.status.get();
		const cfg = deps.ctx.cfg();
		const lines = [
			"# dsh-lark-link 诊断包",
			"",
			`生成时间: ${(/* @__PURE__ */ new Date()).toISOString()}`,
			`桥状态: ${deps.ctx.started() ? "运行中" : "未启动"}`,
			...statusDetailLines(s),
			"",
			"## 配置（脱敏）",
			"```json",
			redactSecrets(JSON.stringify(cfg, null, 2), deps.secrets),
			"```"
		];
		if (deps.extra) lines.push("", "## 附加信息", "```json", JSON.stringify(deps.extra, null, 2), "```");
		const issueMd = [
			"## 问题描述",
			"",
			"（请填写：现象 / 复现步骤 / 期望结果）",
			"",
			"## 诊断信息",
			"```",
			...lines,
			"```",
			"",
			"## 环境",
			"- dsh-lark-link: 0.1.0",
			"- Node: " + process.version
		].join("\n");
		return {
			text: lines.join("\n"),
			issueMd
		};
	} };
}
//#endregion
//#region src/common/connection-status.ts
function createStatusStore(file, now = Date.now) {
	let status = {
		connState: "idle",
		outboxPending: 0,
		outboxFailed: 0,
		inboundPending: 0,
		sessions: 0,
		wsReady: false
	};
	if (file) try {
		const raw = readFileSync(file, "utf8");
		status = {
			...status,
			...JSON.parse(raw)
		};
	} catch {}
	const persist = () => {
		if (!file) return;
		try {
			writeFileSync(file, JSON.stringify(status, null, 2), { mode: 384 });
		} catch {}
	};
	return {
		get: () => ({ ...status }),
		update(patch) {
			status = {
				...status,
				...patch
			};
			persist();
			return this.get();
		},
		setConn(state, extra) {
			const patch = {
				connState: state,
				...extra
			};
			if (state === "connected") patch.connectedAt = now();
			status = {
				...status,
				...patch
			};
			persist();
			return this.get();
		},
		refreshCounters(counters) {
			status = {
				...status,
				...counters
			};
			persist();
		}
	};
}
//#endregion
//#region src/common/config.ts
const DEFAULT_CONFIG = {
	credentialRef: "LARK_LINK_APP",
	groupPolicy: "open",
	groupKeywords: ["lark", "小斯"],
	alsoOnReply: true,
	streaming: {
		enabled: false,
		printFrequencyMs: 120,
		printStep: 3
	},
	reactions: {
		enabled: true,
		pool: [
			"THUMBSUP",
			"OK",
			"HEART",
			"LAUGH",
			"SMILE",
			"WOW",
			"CLAP",
			"Fire"
		],
		done: "DONE"
	},
	outbox: {
		maxAttempts: 50,
		backoffMaxMs: 6e4,
		retainDays: 7,
		pendingCap: 1e4,
		blobThreshold: 24e3
	},
	supervisor: {
		probeIntervalMs: 3e4,
		probeTimeoutMs: 8e3,
		probeFailThreshold: 3,
		maxReconnectAttempts: 8,
		idleKeepaliveMs: 12e5
	},
	quota: {
		windowMinutes: 60,
		limit: 12
	},
	denyList: [],
	sessionIdleTtlMs: 18e5,
	maxSessions: 32,
	allowlist: [],
	workspaceRoot: "",
	agentPreset: "code",
	permissionMode: "danger-full-access",
	// dsh-lark-link-plus: when set, every Feishu conversation routes into this
	// exact persisted DSH session, so the phone and the desktop GUI share one
	// continuous conversation. Persisted via /open; cleared by /unbind.
	sharedSessionId: "",
	// dsh-lark-link-plus: answer DSH approval requests (`approval/request`) with a
	// Feishu card so a phone tap grants or refuses the operation.
	feishuApprovals: true
};
/** Keys that may be hot-reloaded via /lark-config (whitelist, never credentials). */
const HOT_RELOADABLE = [
	"groupPolicy",
	"groupKeywords",
	"alsoOnReply",
	"workspaceRoot",
	"agentPreset",
	"permissionMode",
	"streaming",
	"reactions",
	"denyList",
	"allowlist",
	"sharedSessionId",
	"feishuApprovals"
];
function deepMerge(base, over) {
	const out = { ...base };
	for (const [k, v] of Object.entries(over ?? {})) {
		if (v === void 0) continue;
		const existing = out[k];
		if (existing !== null && v !== null && typeof existing === "object" && typeof v === "object" && !Array.isArray(existing) && !Array.isArray(v)) out[k] = deepMerge(existing, v);
		else out[k] = v;
	}
	return out;
}
function createConfigStore(stateDir, initialOverrides) {
	const overridesPath = join(stateDir, "runtime-overrides.json");
	mkdirSync(dirname(overridesPath), { recursive: true });
	let overrides = { ...initialOverrides ?? {} };
	try {
		const raw = readFileSync(overridesPath, "utf8");
		const parsed = JSON.parse(raw);
		overrides = deepMerge(overrides, parsed);
	} catch {}
	const get = () => deepMerge(DEFAULT_CONFIG, overrides);
	const persist = (file, data) => {
		try {
			writeFileSync(file, JSON.stringify(data, null, 2), { mode: 384 });
		} catch {}
	};
	return {
		get,
		update(partial) {
			for (const key of Object.keys(partial)) if (!HOT_RELOADABLE.includes(key)) throw new Error(`config key "${key}" is not hot-reloadable`);
			overrides = deepMerge(overrides, partial);
			return get();
		},
		save() {
			persist(join(stateDir, "config.json"), get());
		},
		saveOverrides() {
			persist(overridesPath, overrides);
		},
		path: () => overridesPath
	};
}
//#endregion
//#region src/common/logger.ts
function createLogger(scope, minLevel = "info") {
	const levelRank = {
		debug: 0,
		info: 1,
		warn: 2,
		error: 3
	};
	const emit = (level, msg, meta) => {
		if (levelRank[level] < levelRank[minLevel]) return;
		const line = `[${(/* @__PURE__ */ new Date()).toISOString()}] [${level.toUpperCase()}] [${scope}] ${msg}${meta ? ` ${JSON.stringify(meta)}` : ""}`;
		if (level === "error") process.stderr.write(line + "\n");
		else process.stdout.write(line + "\n");
	};
	return {
		debug: (m, meta) => emit("debug", m, meta),
		info: (m, meta) => emit("info", m, meta),
		warn: (m, meta) => emit("warn", m, meta),
		error: (m, meta) => emit("error", m, meta)
	};
}
//#endregion
//#region src/common/dedupe-store.ts
const MAX_RECORDS = 1e4;
function createDedupeStore(file, now = Date.now) {
	let records = [];
	try {
		const raw = readFileSync(file, "utf8");
		records = JSON.parse(raw).slice(-1e4);
	} catch {
		records = [];
	}
	const persist = () => {
		try {
			writeFileSync(file, JSON.stringify(records.slice(-1e4), null, 2), { mode: 384 });
		} catch {}
	};
	return {
		seen(messageId) {
			return records.some((r) => r.messageId === messageId);
		},
		add(messageId) {
			if (records.some((r) => r.messageId === messageId)) return false;
			records.push({
				messageId,
				at: now()
			});
			if (records.length > MAX_RECORDS) records = records.slice(-1e4);
			persist();
			return true;
		},
		prune(ttlMs) {
			const cutoff = now() - ttlMs;
			const before = records.length;
			records = records.filter((r) => r.at >= cutoff);
			if (records.length !== before) persist();
		}
	};
}
//#endregion
//#region src/inbound/inbound-wal.ts
function createInboundWal(deps) {
	const dir = deps.dir;
	const replayRetentionMs = deps.replayRetentionMs ?? 18e5;
	const maxReplayAttempts = deps.maxReplayAttempts ?? 2;
	const now = deps.now ?? Date.now;
	mkdirSync(dir, { recursive: true });
	/** messageId -> record (bounded set; pruned over time). */
	const records = /* @__PURE__ */ new Map();
	function load() {
		let segs = [];
		try {
			segs = readdirSync(dir).filter((f) => /^seg-.*\.jsonl$/.test(f)).sort();
		} catch {
			segs = [];
		}
		for (const seg of segs) try {
			const lines = readFileSync(join(dir, seg), "utf8").split("\n").filter(Boolean);
			for (const line of lines) try {
				const rec = JSON.parse(line);
				if (rec?.messageId) records.set(rec.messageId, rec);
			} catch {}
		} catch {}
	}
	function persistAll() {
		try {
			const segFile = join(dir, `seg-${Date.now()}.jsonl`);
			const tmp = `${segFile}.tmp`;
			const lines = [...records.values()].map((r) => JSON.stringify(r));
			writeFileSync(tmp, lines.join("\n") + "\n", { mode: 384 });
			renameSync(tmp, segFile);
		} catch {}
	}
	load();
	return {
		accept(rec) {
			const full = {
				...rec,
				acceptedAt: now(),
				attempts: 0,
				state: "accepted"
			};
			records.set(rec.messageId, full);
			persistAll();
			return full;
		},
		delivered(messageId) {
			const rec = records.get(messageId);
			if (!rec || rec.state === "delivered") return;
			rec.state = "delivered";
			persistAll();
		},
		markReplay(messageId) {
			const rec = records.get(messageId);
			if (!rec) return false;
			if (rec.state === "delivered") return false;
			if (rec.attempts >= maxReplayAttempts) return false;
			if (now() - rec.acceptedAt > replayRetentionMs) return false;
			rec.attempts += 1;
			rec.state = "replayed";
			persistAll();
			return true;
		},
		pendingReplays() {
			const cutoff = now() - replayRetentionMs;
			return [...records.values()].filter((r) => r.state !== "delivered" && r.attempts < maxReplayAttempts && r.acceptedAt >= cutoff).sort((a, b) => a.acceptedAt - b.acceptedAt);
		},
		prune() {
			const deliveredCutoff = now() - replayRetentionMs;
			let changed = false;
			for (const [id, r] of records) if (r.state === "delivered" ? r.acceptedAt < deliveredCutoff : r.acceptedAt < deliveredCutoff && r.attempts >= maxReplayAttempts) {
				records.delete(id);
				changed = true;
			}
			if (changed) persistAll();
		},
		remove(messageId) {
			if (records.delete(messageId)) persistAll();
		},
		pendingCount: () => records.size
	};
}
//#endregion
//#region src/common/quota-governor.ts
function createQuotaGovernor(historyFile, opts = {
	windowMinutes: 60,
	limit: 12
}) {
	const now = opts.now ?? Date.now;
	const windowMs = opts.windowMinutes * 6e4;
	let history = [];
	try {
		history = readFileSync(historyFile, "utf8").split("\n").filter(Boolean).map((l) => {
			try {
				return JSON.parse(l);
			} catch {
				return;
			}
		}).filter((r) => r !== void 0);
	} catch {
		history = [];
	}
	const persist = () => {
		try {
			mkdirSync(join(historyFile, ".."), { recursive: true });
			writeFileSync(historyFile, history.slice(-500).map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 384 });
		} catch {}
	};
	const prune = () => {
		const cutoff = now() - windowMs;
		history = history.filter((r) => r.at >= cutoff);
	};
	return {
		recordConnect() {
			prune();
			history.push({
				at: now(),
				ok: true
			});
			persist();
			return history.length;
		},
		recordFailure() {
			prune();
			history.push({
				at: now(),
				ok: false
			});
			persist();
		},
		tripped() {
			prune();
			return history.filter((r) => !r.ok).length >= opts.limit;
		},
		remaining() {
			prune();
			return Math.max(0, opts.limit - history.filter((r) => !r.ok).length);
		},
		resetAt() {
			prune();
			const oldest = history.filter((r) => !r.ok)[0];
			return oldest ? oldest.at + windowMs : void 0;
		},
		reset() {
			history = [];
			persist();
		}
	};
}
//#endregion
//#region src/presentation/cards.ts
/**
* schema 2.0 按钮：直接作为组件放 elements（平铺、宽度完整不缩略）；
* 交互回传用 behaviors:[{type:"callback",value}]（card.action.trigger 回调返回 value）。
*/
function button(text, value, style) {
	const b = {
		tag: "button",
		width: "fill",
		text: {
			tag: "plain_text",
			content: text
		},
		behaviors: [{
			type: "callback",
			value
		}]
	};
	if (style === "primary") b.type = "primary";
	if (style === "danger") b.type = "danger";
	return b;
}
/**
* Heuristic: does this reply carry markdown worth rendering as a card?
* Matches headings, lists, fenced code, blockquotes, bold, tables and
* paragraph breaks (pi-feishu-link rich-text mode selection).
*/
function looksLikeMarkdown(text) {
	const t = text.trim();
	if (!t) return false;
	if (/(^|\n)\s*(#{1,6}\s|[-*+]\s|\d+\.\s|```|>\s|\*\*|\|.*\|)/.test(t) || t.includes("\n\n")) return true;
	return false;
}
function markdownCard(markdown, opts = {}) {
	return {
		schema: "2.0",
		...opts.header ? { header: {
			title: {
				tag: "plain_text",
				content: opts.header
			},
			template: opts.accent ? "blue" : "grey"
		} } : {},
		body: { elements: [{
			tag: "markdown",
			content: markdown
		}] }
	};
}
/**
* Agent preset options (DSH agent-presets).
*
* `AGENT_PRESETS` is the FALLBACK roster — the four shipped presets — used
* when the live DSH agentPresets service is unreachable. When the service is
* up, the bridge renders the dynamic roster (shipped + user-authored) instead;
* see the DshSessionBackend.listPresets surface.
*/
const AGENT_PRESETS = [
	{
		id: "standard",
		label: "标准模式",
		desc: "全能：文件/Shell/检索/Skills/目标/子代理/工作流",
		trust: "system"
	},
	{
		id: "code",
		label: "PTC 模式",
		desc: "标准能力 + Code Mode（多步操作一次执行，更快）",
		trust: "system"
	},
	{
		id: "minimal",
		label: "极简模式",
		desc: "仅 bash + 文件编辑，轻量省 token",
		trust: "system"
	},
	{
		id: "cordis",
		label: "创造模式",
		desc: "标准能力 + preset 创作工具（面向开发者）",
		trust: "system"
	}
];
/** Permission preset options (dsh-permission-presets). */
const PERMISSION_PRESETS = [
	{
		id: "read-only",
		label: "只读",
		desc: "沙箱只读，危险操作需审批"
	},
	{
		id: "workspace-write",
		label: "工作区写",
		desc: "仅工作区可写，危险操作需审批"
	},
	{
		id: "danger-full-access",
		label: "Full access",
		desc: "全访问 + 审批 never（默认）"
	}
];
/** Append action buttons to a markdown card's body. */
function withButtons(card, buttons) {
	const c = card;
	return {
		...c,
		body: {
			...c.body ?? {},
			elements: [...c.body?.elements ?? [], ...buttons]
		}
	};
}
/**
* Intent-confirmation card (DSH ask_user_question → Feishu).
*
* Single-select (default): one button per option, answered immediately via op
* "uqa:<questionId>:<optionIndex>".
*
* Multi-select (multiSelect === true): a form_container with a
* multi_select_static dropdown; the user taps 提交 and the onSubmit callback
* returns action.formValue.answer (string[] of option indexes) via op
* "uqam:<questionId>".
*
* The footer always invites a plain-text reply as a custom answer.
*/
function questionCard(q) {
	const header = q.header ? { header: {
		title: {
			tag: "plain_text",
			content: q.header
		},
		template: "blue"
	} } : {};
	if (q.multiSelect) {
		const options = (q.options ?? []).map((o, i) => ({
			text: {
				tag: "plain_text",
				content: o.label
			},
			value: String(i)
		}));
		return {
			schema: "2.0",
			...header,
			body: { elements: [
				{
					tag: "markdown",
					content: q.question
				},
				...q.detail ? [{
					tag: "markdown",
					content: q.detail
				}] : [],
				{
					tag: "form_container",
					children: [{
						tag: "multi_select_static",
						name: "answer",
						placeholder: {
							tag: "plain_text",
							content: "请选择（可多选）…"
						},
						options
					}],
					onSubmit: [{
						type: "callback",
						value: { op: `uqam:${q.id}` }
					}]
				},
				{
					tag: "markdown",
					content: "或直接发消息输入自定义答案"
				}
			] }
		};
	}
	const elements = [{
		tag: "markdown",
		content: q.question
	}, ...q.detail ? [{
		tag: "markdown",
		content: q.detail
	}] : []];
	(q.options ?? []).forEach((o, i) => {
		elements.push(button(o.label, { op: `uqa:${q.id}:${i}` }));
	});
	elements.push({
		tag: "markdown",
		content: "或直接发消息输入自定义答案"
	});
	return {
		schema: "2.0",
		...header,
		body: { elements }
	};
}
/**
 * Approval card (DSH `approval/request` → Feishu). One tap grants exactly the
 * requested operation (`allowed-once`) or refuses it; both buttons carry the
 * pending id so a late tap after settlement is a no-op.
 */
function approvalCard(req, id) {
	const lines = [`**工具**：\`${req.toolName}\``];
	if (req.reason) lines.push(`**原因**：${req.reason}`);
	lines.push("", "这条操作需要你的授权才能继续。");
	return withButtons(markdownCard(lines.join("\n"), {
		header: "🔐 操作授权请求",
		accent: true
	}), [
		button("✅ 允许这次", { op: `apv:${id}:allow` }, "primary"),
		button("⛔ 拒绝", { op: `apv:${id}:reject` }, "danger")
	]);
}
/** Single-select mode picker card — tap a button to switch (no typing). */
function modeCard(current, presets) {
	return markdownCard([
		"**Agent 模式**（单选，点按钮即切换，下条消息生效）",
		"",
		...(presets && presets.length > 0 ? presets : AGENT_PRESETS).map((p) => `- ${p.label}${p.trust === "user" ? "（自定义）" : ""}${current === p.id ? " ← 当前" : ""}：${p.desc ?? p.id}${p.broken ? `（不可用：${p.broken}）` : ""}`)
	].join("\n"), {
		header: "切换模式",
		accent: true
	});
}
/** Model picker card grouped by provider: provider header + one button per model. */
function modelCard(current, groups) {
	const elements = [{
		tag: "markdown",
		content: `**当前模型**: ${current?.provider ?? "?"}/${current?.model ?? "未设置"}`
	}, {
		tag: "markdown",
		content: "**按供应商选择模型**（点按钮即切换，下条消息生效）"
	}];
	let first = true;
	for (const g of groups) {
		if (g.models.length === 0) continue;
		if (!first) elements.push({ tag: "hr" });
		first = false;
		elements.push({
			tag: "markdown",
			content: `**${g.label ?? g.provider}**`
		});
		for (const m of g.models) elements.push({
			tag: "button",
			width: "fill",
			text: {
				tag: "plain_text",
				content: m.name ?? m.id
			},
			behaviors: [{
				type: "callback",
				value: { op: `model:${g.provider}/${m.id}` }
			}]
		});
	}
	if (first) elements.push({
		tag: "markdown",
		content: "（无可用模型列表）"
	});
	return {
		schema: "2.0",
		header: {
			title: {
				tag: "plain_text",
				content: "切换模型"
			},
			template: "blue"
		},
		body: { elements }
	};
}
/** Single-select permission picker card. */
function permissionCard(current) {
	return markdownCard([
		"**权限模式**（单选，点按钮即切换）",
		"",
		...PERMISSION_PRESETS.map((p) => `- ${p.label}${current === p.id ? " ← 当前" : ""}：${p.desc}`)
	].join("\n"), {
		header: "切换权限",
		accent: true
	});
}
/** Format an epoch-ms timestamp in the host's local timezone (`YYYY-MM-DD HH:mm`). */
function formatLocalTime(ms) {
	if (!ms) return "?";
	const d = new Date(ms);
	const p = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function helpCard() {
	return markdownCard([
		"**可用命令**（点按钮或直接输入）",
		"",
		"- `/status` 桥接状态",
		"- `/mode` 切换 Agent 模式（标准/PTC/极简/创造）",
		"- `/permission` 切换权限（只读/工作区写/Full access）",
		"- 🔐 授权请求会以卡片发到这里，点「允许/拒绝」即可（需权限为只读或工作区写）",
		"- `/sessions` 列出电脑 GUI 的历史会话（增强版）",
		"- `/open <id>` 绑定共享会话：飞书与电脑用同一个对话（增强版）",
		"- `/unbind` 解除共享会话绑定（增强版）",
		"- `/new` 当前工作区新起会话",
		"- `/workspace <路径>` 切换工作区（`~` 可用）",
		"- `/stop` 停止当前会话任务",
		"- `/doctor` 生成诊断包（含 session log）",
		"- `/model` 查看/切换模型",
		"- `/lark-config k=v` 热改配置",
		"- `/lark setup|start|stop|status` 桥接管理",
		"- `/goal` 等 DSH 命令原样执行",
		"- skill 无需前缀：直接说任务（如「用 X skill 做 Y」）"
	].join("\n"), {
		header: "Lark Link 帮助",
		accent: true
	});
}
//#endregion
//#region src/host/auth-setup.ts
/** Bridge-required event subscription: message arrival. */
const REQUIRED_EVENT = "im.message.receive_v1";
/** Bridge-dependent permission scopes (message + group-all + reactions). */
const SETUP_SCOPES = [
	"im:message",
	"im:message.send_as_bot",
	"im:chat",
	"im:resource",
	"im:message.group_msg",
	"im:message.reactions:write_only"
];
/** Pure function — unit-testable addon builder. */
function buildSetupAddons() {
	return {
		scopes: { tenant: [...SETUP_SCOPES] },
		events: { items: { tenant: [REQUIRED_EVENT] } },
		callbacks: { items: ["card.action.trigger"] }
	};
}
/** Detect Lark (international) vs Feishu (China) from the registerApp result. */
function detectDomain(userInfo) {
	return userInfo?.tenant_brand === "lark" ? "lark" : "feishu";
}
function createAuthSetup(deps) {
	return { async run(opts) {
		opts.onStatusChange?.("创建应用中…");
		const created = await deps.registerApp({
			source: "dsh-lark-link",
			addons: buildSetupAddons(),
			onQRCodeReady: (info) => opts.onQRCodeReady(info),
			onStatusChange: (info) => opts.onStatusChange?.(info.status ?? "…")
		});
		const appId = created.client_id ?? "";
		const appSecret = created.client_secret ?? "";
		if (!appId || !appSecret) throw new Error("registerApp 未返回 client_id/client_secret");
		const domain = detectDomain(created.user_info);
		opts.onStatusChange?.("校验事件订阅…");
		await deps.persist({
			appId,
			appSecret,
			domain
		});
		opts.onStatusChange?.("完成 ✅");
		return {
			appId,
			appSecret,
			domain
		};
	} };
}
/** base64url(gzip(addons)) — matches the SDK's encodeAddons encoding. */
function encodeAddons(addons) {
	const json = JSON.stringify(addons);
	return gzipSync(Buffer.from(json, "utf8")).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function postForm(url, params, signal) {
	let res;
	try {
		res = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Accept: "application/json",
				"User-Agent": "dsh-lark-link (device-code client)"
			},
			body: new URLSearchParams(params).toString(),
			signal
		});
	} catch (err) {
		throw new Error(`registration request failed: ${err instanceof Error ? err.message : String(err)}`);
	}
	let data;
	try {
		data = await res.json();
	} catch {
		data = {};
	}
	if (!res.ok && !data.error) throw new Error(`registration request failed: HTTP ${res.status}`);
	return data;
}
function sleep(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(/* @__PURE__ */ new Error("Registration was aborted"));
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
		const onAbort = () => {
			cleanup();
			reject(/* @__PURE__ */ new Error("Registration was aborted"));
		};
		const cleanup = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
/**
* registerApp implementation over global fetch. Wire protocol mirrors
* @larksuiteoapi/node-sdk's registerApp (device-code flow against
* accounts.feishu.cn / accounts.larksuite.com), so the QR and created-app
* payload are byte-compatible with the SDK path.
*/
function registerAppWithFetch() {
	return async (options) => {
		const { source, signal, onQRCodeReady, onStatusChange, addons } = options;
		const baseUrl = "https://accounts.feishu.cn";
		const larkBaseUrl = "https://accounts.larksuite.com";
		const endpoint = "/oauth/v1/app/registration";
		const beginRes = await postForm("https://accounts.feishu.cn/oauth/v1/app/registration", {
			action: "begin",
			archetype: "PersonalAgent",
			auth_method: "client_secret",
			request_user_info: "open_id"
		}, signal);
		const verificationUri = beginRes.verification_uri_complete;
		if (typeof verificationUri !== "string" || verificationUri === "") throw new Error(beginRes.error_description ?? "registerApp begin 未返回 verification_uri_complete");
		let qrUrl;
		try {
			qrUrl = new URL(verificationUri);
		} catch {
			throw new Error(`registerApp begin 返回了无效的 verification_uri_complete: ${verificationUri.slice(0, 80)}`);
		}
		qrUrl.searchParams.set("from", "sdk");
		qrUrl.searchParams.set("source", `node-sdk/${source}`);
		qrUrl.searchParams.set("tp", "sdk");
		if (addons) qrUrl.searchParams.set("addons", encodeAddons(addons));
		onQRCodeReady({
			url: qrUrl.toString(),
			expireIn: beginRes.expires_in ?? 600
		});
		const deviceCode = beginRes.device_code;
		if (!deviceCode) throw new Error("registerApp begin 未返回 device_code");
		let currentBase = baseUrl;
		let interval = (beginRes.interval ?? 5) * 1e3;
		const deadline = Date.now() + (beginRes.expires_in ?? 600) * 1e3;
		let domainSwitched = false;
		while (Date.now() < deadline) {
			if (signal?.aborted) throw new Error("Registration was aborted");
			const pollRes = await postForm(currentBase + endpoint, {
				action: "poll",
				device_code: deviceCode
			}, signal);
			const userInfo = pollRes.user_info;
			if (userInfo?.tenant_brand === "lark" && !domainSwitched) {
				currentBase = larkBaseUrl;
				domainSwitched = true;
				onStatusChange?.({ status: "domain_switched" });
				continue;
			}
			const clientId = pollRes.client_id;
			const clientSecret = pollRes.client_secret;
			if (clientId && clientSecret) return {
				client_id: clientId,
				client_secret: clientSecret,
				user_info: userInfo
			};
			switch (pollRes.error) {
				case "authorization_pending":
					onStatusChange?.({ status: "polling" });
					break;
				case "slow_down":
					interval += 5e3;
					onStatusChange?.({
						status: "slow_down",
						interval: interval / 1e3
					});
					break;
				case "access_denied":
				case "expired_token": throw new Error(pollRes.error_description ?? `注册失败：${String(pollRes.error)}`);
				default: if (pollRes.error) throw new Error(pollRes.error_description ?? `注册失败：${String(pollRes.error)}`);
			}
			await sleep(interval, signal);
		}
		throw new Error("注册轮询超时（二维码已过期），请重新运行 /lark setup");
	};
}
//#endregion
//#region src/host/lark-client.ts
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
function isValidRef(ref) {
	return REF_PATTERN.test(ref);
}
/** Parse the stored JSON blob into credentials; undefined if absent/malformed. */
function parseCredentials(raw) {
	if (!raw) return void 0;
	try {
		const parsed = JSON.parse(raw);
		if (parsed.appId && parsed.appSecret) return {
			appId: parsed.appId,
			appSecret: parsed.appSecret,
			domain: parsed.domain === "lark" ? "lark" : "feishu"
		};
	} catch {}
}
async function resolveCredentials(store, ref) {
	return parseCredentials((await store.resolve(ref))?.value);
}
async function persistCredentials(store, ref, creds) {
	if (!isValidRef(ref)) throw new TypeError(`credential ref "${ref}" must match ${String(REF_PATTERN)}`);
	await store.set(ref, JSON.stringify(creds));
}
async function clearCredentials(store, ref) {
	await store.unset(ref);
}
/** Default loader: dynamic import of the real SDK (kept out of test paths). */
const defaultSdkLoader = async () => await import("@larksuiteoapi/node-sdk");
/**
* Build a FeishuClientLike backed by the real SDK. Event handlers attach via
* `.on()` (forwarded to the EventDispatcher); `ws.start()` boots the WSClient
* with that dispatcher; send/probe/upload calls translate to SDK shapes.
*/
async function buildLarkClient(opts) {
	const sdk = await (opts.sdkLoader ?? defaultSdkLoader)();
	const domain = opts.domain === "lark" ? sdk.Domain.Lark : sdk.Domain.Feishu;
	const dh = sdk.defaultHttpInstance;
	if (dh?.defaults) dh.defaults.proxy = false;
	const clientOpts = {
		appId: opts.appId,
		appSecret: opts.appSecret,
		appType: sdk.AppType.SelfBuild,
		domain,
		loggerLevel: sdk.LoggerLevel.error
	};
	const sdkClient = new sdk.Client(clientOpts);
	const dispatcher = new sdk.EventDispatcher({ loggerLevel: sdk.LoggerLevel.error });
	const wsClient = new sdk.WSClient(clientOpts);
	return {
		on(event, handler) {
			dispatcher.register({ [event]: handler });
		},
		ws: {
			start() {
				try {
					wsClient.start({ eventDispatcher: dispatcher });
				} catch (err) {
					opts.logger?.error(`wsClient.start failed: ${err instanceof Error ? err.message : String(err)}`);
				}
			},
			stop() {
				Promise.resolve(wsClient.stop?.()).catch(() => void 0);
			}
		},
		async getBotInfo() {
			const res = await sdkClient.request({
				url: "/open-apis/bot/v3/info",
				method: "GET"
			});
			const bot = res?.bot ?? (res?.data)?.bot;
			return {
				open_id: bot?.open_id ?? (res?.data)?.open_id,
				name: bot?.app_name
			};
		},
		async sendMessage(params) {
			const p = params;
			return sdkClient.im.message.create({
				params: { receive_id_type: p.receive_id_type },
				data: p.params
			});
		},
		async addReaction(params) {
			const p = params;
			return sdkClient.im.messageReaction.create({
				path: { message_id: p.message_id },
				data: { reaction_type: { emoji_type: p.emoji_type } }
			});
		},
		async listMessages(params) {
			const p = params;
			const res = await sdkClient.im.message.list({ params: {
				...p,
				page_size: 50
			} });
			return { items: (res?.items ?? (res?.data)?.items ?? []).map((i) => ({
				message_id: i.message_id,
				create_time: i.create_time
			})) };
		},
		async uploadFile(params) {
			const p = params;
			const fileType = {
				pdf: "pdf",
				doc: "doc",
				docx: "doc",
				xls: "xls",
				xlsx: "xls",
				ppt: "ppt",
				pptx: "ppt",
				mp4: "mp4",
				opus: "opus"
			}[(p.file_name ?? "").split(".").pop()?.toLowerCase() ?? ""] ?? "stream";
			return sdkClient.im.file.create({ data: {
				file_type: fileType,
				file_name: p.file_name ?? "file",
				file: p.file
			} });
		},
		async uploadImage(params) {
			const p = params;
			return sdkClient.im.image.create({ data: {
				image_type: "message",
				image: p.image
			} });
		},
		async downloadResource(params) {
			const p = params;
			const stream = (await sdkClient.request({
				url: `/open-apis/im/v1/messages/${p.messageId}/resources/${p.fileKey}`,
				method: "GET",
				params: { type: p.type },
				responseType: "stream"
			}))?.getReadableStream?.();
			if (!stream) throw new Error(`downloadResource: no stream for ${p.fileKey}`);
			const chunks = [];
			for await (const chunk of stream) chunks.push(Buffer.from(chunk));
			return Buffer.concat(chunks);
		}
	};
}
//#endregion
//#region src/index.ts
const name = "dsh-lark-link";
const inject = [
	"tools",
	"commands",
	"agents",
	"systemPrompt",
	"credentials",
	"webServer"
];
/** Bridge state directory (<DSH_HOME>/lark-link, overridable). */
function stateDir() {
	return process.env.DSH_LARK_LINK_HOME ?? join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "lark-link");
}
function apply(ctx, rawConfig) {
	const cfg = rawConfig;
	if (cfg?.enabled === false) return;
	const dir = stateDir();
	mkdirSync(dir, { recursive: true });
	const logger = createLogger("lark-link");
	const configStore = createConfigStore(dir, {
		groupPolicy: cfg?.groupPolicy,
		denyList: cfg?.denyList
	});
	const status = createStatusStore(join(dir, "status.json"));
	const routeStore = createRouteStore(join(dir, "routes.json"));
	const dedupe = createDedupeStore(join(dir, "dedupe.jsonl"));
	const inboundWal = createInboundWal({ dir: join(dir, "inbound-wal") });
	const getCfg = () => configStore.get();
	let syncTried = 0;
	function syncDefaultPermission() {
		const settings = ctx.get?.("settings");
		if (!settings?.update) {
			syncTried++;
			if (syncTried <= 4) setTimeout(syncDefaultPermission, 500 * syncTried);
			return;
		}
		const mode = getCfg().permissionMode;
		settings.update("permission", { defaultPreset: mode }).then(() => logger.info(`permission default set to ${mode}`)).catch((err) => {
			syncTried++;
			logger.warn(`sync permission default to ${mode} failed: ${err instanceof Error ? err.message : String(err)}`);
			if (syncTried < 4) setTimeout(syncDefaultPermission, 500 * syncTried);
		});
	}
	syncDefaultPermission();
	const liveModelSelection = {
		provider: "",
		model: ""
	};
	{
		const cur = (ctx.get?.("agentDefaultModel"))?.currentSelection?.();
		if (cur?.provider && cur.model) {
			liveModelSelection.provider = cur.provider;
			liveModelSelection.model = cur.model;
		}
	}
	const runNonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
	let backend;
	try {
		backend = createDshAdapter({
			ctx,
			sessionPrefix: "lark-link",
			runNonce,
			logger,
			cwd: () => getCfg().workspaceRoot || process.cwd(),
			preset: () => {
				const p = getCfg().agentPreset || "code";
				return p === "ptc" ? "code" : p;
			},
			modelSelection: { current: liveModelSelection },
			sharedSessionId: () => getCfg().sharedSessionId,
			askUserQuestion
		});
	} catch (err) {
		logger.warn(`DSH adapter unavailable — using in-memory backend: ${String(err)}`);
		backend = createMemoryDshBackend();
	}
	let larkClient;
	const getLarkClient = () => larkClient;
	const credStore = {
		resolve: (ref) => ctx.credentials?.resolve(ref) ?? Promise.resolve(void 0),
		set: (ref, value) => ctx.credentials?.set(ref, value) ?? Promise.resolve(),
		unset: (ref) => ctx.credentials?.unset(ref) ?? Promise.resolve()
	};
	let startBlocker;
	const maskId = (id) => id.length <= 8 ? "****" : `${id.slice(0, 6)}…${id.slice(-4)}`;
	let activeQr;
	const webServer = ctx.webServer;
	if (webServer) {
		ctx.effect(() => webServer.register({
			kind: "exact",
			path: "/plugins/lark-link/qr",
			handler: (_req, res) => {
				const r = res;
				if (activeQr && Date.now() < activeQr.expireAt) {
					r.writeHead(200, {
						"Content-Type": "image/png",
						"Cache-Control": "no-store"
					});
					r.end(activeQr.png);
				} else {
					r.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
					r.end("no active lark-link setup qr (run /lark setup)");
				}
			}
		}), "lark-link: webui qr route");
		ctx.effect(() => webServer.register({
			kind: "exact",
			path: "/plugins/lark-link/status",
			handler: async (_req, res) => {
				const r = res;
				const configured = Boolean(await resolveCredentials(credStore, getCfg().credentialRef));
				r.writeHead(200, {
					"Content-Type": "application/json; charset=utf-8",
					"Cache-Control": "no-store"
				});
				r.end(JSON.stringify({
					...status.get(),
					configured
				}));
			}
		}), "lark-link: webui status route");
	}
	const sender = {
		async replyTo(msg, textOrCard) {
			const text = typeof textOrCard === "string" ? textOrCard : JSON.stringify(textOrCard);
			if (typeof textOrCard === "string") await sender.sendText(msg.chatId, text);
			else await sender.sendCard(msg.chatId, textOrCard);
		},
		async sendText(chatId, text) {
			const client = getLarkClient();
			if (!client?.sendMessage) throw new Error("lark client not ready");
			if (looksLikeMarkdown(text) && text.length <= 28e3) {
				await client.sendMessage({
					receive_id_type: chatId.startsWith("oc_") ? "chat_id" : "open_id",
					params: {
						receive_id: chatId,
						msg_type: "interactive",
						content: JSON.stringify(markdownCard(text))
					}
				});
				return;
			}
			await client.sendMessage({
				receive_id_type: chatId.startsWith("oc_") ? "chat_id" : "open_id",
				params: {
					receive_id: chatId,
					msg_type: "text",
					content: JSON.stringify({ text })
				}
			});
		},
		async sendCard(chatId, card) {
			const client = getLarkClient();
			if (!client?.sendMessage) throw new Error("lark client not ready");
			await client.sendMessage({
				receive_id_type: chatId.startsWith("oc_") ? "chat_id" : "open_id",
				params: {
					receive_id: chatId,
					msg_type: "interactive",
					content: JSON.stringify(card)
				}
			});
		},
		async addReaction(messageId, emojiType) {
			const client = getLarkClient();
			if (!client?.addReaction) throw new Error("lark client not ready");
			await client.addReaction({
				message_id: messageId,
				emoji_type: emojiType
			});
		},
		async sendFile(chatId, fileKey, type) {
			const client = getLarkClient();
			if (!client?.sendMessage) throw new Error("lark client not ready");
			await client.sendMessage({
				receive_id_type: chatId.startsWith("oc_") ? "chat_id" : "open_id",
				params: {
					receive_id: chatId,
					msg_type: type,
					content: JSON.stringify(type === "image" ? { image_key: fileKey } : { file_key: fileKey })
				}
			});
		},
		async listMessages({ chatId, startTimeMs, endTimeMs }) {
			const client = getLarkClient();
			if (!client?.listMessages) return [];
			return ((await client.listMessages({
				container_id_type: "chat",
				container_id: chatId,
				start_time: String(startTimeMs),
				end_time: String(endTimeMs)
			})).items ?? []).map((i) => ({
				messageId: i.message_id ?? "",
				timestampMs: Number(i.create_time ?? 0)
			}));
		}
	};
	const bridge = createBridgeContext({
		logger,
		cfg: getCfg,
		configStore,
		status,
		backend,
		router: routeStore,
		sender,
		attachments: ctx.get?.("attachments")
	});
	const outbox = createOutbox({
		dir: join(dir, "outbox"),
		sender: { async deliver(env, payload) {
			const chatId = env.route.chatId;
			try {
				if (payload.kind === "text") {
					if (payload.card !== void 0) await sender.sendCard(chatId, payload.card);
					else await sender.sendText(chatId, payload.text);
				} else if (payload.kind === "card") await sender.sendCard(chatId, payload.card);
				else if (payload.kind === "media") await sender.sendFile(chatId, payload.fileKey, payload.type);
				else if (payload.kind === "reaction") await sender.addReaction(payload.messageId, payload.emojiType);
				return { ok: true };
			} catch (err) {
				return {
					ok: false,
					retryable: true,
					error: err instanceof Error ? err.message : String(err)
				};
			}
		} },
		cfg: getCfg().outbox,
		onStatsChange: (stats) => {
			try {
				status.refreshCounters({
					outboxPending: stats.pending,
					outboxFailed: stats.failed
				});
			} catch {}
		}
	});
	const forwarder = createEventForwarder({
		outbox,
		routeFor: (key) => routeStore.get(key),
		streamFor: (sessionKey) => {
			const route = routeStore.get(sessionKey);
			if (!route) return void 0;
			return {
				route: {
					sessionKey: route.sessionKey,
					chatId: route.chatId,
					chatType: route.chatType,
					threadMessageId: route.threadMessageId
				},
				ensureStream: () => void 0,
				fallbackText: async (text) => {
					await outbox.enqueue({
						dedupeKey: `${sessionKey}:fallback:${Date.now()}`,
						laneKey: sessionKey,
						route: {
							sessionKey: route.sessionKey,
							chatId: route.chatId,
							chatType: route.chatType
						},
						kind: "assistant-output",
						payload: {
							kind: "text",
							text
						}
					});
				},
				markDone: () => bridge.markDone(sessionKey, route.lastMessageId)
			};
		},
		cfg: () => ({ streamingEnabled: getCfg().streaming.enabled }),
		onDelivered: (sessionKey) => {
			try {
				const route = routeStore.get(sessionKey);
				if (route?.lastMessageId) inboundWal.delivered(route.lastMessageId);
			} catch {}
		}
	});
	const groupTrigger = createGroupTrigger({
		cfg: () => ({
			policy: getCfg().groupPolicy,
			keywords: getCfg().groupKeywords,
			alsoOnReply: getCfg().alsoOnReply
		}),
		botOpenId: () => bridge.botOpenId()
	});
	const diagnostics = createDiagnosticsService({
		ctx: bridge,
		secrets: []
	});
	const pendingQuestions = /* @__PURE__ */ new Map();
	/** dsh-lark-link-plus: approval id -> pending Feishu decision. */
	const pendingApprovals = /* @__PURE__ */ new Map();
	/**
	 * dsh-lark-link-plus: ask the phone to authorize one operation. Resolves
	 * 'allow' / 'reject' on a card tap, or undefined when the request could not
	 * be presented (no route, send failure, timeout, abort) so the caller can
	 * delegate to whatever other answerer the deployment composed.
	 */
	/**
	 * dsh-lark-link-plus: resolve the Feishu chat a pending approval belongs to.
	 * A restart empties the in-memory session->key map until the next inbound
	 * message, so the bound shared session falls back to its persisted DM route;
	 * anything else delegates rather than guessing a chat.
	 */
	function approvalChatIdFor(req) {
		const agentId = req?.agent?.id ?? req?.agent?.session?.header?.id ?? "";
		const key = agentId ? backend?.keyForSessionId?.(agentId) : void 0;
		const direct = key ? routeStore.get(key)?.chatId : void 0;
		if (direct) return direct;
		const shared = getCfg().sharedSessionId;
		if (!shared || String(agentId) !== String(shared)) return void 0;
		const dms = routeStore.all()
			.filter((r) => typeof r?.sessionKey === "string" && r.sessionKey.startsWith("dm:"))
			.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
		return dms[0]?.chatId;
	}
	/**
	 * dsh-lark-link-plus: answerable approval frames the Host proxy pushed to the
	 * browser, keyed by approval id. A phone answer is delivered back through the
	 * proxy's own `respond` channel so its `approval/resolved` broadcast dismisses
	 * the desktop prompt instead of leaving it open.
	 */
	const approvalFrames = /* @__PURE__ */ new Map();
	const apiProxy = ctx.get?.("apiProxy");
	if (apiProxy?.events?.mux) {
		const muxAbort = new AbortController();
		const consume = async () => {
			try {
				for await (const frame of apiProxy.events.mux({ rpcId: randomUUID(), payload: {} }, muxAbort.signal)) {
					const payload = frame?.payload;
					if (payload?.type === "approval/requested") {
						approvalFrames.set(String(payload.approvalId), {
							rpcId: frame.rpcId,
							sessionId: payload.sessionId,
							approvalId: payload.approvalId,
							callId: payload.callId,
							at: Date.now(),
							claimed: false
						});
						if (approvalFrames.size > 64) {
							const oldest = [...approvalFrames.entries()].sort((a, b) => a[1].at - b[1].at)[0];
							if (oldest) approvalFrames.delete(oldest[0]);
						}
					} else if (payload?.type === "approval/resolved") {
						approvalFrames.delete(String(payload.approvalId));
					}
				}
			} catch (err) {
				if (!muxAbort.signal.aborted) logger.warn(`approval mux subscription ended: ${err instanceof Error ? err.message : String(err)}`);
			}
		};
		consume();
		ctx.effect(() => () => muxAbort.abort(), "lark-link: approval mux subscription");
	}
	/**
	 * dsh-lark-link-plus: claim the mux frame matching this request so a phone
	 * answer can travel the desktop channel. Best-effort: an unclaimed request
	 * simply answers the waterfall directly.
	 */
	async function claimApprovalFrame(req) {
		const sessionId = String(req?.agent?.session?.id ?? req?.agent?.id ?? "");
		for (let attempt = 0; attempt < 20; attempt += 1) {
			for (const frame of approvalFrames.values()) {
				if (frame.claimed) continue;
				if (String(frame.sessionId) !== sessionId) continue;
				if ((frame.callId ?? null) !== (req?.callId ?? null)) continue;
				frame.claimed = true;
				return frame;
			}
			await new Promise((resolve) => {
				const t = setTimeout(resolve, 100);
				t.unref?.();
			});
		}
		return void 0;
	}
	/**
	 * dsh-lark-link-plus: present one approval on the phone. Returns the pending
	 * handle rather than the decision, so the caller can settle the card when the
	 * desktop answers first and keep a late tap from claiming it decided.
	 */
	function requestFeishuApproval(req, chatId) {
		const id = `apv-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
		let resolveDecision;
		const promise = new Promise((resolve) => {
			resolveDecision = resolve;
		});
		const settle = (value) => {
			const pending = pendingApprovals.get(id);
			if (!pending || pending.settled) return;
			clearTimeout(pending.timer);
			pending.settled = true;
			resolveDecision(value);
		};
		/**
		 * Withdraw the mirrored desktop prompt through the proxy's own resolution
		 * channel: settling its pending entry is what broadcasts `approval/resolved`.
		 * Deliberately fire-and-forget — the phone's decision below must never wait
		 * on this channel, or a stalled response would hold the whole request open.
		 */
		const dismissDesktop = (allow) => {
			const frame = pendingApprovals.get(id)?.frame;
			if (!frame || !apiProxy?.respond) return;
			apiProxy.respond({
				type: "client-response",
				rpcId: frame.rpcId,
				result: {
					ok: true,
					value: {
						sessionId: frame.sessionId,
						approvalId: frame.approvalId,
						outcome: allow ? "allowed-once" : "rejected"
					}
				}
			}).then((receipt) => {
				if (!receipt?.accepted) logger.warn(`approval dismiss rejected by proxy: ${receipt?.reason ?? "unknown"}`);
			}).catch((err) => {
				logger.warn(`approval dismiss failed: ${err instanceof Error ? err.message : String(err)}`);
			});
		};
		const timer = setTimeout(() => settle(void 0), 3e5);
		timer.unref?.();
		pendingApprovals.set(id, { resolve: settle, chatId, timer, settled: false, frame: void 0 });
		req.signal?.addEventListener?.("abort", () => settle(void 0), { once: true });
		sender.sendCard(chatId, approvalCard(req, id)).catch((err) => {
			logger.warn(`approval card send failed: ${err instanceof Error ? err.message : String(err)}`);
			settle(void 0);
		});
		return {
			promise,
			close: () => settle(void 0),
			link(frame) {
				const pending = pendingApprovals.get(id);
				if (pending) pending.frame = frame;
			},
			dismissDesktop
		};
	}
	// dsh-lark-link-plus: ask BOTH surfaces at once. The phone card and the rest
	// of the chain (the desktop GUI prompt) are raised together and the first
	// decisive answer wins. A chain answer of 'unavailable' means nobody else
	// will answer, so the phone keeps the request open instead of inheriting it.
	ctx.on("approval/request", async (req, next) => {
		let chatId;
		try {
			if (getCfg().feishuApprovals) chatId = approvalChatIdFor(req);
		} catch (err) {
			logger.warn(`feishu approval route lookup failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		if (!chatId) return await next();
		const feishu = requestFeishuApproval(req, chatId);
		const desktop = next();
		desktop.then((outcome) => {
			if (outcome && outcome !== "unavailable") feishu.close();
		}).catch(() => void 0);
		// Claim the pushed frame so a phone tap can answer through the proxy and
		// thereby close the desktop prompt; if none appears the tap answers directly.
		claimApprovalFrame(req).then((frame) => {
			if (frame) feishu.link(frame);
		}).catch(() => void 0);
		let picked;
		try {
			picked = await feishu.promise;
		} catch (err) {
			logger.warn(`feishu approval failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		if (picked === "allow") return "allowed-once";
		if (picked === "reject") return "rejected";
		return await desktop.catch(() => "unavailable");
	});
	async function askUserQuestion(questions, agentId) {
		const answers = [];
		const key = backend?.keyForSessionId?.(agentId);
		const chatId = (key ? routeStore.get(key) : void 0)?.chatId;
		if (!chatId) {
			logger.warn(`ask_user_question: no Feishu route for ${agentId}`);
			return { answers: questions.map((q) => ({
				id: q.id,
				selected: ["(无会话，未回答)"]
			})) };
		}
		for (const q of questions) {
			const answer = await new Promise((resolve) => {
				const timer = setTimeout(() => {
					pendingQuestions.delete(q.id);
					resolve({
						id: q.id,
						selected: ["(超时未回答)"]
					});
				}, 6e5);
				timer.unref?.();
				pendingQuestions.set(q.id, {
					resolve,
					chatId,
					questionId: q.id,
					timer,
					options: q.options ?? []
				});
				sender.sendCard(chatId, questionCard(q)).catch((err) => {
					clearTimeout(timer);
					pendingQuestions.delete(q.id);
					resolve({
						id: q.id,
						selected: [`(卡片发送失败: ${err instanceof Error ? err.message : String(err)})`]
					});
				});
			});
			answers.push(answer);
		}
		return { answers };
	}
	const dshCommands = {
		has: (name, agentId) => {
			try {
				const services = ctx;
				const agent = agentId ? services.agents?.get?.(agentId) : void 0;
				if (!agent) return false;
				return Boolean(services.commands?.find?.(agent, name));
			} catch {
				return false;
			}
		},
		async run(name, rawInput, agentId) {
			try {
				const services = ctx;
				const commands = services.commands;
				const agent = services.agents?.get?.(agentId);
				if (!commands?.execute || !agent) return {
					kind: "error",
					text: "commands service unavailable"
				};
				const line = rawInput.trim() ? `/${name} ${rawInput.trim()}` : `/${name}`;
				const out = await commands.execute(agent, line, new AbortController().signal);
				if (!out?.result) return {
					kind: "error",
					text: `未知命令 /${name}`
				};
				return {
					kind: out.result.kind,
					text: out.result.text
				};
			} catch (err) {
				return {
					kind: "error",
					text: err instanceof Error ? err.message : String(err)
				};
			}
		}
	};
	const durableReply = async (cmdName, msg, textOrCard) => {
		const key = bridge.conversationKeyFor(msg);
		await outbox.enqueue({
			dedupeKey: `bridge:${cmdName}:${msg.messageId}`,
			laneKey: key,
			route: {
				sessionKey: key,
				chatId: msg.chatId,
				chatType: msg.chatType
			},
			kind: "command-reply",
			payload: typeof textOrCard === "string" ? {
				kind: "text",
				text: textOrCard
			} : {
				kind: "card",
				card: textOrCard
			}
		});
	};
	const bridgeHandler = async (name, _rawInput, msg) => {
		switch (name) {
			case "status":
				await durableReply(name, msg, formatStatusLine(status.get()) + "\n\n" + statusDetailLines(status.get()).join("\n"));
				return true;
			case "feishu-config":
			case "lark-config": {
				const arg = _rawInput.trim();
				if (!arg) {
					await durableReply(name, msg, formatStatusLine(status.get()) + "\n\n" + statusDetailLines(status.get()).join("\n"));
					return true;
				}
				const eq = arg.indexOf("=");
				if (eq === -1) {
					await durableReply(name, msg, "用法：/lark-config key=value（可热改: " + HOT_RELOADABLE.join(", ") + "）");
					return true;
				}
				const key = arg.slice(0, eq).trim();
				const rawVal = arg.slice(eq + 1).trim();
				if (!HOT_RELOADABLE.includes(key)) {
					await durableReply(name, msg, `"${key}" 不可热改（可改: ${HOT_RELOADABLE.join(", ")}）`);
					return true;
				}
				let val = rawVal;
				if (rawVal === "true" || rawVal === "false") val = rawVal === "true";
				else if (rawVal !== "" && !Number.isNaN(Number(rawVal))) val = Number(rawVal);
				try {
					configStore.update({ [key]: val });
					configStore.saveOverrides();
				} catch (err) {
					await durableReply(name, msg, `更新失败: ${err instanceof Error ? err.message : String(err)}`);
					return true;
				}
				await durableReply(name, msg, `已更新 ${key}=${JSON.stringify(val)}`);
				return true;
			}
			case "support":
			case "doctor": {
				const diag = await diagnostics.build();
				const client = getLarkClient();
				if (client?.uploadFile) try {
					const key = bridge.conversationKeyFor(msg);
					const sessionId = bridge.backend?.get(key)?.sessionId ?? findLatestLarkSessionId();
					const zipBuf = sessionId ? await buildSessionExportZip(sessionId, diag.text, diag.issueMd) : void 0;
					if (zipBuf) {
						const fileName = `lark-link-doctor-${Date.now()}.zip`;
						const uploadKey = extractUploadKey(await client.uploadFile({
							file_type: "file",
							file_name: fileName,
							file: zipBuf
						}), "file_key");
						if (uploadKey) {
							await sender.sendFile(msg.chatId, uploadKey, "file");
							return true;
						}
					}
					const fileName = `lark-link-doctor-${Date.now()}.md`;
					const buf = Buffer.from(`# dsh-lark-link 诊断包\n\n${diag.text}\n\n${diag.issueMd}\n`, "utf8");
					const uploadKey = extractUploadKey(await client.uploadFile({
						file_type: "file",
						file_name: fileName,
						file: buf
					}), "file_key");
					if (uploadKey) {
						await sender.sendFile(msg.chatId, uploadKey, "file");
						return true;
					}
				} catch (err) {
					logger.warn(`doctor file send failed: ${err instanceof Error ? err.message : String(err)}`);
				}
				await durableReply(name, msg, diag.text);
				return true;
			}
			case "sessions": {
				// dsh-lark-link-plus: 列出电脑 GUI 侧边栏同源的历史会话（持久化会话，
				// 含标题/时间/工作目录），排除子代理会话；而不是只看飞书桥的活跃 key。
				const services = ctx;
				const persistence = services.get?.("sessionPersistence");
				const sessionQuery = services.get?.("sessionQuery");
				if (!persistence) {
					await durableReply(name, msg, "会话持久化服务不可用（未加载 dsh-session-persistence）");
					return true;
				}
				let headers = [];
				try {
					headers = await persistence.list();
				} catch (err) {
					await durableReply(name, msg, `列出会话失败: ${err instanceof Error ? err.message : String(err)}`);
					return true;
				}
				const rows = headers
					.filter((h) => h.origin !== "subagent" && !h.parentSession)
					.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
				const limit = 30;
				const shown = rows.slice(0, limit);
				const lines = [];
				for (const h of shown) {
					let title = "";
					if (sessionQuery?.readTitle) {
						try {
							// readTitle resolves a SessionTitleSnapshot; the text lives on `.title`.
							const snap = await sessionQuery.readTitle(h.id);
							title = snap?.title ?? "";
						} catch {}
					}
					const when = formatLocalTime(h.createdAt);
					const cwdName = h.cwd ? basename(h.cwd) : "";
					const mark = h.id === getCfg().sharedSessionId ? "✅ " : "";
					const head = title ? `${mark}📝 ${title}` : `${mark}💬 ${h.id}`;
					lines.push(`• ${head}\n   id: \`${h.id}\`\n   时间: ${when}${cwdName ? ` | 目录: ${cwdName}` : ""}`);
				}
				if (lines.length === 0) {
					await durableReply(name, msg, "还没有历史会话。在电脑 GUI 里开过对话后，这里能看到并续聊。");
					return true;
				}
				const more = rows.length > limit ? `\n（仅显示前 ${limit} 条，共 ${rows.length} 条）` : "";
				const boundId = getCfg().sharedSessionId;
				const bindLine = boundId
					? `\n\n当前已绑定共享会话：✅ \`${boundId}\`（飞书与电脑同一个对话）。解除用 /unbind。`
					: `\n\n当前未绑定共享会话（每个飞书会话各自独立）。发 \`/open <id>\` 可绑定成「飞书与电脑同一个对话」。`;
				await durableReply(name, msg, `**历史会话 (${rows.length})** — 回复 \`/open <id>\` 绑定/续聊\n\n` + lines.join("\n") + `\n${more}` + bindLine);
				return true;
			}
			case "open": {
				// dsh-lark-link-plus: 恢复一个「已存在的持久化 DSH 会话」，并让当前飞书聊天切入它续聊。
				const arg = (_rawInput ?? "").trim();
				if (!arg) {
					await durableReply(name, msg, "用法：/open <sessionId> —— 用 /sessions 查看可选会话 id");
					return true;
				}
				const services = ctx;
				const persistence = services.get?.("sessionPersistence");
				if (!persistence) {
					await durableReply(name, msg, "会话持久化服务不可用（未加载 dsh-session-persistence）");
					return true;
				}
				let meta;
				try {
					meta = (await persistence.list()).find((h) => h.id === arg);
				} catch {
					meta = void 0;
				}
				if (!meta || meta.origin === "subagent" || meta.parentSession) {
					await durableReply(name, msg, `未找到可续聊的会话 \`${arg}\`（子代理会话不可打开）。用 /sessions 查看列表。`);
					return true;
				}
				const key = bridge.conversationKeyFor(msg);
				try {
					const adopted = await bridge.backend?.adoptSession(key, meta.id, { preset: meta.agentPreset ?? "code" });
					if (!adopted) {
						await durableReply(name, msg, "桥后端未初始化，无法恢复会话。");
						return true;
					}
				} catch (err) {
					await durableReply(name, msg, `恢复会话失败: ${err instanceof Error ? err.message : String(err)}`);
					return true;
				}
				configStore.update({ sharedSessionId: meta.id });
				configStore.saveOverrides();
				const when = formatLocalTime(meta.createdAt);
				await durableReply(name, msg, `已绑定共享会话 \`${meta.id}\`（创建于 ${when}）。\n\n从现在起，飞书里发的每条消息都会进入这个会话——和电脑上打开的是同一个对话，两边的消息与回复都能看到。\n\n绑定已持久化，重启 DSH 后依然有效。想解除用 /unbind。`);
				return true;
			}
			case "unbind": {
				const bound = getCfg().sharedSessionId;
				if (!bound) {
					await durableReply(name, msg, "当前没有绑定共享会话（每个飞书会话各自独立）。用 /sessions 查看可选会话，再 /open <id> 绑定。");
					return true;
				}
				configStore.update({ sharedSessionId: "" });
				configStore.saveOverrides();
				await conversations?.rotate(bridge.conversationKeyFor(msg));
				await durableReply(name, msg, `已解除对 \`${bound}\` 的绑定。之后飞书消息回到各自的独立会话；要重新绑定用 /open <id>。`);
				return true;
			}
			case "help":
				await durableReply(name, msg, helpCard());
				return true;
			case "workspace": {
				const arg = _rawInput.trim();
				if (!arg) {
					await durableReply(name, msg, `工作区: ${getCfg().workspaceRoot || process.cwd()}`);
					return true;
				}
				const expanded = arg === "~" || arg.startsWith("~/") ? join(homedir(), arg.slice(arg.startsWith("~/") ? 2 : 1)) : arg;
				const target = resolve(expanded.startsWith("/") ? expanded : join(getCfg().workspaceRoot || process.cwd(), expanded));
				if (!target.startsWith("/")) {
					await durableReply(name, msg, `无效路径: ${arg}`);
					return true;
				}
				try {
					if (!statSync(target).isDirectory()) {
						await durableReply(name, msg, `不是有效目录: ${target}`);
						return true;
					}
				} catch {
					await durableReply(name, msg, `目录不存在: ${target}`);
					return true;
				}
				configStore.update({ workspaceRoot: target });
				configStore.saveOverrides();
				await conversations?.rotate(bridge.conversationKeyFor(msg));
				await durableReply(name, msg, `工作区已切换: ${target}\n当前会话已重置，下一条消息在新工作区生效（其他会话不受影响）。`);
				return true;
			}
			case "stop": {
				const key = bridge.conversationKeyFor(msg);
				await bridge.conversations?.stop(key);
				await durableReply(name, msg, "已停止当前会话任务");
				return true;
			}
			case "new": {
				const bound = getCfg().sharedSessionId;
				if (bound) {
					await durableReply(name, msg, `当前已绑定共享会话 \`${bound}\`，/new 不会生效（消息仍进该会话）。\n\n想真正开新会话：先 /unbind 解除绑定，再发 /new。`);
					return true;
				}
				const key = bridge.conversationKeyFor(msg);
				await conversations?.rotate(key);
				await durableReply(name, msg, `已开启新会话（工作区: ${getCfg().workspaceRoot || process.cwd()}）。下一条消息开始全新上下文。`);
				return true;
			}
			case "model": {
				const arg = _rawInput.trim();
				const services = ctx;
				const adm = services.get?.("agentDefaultModel");
				const llm = services.get?.("llm");
				const current = adm?.currentSelection?.();
				if (!arg) {
					const groups = [];
					const providers = llm?.listProviders?.() ?? [];
					for (const p of providers) {
						let models = [];
						try {
							models = await llm?.listModels?.(p.id ?? "") ?? [];
						} catch {}
						if (models.length > 0) groups.push({
							provider: p.id ?? "",
							label: p.name ?? p.id,
							models
						});
					}
					await sender.sendCard(msg.chatId, modelCard(current, groups));
					return true;
				}
				let provider = current?.provider ?? "";
				let model = arg;
				if (arg.includes("/")) {
					const [p, m] = arg.split("/");
					if (p) provider = p.trim();
					model = (m ?? "").trim();
				}
				if (!provider || !model) {
					await durableReply(name, msg, "用法：/model <provider>/<model> 或 /model <model>");
					return true;
				}
				if (!adm?.saveSelection) {
					await durableReply(name, msg, "模型切换服务不可用");
					return true;
				}
				try {
					await adm.saveSelection({
						provider,
						model
					});
				} catch (err) {
					await durableReply(name, msg, `模型切换失败: ${err instanceof Error ? err.message : String(err)}`);
					return true;
				}
				liveModelSelection.provider = provider;
				liveModelSelection.model = model;
				await durableReply(name, msg, `模型已切换: ${provider}/${model}\n当前会话下次回复生效（会话不中断）。`);
				return true;
			}
			case "mode": {
				const live = backend ? await backend.listPresets() : [];
				const roster = live.length > 0 ? live : [...AGENT_PRESETS];
				const arg = _rawInput.trim().toLowerCase();
				if (!arg) {
					await sender.sendCard(msg.chatId, withButtons(modeCard(getCfg().agentPreset, roster), roster.filter((p) => !p.broken).map((p) => button(p.label, { op: `mode:${p.id}` }))));
					return true;
				}
				if (!roster.some((p) => p.id === arg)) {
					await durableReply(name, msg, `未知模式 ${arg}（可用: ${roster.map((p) => p.id).join(", ")}）`);
					return true;
				}
				configStore.update({ agentPreset: arg });
				configStore.saveOverrides();
				await conversations?.rotate(bridge.conversationKeyFor(msg));
				const picked = roster.find((p) => p.id === arg);
				await durableReply(name, msg, `模式已切换为 ${picked?.label ?? arg}${picked?.trust === "user" ? "（自定义）" : ""}（当前会话已重置，下条消息生效；其他会话不受影响）`);
				return true;
			}
			case "permission": {
				const arg = _rawInput.trim().toLowerCase();
				if (!arg) {
					await sender.sendCard(msg.chatId, withButtons(permissionCard(getCfg().permissionMode), PERMISSION_PRESETS.map((p) => button(p.label, { op: `permission:${p.id}` }))));
					return true;
				}
				if (!PERMISSION_PRESETS.some((p) => p.id === arg)) {
					await durableReply(name, msg, `未知权限 ${arg}（可用: ${PERMISSION_PRESETS.map((p) => p.id).join(", ")}）`);
					return true;
				}
				try {
					const services = ctx;
					const sessionId = bridge.backend?.get(bridge.conversationKeyFor(msg))?.sessionId;
					const agent = sessionId ? (services.get?.("agents"))?.get?.(sessionId) : void 0;
					const permission = services.get?.("permissionPresets");
					if (agent?.session && permission?.apply) permission.apply(agent.session, arg, (policy) => {
						(services.get?.("approval"))?.setPolicy?.(agent, policy);
					});
				} catch (err) {
					logger.warn(`permission switch failed: ${err instanceof Error ? err.message : String(err)}`);
				}
				configStore.update({ permissionMode: arg });
				configStore.saveOverrides();
				syncDefaultPermission();
				const approvalNote = arg === "danger-full-access"
					? "\n\n注意：Full access 的审批策略是 never，不会产生授权请求。想在这里收到授权卡片，请切到「只读」或「工作区写」。"
					: "\n\n已开启审批：需要授权的操作会以卡片发到这里，点按钮即可允许/拒绝。";
				await durableReply(name, msg, `权限已切换为 ${arg}${approvalNote}`);
				return true;
			}
			case "lark": {
				const sub = _rawInput.trim().split(/\s+/)[0] ?? "";
				await durableReply(name, msg, await runLarkSubcommand(sub.toLowerCase()));
				return true;
			}
			default: return false;
		}
	};
	const commandRouter = createCommandRouter({
		ctx: bridge,
		commands: dshCommands,
		bridgeHandler
	});
	const handleCardAction = async (data) => {
		try {
			const raw = data;
			const value = raw.action?.value ?? {};
			const op = typeof value.op === "string" ? value.op : "";
			logger.info(`card action data: ${JSON.stringify(raw).slice(0, 600)}`);
			const chatId = raw.context?.open_chat_id ?? raw.operator?.operator_id?.open_id ?? raw.open_id ?? "";
			const messageId = raw.message?.message_id ?? "";
			if (!op) return;
			if (op.startsWith("uqam:")) {
				const questionId = op.slice(5);
				const pending = pendingQuestions.get(questionId);
				if (pending) {
					clearTimeout(pending.timer);
					pendingQuestions.delete(questionId);
					const answer = (raw.action?.formValue)?.answer;
					const selected = (Array.isArray(answer) ? answer.map((v) => String(v)) : typeof answer === "string" && answer ? [answer] : []).map((v) => {
						const i = Number(v);
						return Number.isInteger(i) && pending.options[i] ? pending.options[i].label : v;
					});
					sender.sendText(pending.chatId, `已收到你的选择 ✅（${selected.join("、")}）`).catch(() => void 0);
					pending.resolve({
						id: questionId,
						selected
					});
				}
				return;
			}
			if (op.startsWith("uqa:")) {
				const parts = op.split(":");
				const questionId = parts[1] ?? "";
				const optionIndex = Number(parts[2] ?? NaN);
				const pending = pendingQuestions.get(questionId);
				if (pending) {
					clearTimeout(pending.timer);
					pendingQuestions.delete(questionId);
					const label = pending.options[optionIndex]?.label ?? String(optionIndex);
					sender.sendText(pending.chatId, `已收到你的选择 ✅（${label}）`).catch(() => void 0);
					pending.resolve({
						id: questionId,
						selected: [label]
					});
				}
				return;
			}
			if (op.startsWith("apv:")) {
				// dsh-lark-link-plus: one tap settles the pending approval request.
				const parts = op.split(":");
				const approvalId = parts[1] ?? "";
				const allow = (parts[2] ?? "") === "allow";
				const pending = pendingApprovals.get(approvalId);
				if (pending) {
					const late = pending.settled;
					sender.sendText(pending.chatId, late ? "这条授权已经处理过了 ✅" : allow ? "已允许这一次 ✅" : "已拒绝 ⛔").catch(() => void 0);
					if (late) {
						pendingApprovals.delete(approvalId);
						return;
					}
					// The tap decides immediately — never behind the dismissal channel —
					// then the mirrored desktop prompt is withdrawn as a separate step.
					pending.resolve(allow ? "allow" : "reject");
					pending.dismissDesktop?.(allow);
					pendingApprovals.delete(approvalId);
				}
				return;
			}
			const sep = op.indexOf(":");
			const cmd = sep === -1 ? op : op.slice(0, sep);
			const arg = sep === -1 ? "" : op.slice(sep + 1);
			await bridgeHandler(cmd, arg, {
				messageId,
				chatId,
				chatType: "p2p",
				chatMode: "p2p",
				senderOpenId: chatId,
				msgType: "interactive",
				content: "",
				text: "",
				mentions: [],
				timestamp: Date.now()
			});
		} catch (err) {
			logger.error(`card action failed: ${String(err)}`);
		}
	};
	const messageHandler = createMessageHandler({
		ctx: bridge,
		commands: commandRouter,
		groupTrigger,
		dedupe,
		allowlist: () => getCfg().allowlist,
		wal: inboundWal,
		inboundDir: join(dir, "inbound")
	});
	const turnDelivered = /* @__PURE__ */ new Set();
	const conversations = createConversationManager({
		backend,
		maxSessions: getCfg().maxSessions,
		idleTtlMs: getCfg().sessionIdleTtlMs,
		logger,
		onEvent: (key, event) => {
			forwarder.onSessionEvent(key, event).catch((e) => logger.warn(`forwarder: ${String(e)}`));
			if (event.type === "turn/start") {
				turnDelivered.delete(key);
				turnSupervisor.arm(key);
			}
			if (event.type === "assistant/message") {
				turnSupervisor.disarm(key);
				if ((event.text ?? "").trim() !== "") turnDelivered.add(key);
			}
			if (event.type === "turn/end") {
				turnSupervisor.disarm(key);
				const reason = event.reason;
				const silent = !turnDelivered.has(key) && (reason === "aborted" || reason === "rejected" || reason === "failed" || reason === "error");
				turnDelivered.delete(key);
				if (silent) {
					logger.warn(`turn ended '${reason}' with no output for ${key}; recovering agent`);
					conversations.dispose(key).then(() => {
						const chatId = routeStore.get(key)?.chatId;
						if (chatId) return sender.sendText(chatId, `⚠️ 本轮没有产出回复（turn ended: ${reason}，无输出）。已重置会话，请再发一条消息重试。若仍无回复，请检查 /model 是否指向可用的模型。`).catch(() => void 0);
					}).catch((e) => logger.warn(`recover agent for ${key} failed: ${String(e)}`));
				}
			}
		}
	});
	const turnSupervisor = createTurnSupervisor({
		backend,
		timeoutMs: 6e5,
		logger
	});
	const compensation = createMissedCompensation({
		routes: routeStore,
		listMessages: (p) => sender.listMessages(p),
		reinject: (msg) => messageHandler.handleCompensated(msg),
		logger
	});
	let lifecycleStarted = false;
	let supervisor;
	const startBridge = async () => {
		if (lifecycleStarted) return;
		const ref = getCfg().credentialRef;
		const creds = await resolveCredentials(credStore, ref);
		if (!creds) {
			startBlocker = `未配置飞书凭据（ref=${ref}）。请先运行 /lark setup 扫码，或设置 DSH_LARK_APP_ID/DSH_LARK_APP_SECRET 后再 /lark setup。`;
			logger.warn(startBlocker);
			return;
		}
		startBlocker = void 0;
		logger.info("starting bridge…");
		try {
			larkClient = await buildLarkClient({
				appId: creds.appId,
				appSecret: creds.appSecret,
				domain: creds.domain,
				logger
			});
		} catch (err) {
			startBlocker = `lark client 构建失败: ${err instanceof Error ? err.message : String(err)}`;
			logger.error(startBlocker);
			return;
		}
		bridge.setConversations(conversations);
		bridge.setOutbox(outbox);
		bridge.setForwarder(forwarder);
		bridge.setCompensation(compensation);
		outbox.rebuildFromDisk();
		outbox.start();
		turnSupervisor.start();
		const transport = createTransport({
			getClient: () => larkClient ?? {},
			onMessage: async (msg) => {
				const pendingForChat = [...pendingQuestions.values()].find((p) => p.chatId === msg.chatId);
				if (pendingForChat && (msg.text ?? "").trim() !== "") {
					clearTimeout(pendingForChat.timer);
					pendingQuestions.delete(pendingForChat.questionId);
					const text = (msg.text ?? "").trim();
					pendingForChat.resolve({
						id: pendingForChat.questionId,
						selected: [],
						custom: text
					});
					return;
				}
				await messageHandler.handleInbound(msg);
			},
			onEvent: (event, data) => {
				if (event === "card.action.trigger") handleCardAction(data);
			},
			logger
		});
		bridge.setTransport(transport);
		supervisor = createConnectionSupervisor({
			transport,
			quota: createQuotaGovernor(join(dir, "conn-history.jsonl"), {
				windowMinutes: getCfg().quota.windowMinutes,
				limit: getCfg().quota.limit
			}),
			status,
			cfg: {
				probeIntervalMs: getCfg().supervisor.probeIntervalMs,
				probeTimeoutMs: getCfg().supervisor.probeTimeoutMs,
				probeFailThreshold: getCfg().supervisor.probeFailThreshold,
				maxReconnectAttempts: getCfg().supervisor.maxReconnectAttempts,
				idleKeepaliveMs: getCfg().supervisor.idleKeepaliveMs,
				quotaWindowMinutes: getCfg().quota.windowMinutes,
				quotaLimit: getCfg().quota.limit
			},
			logger,
			onStateChange: (state, detail) => {
				if (state === "connected") bridge.setBotOpenId(transport.botOpenId());
				logger.info(`conn state: ${state}${detail ? ` (${detail})` : ""}`);
			}
		});
		await supervisor.start();
		bridge.setBotOpenId(transport.botOpenId());
		status.refreshCounters({
			outboxPending: outbox.pendingCount(),
			outboxFailed: outbox.failedCount(),
			inboundPending: inboundWal.pendingReplays().length
		});
		status.setConn("connected", { wsReady: transport.wsReady() });
		bridge.setStarted(true);
		lifecycleStarted = true;
		(async () => {
			let replayed = 0;
			try {
				inboundWal.prune();
				for (const rec of inboundWal.pendingReplays()) {
					if (!inboundWal.markReplay(rec.messageId)) continue;
					try {
						await messageHandler.handleCompensated({
							messageId: rec.messageId,
							chatId: rec.chatId,
							chatType: rec.chatType,
							chatMode: rec.chatType === "p2p" ? "p2p" : "group_all",
							senderOpenId: rec.senderOpenId,
							msgType: "text",
							content: rec.text,
							text: rec.text,
							mentions: [],
							timestamp: rec.acceptedAt
						});
						replayed++;
					} catch (err) {
						logger.warn(`inbound replay failed for ${rec.messageId}: ${err instanceof Error ? err.message : String(err)}`);
					}
				}
				if (replayed > 0) logger.info(`inbound replay re-dispatched ${replayed} request(s)`);
				status.refreshCounters({ inboundPending: inboundWal.pendingReplays().length });
			} catch (err) {
				logger.warn(`inbound replay errored: ${err instanceof Error ? err.message : String(err)}`);
			}
		})();
		logger.info("bridge started (in-process) [HMR-RELOAD-MARKER-2]");
	};
	const stopBridge = async () => {
		if (!lifecycleStarted) return;
		logger.info("stopping bridge…");
		turnSupervisor.stop();
		await supervisor?.stop();
		supervisor = void 0;
		await outbox.stop();
		await conversations.disposeAll();
		bridge.setStarted(false);
		status.setConn("stopped");
		lifecycleStarted = false;
		logger.info("bridge stopped");
	};
	ctx.tools.register(defineTool({
		name: "lark_send_local_file",
		description: "Send a local file or image to the current Feishu chat.",
		parameters: {
			path: {
				type: "string",
				required: true,
				description: "Absolute local path"
			},
			kind: {
				type: "string",
				required: true,
				description: "image（png/jpeg/webp/gif，其他格式如 svg 自动按 file 发送）| file"
			},
			caption: {
				type: "string",
				description: "Optional caption text"
			}
		},
		output: {
			schema: { type: "string" },
			render: (_args, value) => [{
				type: "text",
				text: value
			}]
		},
		async execute(args, exec) {
			const workspaceRoot = getCfg().workspaceRoot || process.cwd();
			const abs = resolve(args.path.startsWith("/") ? args.path : join(workspaceRoot, args.path));
			if (!abs.startsWith(workspaceRoot)) return "拒绝: 路径不在工作区内";
			const sessionId = exec.agent?.id ?? "";
			const key = bridge.backend?.keyForSessionId?.(sessionId) ?? (sessionId.startsWith("lark-link:") ? sessionId.slice(10).replace(/:[a-z0-9]{8,}$/, "") : sessionId);
			const route = routeStore.get(key);
			if (!route) return "错误: 无法定位当前飞书会话";
			const client = getLarkClient();
			if (!client) return "错误: lark 客户端未就绪";
			const isImage = args.kind === "image" && /\.(png|jpe?g|webp|gif)$/i.test(args.path);
			if (isImage ? !client.uploadImage : !client.uploadFile) return "错误: lark 客户端未就绪";
			let buf;
			try {
				if (statSync(abs).size > 26214400) return "错误: 文件超过 25MB 上限";
				buf = readFileSync(abs);
			} catch (err) {
				return `错误: 读取文件失败 (${err instanceof Error ? err.message : String(err)})`;
			}
			const fileName = args.path.split(/[\\/]/).pop() ?? "file";
			let uploadKey;
			if (isImage) uploadKey = extractUploadKey(await client.uploadImage({ image: buf }), "image_key");
			else uploadKey = extractUploadKey(await client.uploadFile({
				file_type: "file",
				file_name: fileName,
				file: buf
			}), "file_key");
			if (!uploadKey) return "错误: 上传失败";
			await sender.sendFile(route.chatId, uploadKey, isImage ? "image" : "file");
			return `已发送 ${args.path}`;
		}
	}));
	ctx.tools.register(defineTool({
		name: "lark_config_get",
		description: "Read bridge config (hot-reloadable keys).",
		parameters: {},
		output: {
			schema: { type: "string" },
			render: (_a, v) => [{
				type: "text",
				text: v
			}]
		},
		async execute() {
			return JSON.stringify(getCfg(), null, 2);
		}
	}));
	const commandsCtx = ctx;
	const registerCmd = (name, description, handler, inputHint) => {
		commandsCtx.commands?.register?.({
			name,
			description,
			...inputHint !== void 0 ? { input: { hint: inputHint } } : {},
			handler: async (inv) => ({
				kind: "success",
				text: await handler(inv?.rawInput ?? "")
			})
		});
	};
	const runLarkSubcommand = async (sub) => {
		switch (sub) {
			case "status": return formatStatusLine(status.get());
			case "start":
				await startBridge();
				return lifecycleStarted ? "bridge started" : startBlocker ?? "bridge 未启动";
			case "stop":
				await stopBridge();
				return "bridge stopped";
			case "restart":
				await stopBridge();
				await startBridge();
				return lifecycleStarted ? "bridge restarted" : startBlocker ?? "bridge 未启动";
			case "setup": return await runSetup();
			case "uninstall-clean": return await runUninstallClean();
			default: return "Lark Link 用法：/lark setup | start | stop | restart | status | uninstall-clean";
		}
	};
	registerCmd("lark", "Lark Link bridge — usage: /lark setup|start|stop|restart|status|uninstall-clean", async (rawInput) => runLarkSubcommand((rawInput.trim().split(/\s+/)[0] ?? "").toLowerCase()), "setup|start|stop|restart|status|uninstall-clean");
	/**
	* Locate the DSH session log for a bridge session id. Persisted logs live
	* at <DSH_HOME>/sessions/<workspace-dir>/<encoded-session-id>/session.jsonl.zstd
	* where ":" encodes as "~003A" — scan every workspace dir for the match.
	*/
	/** Scan ~/.dsh/sessions for the most recently written lark-link session id. */
	const findLatestLarkSessionId = () => {
		const sessionsRoot = join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "sessions");
		if (!existsSync(sessionsRoot)) return void 0;
		let latest;
		for (const wsDir of readdirSync(sessionsRoot)) {
			const wsPath = join(sessionsRoot, wsDir);
			let entries = [];
			try {
				entries = readdirSync(wsPath);
			} catch {
				continue;
			}
			for (const name of entries) {
				if (!name.includes("lark-link")) continue;
				const sessionDir = join(wsPath, name);
				const zstd = join(sessionDir, "session.jsonl.zstd");
				if (!existsSync(zstd)) continue;
				let mtime = 0;
				try {
					mtime = statSync(zstd).mtimeMs;
				} catch {
					continue;
				}
				if (!latest || mtime > latest.mtime) latest = {
					id: name.replace(/~003A/g, ":"),
					mtime
				};
			}
		}
		return latest?.id;
	};
	const buildSessionExportZip = async (sessionId, diagText, issueMd) => {
		try {
			const services = ctx;
			const persistence = services.get?.("sessionPersistence");
			const query = services.get?.("sessionQuery");
			const files = [];
			let root;
			if (persistence?.readRaw) try {
				root = await persistence.readRaw(sessionId);
			} catch (err) {
				logger.warn(`doctor: sessionPersistence.readRaw failed: ${err instanceof Error ? err.message : String(err)}`);
			}
			else logger.warn("doctor: sessionPersistence service unavailable — falling back to file scan");
			if (root) {
				files.push({
					name: root.filename,
					data: Buffer.from(root.content, "utf8")
				});
				const seen = /* @__PURE__ */ new Set([sessionId]);
				const collect = async (nodes) => {
					for (const node of nodes) {
						const id = node.session.header.id;
						if (seen.has(id)) continue;
						seen.add(id);
						const raw = await persistence?.readRaw?.(id);
						if (raw !== void 0) {
							const safe = id.replace(/[^A-Za-z0-9_-]/g, "_");
							files.push({
								name: `subagents/${safe}/${raw.filename}`,
								data: Buffer.from(raw.content, "utf8")
							});
						}
						await collect(node.descendants ?? []);
					}
				};
				if (query?.traceSession) try {
					await collect((await query.traceSession(sessionId)).descendants);
				} catch (err) {
					logger.warn(`doctor: traceSession failed (subagents skipped): ${err instanceof Error ? err.message : String(err)}`);
				}
			}
			if (files.length === 0) {
				const sessionsRoot = join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "sessions");
				const encoded = sessionId.replace(/:/g, "~003A");
				let zstdPath;
				if (existsSync(sessionsRoot)) for (const wsDir of readdirSync(sessionsRoot)) {
					const candidate = join(sessionsRoot, wsDir, encoded, "session.jsonl.zstd");
					if (existsSync(candidate)) {
						zstdPath = candidate;
						break;
					}
				}
				if (!zstdPath) {
					logger.warn(`doctor: no session log found for ${sessionId} (service + file scan)`);
					return;
				}
				const jsonl = zstdDecompressSync(readFileSync(zstdPath)).toString("utf8");
				logger.info(`doctor: file-scan fallback used: ${zstdPath}`);
				files.push({
					name: "session.jsonl",
					data: Buffer.from(jsonl, "utf8")
				});
			}
			files.push({
				name: "ISSUE.md",
				data: Buffer.from(`# dsh-lark-link 诊断包\n\n${diagText}\n\n${issueMd}\n`, "utf8")
			});
			files.push({
				name: "README.txt",
				data: Buffer.from([
					"本压缩包内容：",
					"- session.jsonl: 当前会话的 DSH session log（与 WebUI 右上角 Session log 下载一致）",
					"- subagents/: 子代理会话日志",
					"- ISSUE.md: 脱敏诊断信息（配置/连接状态/Outbox 等）",
					"",
					"将本包直接发给维护者，或贴 ISSUE.md 给 AI 即可定位问题。"
				].join("\n"), "utf8")
			});
			const { zipSync, strToU8 } = await import("fflate");
			const entries = {};
			for (const f of files) entries[f.name] = strToU8(new TextDecoder().decode(f.data));
			const buf = Buffer.from(zipSync(entries, { level: 6 }));
			logger.info(`doctor: zip built (${files.length} files, ${buf.length} bytes)`);
			return buf;
		} catch (err) {
			logger.warn(`doctor: zip build failed: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
	};
	const runSetup = async () => {
		const ref = getCfg().credentialRef;
		const envAppId = process.env.DSH_LARK_APP_ID?.trim();
		const envSecret = process.env.DSH_LARK_APP_SECRET?.trim();
		if (envAppId && envSecret) {
			const envDomain = process.env.DSH_LARK_DOMAIN === "lark" ? "lark" : "feishu";
			await persistCredentials(credStore, ref, {
				appId: envAppId,
				appSecret: envSecret,
				domain: envDomain
			});
			return `凭据已保存（env 手动，appId=${maskId(envAppId)}，domain=${envDomain}）。运行 /lark start 启动。`;
		}
		let qrInfo;
		(async () => {
			const setup = createAuthSetup({
				registerApp: registerAppWithFetch(),
				persist: async (c) => {
					await persistCredentials(credStore, ref, c);
				},
				logger
			});
			try {
				const res = await setup.run({
					onQRCodeReady(info) {
						qrInfo = info;
						QRCode.toBuffer(info.url, {
							type: "png",
							margin: 1,
							width: 256
						}).then((png) => {
							activeQr = {
								png,
								expireAt: Date.now() + info.expireIn * 1e3
							};
						}).catch((e) => logger.warn(`qr png failed: ${e instanceof Error ? e.message : String(e)}`));
						try {
							qrcode.generate(info.url, { small: true }, (qr) => console.log(`\n${qr}`));
						} catch {}
					},
					onStatusChange: (s) => logger.info(`setup: ${s}`)
				});
				logger.info(`setup complete: appId=${res.appId} domain=${res.domain}`);
				activeQr = void 0;
			} catch (err) {
				logger.warn(`setup background failed: ${err instanceof Error ? err.message : String(err)}`);
				activeQr = void 0;
			}
		})();
		const deadline = Date.now() + 3e4;
		while (!qrInfo && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
		if (!qrInfo) return "扫码流程未在 30s 内就绪。可改用手动通道：设 DSH_LARK_APP_ID + DSH_LARK_APP_SECRET 后再 /lark setup。";
		console.log(`飞书授权二维码链接: ${qrInfo.url}（${qrInfo.expireIn} 秒后过期）`);
		return [
			"📱 飞书授权二维码已生成 —— 见左侧 🪶 Lark 面板（或终端），手机飞书扫码确认。",
			"",
			`二维码 ${qrInfo.expireIn} 秒后过期。扫码后凭据在后台写入，运行 /lark start 启动。`,
			`备用链接（手机浏览器打开）：${qrInfo.url}`,
			"看不到二维码？终端也打印了；或用 DSH_LARK_APP_ID/SECRET 手动通道。"
		].join("\n");
	};
	const runUninstallClean = async () => {
		await stopBridge();
		const ref = getCfg().credentialRef;
		await clearCredentials(credStore, ref);
		larkClient = void 0;
		for (const f of [
			"config.json",
			"routes.json",
			"dedupe.jsonl",
			"conn-history.jsonl",
			"status.json",
			"runtime-overrides.json"
		]) try {
			rmSync(join(dir, f), { force: true });
		} catch {}
		try {
			rmSync(join(dir, "outbox"), {
				recursive: true,
				force: true
			});
		} catch {}
		try {
			rmSync(join(dir, "inbound-wal"), {
				recursive: true,
				force: true
			});
		} catch {}
		return `已清除凭据（ref=${ref}）并清理状态目录 ${dir}。重新使用请运行 /lark setup。`;
	};
	try {
		ctx.systemPrompt?.section?.({
			priority: 200,
			section: () => ({
				role: "system",
				content: [
					"你正在通过飞书/Lark 桥接与用户对话。",
					"可用工具: lark_send_local_file（发送本地文件到当前飞书会话）、lark_config_get（读取桥配置）。",
					"回复要简洁；长输出会自动流式呈现给用户。"
				].join("\n")
			})
		});
	} catch {}
	ctx.effect(() => {
		startBridge();
		const sweep = setInterval(() => {
			if (conversations.sweep() > 0) status.refreshCounters({
				outboxPending: outbox.pendingCount(),
				outboxFailed: outbox.failedCount(),
				inboundPending: inboundWal.pendingReplays().length
			});
		}, 6e4);
		sweep.unref?.();
		return async () => {
			clearInterval(sweep);
			await stopBridge();
		};
	});
}
//#endregion
export { apply, inject, name, stateDir };
