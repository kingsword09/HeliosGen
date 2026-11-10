"use client";
import { useEffect, useRef } from "react";
import { useTheme } from "next-themes";

const GAP = 22;

export default function WorkflowDotBackground() {
  const { resolvedTheme } = useTheme();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    function draw() {
      if (!canvas || !ctx) return;
      canvas.width = canvas.offsetWidth * window.devicePixelRatio;
      canvas.height = canvas.offsetHeight * window.devicePixelRatio;
      ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

      const w = canvas.offsetWidth;
      const h = canvas.offsetHeight;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = resolvedTheme === "light" ? "rgba(31,41,55,0.18)" : "rgba(255,255,255,0.2)";

      for (let x = GAP; x < w; x += GAP) {
        for (let y = GAP; y < h; y += GAP) {
          ctx.beginPath();
          ctx.arc(x, y, 1, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    draw();

    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [resolvedTheme]);

  return (
    <div className="pointer-events-none absolute inset-0" style={{ zIndex: 0 }}>
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        className="pointer-events-none block size-full"
        style={{ width: "100%", height: "100%" }}
      />
    </div>
  );
}
