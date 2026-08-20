# dsh-cpa-plugin

A `dsh` (DeepSeek Harness) plugin that routes models through **CPA**
(MacCLIProxyAPI), your local unified subscription-model endpoint, and adds a
"Ctx" pill in the composer's tool row — click it and a small panel pops up
(same upward-opening pattern as the Model/Effort picker and the built-in
ContextMeter beside it) with a slider that live-controls auto-compact — no
`dsh` restart needed to move it.

Two halves, one package:

- **Server** (`lib/index.js`): an `LlmAdapter` (`export const name = "llm-cpa"`)
  registered on `ctx.llm` for provider route `"cpa"`. Talks OpenAI Responses
  (`POST /v1/responses`) to CPA's local endpoint (`http://127.0.0.1:8317/v1`
  by default) so CPA classifies the call as `FormatOpenAIResponse` — the same
  ingress Codex App uses, which is what turns on xAI encrypted-reasoning
  replay. Thinking effort (`none/minimal/low/medium/high/xhigh/max`) is sent
  as `reasoning.effort` / `reasoning.summary`. `listModels()` discovers CPA's
  *entire* live catalog (`GET /models`) — not one hardcoded model — filtering
  out `deepseek-*` by default
  (CPA's DeepSeek route just proxies to `api.deepseek.com`, the same upstream
  dsh's built-in `deepseek-official` adapter already reaches directly, so
  listing it again here would just duplicate the `/model` picker entry for no
  benefit; use `deepseek-official` for DeepSeek). Per-model context windows
  come from a layered lookup, in order: your own `models:` catalog override →
  an exact table decoded from CPA's own bundled catalog
  (`App/Resources/tencent_models.json`) → OpenRouter's public model catalog
  (live, cached) → a family-prefix heuristic ported from CPA's own Swift code
  → `defaultContextWindow`. None of these are a live "ask CPA how big this
  model's context is" call — CPA doesn't expose that — so treat the first
  three as *nominal* claims from someone else's catalog, not a measurement of
  your specific account's actual entitlement; override the ones that turn out
  wrong in `models:` (already done for this deployment's `gpt-5.x` models,
  which don't get the 1M several sources claim — see the config below).
  Input modalities (`inputModalities` on `listModels`/`resolveModel`) come
  from a **static** per-model table snapshotted from OpenRouter's catalog
  (2026-08-19: Claude/GPT/Grok are `text+image+file`, Gemini adds
  `video+audio+file`, Kimi/MiniMax/GLM-vision add `image`/`video`) with a
  family-prefix fallback — deliberately not a live fetch, modalities rarely
  change. Requests carrying a dsh `sessionId` send one CPA session header
  (`X-Session-ID`) plus body `prompt_cache_key` with the same value. CPA
  maps that body field onto each upstream cache key (`x-grok-conv-id` for
  xAI, `Session_id` for Codex). Session-title and compaction calls get a
  suffixed key (`:title` / `:compact`) so they cannot overwrite the
  conversation's Grok conv-id or CPA's encrypted-reasoning replay cache.
  Switching the plugin from chat completions to Responses is what lets CPA
  replay Grok's encrypted reasoning on later turns; Antigravity *does*
  report cache hits
  (`cachedContentTokenCount` → `prompt_tokens_details.cached_tokens`); a
  persistent 0 is a real miss — its translator never copies a client
  session into `request.sessionId`.
- **Client** (`lib/client.js`): registers a trigger pill + popup panel into
  the `conversation.input.right` slot — the composer's tool row, beside the
  Model/Effort seat, where the framework's own `ContextMeter` ring already
  lives. Deliberately *not* `conversation.composer.dock` (the band under the
  card, tried first): that slot only renders once a session has an actual
  message in it, staying hidden through the whole pre-first-message "hero"
  screen, so a control placed there is invisible exactly when you're most
  likely to want to set the cap. `conversation.input.right` renders from the
  first paint, matches the visual language of the framework's own controls
  (same `--dsw-*` theme tokens, same click-toggle / outside-click / Escape
  panel behavior as `ContextMeter`, panel opens upward via `bottom: calc(100%
  + 8px)`), and holds a *discrete* slider — a plain `<input type="range">`
  driven by an index into the fixed `[64K, 256K, 512K, 1M]` ladder, not a
  continuous drag with an arbitrary token value; it only ever lands exactly
  on one of the labeled rungs shown under the track.

  The drag range's own ceiling is `min(sliderMaxTokens, current model's real
  max)` — not just `sliderMaxTokens`. The control reads the composer's
  actual current selection through `ctx.modelDirectories` (the same session
  service `dsh-client-ui-model-selection`'s own Model/Effort seat uses,
  subscribed live via `useSyncExternalStore` so it re-resolves the instant
  you switch models) and, when that selection is one of this provider's
  models, resolves its real max with a client-side mirror of
  `resolveContextWindow()` (bundled CPA table → OpenRouter → family
  heuristic → fallback — see `resolveModelMax` in `lib/client.js`). Picking a
  272k-max `gpt-5.x` model now visibly removes the 512K/1M rungs instead of
  letting you drag to a value the server then silently downgrades. `models:`
  overrides are read from the same live settings call the panel already
  makes, so an override takes effect without any extra plumbing. Falls back
  to the plain `sliderMaxTokens` ceiling when no CPA model is selected, or
  while `dsh-client-ui-model-selection` isn't available in a profile.

  Selecting a tick writes `contextCapTokens` and locks the slider until
  that write confirms, so a rapid drag cannot queue overlapping mutates.
  The adapter's `resolveModel()` reads the stored cap on every call and
  returns `min(contextCapTokens, model's real max)` as the model's
  context window, so it can never exceed what the model actually supports.

## Why the slider actually moves auto-compact

`dsh-compaction-basic` re-reads `ctx.llm.resolveModelInfo(provider, model)`
fresh on every pressure check — it never caches `contextWindow` at load — and
computes its compact threshold as `contextWindow × thresholdRatio` (default
0.8). Since our adapter's `resolveModel()` returns the capped value, dragging
the slider retunes the auto-compact trigger point immediately, without
restarting `dsh` or touching the compaction plugin at all.

## Install

1. **Deploy the plugin package** into your `web` profile:

   ```sh
   ./deploy.sh web
   ```

   Do **not** use `dsh plugin --profile web add <path>` for this package —
   that runs `pnpm add file:...`, which pnpm records as a `link:` (symlink)
   dependency living *outside* `~/.dsh/`. dsh resolves its framework packages
   (`@deepseek-ai/dsh-llm`, `dsh-settings`, `schemastery`, ...) by walking
   *up* the real (symlink-dereferenced) directory tree from wherever a
   package physically lives until it hits the shared
   `~/.dsh/profiles/node_modules` fallback (`healProfilesModuleFallback` in
   `dsh-app-boot`). A package symlinked in from outside `~/.dsh/` never
   reaches that fallback, so `@deepseek-ai/dsh-llm` fails to resolve — and
   worse, if you route around that by giving the plugin its *own* copy of
   `dsh-llm` (e.g. `npm install` inside this repo), you get a second,
   distinct `LlmError`/`ReasoningEffortId` module instance that
   `dsh-agent-loop`'s `error instanceof LlmError` checks silently fail
   against, breaking error classification (auth/rate-limit/context-window
   handling) without breaking the happy path — the kind of bug that only
   shows up later. `deploy.sh` instead copies this package's real files
   straight into `~/.dsh/profiles/<profile>/node_modules/dsh-cpa-plugin/`, a
   location the ancestor-walk resolves correctly, verified end to end
   against a real CPA round trip while building this. Re-run `./deploy.sh
   web` after every edit here (no build step — it's hand-authored ESM, no
   bundler); it's a copy, not a symlink, so edits in this repo aren't picked
   up automatically.

2. **Activate it** by adding an entry to
   `~/.dsh/profiles/web/cordis.patch.yml` (currently an empty `[]` — replace
   its contents with the array below, or add to it if you've since patched
   other things):

   ```yaml
   - insert:
       - id: llm-cpa
         name: dsh-cpa-plugin
         config:
           baseURL: http://127.0.0.1:8317/v1
           apiKeyEnv: CPA_API_KEY
           thinking: enabled
           reasoningEffort: medium
           contextCapTokens: 1000000
           sliderMaxTokens: 1000000
           # Fallback when no catalog entry, bundled-table match, OpenRouter
           # hit, or family-prefix heuristic applies — not a global ceiling.
           defaultContextWindow: 128000
           # excludeModelPrefixes defaults to ["deepseek-"]; omit unless you
           # want to change it.
           #
           # Explicit per-model overrides win over every other source. Add
           # one whenever a catalog/heuristic number turns out wrong for
           # your actual account (see README "known simplifications").
           models:
             - id: gpt-5.5
               contextWindow: 272000
   # dsh-web-app ships compaction disabled by default — turn it on so the
   # context cap has something to drive:
   - id: compaction-basic
     disabled: false
   - id: command-compact
     disabled: false
   ```

   `models:` entries are overrides, not an allowlist — `listModels()`
   discovers CPA's full live catalog on its own (`curl -H "Authorization:
   Bearer $KEY" http://127.0.0.1:8317/v1/models` shows the same list). Only
   add an entry when a specific id's auto-resolved context window is wrong.

3. **Provide the API key.** CPA's home screen shows a generated API key
   (also at `~/Library/Application Support/com.maccliproxyapi/api-keys.json`).
   The `web` profile has `dsh-credentials-local` active, which checks its
   managed store *before* falling back to the environment — so a plain
   `export CPA_API_KEY=...` before launching is **not** enough here. Either:

   - open dsh's web UI → Settings → Models → "CPA" (it appears automatically
     because the plugin calls `registerConfigurableProviders`) → paste the
     key there, or
   - add a `CPA_API_KEY: sk-...` line directly to `~/.dsh/.credentials.yaml`
     (a flat `ref: value` YAML map — this is the exact file the Models page
     writes to).

4. **Restart `dsh web`.** The profile's `hmr` entry is disabled by default,
   so `cordis.patch.yml` edits and a redeployed plugin both need a fresh
   process (`Ctrl+C`, then `dsh web` again) to take effect.

5. Open the web UI, pick the "CPA" provider / any model from the `/model`
   picker (e.g. `gpt-5.5`, `claude-sonnet-5` — `deepseek-*` is filtered out by
   default, see below), and confirm a "Ctx ..." pill appears in the composer's
   tool row, beside the model seat — click it for the slider panel.

### Status in this environment

Steps 1–3 are already done against your real `~/.dsh/profiles/web`: the
plugin is deployed, `cordis.patch.yml` has the `llm-cpa` entry (DeepSeek
filtered, `gpt-5.x` pinned to 272k per your account) plus compaction enabled,
and `CPA_API_KEY` is stored in `~/.dsh/.credentials.yaml`.

The **server** adapter — live model discovery (54 models beyond the DeepSeek
filter), the layered context-window resolution including a real OpenRouter
round trip, and a real streamed chat completion through CPA →
DeepSeek-V4-Flash — was verified end to end in an isolated scratch profile
(deleted again afterward so it wouldn't linger).

The **client** pill+panel (`conversation.input.right`) was built and revised
against your screenshots but reviewed against the framework's real source,
not click-tested in a running browser — this environment has no browser
access. First restart is the real test; if the pill doesn't show or the
panel looks off, send another screenshot and it's a quick fix from there.

## Notes / known simplifications

- The slider's drag range narrows to the currently-selected model's real max
  (via `ctx.modelDirectories` + a client-side mirror of
  `resolveContextWindow()`), but couples to `dsh-client-ui-model-selection`'s
  `modelDirectories` service, which isn't that package's documented public
  contract — just what its code does today. If a future `dsh` update
  changes or removes that service, the control falls back to the plain
  `sliderMaxTokens` ceiling (same as before this coupling existed) rather
  than breaking outright, but the per-model narrowing would silently stop.
- `KNOWN_MODEL_CONTEXT_WINDOWS` and `familyContextWindow()` are duplicated
  between `lib/index.js` (server, authoritative — what actually gets sent
  over the wire and what compaction math uses) and `lib/client.js` (a mirror,
  used only to size the slider's drag range). Keep them in sync by hand;
  drift between the two only ever makes the *display* wrong, never the
  actual enforced value, since the server's `resolveModel()` clamp is
  independent and always wins.
- `contextCapTokens` is one global cap shared by every model this provider
  serves, not per-model — moving the slider affects all of them together
  (the *ceiling* the slider can reach is now per-model; the cap value it
  writes is still global).
- None of the three context-window data sources (bundled CPA snapshot,
  OpenRouter, family-prefix heuristic) reflect *your account's actual
  entitlement* — they're all someone else's nominal claim about a model
  family. Verify against real behavior and add a `models:` override when
  they're wrong, the way this deployment's `gpt-5.x` entries already are.
- Reasoning effort values (`none…max`) are sent as Responses
  `reasoning.effort` (plus `reasoning.summary: "auto"` when thinking is on)
  to *every* model this adapter resolves. CPA's thinking layer then maps
  that onto each upstream leg. If a specific model behind CPA rejects the
  field, that's a gap in this simplification — per-model handling isn't
  implemented.

## Security note

While wiring this up, `~/Library/Application Support/com.maccliproxyapi/provider-secrets.json`
was found to hold CPA's **upstream** DeepSeek API key in plaintext (separate
from the local `api-keys.json` client key used above). That's expected for
how CPA works locally, but don't commit or paste that file's contents
anywhere.
