export function getRecoveryQueue() {
  return [
    { id: "pay_r1", customer: "Rahul", amount: 249900, reason: "Bank error", action: "RECOVER" },
    { id: "pay_r2", customer: "Priya", amount: 89900, reason: "Abandoned", action: "RECOVER" },
    { id: "pay_r3", customer: "Aman", amount: 499900, reason: "Timeout", action: "REVIEW" },
    { id: "pay_r4", customer: "Rohit", amount: 799900, reason: "Declined", action: "STOP" },
  ]
}
