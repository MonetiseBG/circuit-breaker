# Contributing

## Philosophy

Circuit Breaker was built to solve the immediate, concrete pain of runaway agent costs and infinite loops. The API is intentionally minimal — `budget-guard` and `loop-killer` cover the 80% case. The 20% that remains is discovered through real user friction, not designed in a vacuum.

The roadmap is driven by how you use — or fight — this tool in the wild. We actively want to hear from you, especially if:

- **It almost fits.** The default modes are 80% right but you need one specific tweak.
- **You are writing workarounds.** Custom scripts, wrapper-of-wrappers, patched options.
- **Your use case diverges sharply.** Ultra-strict production trading systems and loose research agents have genuinely different requirements.

When you stop asking *"what does this do?"* and start asking *"can I change how it works?"*, that's the signal to open an issue.

## Getting started

```bash
git clone https://github.com/MonetiseBG/circuit-breaker
cd circuit-breaker
npm install        # install dev + peer deps
npm run typecheck  # tsc --noEmit
npm test           # vitest run
npm run build      # tsup → dist/
```

Requires Node.js ≥ 22.

## Adding a new adapter

1. **Create `src/<framework>/`** with at least `wrapper.ts` and `index.ts`.
2. **Import from `../core/index.js`** only. Adapters must not cross-import each other.
3. **Map framework events to core primitives** — see [Building your own adapter](./06-advanced.md#building-your-own-adapter).
4. **Wire up abort.** Use `AbortSignal`, callback exceptions, or generator returns depending on what the framework supports.
5. **Honour `onTrip`.** If provided, suppress the error and return/yield the callback's value.
6. **Add the entry** to `tsup.config.ts` and the `exports` map in `package.json`. Add the framework as an optional peer dep with `peerDependenciesMeta.<name>.optional = true`.
7. **Write tests** under `tests/<framework>/`. Tests must not hit the network — mock or stub the framework's runtime.
8. **Open a PR** against the `develop` branch.

## Reporting issues

Open an issue on [GitHub](https://github.com/MonetiseBG/circuit-breaker/issues). Include:
- Framework and version
- Circuit Breaker version
- A minimal reproduction (ideally a standalone script)
- Observed vs. expected behaviour

## License

Apache-2.0 — © 2026 MonetiseBG
