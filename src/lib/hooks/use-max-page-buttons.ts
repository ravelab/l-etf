"use client";

import { useEffect, useState } from "react";

/**
 * Returns the maximum number of pagination page buttons to show without truncation,
 * based on current window width.
 */
export function useMaxPageButtons() {
  const [maxButtons, setMaxButtons] = useState(10);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const update = () => {
      const width = window.innerWidth;
      if (width >= 1280) {
        setMaxButtons(30);
      } else if (width >= 1024) {
        setMaxButtons(20);
      } else if (width >= 768) {
        setMaxButtons(15);
      } else {
        setMaxButtons(7);
      }
    };

    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  return maxButtons;
}
