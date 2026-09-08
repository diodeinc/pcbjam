import type { ButtonHTMLAttributes, PropsWithChildren } from "react";
export function Button({ size: _size, variant: _variant, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { size?: string; variant?: string }) { return <button {...props} />; }
export function Spinner({ className }: { className?: string }) { return <span className={className} aria-hidden="true">◌</span>; }
export function TooltipProvider({ children }: PropsWithChildren) { return <>{children}</>; }
export const Tooltip = TooltipProvider;
export function TooltipTrigger({ children }: PropsWithChildren<{ asChild?: boolean }>) { return <>{children}</>; }
export function TooltipContent({ children }: PropsWithChildren) { return <span className="tooltip-content">{children}</span>; }
