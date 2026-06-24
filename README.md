# herdr-controller

A **Next.js dashboard + 3D game to control and observe an active [herdr](https://herdr.dev) instance — focused on agents.**

List every agent in your herdr session, watch their status update live, read
their terminal output, send them messages, spawn new agents — from a clean web
dashboard **or** a 3D office FPS where each agent is a character at a desk.

![herdr-controller dashboard](docs/dashboard.png)

---

## What is herdr?

[**herdr**](https://herdr.dev) is a terminal-native multiplexer for AI coding
agents. It organizes work into **workspaces → tabs → panes**, where each pane is
a real terminal running its own shell, agent (Claude Code, etc.), server, or log
stream. herdr auto-detects agents and tracks their status (`idle` / `working` /
`blocked` / `done` / `unknown`).

herdr's native server exposes its API on an **owner-only unix socket**
(`~/.config/herdr/herdr.sock`) — no TCP, no HTTP — and the sanctioned client is
the `herdr` CLI. Browsers can't speak to a unix socket, so this app puts a thin
HTTP face in front of it.

## Architecture (single server)

```
browser ──HTTP/SSE──> Next.js route handlers (/api/*) ──> `herdr` CLI ──unix socket──> herdr server ──> agents
```

The Next.js server **is** the whole thing. Its `/api/*` route handlers
(`app/api/**`, Node runtime) shell out to the `herdr` CLI and stream the results
back to the browser — same-origin, so there's no CORS and no second process.

- `web/lib/herdr-server.ts` — server-only: runs `herdr` commands, parses the
  `{"result"}` / `{"error"}` envelopes, maps failures to HTTP 404 / 502 / 504,
  and extracts a "done" agent's last message for speech bubbles.
- `web/app/api/**` — the route handlers (agents, summary, SSE stream, read,
  bubble, send, focus, start, pane-kill).
- `web/lib/herdr.ts` — the browser client (calls same-origin `/api/*`).

## What you get

- **Dashboard** (`/`) — live agent grid (SSE), status rollup, terminal mirror,
  message box, `+ New agent` spawn, draggable splitter, per-line Hebrew RTL.
- **3D Office FPS** (`/office`) — each agent is a character at a desk with
  working/idle/blocked/done animations, project signs, and a speech bubble of
  the agent's last message when it finishes. Walk around (WASD + jump/sprint/
  crouch), and **shooting an agent 3× actually closes its herdr pane** — the
  focused controller agent is shield-protected. Synthwave soundtrack + HUD +
  minimap.

## Requirements

- **[herdr](https://herdr.dev)** installed and **running**, with the `herdr`
  binary on your `PATH`. This app must run **on the same machine** (it talks to
  herdr's local socket via the CLI).
- **Node.js ≥ 20** and npm.

> No Python, no second server — the old FastAPI backend was folded into the
> Next.js route handlers.

## Install & run

```bash
git clone https://github.com/aviz85/herdr-controller.git
cd herdr-controller/web
npm install
npm run dev -- --port 3939
```

Open <http://localhost:3939> (dashboard) and <http://localhost:3939/office> (game).

## API (`/api/*`, same origin)

| Method | Path | Description |
|---|---|---|
| GET | `/api/agents` | List agents. `?status=working\|idle\|blocked\|done\|unknown` |
| GET | `/api/agents/stream` | **SSE** — pushes the agent list on every status change |
| GET | `/api/summary` | Agent counts by status + workspace count + focused agent |
| GET | `/api/agents/{target}/read` | Read terminal text (`?source=recent&lines=200`) |
| GET | `/api/agents/{target}/bubble` | Best-effort last message (for office bubbles) |
| POST | `/api/agents/{target}/send` | Type text. `{"text":"…","enter":true}` to submit |
| POST | `/api/agents/{target}/focus` | Focus the agent's pane |
| POST | `/api/agents/start` | Spawn an agent (`name`, `cwd`, `split`, `focus`, `argv`) |
| DELETE | `/api/panes/{id}` | Close a pane = **kill** that agent |

A **target** is anything herdr accepts: a pane id (`w654…-1`), a unique agent
name, or a detected agent label.

```bash
B=http://127.0.0.1:3939
curl -s $B/api/summary | jq
curl -s "$B/api/agents?status=working" | jq '.agents[].cwd'
curl -s "$B/api/agents/elmwood/read?lines=40"
curl -N $B/api/agents/stream
```

## Security notes

This API can spawn agents and type commands into terminals, so don't expose it
publicly — keep it bound to localhost. It controls the local herdr instance and
is meant to run beside it.

## License

MIT
