import { describe, it, expect } from "vitest";
import { extractFromText } from "../src/normalize/index.js";
describe("extractFromText labelled lines (regression: unanchored alternation)", () => {
  it("parses Company/Title/Location labels", () => {
    const r = extractFromText("Company: Acme Corp\nRole: Product Management Intern\nLocation: Austin, TX\nDetails...");
    expect(r.company).toBe("Acme Corp");
    expect(r.title).toBe("Product Management Intern");
    expect(r.location).toBe("Austin, TX");
  });
  it("does not match labels mid-line", () => {
    const r = extractFromText("We value role clarity: high\nThe position: open");
    expect(r.title).not.toBe("open");
    expect(r.title).not.toBe("high");
  });
});
