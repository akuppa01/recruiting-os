// LOCAL MOCK FORMS (not real ATS pages). Static HTML served by a local node server; POST /hit counts real submissions.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const sel = (id: string, label: string, opts: string[], required = false) => `
<div class="select"><label for="${id}">${label}${required ? " *" : ""}</label>
  <input id="${id}" name="${id}" type="text" role="combobox" aria-haspopup="listbox" autocomplete="off"${required ? " required" : ""}>
  <div class="select__menu" hidden>${opts.map((o, i) => `<div id="react-select-${id}-option-${i}" class="select__option">${o}</div>`).join("")}</div></div>`;

const COMBO_JS = `document.querySelectorAll('.select').forEach(function(s){var i=s.querySelector('input'),m=s.querySelector('.select__menu');
 i.addEventListener('click',function(){m.hidden=false});
 m.querySelectorAll('.select__option').forEach(function(o){o.addEventListener('click',function(){i.value=o.textContent.trim();m.hidden=true;i.dispatchEvent(new Event('input',{bubbles:true}))})})});`;

const shell = (body: string, o: { confirm?: string; validate?: string; script?: string } = {}) => `<!doctype html><html><body>${body}<script>
${COMBO_JS}
${o.script ?? ""}
var f=document.querySelector('form'); if(f) f.addEventListener('submit',async function(e){e.preventDefault();
 ${o.validate ?? ""}
 await fetch('/hit',{method:'POST'}); ${o.confirm ?? ""} });
</script></body></html>`;

const thanks = (t: string) => `document.body.innerHTML='<h1>${t}</h1>';`;

const std = `
<label for="fn">First Name *</label><input id="fn" name="first_name" required>
<label for="ln">Last Name *</label><input id="ln" name="last_name" required>
<label for="em">Email *</label><input id="em" name="email" type="email" required>
<label for="ph">Phone</label><input id="ph" name="phone">
<label for="li">LinkedIn Profile</label><input id="li" name="urls[LinkedIn]">
<label for="rs">Resume/CV *</label><input id="rs" name="resume" type="file" required>`;

export const mockForms: Record<string, string> = {
  // Greenhouse-style: react-select-like comboboxes for eligibility + EEO questions.
  gh_style: shell(`<form>${std}
    ${sel("sp", "Do you require visa sponsorship?", ["Yes", "No"], true)}
    ${sel("gd", "Gender", ["Male", "Female", "Decline To Self Identify"])}
    <button type="submit">Submit application</button></form>`, { confirm: thanks("Thank you for applying!") }),

  lever_style: shell(`<form>
    <label for="nm">Full name *</label><input id="nm" name="name" required>
    <label for="em">Email *</label><input id="em" name="email" type="email" required>
    <label for="ph">Phone</label><input id="ph" name="phone">
    <label for="li">LinkedIn URL</label><input id="li" name="urls[LinkedIn]">
    <label for="rs">Resume/CV *</label><input id="rs" name="resume" type="file" required>
    <button type="submit">Submit application</button></form>`, { confirm: thanks("Application submitted!") }),

  ashby_style: shell(`<form>
    <label for="nm">Name *</label><input id="nm" name="_systemfield_name" required>
    <label for="em">Email *</label><input id="em" name="_systemfield_email" type="email" required>
    <label for="rs">Resume *</label><input id="rs" name="_systemfield_resume" type="file" required>
    <button type="submit">Submit Application</button></form>`, { confirm: thanks("Your application was successfully submitted.") }),

  // Multipage: page 2 (and the submit button) stay hidden until Next is clicked.
  multipage: shell(`<form>
    <div id="p1"><label for="fn">First Name *</label><input id="fn" name="first_name" required>
      <label for="ln">Last Name *</label><input id="ln" name="last_name" required>
      <label for="em">Email *</label><input id="em" name="email" type="email" required>
      <button type="button" id="next">Next</button></div>
    <div id="p2" style="display:none"><label for="ph">Phone</label><input id="ph" name="phone">
      <label for="li">LinkedIn Profile</label><input id="li" name="urls[LinkedIn]">
      <label for="rs">Resume/CV *</label><input id="rs" name="resume" type="file" required>
      <button type="submit">Submit application</button></div></form>`,
    { confirm: thanks("Thank you for applying!"), script: `document.getElementById('next').addEventListener('click',function(){document.getElementById('p1').style.display='none';document.getElementById('p2').style.display='block'});` }),

  // Resume control is a styled Attach button wrapping a transparent file input; the page shows the chosen file name.
  resume_upload: shell(`<form>
    <label for="fn">First Name *</label><input id="fn" name="first_name" required>
    <label for="ln">Last Name *</label><input id="ln" name="last_name" required>
    <label for="em">Email *</label><input id="em" name="email" type="email" required>
    <div>Resume/CV * <label class="btn">Attach<input id="rs" type="file" name="resume" required style="opacity:0;position:absolute;width:1px;height:1px"></label> <span id="fname"></span></div>
    <button type="submit">Submit application</button></form>`,
    { confirm: thanks("Thank you for applying!"), script: `document.getElementById('rs').addEventListener('change',function(e){document.getElementById('fname').textContent=e.target.files[0]?e.target.files[0].name:''});` }),

  // The page rejects the phone number (needs 10 digits): no submission, no confirmation, field flagged aria-invalid.
  validation_fail: shell(`<form>${std}<p class="error" id="err" hidden>Phone must have 10 digits</p><button type="submit">Submit application</button></form>`,
    { confirm: thanks("Thank you for applying!"), validate: `var p=document.getElementById('ph'); if(p.value.replace(/\\D/g,'').length!==10){p.setAttribute('aria-invalid','true');document.getElementById('err').hidden=false;return;}` }),

  // Unfamiliar required question whose wording matches no saved-answer pattern.
  unknown_custom: shell(`<form>${std}<label for="oc">Can you work on site three days weekly? *</label><input id="oc" name="q_onsite" required>
    <button type="submit">Submit application</button></form>`, { confirm: thanks("Thank you for applying!") }),

  // The same question on a widget plain Playwright cannot type into (readonly; a script-driven picker).
  custom_widget: shell(`<form>${std}<label for="oc">Can you work on site three days weekly? *</label><input id="oc" name="q_onsite" required readonly data-widget="1">
    <button type="submit">Submit application</button></form>`, { confirm: thanks("Thank you for applying!") }),

  // Required sensitive question the profile has no saved answer for.
  disability_required: shell(`<form>${std}<label for="ds">Do you have a disability? *</label><input id="ds" name="q_disability" required>
    <button type="submit">Submit application</button></form>`, { confirm: thanks("Thank you for applying!") }),
};

export interface FormServer { base: string; hits(): number; reset(): void; close(): Promise<void> }
export async function startFormServer(extra: Record<string, string> = {}): Promise<FormServer> {
  let hits = 0;
  const all = { ...mockForms, ...extra };
  const server: Server = createServer((req, res) => {
    if (req.url === "/hit") { hits++; res.writeHead(204).end(); return; }
    const name = (req.url ?? "").replace(/^\//, "").split("?")[0] ?? "";
    res.writeHead(all[name] ? 200 : 404, { "content-type": "text/html" }).end(all[name] ?? "not found");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, hits: () => hits, reset: () => { hits = 0; }, close: () => new Promise<void>((r) => server.close(() => r())) };
}
