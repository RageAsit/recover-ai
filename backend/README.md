# RecoverAI - Backend

AI-powered revenue recovery agent for the Razorpay Buildathon.

> **Current milestone: backend foundation only.** Express server, environment
> config, an isolated Razorpay service and two endpoints. No database, no AI
> agent, no webhooks, no recovery logic yet.

## Setup

```bash
cd backend
npm install
cp .env.example .env      # then fill in your Razorpay TEST keys
npm run dev
```

Get Test Mode keys from the Razorpay Dashboard → **Account & Settings → API
Keys**, with the dashboard toggled to **Test Mode**. The key id must start with
`rzp_test_`.

## Endpoints

| Method | Path                  | Description                                       |
| ------ | --------------------- | ------------------------------------------------- |
| GET    | `/api/health`         | Server liveness. No external calls.               |
| GET    | `/api/test/razorpay`  | Read-only Razorpay Test Mode connectivity check. Development only. |

## Structure

```
backend/
├── src/
│   ├── server.js                    # boots the HTTP server
│   ├── app.js                       # express app: middleware + routes
│   ├── config/env.js                # loads and validates environment variables
│   ├── routes/
│   │   ├── index.js                 # /api router
│   │   ├── health.routes.js         # GET /api/health
│   │   └── test.routes.js           # GET /api/test/razorpay (dev only)
│   ├── services/
│   │   └── razorpay.service.js      # the only place that calls Razorpay
│   └── middleware/
│       └── errorHandler.js          # 404 + sanitised error responses
├── .env.example
├── .gitignore
└── package.json
```

## Security notes

- `RAZORPAY_KEY_SECRET` is read from the environment, stays in server memory and
  is never logged or returned by any endpoint.
- Razorpay errors are re-shaped in `razorpay.service.js` before they leave the
  service, so the axios error object (which contains the `Authorization` header)
  never reaches a response or a log line.
- The service refuses to run if the key id is not `rzp_test_*`.
- `.env` is git-ignored.
