// LOCAL TEST FIXTURES (not real ATS pages)
export const page = (body: string, extra = "") => `<!doctype html><html><body>${body}<script>
const f=document.querySelector('form'); if(f) f.addEventListener('submit',async e=>{e.preventDefault();await fetch('/hit',{method:'POST'});${extra}});
</script></body></html>`;
export const base = `
<label for="fn">First name *</label><input id="fn" name="first_name" required>
<label for="ln">Last name *</label><input id="ln" name="last_name" required>
<label for="em">Email *</label><input id="em" name="email" type="email" required>
<label for="ph">Phone</label><input id="ph" name="phone">
<label for="li">LinkedIn Profile</label><input id="li" name="urls[LinkedIn]">
<label for="rs">Resume/CV *</label><input id="rs" name="resume" type="file" required>`;
const confirm = `document.body.innerHTML='<h1>Thank you for applying!</h1><p>Your application has been submitted.</p>';`;
export const forms = {
  ok: page(`<form>${base}<button type="submit">Submit application</button></form>`, confirm),
  noconfirm: page(`<form>${base}<button type="submit">Submit application</button></form>`, ``),
  captcha: page(`<form>${base}<div class="g-recaptcha" data-sitekey="x"></div><button type="submit">Submit application</button></form>`, confirm),
  auth: page(`<h2>Sign in to apply</h2><input type="email"><input type="password"><button>Log in</button>`),
  sensitive_required: page(`<form>${base}<label for="sp">Will you now or in the future require visa sponsorship? *</label><input id="sp" name="q1" required><button type="submit">Submit application</button></form>`, confirm),
  sensitive_optional: page(`<form>${base}<label for="vt">Veteran Status</label><input id="vt" name="eeo_veteran"><label for="gd">Gender</label><input id="gd" name="eeo_gender"><button type="submit">Submit application</button></form>`, confirm),
  unknown_required: page(`<form>${base}<label for="q">What is your favorite color? *</label><input id="q" name="q9" required><button type="submit">Submit application</button></form>`, confirm),
} as Record<string, string>;
