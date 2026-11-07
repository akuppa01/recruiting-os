// Debug helper: open a form, print what the scanner sees, save a screenshot. Never fills or submits.
import { chromium } from "playwright";
import { scanForm } from "../src/apply/browser.ts";
const url = process.argv[2]!;
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext()).newPage();
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => undefined);
await page.waitForTimeout(1500);
const fields = await scanForm(page);
for (const f of fields) console.log(`${f.index}\t${f.tag}/${f.type}\treq=${f.required}\tcls=${JSON.stringify(f.cls)}\tgroup="${f.group}"\tlabel="${f.label.slice(0, 70)}"\tcombo=${f.combo}`);
await page.screenshot({ path: process.argv[3] ?? "/tmp/probe.png", fullPage: true });
console.log("final url:", page.url(), "| fields:", fields.length);
await browser.close();
