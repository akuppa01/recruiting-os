import type { Page } from "playwright";
import { classifyField, type FieldClass } from "./fields.js";

export interface ScannedField {
  index: number; selector: string; tag: string; type: string; name: string; label: string; required: boolean; cls: FieldClass;
}

/** Inspect visible form controls. Selectors are positional data-ros-idx attributes we stamp on the element. */
export async function scanForm(page: Page): Promise<ScannedField[]> {
  const raw = await page.evaluate(() => {
    const out: any[] = [];
    const els = Array.from(document.querySelectorAll("input, select, textarea")) as HTMLInputElement[];
    els.forEach((el, i) => {
      const type = (el.getAttribute("type") ?? el.tagName.toLowerCase()).toLowerCase();
      if (["hidden", "submit", "button", "image", "reset"].includes(type)) return;
      const style = getComputedStyle(el);
      const isFile = type === "file";
      if (!isFile && (style.display === "none" || style.visibility === "hidden")) return;
      el.setAttribute("data-ros-idx", String(i));
      const id = el.id;
      const lab = (id && document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent) || el.closest("label")?.textContent
        || el.getAttribute("aria-label") || el.closest("div,fieldset,li")?.querySelector("label,legend")?.textContent || el.getAttribute("placeholder") || "";
      const required = el.required || el.getAttribute("aria-required") === "true" || /\*\s*$/.test(lab.trim());
      out.push({ index: i, tag: el.tagName.toLowerCase(), type, name: el.getAttribute("name") ?? el.id ?? "", label: lab.replace(/\s+/g, " ").replace(/\*/g, "").trim(), required });
    });
    return out;
  });
  return raw.map((r: any) => ({ ...r, selector: `[data-ros-idx="${r.index}"]`, cls: classifyField(r.label, r.name, r.type) }));
}

export interface BlockerReport { captcha: boolean; authWall: boolean; details: string[] }

/** Detect things we must NOT work around. */
export async function detectBlockers(page: Page): Promise<BlockerReport> {
  const r = await page.evaluate(() => {
    const d: string[] = [];
    const html = document.documentElement.outerHTML.toLowerCase();
    const captcha = !!document.querySelector(".g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey], iframe[src*='recaptcha'], iframe[src*='hcaptcha'], iframe[src*='turnstile']")
      || /g-recaptcha|h-captcha|cf-turnstile/.test(html);
    if (captcha) d.push("captcha widget present");
    const text = (document.body?.innerText ?? "").toLowerCase();
    const hasPassword = !!document.querySelector("input[type=password]");
    const authText = /(sign in|log in|login) to (apply|continue)|create an account to apply|you must be logged in/.test(text);
    const authWall = hasPassword || authText;
    if (authWall) d.push(hasPassword ? "password field present" : "login required text");
    return { captcha, authWall, details: d };
  });
  return r;
}

export async function pageText(page: Page): Promise<string> {
  return (await page.evaluate(() => document.body?.innerText ?? "")).toString();
}
