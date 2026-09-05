# RecoverAI

> **AI-Powered Payment Recovery Workflow for the Razorpay Buildathon**

RecoverAI turns failed payments into completed transactions. When a customer checkout fails, RecoverAI analyzes the failure context with Gemini 3.6 Flash, validates the suggested action against deterministic backend policy guardrails, generates an actionable Razorpay Test Mode payment link, and reconciles the payment state only upon receiving a verified webhook.

[![React](https://img.shields.io/badge/React_19-20232A?style=flat&logo=react&logoColor=61DAFB)](https://react.dev/)
[![Vite](https://img.shields.io/badge/Vite_8-646CFF?style=flat&logo=vite&logoColor=white)](https://vitejs.dev/)
[![Node.js](https://img.shields.io/badge/Node.js-339933?style=flat&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express_5-000000?style=flat&logo=express&logoColor=white)](https://expressjs.com/)
[![MongoDB Atlas](https://img.shields.io/badge/MongoDB_Atlas-47A248?style=flat&logo=mongodb&logoColor=white)](https://www.mongodb.com/atlas)
[![Razorpay](https://img.shields.io/badge/Razorpay-Test_Mode-0C2340?style=flat&logo=razorpay&logoColor=white)](https://razorpay.com/)
[![Google Gemini](https://img.shields.io/badge/Gemini_3.6_Flash-8E75C2?style=flat&logo=googlegemini&logoColor=white)](https://ai.google.dev/)

[🚀 **Launch Live Demo**](https://recover-ai-brown.vercel.app) &nbsp;|&nbsp; [🩺 **Backend Health Endpoint**](https://recoverai-backend-2efq.onrender.com/api/health)

---

## Table of Contents

1. [Problem & Solution](#problem--solution)
2. [How the Workflow Works](#how-the-workflow-works)
3. [AI & Safety Architecture](#ai--safety-architecture)
4. [Product Walkthrough](#product-walkthrough)
5. [Two Operating Modes](#two-operating-modes)
6. [Architecture Diagram](#architecture-diagram)
7. [Environment Variables](#environment-variables)
8. [Deployment Overview](#deployment-overview)
9. [Testing & Verification](#testing--verification)
10. [Security & Demo Limitations](#security--demo-limitations)
11. [Core Philosophy](#core-philosophy)

---

## Problem & Solution

### The Problem: Revenue Leakage from Checkout Drop-Offs
Online payments fail regularly due to transient bank downtimes, incorrect PIN/OTP entries, insufficient funds, or network drops. In typical merchant setups:
- Failed transactions are treated as dead ends, requiring customer support or operations teams to manually track down logs.
- Customers rarely restart checkout on their own once an attempt fails, leading to immediate cart abandonment.
- Blind automated retries irritate shoppers and waste payment gateway quotas when failures are non-recoverable (e.g., card stolen or invalid account).

### The Solution: RecoverAI
RecoverAI automates the recovery lifecycle with AI intelligence governed by strict financial policy:
1. **Intelligent Analysis**: When a payment fails, Gemini 3.6 Flash evaluates the failure code, payment method, customer history, and prior attempts to assess recovery viability.
2. **Deterministic Guardrails**: The AI's recommendation is never permitted to move money or issue links directly. An authoritative backend policy engine enforces attempt caps, amount limits, and contact prerequisites.
3. **Frictionless Dispatch**: If allowed, RecoverAI issues a dedicated Razorpay Test Mode payment link via SMS or email.
4. **Verified Reconciliation**: The transaction is marked `recovered` only after receiving and verifying an HMAC-SHA256 signed Razorpay webhook.

> **Key Takeaway**: AI recommends the strategy, but backend policy rules remain strictly authoritative.

---

## How the Workflow Works

RecoverAI organizes the payment recovery process into six discrete stages:

| Stage | Name | System Responsibility | Description |
| :---: | :--- | :--- | :--- |
| **1** | **Payment Failed** | Razorpay / Backend | A checkout fails on Razorpay (`payment.failed`). The backend captures the event, storing the order ID, amount, method, and error reason. |
| **2** | **Agent Analyzed** | Gemini 3.6 Flash | The recovery agent feeds sanitized payment context and history into Gemini 3.6 Flash. The model outputs structured JSON recommending an action (`CREATE_PAYMENT_LINK`, `RETRY`, `NO_ACTION`, `STOP`, or `HUMAN_REVIEW`) with an analytical explanation. |
| **3** | **Policy Evaluated** | Deterministic Engine | Backend rules review the recommendation. Checks ensure the order hasn't already been recovered, attempt limits aren't exceeded, customer contact exists, and transaction limits are respected. Produces an authoritative `ALLOW`, `DENY`, or `HUMAN_REVIEW` decision. |
| **4** | **Link Dispatched** | Razorpay Test API | Upon approval, the backend recovery executor creates a Razorpay payment link tied to the recovery attempt via `reference_id`. |
| **5** | **Customer Paid** | Customer / Razorpay | The customer opens the payment link and completes the transaction in Razorpay's test checkout. |
| **6** | **Payment Recovered** | Webhook Handler | Razorpay fires a `payment_link.paid` webhook. The backend verifies the HMAC signature, links back to the recovery attempt, transitions the payment state to `recovered`, and updates dashboard metrics. |

---

## AI & Safety Architecture

RecoverAI is built around a **fail-closed** safety philosophy designed specifically for financial workflows:

```
[ Failed Payment Context ] 
           │
           ▼
[ Gemini 3.6 Flash ] ──(Structured JSON Recommendation)──┐
                                                         ▼
                                          [ Deterministic Policy Engine ]
                                          ├── Payment already captured/recovered? ──► DENY (STOP)
                                          ├── Attempts >= RECOVERY_MAX_ATTEMPTS?   ──► DENY (STOP)
                                          ├── Missing customer email/contact?     ──► DENY (NO_ACTION)
                                          ├── Amount > RECOVERY_MAX_AMOUNT_PAISE?  ──► HUMAN_REVIEW
                                          └── Upstream AI failure or timeout?      ──► Fail-Closed (HUMAN_REVIEW)
                                                         │
                                               [ Authoritative Decision ]
```

### Safety Principles

- **Structured & Schema-Validated AI Output**: Gemini 3.6 Flash returns responses constrained to a strict JSON schema. If the model returns unparseable text, unknown action enums, or invalid fields, the backend rejects it.
- **Fail-Closed on Provider Errors**: If Gemini encounters an API error, rate limit, timeout, or missing environment key, the agent immediately defaults to `HUMAN_REVIEW` with `confidence: 0`. It never fails open into automated recovery.
- **Uncalibrated Confidence Ignored**: The policy engine deliberately ignores `confidence` scores generated by the LLM. Subjective model probabilities do not dictate whether payment links are dispatched.
- **Strict Attempt & Amount Caps**: Hard limits (`RECOVERY_MAX_ATTEMPTS` and `RECOVERY_MAX_AMOUNT_PAISE`) prevent endless messaging loops and high-value automated risks.
- **No Dispatch Solely on AI Recommendation**: Creating a recovery attempt requires explicit policy allowance. Executing payment link creation requires either automated policy clearance or manual operator approval.
- **HMAC-SHA256 Webhook Verification**: State transitions to `recovered` are strictly prohibited on client claims or unverified webhooks. The backend computes an HMAC digest over the exact raw request bytes using `RAZORPAY_WEBHOOK_SECRET` and validates it with constant-time equality.
- **Protected Demo Reset**: The demo reset endpoint rejects any payment ID that does not match registered synthetic demo prefixes (`isDemo: true`, `pay_DEMO_*`), responding with `403 Forbidden` to safeguard non-demo records.

---

## Product Walkthrough

The RecoverAI Command Center brings real-time visibility and control to revenue operations:

```
┌────────────────────────────────────────────────────────────────────────┐
│  RecoverAI Command Center                       [Test Mode / Demo Mode]│
├────────────────────────────────────────────────────────────────────────┤
│  [ Revenue at Risk ]  [ Revenue Recovered ]  [ Rate % ]  [ Payments ]  │
├────────────────────────────────────────────────────────────────────────┤
│  Interactive Recovery Lifecycle (Guided 6-Stage Demo Stepper)          │
│  [1. Failed] ─► [2. Analyzed] ─► [3. Policy] ─► [4. Link] ─► [5. Paid] │
├────────────────────────────────────────────────────────────────────────┤
│  Recovery Queue            │  Payment Inspector Drawer                 │
│  • Failed payments at risk │  • Order & method breakdown               │
│  • Failure reason & action │  • Complete recovery timeline             │
│  • Single-click agent run  │  • Manual link dispatch trigger           │
├────────────────────────────────────────────────────────────────────────┤
│  Agent Activity Audit Log                                              │
│  • Timestamp, LLM rationale, policy decision, external reference IDs   │
└────────────────────────────────────────────────────────────────────────┘
```

### Key UI Capabilities

1. **KPI Cards**:
   - **Revenue at Risk**: Total value of currently failed payments awaiting resolution.
   - **Revenue Recovered**: Value successfully reclaimed through verified recovery links.
   - **Recovery Rate**: Real-time recovery percentage with an visual progress indicator.
   - **Total Payments**: Complete tally broken down by captured, recovered, and failed counts.

2. **Recovery Queue**:
   - Lists active failed payments requiring attention with customer identifier, amount, failure reason, and recommended action.
   - Allows operators to trigger agent evaluation or open deep-dive inspection.

3. **Payment Inspector**:
   - Slide-out drawer displaying payment metadata, customer contact availability, and failure diagnosis.
   - Displays a chronological recovery timeline detailing previous attempts, policy decisions, and external link IDs.
   - Provides manual triggers to run the agent or dispatch recovery links.

4. **Agent Activity**:
   - Transparent audit log of every recovery attempt.
   - Details model explanations, policy engine reasons, dispatch error states, and Razorpay reference identifiers.

5. **Interactive Recovery Lifecycle Console**:
   - Embedded interactive stepper on the dashboard for buildathon evaluation.
   - Walks through all 6 stages of the recovery process on dedicated synthetic payment `pay_DEMO_RECOVERAI_001`.

6. **Reset Demo**:
   - Restores the synthetic demo payment to `failed` and clears its attempt records so evaluators can repeat the walkthrough reliably.

### Running the Interactive Demo

1. Open the [Live Demo](https://recover-ai-brown.vercel.app).
2. Confirm the blue **Demo Mode** / **Test Mode** badge is visible in the top header.
3. Locate the **Automated Payment Recovery Lifecycle** console on the Dashboard.
4. Click **"Start Recovery Walkthrough"**:
   - Step 1 displays the failed payment details.
   - Step 2 runs Gemini 3.6 Flash analysis (or mock recommendation if `LLM_MOCK=true`).
   - Step 3 displays the authoritative policy gate result (`ALLOW`).
   - Step 4 dispatches the payment link.
   - Step 5 simulates customer payment completion.
   - Step 6 reconciles the payment to `recovered` and increments the recovery KPIs.
5. Click **"Reset Demo"** at any time to re-run the demonstration cleanly.

---

## Two Operating Modes

RecoverAI supports two distinct execution modes to balance reliable evaluation and real integration testing:

| Feature / Behavior | Demo / Mock Mode | Razorpay Test Mode + Gemini Mode |
| :--- | :--- | :--- |
| **Primary Use Case** | Fast, repeatable buildathon demos without external API dependencies | End-to-end integration testing with real Gemini API and Razorpay sandbox |
| **Configuration** | `DEMO_MODE=true`<br>`RAZORPAY_MOCK=true`<br>`LLM_MOCK=true` | `DEMO_MODE=false` (or demo console enabled)<br>`RAZORPAY_MOCK=false`<br>`LLM_MOCK=false` |
| **AI Processing** | Returns deterministic, simulated recommendations without consuming quota | Sends sanitized payment context to Google Gemini REST API (`gemini-3.6-flash`) |
| **Payment Link Creation** | Generates synthetic link IDs locally; executes real MongoDB state changes | Calls Razorpay API (`/v1/payment_links`) using `rzp_test_*` credentials to generate live test links |
| **Payment Simulation** | Simulates customer link payment via internal `/api/demo/...` reconciliation | Customer opens test checkout short URL; Razorpay delivers real `payment_link.paid` webhook |
| **Network Calls** | Completely self-contained; zero outbound API calls | Live outbound calls to Google Gemini and Razorpay Test Mode endpoints |
| **Real Money Movement** | **None** (Synthetic) | **None** (Razorpay Test Mode only) |

> ⚠️ **Important**: Neither mode moves real funds. All payments operate strictly within Razorpay Test Mode or synthetic simulation.

---

## Architecture Diagram

```mermaid
flowchart TD
    subgraph Client["Frontend (Vercel)"]
        UI["React + Vite UI<br/>(Command Center & Demo Console)"]
    end

    subgraph Backend["Backend API (Render)"]
        API["Express Server"]
        Agent["Recovery Agent & Context Builder"]
        Policy["Deterministic Policy Engine"]
        Exec["Recovery Executor"]
        WebhookHandler["HMAC Webhook Handler"]
    end

    subgraph External["External Services"]
        Gemini["Google Gemini 3.6 Flash<br/>(Structured Pattern Recommendation)"]
        Razorpay["Razorpay Test Mode API<br/>(Payment Link Creation)"]
    end

    subgraph Storage["Database (MongoDB Atlas)"]
        DB[(MongoDB Atlas<br/>Payments & Recovery Attempts)]
    end

    %% Flow
    UI -->|1. Trigger recovery / demo| API
    API --> Agent
    Agent -->|2. Send failure context & history| Gemini
    Gemini -->|3. Structured JSON action & reason| Agent
    Agent --> Policy
    Policy -->|4. Authoritative check ALLOW / DENY / REVIEW| Exec
    Exec -->|5. Create payment link| Razorpay
    Exec -->|Record attempt| DB
    Razorpay -.->|6. Customer completes payment| Razorpay
    Razorpay -->|7. payment_link.paid webhook (Signed HMAC)| WebhookHandler
    WebhookHandler -->|8. Verify signature & reconcile| DB
    DB -.->|9. Updated status reflected| API
    API -.->|10. Live KPI refresh| UI
```

---

## Environment Variables

| Variable | Description | Example / Recommended Value |
| :--- | :--- | :--- |
| `MONGODB_URI` | MongoDB connection string (local or MongoDB Atlas). Point to an isolated database for demo testing. | `mongodb+srv://user:pass@cluster.mongodb.net/recoverai` |
| `PORT` | Port for the Express backend server. | `5000` |
| `FRONTEND_ORIGIN` | Allowed origin(s) for CORS in production/decoupled deployment (comma-separated). | `https://recover-ai-brown.vercel.app` |
| `RAZORPAY_KEY_ID` | Razorpay Test Mode Key ID (must start with `rzp_test_`). | `rzp_test_...` |
| `RAZORPAY_KEY_SECRET` | Razorpay Test Mode Key Secret. Never committed to version control. | `...` |
| `RAZORPAY_WEBHOOK_SECRET` | Secret configured in Razorpay Webhooks dashboard for HMAC-SHA256 signature verification. | `...` |
| `LLM_PROVIDER` | LLM provider backend identifier. | `gemini` |
| `LLM_API_KEY` | Google Gemini API key. Stays server-side; never exposed to frontend. | `AIzaSy...` |
| `LLM_MODEL` | Gemini model version identifier used for structured failure analysis. | `gemini-3.6-flash` |
| `DEMO_MODE` | Enables `/api/demo/*` endpoints and the interactive demo console on the frontend. | `true` (for demos), `false` (in production) |
| `RAZORPAY_MOCK` | When `true`, generates synthetic links locally without outbound calls to Razorpay. | `true` (for mock demo), `false` (for real Test Mode) |
| `LLM_MOCK` | When `true`, returns simulated recovery recommendations without consuming Gemini quota. | `true` (for mock demo), `false` (for live Gemini) |
| `RECOVERY_MAX_ATTEMPTS` | Maximum number of recovery attempts allowed per order before policy forces `STOP`. | `3` |
| `RECOVERY_MAX_AMOUNT_PAISE` | Upper transaction threshold in paise. Payments exceeding this escalate to `HUMAN_REVIEW`. | `50000000` (₹500,000) |

---

## Deployment Overview

RecoverAI is deployed as a decoupled modern web application:

- **Frontend**: Hosted on [Vercel](https://recover-ai-brown.vercel.app) (React + Vite).
- **Backend**: Hosted on [Render](https://recoverai-backend-2efq.onrender.com) (Node.js + Express).
- **Database**: Hosted on [MongoDB Atlas](https://www.mongodb.com/atlas) (Managed M0 cluster).

### Decoupled Configuration

- **Frontend Environment**: Configured with `VITE_API_BASE_URL=https://recoverai-backend-2efq.onrender.com`.
- **Backend Environment**: Configured with `FRONTEND_ORIGIN=https://recover-ai-brown.vercel.app`.
- **Razorpay Webhook Endpoint**:
  ```
  https://recoverai-backend-2efq.onrender.com/api/webhooks/razorpay
  ```
- **Webhook Events Subscribed**: `payment.failed`, `payment.captured`, `payment_link.paid`.

> 🔒 **Notice**: Razorpay keys configured in deployment are strictly **Test Mode** credentials (`rzp_test_`). Real card numbers or real bank accounts are neither supported nor processed.

---

## Testing & Verification

The repository includes targeted automated verification scripts in `backend/scripts` and frontend build checks:

### Demo Safety
```bash
# Verify safe demo reset, 403 non-demo protection, and reset idempotency
cd backend
node scripts/testSafeDemoReset.js
```

### Demo Workflow
```bash
# Verify full interactive demo lifecycle state transitions
cd backend
node scripts/testDemoWorkflow.js
```

### Dashboard & API Routes
```bash
# Verify dashboard KPI aggregations, revenue calculations, and funnel stats
cd backend
node scripts/testDashboardStats.js

# Verify payments route filtering, pagination, and status allowlists
node scripts/testPaymentsRoute.js

# Verify payment inspector detail endpoint and history payload formatting
node scripts/testPaymentDetailRoute.js
```

### Recovery Reconciliation
```bash
# Verify payment link reference linkage and webhook reconciliation
cd backend
node scripts/testRecoveryLinkage.js
```

### Frontend Lint & Build
```bash
# Verify frontend code standards with Oxlint and bundle integrity with Vite
cd frontend
npm run lint
npm run build
```

---

## Security & Demo Limitations

- **Credential Hygiene**: API keys, database credentials, and webhook secrets must never be committed to git. Use environment variables exclusively.
- **Test Mode Only**: This project is configured exclusively for Razorpay Test Mode. It is not intended or certified for live payment processing.
- **Isolated Demo Database**: Always point demo instances to an isolated database collection to prevent test operations from mixing with production data.
- **Scoped Demo Reset**: The reset endpoint is strictly guarded: it accepts only synthetic demo records (`pay_DEMO_*`, `isDemo: true`) and rejects all other records with `403 Forbidden`.
- **Demonstration Scope**: RecoverAI is an operational prototype built for the Razorpay Buildathon to showcase AI reasoning paired with deterministic financial safety rules, not an enterprise-certified payment processing gateway.

---

## Core Philosophy

> **“AI recommends. Policy controls. Razorpay processes. Webhooks verify.”**

RecoverAI demonstrates that AI can add immense value to payment operations without introducing financial risk—by keeping the model advisory and letting deterministic code and verified webhooks govern the money.
