// Builds the scheduled source set. Manual/CSV/WhatsApp are on-demand (see imports.ts) and are not part of scheduled runs.
import type { SourceAdapter } from "@ros/core";
import type { GmailResult } from "../gmail/connector.js";
import { createEmailAdapter, type EmailSourceId } from "./email.js";
import { createFeedAdapter, type FeedBoard } from "./feeds.js";
import { createRemoteFeedAdapter } from "./remote.js";
import type { FetchLike } from "./util.js";

export interface BuildAdaptersOptions {
  boards: { greenhouse?: FeedBoard[]; lever?: FeedBoard[]; ashby?: FeedBoard[] };
  getGmail?: () => GmailResult | Promise<GmailResult>;
  fetchImpl?: FetchLike; extraLocations?: string[];
  /** Subset of sources to run (default: all configured). */
  only?: string[];
}

export function buildAdapters(o: BuildAdaptersOptions): SourceAdapter[] {
  const out: SourceAdapter[] = [];
  for (const kind of ["greenhouse", "lever", "ashby"] as const) {
    const boards = o.boards[kind];
    if (boards?.length) out.push(createFeedAdapter(kind, { boards, fetchImpl: o.fetchImpl, extraLocations: o.extraLocations }));
  }
  const getGmail = o.getGmail ?? (() => ({ connected: false as const, reason: "no Gmail connector provided" }));
  for (const id of ["handshake", "twelve_twenty", "linkedin_alert", "indeed_alert"] as EmailSourceId[]) out.push(createEmailAdapter(id, { getGmail }));
  out.push(createRemoteFeedAdapter({ fetchImpl: o.fetchImpl }));
  return o.only ? out.filter((a) => o.only!.includes(a.id)) : out;
}
