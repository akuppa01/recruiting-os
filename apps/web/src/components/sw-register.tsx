"use client";
import { useEffect } from "react";

// Registers the service worker only (installability). Does NOT subscribe to push; that needs VAPID keys.
export function SwRegister() {
  useEffect(() => {
    if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") navigator.serviceWorker.register("/sw.js").catch(() => {});
  }, []);
  return null;
}
