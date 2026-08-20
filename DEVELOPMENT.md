# Development notes

Implementation rationale for `dsh-cpa-plugin`. See [README.md](README.md) for
install/usage; this file is for anyone editing the plugin itself.

## Package layout

Two halves, one package:

- **Server** (`lib/index.js`): an `LlmAdapter` (`export const name =
  "llm-cpa"`) registered on `ctx.llm` for provider route `"cpa"`.
- **Client** (`lib/client.js`): registers the "Ctx" pill + popup panel into
  the composer's tool row.

No build step — hand-authored ESM, no bundler. `deploy.sh` just copies
`package.json`, `lib/index.js`, and `lib/client.js` into a profile's
`node_modules`.

## Server (`lib/index.js`)

### Wire protocol: OpenAI Responses, not chat completions

Talks OpenAI Responses (`POST /v1/responses`) to CPA's local endpoint so CPA
classifies the call as `FormatOpenAIResponse` — the same ingress Codex App
uses, which is what turns on xAI encrypted-reasoning replay. Chat completions
leaves Grok on `FormatOpenAI`, which does not replay encrypted reasoning.
Thinking effort (`none/minimal/low/medium/high/xhigh/max`) is sent as
`reasoning.effort` / `reasoning.summary`.

### Model discovery

`listModels()` discovers CPA's *entire* live catalog (`GET /models`) — not
one hardcoded model — filtering out `deepseek-*` by default (CPA's DeepSeek
route just proxies to `api.deepseek.com`, the same upstream dsh's built-in
`deepseek-official` adapter already reaches directly, so listing it again
here would just duplicate the `/model` picker entry for no benefit).

### Context-window resolution chain

Per-model context windows come from a layered lookup, in order:

1. this connection's own `models:` catalog override,
2. an exact table (`KNOWN_MODEL_CONTEXT_WINDOWS`) decoded from CPA's own
   bundled catalog (`App/Resources/tencent_models.json`),
3. OpenRouter's public model catalog (live, cached 6h on success / 60s on
   failure),
4. a family-prefix heuristic (`familyContextWindow()`) ported from CPA's own
   Swift code (`AgentReasoningEffort.knownContextWindow`),
5. `connection.defaultContextWindow`.

None of these are a live "ask CPA how big this model's context is" call —
CPA doesn't expose that — so treat the first three as *nominal* claims from
someone else's catalog, not a measurement of a specific account's actual
entitlement. Steps 2–4 each also retry against the model id with a trailing
reasoning-effort tier stripped (`stripEffortSuffix`), since routes like
Gemini/Antigravity bake the tier into the id itself
(`gemini-3.6-flash-high`) rather than sending it as a wire field.

### Input modalities

`inputModalities` on `listModels`/`resolveModel` comes from a **static**
per-model table (`KNOWN_MODEL_INPUT_MODALITIES`) snapshotted from
OpenRouter's catalog (2026-08-19: Claude/GPT/Grok are `text+image+file`,
Gemini adds `video+audio+file`, Kimi/MiniMax/GLM-vision add `image`/`video`)
with a family-prefix fallback (`familyInputModalities()`) — deliberately not
a live fetch, since modalities rarely change. Re-run the probe described
inline in the source if CPA or OpenRouter ship models not covered here.

### Image input

User messages and tool results carrying an `image` content block are
serialized to Responses `input_image` parts
(`{type:"input_image", detail:"auto", image_url:"data:<mime>;base64,..."}`),
resolved through the durable attachment service (`ctx.attachments`,
`readImage(ref)` → bytes). This mirrors the wire shape CPA's own
Codex-ingress conversion produces for the same `FormatOpenAIResponse` target
(`convertToolResultOutput` in `@earendil-works/pi-ai`'s
`openai-responses-shared.js`, and `dsh-llm-pi-ai`'s own `userContent()`
helper, both bundled elsewhere in a dsh install).

`CpaAdapter.stream()` does a single up-front check: if any message carries
an image, it 1) confirms the target model's `inputModalities` includes
`"image"` (else throws `UNSUPPORTED_CONTENT` naming the model), then 2)
resolves `ctx.attachments` (else throws — the service isn't wired into every
profile). Everything downstream (`serializeInput`, `serializeUserContent`,
`serializeToolResultOutput`) assumes both checks already passed. Assistant
and system messages carrying an image still throw unconditionally — dsh's
own content model documents assistant output as text-only today
(`ImageBlock` in `@deepseek-ai/dsh-llm`'s types: "current production
adapters declare text-only output, so only user content carries images
today").

### Prompt cache / reasoning replay

Requests carrying a dsh `sessionId` send one CPA session header
(`X-Session-ID`) plus body `prompt_cache_key`. CPA maps that body field onto
each upstream cache key (`x-grok-conv-id` for xAI, `Session_id` for Codex).
Switching the plugin from chat completions to Responses is what lets CPA
replay Grok's encrypted reasoning on later turns.

**`promptCacheKey()` isolates non-conversation calls.** dsh issues auxiliary
LLM calls — session-title generation (`purpose: "session-title"`,
see `dsh-session-title-llm`) and compaction summaries (`purpose:
"compaction"`, see `dsh-compaction-basic`) — that reuse the *same*
`sessionId` as the main conversation but send an unrelated, much shorter
message array. `dsh-session-title-llm` in particular passes
`sessionId: request.session.id` verbatim with no isolation of its own
(confirmed by reading its source directly — this is not something
documented as configurable). Left alone, that collides with the main
conversation's `prompt_cache_key`, and — because CPA's per-session cache
slot on the upstream side stores whatever the *last* request under that key
looked like — a single title-generation call can silently clobber the main
conversation's cached prefix, causing the next real turn to miss entirely.
`promptCacheKey()` suffixes these calls (`:title` / `:compact`) so they get
their own upstream cache slot instead of stomping the conversation's. Title
calls also skip `include: ["reasoning.encrypted_content"]` — they run with
thinking forced off (see `resolveThinking()`), so requesting a reasoning
replay for them is meaningless.

This was diagnosed from a real CPA request-cache trace: alternating
near-100%-hit and near-0%-hit turns within a *single* dsh session, with no
correlation to elapsed time or turn/step boundaries — the signature of two
logically distinct conversations sharing one upstream cache key, not a
routing or TTL issue in CPA itself. Read `xai_executor_request.go` /
`xai_reasoning_replay.go` in the `cli-proxy-api` core source
(the Go binary CPA's Mac app wraps) for the upstream side of this: session
id derivation (`xaiExecutionSessionID`) reads `prompt_cache_key` straight
from the request body and is otherwise deterministic, so the fix belongs on
the client (this plugin) side, not CPA's.

Antigravity *does* report cache hits
(`cachedContentTokenCount` → `prompt_tokens_details.cached_tokens`); a
persistent 0 there is a real miss — its translator never copies a client
session into `request.sessionId`, so nothing this plugin does can fix that
path.

### Why the slider actually moves auto-compact

`dsh-compaction-basic` re-reads `ctx.llm.resolveModelInfo(provider, model)`
fresh on every pressure check — it never caches `contextWindow` at load —
and computes its compact threshold as `contextWindow × thresholdRatio`
(default 0.8). Since `resolveModel()` returns `min(contextCapTokens, model's
real max)`, dragging the slider retunes the auto-compact trigger point
immediately, without restarting `dsh` or touching the compaction plugin at
all.

## Client (`lib/client.js`)

Registers a trigger pill + popup panel into the `conversation.input.right`
slot — the composer's tool row, beside the Model/Effort seat, where the
framework's own `ContextMeter` ring already lives. Deliberately *not*
`conversation.composer.dock` (the band under the card, tried first): that
slot only renders once a session has an actual message in it, staying
hidden through the whole pre-first-message "hero" screen, so a control
placed there is invisible exactly when you're most likely to want to set
the cap. `conversation.input.right` renders from the first paint, matches
the visual language of the framework's own controls (same `--dsw-*` theme
tokens, same click-toggle / outside-click / Escape panel behavior as
`ContextMeter`, panel opens upward via `bottom: calc(100% + 8px)`), and
holds a *discrete* slider — a plain `<input type="range">` driven by an
index into the fixed `[64K, 256K, 512K, 1M]` ladder, not a continuous drag
with an arbitrary token value.

The drag range's own ceiling is `min(sliderMaxTokens, current model's real
max)` — not just `sliderMaxTokens`. The control reads the composer's actual
current selection through `ctx.modelDirectories` (the same session service
`dsh-client-ui-model-selection`'s own Model/Effort seat uses, subscribed
live via `useSyncExternalStore` so it re-resolves the instant you switch
models) and, when that selection is one of this provider's models, resolves
its real max with a client-side mirror of `resolveContextWindow()` (bundled
CPA table → OpenRouter → family heuristic → fallback — see
`resolveModelMax` in `lib/client.js`). Picking a 272k-max `gpt-5.x` model
now visibly removes the 512K/1M rungs instead of letting you drag to a
value the server then silently downgrades. `models:` overrides are read
from the same live settings call the panel already makes. Falls back to the
plain `sliderMaxTokens` ceiling when no CPA model is selected, or while
`dsh-client-ui-model-selection` isn't available in a profile.

Selecting a tick writes `contextCapTokens` and locks the slider until that
write confirms, so a rapid drag cannot queue overlapping mutates. The
adapter's `resolveModel()` reads the stored cap on every call and returns
`min(contextCapTokens, model's real max)` as the model's context window, so
it can never exceed what the model actually supports.

## Why `deploy.sh` copies instead of symlinking

Do **not** use `dsh plugin --profile web add <path>` for this package — that
runs `pnpm add file:...`, which pnpm records as a `link:` (symlink)
dependency living *outside* `~/.dsh/`. dsh resolves its framework packages
(`@deepseek-ai/dsh-llm`, `dsh-settings`, `schemastery`, ...) by walking *up*
the real (symlink-dereferenced) directory tree from wherever a package
physically lives until it hits the shared `~/.dsh/profiles/node_modules`
fallback (`healProfilesModuleFallback` in `dsh-app-boot`). A package
symlinked in from outside `~/.dsh/` never reaches that fallback, so
`@deepseek-ai/dsh-llm` fails to resolve — and worse, if you route around
that by giving the plugin its *own* copy of `dsh-llm` (e.g. `npm install`
inside this repo), you get a second, distinct `LlmError`/`ReasoningEffortId`
module instance that `dsh-agent-loop`'s `error instanceof LlmError` checks
silently fail against, breaking error classification (auth/rate-limit/
context-window handling) without breaking the happy path — the kind of bug
that only shows up later.

`deploy.sh` instead copies this package's real files straight into
`~/.dsh/profiles/<profile>/node_modules/dsh-cpa-plugin/`, a location the
ancestor-walk resolves correctly, verified end to end against a real CPA
round trip while building this.

## Known simplifications

- The slider's per-model drag-range narrowing couples to
  `dsh-client-ui-model-selection`'s `modelDirectories` service, which isn't
  that package's documented public contract — just what its code does
  today. If a future `dsh` update changes or removes that service, the
  control falls back to the plain `sliderMaxTokens` ceiling (same as before
  this coupling existed) rather than breaking outright, but the per-model
  narrowing would silently stop.
- `KNOWN_MODEL_CONTEXT_WINDOWS` and `familyContextWindow()` are duplicated
  between `lib/index.js` (server, authoritative — what actually gets sent
  over the wire and what compaction math uses) and `lib/client.js` (a
  mirror, used only to size the slider's drag range). Keep them in sync by
  hand; drift between the two only ever makes the *display* wrong, never
  the actual enforced value, since the server's `resolveModel()` clamp is
  independent and always wins.
- Reasoning effort values (`none…max`) are sent as Responses
  `reasoning.effort` (plus `reasoning.summary: "auto"` when thinking is on)
  to *every* model this adapter resolves, uniformly. CPA's thinking layer
  then maps that onto each upstream leg. If a specific model behind CPA
  rejects the field, that's a gap in this simplification — per-model
  handling isn't implemented.
- Tool-result images are only forwarded when `contentHasImage()` finds one
  in that specific result's content; there's no recursive walk beyond one
  level of nested `tool-result` blocks (matches the depth `flattenText()`
  already assumed before image support existed).
