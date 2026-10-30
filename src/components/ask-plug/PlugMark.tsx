import leaf from "@/assets/plug-leaf.png";
import { cn } from "@/lib/utils";

/** The Ask The Plug mark: the Cannaplug leaf in a gold speech bubble. Decorative (the label sits next to it). */
export function PlugMark({ size = 34, className }: { size?: number; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("plug-mark", className)}
      style={{ width: size, height: size, ["--plug-leaf" as string]: `url(${leaf})` }}
    />
  );
}
