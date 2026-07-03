import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

export const isSupabaseConfigured = () => {
  return SUPABASE_URL && SUPABASE_ANON_KEY &&
    !SUPABASE_URL.includes("PEGA_AQUI") &&
    !SUPABASE_ANON_KEY.includes("PEGA_AQUI");
};

export const supabase = isSupabaseConfigured()
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    })
  : null;
