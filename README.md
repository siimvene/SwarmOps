# SwarmOps

**Orchestrate parallel AI agent workers to build software projects.**

<p align="center">
  <img src="docs/swarm.png" alt="SwarmOps" width="400">
</p>

SwarmOps manages swarms of AI agents that work together to complete software projects. It handles the full lifecycle from requirements gathering through code review — spawning workers in parallel, managing git isolation, and coordinating multi-stage review chains.

## How It Works

```
Interview → Specification → Build → Review → Complete
```

1. **Interview** — Chat with an AI to gather project requirements
2. **Specification** — Architect agent designs the solution and decomposes into tasks
3. **Build** — Multiple builder agents work in parallel, each in isolated git worktrees
4. **Review** — Sequential review chain (code → security → design) with automatic fixes
5. **Complete** — Merge to main when all reviews pass

## Key Features

- **Parallel Execution** — Spawn multiple workers simultaneously with dependency-aware scheduling
- **Git Isolation** — Each worker operates in its own worktree, merged after completion
- **Role-Based Agents** — Configurable roles with custom models, thinking levels, and prompts
- **Review Chain** — Multi-stage code review with automatic fix-and-retry loops
- **Smart Conflict Resolution** — AI-powered merge conflict resolution
- **Spawn Safeguards** — Circuit breaker, rate limiting, and task deduplication to prevent runaway sessions
- **Real-time Dashboard** — Monitor workers, view logs, manage projects

## Architecture

SwarmOps consists of:

- **Dashboard** — Nuxt 4 web UI for project management and monitoring
- **Orchestrator** — Core logic for task scheduling, worker management, and phase transitions
- **Gateway Integration** — Connects to [OpenClaw](https://github.com/openclaw/openclaw) for AI agent spawning

## Quick Start

```bash
# Clone and install
git clone https://github.com/siimvene/SwarmOps.git
cd SwarmOps
./install.sh

# Start the server
cd dashboard && node .output/server/index.mjs
```

The dashboard runs on `http://localhost:3000` by default.

### Requirements

- Node.js 20+
- [OpenClaw Gateway](https://github.com/openclaw/openclaw) running locally

## Project Structure

```
SwarmOps/
├── dashboard/          # Nuxt 4 web application
│   ├── app/           # Vue components, pages, composables
│   ├── server/        # Nitro API routes and utilities
│   └── public/docs/   # Built-in documentation
├── packages/
│   └── orchestrator/  # Core orchestration logic (TypeScript)
└── data/
    └── orchestrator/  # Runtime data (roles, pipelines, state)
```

## Configuration

### Roles

Define agent roles in `data/orchestrator/roles.json`:

```json
{
  "builder": {
    "id": "builder",
    "name": "Builder",
    "model": "anthropic/claude-sonnet-4",
    "thinking": "low",
    "instructions": "You are a software developer..."
  }
}
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENCLAW_GATEWAY_URL` | Gateway API URL (default: `http://127.0.0.1:18789`) |
| `OPENCLAW_GATEWAY_TOKEN` | Auth token for dashboard access |
| `PROJECTS_DIR` | Path to projects directory |
| `ORCHESTRATOR_DATA_DIR` | Path to orchestrator state |

## Pipeline Flow

Projects move through phases automatically:

1. **Interview** → Spec when `interview.json` has `complete: true`
2. **Spec** → Build when `specs/IMPLEMENTATION_PLAN.md` exists
3. **Build** → Review when all tasks in `progress.md` are done
4. **Review** → Complete when all reviewers approve

The phase watcher polls every 30 seconds and advances projects when conditions are met.

## Documentation

Built-in docs are available at `/docs` in the dashboard, covering:

- Architecture and system design
- Agent context and prompts
- Operations and monitoring
- Resilience and error handling

## License

MIT
