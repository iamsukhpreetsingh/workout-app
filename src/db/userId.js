let currentUserId = null;

export function setCurrentUserId(userId) {
  currentUserId = userId;
}

export function getCurrentUserId() {
  return currentUserId;
}
