# Cleanup inventory — October 16, 2026

Scope: small, reversible cleanup for the October 17 demonstration. No wholesale moves, source rewrites, data deletion, commits or deployment.

## Removed

- `src/components/Sidebar.css`: no import/reference to this file found in source, tests or HTML; former sidebar styling is disconnected from the current TopNav UI. An exact rollback copy was retained in the finalization chat workspace; the tracked original also remains in Git HEAD. Other CSS was retained.
- Root README's generic React/Vite scaffold section: replaced with application-specific setup and diagnostics.
- `vite.config.js`: removed obsolete “Force vite restart again” comment.
- `src/context/FinanceContext.jsx`: removed one unused ESLint suppression; no functional code changed there.
- Multer's unused transitive dependency entries below disappeared through the targeted npm update, not manual package deletion. Package manager removed 13 installed packages; lockfile removal list is authoritative for tracked changes.

- `node_modules/buffer-from`
- `node_modules/concat-stream`
- `node_modules/core-util-is`
- `node_modules/isarray`
- `node_modules/minimist`
- `node_modules/mkdirp`
- `node_modules/process-nextick-args`
- `node_modules/readable-stream`
- `node_modules/readable-stream/node_modules/safe-buffer`
- `node_modules/string_decoder`
- `node_modules/string_decoder/node_modules/safe-buffer`
- `node_modules/typedarray`
- `node_modules/util-deprecate`

## Important retained files and material

- All existing financial JSON, uploads, credentials and `.env` files. No ignored-file cleanup was attempted.
- Both protected databases: `finsphere_faculty_demo_20261015` and `finsphere_report_kit_20261016`. No application/test connection, schema action or data operation was directed to either.
- `public/favicon.svg`, referenced from `index.html`; the only discovered public asset.
- `src/components/Avatar.jsx`: used by Settings and DashboardGreeting, distinct from the assistant.
- `FinancialCompanion`, finance widgets, utility modules and test fixtures: referenced by live components or tests.
- `src/pages/Subscriptions.jsx`: active route; hardcoded examples are a documented limitation, not assumed unused code.
- Empty guidance/document files, existing docs, `skills/`, Python evaluation reference artifacts and test fixtures: retained because no safe claim of uselessness was established.
- `node_modules/`, `dist/`, Python caches and virtual environments: ignored/generated runtime material retained. Build refreshed only its own generated output.
- Root dependencies: retained; no dependency removal based on filename guesses or static text alone.

## Recovery

Review the diff and reverse only selected hunks. The deleted stylesheet can be recovered from `git show HEAD:src/components/Sidebar.css` without resetting anything else. Review a dependency rollback as a paired change to `server/package.json` and `server/package-lock.json`, then reinstall from the chosen lockfile. Never use `git clean`, hard reset, or delete ignored files as a cleanup shortcut.


## Final development release inventory (16 October 2026)

The pre-existing Sidebar.css deletion was independently rechecked and retained. This pass
deleted no additional source, private runtime files, databases, instructions, or tooling.
Tracked root AGENTS.md, CLAUDE.md and GEMINI.md are empty and retained as user-owned
instruction entry points. Tracked skills/SKILL (1).md and skills/designguidlines.md are
development guidance and retained. Root inventory found no agent/, agents/, .agent/,
.agents/, .claude/, .codex/, .vscode/ or .idea/ folder to remove. Existing .gitignore rules
cover IDE/runtime directories where applicable; no instruction directory was untracked.

Private root server_db.json/server_users.json exist but are ignored and untracked; uploads,
node_modules, dist, .env and Python caches remain local. `.gitignore` does not untrack files;
the tracked-file inventory was checked independently. Added exclusions cover backups/,
*.dump, *.backup, *.pem and *.key; no tracked file matching these needed removal.
The .dockerignore separately excludes secrets, runtime JSON, caches and development
instruction folders from image contexts; the source repository retains useful tooling.

Vite's targeted security upgrade replaced its dependency closure through npm. No root
application dependency was proven unused, so none was manually removed. npm reported a
locked old esbuild executable in an ignored temporary node_modules directory; it was left
in place rather than terminating an unknown developer process. Clean npm ci passed in a
separate source-only copy. Retained older reports are historical evidence, not current
security clearance. Retained screenshots use explicitly synthetic data.
