import { apiUrl } from "./api";

export async function getPayments({ status = "all", limit = 50, signal } = {}) {
  const params = new URLSearchParams()
  if (status && status !== "all") params.set("status", status)
  if (limit) params.set("limit", String(limit))

  const url = apiUrl(`/api/payments${params.toString() ? `?${params.toString()}` : ""}`)
  const response = await fetch(url, { signal })
  const data = await response.json()
  if (!response.ok) {
    throw new Error(data.message || "Failed to load payments")
  }
  return data
}

