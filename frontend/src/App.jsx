import { useState, useEffect, useRef, Fragment } from "react"
import { getDashboardStats } from "./services/dashboard"
import {
  getRecoveryQueue,
  getRecoveryActivity,
  getPaymentDetail,
  runAgent,
  approveAttempt,
} from "./services/recovery"
import {
  getDemoStatus,
  ensureDemoPayment,
  simulateCustomerPayment,
  resetDemoPayment,
} from "./services/demo"
import { getPayments } from "./services/payments"
import { formatRupees } from "./utils/format"

// Recovery QUEUE action vocabulary. See ATTEMPT_ACTION_LABEL below for the
// distinct RecoveryAttempt.action enum — the two maps must stay separate.
const ACTION_LABEL = { RECOVER: "Recover", REVIEW: "Review", STOP: "Stop" }
const ACTION_CLASS = { RECOVER: "good", REVIEW: "warn", STOP: "danger" }

const STATUS_CLASS = {
  executed: "good",
  allowed: "good",
  denied: "danger",
  failed: "danger",
  human_review: "warn",
  pending: "warn",
  succeeded: "good",
  captured: "good",
  recovered: "good",
}

const STATUS_LABEL = {
  pending: "Pending",
  allowed: "Allowed",
  denied: "Denied",
  human_review: "Human review",
  executed: "Executed",
  succeeded: "Succeeded",
  failed: "Failed",
  captured: "Captured",
  recovered: "Recovered",
}

// DISTINCT VOCABULARY from ACTION_LABEL above. The recovery QUEUE uses
// RECOVER/REVIEW/STOP; a RecoveryAttempt.action is one of
// CREATE_PAYMENT_LINK/RETRY/NO_ACTION/STOP/HUMAN_REVIEW. They overlap only on
// STOP, so reusing ACTION_LABEL here would yield undefined for four values and
// a plausible-but-wrong label for the fifth. Keep these two maps separate.
const ATTEMPT_ACTION_LABEL = {
  CREATE_PAYMENT_LINK: "Payment link",
  RETRY: "Retry",
  NO_ACTION: "No action",
  STOP: "Stop",
  HUMAN_REVIEW: "Human review",
}

const DECISION_LABEL = {
  ALLOW: "Allow",
  DENY: "Deny",
  HUMAN_REVIEW: "Review",
}

const DECISION_CLASS = {
  ALLOW: "good",
  DENY: "danger",
  HUMAN_REVIEW: "warn",
}

const VIEW_TITLE = {
  dashboard: "Dashboard",
  queue: "Recovery Queue",
  payments: "Payments",
  activity: "Agent Activity",
}

function formatActivityTime(iso) {
  if (!iso) return "—"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "—"
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  if (sameDay) return time
  // An audit row must never be ambiguous about WHICH DAY it happened.
  const date = d.toLocaleDateString([], { day: "2-digit", month: "short" })
  return `${date} ${time}`
}

/* ================================================================
   Inline SVG icons — no icon dependency needed
   ================================================================ */
function IconMenu() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <line x1="3" y1="5" x2="17" y2="5" />
      <line x1="3" y1="10" x2="17" y2="10" />
      <line x1="3" y1="15" x2="17" y2="15" />
    </svg>
  )
}

function IconRefresh() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.5 8a5.5 5.5 0 0 1 9.38-3.89L14 2v4h-4l2.12-2.12A3.5 3.5 0 0 0 4.5 8" />
      <path d="M13.5 8a5.5 5.5 0 0 1-9.38 3.89L2 14v-4h4l-2.12 2.12A3.5 3.5 0 0 0 11.5 8" />
    </svg>
  )
}

function IconCheck() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3.5 8.5 6.5 11.5 12.5 4.5" />
    </svg>
  )
}

function IconAlert() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <circle cx="8" cy="8" r="6.5" />
      <line x1="8" y1="4.5" x2="8" y2="9" />
      <circle cx="8" cy="11.5" r="0.75" fill="currentColor" />
    </svg>
  )
}

function IconPlay() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
      <polygon points="4,2 14,8 4,14" />
    </svg>
  )
}

function IconSpinner() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="spin-icon">
      <circle cx="8" cy="8" r="6" strokeOpacity="0.25" />
      <path d="M14 8a6 6 0 0 0-6-6" />
    </svg>
  )
}

/* ================================================================
   PaymentInspector — Shared between Queue and Payments views
   ================================================================ */
function PaymentInspector({
  selectedPaymentId,
  detailLoading,
  detailError,
  paymentDetail,
  inspectorBusy,
  inspectorError,
  inspectorDispatchResult,
  newlyCreatedAttempt,
  onRunAgent,
  onApprove,
  activeFilter,
}) {
  const isHiddenByFilter =
    activeFilter &&
    activeFilter !== "all" &&
    paymentDetail?.payment?.status &&
    paymentDetail.payment.status !== activeFilter

  return (
    <aside className="inspector-panel">
      {!selectedPaymentId || isHiddenByFilter ? (
        <div className="inspector-placeholder">
          <h3>Inspector</h3>
          <p>Select a payment to review details and recovery timeline.</p>
        </div>
      ) : detailLoading ? (
        <div className="inspector-placeholder">
          <h3>Inspector</h3>
          <p>Loading…</p>
        </div>
      ) : detailError ? (
        <div className="inspector-placeholder">
          <h3>Inspector</h3>
          <div className="error-banner">{detailError}</div>
        </div>
      ) : paymentDetail?.payment ? (
        <div className="inspector-content">
          <div className="inspector-header">
            <div className="inspector-header-left">
              <span className="inspector-badge">Inspector</span>
              <h3 className="inspector-title cell-mono">{paymentDetail.payment.id}</h3>
              <div className="inspector-amount">{formatRupees(paymentDetail.payment.amount)}</div>
            </div>
            <span
              className={`status-badge status-badge--${
                STATUS_CLASS[paymentDetail.payment.status] ?? "warn"
              }`}
            >
              {STATUS_LABEL[paymentDetail.payment.status] ?? paymentDetail.payment.status}
            </span>
          </div>

          <div className="inspector-grid">
            <div className="detail-field">
              <span className="detail-label">Method</span>
              <span className="detail-value">
                {paymentDetail.payment.method
                  ? paymentDetail.payment.method.toUpperCase()
                  : "—"}
              </span>
            </div>
            <div className="detail-field">
              <span className="detail-label">Order ID</span>
              <span className="detail-value cell-mono">
                {paymentDetail.payment.orderId || "—"}
              </span>
            </div>
            <div className="detail-field" style={{ gridColumn: "1 / -1" }}>
              <span className="detail-label">Failure Reason</span>
              <span className="detail-value">
                {paymentDetail.payment.failureReason || "—"}
              </span>
            </div>
            <div className="detail-field">
              <span className="detail-label">Created</span>
              <span className="detail-value">
                {paymentDetail.payment.createdAt
                  ? formatActivityTime(paymentDetail.payment.createdAt)
                  : "—"}
              </span>
            </div>
            <div className="detail-field">
              <span className="detail-label">Updated</span>
              <span className="detail-value">
                {paymentDetail.payment.updatedAt
                  ? formatActivityTime(paymentDetail.payment.updatedAt)
                  : "—"}
              </span>
            </div>
          </div>

          <div className="inspector-actions">
            {paymentDetail.payment.status === "failed" && (
              <button
                type="button"
                className="btn-run-agent"
                disabled={inspectorBusy}
                onClick={() => onRunAgent(paymentDetail.payment.id)}
              >
                {inspectorBusy && !newlyCreatedAttempt
                  ? "Running agent…"
                  : "Run agent"}
              </button>
            )}

            {newlyCreatedAttempt &&
              newlyCreatedAttempt.status === "allowed" &&
              (!inspectorDispatchResult || !inspectorDispatchResult.success) && (
                <button
                  type="button"
                  className="btn-approve"
                  disabled={inspectorBusy}
                  onClick={() =>
                    onApprove(
                      newlyCreatedAttempt.id,
                      paymentDetail.payment.amount
                    )
                  }
                >
                  {inspectorBusy ? "Dispatching…" : "Approve and create link"}
                </button>
              )}
          </div>

          {inspectorError && <div className="error-banner" style={{ margin: "0 20px 16px" }}>{inspectorError}</div>}

          {inspectorDispatchResult && (
            <div style={{ padding: "0 20px 16px" }}>
              <div
                className={`dispatch-outcome dispatch-outcome--${
                  !inspectorDispatchResult.success
                    ? "error"
                    : inspectorDispatchResult.alreadyExecuted
                      ? "neutral"
                      : "success"
                }`}
              >
                {inspectorDispatchResult.success &&
                  !inspectorDispatchResult.alreadyExecuted && (
                    <div>
                      <strong>Payment link created</strong>
                      <div className="dispatch-details">
                        <span>
                          Reference:{" "}
                          <span className="cell-mono">
                            {inspectorDispatchResult.link?.linkId ||
                              inspectorDispatchResult.externalReference}
                          </span>
                        </span>
                      </div>
                    </div>
                  )}
                {inspectorDispatchResult.alreadyExecuted && (
                  <div>
                    <strong>Already dispatched</strong>
                    <div className="dispatch-details">
                      <span>
                        Reference:{" "}
                        <span className="cell-mono">
                          {inspectorDispatchResult.externalReference}
                        </span>
                      </span>
                    </div>
                  </div>
                )}
                {!inspectorDispatchResult.success && (
                  <div>
                    <strong>Dispatch failed: </strong>
                    {inspectorDispatchResult.executionError || "Execution failed"}
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="inspector-timeline">
            <h4 className="inspector-section-title">
              Recovery Timeline ({paymentDetail.attempts.length})
            </h4>

            {paymentDetail.attempts.length === 0 ? (
              <div className="empty-substate">
                No recovery attempts yet for this payment.
              </div>
            ) : (
              <div className="timeline-list">
                {paymentDetail.attempts.map((attempt) => (
                  <div key={attempt.id} className="timeline-card">
                    <div className="timeline-card-header">
                      <span
                        className="timeline-time"
                        title={
                          attempt.createdAt
                            ? new Date(attempt.createdAt).toLocaleString()
                            : ""
                        }
                      >
                        {formatActivityTime(attempt.createdAt)}
                      </span>
                      <span
                        className={`action-pill action-pill--${
                          STATUS_CLASS[attempt.status] ?? "warn"
                        }`}
                      >
                        {STATUS_LABEL[attempt.status] ?? attempt.status}
                      </span>
                    </div>

                    <div className="timeline-card-body">
                      <div>
                        <span className="detail-label">Action: </span>
                        <span>
                          {ATTEMPT_ACTION_LABEL[attempt.action] ??
                            attempt.action ??
                            "—"}
                        </span>
                      </div>

                      {attempt.policyDecision && (
                        <div>
                          <span className="detail-label">Policy: </span>
                          <span
                            className={`action-pill action-pill--${
                              DECISION_CLASS[attempt.policyDecision] ?? "warn"
                            }`}
                          >
                            {DECISION_LABEL[attempt.policyDecision] ??
                              attempt.policyDecision}
                          </span>
                          {attempt.policyReason && (
                            <span className="timeline-policy-reason">
                              {" "}
                              — {attempt.policyReason}
                            </span>
                          )}
                        </div>
                      )}

                      {attempt.llmReason && (
                        <div>
                          <span className="detail-label">Agent: </span>
                          <span>{attempt.llmReason}</span>
                        </div>
                      )}

                      {attempt.executionError && (
                        <div className="timeline-error">
                          <span className="detail-label">Error: </span>
                          <span>{attempt.executionError}</span>
                        </div>
                      )}

                      {attempt.externalReference && (
                        <div>
                          <span className="detail-label">Link ID: </span>
                          <span className="cell-mono">
                            {attempt.externalReference}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </aside>
  )
}

/* ================================================================
   APP COMPONENT
   ================================================================ */
function App() {
  const [view, setView] = useState("dashboard")
  const [stats, setStats] = useState(null)
  const [queue, setQueue] = useState(null)
  const [error, setError] = useState(null)
  const [activity, setActivity] = useState(null)
  const [activityError, setActivityError] = useState(null)
  const [expandedId, setExpandedId] = useState(null)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)

  // Recovery agent run & dispatch state (dashboard)
  const [agentRunId, setAgentRunId] = useState(null)
  const [agentResult, setAgentResult] = useState(null)
  const [agentBusy, setAgentBusy] = useState(false)
  const [agentError, setAgentError] = useState(null)
  const [dispatchResult, setDispatchResult] = useState(null)

  // Recovery Queue & Payment Detail Inspector state
  const [selectedPaymentId, setSelectedPaymentId] = useState(null)
  const [paymentDetail, setPaymentDetail] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState(null)
  const [inspectorBusy, setInspectorBusy] = useState(false)
  const [inspectorError, setInspectorError] = useState(null)
  const [inspectorDispatchResult, setInspectorDispatchResult] = useState(null)
  const [newlyCreatedAttempt, setNewlyCreatedAttempt] = useState(null)

  // Demo Mode state (Interactive Buildathon Walkthrough)
  const [demoConfig, setDemoConfig] = useState(null)
  const [demoPaymentId, setDemoPaymentId] = useState("")
  const [demoPaymentInfo, setDemoPaymentInfo] = useState(null)
  const [demoWorkflowState, setDemoWorkflowState] = useState("ready") // ready | analyzing | analyzed | approving | approved | paying | recovered | error
  const [demoStepData, setDemoStepData] = useState({
    agentDecision: null,
    attempt: null,
    paymentResult: null,
  })
  const [demoLogs, setDemoLogs] = useState([])
  const [demoBusy, setDemoBusy] = useState(false)
  const [demoError, setDemoError] = useState(null)

  // Payments View state
  const [paymentsList, setPaymentsList] = useState(null)
  const [paymentsLoading, setPaymentsLoading] = useState(false)
  const [paymentsError, setPaymentsError] = useState(null)
  const [paymentStatusFilter, setPaymentStatusFilter] = useState("all")
  const [paymentSearchQuery, setPaymentSearchQuery] = useState("")

  const detailAbortControllerRef = useRef(null)
  const activeDetailPaymentIdRef = useRef(null)
  const paymentsAbortControllerRef = useRef(null)
  const activePaymentFilterRef = useRef("all")

  function addDemoLog(message, type = "info") {
    const now = new Date()
    const time = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    setDemoLogs((prev) => [
      { id: `${Date.now()}-${Math.random()}`, time, message, type },
      ...prev.slice(0, 39),
    ])
  }

  function handleSelectDemoPayment(id) {
    setDemoPaymentId(id)
    const found = Array.isArray(queue) ? queue.find((i) => i.id === id) : null
    if (found) {
      setDemoPaymentInfo(found)
    }
    setDemoWorkflowState("ready")
    setDemoStepData({ agentDecision: null, attempt: null, paymentResult: null })
    setDemoError(null)
    addDemoLog(`Selected payment ${id} for recovery demo`, "info")
  }

  function clearInspectorSelection() {
    setSelectedPaymentId(null)
    setPaymentDetail(null)
    setDetailLoading(false)
    setDetailError(null)
    setInspectorBusy(false)
    setInspectorError(null)
    setInspectorDispatchResult(null)
    setNewlyCreatedAttempt(null)
    if (detailAbortControllerRef.current) {
      detailAbortControllerRef.current.abort()
    }
    activeDetailPaymentIdRef.current = null
  }

  function handleStatusFilterChange(newStatus) {
    if (newStatus === paymentStatusFilter) return
    clearInspectorSelection()
    setPaymentStatusFilter(newStatus)
  }

  function navigateTo(target) {
    if (view !== target) {
      clearInspectorSelection()
      setView(target)
    }
    setMobileNavOpen(false)
  }

  useEffect(() => {
    getDashboardStats()
      .then(setStats)
      .catch((err) => setError(err.message))

    getRecoveryQueue()
      .then(setQueue)
      .catch((err) => setError(err.message))

    getDemoStatus()
      .then(async (res) => {
        if (res?.success && res.enabled) {
          setDemoConfig(res)
          addDemoLog("Demo Mode initialized: real backend transitions active", "accent")
          try {
            const ensured = await ensureDemoPayment()
            const targetId = ensured.payment?.id || res.demoPaymentId || "pay_DEMO_RECOVERAI_001"
            setDemoPaymentId(targetId)
            if (ensured.payment) {
              setDemoPaymentInfo(ensured.payment)
            }
          } catch (err) {
            console.error("Failed to ensure demo payment:", err)
          }
        }
      })
      .catch(() => {})
  }, [])

  // Derived active demo payment ID and cached info
  const defaultDemoId = demoConfig?.demoPaymentId || "pay_DEMO_RECOVERAI_001"
  const targetDemoPaymentId = demoPaymentId || defaultDemoId || (Array.isArray(queue) && queue[0]?.id) || ""
  const isDemoRecord =
    targetDemoPaymentId === (demoConfig?.demoPaymentId || "pay_DEMO_RECOVERAI_001") ||
    targetDemoPaymentId.startsWith("pay_DEMO_")
  const targetDemoPaymentInfo =
    demoPaymentInfo?.id === targetDemoPaymentId
      ? demoPaymentInfo
      : (Array.isArray(queue) && queue.find((i) => i.id === targetDemoPaymentId)) || demoPaymentInfo

  async function loadPayments(statusToFetch = paymentStatusFilter) {
    if (paymentsAbortControllerRef.current) {
      paymentsAbortControllerRef.current.abort()
    }
    const controller = new AbortController()
    paymentsAbortControllerRef.current = controller
    activePaymentFilterRef.current = statusToFetch

    setPaymentsLoading(true)
    setPaymentsError(null)
    try {
      const data = await getPayments({
        status: statusToFetch,
        limit: 50,
        signal: controller.signal,
      })
      if (activePaymentFilterRef.current === statusToFetch) {
        setPaymentsList(data.payments)
        setPaymentsLoading(false)
      }
    } catch (err) {
      if (err.name === "AbortError") {
        return
      }
      if (activePaymentFilterRef.current === statusToFetch) {
        setPaymentsError(err.message)
        setPaymentsLoading(false)
      }
    }
  }

  useEffect(() => {
    if (view === "payments") {
      loadPayments(paymentStatusFilter)
    }
    return () => {
      if (paymentsAbortControllerRef.current) {
        paymentsAbortControllerRef.current.abort()
      }
    }
  }, [view, paymentStatusFilter])

  useEffect(() => {
    if (view !== "activity") return
    setExpandedId(null)
    setActivityError(null)
    getRecoveryActivity(50)
      .then((data) => setActivity(data.attempts))
      .catch((err) => setActivityError(err.message))
  }, [view])

  async function handleRunAgent(paymentId) {
    setAgentBusy(true)
    setAgentError(null)
    setDispatchResult(null)
    setAgentRunId(paymentId)
    setAgentResult(null)
    try {
      const res = await runAgent(paymentId)
      setAgentResult(res)
    } catch (err) {
      setAgentError(err.message)
    } finally {
      setAgentBusy(false)
    }
  }

  async function handleApprove() {
    if (!agentResult?.attempt?.id) return
    const amount = agentResult.payment?.amount
    const ok = window.confirm(
      `Create a REAL Razorpay payment link for ${formatRupees(amount)} and make it ` +
        `payable by this customer?\n\nThis is not affected by LLM_MOCK - mock mode ` +
        `stubs the model, not the dispatch.`
    )
    if (!ok) return

    setAgentBusy(true)
    setAgentError(null)
    try {
      const res = await approveAttempt(agentResult.attempt.id)
      setDispatchResult(res)
    } catch (err) {
      setAgentError(err.message)
    } finally {
      setAgentBusy(false)
    }
  }

  async function loadPaymentDetail(paymentId) {
    if (detailAbortControllerRef.current) {
      detailAbortControllerRef.current.abort()
    }
    const controller = new AbortController()
    detailAbortControllerRef.current = controller
    activeDetailPaymentIdRef.current = paymentId

    if (!paymentId) {
      setPaymentDetail(null)
      setDetailLoading(false)
      return
    }
    setDetailLoading(true)
    setDetailError(null)
    setInspectorError(null)
    setInspectorDispatchResult(null)
    setNewlyCreatedAttempt(null)
    try {
      const data = await getPaymentDetail(paymentId, controller.signal)
      if (activeDetailPaymentIdRef.current === paymentId) {
        setPaymentDetail(data)
        setDetailLoading(false)
      }
    } catch (err) {
      if (err.name === "AbortError") {
        return
      }
      if (activeDetailPaymentIdRef.current === paymentId) {
        setDetailError(err.message)
        setDetailLoading(false)
      }
    }
  }

  function handleSelectPayment(paymentId) {
    setSelectedPaymentId(paymentId)
    loadPaymentDetail(paymentId)
  }

  async function refreshQueueAndDetail(paymentId) {
    try {
      const [qData, sData] = await Promise.all([
        getRecoveryQueue(),
        getDashboardStats(),
      ])
      setQueue(qData)
      setStats(sData)
    } catch (err) {
      console.error("Failed to refresh queue data:", err)
    }

    try {
      const pData = await getPayments({
        status: activePaymentFilterRef.current,
        limit: 50,
      })
      if (activePaymentFilterRef.current === paymentStatusFilter) {
        setPaymentsList(pData.payments)
      }
    } catch (err) {
      console.error("Failed to refresh payments list:", err)
    }

    if (paymentId && activeDetailPaymentIdRef.current === paymentId) {
      try {
        const detailData = await getPaymentDetail(paymentId)
        if (activeDetailPaymentIdRef.current === paymentId) {
          setPaymentDetail(detailData)
        }
      } catch (err) {
        console.error("Failed to refresh payment detail:", err)
      }
    }
  }

  async function handleInspectorRunAgent(paymentId) {
    setInspectorBusy(true)
    setInspectorError(null)
    setInspectorDispatchResult(null)
    setNewlyCreatedAttempt(null)
    try {
      const res = await runAgent(paymentId)
      if (
        res.decision?.policyDecision === "ALLOW" &&
        res.decision?.finalAction === "CREATE_PAYMENT_LINK" &&
        res.attempt
      ) {
        setNewlyCreatedAttempt(res.attempt)
      }
      await refreshQueueAndDetail(paymentId)
    } catch (err) {
      setInspectorError(err.message)
    } finally {
      setInspectorBusy(false)
    }
  }

  async function handleInspectorApprove(attemptId, amount) {
    if (!attemptId) return
    const ok = window.confirm(
      `Create a REAL Razorpay payment link for ${formatRupees(amount)} and make it ` +
        `payable by this customer?\n\nThis is not affected by LLM_MOCK - mock mode ` +
        `stubs the model, not the dispatch.`
    )
    if (!ok) return

    setInspectorBusy(true)
    setInspectorError(null)
    try {
      const res = await approveAttempt(attemptId)
      setInspectorDispatchResult(res)
      setNewlyCreatedAttempt(null)
      await refreshQueueAndDetail(selectedPaymentId)
    } catch (err) {
      setInspectorError(err.message)
    } finally {
      setInspectorBusy(false)
    }
  }

  async function executeDemoRunAgent(targetPaymentId = targetDemoPaymentId) {
    const resolvedId = targetPaymentId || targetDemoPaymentId
    if (!resolvedId) return null
    setDemoBusy(true)
    setDemoError(null)
    setDemoWorkflowState("analyzing")
    addDemoLog(`[Agent] Analyzing failed payment ${resolvedId}...`, "info")
    try {
      const res = await runAgent(resolvedId)
      const policyDec = res.decision?.policyDecision || "ALLOW"
      const action = res.recommendation?.action || "CREATE_PAYMENT_LINK"
      const conf = Math.round((res.recommendation?.confidence ?? 0) * 100)
      addDemoLog(
        `[Agent] Recommendation: ${action} (${conf}% conf) · Policy: ${policyDec} (${res.decision?.policyReason || "Rule evaluated"})`,
        "accent"
      )
      setDemoStepData((prev) => ({
        ...prev,
        agentDecision: res.decision,
        recommendation: res.recommendation,
        attempt: res.attempt,
      }))
      setDemoWorkflowState("analyzed")
      await refreshQueueAndDetail(resolvedId)
      return res
    } catch (err) {
      setDemoError(err.message)
      setDemoWorkflowState("error")
      addDemoLog(`[Agent Error] ${err.message}`, "warn")
      throw err
    } finally {
      setDemoBusy(false)
    }
  }

  async function executeDemoApprove(targetAttemptId = demoStepData.attempt?.id) {
    if (!targetAttemptId) {
      setDemoError("No recovery attempt available to approve.")
      return null
    }
    setDemoBusy(true)
    setDemoError(null)
    setDemoWorkflowState("approving")
    addDemoLog(`[Executor] Approving recovery attempt ${targetAttemptId}...`, "info")
    try {
      const res = await approveAttempt(targetAttemptId)
      const linkId = res.link?.linkId || res.link?.id || "plink_generated"
      addDemoLog(`[Executor] Recovery attempt approved! Payment link generated: ${linkId}`, "accent")
      setDemoStepData((prev) => ({
        ...prev,
        attempt: {
          ...(prev.attempt || {}),
          id: targetAttemptId,
          status: "executed",
          externalReference: linkId,
        },
      }))
      setDemoWorkflowState("approved")
      await refreshQueueAndDetail(targetDemoPaymentId)
      return res
    } catch (err) {
      setDemoError(err.message)
      setDemoWorkflowState("error")
      addDemoLog(`[Executor Error] ${err.message}`, "warn")
      throw err
    } finally {
      setDemoBusy(false)
    }
  }

  async function executeDemoSimulatePayment(targetAttemptId = demoStepData.attempt?.id) {
    if (!targetAttemptId) {
      setDemoError("No executed recovery attempt available to simulate payment.")
      return null
    }
    setDemoBusy(true)
    setDemoError(null)
    setDemoWorkflowState("paying")
    addDemoLog(`[Customer Simulation] Customer opening link and completing payment...`, "info")
    try {
      const res = await simulateCustomerPayment(targetAttemptId)
      const amtStr = formatRupees(res.amount)
      addDemoLog(`[Webhook Verified] payment_link.paid reconciled! Payment status: recovered (${amtStr})`, "success")
      setDemoStepData((prev) => ({
        ...prev,
        paymentResult: {
          recoveredAmount: res.amount,
          paymentStatus: res.paymentStatus,
          attemptStatus: res.attemptStatus,
          recoveredAt: new Date().toISOString(),
        },
        attempt: {
          ...(prev.attempt || {}),
          status: res.attemptStatus || "succeeded",
        },
      }))
      setDemoWorkflowState("recovered")
      await refreshQueueAndDetail(targetDemoPaymentId)
      return res
    } catch (err) {
      setDemoError(err.message)
      setDemoWorkflowState("error")
      addDemoLog(`[Simulation Error] ${err.message}`, "warn")
      throw err
    } finally {
      setDemoBusy(false)
    }
  }

  async function handleStartFullWalkthrough() {
    if (demoBusy || !targetDemoPaymentId) return
    try {
      const agentRes = await executeDemoRunAgent(targetDemoPaymentId)
      const attemptId = agentRes?.attempt?.id
      if (!attemptId) {
        throw new Error("Agent did not produce an attempt.")
      }
      await new Promise((r) => setTimeout(r, 600))
      await executeDemoApprove(attemptId)
      await new Promise((r) => setTimeout(r, 600))
      await executeDemoSimulatePayment(attemptId)
    } catch (err) {
      console.error("Demo walkthrough error:", err)
    }
  }

  async function handleDemoReset() {
    if (!targetDemoPaymentId || demoBusy) return
    if (!isDemoRecord) {
      setDemoError("Reset is restricted to dedicated synthetic demo payments.")
      return
    }
    setDemoBusy(true)
    setDemoError(null)
    try {
      addDemoLog(`[Demo Reset] Reverting payment ${targetDemoPaymentId} back to failed...`, "info")
      const res = await resetDemoPayment(targetDemoPaymentId)
      addDemoLog(`[Demo Reset] Payment ${targetDemoPaymentId} status restored to: ${res.payment?.status || "failed"}`, "accent")
      setDemoWorkflowState("ready")
      setDemoStepData({ agentDecision: null, attempt: null, paymentResult: null })
      await refreshQueueAndDetail(targetDemoPaymentId)
    } catch (err) {
      setDemoError(err.message)
      addDemoLog(`[Reset Error] ${err.message}`, "warn")
    } finally {
      setDemoBusy(false)
    }
  }

  function handleRefresh() {
    if (view === "dashboard" || view === "queue") {
      getDashboardStats().then(setStats).catch(() => {})
      getRecoveryQueue().then(setQueue).catch(() => {})
      getDemoStatus()
        .then(async (res) => {
          if (res?.success && res.enabled) {
            setDemoConfig(res)
            try {
              const ensured = await ensureDemoPayment()
              if (!demoPaymentId && ensured.payment?.id) {
                setDemoPaymentId(ensured.payment.id)
                setDemoPaymentInfo(ensured.payment)
              }
            } catch {}
          }
        })
        .catch(() => {})
    }
    if (view === "payments") {
      loadPayments(paymentStatusFilter)
    }
    if (view === "activity") {
      getRecoveryActivity(50)
        .then((data) => setActivity(data.attempts))
        .catch(() => {})
    }
  }

  // Compute dashboard summary stats
  const totalAtRisk = stats?.revenueAtRisk ?? 0
  const totalRecovered = stats?.revenueRecovered ?? 0
  const recoveryRate = stats?.recoveryRate ?? 0

  return (
    <div className="app">
      {/* Mobile backdrop */}
      <div
        className={`sidebar-backdrop${mobileNavOpen ? " is-visible" : ""}`}
        onClick={() => setMobileNavOpen(false)}
      />

      {/* Sidebar */}
      <aside className={`sidebar${mobileNavOpen ? " is-open" : ""}`}>
        <span className="sidebar-brand">
          <span className="sidebar-brand-dot" />
          RecoverAI
        </span>
        <nav className="sidebar-nav">
          <span className="sidebar-section-label">Operations</span>
          <ul className="sidebar-list">
            {[
              { key: "dashboard", label: "Dashboard" },
              { key: "queue", label: "Recovery Queue" },
              { key: "payments", label: "Payments" },
            ].map((item) => (
              <li
                key={item.key}
                tabIndex={0}
                role="button"
                className={`sidebar-item${view === item.key ? " is-active" : ""}`}
                onClick={() => navigateTo(item.key)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault()
                    navigateTo(item.key)
                  }
                }}
              >
                {item.label}
              </li>
            ))}
          </ul>
          <span className="sidebar-section-label">Monitoring</span>
          <ul className="sidebar-list">
            <li
              tabIndex={0}
              role="button"
              className={`sidebar-item${view === "activity" ? " is-active" : ""}`}
              onClick={() => navigateTo("activity")}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault()
                  navigateTo("activity")
                }
              }}
            >
              Agent Activity
            </li>
          </ul>
        </nav>
      </aside>

      {/* Main content */}
      <main className="main">
        <header className="topbar">
          <div className="topbar-left">
            <button
              type="button"
              className="mobile-nav-toggle"
              onClick={() => setMobileNavOpen(!mobileNavOpen)}
              aria-label="Toggle navigation"
            >
              <IconMenu />
            </button>
            <span className="topbar-title">{VIEW_TITLE[view] ?? view}</span>
          </div>
          <div className="topbar-right">
            <button
              type="button"
              className="btn-refresh"
              onClick={handleRefresh}
              title="Refresh data"
            >
              <IconRefresh /> Refresh
            </button>
            <span className={`topbar-pill${demoConfig?.enabled ? " topbar-pill--demo" : ""}`}>
              {demoConfig?.enabled ? "Demo Mode" : "Test Mode"}
            </span>
          </div>
        </header>

        <div className="content">
          {error && <div className="error-banner">{error}</div>}
          {agentError && <div className="error-banner">{agentError}</div>}

          {/* ============== DASHBOARD ============== */}
          {view === "dashboard" && (
            <>
              {/* Dashboard Heading */}
              <div className="dash-header">
                <h1 className="dash-heading">Recovery Command Center</h1>
                <p className="dash-subheading">
                  Real-time payment failure recovery and automated dispatch
                </p>
              </div>

              {/* KPI Cards */}
              <div className="kpi-row">
                <div className="kpi-card kpi-card--risk">
                  <span className="kpi-label">Revenue at Risk</span>
                  <span className="kpi-value kpi-value--risk">
                    {stats ? formatRupees(totalAtRisk) : "—"}
                  </span>
                  <span className="kpi-sub">
                    {stats ? `${stats.failedPaymentCount ?? 0} failed payments` : "—"}
                  </span>
                </div>
                <div className="kpi-card kpi-card--recovered">
                  <span className="kpi-label">Revenue Recovered</span>
                  <span className="kpi-value kpi-value--recovered">
                    {stats ? formatRupees(totalRecovered) : "—"}
                  </span>
                  <span className="kpi-sub">
                    {stats ? `${stats.recoveredPaymentCount ?? 0} recovered payments` : "—"}
                  </span>
                </div>
                <div className="kpi-card kpi-card--rate">
                  <span className="kpi-label">Recovery Rate</span>
                  <span className="kpi-value kpi-value--rate">
                    {stats ? `${recoveryRate}%` : "—"}
                  </span>
                  <div className="kpi-progress">
                    <div
                      className="kpi-progress-fill"
                      style={{ width: `${Math.min(recoveryRate, 100)}%` }}
                    />
                  </div>
                </div>
                <div className="kpi-card kpi-card--total">
                  <span className="kpi-label">Total Payments</span>
                  <span className="kpi-value kpi-value--total">
                    {stats ? (stats.totalPaymentCount ?? 0) : "—"}
                  </span>
                  <span className="kpi-sub">
                    {stats
                      ? `${stats.capturedPaymentCount ?? 0} captured · ${stats.recoveredPaymentCount ?? 0} recovered · ${stats.failedPaymentCount ?? 0} failed`
                      : "—"}
                  </span>
                </div>
              </div>

              {/* Interactive Demo Walkthrough Console (When DEMO_MODE=true) */}
              {demoConfig?.enabled && (
                <section className="demo-console" aria-label="Interactive Demo Recovery Console">
                  <div className="demo-header">
                    <div className="demo-header-info">
                      <div className="demo-badge-row">
                        <span className="demo-badge demo-badge--live">
                          <IconPlay /> Live Interactive Demo
                        </span>
                        {demoConfig.razorpayMock && (
                          <span className="demo-badge demo-badge--mock">Razorpay Mock Active</span>
                        )}
                        {demoConfig.llmMock && (
                          <span className="demo-badge demo-badge--mock">LLM Mock Active</span>
                        )}
                      </div>
                      <h2 className="demo-title">Automated Payment Recovery Lifecycle</h2>
                      <p className="demo-desc">
                        Watch a failed payment recover live through AI analysis, deterministic policy guards, payment link dispatch, and verified webhook reconciliation.
                      </p>
                    </div>

                    <div className="demo-controls">
                      <select
                        className="demo-select"
                        value={targetDemoPaymentId}
                        onChange={(e) => handleSelectDemoPayment(e.target.value)}
                        disabled={demoBusy}
                        aria-label="Select target failed payment"
                      >
                        {Array.isArray(queue) &&
                          queue.map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.id} — {formatRupees(item.amount)} ({item.method?.toUpperCase() || "PAYMENT"})
                            </option>
                          ))}
                        {targetDemoPaymentId &&
                          Array.isArray(queue) &&
                          !queue.some((i) => i.id === targetDemoPaymentId) && (
                            <option value={targetDemoPaymentId}>
                              {targetDemoPaymentId} — {targetDemoPaymentInfo?.amount ? formatRupees(targetDemoPaymentInfo.amount) : "Target"} (Active Demo)
                            </option>
                          )}
                      </select>

                      <div className="demo-actions">
                        <button
                          type="button"
                          className="btn-demo-primary"
                          onClick={handleStartFullWalkthrough}
                          disabled={demoBusy || !targetDemoPaymentId || demoWorkflowState === "recovered"}
                        >
                          {demoBusy ? <IconSpinner /> : <IconPlay />}
                          {demoWorkflowState === "recovered" ? "Recovery Complete" : "Start Recovery Walkthrough"}
                        </button>

                        {demoWorkflowState === "ready" && (
                          <button
                            type="button"
                            className="btn-demo-secondary"
                            onClick={() => executeDemoRunAgent()}
                            disabled={demoBusy || !targetDemoPaymentId}
                          >
                            Analyze Only
                          </button>
                        )}

                        {demoWorkflowState === "analyzed" && (
                          <button
                            type="button"
                            className="btn-demo-primary"
                            onClick={() => executeDemoApprove()}
                            disabled={demoBusy || !demoStepData.attempt?.id}
                          >
                            Approve Link
                          </button>
                        )}

                        {demoWorkflowState === "approved" && (
                          <button
                            type="button"
                            className="btn-demo-primary"
                            onClick={() => executeDemoSimulatePayment()}
                            disabled={demoBusy || !demoStepData.attempt?.id}
                          >
                            Simulate Customer Payment
                          </button>
                        )}

                        <button
                          type="button"
                          className="btn-demo-secondary"
                          onClick={handleDemoReset}
                          disabled={demoBusy || !targetDemoPaymentId || !isDemoRecord}
                          title={
                            !isDemoRecord
                              ? "Reset is restricted to synthetic demo records"
                              : "Revert payment back to failed state to re-run demo"
                          }
                        >
                          Reset Demo
                        </button>
                      </div>
                    </div>
                  </div>

                  {demoError && <div className="error-banner">{demoError}</div>}

                  {/* 6-Step Stepper Cards */}
                  <div className="demo-stepper">
                    {/* Step 1: Failed Payment */}
                    <div className="demo-step is-completed">
                      <div className="demo-step-header">
                        <span className="demo-step-num"><IconCheck /></span>
                        <span className="demo-step-tag">Step 1</span>
                      </div>
                      <div className="demo-step-title">1. Payment Failed</div>
                      <div className="demo-step-body">
                        <span className="cell-mono">{targetDemoPaymentInfo?.id || targetDemoPaymentId || "—"}</span>
                        <span>{targetDemoPaymentInfo?.amount ? formatRupees(targetDemoPaymentInfo.amount) : "—"} · {targetDemoPaymentInfo?.failureReason || "Insufficient funds"}</span>
                        <span className="demo-step-tag">{targetDemoPaymentInfo?.method?.toUpperCase() || "UPI"}</span>
                      </div>
                    </div>

                    {/* Step 2: Agent Analyzed */}
                    <div
                      className={`demo-step ${
                        demoWorkflowState === "analyzing"
                          ? "is-active"
                          : ["analyzed", "approving", "approved", "paying", "recovered"].includes(demoWorkflowState)
                          ? "is-completed"
                          : ""
                      }`}
                    >
                      <div className="demo-step-header">
                        <span className="demo-step-num">
                          {["analyzed", "approving", "approved", "paying", "recovered"].includes(demoWorkflowState) ? (
                            <IconCheck />
                          ) : demoWorkflowState === "analyzing" ? (
                            <IconSpinner />
                          ) : (
                            "2"
                          )}
                        </span>
                        <span className="demo-step-tag">Step 2</span>
                      </div>
                      <div className="demo-step-title">2. Agent Analyzed</div>
                      <div className="demo-step-body">
                        <span>
                          {demoStepData.recommendation?.action
                            ? ATTEMPT_ACTION_LABEL[demoStepData.recommendation.action] || demoStepData.recommendation.action
                            : demoWorkflowState === "analyzing"
                            ? "Analyzing patterns..."
                            : "Awaiting trigger"}
                        </span>
                        <span>
                          {demoStepData.recommendation?.confidence != null
                            ? `${Math.round(demoStepData.recommendation.confidence * 100)}% confidence`
                            : "Pattern confidence"}
                        </span>
                        <span className="demo-step-tag">
                          {demoStepData.recommendation?.modelVersion || (demoConfig?.llmMock ? "Mock AI" : "LLM Model")}
                        </span>
                      </div>
                    </div>

                    {/* Step 3: Policy Evaluated */}
                    <div
                      className={`demo-step ${
                        demoWorkflowState === "analyzing"
                          ? "is-active"
                          : ["analyzed", "approving", "approved", "paying", "recovered"].includes(demoWorkflowState)
                          ? demoStepData.agentDecision?.policyDecision === "DENY"
                            ? "is-failed"
                            : "is-completed"
                          : ""
                      }`}
                    >
                      <div className="demo-step-header">
                        <span className="demo-step-num">
                          {["analyzed", "approving", "approved", "paying", "recovered"].includes(demoWorkflowState) ? (
                            demoStepData.agentDecision?.policyDecision === "DENY" ? <IconAlert /> : <IconCheck />
                          ) : demoWorkflowState === "analyzing" ? (
                            <IconSpinner />
                          ) : (
                            "3"
                          )}
                        </span>
                        <span className="demo-step-tag">Step 3</span>
                      </div>
                      <div className="demo-step-title">3. Policy Evaluated</div>
                      <div className="demo-step-body">
                        <span style={{ fontWeight: 600 }}>
                          {demoStepData.agentDecision?.policyDecision
                            ? `Decision: ${demoStepData.agentDecision.policyDecision}`
                            : demoWorkflowState === "analyzing"
                            ? "Checking guardrails..."
                            : "Awaiting policy"}
                        </span>
                        <span>{demoStepData.agentDecision?.policyReason || "Deterministic checks"}</span>
                        <span className="demo-step-tag">Authoritative Gate</span>
                      </div>
                    </div>

                    {/* Step 4: Payment Link Dispatched */}
                    <div
                      className={`demo-step ${
                        demoWorkflowState === "approving"
                          ? "is-active"
                          : ["approved", "paying", "recovered"].includes(demoWorkflowState)
                          ? "is-completed"
                          : ""
                      }`}
                    >
                      <div className="demo-step-header">
                        <span className="demo-step-num">
                          {["approved", "paying", "recovered"].includes(demoWorkflowState) ? (
                            <IconCheck />
                          ) : demoWorkflowState === "approving" ? (
                            <IconSpinner />
                          ) : (
                            "4"
                          )}
                        </span>
                        <span className="demo-step-tag">Step 4</span>
                      </div>
                      <div className="demo-step-title">4. Link Dispatched</div>
                      <div className="demo-step-body">
                        <span>
                          {["approved", "paying", "recovered"].includes(demoWorkflowState)
                            ? "Attempt Executed"
                            : demoWorkflowState === "approving"
                            ? "Generating link..."
                            : "Awaiting approval"}
                        </span>
                        <span className="cell-mono">
                          {demoStepData.attempt?.externalReference || "Link not created"}
                        </span>
                        <span className="demo-step-tag">
                          {demoConfig?.razorpayMock ? "Synthetic Link" : "Razorpay Link"}
                        </span>
                      </div>
                    </div>

                    {/* Step 5: Customer Paid */}
                    <div
                      className={`demo-step ${
                        demoWorkflowState === "paying"
                          ? "is-active"
                          : demoWorkflowState === "recovered"
                          ? "is-completed"
                          : ""
                      }`}
                    >
                      <div className="demo-step-header">
                        <span className="demo-step-num">
                          {demoWorkflowState === "recovered" ? (
                            <IconCheck />
                          ) : demoWorkflowState === "paying" ? (
                            <IconSpinner />
                          ) : (
                            "5"
                          )}
                        </span>
                        <span className="demo-step-tag">Step 5</span>
                      </div>
                      <div className="demo-step-title">5. Customer Paid</div>
                      <div className="demo-step-body">
                        <span>
                          {demoWorkflowState === "recovered"
                            ? "payment_link.paid"
                            : demoWorkflowState === "paying"
                            ? "Processing customer..."
                            : "Awaiting payment"}
                        </span>
                        <span>
                          {demoWorkflowState === "recovered" ? "HMAC Verified" : "Reconciliation Ready"}
                        </span>
                        <span className="demo-step-tag">Webhook Event</span>
                      </div>
                    </div>

                    {/* Step 6: Payment Recovered */}
                    <div
                      className={`demo-step ${
                        demoWorkflowState === "recovered" ? "is-completed" : ""
                      }`}
                    >
                      <div className="demo-step-header">
                        <span className="demo-step-num">
                          {demoWorkflowState === "recovered" ? <IconCheck /> : "6"}
                        </span>
                        <span className="demo-step-tag">Step 6</span>
                      </div>
                      <div className="demo-step-title">6. Recovered</div>
                      <div className="demo-step-body">
                        <span style={{ fontWeight: 600, color: demoWorkflowState === "recovered" ? "var(--green)" : "inherit" }}>
                          {demoWorkflowState === "recovered" ? "Payment Recovered" : "Pending Recovery"}
                        </span>
                        <span>
                          {demoWorkflowState === "recovered"
                            ? `+${formatRupees(demoStepData.paymentResult?.recoveredAmount || demoPaymentInfo?.amount)} saved`
                            : "Metrics will update"}
                        </span>
                        <span className="demo-step-tag">Database Committed</span>
                      </div>
                    </div>
                  </div>

                  {/* Live Event Feed */}
                  <div className="demo-feed">
                    {demoLogs.length === 0 ? (
                      <div className="demo-feed-entry">
                        <span className="demo-feed-time">—:—:—</span>
                        <span className="demo-feed-msg" style={{ color: "var(--text-muted)" }}>
                          Awaiting action. Click &ldquo;Start Recovery Walkthrough&rdquo; to begin.
                        </span>
                      </div>
                    ) : (
                      demoLogs.map((log) => (
                        <div key={log.id} className="demo-feed-entry">
                          <span className="demo-feed-time">{log.time}</span>
                          <span
                            className={`demo-feed-msg ${
                              log.type === "success"
                                ? "demo-feed-msg--success"
                                : log.type === "accent"
                                ? "demo-feed-msg--accent"
                                : log.type === "warn"
                                ? "demo-feed-msg--warn"
                                : ""
                            }`}
                          >
                            {log.message}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                </section>
              )}

              {/* Recovery Funnel & Attention Grid */}
              <div className="dash-grid">
                {/* Recovery Funnel */}
                <div className="funnel-card">
                  <h3 className="funnel-title">Recovery Funnel</h3>
                  <div className="funnel-steps">
                    <div className="funnel-step">
                      <span className="funnel-dot funnel-dot--red" />
                      <span className="funnel-step-label">Failed payments</span>
                      <span className="funnel-step-value">
                        {stats
                          ? (stats.failedPaymentCount ?? 0) + (stats.recoveredPaymentCount ?? 0)
                          : "—"}
                      </span>
                    </div>
                    <div className="funnel-step">
                      <span className="funnel-dot funnel-dot--amber" />
                      <span className="funnel-step-label">Agent reviewed</span>
                      <span className="funnel-step-value">
                        {stats ? (stats.totalRecoveryAttemptCount ?? 0) : "—"}
                      </span>
                    </div>
                    <div className="funnel-step">
                      <span className="funnel-dot funnel-dot--accent" />
                      <span className="funnel-step-label">Approved or executed</span>
                      <span className="funnel-step-value">
                        {stats
                          ? (stats.executedAttemptCount ?? 0) +
                            (stats.successfulRecoveryAttemptCount ?? 0) +
                            (stats.allowedAttemptCount ?? 0)
                          : "—"}
                      </span>
                    </div>
                    <div className="funnel-step">
                      <span className="funnel-dot funnel-dot--green" />
                      <span className="funnel-step-label">Recovered</span>
                      <span className="funnel-step-value">
                        {stats ? (stats.recoveredPaymentCount ?? 0) : "—"}
                      </span>
                    </div>
                  </div>
                </div>

                {/* What Needs Attention */}
                <div className="attention-card">
                  <h3 className="attention-title">What Needs Attention</h3>
                  {stats ? (
                    <div className="attention-list">
                      <div
                        className={`attention-item${
                          (stats.failedPaymentCount ?? 0) > 0 ? " attention-item--red" : ""
                        }`}
                      >
                        <span
                          className="attention-item-count"
                          style={{
                            color:
                              (stats.failedPaymentCount ?? 0) > 0
                                ? "var(--red)"
                                : "var(--text-muted)",
                          }}
                        >
                          {stats.failedPaymentCount ?? 0}
                        </span>
                        <span className="attention-item-label">
                          Failed payment{(stats.failedPaymentCount ?? 0) !== 1 ? "s" : ""} in queue
                        </span>
                        {(stats.failedPaymentCount ?? 0) > 0 && (
                          <button
                            type="button"
                            className="section-link"
                            onClick={() => navigateTo("queue")}
                          >
                            Open queue →
                          </button>
                        )}
                      </div>
                      <div
                        className={`attention-item${
                          (stats.pendingReviewCount ?? 0) > 0 ? " attention-item--amber" : ""
                        }`}
                      >
                        <span
                          className="attention-item-count"
                          style={{
                            color:
                              (stats.pendingReviewCount ?? 0) > 0
                                ? "var(--amber)"
                                : "var(--text-muted)",
                          }}
                        >
                          {stats.pendingReviewCount ?? 0}
                        </span>
                        <span className="attention-item-label">
                          Human-review attempt{(stats.pendingReviewCount ?? 0) !== 1 ? "s" : ""}
                        </span>
                        {(stats.pendingReviewCount ?? 0) > 0 && (
                          <button
                            type="button"
                            className="section-link"
                            onClick={() => navigateTo("activity")}
                          >
                            Review →
                          </button>
                        )}
                      </div>
                      <div
                        className={`attention-item${
                          (stats.failedAttemptCount ?? 0) > 0 ? " attention-item--red" : ""
                        }`}
                      >
                        <span
                          className="attention-item-count"
                          style={{
                            color:
                              (stats.failedAttemptCount ?? 0) > 0
                                ? "var(--red)"
                                : "var(--text-muted)",
                          }}
                        >
                          {stats.failedAttemptCount ?? 0}
                        </span>
                        <span className="attention-item-label">
                          Failed execution attempt{(stats.failedAttemptCount ?? 0) !== 1 ? "s" : ""}
                        </span>
                        {(stats.failedAttemptCount ?? 0) > 0 && (
                          <button
                            type="button"
                            className="section-link"
                            onClick={() => navigateTo("activity")}
                          >
                            Inspect →
                          </button>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="attention-none">Loading attention items…</div>
                  )}
                </div>
              </div>

              {/* Dashboard Queue Preview */}
              <div className="dash-section-header">
                <h2 className="section-title">Recovery Queue</h2>
                <button type="button" className="section-link" onClick={() => navigateTo("queue")}>
                  View all →
                </button>
              </div>
              <div className="queue-table-wrapper">
                <table className="queue-table">
                  <thead>
                    <tr>
                      <th>Payment</th>
                      <th className="col-amount">Amount</th>
                      <th>Reason</th>
                      <th>Action</th>
                      <th>Agent</th>
                    </tr>
                  </thead>
                  <tbody>
                    {queue === null ? (
                      <tr>
                        <td
                          colSpan={5}
                          style={{
                            textAlign: "center",
                            color: "var(--text-muted)",
                            padding: "24px",
                          }}
                        >
                          Loading recovery queue…
                        </td>
                      </tr>
                    ) : queue.length === 0 ? (
                      <tr>
                        <td
                          colSpan={5}
                          style={{
                            textAlign: "center",
                            color: "var(--text-muted)",
                            padding: "24px",
                          }}
                        >
                          No payments at risk
                        </td>
                      </tr>
                    ) : (
                      queue.slice(0, 5).map((row) => {
                        const isPanelOpen = agentRunId === row.id && agentResult
                        const isMocked =
                          agentResult?.recommendation?.modelVersion === "mock" ||
                          (typeof agentResult?.recommendation?.reason === "string" &&
                            agentResult.recommendation.reason.startsWith("MOCK:"))

                        return (
                          <Fragment key={row.id}>
                            <tr>
                              <td className="cell-mono">{row.customer}</td>
                              <td className="col-amount">{formatRupees(row.amount)}</td>
                              <td>{row.reason}</td>
                              <td>
                                <span
                                  className={`action-pill action-pill--${ACTION_CLASS[row.action]}`}
                                >
                                  {ACTION_LABEL[row.action]}
                                </span>
                              </td>
                              <td>
                                <button
                                  type="button"
                                  className="btn-run-agent"
                                  disabled={agentBusy}
                                  onClick={() => handleRunAgent(row.id)}
                                >
                                  {agentBusy && agentRunId === row.id && !agentResult
                                    ? "Running…"
                                    : "Run agent"}
                                </button>
                              </td>
                            </tr>

                            {isPanelOpen && (
                              <tr className="agent-result-row">
                                <td colSpan={5}>
                                  <div className="agent-result-panel">
                                    {isMocked && (
                                      <div className="mock-badge">
                                        MOCKED DECISION — no live model call
                                      </div>
                                    )}

                                    <div className="detail-grid">
                                      <div className="detail-field">
                                        <span className="detail-label">
                                          Model recommended
                                        </span>
                                        <span className="detail-value">
                                          {agentResult.recommendation?.action
                                            ? `${agentResult.recommendation.action} — `
                                            : ""}
                                          {agentResult.recommendation?.reason ?? "—"}
                                        </span>
                                      </div>
                                      <div className="detail-field">
                                        <span className="detail-label">Policy decided</span>
                                        <span className="detail-value">
                                          {agentResult.decision?.policyDecision
                                            ? `${DECISION_LABEL[agentResult.decision.policyDecision] ?? agentResult.decision.policyDecision} — `
                                            : ""}
                                          {agentResult.decision?.policyReason ?? "—"}
                                        </span>
                                      </div>
                                      <div className="detail-field">
                                        <span className="detail-label">Model</span>
                                        <span className="detail-value">
                                          {agentResult.recommendation?.modelVersion ?? "—"}
                                        </span>
                                      </div>
                                      <div className="detail-field">
                                        <span className="detail-label">Final action</span>
                                        <span className="detail-value">
                                          {ATTEMPT_ACTION_LABEL[
                                            agentResult.decision?.finalAction
                                          ] ??
                                            agentResult.decision?.finalAction ??
                                            "—"}
                                        </span>
                                      </div>
                                      <div className="detail-field">
                                        <span className="detail-label">Attempts used</span>
                                        <span className="detail-value">
                                          {agentResult.history?.attemptsForOrder ?? 0}
                                        </span>
                                      </div>
                                    </div>

                                    {/* Dispatch action button */}
                                    {agentResult.decision?.policyDecision === "ALLOW" &&
                                      agentResult.decision?.finalAction ===
                                        "CREATE_PAYMENT_LINK" &&
                                      (dispatchResult === null || !dispatchResult.alreadyExecuted) && (
                                        <div>
                                          <button
                                            type="button"
                                            className="btn-approve"
                                            disabled={agentBusy}
                                            onClick={handleApprove}
                                          >
                                            {agentBusy
                                              ? "Dispatching…"
                                              : "Approve & send payment link"}
                                          </button>
                                        </div>
                                      )}

                                    {/* Dispatch outcome display */}
                                    {dispatchResult && (
                                      <div
                                        className={`dispatch-outcome dispatch-outcome--${
                                          !dispatchResult.success
                                            ? "error"
                                            : dispatchResult.alreadyExecuted
                                              ? "neutral"
                                              : "success"
                                        }`}
                                      >
                                        {dispatchResult.success &&
                                          !dispatchResult.alreadyExecuted && (
                                            <div>
                                              <strong>Payment link created</strong>
                                              <div className="dispatch-details">
                                                <span>
                                                  Link ID:{" "}
                                                  <span className="cell-mono">
                                                    {dispatchResult.link?.linkId}
                                                  </span>
                                                </span>
                                                {dispatchResult.link?.shortUrl && (
                                                  <a
                                                    href={dispatchResult.link.shortUrl}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="dispatch-link"
                                                  >
                                                    {dispatchResult.link.shortUrl}
                                                  </a>
                                                )}
                                              </div>
                                            </div>
                                          )}
                                        {dispatchResult.alreadyExecuted && (
                                          <div>
                                            <strong>Already dispatched</strong>
                                            <div className="dispatch-details">
                                              <span>
                                                Reference:{" "}
                                                <span className="cell-mono">
                                                  {dispatchResult.externalReference}
                                                </span>
                                              </span>
                                            </div>
                                          </div>
                                        )}
                                        {!dispatchResult.success && (
                                          <div>
                                            <strong>Dispatch failed: </strong>
                                            {dispatchResult.executionError ||
                                              "Execution failed"}
                                          </div>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        )
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {/* ============== RECOVERY QUEUE ============== */}
          {view === "queue" && (
            <div className="queue-view-layout">
              <div className="queue-view-main">
                {queue === null ? (
                  <div className="empty-state">Loading recovery queue…</div>
                ) : queue.length === 0 ? (
                  <div className="empty-state">No payments at risk in the recovery queue.</div>
                ) : (
                  <>
                    <div className="dash-section-header" style={{ marginBottom: 16 }}>
                      <h2 className="section-title">
                        {queue.length} payment{queue.length !== 1 ? "s" : ""} at risk
                        {" · "}
                        {formatRupees(queue.reduce((sum, r) => sum + (r.amount || 0), 0))} total
                      </h2>
                    </div>
                    <div className="queue-table-wrapper">
                      <table className="queue-table">
                        <thead>
                          <tr>
                            <th>Payment</th>
                            <th className="col-amount">Amount</th>
                            <th>Reason</th>
                            <th>Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {queue.map((row) => {
                            const isSelected = selectedPaymentId === row.id
                            return (
                              <tr
                                key={row.id}
                                className={`queue-row${isSelected ? " is-selected" : ""}`}
                                onClick={() => handleSelectPayment(row.id)}
                              >
                                <td className="cell-mono">{row.customer}</td>
                                <td className="col-amount">{formatRupees(row.amount)}</td>
                                <td>{row.reason}</td>
                                <td>
                                  <button
                                    type="button"
                                    className="btn-review"
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      handleSelectPayment(row.id)
                                    }}
                                  >
                                    Review
                                  </button>
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </div>

              <PaymentInspector
                selectedPaymentId={selectedPaymentId}
                detailLoading={detailLoading}
                detailError={detailError}
                paymentDetail={paymentDetail}
                inspectorBusy={inspectorBusy}
                inspectorError={inspectorError}
                inspectorDispatchResult={inspectorDispatchResult}
                newlyCreatedAttempt={newlyCreatedAttempt}
                onRunAgent={handleInspectorRunAgent}
                onApprove={handleInspectorApprove}
              />
            </div>
          )}

          {/* ============== PAYMENTS ============== */}
          {view === "payments" && (
            <div className="queue-view-layout">
              <div className="queue-view-main">
                <div className="table-toolbar">
                  <div className="filter-group" role="tablist" aria-label="Filter payments by status">
                    {["all", "failed", "captured", "recovered"].map((s) => (
                      <button
                        key={s}
                        type="button"
                        className={`filter-btn${paymentStatusFilter === s ? " is-active" : ""}`}
                        onClick={() => handleStatusFilterChange(s)}
                      >
                        {s.charAt(0).toUpperCase() + s.slice(1)}
                      </button>
                    ))}
                  </div>
                  <input
                    type="text"
                    className="search-input"
                    placeholder="Search by payment ID or order ID…"
                    value={paymentSearchQuery}
                    onChange={(e) => setPaymentSearchQuery(e.target.value)}
                    aria-label="Search payments"
                  />
                </div>

                {paymentsLoading ? (
                  <div className="empty-state">Loading payments…</div>
                ) : paymentsError ? (
                  <div className="error-banner">{paymentsError}</div>
                ) : paymentsList && paymentsList.length === 0 ? (
                  <div className="empty-state">No payments found.</div>
                ) : (paymentsList || []).filter((p) => {
                    if (!paymentSearchQuery.trim()) return true
                    const q = paymentSearchQuery.toLowerCase().trim()
                    const idMatch = p.id && p.id.toLowerCase().includes(q)
                    const orderMatch = p.orderId && p.orderId.toLowerCase().includes(q)
                    return idMatch || orderMatch
                  }).length === 0 ? (
                  <div className="empty-state">
                    No payments match &ldquo;{paymentSearchQuery}&rdquo;.
                  </div>
                ) : (
                  <div className="queue-table-wrapper">
                    <table className="queue-table">
                      <thead>
                        <tr>
                          <th>Payment</th>
                          <th>Order</th>
                          <th className="col-amount">Amount</th>
                          <th>Method</th>
                          <th>Status</th>
                          <th>Failure Reason</th>
                          <th>Updated</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(paymentsList || [])
                          .filter((p) => {
                            if (!paymentSearchQuery.trim()) return true
                            const q = paymentSearchQuery.toLowerCase().trim()
                            const idMatch = p.id && p.id.toLowerCase().includes(q)
                            const orderMatch = p.orderId && p.orderId.toLowerCase().includes(q)
                            return idMatch || orderMatch
                          })
                          .map((row) => {
                            const isSelected = selectedPaymentId === row.id
                            return (
                              <tr
                                key={row.id}
                                className={`queue-row${isSelected ? " is-selected" : ""}`}
                                onClick={() => handleSelectPayment(row.id)}
                              >
                                <td className="cell-mono">{row.id}</td>
                                <td className="cell-mono">{row.orderId || "—"}</td>
                                <td className="col-amount">{formatRupees(row.amount)}</td>
                                <td>{row.method ? row.method.toUpperCase() : "—"}</td>
                                <td>
                                  <span
                                    className={`action-pill action-pill--${
                                      STATUS_CLASS[row.status] || "warn"
                                    }`}
                                  >
                                    {STATUS_LABEL[row.status] || row.status}
                                  </span>
                                </td>
                                <td
                                  className="col-reason-dense"
                                  title={row.failureReason || ""}
                                >
                                  {row.failureReason || "—"}
                                </td>
                                <td
                                  title={
                                    row.updatedAt
                                      ? new Date(row.updatedAt).toLocaleString()
                                      : ""
                                  }
                                >
                                  {formatActivityTime(row.updatedAt)}
                                </td>
                              </tr>
                            )
                          })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <PaymentInspector
                selectedPaymentId={selectedPaymentId}
                detailLoading={detailLoading}
                detailError={detailError}
                paymentDetail={paymentDetail}
                inspectorBusy={inspectorBusy}
                inspectorError={inspectorError}
                inspectorDispatchResult={inspectorDispatchResult}
                newlyCreatedAttempt={newlyCreatedAttempt}
                onRunAgent={handleInspectorRunAgent}
                onApprove={handleInspectorApprove}
                activeFilter={paymentStatusFilter}
              />
            </div>
          )}

          {/* ============== AGENT ACTIVITY ============== */}
          {view === "activity" && (
            <>
              {activityError && <div className="error-banner">{activityError}</div>}
              <div className="queue-table-wrapper">
                <table className="queue-table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Payment ID</th>
                      <th className="col-amount">Amount</th>
                      <th>Status</th>
                      <th>Decision</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activity === null ? null : activity.length === 0 ? (
                      <tr>
                        <td colSpan={6} style={{ textAlign: "center", color: "var(--text-muted)" }}>
                          No agent activity yet.
                        </td>
                      </tr>
                    ) : (
                      activity.map((row) => {
                        const isExpanded = expandedId === row.id
                        return (
                          <Fragment key={row.id}>
                            <tr
                              className={`activity-row${isExpanded ? " is-expanded" : ""}`}
                              onClick={() => setExpandedId(isExpanded ? null : row.id)}
                            >
                              <td title={row.createdAt ? new Date(row.createdAt).toLocaleString() : ""}>
                                {formatActivityTime(row.createdAt)}
                              </td>
                              <td className="cell-mono">{row.razorpayPaymentId}</td>
                              <td className="col-amount">{row.amount == null ? "—" : formatRupees(row.amount)}</td>
                              <td>
                                <span className={`action-pill action-pill--${STATUS_CLASS[row.status] ?? "warn"}`}>
                                  {STATUS_LABEL[row.status] ?? row.status}
                                </span>
                              </td>
                              <td>
                                <span className={`action-pill action-pill--${DECISION_CLASS[row.policyDecision] ?? "warn"}`}>
                                  {DECISION_LABEL[row.policyDecision] ?? row.policyDecision}
                                </span>
                              </td>
                              <td>{ATTEMPT_ACTION_LABEL[row.action] ?? row.action ?? "—"}</td>
                            </tr>
                            {isExpanded && (
                              <tr className="detail-row">
                                <td colSpan={6}>
                                  <div className="detail-grid">
                                    <div className="detail-field">
                                      <span className="detail-label">Model recommended</span>
                                      <span className="detail-value">{row.llmReason ?? "—"}</span>
                                    </div>
                                    <div className="detail-field">
                                      <span className="detail-label">Policy decided</span>
                                      <span className="detail-value">{row.policyReason ?? "—"}</span>
                                    </div>
                                    {row.executionError != null && (
                                      <div className="detail-field">
                                        <span className="detail-label">Dispatch error</span>
                                        <span className="detail-value detail-value--danger">
                                          {row.executionError}
                                        </span>
                                      </div>
                                    )}
                                    <div className="detail-field">
                                      <span className="detail-label">Confidence</span>
                                      <span className="detail-value">
                                        {row.llmConfidence != null
                                          ? `${(row.llmConfidence * 100).toFixed(0)}%`
                                          : "—"}
                                      </span>
                                    </div>
                                    <div className="detail-field">
                                      <span className="detail-label">Model</span>
                                      <span className="detail-value">{row.modelVersion ?? "—"}</span>
                                    </div>
                                    {row.externalReference != null && (
                                      <div className="detail-field">
                                        <span className="detail-label">Payment link ref</span>
                                        <span className="detail-value cell-mono">
                                          {row.externalReference}
                                        </span>
                                      </div>
                                    )}
                                    {row.razorpayOrderId != null && (
                                      <div className="detail-field">
                                        <span className="detail-label">Order ID</span>
                                        <span className="detail-value cell-mono">
                                          {row.razorpayOrderId}
                                        </span>
                                      </div>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        )
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  )
}

export default App
