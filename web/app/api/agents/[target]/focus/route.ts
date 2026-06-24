import { runHerdr, ok, fail } from "@/lib/herdr-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ target: string }> },
) {
  try {
    const { target } = await params;
    await runHerdr(["agent", "focus", target]);
    return ok({ ok: true, target });
  } catch (e) {
    return fail(e);
  }
}
