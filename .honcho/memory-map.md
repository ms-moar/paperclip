# Honcho memory map: paperclip

Workspace: `paperclip`
Project peer: `project-paperclip`

## Role split

Paperclip remains the operational source of truth for issues, agents, comments, interactions, statuses, and execution state.

Honcho stores durable memory only:

- architecture decisions;
- governance rules;
- incident lessons;
- repeated failure patterns;
- summarized issue outcomes;
- agent behavior lessons.

Do not ingest raw heartbeat noise, raw comments in bulk, raw JSONL traces, or secrets.

## Components

- `server` → `component-server` / `component-server`
- `ui` → `component-ui` / `component-ui`
- `cli` → `component-cli` / `component-cli`
- `worker` → `component-worker` / `component-worker`
- `skills` → `component-skills` / `component-skills`
- `docs` → `component-docs` / `component-docs`

## Rules

- Use slug IDs only: `^[a-zA-Z0-9_-]+$`.
- For issue memory, ingest curated final summaries into `issue-<id>` sessions.
- Do not duplicate Paperclip database state into Honcho.
- Keep production actions governed by Paperclip, not Honcho memory.
