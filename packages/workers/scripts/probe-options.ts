// Debug helper: open a form, and for every dropdown print its question and options. Never fills or submits.
import { chromium } from "playwright";
import { scanForm } from "../src/apply/browser.ts";

async function main() {
  const url = process.argv[2]!;
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext()).newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => undefined);
  await page.waitForTimeout(1500);
  const src = await page.evaluate(() => { const f = Array.from(document.querySelectorAll("iframe")).find((i) => /greenhouse\.io/.test(i.src)); return f ? f.src : null; });
  if (src) {
    await page.goto(src, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => undefined);
    await page.waitForTimeout(1500);
  }
  const fields = await scanForm(page);
  for (const f of fields) {
    if (f.type === "file") {
      const ctx = await page.locator(f.selector).evaluate((el) => {
        let n: HTMLElement | null = el as HTMLElement;
        for (let i = 0; i < 6; i++) { n = n?.parentElement ?? null; const t = n?.innerText?.trim() ?? ""; if (t.length > 30) return t.replace(/\s+/g, " ").slice(0, 140); }
        return "";
      }).catch(() => "");
      console.log(`FILE  ${f.selector} label="${f.label}" required=${f.required} ctx="${ctx}"`); continue;
    }
    if (!f.combo && f.tag !== "select") continue;
    const q = f.group || f.label;
    if (f.tag === "select") { console.log(`SELECT "${q.slice(0, 90)}": ${f.options.slice(0, 14).join(" | ")}`); continue; }
    try {
      await page.locator(f.selector).click({ timeout: 4000 });
      await page.waitForTimeout(500);
      const opts = await page.locator('[role="option"], [id*="-option-"], [class*="__option"] >> visible=true').allInnerTexts();
      console.log(`COMBO "${q.slice(0, 90)}": ${opts.map((o) => o.trim()).slice(0, 16).join(" | ")}`);
      await page.keyboard.press("Escape");
    } catch (e) { console.log(`COMBO "${q.slice(0, 90)}": (could not open)`); }
  }
  await browser.close();
}
main();
