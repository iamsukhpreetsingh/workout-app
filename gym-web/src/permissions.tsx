// Gym permission context: resolved server-side via GET /gym/:id/permissions
// for the selected gym. Nav visibility and route guards read this; the
// backend remains the authority on every request.
import React, { createContext, useContext } from 'react';
import { GymPermissions } from './api';

export const GymContext = createContext<{
  gymId: string;
  role: string;
  permissions: string[];
} | null>(null);

export function useGymContext() {
  return useContext(GymContext);
}

export function hasPermission(ctx: { permissions: string[] } | null, ...anyOf: string[]) {
  if (!ctx) return false;
  return anyOf.some((p) => ctx.permissions.includes(p));
}

export type { GymPermissions };
