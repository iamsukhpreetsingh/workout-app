import { api } from './api';

export async function fetchTags() {
  return api('/trainer/tags');
}

export async function fetchWorkoutTags() {
  return api('/trainer/tags/workout');
}

export async function fetchRecipeTags() {
  return api('/trainer/tags/recipe');
}

export async function createTag(name, category) {
  return api('/trainer/tags', { method: 'POST', body: { name, category } });
}

export async function updateTag(tagId, name) {
  return api(`/trainer/tags/${tagId}`, { method: 'PATCH', body: { name } });
}

export async function deleteTag(tagId) {
  return api(`/trainer/tags/${tagId}`, { method: 'DELETE' });
}

export async function checkTagInUse(tagId) {
  const result = await api(`/trainer/tags/${tagId}/in-use`);
  return result.in_use;
}