// gymPermissions.js — THE permission matrix for the Gym Management System.
// Roles are GYM-SCOPED (gym_staff.gym_role / GYM_MEMBER), never global.
// The backend is the authority: the web portal may hide UI by role, but every
// /gym request is re-checked here against the caller's verified gym context.

const GYM_ROLES = ['OWNER', 'ADMIN', 'TRAINER', 'FRONT_DESK', 'MEMBER'];

const GYM_PERMISSIONS = {
  OWNER: [
    'gym.manage', 'staff.manage', 'audit.view',
    'members.view', 'members.create', 'members.manage',
    'plans.manage', 'memberships.view', 'memberships.manage',
    'payments.manage', 'attendance.manage', 'checkin.manage',
    'content.manage', 'communications.manage', 'reports.view', 'settings.manage',
    'assigned_members.view',
  ],
  ADMIN: [
    'members.view', 'members.create', 'members.manage',
    'memberships.view', 'memberships.manage',
    'attendance.manage', 'content.manage', 'communications.manage',
    'assigned_members.view',
  ],
  TRAINER: [
    'assigned_members.view', 'workouts.manage',
    'nutrition.manage', 'assignments.manage',
  ],
  FRONT_DESK: [
    'members.view', 'members.create', 'memberships.view', 'checkin.manage',
  ],
  MEMBER: [
    'own.profile.view', 'own.membership.view',
    'own.attendance.view', 'content.view',
  ],
};

function permissionsFor(gymRole) {
  return GYM_PERMISSIONS[gymRole] || [];
}

function hasPermission(gymRole, permission) {
  return permissionsFor(gymRole).includes(permission);
}

module.exports = { GYM_ROLES, GYM_PERMISSIONS, permissionsFor, hasPermission };
