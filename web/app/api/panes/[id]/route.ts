import { runHerdr, ok, fail } from "@/lib/herdr-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// DELETE a pane = close it in herdr = kill that agent.
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    await runHerdr(["pane", "close", id]);
    return ok({ ok: true, pane_id: id });
  } catch (e) {
    return fail(e);
  }
}
