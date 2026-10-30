# CLAUDE.md

This file is loaded automatically at the start of every Claude Code session.

@AGENTS.md

## Working agreement

Run the checks after every change and report the real output:

| Check  | Command                |
| ------ | ---------------------- |
| Types  | `npm run typecheck`    |
| Lint   | `npm run lint`         |
| Format | `npm run format:check` |
| Tests  | `npm run coverage`     |
| Build  | `npm run build`        |

Tests run against a fake API (`tests/fakeApi.ts`) and need no running services.

### Don't touch

- `.env*`: local secrets. Never read, commit, or modify them.
- `dist/` and `coverage/`: generated output.
