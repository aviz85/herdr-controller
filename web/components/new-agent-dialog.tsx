"use client";

import { useState } from "react";
import { herdr } from "@/lib/herdr";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { toast } from "sonner";

type Split = "right" | "down";

export function NewAgentDialog() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("claude");
  const [cwd, setCwd] = useState("");
  const [split, setSplit] = useState<Split>("right");
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        split,
        focus: false,
      };
      if (cwd.trim()) body.cwd = cwd.trim();
      if (task.trim()) body.argv = [task.trim()];
      await herdr.start(body);
      toast.success(`Spawned ${name} in herdr`);
      setOpen(false);
      setCwd("");
      setTask("");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" className="gap-1" />}>
        <span className="text-base leading-none">+</span> New agent
      </DialogTrigger>
      <DialogContent className="border-zinc-800 bg-zinc-950 text-zinc-100 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Spawn a new agent</DialogTitle>
          <DialogDescription className="text-zinc-500">
            Opens a real agent in a new herdr pane.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid gap-1.5">
            <Label htmlFor="agent">Agent</Label>
            <Input id="agent" value={name} onChange={(e) => setName(e.target.value)} placeholder="claude" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="cwd">Working directory (optional)</Label>
            <Input
              id="cwd"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="/Users/aviz/some-repo"
              className="font-mono text-xs"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="task">First message / task (optional)</Label>
            <Input
              id="task"
              value={task}
              onChange={(e) => setTask(e.target.value)}
              placeholder="review the test coverage in src/"
            />
          </div>
          <div className="grid gap-1.5">
            <Label>Placement</Label>
            <div className="flex gap-2">
              {(["right", "down"] as Split[]).map((d) => (
                <Button
                  key={d}
                  type="button"
                  size="sm"
                  variant={split === d ? "default" : "outline"}
                  onClick={() => setSplit(d)}
                  className="capitalize"
                >
                  split {d}
                </Button>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || !name.trim()}>
            {busy ? "Spawning…" : "Spawn agent"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
