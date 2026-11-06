// Connection status is derived ONLY from which env vars are set. It means "configured", not "verified".
export interface IntegrationInfo { id: string; name: string; purpose: string; setupUrl: string; configured: boolean; steps: string }

export function getIntegrations(): IntegrationInfo[] {
  const e = process.env;
  const has = (...k: string[]) => k.every((x) => !!e[x]);
  return [
    { id: "supabase", name: "Supabase", purpose: "Database, sign-in and file storage.", setupUrl: "https://supabase.com/dashboard/new", configured: has("NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"), steps: "Create a project, then add its URL and keys in Vercel environment variables." },
    { id: "anthropic", name: "Anthropic API", purpose: "Research, scoring rationale and drafting.", setupUrl: "https://console.anthropic.com/settings/keys", configured: has("ANTHROPIC_API_KEY"), steps: "Create a key and add it as ANTHROPIC_API_KEY in Vercel. Never paste it into chat." },
    { id: "gmail", name: "Gmail", purpose: "Job alerts in, outreach out.", setupUrl: "https://console.cloud.google.com/apis/credentials", configured: has("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"), steps: "Create an OAuth client, enable the Gmail API, then authorize once." },
    { id: "n8n", name: "n8n", purpose: "Scheduled and durable workflows.", setupUrl: "https://app.n8n.cloud/register", configured: has("N8N_BASE_URL", "N8N_API_KEY"), steps: "Create an n8n instance and import the workflows from the repo." },
    { id: "push", name: "Push notifications", purpose: "Interview and reply alerts on your phone.", setupUrl: "https://ntfy.sh/app", configured: has("NTFY_TOPIC") || has("PUSHOVER_APP_TOKEN", "PUSHOVER_USER_KEY"), steps: "Pick a private ntfy topic name and set NTFY_TOPIC, then subscribe in the ntfy app." },
    { id: "contacts", name: "Contact finder", purpose: "Find recruiters and hiring managers.", setupUrl: "https://app.apollo.io/#/settings/integrations/api", configured: has("APOLLO_API_KEY") || has("SNOV_CLIENT_ID", "SNOV_CLIENT_SECRET"), steps: "Create an API key with Apollo or Snov and set CONTACT_PROVIDER." },
  ];
}
