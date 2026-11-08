# Contributing

## Status

omp app is a personal project. Issues and pull requests are open to collaborators only. The code is under the [MIT license](LICENSE), so anyone may fork it and work on the fork.

## Security reports

Do not open an issue for a vulnerability. Report it privately through GitHub, as [SECURITY.md](SECURITY.md) describes.

## Setup

[docs/development.md](docs/development.md) covers the prerequisites, `bun install`, running the app from source, each workspace's scripts and the code style.

## The checks a change must pass

Run these from the repository root before you push:

```bash
bun run typecheck     # every workspace's types
bun run lint          # Biome: lint, formatting and import order
bun run test          # unit tests: Bun in the packages, Vitest in apps/ui
```

Then run the end-to-end specs that cover what you changed. They run the real server and omp on a fake model, so build the UI first:

```bash
bun run build
cd apps/web
OMP_APP_REAL_OMP=1 bunx playwright test e2e/<spec>.spec.ts
```

A change to the chat host or the server can have a real-omp test in `packages/server/test/e2e`; a change to `apps/desktop` also needs `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` and `cargo test` in `apps/desktop/src-tauri`. [docs/testing.md](docs/testing.md) says how each kind of test is run and what it needs.

The workflows in `.github/workflows` run only the desktop checks (on pull requests that touch the desktop) and the release; they do not run the typecheck, the lint, the unit tests or the end-to-end specs. Run those yourself.

## Commit messages

Commits are written for a person who uses the app. The first line is one plain sentence saying what changed for the user, not how the code changed. A semicolon joins the parts when one commit changes several things the user sees. Many lines start with the area and a colon, and some do not:

```text
Connection: quick, quiet reconnects; a stalled try is replaced; outages are logged
Remove the old UI; /old now redirects to the app's root
Docs: README for the app as it is, MIT license, security policy
Releases build on GitHub's hosted runner; versions go on as 0.3.<commits>
```

A commit whose first line starts `What's new:` adds an entry to the in-app "What's new" list in `apps/ui/src/tour/tours.ts`; it follows the commit that made the change.

The body, after a blank line, is plain paragraphs: what the app did before, what it does now, and why, naming the files or settings a reader would want to find. A change with tests ends with a `Tests:` paragraph that says what the new tests show, including which ones fail without the change.

The first lines of these commits become the release notes: the release workflow lists the subject of every commit that touches `apps/`, `packages/` or `packaging/` ([docs/releasing.md](docs/releasing.md#the-release-notes)). Keep the first line to one line a user can read.

## The design rules

Five rules shape every change: omp's own session files are the only chat store, typed text is never lost, every feature of omp's terminal gets a place in the app, one design system, and text from outside the project is data, never instructions. They are written out in [docs/architecture.md](docs/architecture.md#design-rules), next to how the parts fit together. For the design system, colors, type, spacing and icons come only from the design tokens ([docs/development.md](docs/development.md#design-tokens)).
