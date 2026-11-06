export interface ContactCandidate {
  name: string;
  title: string | null;
  email: string | null;
  linkedinUrl: string | null;
  source: string;                 // provider name or "manual"
  education?: string[];           // e.g. ["Carnegie Mellon University"]
  pastEmployers?: string[];       // e.g. ["Lockheed Martin"]
  providerRef?: string;           // provider-side id for later enrichment
}

export interface ContactQuery {
  domain: string;
  companyName: string;
  titles: string[];               // title keywords to search
  limit?: number;
}

export interface ContactProvider {
  name: string;
  /** false when credentials are absent; callers must not treat an empty result as "no contacts exist". */
  isConfigured(): boolean;
  search(q: ContactQuery): Promise<ContactCandidate[]>;
}

export type ContactTier = "hiring_manager" | "recruiter" | "functional_leader" | "peer" | "other";
export interface RankedContact { contact: ContactCandidate; score: number; tier: ContactTier; reasons: string[] }
export interface JobForRanking { title: string; roleCategory?: string }
