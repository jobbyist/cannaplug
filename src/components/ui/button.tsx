import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap font-semibold transition duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "rounded-full bg-primary text-primary-foreground uppercase tracking-wide hover:bg-primary/90",
        primary: "rounded-full bg-primary text-primary-foreground uppercase tracking-wide hover:bg-primary/90",
        outline:
          "rounded-full border border-primary bg-background text-primary uppercase tracking-wide hover:bg-primary hover:text-primary-foreground",
        secondary: "rounded-md bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "rounded-md text-foreground hover:bg-muted",
        link: "text-primary underline-offset-4 hover:underline normal-case font-medium",
        destructive: "rounded-md bg-destructive text-destructive-foreground hover:bg-destructive/90",
        gold: "rounded-full bg-premium text-charcoal uppercase tracking-wide hover:bg-premium/85",
      },
      size: {
        default: "h-11 px-5 text-xs",
        sm: "h-9 px-4 text-xs",
        lg: "h-12 px-7 text-sm",
        icon: "h-10 w-10 rounded-full p-0",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "default",
    },
  },
);

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  };

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp ref={ref} className={cn(buttonVariants({ variant, size, className }))} {...props} />;
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
