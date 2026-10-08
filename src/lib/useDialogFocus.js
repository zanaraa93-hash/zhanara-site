import { useEffect } from "react";

// Moves focus into a dialog when it opens and returns it to the element that
// opened it when it closes, so keyboard users don't lose their place.
export function useDialogFocus(open, targetRef) {
  useEffect(() => {
    if (!open) return undefined;
    const previous = document.activeElement;
    targetRef.current?.focus();
    return () => {
      // Skip when focus already moved on, e.g. into a dialog stacked on top.
      // A focused element inside the just-hidden dialog still counts as lost:
      // browsers move focus off hidden elements only on the next frame.
      const active = document.activeElement;
      if (active && active !== document.body && active.isConnected && !active.closest("[hidden]")) return;
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [open, targetRef]);
}
