import { InMemoryStore } from "../src/memory.js";
import { storeConformance } from "./conformance.js";
storeConformance("InMemoryStore", () => new InMemoryStore());
