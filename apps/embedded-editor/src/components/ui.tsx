import type { ButtonHTMLAttributes } from "react";
export function Button({ size: _size, variant: _variant, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { size?: string; variant?: string }) { return <button {...props} />; }
export function Spinner({ className }: { className?: string }) { return <span className={className} aria-hidden="true">◌</span>; }
