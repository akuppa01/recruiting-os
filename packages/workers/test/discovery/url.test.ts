import { describe, expect, it } from "vitest";
import { canonicalizeUrl, urlKey } from "../../src/discovery/index.js";

describe("canonicalizeUrl", () => {
  it("strips tracking params but keeps job-identifying ones", () => {
    expect(canonicalizeUrl("https://jobs.lever.co/acme/abc-123?utm_source=x&lever-source=Linkedin")).toBe("https://jobs.lever.co/acme/abc-123");
    expect(canonicalizeUrl("https://acme.com/careers/open?gh_jid=555&utm_medium=email&gclid=zzz")).toBe("https://acme.com/careers/open?gh_jid=555");
  });
  it("normalizes LinkedIn wrappers", () => {
    expect(canonicalizeUrl("https://www.linkedin.com/comm/jobs/view/4012345678?trackingId=abc&refId=def")).toBe("https://www.linkedin.com/jobs/view/4012345678");
  });
  it("normalizes Indeed links to the viewjob form", () => {
    expect(canonicalizeUrl("https://www.indeed.com/rc/clk?jk=abc123def456&fccid=9&vjs=3")).toBe("https://www.indeed.com/viewjob?jk=abc123def456");
  });
  it("keeps the Handshake school subdomain but drops the query", () => {
    expect(canonicalizeUrl("https://cmu.joinhandshake.com/jobs/9876543?ref=email")).toBe("https://cmu.joinhandshake.com/jobs/9876543");
  });
  it("drops fragments and trailing slashes; tolerates junk", () => {
    expect(canonicalizeUrl("https://Example.com/jobs/1/#apply")).toBe("https://example.com/jobs/1");
    expect(canonicalizeUrl("not a url")).toBe("not a url");
  });
});

describe("urlKey (identity across variants)", () => {
  it("same Handshake job via different hosts/paths", () => {
    expect(urlKey("https://cmu.joinhandshake.com/jobs/123")).toBe(urlKey("https://app.joinhandshake.com/stu/jobs/123?x=1"));
  });
  it("same Greenhouse job on the hosted board and on a custom career page", () => {
    expect(urlKey("https://job-boards.greenhouse.io/databricks/jobs/6883068002")).toBe(urlKey("https://databricks.com/company/careers/open-positions/job?gh_jid=6883068002"));
  });
  it("same LinkedIn job across wrappers", () => {
    expect(urlKey("https://www.linkedin.com/comm/jobs/view/42?x=1")).toBe(urlKey("https://www.linkedin.com/jobs/view/42"));
  });
  it("different jobs differ", () => {
    expect(urlKey("https://jobs.lever.co/acme/aaaa1111")).not.toBe(urlKey("https://jobs.lever.co/acme/bbbb2222"));
  });
});
