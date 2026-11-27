import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

/** A finger/stylus signature box. Calls onChange with a PNG data URL, or null when empty. */
export function SignaturePad({
  onChange,
  resetKey,
}: {
  onChange: (png: string | null) => void;
  /** Change this value to clear the pad from outside. */
  resetKey?: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [has, setHas] = useState(false);

  const clear = () => {
    const c = canvas.current;
    const ctx = c?.getContext("2d");
    if (c && ctx) ctx.clearRect(0, 0, c.width, c.height);
    setHas(false);
    onChange(null);
  };

  useEffect(() => {
    const c = canvas.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    setHas(false);
  }, [resetKey]);

  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = canvas.current!;
    const r = c.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * c.width,
      y: ((e.clientY - r.top) / r.height) * c.height,
    };
  };

  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    const { x, y } = pos(e);
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#111111";
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + 0.01, y + 0.01);
    ctx.stroke();
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) return;
    const { x, y } = pos(e);
    ctx.lineTo(x, y);
    ctx.stroke();
  };
  const up = () => {
    if (!drawing.current) return;
    drawing.current = false;
    const c = canvas.current;
    if (!c) return;
    setHas(true);
    onChange(c.toDataURL("image/png"));
  };

  return (
    <div>
      <canvas
        ref={canvas}
        width={600}
        height={200}
        data-testid="signature-pad"
        aria-label="Signature box. Sign with a finger or stylus."
        className="w-full touch-none rounded-md border-2 border-dashed border-input bg-white"
        style={{ height: 140 }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
      />
      <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
        <span>{has ? "Signed" : "Sign above with a finger or stylus"}</span>
        <Button type="button" variant="ghost" size="sm" onClick={clear} disabled={!has}>
          Clear
        </Button>
      </div>
    </div>
  );
}
