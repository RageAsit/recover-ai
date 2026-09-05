# RecoverAI

> AI-Powered Revenue Recovery Command Center for the Razorpay Buildathon

RecoverAI automatically detects failed payments, uses AI to analyze failure patterns, applies deterministic policy guardrails, generates recovery payment links, and reconciles payments upon customer completion.

---

## Quick Start

### 1. Backend Setup

```bash
cd backend
npm install
cp .env.example .env
```

Ensure the following are set in `backend/.env`:
```env
DEMO_MODE=true
RAZORPAY_MOCK=true
LLM_MOCK=true
MONGODB_URI=mongodb://localhost:27017/recoverai
PORT=5000
```

Start the backend server:
```bash
npm run dev
```

### 2. Frontend Setup

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173` in your browser.

---

## Interactive Demo Mode (For Judges)

RecoverAI includes a dedicated **Interactive Demo Console** right on the Dashboard:

1. Look for the blue **DEMO MODE** badge in the top navigation bar.
2. Under the KPI cards, the **Automated Payment Recovery Lifecycle** console automatically loads the dedicated synthetic demo record (`pay_DEMO_RECOVERAI_001`).
3. Click **"Start Recovery Walkthrough"**:
   - **Step 1: Payment Failed** — Inspects failure reason, amount, method, and order ID.
   - **Step 2: Agent Analyzed** — Runs the AI recovery agent (`execute: false`) to analyze risk and recommend recovery actions with pattern confidence.
   - **Step 3: Policy Evaluated** — Evaluates deterministic backend policy rules (`ALLOW` / `DENY`).
   - **Step 4: Link Dispatched** — Approves the attempt and creates a payment link (mocked or live Razorpay Test Mode).
   - **Step 5: Customer Paid** — Simulates customer payment link completion, triggering `processPaymentLinkPaid()` with HMAC-verified reconciliation.
   - **Step 6: Recovered** — Reconciles payment status to `recovered`, updates attempt to `succeeded`, and refreshes live KPI cards and the recovery funnel.
4. Click **"Reset Demo"** at any time:
   - **Server-Side Safety**: Only synthetic demo records (`pay_DEMO_*` or `isDemo: true`) can be reset. Attempting to reset non-demo operational payments is rejected with `403 Forbidden`.
   - **Targeted Scope**: Deletes only RecoveryAttempt records belonging to the demo payment; other payment attempts remain untouched.
   - **Idempotency**: Resetting multiple times cleanly restores the record to `failed` without errors.

---

## Production & Decoupled Deployment

RecoverAI is built as a modular monolith (Express backend + Vite React frontend) that can be run unified or deployed decoupled (e.g. Vercel + Render):

### Deployment Architecture Example

| Component | Example Hosting | URL | Key Environment Variables |
| :--- | :--- | :--- | :--- |
| **Frontend** | Vercel / Cloudflare Pages | `https://recover-ai-demo.vercel.app` | `VITE_API_BASE_URL=https://recover-ai-api.onrender.com` |
| **Backend** | Render / Railway / AWS | `https://recover-ai-api.onrender.com` | `FRONTEND_ORIGIN=https://recover-ai-demo.vercel.app`<br>`PORT=5000`<br>`MONGODB_URI=mongodb+srv://...` |
| **Database** | MongoDB Atlas | Cluster URI | Point to isolated demo DB for demo deployments |

### Production Environment Variables

#### Backend (`backend/.env`):
```env
PORT=5000
MONGODB_URI=mongodb+srv://<user>:<password>@cluster.mongodb.net/recoverai_prod?retryWrites=true&w=majority
FRONTEND_ORIGIN=https://recover-ai-demo.vercel.app

# Razorpay Test Mode Credentials
RAZORPAY_KEY_ID=rzp_test_...
RAZORPAY_KEY_SECRET=...
RAZORPAY_WEBHOOK_SECRET=...

# Gemini AI Credentials
LLM_PROVIDER=gemini
LLM_API_KEY=...
LLM_MODEL=gemini-2.5-flash

# Policy Controls
RECOVERY_MAX_ATTEMPTS=3
RECOVERY_MAX_AMOUNT_PAISE=50000000

# Demo Mode (Disable in production!)
DEMO_MODE=false
RAZORPAY_MOCK=false
LLM_MOCK=false
```

#### Frontend (`frontend/.env`):
```env
VITE_API_BASE_URL=https://recover-ai-api.onrender.com
```

### Isolated Demo Environment (Buildathon Demo)

To run a completely isolated, repeatable demo instance:
1. Configure `MONGODB_URI=mongodb://localhost:27017/recoverai_demo` (separate from any operational databases).
2. Set `DEMO_MODE=true`, `RAZORPAY_MOCK=true`, `LLM_MOCK=true`.
3. When mocks are active, zero live network calls are made to Razorpay or Gemini, guaranteeing high speed and 100% repeatable reliability without consuming external API rate limits.

---

## Testing & Verification

Run all test suites from the `backend/` directory:

```bash
cd backend
node scripts/testSafeDemoReset.js       # Safe demo reset, 403 guard, and idempotency tests
node scripts/testDemoWorkflow.js        # Full Demo Mode integration test suite
node scripts/testDashboardStats.js       # KPI aggregations and funnel verification
node scripts/testPaymentsRoute.js        # Payments filtering and allowlist check
node scripts/testPaymentDetailRoute.js   # Detail inspector data verification
node scripts/testRecoveryLinkage.js      # Reconciliation linkage verification
```

Run frontend verification:

```bash
cd frontend
npm run lint
npm run build
```
