import { apiUrl } from "./api";

/**
 * Service for RecoverAI Demo Mode and simulated payment workflow.
 * All endpoints are guarded by DEMO_MODE=true on the backend.
 */

export async function getDemoStatus() {
  try {
    const res = await fetch(apiUrl("/api/demo/status"));
    if (!res.ok) return { success: false, enabled: false };
    return res.json();
  } catch {
    return { success: false, enabled: false };
  }
}

export async function ensureDemoPayment() {
  const res = await fetch(apiUrl("/api/demo/payments/ensure"), {
    method: "POST",
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.message || "Failed to ensure demo payment");
  }
  return data;
}

export async function simulateCustomerPayment(attemptId) {
  const res = await fetch(apiUrl(`/api/demo/recovery-attempts/${attemptId}/payment`), {
    method: "POST",
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.message || "Failed to simulate payment");
  }
  return data;
}

export async function resetDemoPayment(razorpayPaymentId) {
  const res = await fetch(apiUrl(`/api/demo/payments/${razorpayPaymentId}/reset`), {
    method: "POST",
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.message || "Failed to reset demo payment");
  }
  return data;
}
