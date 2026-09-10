window.__ModuleLoader__.load({
	id: "@xiangsam/dsh-cpa-plugin",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const h = react.createElement;
		const { useState, useEffect, useCallback, useRef, useSyncExternalStore } = react;
		const { Tooltip } = require("@deepseek-ai/dsh-client-ui-primitives");

		// Must match settingsNamespace("llm-cpa") / PROVIDER in lib/index.js.
		const NS = "llm-cpa";
		const PROVIDER = "cpa";
		const TICKS = [65536, 262144, 524288, 1048576];

		function formatTokens(n) {
			if (n >= 1_000_000) {
				const v = n / 1_000_000;
				return `${Number.isInteger(v) ? v : v.toFixed(1)}M`;
			}
			if (n >= 1_000) {
				const v = n / 1_000;
				return `${Number.isInteger(v) ? v : v.toFixed(1)}K`;
			}
			return String(n);
		}

		// ---------------------------------------------------------------------
		// Client-side mirror of lib/index.js's context-window resolution chain
		// (bundled CPA snapshot table -> OpenRouter live catalog -> family-prefix
		// heuristic -> fallback), MINUS the `models:` catalog step, which is read
		// from the live settings value instead of duplicated here. Needed so the
		// slider's own drag range can be bounded by the *currently selected*
		// model's real max, not just the global `sliderMaxTokens` ceiling —
		// resolveModel() runs server-side per request and its result isn't
		// otherwise reachable from here (LlmModelInfo, what listModels() returns,
		// carries no context field by design; only LlmResolvedModelInfo does).
		// Keep this table in sync with KNOWN_MODEL_CONTEXT_WINDOWS in lib/index.js.
		// ---------------------------------------------------------------------
		const KNOWN_MODEL_CONTEXT_WINDOWS = {
			"claude-sonnet-5": 200_000,
			"claude-sonnet-5-1m": 1_000_000,
			"claude-sonnet-4.6": 176_000,
			"claude-sonnet-4.6-1m": 1_000_000,
			"claude-sonnet-4.5": 1_000_000,
			"claude-opus-5": 1_000_000,
			"claude-opus-4.8": 176_000,
			"claude-opus-4.8-1m": 1_000_000,
			"claude-opus-4.7": 176_000,
			"claude-opus-4.7-1m": 1_000_000,
			"claude-opus-4.6": 176_000,
			"claude-opus-4.6-1m": 1_000_000,
			"claude-opus-4.5": 200_000,
			"claude-opus-4.1": 200_000,
			"claude-opus-4": 200_000,
			"claude-haiku-4.5": 176_000,
			"claude-fable-5": 1_000_000,
			"gemini-3.1-pro": 400_000,
			"gemini-3.5-flash": 1_000_000,
			"gpt-5.6-sol": 1_000_000,
			"gpt-5.6-terra": 1_000_000,
			"gpt-5.6-luna": 1_000_000,
			"gpt-5.5": 1_000_000,
			"gpt-5.4": 272_000,
			"gpt-5.3-codex": 272_000,
			"gpt-oss-120b": 128_000,
			"glm-5.2-ioa": 1_000_000,
			"glm-5.2-internal-ioa": 200_000,
			"glm-5v-turbo-ioa": 200_000,
			"glm-5.0-ioa": 200_000,
			"minimax-m3-ioa": 512_000,
			"minimax-m2.7-ioa": 200_000,
			"kimi-k3-ioa": 1_000_000,
			"kimi-k2.7-ioa": 256_000,
			"kimi-k2.6-ioa": 256_000,
			"hy3-ioa": 192_000,
			"deepseek-v4-flash-ioa": 1_000_000,
			"deepseek-v4-pro-ioa": 1_000_000,
			"grok-4.20": 2_000_000,
			"grok-4.20-multi-agent": 2_000_000,
			"grok-4.3": 1_000_000,
			"grok-build-0.1": 256_000,
		};
		const KNOWN_MODEL_CONTEXT_WINDOWS_DASHED = Object.fromEntries(
			Object.entries(KNOWN_MODEL_CONTEXT_WINDOWS).map(([id, tokens]) => [id.replace(/\./g, "-"), tokens]),
		);

		const EFFORT_SUFFIX_RE = /-(none|minimal|extra-low|low|medium|high|xhigh|max|thinking)$/;
		function stripEffortSuffix(lower) {
			const stripped = lower.replace(EFFORT_SUFFIX_RE, "");
			return stripped === lower ? undefined : stripped;
		}

		function familyContextWindow(lower) {
			if (lower.startsWith("deepseek-v4")) return 1_000_000;
			if (lower.startsWith("gpt-5.6") || lower.startsWith("gpt-5.5")) return 1_000_000;
			if (lower.startsWith("gpt-5.4") || lower.startsWith("gpt-5.3")) return 272_000;
			if (lower.startsWith("gpt-oss")) return 128_000;
			if (lower.startsWith("claude")) {
				if (lower.includes("[1m]") || lower.endsWith("-1m")) return 1_000_000;
				if (lower.startsWith("claude-sonnet-5")) return 200_000;
				if (lower.startsWith("claude-sonnet-4")) return 1_000_000;
				if (lower.startsWith("claude-opus-4-5") || lower.startsWith("claude-opus-4-1")) return 200_000;
				if (lower.startsWith("claude-opus-4-8") || lower.startsWith("claude-opus-4-7") || lower.startsWith("claude-opus-4-6")) return 176_000;
				return 176_000;
			}
			if (lower.startsWith("grok-4.20")) return 2_000_000;
			if (lower.startsWith("grok-4.3")) return 1_000_000;
			if (lower.startsWith("grok-build")) return 256_000;
			if (lower.startsWith("grok")) return 500_000;
			if (lower.startsWith("gemini")) return 1_000_000;
			return undefined;
		}

		const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
		const OPENROUTER_CACHE_MS = 6 * 60 * 60 * 1000;
		const OPENROUTER_RETRY_MS = 60_000;
		const OPENROUTER_TIMEOUT_MS = 5_000;
		let openRouterCache;
		let openRouterInFlight;

		async function openRouterContextWindows() {
			const now = Date.now();
			if (openRouterCache !== undefined && now - openRouterCache.at < openRouterCache.ttlMs) return openRouterCache.byId;
			if (openRouterInFlight !== undefined) return openRouterInFlight;
			openRouterInFlight = (async () => {
				const byId = new Map();
				let ttlMs = OPENROUTER_RETRY_MS;
				try {
					const response = await fetch(OPENROUTER_MODELS_URL, { signal: AbortSignal.timeout(OPENROUTER_TIMEOUT_MS) });
					if (response.ok) {
						const body = await response.json();
						for (const row of Array.isArray(body?.data) ? body.data : []) {
							const contextLength = row?.context_length;
							if (typeof contextLength !== "number" || !(contextLength > 0)) continue;
							const bare = String(row?.id ?? "")
								.replace(/^~/, "")
								.split("/")
								.pop()
								?.split(":")[0];
							if (bare === undefined || bare.length === 0) continue;
							const lower = bare.toLowerCase();
							if (!byId.has(lower)) byId.set(lower, contextLength);
							const dashed = lower.replace(/\./g, "-");
							if (!byId.has(dashed)) byId.set(dashed, contextLength);
						}
						ttlMs = OPENROUTER_CACHE_MS;
					}
				} catch {
					// best-effort; resolveModelMax falls further down its chain.
				}
				openRouterCache = { at: Date.now(), ttlMs, byId };
				openRouterInFlight = undefined;
				return byId;
			})();
			return openRouterInFlight;
		}

		/** Mirrors lib/index.js's resolveContextWindow, minus the network round trip through our own server. */
		async function resolveModelMax(modelId, models, defaultContextWindow) {
			const configured = models.find((entry) => entry.id === modelId);
			if (typeof configured?.contextWindow === "number") return configured.contextWindow;
			const lower = modelId.toLowerCase();
			const stripped = stripEffortSuffix(lower);
			const candidates = stripped === undefined ? [lower] : [lower, stripped];
			for (const candidate of candidates) {
				const exact = KNOWN_MODEL_CONTEXT_WINDOWS[candidate] ?? KNOWN_MODEL_CONTEXT_WINDOWS_DASHED[candidate];
				if (exact !== undefined) return exact;
			}
			const openRouterMap = await openRouterContextWindows();
			for (const candidate of candidates) {
				const hit = openRouterMap.get(candidate);
				if (hit !== undefined) return hit;
			}
			for (const candidate of candidates) {
				const family = familyContextWindow(candidate);
				if (family !== undefined) return family;
			}
			return defaultContextWindow;
		}

		const EMPTY_DIRECTORY_SNAPSHOT = { current: null };

		/**
		 * A trigger pill + upward-opening panel in the composer's tool row
		 * (`conversation.input.right`, beside the Model/Effort seat and the
		 * built-in ContextMeter) — same open/close/outside-click/Escape pattern
		 * and the same `--dsw-*` theme tokens as that ContextMeter, so it reads
		 * as a native control rather than a bolted-on one. `input.right` (unlike
		 * `composer.dock`) renders even on the pre-first-message "hero" screen.
		 *
		 * Reads and writes `contextCapTokens` on the `llm-cpa` settings section
		 * live — dsh-compaction-basic re-reads the adapter's resolved
		 * contextWindow on every pressure check, so moving the slider retunes
		 * auto-compact immediately, no dsh restart required. The drag range
		 * itself is bounded by `min(sliderMaxTokens, current model's real max)`:
		 * when the composer's currently selected model is one of ours, its real
		 * max is resolved (via `resolveModelMax`, mirroring the server) and used
		 * as the ceiling, so — unlike the earlier version of this control — the
		 * slider itself cannot be dragged past what that model actually
		 * supports, not just clamped after the fact server-side. Falls back to
		 * the global `sliderMaxTokens` ceiling when no CPA model is selected
		 * (or the model-selection service isn't available in this profile).
		 */
		function ContextCapControl(props) {
			const { api, onDocumentUpdated, directory } = props;
			const [state, setState] = useState({ status: "loading" });
			const [modelMax, setModelMax] = useState(undefined);
			const [writing, setWriting] = useState(false);
			const [open, setOpen] = useState(false);
			const rootRef = useRef(null);
			// Discrete ticks only: one confirmed write at a time. A drag that
			// crosses several rungs used to fire overlapping mutates; the later
			// (usually larger) value could lose SETTINGS_CONFLICT while the pill
			// still showed the draft. Lock the slider until the write settles.
			const writingRef = useRef(false);

			const directorySnapshot = useSyncExternalStore(
				directory === undefined ? () => () => {} : directory.store.subscribe,
				directory === undefined ? () => EMPTY_DIRECTORY_SNAPSHOT : directory.store.getSnapshot,
			);
			const currentModelId = directorySnapshot.current?.provider === PROVIDER ? directorySnapshot.current.model : undefined;

			const refresh = useCallback(() => {
				api.settings.describe({}).then(
					(response) => {
						if (writingRef.current) return;
						if (!response.result.ok) {
							setState({ status: "error" });
							return;
						}
						const view = response.result.value.namespaces.find((entry) => entry.ns === NS);
						const value = view?.value ?? {};
						const sliderMax = typeof value.sliderMaxTokens === "number" ? value.sliderMaxTokens : 1_048_576;
						const cap = typeof value.contextCapTokens === "number" ? value.contextCapTokens : sliderMax;
						const models = Array.isArray(value.models) ? value.models : [];
						const defaultContextWindow = typeof value.defaultContextWindow === "number" ? value.defaultContextWindow : 128_000;
						setState({ status: "ready", cap, sliderMax, models, defaultContextWindow });
					},
					() => setState({ status: "error" }),
				);
			}, [api]);

			const commit = useCallback(
				(next) => {
					if (writingRef.current) return;
					writingRef.current = true;
					setWriting(true);
					setState((current) => (current.status === "ready" ? { ...current, cap: next } : current));
					api.settings
						.mutate({
							ns: NS,
							ops: [{ op: "set", path: ["contextCapTokens"], value: next }],
						})
						.then(refresh, refresh)
						.finally(() => {
							writingRef.current = false;
							setWriting(false);
						});
				},
				[api, refresh],
			);

			useEffect(() => {
				refresh();
				return onDocumentUpdated((ns) => {
					if (ns === NS && !writingRef.current) refresh();
				});
			}, [refresh, onDocumentUpdated]);

			useEffect(() => {
				if (state.status !== "ready") return;
				if (currentModelId === undefined) {
					setModelMax(undefined);
					return;
				}
				let cancelled = false;
				resolveModelMax(currentModelId, state.models, state.defaultContextWindow).then((max) => {
					if (!cancelled) setModelMax(max);
				});
				return () => {
					cancelled = true;
				};
			}, [state.status, state.status === "ready" ? state.models : undefined, state.status === "ready" ? state.defaultContextWindow : undefined, currentModelId]);

			useEffect(() => {
				if (!open) return;
				const onPointerDown = (event) => {
					if (event.target instanceof Node && rootRef.current?.contains(event.target) === true) return;
					setOpen(false);
				};
				const onKeyDown = (event) => {
					if (event.key === "Escape") setOpen(false);
				};
				document.addEventListener("pointerdown", onPointerDown);
				document.addEventListener("keydown", onKeyDown);
				return () => {
					document.removeEventListener("pointerdown", onPointerDown);
					document.removeEventListener("keydown", onKeyDown);
				};
			}, [open]);

			if (state.status !== "ready") return null;

			const { cap, sliderMax } = state;
			// The real bound: the global ceiling, further narrowed by the
			// currently selected CPA model's actual max once known. `undefined`
			// modelMax (still resolving, or no CPA model selected) just means
			// "no extra narrowing yet" — never a wider bound than sliderMax.
			const rawMax = modelMax === undefined ? sliderMax : Math.min(sliderMax, modelMax);
			// Discrete snap points only — no continuous drag. Ticks are the fixed
			// 64K/256K/512K/1M ladder, filtered to the resolved ceiling and closed
			// off with rawMax itself when that ceiling falls between two rungs.
			const ticks = TICKS.filter((tick) => tick <= rawMax);
			if (ticks.length === 0 || ticks[ticks.length - 1] !== rawMax) ticks.push(rawMax);
			const nearestIndex = (tokens) => {
				let best = 0;
				let bestDiff = Infinity;
				for (let i = 0; i < ticks.length; i++) {
					const diff = Math.abs(ticks[i] - tokens);
					if (diff < bestDiff) {
						best = i;
						bestDiff = diff;
					}
				}
				return best;
			};
			const index = nearestIndex(Math.min(cap, rawMax));
			const value = ticks[index];

			const icon = h(
				"svg",
				{ viewBox: "0 0 16 16", width: "14", height: "14", "aria-hidden": true },
				h("line", { x1: 2, y1: 4, x2: 14, y2: 4, stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round" }),
				h("circle", { cx: 6, cy: 4, r: 1.6, fill: "currentColor" }),
				h("line", { x1: 2, y1: 8, x2: 14, y2: 8, stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round" }),
				h("circle", { cx: 10, cy: 8, r: 1.6, fill: "currentColor" }),
				h("line", { x1: 2, y1: 12, x2: 14, y2: 12, stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round" }),
				h("circle", { cx: 4, cy: 12, r: 1.6, fill: "currentColor" }),
			);

			return h(
				"span",
				{ ref: rootRef, style: { display: "inline-flex", position: "relative" } },
				h(
					Tooltip,
					{ label: `CPA context cap: ${formatTokens(value)}`, side: "top", delayMs: 200, disabled: open },
					h(
						"button",
						{
							type: "button",
							"aria-haspopup": "dialog",
							"aria-expanded": open,
							"aria-label": `CPA context cap ${formatTokens(value)}`,
							onClick: () => setOpen(!open),
							style: {
								width: "28px",
								height: "28px",
								display: "grid",
								placeItems: "center",
								color: "var(--dsw-alias-label-secondary, #81858c)",
								background: open ? "var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.16))" : "transparent",
								border: "none",
								borderRadius: "999px",
								cursor: "pointer",
							},
							onMouseEnter: (event) => {
								event.currentTarget.style.background = "var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.16))";
							},
							onMouseLeave: (event) => {
								if (!open) event.currentTarget.style.background = "transparent";
							},
						},
						icon,
					),
				),
				open &&
					h(
						"div",
						{
							role: "dialog",
							style: {
								zIndex: 100,
								boxSizing: "border-box",
								border: "1px solid var(--dsw-alias-border-inverted, rgba(127,127,127,.3))",
								background: "var(--dsw-specific-menu, #1e1f22)",
								width: "280px",
								boxShadow: "var(--dsw-shadow-lv3, 0 8px 24px rgba(0,0,0,.35))",
								color: "var(--dsw-alias-label-secondary, #81858c)",
								cursor: "default",
								borderRadius: "12px",
								padding: "12px",
								fontSize: "12px",
								lineHeight: "20px",
								position: "absolute",
								bottom: "calc(100% + 8px)",
								right: 0,
							},
						},
						h(
							"div",
							{ style: { display: "flex", alignItems: "center", gap: "6px", marginBottom: "4px" } },
							h("span", { style: { color: "var(--dsw-alias-label-tertiary, #9a9ea5)" } }, "CPA context cap"),
							h(
								"span",
								{ style: { marginLeft: "auto", fontVariantNumeric: "tabular-nums", color: "var(--dsw-alias-label-primary, #fff)", fontWeight: 500 } },
								formatTokens(value),
							),
						),
						h(
							"div",
							{ style: { marginBottom: "8px", fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #9a9ea5)" } },
							currentModelId === undefined
								? "Applies to any CPA model."
								: modelMax === undefined
									? `Resolving ${currentModelId}'s real max…`
									: `${currentModelId} supports up to ${formatTokens(modelMax)}.`,
						),
						h("input", {
							type: "range",
							min: 0,
							max: ticks.length - 1,
							step: 1,
							value: index,
							disabled: writing,
							style: {
								width: "100%",
								height: "16px",
								accentColor: "var(--dsw-alias-state-business-primary, #4c8dff)",
								opacity: writing ? 0.6 : 1,
								cursor: writing ? "wait" : "pointer",
							},
							onChange: (event) => {
								if (writingRef.current) return;
								const tokens = ticks[Number(event.target.value)];
								if (tokens === undefined || tokens === cap) return;
								commit(tokens);
							},
						}),
						h(
							"div",
							{ style: { display: "flex", justifyContent: "space-between", marginTop: "4px" } },
							ticks.map((tick, i) =>
								h(
									"span",
									{
										key: tick,
										style: {
											fontSize: "11px",
											fontVariantNumeric: "tabular-nums",
											color: i === index ? "var(--dsw-alias-label-primary, #fff)" : "var(--dsw-alias-label-tertiary, #9a9ea5)",
											fontWeight: i === index ? 500 : 400,
										},
									},
									formatTokens(tick),
								),
							),
						),
					),
			);
		}

		const name = "llm-cpa-client";
		const inject = ["connection", "remote"];

		function apply(ctx) {
			const connection = ctx.get("connection");
			const api = connection.api;
			const onDocumentUpdated = (handler) => ctx.remote.$on("settings/document-updated", handler);
			// Deferred: dsh-client-ui-model-selection (which owns `modelDirectories`)
			// isn't a hard dependency — if it's ever absent from a profile, this
			// control simply never registers instead of hanging apply() forever.
			ctx.inject(["slots", "modelDirectories"], (scope) => {
				scope.slots.inject(
					"conversation.input.right",
					() =>
						scope.slots.register(
							{
								name: "conversation.input.right",
								id: "cpa-context-cap",
								order: 5,
								inject: (sessionId) => ({ api, onDocumentUpdated, directory: scope.modelDirectories.directoryFor(sessionId) }),
							},
							ContextCapControl,
						),
				);
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	},
});
