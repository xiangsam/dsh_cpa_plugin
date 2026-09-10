# @xiangsam/dsh-cpa-plugin

A `dsh` (DeepSeek Harness) plugin that routes models through **CPA**
(MacCLIProxyAPI), your local unified subscription-model endpoint. It adds:

- A **"CPA" model provider** in dsh's `/model` picker, listing whatever
  subscription models your CPA install currently serves (Claude, GPT, Grok,
  Gemini, DeepSeek, and more), with working image input, 7-level thinking
  effort, and correct prompt-cache behavior on multi-turn conversations.
- A **"Ctx" pill** in the composer's tool row, next to the Model/Effort
  picker — click it for a slider that live-controls the context cap driving
  auto-compact, no `dsh` restart needed to move it.

## Compatibility

Works with `dsh` **0.1.5-alpha.2** (verified) and 0.1.1-rc.x. The
0.1.5-alpha migration touched only the host face: settings registration now
goes through `ctx.inject(["settings"])` + `settings.installSection`,
`deepEqualJson` moved to `@deepseek-ai/dsh-util-values`, the tool-call brand
is `ToolCallId`, and inline images read through
`attachments.readImageRequest(ref, policy)` with a route-owned budget (20 MB
bytes / 8 M pixels). The deploy/activate flow below is unchanged.

## Install

The package is published to GitHub Packages as `@xiangsam/dsh-cpa-plugin`.
Installing from the registry needs authentication, so log in once first
(password: a PAT with `read:packages`) and map the scope:

```sh
npm login --registry=https://npm.pkg.github.com
npm config set @xiangsam:registry https://npm.pkg.github.com
```

Then either let dsh install it into the profile, or use the copy deploy
below when you are editing this checkout:

```sh
dsh plugin --profile web add "@xiangsam/dsh-cpa-plugin@0.1.0"
```

1. **Deploy the plugin package** into your `web` profile:

   ```sh
   ./deploy.sh web
   ```

   This copies the plugin's files into
   `~/.dsh/profiles/web/node_modules/@xiangsam/dsh-cpa-plugin/`. Don't use
   `dsh plugin --profile web add <path>` for this package — see
   [DEVELOPMENT.md](DEVELOPMENT.md#why-deploysh-copies-instead-of-symlinking)
   for why. Re-run `./deploy.sh web` after every edit — it's a copy, not a
   symlink, so edits in this repo aren't picked up automatically, and there's
   no build step.

2. **Activate it** by adding an entry to
   `~/.dsh/profiles/web/cordis.patch.yml` (replace an empty `[]`, or add to
   it if you've since patched other things):

   ```yaml
   - insert:
       - id: llm-cpa
         name: '@xiangsam/dsh-cpa-plugin'
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
           # your account (see "Known limitations" below).
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

   `models:` entries are overrides, not an allowlist — the provider
   discovers CPA's full live catalog on its own (`curl -H "Authorization:
   Bearer $KEY" http://127.0.0.1:8317/v1/models` shows the same list). Only
   add an entry when a specific model's auto-resolved context window is
   wrong for your account.

3. **Provide the API key.** CPA's home screen shows a generated API key
   (also at `~/Library/Application Support/com.maccliproxyapi/api-keys.json`).
   Either:

   - open dsh's web UI → Settings → Models → "CPA" (it appears automatically
     once the plugin is active) → paste the key there, or
   - add a `CPA_API_KEY: sk-...` line directly to `~/.dsh/.credentials.yaml`.

   If your profile has `dsh-credentials-local` active, a plain
   `export CPA_API_KEY=...` before launching is **not** enough — it checks
   the managed store first.

4. **Restart `dsh web`.** `cordis.patch.yml` edits and a redeployed plugin
   both need a fresh process (`Ctrl+C`, then `dsh web` again) — hmr is off by
   default for this profile.

5. Open the web UI, pick the "CPA" provider / any model from the `/model`
   picker (e.g. `gpt-5.5`, `claude-sonnet-5` — `deepseek-*` is filtered out
   by default, see below), and confirm a "Ctx ..." pill appears in the
   composer's tool row, beside the model seat — click it for the slider
   panel.

## Using the context-cap slider

Click the "Ctx" pill to open a panel with a discrete slider —
`[64K, 256K, 512K, 1M]` rungs, snapping to whichever is closest to the
currently selected model's own real maximum (picking a 272k-max model
removes the 512K/1M rungs, for example). Moving it writes a new cap that
`dsh-compaction-basic` picks up immediately on its next pressure check, so
auto-compact retunes without restarting `dsh` or touching any other plugin.

The cap is one global value shared by every model this provider serves, not
per-model — moving the slider affects all of them together (only the
slider's *ceiling* narrows per-model).

## Configuration reference

| Key | Default | Meaning |
| --- | --- | --- |
| `baseURL` | `http://127.0.0.1:8317/v1` | CPA's local endpoint. |
| `apiKeyEnv` | `CPA_API_KEY` | Credential reference resolved via dsh's credentials service or launch environment. |
| `thinking` | `enabled` | `disabled` forces every call to reasoning effort `none`. |
| `reasoningEffort` | `medium` | Default effort (`none`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`) when a call doesn't specify one. |
| `maxTokens` | `65536` | Default max output tokens. |
| `defaultContextWindow` | `128000` | Fallback context window when no catalog entry, bundled-table match, OpenRouter hit, or family-prefix heuristic applies. |
| `contextCapTokens` | `1000000` | The cap the "Ctx" slider reads/writes. |
| `sliderMaxTokens` | `1000000` | Cosmetic ceiling for the slider's rightmost rung. |
| `models` | `[]` | Per-model overrides: `id`, `name`, `description`, `contextWindow`, `maxTokens`. Wins over every other context-window source. |
| `excludeModelPrefixes` | `["deepseek-"]` | Model ids hidden from discovery (CPA's DeepSeek route just proxies to `api.deepseek.com` — use dsh's built-in `deepseek-official` adapter instead). |
| `streamIdleTimeoutMs` | `300000` | Abort a stream if no data arrives for this long. |

## Known limitations

- **Context-window numbers are estimates, not measurements.** They come from
  a bundled CPA catalog snapshot, OpenRouter's public catalog, or a
  family-prefix guess — none of them reflect *your account's actual
  entitlement*. Verify against real behavior and add a `models:` override
  when one turns out wrong (this is already done here for `gpt-5.x`, which
  doesn't get the 1M several sources claim).
- **`contextCapTokens` is global**, not per-model (see above).
- **Reasoning effort is sent uniformly** to every model this adapter
  resolves. If a specific model behind CPA rejects the field, that's a
  current gap — there's no per-model override for it.
- **Image input** requires your dsh profile to have a durable attachment
  service active (ships by default with `dsh-web-app`) and a model whose
  catalog entry declares image support.

## Security note

While wiring this up, `~/Library/Application Support/com.maccliproxyapi/provider-secrets.json`
was found to hold CPA's **upstream** provider API keys in plaintext
(separate from the local `api-keys.json` client key used above). That's
expected for how CPA works locally, but don't commit or paste that file's
contents anywhere.

## Contributing / internals

See [DEVELOPMENT.md](DEVELOPMENT.md) for how the plugin is built, the
prompt-cache and reasoning-replay mechanics, and known simplifications in
the implementation.
