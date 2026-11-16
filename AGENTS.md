# Repository Guidelines

## Project Structure & Modules

This is a pnpm TypeScript workspace. Reusable domain code lives in `packages/` (for example, `ir`, `geometry`, `engine`, `tools`, and `agents`); the Node host and browser app are in `apps/host` and `apps/web`. Keep package dependencies aligned with the rules enforced by `tools/check-boundaries.ts`. Tests sit in each package or app's `test/` directory; shared evaluation tests and scripts are under `tools/`. Use `docs/` for specifications, architecture decisions, and evaluation notes. Golden project fixtures live in `tools/fixtures`.

## Build, Test, and Development

Use Node 22 or newer and pnpm 10 (`corepack pnpm ...` if needed).

- `pnpm install` installs workspace dependencies.
- `pnpm check` runs formatting/lint checks, package-boundary checks, TypeScript, Vitest, and ledger coverage.
- `pnpm test` runs the Vitest suite; `pnpm test:watch` runs it interactively.
- `pnpm host:dev` starts the host with HTTP and MCP interfaces.
- `pnpm web:dev` starts the Vite web app; `pnpm web:build` builds it.
- `pnpm format` applies Biome formatting to the repository.

## Coding Style & Naming

Use TypeScript ESM with two-space indentation, double quotes, semicolons, and an approximately 110-character line width; Biome applies these settings. Follow nearby naming: lower-case kebab case for multiword filenames (for example, `agent-runs.ts`), descriptive identifiers, and `.test.ts` for tests. Keep browser and Node dependencies within the established package boundaries; pure model and geometry packages must remain independent of three.js and the DOM.

## Testing

Vitest collects `packages/*/test/**/*.test.ts`, `apps/*/test/**/*.test.ts?(x)`, and `tools/test/**/*.test.ts`. Name tests `*.test.ts`; add cases beside the package or app they cover. Tests should assert on model values, geometry, and derived measurements rather than rendered pixels. When changing a rule tracked in the ledger, include a test using its ledger ID and keep `pnpm ledger:coverage` passing. Use JSON fixtures in `tools/fixtures` for repeatable plan examples.

## Commits & Pull Requests

Recent commits use concise, sentence-like descriptions rather than a visible prefix convention. Write a clear imperative or outcome-focused subject that explains the change. PRs should summarize behavior and affected packages, link relevant issues or design decisions, and include test/check results. Add screenshots for visible web or viewer changes, and note fixture or documentation updates where relevant.

## Configuration & Assets

Copy `.env.example` to `.env` for local configuration; do not commit secrets. Third-party drawing fixtures have separate license terms documented in `SOURCES.md` beside the fixtures.
