/**
 * Wires the cookie-based session resolver into lib/auth.ts.
 * Import this module from any server-side entry point (e.g. handlers.ts)
 * so the resolver is registered before authenticate() is called.
 */
import { setSessionResolver } from "./auth";
import { getSessionCtx } from "./session-ctx";

setSessionResolver(async () => getSessionCtx());
