import { OfficeScene } from "@/components/office/office-scene";
import { GameMusic } from "@/components/office/game-music";

export default function OfficePage() {
  return (
    <main className="relative h-screen w-screen overflow-hidden bg-zinc-950">
      <OfficeScene />
      <GameMusic />
    </main>
  );
}
