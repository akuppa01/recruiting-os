# Evidence bank

Recruiting OS may only put text on a resume that comes from a verified `EvidenceItem` (see `packages/core/src/domain.ts`).
Nothing here is invented. Until you supply real items, tailoring will refuse to run and raise a `missing_profile_field` exception.

## How to supply it
1. Put your resume (PDF/DOCX) and supporting docs in `resumes/evidence/private/` (git-ignored).
2. Create `resumes/evidence/private/<anything>.json` containing an array of items:
```json
[{ "id": "slug", "employer": "...", "role": "...", "dates": "Jul 2023 – May 2025",
   "statement": "bullet copied from your resume",
   "metrics": ["7 teams"], "tags": ["cicd","leadership"],
   "verifiedBy": "resume", "sourceDoc": "resume-2026-10.pdf" }]
```
3. Create `resumes/evidence/private/profile.json`: `{ "name", "email", "phone", "linkedin", "location", "education": ["line", ...] }` (used for the resume header and application forms).
4. `statement` must be verbatim from a document you wrote; set `verifiedBy` to `resume`, `supporting_doc`, or `user_confirmed`.

Files named `*.synthetic.json` (or containing `"_synthetic": true`) are test fixtures; the loader refuses them for real tailoring.
