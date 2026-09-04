// Barrel: the app imports this module as `../api` (or `./api`). Each domain
// surface lives in its own file — add new endpoints to the matching module,
// not here. This file only re-exports.
export * from './client';
export * from './gyms';
export * from './members';
export * from './staff';
export * from './memberships';
export * from './billing';
export * from './attendance';
export * from './workouts';
export * from './nutrition';
export * from './assignments';
export * from './announcements';
