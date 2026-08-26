import { useState, useEffect } from "react"
import { getDashboardStats } from "./services/dashboard"
import { getRecoveryQueue } from "./services/recovery"
import { formatRupees } from "./utils/format"

const ACTION_LABEL = { RECOVER: "Recover", REVIEW: "Review", STOP: "Stop" }
const ACTION_CLASS = { RECOVER: "good", REVIEW: "warn", STOP: "danger" }

function App() {
  const [stats, setStats] = useState(null)
  const [error, setError] = useState(null)
  const queue = getRecoveryQueue()

  useEffect(() => {
    getDashboardStats()
      .then(setStats)
      .catch((err) => setError(err.message))
  }, [])

  return (
    <div className="app">
      <aside className="sidebar">
        <span className="sidebar-brand">RecoverAI</span>
        <nav className="sidebar-nav">
          <ul className="sidebar-list">
            <li className="sidebar-item is-active">Dashboard</li>
            <li className="sidebar-item">Recovery Queue</li>
            <li className="sidebar-item">Payments</li>
            <li className="sidebar-item">Agent Activity</li>
          </ul>
        </nav>
      </aside>
      <main className="main">
        <header className="topbar">
          <span className="topbar-title">Dashboard</span>
          <span className="topbar-pill">Test Mode</span>
        </header>
        <div className="content">
          {error && <div style={{ color: "var(--danger)", marginBottom: "1rem" }}>{error}</div>}
          <div className="card-row">
            <div className="card">
              <span className="card-label">REVENUE AT RISK</span>
              <span className="card-value card-value--warn">
                {stats ? formatRupees(stats.revenueAtRisk) : "—"}
              </span>
            </div>
            <div className="card">
              <span className="card-label">REVENUE RECOVERED</span>
              <span className="card-value card-value--good">
                {stats ? formatRupees(stats.revenueRecovered) : "—"}
              </span>
            </div>
            <div className="card">
              <span className="card-label">RECOVERY RATE</span>
              <span className="card-value">
                {stats ? `${stats.recoveryRate}%` : "—"}
              </span>
            </div>
          </div>
          <h2 className="section-title">Recovery Queue</h2>
          <table className="queue-table">
            <thead>
              <tr>
                <th>Customer</th>
                <th className="col-amount">Amount</th>
                <th>Reason</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {queue.map((row) => (
                <tr key={row.id}>
                  <td>{row.customer}</td>
                  <td className="col-amount">{formatRupees(row.amount)}</td>
                  <td>{row.reason}</td>
                  <td>
                    <span className={`action-pill action-pill--${ACTION_CLASS[row.action]}`}>
                      {ACTION_LABEL[row.action]}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  )
}

export default App
