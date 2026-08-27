export async function getRecoveryQueue() {
  const response = await fetch("/api/recovery")
  if (!response.ok) {
    throw new Error("Failed to load recovery queue")
  }
  return response.json()
}
