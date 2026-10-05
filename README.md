# 🔍 lupe

> **newcoworker fork.** Tracks [Gigadrive/lupe](https://github.com/Gigadrive/lupe) so the GitHub Action can call Anthropic Claude Sonnet 5.5 (`claude-sonnet-5-5`). This fork pins `@ai-sdk/anthropic` to **3.0.127** (≥3.0.125), which treats Sonnet 5.5 as rejecting forced tool use and falls back from `jsonTool` to native `outputFormat`. Pin `uses: newcoworker/lupe/apps/action@v0.2.2-nc.2` (moving alias `@v0.2.2-nc`) until upstream ships the same provider. Bugbot and Loupe reviewers are not configured on this fork. License remains [MIT](LICENSE) © Gigadrive.

> Platform- and provider-agnostic AI code review agent. Bring your own tokens.

**lupe** (German for _magnifying glass_) is an open-source, BYO-token alternative to CodeRabbit,
Cursor Bugbot, Greptile, and Macroscope. Run it as a reusable **GitHub Action** or a local **CLI**,
pointed at _your_ model provider (Anthropic, OpenAI, Google, Bedrock, OpenRouter, …) or — opt-in —
your existing local Claude Code / Codex login.

## Why lupe

- **Provider-agnostic.** One engine, any model. Swap providers with a single config value.
- **BYO-token.** No hosted SaaS, no per-seat pricing. Your keys, your spend.
- **Two surfaces, one core.** The same review engine powers a GitHub Action and a CLI.
- **Precision-first.** High-recall detection, then a grounding verifier + filter chain so the noise
  budget stays low (≈5 actionable comments/PR).
- **Embeddable.** `@gigadrive/lupe-sdk` lets you drop the reviewer into your own product.

## Packages

| Package                                          | Description                                                                                        |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| [`@gigadrive/lupe-core`](packages/lupe-core)     | The review engine: finding model, provider registry, agent loop, verifier, filters, renderers.     |
| [`@gigadrive/lupe-git`](packages/lupe-git)       | Diff parsing, hunk → `(line, side)` anchoring, read-only repo tools, context compression.          |
| [`@gigadrive/lupe-github`](packages/lupe-github) | GitHub transport: paginated diff fetch, batched review posting, sticky summary, thread resolution. |
| [`@gigadrive/lupe`](apps/cli)                    | The CLI (`lupe`). BYO API keys or opt-in local Claude Code / Codex credentials.                    |
| [`@gigadrive/lupe-action`](apps/action)          | The reusable GitHub Action.                                                                        |
| [`@gigadrive/lupe-sdk`](packages/lupe-sdk)       | Embeddable, Promise-returning programmatic facade.                                                 |

## Architecture in one line

> Vercel **AI SDK 6** is the AI engine; **Effect** is the application backbone. Model-touching code
> uses the AI SDK; app wiring (DI, typed errors, config, CLI, concurrency) uses Effect.

## Development

```bash
pnpm install
pnpm build          # turbo run build (tsdown, ESM-only)
pnpm typecheck
pnpm test
pnpm check:exports  # publint
pnpm format         # oxfmt --check  (format:fix to apply)
pnpm lint           # oxlint
pnpm knip           # unused deps/exports
pnpm effect:check   # @effect/language-service diagnostics
```

Node ≥ 20.18, pnpm ≥ 10.

## License

[MIT](LICENSE) © Gigadrive
