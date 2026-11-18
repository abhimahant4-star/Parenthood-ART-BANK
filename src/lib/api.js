const TOKEN_KEY = "pb_api_token";
const USER_KEY = "pb_api_user";
export const SESSION_CLEARED_EVENT = "pb:session-cleared";

export function readStoredSession() {
  try {
    const token = sessionStorage.getItem(TOKEN_KEY);
    const user = JSON.parse(localStorage.getItem(USER_KEY) || "null");
    return token && user ? { token, user } : null;
  } catch {
    return null;
  }
}

export function storeSession(token, user) {
  sessionStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearStoredSession() {
  sessionStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export async function apiRequest(path, { method = "GET", body, formData, responseType = "json" } = {}) {
  const token = sessionStorage.getItem(TOKEN_KEY);
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const response = await fetch(`/api${path}`, {
    method,
    headers,
    body: formData || (body === undefined ? undefined : JSON.stringify(body))
  });

  if (response.status === 401 && token) {
    clearStoredSession();
    window.dispatchEvent(new Event(SESSION_CLEARED_EVENT));
  }
  if (!response.ok) {
    let detail = {};
    try { detail = await response.json(); } catch { /* response may not be JSON */ }
    const error = new Error(detail.message || `Request failed (${response.status})`);
    error.status = response.status;
    error.code = detail.errorCode;
    error.data = detail.data;
    throw error;
  }
  return responseType === "blob" ? response.blob() : response.json();
}

export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function downloadFile(path, filename) {
  saveBlob(await apiRequest(path, { responseType: "blob" }), filename);
}

export function downloadAttachment(attachmentId, fileId, filename) {
  return downloadFile(`/attachments/${encodeURIComponent(attachmentId)}/files/${encodeURIComponent(fileId)}`, filename || "attachment");
}

// Loads several endpoints at once; one failure does not hide the others.
export async function loadAll(jobs) {
  const entries = Object.entries(jobs).filter(([, path]) => Boolean(path));
  const settled = await Promise.allSettled(entries.map(([, path]) => apiRequest(path)));
  const results = {};
  const errors = [];
  settled.forEach((outcome, index) => {
    const key = entries[index][0];
    if (outcome.status === "fulfilled") results[key] = outcome.value;
    else errors.push({ key, message: outcome.reason?.message || "Request failed" });
  });
  return { results, errors };
}
