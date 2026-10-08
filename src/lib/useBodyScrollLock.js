import { useEffect } from "react";

export function useBodyScrollLock(locked) {
  useEffect(() => {
    if (!locked) return undefined;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, [locked]);
}
