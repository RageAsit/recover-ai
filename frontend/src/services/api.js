/**
 * RecoverAI API URL helper.
 *
 * In local development, VITE_API_BASE_URL is typically empty, so apiUrl("/api/...")
 * returns "/api/..." and relies on the Vite dev proxy.
 *
 * In a decoupled or production deployment (e.g., Vercel + Render), setting
 * VITE_API_BASE_URL="https://recover-ai-api.onrender.com" prefixes all API requests.
 */
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/+$/, "");

export function apiUrl(path = "") {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${API_BASE_URL}${normalizedPath}`;
}
