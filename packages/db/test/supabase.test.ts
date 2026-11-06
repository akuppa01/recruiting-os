import { SupabaseStore, createServiceClient, hasSupabaseEnv } from "../src/supabase.js";
import { storeConformance } from "./conformance.js";

// Runs ONLY when a real Supabase project is configured (NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)
// AND ROS_TEST_TENANTS_PROVISIONED=1 (conformance creates random tenant/user ids, which need auth.users rows).
// Otherwise the suite is reported as skipped — it has NOT been verified against a live database.
const live = hasSupabaseEnv() && process.env.ROS_TEST_TENANTS_PROVISIONED === "1";
storeConformance("SupabaseStore (live)", () => new SupabaseStore(createServiceClient()), { skip: !live });
