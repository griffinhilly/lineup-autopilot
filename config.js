// config.js — public settings only (written by lineup-autopilot-jobs/scripts/setup.mjs). Nothing here is secret:
// the Supabase URL and publishable key are meant for browsers; the public key only encrypts sign-ins for the GitHub job.
window.LINEUP_CONFIG = {
  supabaseUrl: null,
  supabaseKey: null,
  connectPublicKey: null,
};
