"""FastAPI server to control and observe an active herdr instance.

Focused on agents: list, inspect, read terminal output, send input, focus,
rename, wait for status, and spawn new agents. Plus workspace/pane helpers and
a live Server-Sent-Events stream of agent status.

Run:  uv run herdr-controller     (or)   uv run uvicorn app.main:app --reload
"""

from __future__ import annotations

import asyncio
import json
import os
from collections import Counter
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Body, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse, StreamingResponse

from .herdr import HerdrError, run_herdr, run_text
from .models import (
    CreateWorkspace,
    RenameAgent,
    RunCommand,
    SendKeys,
    SendText,
    SplitPane,
    StartAgent,
    WaitStatus,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    if os.environ.get("HERDR_ENV") != "1":
        # Not fatal — the CLI still talks to the server over the socket — but warn.
        print("[herdr-controller] warning: HERDR_ENV != 1 (not running inside a herdr pane)")
    yield


app = FastAPI(
    title="herdr controller",
    version="0.1.0",
    description="Control and pull data from an active herdr instance, focused on agents.",
    lifespan=lifespan,
)

# This API can drive agents that run arbitrary shell commands, so we do NOT use
# wildcard CORS. Only same-machine dashboard origins may call it from a browser.
# Override/extend with HERDR_ALLOWED_ORIGINS (comma-separated).
_default_origins = [
    "http://localhost:3000", "http://127.0.0.1:3000",
    "http://localhost:3939", "http://127.0.0.1:3939",
]
_env_origins = [o.strip() for o in os.environ.get("HERDR_ALLOWED_ORIGINS", "").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_env_origins or _default_origins,
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Content-Type", "Authorization", "X-API-Token"],
)


def _wrap(coro):
    """Translate HerdrError into a clean HTTP error."""
    async def runner():
        try:
            return await coro
        except HerdrError as e:
            status = 404 if e.code in {"agent_not_found", "not_found", "pane_not_found"} else 502
            if e.code == "timeout":
                status = 504
            raise HTTPException(status_code=status, detail={"code": e.code, "message": e.message})
    return runner()


# ---------------------------------------------------------------- health/status

@app.get("/health", tags=["meta"])
async def health() -> dict[str, Any]:
    return {"ok": True, "herdr_env": os.environ.get("HERDR_ENV") == "1"}


@app.get("/status", response_class=PlainTextResponse, tags=["meta"])
async def status() -> str:
    """Raw `herdr status` (client + server version, socket path)."""
    return await _wrap(run_text(["status"]))


@app.get("/summary", tags=["meta"])
async def summary() -> dict[str, Any]:
    """Aggregate view: agent count broken down by status + per-workspace rollup."""
    agents = (await _wrap(run_herdr(["agent", "list"]))).get("agents", [])
    workspaces = (await _wrap(run_herdr(["workspace", "list"]))).get("workspaces", [])
    by_status = Counter(a.get("agent_status", "unknown") for a in agents)
    return {
        "total_agents": len(agents),
        "by_status": dict(by_status),
        "workspaces": len(workspaces),
        "focused_agent": next((a for a in agents if a.get("focused")), None),
    }


# ---------------------------------------------------------------------- agents

@app.get("/agents/stream", tags=["agents"])
async def stream_agents(interval: float = Query(2.0, ge=0.5, le=30.0)):
    """Server-Sent Events: emit the agent list whenever any status changes."""

    async def gen():
        last = None
        while True:
            try:
                agents = (await run_herdr(["agent", "list"])).get("agents", [])
            except HerdrError as e:
                yield f"event: error\ndata: {json.dumps({'code': e.code, 'message': e.message})}\n\n"
                await asyncio.sleep(interval)
                continue
            snapshot = {a["pane_id"]: a.get("agent_status") for a in agents}
            if snapshot != last:
                last = snapshot
                yield f"data: {json.dumps({'agents': agents})}\n\n"
            else:
                yield ": keepalive\n\n"
            await asyncio.sleep(interval)

    return StreamingResponse(gen(), media_type="text/event-stream")


@app.get("/agents", tags=["agents"])
async def list_agents(status: str | None = Query(None, description="Filter by agent_status")):
    result = await _wrap(run_herdr(["agent", "list"]))
    agents = result.get("agents", [])
    if status:
        agents = [a for a in agents if a.get("agent_status") == status]
    return {"agents": agents, "count": len(agents)}


@app.get("/agents/{target}", tags=["agents"])
async def get_agent(target: str):
    result = await _wrap(run_herdr(["agent", "get", target]))
    return result.get("agent", result)


@app.get("/agents/{target}/read", response_class=PlainTextResponse, tags=["agents"])
async def read_agent(
    target: str,
    source: str = Query("recent", pattern="^(visible|recent|recent-unwrapped)$"),
    lines: int = Query(50, ge=1, le=2000),
    format: str = Query("text", pattern="^(text|ansi)$"),
):
    """Read what's currently on an agent's terminal screen/scrollback."""
    result = await _wrap(
        run_herdr(["agent", "read", target, "--source", source, "--lines", str(lines), "--format", format])
    )
    return result.get("read", {}).get("text", "")


@app.post("/agents/{target}/send", tags=["agents"])
async def send_agent(target: str, body: SendText):
    """Type text into an agent. Set enter=true to submit it."""
    await _wrap(run_herdr(["pane" if body.enter else "agent",
                           "run" if body.enter else "send", target, body.text]))
    return {"ok": True, "target": target}


@app.post("/agents/{target}/focus", tags=["agents"])
async def focus_agent(target: str):
    await _wrap(run_herdr(["agent", "focus", target]))
    return {"ok": True, "target": target}


@app.post("/agents/{target}/rename", tags=["agents"])
async def rename_agent(target: str, body: RenameAgent):
    args = ["agent", "rename", target] + (["--clear"] if not body.name else [body.name])
    await _wrap(run_herdr(args))
    return {"ok": True, "target": target, "name": body.name}


@app.post("/agents/{target}/wait", tags=["agents"])
async def wait_agent(target: str, body: WaitStatus):
    """Block until the agent reaches a status (or timeout). 504 on timeout."""
    timeout_s = max(body.timeout_ms / 1000 + 5, 10)
    result = await _wrap(
        run_herdr(
            ["agent", "wait", target, "--status", body.status, "--timeout", str(body.timeout_ms)],
            timeout=timeout_s,
        )
    )
    return result


@app.get("/agents/{target}/explain", tags=["agents"])
async def explain_agent(target: str):
    """herdr's structured explanation of an agent's current state."""
    return await _wrap(run_herdr(["agent", "explain", target, "--json"]))


@app.post("/agents/start", tags=["agents"])
async def start_agent(body: StartAgent):
    """Spawn a new agent (e.g. claude) in a new/split pane."""
    args = ["agent", "start", body.name]
    if body.cwd:
        args += ["--cwd", body.cwd]
    if body.workspace:
        args += ["--workspace", body.workspace]
    if body.tab:
        args += ["--tab", body.tab]
    if body.split:
        args += ["--split", body.split]
    args += ["--focus"] if body.focus else ["--no-focus"]
    if body.argv:
        args += ["--", *body.argv]
    return await _wrap(run_herdr(args))


# ------------------------------------------------------------------ workspaces

@app.get("/workspaces", tags=["workspaces"])
async def list_workspaces():
    return await _wrap(run_herdr(["workspace", "list"]))


@app.post("/workspaces", tags=["workspaces"])
async def create_workspace(body: CreateWorkspace):
    args = ["workspace", "create"]
    if body.cwd:
        args += ["--cwd", body.cwd]
    if body.label:
        args += ["--label", body.label]
    if not body.focus:
        args += ["--no-focus"]
    return await _wrap(run_herdr(args))


@app.post("/workspaces/{workspace_id}/focus", tags=["workspaces"])
async def focus_workspace(workspace_id: str):
    await _wrap(run_herdr(["workspace", "focus", workspace_id]))
    return {"ok": True, "workspace_id": workspace_id}


@app.delete("/workspaces/{workspace_id}", tags=["workspaces"])
async def close_workspace(workspace_id: str):
    await _wrap(run_herdr(["workspace", "close", workspace_id]))
    return {"ok": True, "workspace_id": workspace_id}


# ----------------------------------------------------------------------- panes

@app.get("/panes", tags=["panes"])
async def list_panes(workspace: str | None = Query(None)):
    args = ["pane", "list"]
    if workspace:
        args += ["--workspace", workspace]
    return await _wrap(run_herdr(args))


@app.get("/panes/{pane_id}/read", response_class=PlainTextResponse, tags=["panes"])
async def read_pane(
    pane_id: str,
    source: str = Query("recent", pattern="^(visible|recent|recent-unwrapped)$"),
    lines: int = Query(50, ge=1, le=2000),
):
    result = await _wrap(run_herdr(["pane", "read", pane_id, "--source", source, "--lines", str(lines)]))
    return result.get("read", {}).get("text", result.get("text", ""))


@app.post("/panes/{pane_id}/run", tags=["panes"])
async def run_in_pane(pane_id: str, body: RunCommand):
    await _wrap(run_herdr(["pane", "run", pane_id, body.command]))
    return {"ok": True, "pane_id": pane_id}


@app.post("/panes/{pane_id}/keys", tags=["panes"])
async def send_pane_keys(pane_id: str, body: SendKeys):
    await _wrap(run_herdr(["pane", "send-keys", pane_id, *body.keys]))
    return {"ok": True, "pane_id": pane_id}


@app.post("/panes/{pane_id}/split", tags=["panes"])
async def split_pane(pane_id: str, body: SplitPane):
    args = ["pane", "split", pane_id, "--direction", body.direction]
    if body.ratio is not None:
        args += ["--ratio", str(body.ratio)]
    if body.cwd:
        args += ["--cwd", body.cwd]
    args += ["--focus"] if body.focus else ["--no-focus"]
    return await _wrap(run_herdr(args))


@app.delete("/panes/{pane_id}", tags=["panes"])
async def close_pane(pane_id: str):
    await _wrap(run_herdr(["pane", "close", pane_id]))
    return {"ok": True, "pane_id": pane_id}


def main() -> None:
    import uvicorn

    uvicorn.run(
        "app.main:app",
        host=os.environ.get("HOST", "127.0.0.1"),
        port=int(os.environ.get("PORT", "8787")),
        reload=bool(os.environ.get("RELOAD")),
    )
