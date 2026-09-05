import { apiUrl } from "./api";

// The UI NEVER sends execute:true to the run route. Decision and dispatch are
// two separate user actions against two separate endpoints. The run route
// creates an attempt row, and both "allowed" and "executed" count toward the
// budget - so dispatching via the run route would spend a second attempt to
// send one link. Dispatch goes through the approve endpoint, which acts on the
// attempt that already exists and consumes no budget.

export async function getRecoveryQueue() {
  const response = await fetch(apiUrl("/api/recovery"))
  if (!response.ok) {
    throw new Error("Failed to load recovery queue")
  }
  return response.json()
}

export async function getRecoveryActivity(limit = 50) {
  const response = await fetch(apiUrl(`/api/recovery/activity?limit=${limit}`))
  if (!response.ok) {
    throw new Error("Failed to load agent activity")
  }
  return response.json()
}

export async function runAgent(razorpayPaymentId) {
  const response = await fetch(apiUrl(`/api/recovery/${razorpayPaymentId}/run`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ execute: false }),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.message || "Failed to run agent")
  return data
}

export async function approveAttempt(attemptId) {
  const response = await fetch(apiUrl(`/api/recovery/attempts/${attemptId}/execute`), {
    method: "POST",
  })
  const data = await response.json()
  // The endpoint returns 200 with success:false for a recorded refusal
  // (payment no longer at risk, no contact details). That is a real outcome,
  // not a transport error, so do not throw on it - return it and let the UI show it.
  if (!response.ok) throw new Error(data.message || "Failed to dispatch")
  return data
}

export async function getPaymentDetail(razorpayPaymentId, signal) {
  const response = await fetch(apiUrl(`/api/recovery/payments/${razorpayPaymentId}`), { signal })
  const data = await response.json()
  if (!response.ok) {
    throw new Error(data.message || "Failed to load payment detail")
  }
  return data
}

