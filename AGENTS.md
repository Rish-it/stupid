# Stupid

Stupid is a workspace for creators and small businesses on Meta: sign in with Facebook,
connect Ads, Instagram and WhatsApp one at a time, read results in plain words, and let
background agents prepare leads, post ideas, replies and ad advice for one-tap review.

- Read `README.md` and, if present locally, the ignored `plan.md` and `.internal/` notes first.
- Server: Rust in `server/` (axum, tokio, SQLite). `cargo test` and `cargo clippy -- -D warnings`
  from `server/` must pass. It serves `frontend/dist` and reads settings from `.env` (`STUPID_*`).
- Frontend: Vite + React 19 + Astryx (`@astryxdesign/core`, neutral theme) in `frontend/`.
  `npm run lint` and `npm run build` must pass. Use Astryx components before custom CSS.
- Use `npm ci` and keep `package-lock.json` and `server/Cargo.lock` updated when dependencies change.
- Keep secrets, tokens, uploaded data, databases and caches out of Git. Never print or `source` `.env`.
  Meta tokens never reach the browser.
- Show only real data. An empty or unconnected state says so; never invent numbers.
- Agents prepare work and wait for the person. Nothing is sent, posted or changed without a tap.
- No new paid services. AI spend stays under `STUPID_MUSE_BUDGET_USD`.

## Working rules

- Coding: take the simplest change that fully works. Reuse what is already in the repo, then the
  standard library, then installed dependencies; add nothing speculative. Fix root causes.
- Conventions: one task branch per chunk, cut from `main`; never commit on `main`. Task-only diffs.
  Run the checks twice before committing. Small, specific, imperative commits; stage files by name,
  never `git add -A`. PRs into `main` are merged only on the owner's word.
- No AI or tool attribution in commits, PRs, branch names or code comments.
- Full versions of these rules, when present locally: `.internal/skills/ponytail/SKILL.md` (coding)
  and `.internal/skills/carmy/SKILL.md` (conventions).

## graphify

- **graphify** (`~/.Codex/skills/graphify/SKILL.md`) — any input to knowledge graph.
  Trigger: `/graphify`. When invoked, read and follow that skill before other work.
