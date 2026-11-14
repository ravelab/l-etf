"use client";

import { useEffect, useState } from "react";

/** Tracks the `dark` class on `<html>`, which the theme toggle flips. Charts color their lines by it. */
export function useIsDarkTheme(): boolean {
  const [isDarkTheme, setIsDarkTheme] = useState(true);
  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    const syncTheme = () => setIsDarkTheme(root.classList.contains("dark"));
    syncTheme();
    const observer = new MutationObserver(syncTheme);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return isDarkTheme;
}
