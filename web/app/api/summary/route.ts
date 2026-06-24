import { runHerdr, ok, fail } from "@/lib/herdr-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [a, w] = await Promise.all([
      runHerdr(["agent", "list"]),
      runHerdr(["workspace", "list"]),
    ]);
    const agents = (a.agents as Record<string, unknown>[]) ?? [];
    const workspaces = (w.workspaces as unknown[]) ?? [];
    const by_status: Record<string, number> = {};
    for (const ag of agents) {
      const s = (ag.agent_status as string) ?? "unknown";
      by_status[s] = (by_status[s] ?? 0) + 1;
    }
    return ok({
      total_agents: agents.length,
      by_status,
      workspaces: workspaces.length,
      focused_agent: agents.find((ag) => ag.focused) ?? null,
    });
  } catch (e) {
    return fail(e);
  }
}
