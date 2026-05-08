'use strict';

const SUPABASE_URL = 'https://kzlovmcghswprasjaeeo.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt6bG92bWNnaHN3cHJhc2phZWVvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc1ODkyOTEsImV4cCI6MjA5MzE2NTI5MX0.aivqzUI4jpGgIMEpo6NMy8JL3iBxp49RqoCJU0NLOGE';

// Shared Supabase client (anon, for auth only)
const _sbClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function getAuthToken() {
  const { data: { session } } = await _sbClient.auth.getSession();
  return session?.access_token || null;
}

async function getCurrentUser() {
  const { data: { user } } = await _sbClient.auth.getUser();
  return user;
}

async function signInWithGoogle() {
  await _sbClient.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin + '/storyboard' }
  });
}

async function signOut() {
  await _sbClient.auth.signOut();
}

function onAuthStateChange(callback) {
  return _sbClient.auth.onAuthStateChange(callback);
}

async function apiFetch(path, options = {}) {
  const token = await getAuthToken();
  const res = await fetch(`/api/storyboard${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {})
    }
  });
  return res;
}

async function generateStoryboard({ scenario, genres, style, cutCount, referenceImageIds }) {
  const res = await apiFetch('/generate', {
    method: 'POST',
    body: JSON.stringify({ scenario, genres, style, cutCount, referenceImageIds })
  });
  return res.json();
}

async function getStatus(storyboardId) {
  const res = await apiFetch(`/${storyboardId}/status`);
  return res.json();
}

async function getStoryboard(storyboardId) {
  const res = await apiFetch(`/${storyboardId}`);
  return res.json();
}

async function listStoryboards({ page = 1, limit = 10 } = {}) {
  const res = await apiFetch(`/list?page=${page}&limit=${limit}`);
  return res.json();
}

async function deleteStoryboard(storyboardId) {
  const res = await apiFetch(`/${storyboardId}`, { method: 'DELETE' });
  return res.json();
}

async function uploadReference(file, onProgress) {
  const token = await getAuthToken();
  const formData = new FormData();
  formData.append('image', file);

  const res = await fetch('/api/storyboard/upload-reference', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: formData
  });
  return res.json();
}

async function getUserProfile() {
  const token = await getAuthToken();
  if (!token) return null;
  const res = await fetch('/api/user/profile', {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) return null;
  return res.json();
}

window.StoryboardAPI = {
  getAuthToken, getCurrentUser, signInWithGoogle, signOut, onAuthStateChange,
  generateStoryboard, getStatus, getStoryboard, listStoryboards, deleteStoryboard,
  uploadReference, getUserProfile
};
