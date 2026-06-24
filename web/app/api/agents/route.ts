import { runHerdr, ok, fail } from "@/lib/herdr-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const status = new URL(req.url).searchParams.get("status");
    const res = await runHerdr(["agent", "list"]);
    let agents = (res.agents as Record<string, unknown>[]) ?? [];
    if (status) agents = agents.filter((a) => a.agent_status === status);
    return ok({ agents, count: agents.length });
  } catch (e) {
    return fail(e);
  }
}
