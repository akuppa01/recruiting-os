import PDFDocument from "pdfkit";
import type { ResumeContent } from "./verify.js";

/** ATS-friendly: single column, standard font, real text (no images/tables/columns), simple headings. */
export function renderResumePdf(c: ResumeContent, opts: { compress?: boolean } = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margins: { top: 48, bottom: 48, left: 54, right: 54 }, compress: opts.compress ?? true, info: { Title: `${c.name} Resume`, Author: c.name } });
    const chunks: Buffer[] = [];
    doc.on("data", (d: Buffer) => chunks.push(d)); doc.on("end", () => resolve(Buffer.concat(chunks))); doc.on("error", reject);
    const heading = (t: string) => { doc.moveDown(0.6).font("Helvetica-Bold").fontSize(11).text(t.toUpperCase()); doc.moveTo(54, doc.y).lineTo(558, doc.y).lineWidth(0.5).stroke(); doc.moveDown(0.3); };
    doc.font("Helvetica-Bold").fontSize(18).text(c.name || "Candidate", { align: "center" });
    if (c.contact.length) doc.font("Helvetica").fontSize(9.5).text(c.contact.join("  |  "), { align: "center" });
    if (c.education.length) { heading("Education"); doc.font("Helvetica").fontSize(10); c.education.forEach((e) => doc.text(e)); }
    heading("Experience");
    for (const s of c.sections) {
      doc.font("Helvetica-Bold").fontSize(10.5).text(`${s.employer} — ${s.role}`, { continued: true }).font("Helvetica").text(`   ${s.dates}`, { align: "right" });
      doc.font("Helvetica").fontSize(10);
      for (const b of s.bullets) doc.text(`• ${b.text}`, { indent: 10, paragraphGap: 2 });
      doc.moveDown(0.4);
    }
    doc.end();
  });
}
