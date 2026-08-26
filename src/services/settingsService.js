/**
 * User-settings data service.
 *
 * Single access point for user settings (units, theme, streak tolerance,
 * progression formula, …). UI code must import from here, never from
 * `../db/*` directly. Thin facade over the local SQLite module.
 */
export { getSettings, updateSettings } from '../db/settings';
