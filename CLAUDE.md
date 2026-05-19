# CLAUDE.md

This file is for Claude Code working in this repository.

**The canonical instruction file is [`AGENTS.md`](./AGENTS.md).** Read it
first — it covers the project's purpose, layout, build/test commands,
engineering conventions, and the recipe for adding a new framework adapter.
Everything below is additional Claude-specific guidance that doesn't belong
in the framework-neutral `AGENTS.md`.

---

## Claude-specific notes

### Tooling

- Use the `Edit` tool for in-place changes; use `Write` only for new files or
  full rewrites. `Read` the file first before editing.
- Use `TaskCreate` / `TaskUpdate` to plan multi-step work (refactors, new
  adapters, version bumps). One task per discrete step, mark complete as you
  finish each.
- Prefer running `npm run typecheck && npm test` over running tests in
  isolation when you've changed shared types or core code — a green test
  doesn't prove a green typecheck under our strict config.

### Commit conventions

When the user explicitly asks for a commit:

- Conventional-commit style prefixes are fine but not enforced
  (`feat:`, `fix:`, `chore:`, `refactor:`, `docs:`, `test:`).
- One short subject line (≤ 72 chars), optional body explaining *why*.
- **Do not add a `Co-Authored-By: Claude …` trailer.** Commits should be
  attributed solely to the human committer.
- **Use whatever identity git resolves on its own.** Do not pass
  `-c user.name=…` / `-c user.email=…` overrides. Verify with
  `git config user.email` if you're unsure.
- Stage files explicitly by path. Never `git add -A`. The gitignored
  directories (`node_modules/`, `dist/`, IDE configs, local Claude
  settings) should stay out of commits.
- Never modify global git config.

### Pushing

- Default branch is `develop`. `main` is reserved for releases — the
  release workflow verifies that the published tag is reachable from
  `main`.
- Don't force-push without explicit user instruction.
- Don't use `--no-verify` to bypass hooks.

### When in doubt

- Token-extraction shapes vary across LLM providers. If you see a new shape,
  add it to `src/langchain/tokens.ts` with a comment naming the provider —
  don't silently coerce it.
- If a framework's API is unclear, install it locally (`npm install
  --no-save <pkg>`) and read its `.d.ts` files directly rather than relying
  on documentation.
- Prefer asking the user one focused question over guessing on
  product-shaping decisions (package name, breaking changes, public API
  surface).
