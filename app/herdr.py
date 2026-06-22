"""Thin async wrapper around the `herdr` CLI.

Every herdr subcommand that talks to the running server prints a JSON envelope:

    {"id": "cli:agent:list", "result": {...}}        # success
    {"error": {"code": "...", "message": "..."}}      # failure (exit 1)

A few mutating commands (send-text, send-keys, run, agent send, focus, ...)
print nothing on success. We normalise all of that here so the HTTP layer only
ever sees `result` dicts or a raised :class:`HerdrError`.
"""

from __future__ import annotations

import asyncio
import json
import shutil
from typing import Any

HERDR_BIN = shutil.which("herdr") or "herdr"

# wait commands block server-side; give them their own generous ceiling.
DEFAULT_TIMEOUT = 30.0


class HerdrError(Exception):
    """A herdr command failed. Carries the CLI error code + message."""

    def __init__(self, code: str, message: str, *, exit_code: int | None = None):
        self.code = code
        self.message = message
        self.exit_code = exit_code
        super().__init__(f"[{code}] {message}")


async def run_herdr(args: list[str], *, timeout: float = DEFAULT_TIMEOUT) -> dict[str, Any]:
    """Run `herdr <args>` and return the parsed `result` object.

    Returns ``{"ok": True}`` for commands that succeed with empty stdout.
    Raises :class:`HerdrError` on a CLI error envelope or non-zero exit.
    """
    try:
        proc = await asyncio.create_subprocess_exec(
            HERDR_BIN,
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        out_b, err_b = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        raise HerdrError("timeout", f"herdr {' '.join(args)} timed out after {timeout}s")
    except FileNotFoundError:
        raise HerdrError("herdr_not_found", f"herdr binary not found at {HERDR_BIN!r}")

    out = out_b.decode("utf-8", "replace").strip()
    err = err_b.decode("utf-8", "replace").strip()

    def _parse(s: str) -> dict[str, Any] | None:
        if not s:
            return None
        try:
            v = json.loads(s)
            return v if isinstance(v, dict) else None
        except json.JSONDecodeError:
            return None

    payload = _parse(out)
    # herdr prints error envelopes to stderr, success envelopes to stdout.
    err_payload = _parse(err)

    for candidate in (payload, err_payload):
        if isinstance(candidate, dict) and "error" in candidate:
            e = candidate["error"]
            raise HerdrError(
                e.get("code", "error"),
                e.get("message", "unknown herdr error"),
                exit_code=proc.returncode,
            )

    if proc.returncode != 0:
        # wait commands exit 1 on timeout with no error envelope.
        raise HerdrError(
            "command_failed",
            err or out or f"herdr {' '.join(args)} exited {proc.returncode}",
            exit_code=proc.returncode,
        )

    if isinstance(payload, dict) and "result" in payload:
        return payload["result"]
    if payload is not None:
        return payload
    # success with no JSON body -> return raw text so callers can use it.
    return {"ok": True, "text": out} if out else {"ok": True}


async def run_text(args: list[str], *, timeout: float = DEFAULT_TIMEOUT) -> str:
    """Run a herdr command and return raw stdout text (for `status`, etc.)."""
    proc = await asyncio.create_subprocess_exec(
        HERDR_BIN, *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out_b, err_b = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    if proc.returncode != 0:
        raise HerdrError("command_failed", err_b.decode("utf-8", "replace").strip() or "failed")
    return out_b.decode("utf-8", "replace")
