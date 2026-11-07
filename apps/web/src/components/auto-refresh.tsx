"use client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Re-reads the server data every few seconds while the tab is visible, so worker transitions appear without a manual reload. */
export function AutoRefresh({ everySeconds = 30 }: { everySeconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => { if (document.visibilityState === "visible") router.refresh(); }, everySeconds * 1000);
    return () => clearInterval(id);
  }, [router, everySeconds]);
  return null;
}
