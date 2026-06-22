"""Request bodies for the herdr controller API.

Response shapes are passed through from the herdr CLI verbatim, so we keep
typed models only for inputs where validation actually helps.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

AgentStatus = Literal["idle", "working", "blocked", "done", "unknown"]
ReadSource = Literal["visible", "recent", "recent-unwrapped"]
SplitDirection = Literal["right", "down"]


class SendText(BaseModel):
    text: str = Field(..., description="Literal text to type into the agent's terminal.")
    enter: bool = Field(
        False,
        description="If true, press Enter after the text (like `herdr pane run`).",
    )


class RenameAgent(BaseModel):
    name: str | None = Field(None, description="New name; omit/null to clear the custom name.")


class WaitStatus(BaseModel):
    status: AgentStatus = Field(..., description="Status to block until the agent reaches.")
    timeout_ms: int = Field(30000, ge=0, le=600000)


class StartAgent(BaseModel):
    name: str = Field(..., description="Agent integration name, e.g. 'claude'.")
    cwd: str | None = None
    workspace: str | None = Field(None, description="Workspace id to start in.")
    tab: str | None = Field(None, description="Tab id to start in.")
    split: SplitDirection | None = Field(None, description="Split an existing pane this direction.")
    focus: bool = True
    argv: list[str] = Field(default_factory=list, description="Extra args passed after `--`.")


class CreateWorkspace(BaseModel):
    cwd: str | None = None
    label: str | None = None
    focus: bool = True


class RunCommand(BaseModel):
    command: str = Field(..., description="Command text; Enter is pressed automatically.")


class SplitPane(BaseModel):
    direction: SplitDirection
    cwd: str | None = None
    ratio: float | None = Field(None, gt=0, lt=1)
    focus: bool = False


class SendKeys(BaseModel):
    keys: list[str] = Field(..., min_length=1, description="Key names, e.g. ['Enter'] or ['Escape'].")
