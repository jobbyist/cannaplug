import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "outline" | "ghost" | "gold";
  children: ReactNode;
};

export function Button({ variant = "primary", className, children, ...props }: ButtonProps) {
  return (
    <button
      className={cn(
        "inline-flex min-h-11 items-center justify-center gap-2 rounded-full px-5 text-xs font-semibold uppercase transition duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
        variant === "primary" && "bg-primary text-primary-foreground hover:bg-primary/90",
        variant === "outline" && "border border-primary bg-background text-primary hover:bg-primary hover:text-primary-foreground",
        variant === "ghost" && "text-foreground hover:bg-muted",
        variant === "gold" && "bg-premium text-charcoal hover:bg-premium/85",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}