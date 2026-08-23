// The ONE place a human touches when a table needs special handling in the
// admin dashboard's generic entity browser. Every table NOT listed here
// just works automatically: read at 'support'+, write at 'super_admin'.
//
// When you add a new backend table:
//   - do nothing → it appears in the Database nav automatically
//   - add an entry here ONLY to exclude it, mask sensitive columns, change
//     its required roles, or route navigation to a custom module.

module.exports = {
  // never returned by generic read endpoints, never editable
  sensitiveColumns: [
    'password_hash',
    'token', 'token_hash', 'refresh_token',
    'expo_push_token',
  ],

  // tables hidden from the generic browser entirely (internal plumbing)
  excluded: [
    'admin_refresh_tokens', // pure token storage — nothing to browse
    'schema_migrations',
  ],

  // per-table overrides; anything unlisted defaults to
  // { readRole: 'support', writeRole: 'super_admin' }
  tables: {
    admin_users: { readRole: 'super_admin', writeRole: 'super_admin' },
    admin_audit_log: { readRole: 'super_admin', writeRole: null }, // append-only
    refresh_tokens: { readRole: 'super_admin', writeRole: 'super_admin' },
    push_tokens: { readRole: 'super_admin', writeRole: 'super_admin' },
    trainer_invite_codes: { readRole: 'super_admin', writeRole: null },
    session_exercise_details: { readRole: 'support', writeRole: null },
    session_summaries: { readRole: 'support', writeRole: null },
    measurement_entries: { readRole: 'support', writeRole: null },
    push_log: { readRole: 'support', writeRole: null },
    purge_job_runs: { readRole: 'support', writeRole: null },
    content_reports: { readRole: 'content_moderator', writeRole: 'content_moderator' },
    feature_flags: { readRole: 'support', writeRole: 'super_admin' },
    meal_catalog_items: { readRole: 'content_moderator', writeRole: 'content_moderator' },
    workout_templates: { readRole: 'content_moderator', writeRole: 'content_moderator' },
  },

  // navigation routes to a purpose-built module instead of the generic
  // grid when one exists (generic view stays reachable for debugging)
  customModules: {
    users: 'Users',                 // Phase 4
    trainer_clients: 'Relationships',
    meal_catalog_items: 'Content',
    workout_templates: 'Content',
    content_reports: 'Content',
    feature_flags: 'Feature Flags',
  },
};
