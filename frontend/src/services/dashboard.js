export async function getDashboardStats() {
  const response = await fetch("/api/dashboard")
  if (!response.ok) {
    throw new Error("Failed to load dashboard metrics")
  }
  return response.json()
}
