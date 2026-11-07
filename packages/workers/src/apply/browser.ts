import type { Page } from "playwright";
import { classifyField, type FieldClass } from "./fields.js";

export interface ScannedField {
  index: number; selector: string; tag: string; type: string; name: string; label: string; group: string; options: string[]; combo: boolean; required: boolean; cls: FieldClass;
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
      if (!isFile && el.getAttribute("aria-hidden") === "true") return;
      el.setAttribute("data-ros-idx", String(i));
      const id = el.id;
      const lab = (id && document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent) || el.closest("label")?.textContent
        || el.getAttribute("aria-label") || el.closest("div,fieldset,li")?.querySelector("label,legend")?.textContent || el.getAttribute("placeholder") || "";
      const required = el.required || el.getAttribute("aria-required") === "true" || /\*\s*$/.test(lab.trim());
      const isChoice = type === "radio" || type === "checkbox";
      const group = isChoice
        ? (el.closest("fieldset")?.querySelector("legend")?.textContent || el.closest('[role="radiogroup"],[role="group"]')?.getAttribute("aria-label")
          || el.closest("div")?.parentElement?.querySelector("legend,label")?.textContent || "")
        : "";
      const options = el.tagName === "SELECT" ? Array.from((el as unknown as HTMLSelectElement).options).map((o) => o.text.trim()) : [];
      const combo = el.getAttribute("role") === "combobox" || el.getAttribute("aria-haspopup") === "listbox";
      out.push({ index: i, tag: el.tagName.toLowerCase(), type, name: el.getAttribute("name") ?? el.id ?? "", label: lab.replace(/\s+/g, " ").replace(/\*/g, "").trim(),
        group: group.replace(/\s+/g, " ").replace(/\*/g, "").trim(), options, combo, required: required || (isChoice && /\*\s*$/.test(group.trim())) });
    });
    return out;
  });
  return raw.map((r: any) => ({ ...r, selector: `[data-ros-idx="${r.index}"]`, cls: classifyField(r.group || r.label, r.name, r.type) }));
}

export interface BlockerReport { captcha: boolean; authWall: boolean; details: string[] }

/** Detect things we must NOT work around. */
export async function detectBlockers(page: Page): Promise<BlockerReport> {
  const r = await page.evaluate(() => {
    const d: string[] = [];
    const html = document.documentElement.outerHTML.toLowerCase();
    const widgets = Array.from(document.querySelectorAll(".g-recaptcha, .h-captcha, .cf-turnstile, iframe[src*='recaptcha'], iframe[src*='hcaptcha'], iframe[src*='turnstile']")).filter((el) => !el.closest(".grecaptcha-badge"));
    const captcha = widgets.some((el) => {
      const r = (el as HTMLElement).getBoundingClientRect(); const st = getComputedStyle(el as HTMLElement);
      return r.width > 60 && r.height > 40 && st.visibility !== "hidden" && st.display !== "none";
    });
    if (captcha) d.push("visible captcha challenge present");
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
