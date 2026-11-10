# Contributing

Use Node.js 22.18+ (CI uses Node 24) and `npm ci`. Run `npm run verify` and `npm audit` before proposing changes. The test suite uses the official BB SDK fake host with real temporary SQLite storage, plus frontend and DOM integration tests.

Run `bb plugin build` with a supported BB host, then install or reload the local plugin and verify changed workflows. Compatibility has been checked on BB 0.48.1 and 0.49.0; verify the tab strip, composer and message menu when testing new BB versions. Never run live tests in someone else's conversation or worktree without authorization. Use an isolated test thread and harmless prompts.

Keep imports on public SDK entrypoints. Document changes that depend on BB DOM structure. Tests do not replace live verification of host components and styling. See SECURITY.md for data handling and known boundaries.
