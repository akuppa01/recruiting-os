// Handler wiring by dependency injection. The discovery, qualify and apply modules are built by other workstreams; this file
// depends only on function types, never on their files. Whoever wires the app passes the real functions in.
import { TaskKind, type TaskHandler } from "@ros/core";
import { NotWiredError, type HandlerRegistry } from "./types.js";

export interface DefaultHandlerDeps {
  discover?: TaskHandler;
  ingest?: TaskHandler;
  qualify?: TaskHandler;
  tailor?: TaskHandler;
  apply?: TaskHandler;
  verify?: TaskHandler;
  outreach?: TaskHandler;
}

export interface DefaultHandlers { handlers: HandlerRegistry; wired: TaskKind[]; unwired: TaskKind[] }

/**
 * Every kind gets a handler. Kinds without an injected implementation get a placeholder that throws NotWiredError, which the
 * runner pushes back with a long delay (it never marks the task failed or lets it run as if it had succeeded).
 * Run workers with `kinds: wired` so unwired work simply stays queued.
 */
export function createDefaultHandlers(deps: DefaultHandlerDeps = {}): DefaultHandlers {
  const handlers: HandlerRegistry = {};
  const wired: TaskKind[] = [], unwired: TaskKind[] = [];
  for (const kind of TaskKind.options) {
    const impl = deps[kind];
    if (impl) { handlers[kind] = impl; wired.push(kind); }
    else { handlers[kind] = async () => { throw new NotWiredError(kind); }; unwired.push(kind); }
  }
  return { handlers, wired, unwired };
}
