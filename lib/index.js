import z from "@deepseek-ai/schemastery";
import {
	CONTEXT_WINDOW_EXCEEDED_CODE,
	EMPTY_RESPONSE_CODE,
	LlmAdapter,
	LlmError,
	ProviderRequestId,
	QUOTA_EXCEEDED_CODE,
	ReasoningEffortId,
	RetryPolicySchema,
	ToolCallId,
	assertUsableApiKey,
	attributionHeaders,
	contentHasImage,
	isContextWindowExceededError,
	isQuotaExceededError,
	resolveRetryPolicy,
} from "@deepseek-ai/dsh-llm";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { deepEqualJson } from "@deepseek-ai/dsh-util-values";
import { MAX_TIMER_DELAY_MS, idleWatchdog, timeoutOf } from "@deepseek-ai/dsh-timeout";
import { getOrCreateAnonymousUserId } from "@deepseek-ai/dsh-anonymous-user-id";
import { EventSourceParserStream } from "eventsource-parser/stream";

// ---------------------------------------------------------------------------
// Wire serialization: harness messages -> CPA OpenAI Responses (`/v1/responses`).
// Chat completions left Grok on FormatOpenAI, which does not replay encrypted
// reasoning; Responses is FormatOpenAIResponse, the same ingress Codex App uses.
// CPA still translates onward to each subscription leg.
// ---------------------------------------------------------------------------

const REASONING_EFFORT_IDS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Route-owned pixel/byte budget for inline base64 `input_image` parts (the
 * `readImageRequest` policy contract of dsh >= 0.1.5-alpha). The byte cap
 * mirrors dsh-llm-deepseek's inline image quantum; the pixel cap is the
 * upper bound of one CPA Responses image.
 */
const CPA_INLINE_IMAGE_POLICY = { maxPixels: 8_000_000, maxBytes: 20 * 1024 * 1024 };

/** Validate the adapter-owned effort before resolving its wire fields. */
function reasoningEffort(effort) {
	if (REASONING_EFFORT_IDS.includes(effort)) return effort;
	throw new LlmError(`CPA adapter does not support reasoning effort "${effort}"`, "UNSUPPORTED_REASONING_EFFORT");
}

/** Resolve one legal thinking/effort pair without exposing `none` as a wire effort. */
function resolveThinking(options, defaults) {
	if (options.purpose === "session-title") return { thinking: "disabled" };
	const effort = options.reasoningEffort === undefined ? defaults.reasoningEffort : reasoningEffort(options.reasoningEffort);
	if (defaults.thinking === "disabled" && effort !== undefined && effort !== "none") {
		throw new LlmError(`CPA deployment does not support reasoning effort "${effort}"`, "UNSUPPORTED_REASONING_EFFORT");
	}
	if (effort === "none" || effort === undefined) return { thinking: defaults.thinking === undefined ? undefined : defaults.thinking };
	return { thinking: "enabled", reasoningEffort: effort };
}

function flattenText(blocks) {
	return blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
}

function textPart(type, text) {
	return { type, text };
}

/**
 * One `input_image` part for a Responses user/tool-result content array,
 * resolved through the durable attachment service (`ctx.attachments`) — the
 * block itself only carries an opaque `ImageAttachmentRef`, never raw bytes.
 * Mirrors the wire shape CPA's own Codex-ingress conversion produces for the
 * same FormatOpenAIResponse target (`convertToolResultOutput` in
 * `@earendil-works/pi-ai`'s `openai-responses-shared.js`).
 *
 * dsh >= 0.1.5-alpha: the attachment service derives the model-request image
 * through `readImageRequest(ref, policy, signal)` (normalized, route-budgeted)
 * instead of the removed `readImage(ref)`; the returned record carries the
 * media type and request bytes directly.
 */
async function imagePart(block, attachments) {
	const stored = await attachments.readImageRequest(block.attachment, CPA_INLINE_IMAGE_POLICY);
	return {
		type: "input_image",
		detail: "auto",
		image_url: `data:${stored.mediaType};base64,${Buffer.from(stored.data).toString("base64")}`,
	};
}

/** Serialize one user-role content array to Responses `input_text`/`input_image` parts; blocks of any other type (tool-result, tool-call) are ignored here, handled separately by the caller. */
async function serializeUserContent(blocks, attachments) {
	const parts = [];
	for (const block of blocks) {
		if (block.type === "text") {
			if (block.text.length > 0) parts.push(textPart("input_text", block.text));
		} else if (block.type === "image") {
			parts.push(await imagePart(block, attachments));
		}
	}
	return parts;
}

/**
 * `function_call_output.output`: plain text when the tool result carries no
 * image, else an `input_text`/`input_image` array — same shape CPA's own
 * Codex-ingress conversion falls back to for image-bearing tool results.
 * Only called once the caller has confirmed the model accepts image input.
 */
async function serializeToolResultOutput(blocks, attachments) {
	const text = flattenText(blocks);
	const images = blocks.filter((block) => block.type === "image");
	if (images.length === 0) return text.length > 0 ? text : "(no output)";
	const parts = [];
	if (text.length > 0) parts.push(textPart("input_text", text));
	for (const image of images) parts.push(await imagePart(image, attachments));
	return parts;
}

function serializeAssistantItems(message) {
	const items = [];
	// Do not echo reasoning summaries back as input items. CPA's xAI/Codex
	// legs replay encrypted reasoning from the previous turn when this
	// request is FormatOpenAIResponse and `prompt_cache_key` is stable.
	const text = flattenText(message.content);
	if (text.length > 0) {
		items.push({
			type: "message",
			role: "assistant",
			content: [textPart("output_text", text)],
		});
	}
	for (const block of message.content) {
		if (block.type !== "tool-call") continue;
		items.push({
			type: "function_call",
			call_id: block.id,
			name: block.name,
			arguments: block.arguments,
		});
	}
	return items;
}

/** `attachments` is only ever undefined when nothing in `options.messages` carries an image — the caller (`CpaAdapter.stream`) has already confirmed the target model accepts image input before this runs. */
async function serializeInput(options, attachments) {
	const input = [];
	if (options.system !== undefined) {
		input.push({
			type: "message",
			role: "developer",
			content: [textPart("input_text", options.system)],
		});
	}
	for (const message of options.messages) {
		if (message.role === "system") {
			if (contentHasImage(message.content)) {
				throw new LlmError("The CPA responses adapter cannot represent an image in a system message.", "UNSUPPORTED_CONTENT");
			}
			const text = flattenText(message.content);
			if (text.length > 0) {
				input.push({
					type: "message",
					role: "developer",
					content: [textPart("input_text", text)],
				});
			}
			continue;
		}
		if (message.role === "assistant") {
			if (contentHasImage(message.content)) {
				throw new LlmError("The CPA responses adapter does not support image content in assistant history.", "UNSUPPORTED_CONTENT");
			}
			input.push(...serializeAssistantItems(message));
			continue;
		}
		const toolResults = message.content.filter((block) => block.type === "tool-result");
		const content = contentHasImage(message.content)
			? await serializeUserContent(message.content, attachments)
			: (() => {
					const text = flattenText(message.content);
					return text.length > 0 ? [textPart("input_text", text)] : [];
				})();
		if (content.length > 0 || toolResults.length === 0) {
			input.push({
				type: "message",
				role: "user",
				content,
			});
		}
		for (const result of toolResults) {
			const output = contentHasImage(result.content)
				? await serializeToolResultOutput(result.content, attachments)
				: flattenText(result.content) || "(no output)";
			input.push({
				type: "function_call_output",
				call_id: result.toolCallId,
				output,
			});
		}
	}
	return input;
}

async function serializeRequest(options, defaults = {}, attachments) {
	const tools = options.tools?.map((tool) => ({
		type: "function",
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
	}));
	const resolvedThinking = resolveThinking(options, defaults);
	const cacheKey = promptCacheKey(options);
	const includeEncrypted = options.purpose !== "session-title";
	return {
		model: options.model,
		input: await serializeInput(options, attachments),
		stream: true,
		store: false,
		...(includeEncrypted ? { include: ["reasoning.encrypted_content"] } : {}),
		parallel_tool_calls: true,
		...(resolvedThinking.thinking !== undefined || resolvedThinking.reasoningEffort !== undefined
			? {
					reasoning: {
						...(resolvedThinking.thinking === "disabled" ? { effort: "none" } : {}),
						...(resolvedThinking.reasoningEffort !== undefined ? { effort: resolvedThinking.reasoningEffort } : {}),
						...(resolvedThinking.thinking === "enabled" ? { summary: "auto" } : {}),
					},
				}
			: {}),
		...(tools !== undefined && tools.length > 0 ? { tools } : {}),
		...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
		...(options.maxTokens === undefined ? {} : { max_output_tokens: options.maxTokens }),
		// The one session token CPA actually maps onto each upstream cache
		// key: xAI copies it to `x-grok-conv-id`, Codex to `Session_id` /
		// `prompt_cache_key`, Antigravity replay to `prompt-cache:<id>`.
		...(cacheKey !== undefined ? { prompt_cache_key: cacheKey } : {}),
	};
}

/** Sticky cache id for CPA/xAI. Title/compaction must not share the conversation key. */
function promptCacheKey(options) {
	if (options.sessionId === undefined) return undefined;
	const id = String(options.sessionId);
	if (options.purpose === "session-title") return `${id}:title`;
	if (options.purpose === "compaction") return `${id}:compact`;
	return id;
}

async function* parseSse(stream, onComment) {
	const events = stream.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream({ onComment }));
	for await (const event of events) {
		yield event;
		if (event.data === "[DONE]") return;
	}
}

function mapIncompleteReason(reason) {
	switch (reason) {
		case "max_output_tokens":
		case "length":
			return { kind: "max-tokens" };
		case "content_filter":
			return { kind: "error", failure: { message: "model stopped: content_filter", code: "CONTENT_FILTER" } };
		default:
			return { kind: "error", failure: { message: `model stopped: ${reason}`, code: String(reason).toUpperCase() } };
	}
}

function mapUsage(usage) {
	const inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? 0;
	const outputTokens = usage.output_tokens ?? usage.completion_tokens ?? 0;
	const cacheRead = usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens;
	const reasoning = usage.output_tokens_details?.reasoning_tokens ?? usage.completion_tokens_details?.reasoning_tokens;
	return {
		inputTokens: inputTokens - (cacheRead ?? 0),
		outputTokens,
		...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
		...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
	};
}

function closeBlock(block) {
	switch (block.kind) {
		case "text":
			return { type: "text", text: block.text };
		case "reasoning":
			return { type: "reasoning", text: block.text };
		case "tool-call":
			return { type: "tool-call", id: ToolCallId(block.callId ?? ""), name: block.name ?? "", arguments: block.text };
	}
}

async function* translate(events) {
	let nextIndex = 0;
	let textBlock;
	let reasoningBlock;
	const toolBlocks = new Map();
	const order = [];
	let pendingFinish;
	let pendingUsage;
	let completed = false;

	function open(kind) {
		const block = { index: nextIndex++, kind, text: "" };
		order.push(block);
		return block;
	}

	function* finish() {
		if (completed) return;
		completed = true;
		for (const block of order) yield { type: "block-end", index: block.index, block: closeBlock(block) };
		if (pendingUsage) yield { type: "usage", usage: pendingUsage };
		const reason =
			pendingFinish ??
			(toolBlocks.size > 0 ? { kind: "tool-calls" } : { kind: "stop" });
		yield {
			type: "finish",
			reason:
				reason.kind === "stop" && order.length === 0
					? { kind: "error", failure: { message: "model returned a completed response with no content", code: EMPTY_RESPONSE_CODE } }
					: reason,
		};
	}

	function toolKey(chunk, item) {
		return (
			chunk.item_id ||
			item?.id ||
			item?.call_id ||
			chunk.call_id ||
			(chunk.output_index !== undefined ? `out:${chunk.output_index}` : undefined)
		);
	}

	function* ensureTool(chunk, item) {
		const key = toolKey(chunk, item);
		if (key === undefined) return;
		let block = toolBlocks.get(key);
		if (!block) {
			block = open("tool-call");
			toolBlocks.set(key, block);
			yield { type: "block-start", index: block.index, blockType: "tool-call" };
		}
		const callId = item?.call_id ?? chunk.call_id;
		const name = item?.name ?? chunk.name;
		if (callId) {
			block.callId = callId;
			toolBlocks.set(callId, block);
		}
		if (name) block.name = name;
		if (item?.id) toolBlocks.set(item.id, block);
		if (chunk.item_id) toolBlocks.set(chunk.item_id, block);
		return block;
	}

	function* ensureText(delta) {
		if (typeof delta !== "string" || delta.length === 0) return;
		if (!textBlock) {
			textBlock = open("text");
			yield { type: "block-start", index: textBlock.index, blockType: "text" };
		}
		if (textBlock.text.length > 0 && delta.startsWith(textBlock.text)) delta = delta.slice(textBlock.text.length);
		if (delta.length === 0) return;
		textBlock.text += delta;
		yield { type: "text-delta", index: textBlock.index, text: delta };
	}

	function* ensureReasoning(delta) {
		if (typeof delta !== "string" || delta.length === 0) return;
		if (!reasoningBlock) {
			reasoningBlock = open("reasoning");
			yield { type: "block-start", index: reasoningBlock.index, blockType: "reasoning" };
		}
		if (reasoningBlock.text.length > 0 && delta.startsWith(reasoningBlock.text)) delta = delta.slice(reasoningBlock.text.length);
		if (delta.length === 0) return;
		reasoningBlock.text += delta;
		yield { type: "reasoning-delta", index: reasoningBlock.index, text: delta };
	}

	function* emitToolDelta(block, fragment) {
		if (fragment.length > 0) block.text += fragment;
		yield {
			type: "tool-call-delta",
			index: block.index,
			id: ToolCallId(block.callId ?? ""),
			...(block.name !== undefined ? { name: block.name } : {}),
			argumentsDelta: fragment,
		};
	}

	for await (const event of events) {
		const payload = event.data;
		if (payload === undefined || payload === "") continue;
		if (payload === "[DONE]") {
			yield* finish();
			return;
		}
		let chunk;
		try {
			chunk = JSON.parse(payload);
		} catch {
			throw new LlmError(`malformed SSE payload: ${payload.slice(0, 120)}`, "MALFORMED_RESPONSE");
		}
		const type = event.event || chunk.type;
		if (type === "error" || chunk.type === "error") {
			const message = chunk.message ?? chunk.error?.message ?? "CPA responses stream error";
			const code = chunk.code ?? chunk.error?.code;
			throw new LlmError(message, typeof code === "string" && code.length > 0 ? String(code).toUpperCase() : "PROVIDER_ERROR");
		}
		switch (type) {
			case "response.output_item.added":
			case "response.output_item.done": {
				const item = chunk.item ?? {};
				if (item.type === "function_call" || item.type === "custom_tool_call") {
					const block = yield* ensureTool(chunk, item);
					if (block !== undefined) {
						const args = item.type === "custom_tool_call" ? item.input : item.arguments;
						if (typeof args === "string" && args.length > 0 && block.text.length === 0) {
							yield* emitToolDelta(block, args);
						} else {
							yield* emitToolDelta(block, "");
						}
					}
				}
				break;
			}
			case "response.output_text.delta":
				yield* ensureText(chunk.delta);
				break;
			case "response.output_text.done":
				yield* ensureText(chunk.text);
				break;
			case "response.reasoning_summary_text.delta":
			case "response.reasoning_text.delta":
				yield* ensureReasoning(chunk.delta);
				break;
			case "response.reasoning_summary_text.done":
			case "response.reasoning_text.done":
				yield* ensureReasoning(chunk.text);
				break;
			case "response.function_call_arguments.delta":
			case "response.custom_tool_call_input.delta": {
				const block = yield* ensureTool(chunk, chunk.item);
				if (block !== undefined && typeof chunk.delta === "string") yield* emitToolDelta(block, chunk.delta);
				break;
			}
			case "response.function_call_arguments.done":
			case "response.custom_tool_call_input.done": {
				const block = yield* ensureTool(chunk, chunk.item);
				if (block !== undefined) {
					const args = chunk.arguments ?? chunk.input;
					if (typeof args === "string" && args.length > 0 && block.text.length === 0) yield* emitToolDelta(block, args);
				}
				break;
			}
			case "response.completed": {
				const response = chunk.response ?? chunk;
				if (response.usage) pendingUsage = mapUsage(response.usage);
				pendingFinish = toolBlocks.size > 0 ? { kind: "tool-calls" } : { kind: "stop" };
				yield* finish();
				return;
			}
			case "response.incomplete": {
				const response = chunk.response ?? chunk;
				if (response.usage) pendingUsage = mapUsage(response.usage);
				pendingFinish = mapIncompleteReason(response.incomplete_details?.reason ?? "incomplete");
				yield* finish();
				return;
			}
			case "response.failed": {
				const response = chunk.response ?? chunk;
				const message = response.error?.message ?? "CPA response failed";
				throw new LlmError(message, "PROVIDER_ERROR");
			}
			default:
				break;
		}
	}
	if (completed) return;
	throw new LlmError("SSE stream ended without response.completed", "STREAM_CLOSED");
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;
/** Fallback context window for a model matching none of `knownContextWindow`'s families and absent from the static catalog. */
const DEFAULT_CONTEXT_WINDOW = 128_000;
/** Default ceiling for `contextCapTokens` and the composer slider's drag range. */
const DEFAULT_CONTEXT_CAP = 1_000_000;
const DEFAULT_MAX_TOKENS = 65_536;
const STREAM_IDLE_TIMEOUT_CODE = "LLM_STREAM_IDLE_TIMEOUT";
const LIST_MODELS_CACHE_MS = 30_000;
const LIST_MODELS_TIMEOUT_MS = 5_000;

/**
 * Exact per-model context windows, decoded from CPA's own bundled catalog
 * (`App/Resources/tencent_models.json` in the MacCLIProxyAPI repo — an
 * HMAC-signed envelope around plain base64+JSON; verified by decoding it
 * directly). `catalog.updatedAt = 2026-07-31T10:17:33.000Z`, 32 models. This
 * is CPA's own ground truth for the models it names here — not a guess —
 * but it's a point-in-time snapshot bundled into the app, not something CPA
 * serves live (its `/v1/models` doesn't return context sizes either,
 * confirmed directly against the running instance). Re-run the decode
 * command in this repo's README if CPA ships a newer app build.
 */
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
/** The catalog above uses dots in version segments (`claude-opus-4.7`); CPA's live `/v1/models` roster observed dashes instead (`claude-opus-4-7`) — index both spellings. */
const KNOWN_MODEL_CONTEXT_WINDOWS_DASHED = Object.fromEntries(
	Object.entries(KNOWN_MODEL_CONTEXT_WINDOWS).map(([id, tokens]) => [id.replace(/\./g, "-"), tokens]),
);

/**
 * Exact per-model input modalities, snapshot from OpenRouter's public catalog
 * (`architecture.input_modalities`) on 2026-08-19 — same source the
 * context-window chain consults, but deliberately *static*: modalities are
 * stable per model family and the list is small, so there is no live fetch
 * for them. Re-run the probe command in this repo's README if CPA or
 * OpenRouter ship models not covered here; the family fallback below still
 * covers unknown ids.
 */
const KNOWN_MODEL_INPUT_MODALITIES = {
	"claude-sonnet-5": ["text", "image", "file"],
	"claude-sonnet-4.6": ["text", "image", "file"],
	"claude-opus-5": ["text", "image", "file"],
	"claude-opus-4.8": ["text", "image", "file"],
	"claude-opus-4.7": ["text", "image", "file"],
	"claude-opus-4.6": ["text", "image", "file"],
	"claude-haiku-4.5": ["text", "image", "file"],
	"claude-fable-5": ["text", "image", "file"],
	"gemini-3.5-flash": ["text", "image", "video", "file", "audio"],
	"gpt-5.6-sol": ["text", "image", "file"],
	"gpt-5.6-terra": ["text", "image", "file"],
	"gpt-5.6-luna": ["text", "image", "file"],
	"gpt-5.5": ["text", "image", "file"],
	"gpt-5.4": ["text", "image", "file"],
	"gpt-5.3-codex": ["text", "image", "file"],
	"grok-4.6": ["text", "image", "file"],
	"grok-4.5": ["text", "image", "file"],
	"kimi-k3-ioa": ["text", "image", "video"],
	"kimi-k2.7-ioa": ["text", "image"],
	"kimi-k2.6-ioa": ["text", "image"],
	"minimax-m3-ioa": ["text", "image", "video"],
	"glm-5v-turbo-ioa": ["text", "image", "video"],
};
/** Dot/dash variants for the modality table, mirroring the context-window table. */
const KNOWN_MODEL_INPUT_MODALITIES_DASHED = Object.fromEntries(
	Object.entries(KNOWN_MODEL_INPUT_MODALITIES).map(([id, modalities]) => [id.replace(/\./g, "-"), modalities]),
);

/** Family-prefix modality fallback for ids the static table doesn't name (observed OpenRouter families, conservative per family). Order matters: image/video *generation* models and the text-only GPT-OSS family must match before their broad `gpt`/`grok` prefixes. */
function familyInputModalities(lower) {
	if (lower.startsWith("claude")) return ["text", "image", "file"];
	if (lower.startsWith("gemini")) return ["text", "image", "video", "file", "audio"];
	if (lower.startsWith("gpt-image") || lower.startsWith("grok-imagine")) return ["text"];
	if (lower.startsWith("gpt-oss")) return ["text"];
	if (lower.startsWith("gpt")) return ["text", "image", "file"];
	if (lower.startsWith("grok")) return ["text", "image", "file"];
	if (lower.startsWith("kimi")) {
		if (lower.startsWith("kimi-k3")) return ["text", "image", "video"];
		return ["text", "image"];
	}
	if (lower.startsWith("minimax-m3")) return ["text", "image", "video"];
	if (lower.startsWith("glm-5v")) return ["text", "image", "video"];
	if (lower.startsWith("deepseek") || lower.startsWith("hy3") || lower.startsWith("glm")) return ["text"];
	return undefined;
}

/** Resolve input modalities: static exact/dashed table, then family fallback, then text-only. */
function resolveInputModalities(model) {
	const lower = model.toLowerCase();
	const stripped = stripEffortSuffix(lower);
	const candidates = stripped === undefined ? [lower] : [lower, stripped];
	for (const candidate of candidates) {
		const exact = KNOWN_MODEL_INPUT_MODALITIES[candidate] ?? KNOWN_MODEL_INPUT_MODALITIES_DASHED[candidate];
		if (exact !== undefined) return exact;
	}
	for (const candidate of candidates) {
		const family = familyInputModalities(candidate);
		if (family !== undefined) return family;
	}
	return ["text"];
}

/** Family-prefix fallback, ported from `AgentReasoningEffort.knownContextWindow` in the MacCLIProxyAPI app — used only when nothing more specific matched. Covers the live CPA roster's suffix shapes: date-stamped Claude ids (`claude-sonnet-4-5-20250929`), effort-suffixed Gemini ids, `grok-4.20-0309-*`, `-fast`/`-spark` variants. */
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

/** Some agent routes (observed: Gemini/Antigravity ids) bake the reasoning-effort tier into the model id itself rather than sending it as a separate wire field — strip one trailing tier so catalog/OpenRouter lookups match the base model. `extra-low` must precede `low` so `gemini-3.5-flash-extra-low` strips the full tier. */
const EFFORT_SUFFIX_RE = /-(none|minimal|extra-low|low|medium|high|xhigh|max|thinking)$/;
function stripEffortSuffix(lower) {
	const stripped = lower.replace(EFFORT_SUFFIX_RE, "");
	return stripped === lower ? undefined : stripped;
}

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const OPENROUTER_CACHE_MS = 6 * 60 * 60 * 1000;
const OPENROUTER_RETRY_MS = 60_000;
const OPENROUTER_TIMEOUT_MS = 5_000;
let openRouterCache;
let openRouterInFlight;

/**
 * OpenRouter's public model catalog (no auth required) as a live, broadly
 * maintained source of `context_length` per model — filling in ids the
 * bundled CPA snapshot and the family-prefix heuristic don't recognize.
 * Cached in memory: 6h on a successful fetch, 60s on failure/unreachable so
 * a transient network blip doesn't wedge the fallback for hours. This is
 * still someone else's *nominal* context-window claim, not a measurement of
 * this specific CPA deployment's actual entitlement — an explicit `models:`
 * catalog entry always wins over it (see `resolveContextWindow`).
 * @returns a lowercase-bare-id → context_length map (best effort; empty on failure).
 */
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
			// best-effort external lookup; resolveContextWindow falls further down the chain.
		}
		openRouterCache = { at: Date.now(), ttlMs, byId };
		openRouterInFlight = undefined;
		return byId;
	})();
	return openRouterInFlight;
}

/**
 * Full context-window resolution chain, in precedence order: (1) this
 * connection's own `models:` catalog override — the deployment operator's
 * explicit, verified truth, e.g. correcting a subscription tier that
 * doesn't actually get the nominal 1M some catalog claims; (2)
 * `KNOWN_MODEL_CONTEXT_WINDOWS` exact/dashed match (CPA's own bundled
 * per-model data); (3) OpenRouter's live catalog; (4) the family-prefix
 * heuristic; (5) `connection.defaultContextWindow`. Steps (2)-(4) each also
 * retry against the id with a trailing reasoning-effort tier stripped
 * (`stripEffortSuffix`) before moving to the next step, since routes like
 * Gemini/Antigravity observed here bake the tier into the id itself
 * (`gemini-3.6-flash-high`) rather than sending it as a wire field, and
 * neither the bundled table nor OpenRouter's catalog name that exact
 * suffixed id.
 */
async function resolveContextWindow(model, connection) {
	const configured = connection.models.find((entry) => entry.id === model);
	if (configured?.contextWindow !== undefined) return configured.contextWindow;
	const lower = model.toLowerCase();
	const stripped = stripEffortSuffix(lower);
	const candidates = stripped === undefined ? [lower] : [lower, stripped];
	for (const candidate of candidates) {
		const exact = KNOWN_MODEL_CONTEXT_WINDOWS[candidate] ?? KNOWN_MODEL_CONTEXT_WINDOWS_DASHED[candidate];
		if (exact !== undefined) return exact;
	}
	const openRouterMap = await openRouterContextWindows();
	for (const candidate of candidates) {
		const openRouter = openRouterMap.get(candidate);
		if (openRouter !== undefined) return openRouter;
	}
	for (const candidate of candidates) {
		const family = familyContextWindow(candidate);
		if (family !== undefined) return family;
	}
	return connection.defaultContextWindow;
}

/** Fetch the model ids CPA is currently serving (`GET /models`), advisory only. */
async function fetchLiveModelIds(connection, apiKey) {
	const response = await fetch(`${connection.baseURL}/models`, {
		headers: { authorization: `Bearer ${apiKey}`, "x-api-key": apiKey, ...attributionHeaders() },
		signal: AbortSignal.timeout(LIST_MODELS_TIMEOUT_MS),
	});
	if (!response.ok) throw new LlmError(`CPA /models returned HTTP ${response.status}`, httpErrorCode(response.status));
	const body = await response.json();
	const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : undefined;
	if (rows === undefined) throw new LlmError("CPA /models: unrecognized response shape", "MALFORMED_RESPONSE");
	return rows.map((row) => String(row.id ?? row.name ?? "").replace(/^models\//, "")).filter((id) => id.length > 0);
}

const REASONING_EFFORTS = [
	{ id: ReasoningEffortId("none"), name: "None" },
	{ id: ReasoningEffortId("minimal"), name: "Minimal" },
	{ id: ReasoningEffortId("low"), name: "Low" },
	{ id: ReasoningEffortId("medium"), name: "Medium" },
	{ id: ReasoningEffortId("high"), name: "High" },
	{ id: ReasoningEffortId("xhigh"), name: "X-High" },
	{ id: ReasoningEffortId("max"), name: "Max" },
];
const NONE_ONLY_REASONING_EFFORTS = [{ id: ReasoningEffortId("none"), name: "None" }];
const REASONING_EFFORT_ID_BY_NAME = Object.fromEntries(REASONING_EFFORTS.map((entry) => [String(entry.id), entry.id]));

function modelInfo(provider, model) {
	return {
		provider,
		id: model.id,
		name: model.name ?? model.id,
		...(model.description === undefined ? {} : { description: model.description }),
		inputModalities: resolveInputModalities(model.id),
	};
}

function providerRetryAfterMs(value) {
	if (value === null) return undefined;
	if (/^\d+$/.test(value)) {
		const delay = Number(value) * 1000;
		return Number.isFinite(delay) && delay > 0 ? delay : undefined;
	}
	const delay = Date.parse(value) - Date.now();
	return Number.isFinite(delay) && delay > 0 ? delay : undefined;
}

function requestId(headers) {
	const value = headers.get("x-request-id") ?? headers.get("x-deepseek-request-id");
	return value === null || value.length === 0 ? undefined : ProviderRequestId(value);
}

function httpErrorCode(status, error) {
	if (status === 401 || status === 403) return "AUTH";
	const detail = [error?.code, error?.type, error?.message].filter(Boolean).join(" ");
	if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE;
	if (status === 429) return "RATE_LIMIT";
	if (status === 400) {
		if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE;
		return "INVALID_REQUEST";
	}
	if (status >= 500) return "SERVER";
	return `HTTP_${status}`;
}

/**
 * One `LlmAdapter` instance serving every model routed through CPA. Connection
 * facts (baseURL, models catalog, the context cap the composer slider writes)
 * are resolved per request from the optional settings layer, not frozen at
 * load — see `apply` below.
 */
class CpaAdapter extends LlmAdapter {
	config;
	modelsCache;
	constructor(config) {
		super();
		this.config = config;
	}

	providerInfo(provider) {
		return { id: provider, name: "CPA" };
	}

	providerRetryPolicy(_provider) {
		return this.config.options().retryPolicy;
	}

	/**
	 * Discovers every model CPA is currently serving (`GET /models`), not
	 * just the static catalog — CPA routes to whatever subscription models
	 * are configured on its side (DeepSeek, Claude, GPT, Grok, ...) and that
	 * roster changes over time, so a fixed list would silently go stale.
	 * Cached briefly; falls back to the static catalog alone if CPA can't be
	 * reached (advisory only — resolveModel works for any id regardless).
	 *
	 * Live ids matching `excludeModelPrefixes` are hidden here unless a
	 * `models:` catalog entry explicitly names that exact id — the default
	 * `deepseek-` prefix exists because CPA's own DeepSeek route is just a
	 * proxy to `api.deepseek.com`, the same upstream dsh's built-in
	 * `deepseek-official` adapter already reaches directly; listing it again
	 * under "CPA" would just duplicate that entry in the `/model` picker for
	 * no benefit. This only hides discovery — resolveModel still resolves
	 * any id, filtered or not, if something requests it by name directly.
	 */
	async listModels(provider) {
		const connection = this.config.options();
		const now = Date.now();
		if (this.modelsCache !== undefined && now - this.modelsCache.at < LIST_MODELS_CACHE_MS) return this.modelsCache.value;
		let liveIds = [];
		try {
			const apiKey = await this.config.resolveApiKey(connection);
			liveIds = await fetchLiveModelIds(connection, apiKey);
		} catch {
			// advisory only — the static catalog (possibly empty) is still returned below.
		}
		const seen = new Set();
		const result = [];
		for (const id of liveIds) {
			if (seen.has(id)) continue;
			seen.add(id);
			const override = connection.models.find((entry) => entry.id === id);
			if (override === undefined && connection.excludeModelPrefixes.some((prefix) => id.toLowerCase().startsWith(prefix.toLowerCase()))) continue;
			result.push(modelInfo(provider, override ?? { id }));
		}
		for (const model of connection.models) {
			if (seen.has(model.id)) continue;
			seen.add(model.id);
			result.push(modelInfo(provider, model));
		}
		this.modelsCache = { at: now, value: result };
		return result;
	}

	/**
	 * Context window here is `min(contextCapTokens, model's real max)` — never
	 * above what the model actually supports, but capped further by the live
	 * setting the input-box slider controls. The real max comes from the
	 * static catalog when an entry overrides it, else `knownContextWindow`'s
	 * family heuristic, else `defaultContextWindow`. Since dsh-compaction-basic
	 * re-reads this on every pressure check (not cached at load), moving the
	 * slider retunes auto-compact immediately, no restart required.
	 */
	async resolveModel(provider, model, _signal) {
		const connection = this.config.options();
		const configured = connection.models.find((entry) => entry.id === model);
		const rawMax = await resolveContextWindow(model, connection);
		const contextWindow = Math.min(connection.contextCapTokens, rawMax);
		const defaultEffort = REASONING_EFFORT_ID_BY_NAME[connection.defaults.reasoningEffort] ?? REASONING_EFFORT_ID_BY_NAME.none;
		return {
			...(configured === undefined ? { provider, id: model, name: model, inputModalities: resolveInputModalities(model) } : modelInfo(provider, configured)),
			context: { contextWindow },
			defaultMaxTokens: configured?.maxTokens ?? connection.maxTokens,
			...(connection.defaults.thinking === "disabled"
				? { reasoning: { efforts: NONE_ONLY_REASONING_EFFORTS, defaultEffort: ReasoningEffortId("none") } }
				: { reasoning: { efforts: REASONING_EFFORTS, defaultEffort } }),
		};
	}

	async *stream(options) {
		const connection = this.config.options();
		const apiKey = await this.config.resolveApiKey(connection);
		const userId = this.config.resolveUserId();
		const containsImage = options.messages.some((message) => contentHasImage(message.content));
		if (containsImage && !resolveInputModalities(options.model).includes("image")) {
			throw new LlmError(`CPA model "${options.model}" does not support image input`, "UNSUPPORTED_CONTENT");
		}
		const attachments = containsImage ? this.config.resolveAttachments?.() : undefined;
		if (containsImage && attachments === undefined) {
			throw new LlmError("CPA image input requires the durable attachment service", "UNSUPPORTED_CONTENT");
		}
		const consumer = new AbortController();
		const watchdog = idleWatchdog(
			options.signal === undefined ? consumer.signal : AbortSignal.any([options.signal, consumer.signal]),
			connection.streamIdleTimeoutMs,
			STREAM_IDLE_TIMEOUT_CODE,
		);
		try {
			const iterator = this.request(options, watchdog.signal, connection, apiKey, userId, () => watchdog.pulse(), attachments)[Symbol.asyncIterator]();
			let exhausted = false;
			try {
				while (true) {
					const result = await watchdog.next(iterator);
					if (result.done) {
						exhausted = true;
						return;
					}
					yield result.value;
				}
			} catch (error) {
				if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
					throw new LlmError(`CPA stream idle timeout after ${connection.streamIdleTimeoutMs}ms`, "TIMEOUT", { cause: error });
				}
				if (options.signal?.aborted) throw new LlmError("CPA request aborted by caller", "ABORTED", { cause: error });
				if (error instanceof LlmError) throw error;
				throw new LlmError(`CPA request to ${connection.baseURL} failed`, "TRANSPORT", { cause: error });
			} finally {
				consumer.abort("CPA stream consumer stopped");
				if (!exhausted && iterator.return !== undefined) {
					try {
						await iterator.return();
					} catch {}
				}
			}
		} finally {
			watchdog[Symbol.dispose]();
		}
	}

	async *request(options, signal, connection, apiKey, userId, onComment, attachments) {
		const body = await serializeRequest(options, connection.defaults, attachments);
		const payload = JSON.stringify(body);
		const headers = {
			authorization: `Bearer ${apiKey}`,
			"x-api-key": apiKey,
			"content-type": "application/json",
			accept: "text/event-stream",
			...attributionHeaders(),
			"x-deepseek-harness-user-id": String(userId),
			...(options.sessionId !== undefined
				? {
						"x-deepseek-harness-session-id": String(options.sessionId),
						// CPA's generic session header (`ExtractSessionID` item 4).
						// It does not itself become `x-grok-conv-id` / Codex
						// `Session_id` / Antigravity `request.sessionId` — those
						// are rewritten from body `prompt_cache_key`.
						"X-Session-ID": String(options.sessionId),
					}
				: {}),
			...(options.purpose === "compaction" ? { "x-deepseek-harness-compact": "1" } : {}),
		};
		let response;
		try {
			response = await fetch(`${connection.baseURL}/responses`, { method: "POST", headers, body: payload, signal });
		} catch (error) {
			if (signal.aborted) throw error;
			throw new LlmError(`CPA request to ${connection.baseURL} failed`, "TRANSPORT", { cause: error });
		}
		if (!response.ok) {
			let message = `CPA request error (HTTP ${response.status})`;
			let providerError;
			try {
				providerError = (await response.json()).error;
				if (providerError?.message) message = providerError.message;
			} catch {}
			const delay = providerRetryAfterMs(response.headers.get("retry-after"));
			const id = requestId(response.headers);
			throw new LlmError(message, httpErrorCode(response.status, providerError), {
				status: response.status,
				...(delay === undefined ? {} : { providerRetryAfterMs: delay }),
				...(id === undefined ? {} : { requestId: id }),
			});
		}
		if (!response.body) throw new LlmError("CPA returned no response body", "EMPTY_RESPONSE");
		yield* translate(parseSse(response.body, onComment));
	}
}

// ---------------------------------------------------------------------------
// Plugin registration
// ---------------------------------------------------------------------------

export const name = "llm-cpa";
export const inject = ["llm"];

const NS = "llm-cpa";
const DEFAULT_API_KEY_ENV = "CPA_API_KEY";
const PROVIDER = "cpa";
const BASE_URL_ENV = "CPA_BASE_URL";
const DEFAULT_BASE_URL = "http://127.0.0.1:8317/v1";

/** Empty by default: `listModels`/`resolveModel` discover CPA's live catalog and estimate context windows via `knownContextWindow`. Add entries here only to override a specific model's name/context/max-tokens. */
const DEFAULT_MODELS = [];
/** CPA's DeepSeek route is a proxy to the same api.deepseek.com dsh's built-in `deepseek-official` adapter already reaches directly — hide it from discovery by default; use `deepseek-official` for DeepSeek instead. */
const DEFAULT_EXCLUDE_MODEL_PREFIXES = ["deepseek-"];

const catalogModel = z.object({
	id: z.string().required(),
	name: z.string(),
	description: z.string(),
	contextWindow: z.number().step(1).min(1),
	maxTokens: z.number().step(1).min(1),
});

/**
 * `contextCapTokens` is the field the composer slider reads and writes live
 * (through `settings.installSection` below): it never raises a model above its
 * own real max (catalog override, else `knownContextWindow`, else
 * `defaultContextWindow`), only lowers the effective ceiling used for
 * auto-compact math. `sliderMaxTokens` is a separate, purely cosmetic bound —
 * the composer slider's rightmost drag position — independent of whichever
 * model happens to be selected; the actual per-model safety clamp always
 * happens in `resolveModel`, not in the UI.
 */
export const Config = z.object({
	apiKeyEnv: z.string().role("credential-ref").default(DEFAULT_API_KEY_ENV),
	baseURL: z.string().default(DEFAULT_BASE_URL),
	thinking: z.union(["enabled", "disabled"]).default("enabled"),
	reasoningEffort: z.union(REASONING_EFFORT_IDS).default("medium"),
	maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS),
	defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
	contextCapTokens: z.number().step(1).min(65536).default(DEFAULT_CONTEXT_CAP),
	sliderMaxTokens: z.number().step(1).min(65536).default(DEFAULT_CONTEXT_CAP),
	models: z.array(catalogModel).default(DEFAULT_MODELS),
	excludeModelPrefixes: z.array(z.string()).default(DEFAULT_EXCLUDE_MODEL_PREFIXES),
	streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
	retryPolicy: RetryPolicySchema,
});

function resolveModels(models) {
	const seen = new Set();
	return (models ?? DEFAULT_MODELS).map((model) => {
		if (model.id.length === 0) throw new Error("llm-cpa: catalog model ids must be non-empty");
		if (model.name !== undefined && model.name.length === 0) throw new Error(`llm-cpa: catalog model "${model.id}" has an empty name`);
		if (model.contextWindow !== undefined && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) {
			throw new Error(`llm-cpa: catalog model "${model.id}" contextWindow must be a positive integer`);
		}
		if (model.maxTokens !== undefined && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) {
			throw new Error(`llm-cpa: catalog model "${model.id}" maxTokens must be a positive integer`);
		}
		if (seen.has(model.id)) throw new Error(`llm-cpa: duplicate catalog model "${model.id}"`);
		seen.add(model.id);
		return {
			id: model.id,
			...(model.name === undefined ? {} : { name: model.name }),
			...(model.description === undefined ? {} : { description: model.description }),
			...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
			...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
		};
	});
}

function resolveAdapterOptions(config, environment) {
	if (config.thinking === "disabled" && config.reasoningEffort !== undefined && config.reasoningEffort !== "none") {
		throw new Error('llm-cpa: only reasoningEffort "none" can be configured when thinking is disabled');
	}
	if (config.defaultContextWindow !== undefined && (!Number.isInteger(config.defaultContextWindow) || config.defaultContextWindow <= 0)) {
		throw new Error("llm-cpa: defaultContextWindow must be a positive integer");
	}
	if (config.contextCapTokens !== undefined && (!Number.isInteger(config.contextCapTokens) || config.contextCapTokens <= 0)) {
		throw new Error("llm-cpa: contextCapTokens must be a positive integer");
	}
	if (config.sliderMaxTokens !== undefined && (!Number.isInteger(config.sliderMaxTokens) || config.sliderMaxTokens <= 0)) {
		throw new Error("llm-cpa: sliderMaxTokens must be a positive integer");
	}
	if (config.maxTokens !== undefined && (!Number.isSafeInteger(config.maxTokens) || config.maxTokens <= 0)) {
		throw new Error("llm-cpa: maxTokens must be a positive safe integer");
	}
	const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
	if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0 || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
		throw new Error(`llm-cpa: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
	}
	return {
		apiKeyEnv: credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV),
		baseURL: config.baseURL ?? environment?.get(BASE_URL_ENV)?.value ?? DEFAULT_BASE_URL,
		defaults: { thinking: config.thinking, reasoningEffort: config.reasoningEffort },
		maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
		defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
		contextCapTokens: config.contextCapTokens ?? DEFAULT_CONTEXT_CAP,
		sliderMaxTokens: config.sliderMaxTokens ?? DEFAULT_CONTEXT_CAP,
		models: resolveModels(config.models),
		excludeModelPrefixes: config.excludeModelPrefixes ?? DEFAULT_EXCLUDE_MODEL_PREFIXES,
		streamIdleTimeoutMs,
		retryPolicy: resolveRetryPolicy(config.retryPolicy, "llm-cpa: retryPolicy"),
	};
}

export function apply(ctx, config) {
	let current = () => config;
	let lastRaw;
	let lastGood;
	const options = () => {
		const raw = current();
		if (raw === lastRaw && lastGood !== undefined) return lastGood;
		try {
			const next = resolveAdapterOptions(raw, launchEnvironmentOf(ctx));
			lastRaw = raw;
			lastGood = next;
			return next;
		} catch (error) {
			if (lastGood === undefined) throw error;
			lastRaw = raw;
			ctx.logger.error("llm-cpa: keeping the last good configuration after an invalid settings section");
			ctx.logger.error(error);
			return lastGood;
		}
	};
	options();

	const resolveApiKey = async (connection) => {
		const ref = connection.apiKeyEnv;
		const credentials = ctx.get("credentials");
		if (credentials !== undefined) {
			const hit = await credentials.resolve(ref);
			if (hit !== undefined) return assertUsableApiKey(hit.value, "llm-cpa", ref);
		} else {
			const ambient = launchEnvironmentOf(ctx).get(ref);
			if (ambient !== undefined && ambient.value.length > 0) return assertUsableApiKey(ambient.value, "llm-cpa", ref);
		}
		throw new LlmError(
			`llm-cpa: no API key for provider route "${PROVIDER}"; store ${ref} through the credentials service (the web Models page writes it), or export ${ref} in the launching environment`,
			"MISSING_CREDENTIAL",
		);
	};

	let userId;
	const resolveUserId = () => (userId ??= getOrCreateAnonymousUserId());
	const adapter = new CpaAdapter({ options, resolveApiKey, resolveUserId, resolveAttachments: () => ctx.get("attachments") });

	ctx.llm.registerConfigurableProviders([{ provider: PROVIDER, displayName: "CPA", settingsNs: NS, settingsPath: [] }]);
	const registration = ctx.llm.registerAdapter([PROVIDER], adapter);

	let registeredPolicy = options().retryPolicy;
	const ensureRegistrationFacts = () => {
		const policy = options().retryPolicy;
		if (deepEqualJson(policy, registeredPolicy)) return;
		registration.replace([PROVIDER]);
		registeredPolicy = policy;
	};

	ctx.inject(["settings"], (settingsCtx) => {
		settingsCtx.settings.installSection(ctx, NS, Config, config, {
			setSource: (source) => {
				current = source;
			},
			onChange: ensureRegistrationFacts,
		});
	});
}
