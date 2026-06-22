# herdr-controller

A FastAPI server to **control and pull data from an active [herdr](https://herdr.dev) instance**, focused on agents.

It's a thin async HTTP layer over the `herdr` CLI. Every endpoint shells out to
`herdr <subcommand>`, which talks to the running herdr server over its local
unix socket, and returns the parsed JSON. No state of its own — herdr is the
source of truth.

## Why

herdr runs many terminal-native coding agents (claude, etc.) across workspaces,
tabs, and panes. This server exposes that live fleet over HTTP/JSON so you can
list agents, see their status, read their terminal output, send them input,
spawn new ones, and stream status changes — from a script, a dashboard, a phone,
or another agent.

## Run

The server must run on the same machine as herdr (it uses the `herdr` binary).

```bash
uv run uvicorn app.main:app --host 127.0.0.1 --port 8791
# or, via the installed script:
uv run herdr-controller            # PORT / HOST / RELOAD env vars
```

Open interactive docs at <http://127.0.0.1:8791/docs>.

## Endpoints

### Meta
| Method | Path | Description |
|---|---|---|
| GET | `/health` | Liveness + whether running inside a herdr pane |
| GET | `/status` | Raw `herdr status` (versions, socket path) |
| GET | `/summary` | Agent counts by status + workspace count + focused agent |

### Agents (the focus)
| Method | Path | Description |
|---|---|---|
| GET | `/agents` | List agents. `?status=working\|idle\|blocked\|done\|unknown` to filter |
| GET | `/agents/stream` | **SSE** — pushes the agent list whenever any status changes (`?interval=2`) |
| GET | `/agents/{target}` | One agent's full info |
| GET | `/agents/{target}/read` | Read the agent's terminal text (`?source=recent&lines=50&format=text`) |
| GET | `/agents/{target}/explain` | herdr's structured explanation of the agent state |
| POST | `/agents/{target}/send` | Type text. `{"text": "...", "enter": true}` to submit |
| POST | `/agents/{target}/focus` | Focus the agent's pane |
| POST | `/agents/{target}/rename` | `{"name": "..."}` or `{"name": null}` to clear |
| POST | `/agents/{target}/wait` | Block until status reached. `{"status":"done","timeout_ms":60000}` |
| POST | `/agents/start` | Spawn a new agent (see body schema in `/docs`) |

A **target** is anything herdr accepts: a terminal/pane id (`w654…-1`), a unique
agent name, or a detected agent label.

### Workspaces & panes
| Method | Path | Description |
|---|---|---|
| GET | `/workspaces` | List workspaces |
| POST | `/workspaces` | Create one (`cwd`, `label`, `focus`) |
| POST | `/workspaces/{id}/focus` | Focus |
| DELETE | `/workspaces/{id}` | Close |
| GET | `/panes` | List panes (`?workspace=...`) |
| GET | `/panes/{id}/read` | Read pane text |
| POST | `/panes/{id}/run` | Run a command (`{"command":"npm run dev"}`) |
| POST | `/panes/{id}/keys` | Send keys (`{"keys":["Enter"]}`) |
| POST | `/panes/{id}/split` | Split (`{"direction":"down"}`) |
| DELETE | `/panes/{id}` | Close pane |

## Examples

```bash
B=http://127.0.0.1:8791

# fleet overview
curl -s $B/summary | jq

# every working agent
curl -s "$B/agents?status=working" | jq '.agents[].cwd'

# read the last 30 lines of an agent's screen
curl -s "$B/agents/w654d42fd0f45e9-1/read?lines=30"

# ask an agent something and submit it
curl -s -X POST $B/agents/elmwood/send \
  -H 'content-type: application/json' \
  -d '{"text":"run the tests","enter":true}'

# block until it's done, then read the result
curl -s -X POST $B/agents/elmwood/wait \
  -H 'content-type: application/json' \
  -d '{"status":"done","timeout_ms":120000}'

# spawn a fresh claude agent in a new split
curl -s -X POST $B/agents/start \
  -H 'content-type: application/json' \
  -d '{"name":"claude","split":"right","focus":false}'

# live dashboard feed
curl -N "$B/agents/stream"
```

## Architecture

```
HTTP client ──> FastAPI (app/main.py)
                   │  app/herdr.py  (async subprocess wrapper)
                   ▼
                herdr CLI ──unix socket──> running herdr server
```

- `app/herdr.py` — runs `herdr` commands, parses the `{"result": …}` / `{"error": …}`
  JSON envelopes (errors arrive on stderr), maps failures to `HerdrError`.
- `app/models.py` — Pydantic request bodies.
- `app/main.py` — routes; `HerdrError` → HTTP 404/502/504.

Responses are herdr's JSON passed through verbatim, so the shapes always match
the installed herdr version.
