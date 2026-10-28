/** Ctrl/⌘/Shift/Alt-click or a non-left button: let the browser open the link in a new tab or window. */
export function opensElsewhere(e: {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): boolean {
  return e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;
}
