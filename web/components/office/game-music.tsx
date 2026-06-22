"use client";

import { useEffect, useRef, useState } from "react";

// Looping soundtrack for the office shooter. Decoupled from the 3D scene so it
// survives scene rewrites. Browser autoplay needs a user gesture, so we arm on
// the first click/keydown and expose a mute toggle.
export function GameMusic({ src = "/office-theme.mp3", volume = 0.35 }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [muted, setMuted] = useState(false);
  const [started, setStarted] = useState(false);

  useEffect(() => {
    const audio = new Audio(src);
    audio.loop = true;
    audio.volume = volume;
    audioRef.current = audio;

    const start = () => {
      if (audioRef.current && audioRef.current.paused) {
        audioRef.current.play().then(() => setStarted(true)).catch(() => {});
      }
    };
    window.addEventListener("pointerdown", start);
    window.addEventListener("keydown", start);
    return () => {
      window.removeEventListener("pointerdown", start);
      window.removeEventListener("keydown", start);
      audio.pause();
      audio.src = "";
    };
  }, [src, volume]);

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    const next = !muted;
    setMuted(next);
    a.muted = next;
    if (!next && a.paused) a.play().then(() => setStarted(true)).catch(() => {});
  };

  return (
    <button
      onClick={toggle}
      title={muted ? "Unmute music" : "Mute music"}
      className="absolute bottom-4 left-4 z-20 flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-950/70 px-3 py-2 text-xs text-zinc-200 backdrop-blur transition-colors hover:bg-zinc-900"
    >
      <span className="text-base leading-none">{muted ? "🔇" : "🎵"}</span>
      <span className="hidden sm:inline">
        {muted ? "music off" : started ? "now playing" : "click to play"}
      </span>
      {!muted && started && (
        <span className="flex items-end gap-0.5">
          <span className="h-2 w-0.5 animate-pulse bg-emerald-400" style={{ animationDelay: "0ms" }} />
          <span className="h-3 w-0.5 animate-pulse bg-emerald-400" style={{ animationDelay: "150ms" }} />
          <span className="h-1.5 w-0.5 animate-pulse bg-emerald-400" style={{ animationDelay: "300ms" }} />
        </span>
      )}
    </button>
  );
}
