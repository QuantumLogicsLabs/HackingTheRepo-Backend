# HackingTheRepo — Backend

> Express.js REST API that manages AI-powered code-refactoring jobs, authenticates users via JWT, and orchestrates the **RepoMind** FastAPI agent to open real GitHub PRs.

---

## Table of Contents

- [Tech Stack](#tech-stack)
- [Architecture Overview](#architecture-overview)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [API Reference](#api-reference)
- [Scripts](#scripts)
- [Deployment](#deployment)
- [Upgrade Roadmap](#upgrade-roadmap)

---

## Tech Stack

| Layer            | Tool                           | Version |
| ---------------- | ------------------------------ | ------- |
| Runtime          | Node.js                        | ≥ 18    |
| Framework        | Express.js                     | 4.x     |
| Database         | MongoDB (Mongoose)             | 7.x     |
| Auth             | JSON Web Tokens (jsonwebtoken) | 9.x     |
| Password hashing | bcryptjs                       | 2.x     |
| HTTP client      | Axios                          | 1.x     |
| Deployment       | Vercel (serverless)            | —       |

---

## Architecture Overview

```
Browser / Frontend
        │
        ▼
  Express API  (:5000)
  ├── /api/auth      ← JWT signup / login / me
  ├── /api/jobs      ← CRUD + polling + refinement
  ├── /api/settings  ← GitHub & OpenAI key management
  └── /api/health    ← liveness probe
        │
        ▼
  RepoMind FastAPI  (:8000)   ←  AI agent + GitHub PR creator
        │
        ▼
  MongoDB Atlas                ←  Users, Jobs
```

---

## Project Structure

```
backend/
├── middleware/
│   └── auth.js          # JWT protect middleware
├── models/
│   ├── Job.js           # Job schema (status, prUrl, refinements…)
│   └── User.js          # User schema + bcrypt hooks
├── routes/
│   ├── auth.js          # POST /signup  POST /login  GET /me
│   ├── jobs.js          # Full job lifecycle CRUD
│   └── settings.js      # GitHub token & OpenAI key storage
├── index.js             # Entry point — Express app bootstrap
├── vercel.json          # Vercel serverless config
├── .env.example         # Copy → .env and fill in values
└── .gitignore
```

---

## Getting Started

### Prerequisites

- Node.js ≥ 18
- MongoDB (local or Atlas)
- RepoMind FastAPI running on `:8000` (see `/repomind`)

### Install & Run

```bash
cd backend
npm install
cp .env.example .env   # fill in your values
npm run dev            # starts with nodemon on :5000
```

---

## Environment Variables

Copy `.env.example` → `.env` and populate every value:

| Variable                   | Required | Description                                                |
| -------------------------- | -------- | ---------------------------------------------------------- |
| `MONGO_URI`                | ✅       | MongoDB connection string                                  |
| `JWT_SECRET`               | ✅       | Long random string for signing tokens                      |
| `REPOMIND_API_URL`         | ✅       | URL of the FastAPI agent (default `http://localhost:8000`) |
| `REPOMIND_GITHUB_TOKEN`    | ✅       | GitHub PAT for the bot account that opens PRs              |
| `REPOMIND_GITHUB_USERNAME` | ✅       | GitHub username of the bot account                         |
| `OPENAI_API_KEY`           | ✅       | OpenAI key forwarded to RepoMind agent                     |
| `PORT`                     | —        | HTTP port (default `5000`)                                 |

> ⚠️ **Never commit `.env`** — it is already in `.gitignore`.

---

## API Reference

All routes are prefixed with `/api`.

### Auth — `/api/auth`

| Method | Path      | Auth      | Description                 |
| ------ | --------- | --------- | --------------------------- |
| `POST` | `/signup` | ❌        | Register a new user         |
| `POST` | `/login`  | ❌        | Login and receive a JWT     |
| `GET`  | `/me`     | ✅ Bearer | Return current user profile |

**POST /api/auth/signup** — Body: `{ username, email, password }`

**POST /api/auth/login** — Body: `{ email, password }`

All authenticated routes require: `Authorization: Bearer <token>`

---

### Jobs — `/api/jobs`

| Method   | Path          | Auth | Description                                     |
| -------- | ------------- | ---- | ----------------------------------------------- |
| `POST`   | `/`           | ✅   | Create a new job (queues it to RepoMind)        |
| `GET`    | `/`           | ✅   | List all jobs for the logged-in user            |
| `GET`    | `/:id`        | ✅   | Get a single job by ID                          |
| `GET`    | `/:id/status` | ✅   | Poll live status from RepoMind                  |
| `POST`   | `/:id/refine` | ✅   | Add a refinement instruction to an existing job |
| `DELETE` | `/:id`        | ✅   | Delete a job                                    |

**POST /api/jobs** — Body:

```json
{
  "repoUrl": "https://github.com/owner/repo",
  "instruction": "Add unit tests for all utility functions",
  "branchName": "repomind/add-tests", // optional — auto-generated if omitted
  "prTitle": "chore: add utility tests" // optional — auto-generated if omitted
}
```

**Job Status Enum:** `queued` → `running` → `completed` | `failed` | `refined`

---

### Settings — `/api/settings`

| Method | Path | Auth | Description                                  |
| ------ | ---- | ---- | -------------------------------------------- |
| `GET`  | `/`  | ✅   | Get masked GitHub/OpenAI keys                |
| `PUT`  | `/`  | ✅   | Update GitHub username, token, or OpenAI key |

---

### Health

| Method | Path          | Description                                   |
| ------ | ------------- | --------------------------------------------- |
| `GET`  | `/api/health` | Returns `{ status: "ok", bot: "<username>" }` |

---

## Scripts

```bash
npm run dev     # nodemon hot-reload
npm start       # node index.js (production)
```

---

## Deployment

The project includes `vercel.json` for one-click Vercel deployment.

```bash
npm i -g vercel
vercel --prod
```

Add all environment variables in the Vercel dashboard under **Settings → Environment Variables**.

---

## Upgrade Roadmap

Planned improvements to bring the backend to industry-standard production quality.

### Phase 1 — API Documentation (Swagger UI)

> Estimated effort: 1–2 days

Install **swagger-jsdoc** + **swagger-ui-express** to auto-generate interactive docs from JSDoc comments:

```bash
npm install swagger-jsdoc swagger-ui-express
```

Add to `index.js`:

```js
import swaggerJsdoc from "swagger-jsdoc";
import swaggerUi from "swagger-ui-express";

const spec = swaggerJsdoc({
  definition: {
    openapi: "3.0.0",
    info: { title: "HackingTheRepo API", version: "1.0.0" },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      },
    },
    security: [{ bearerAuth: [] }],
  },
  apis: ["./routes/*.js"],
});
app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(spec));
```

Then annotate routes with JSDoc `@swagger` blocks. Docs will be live at `http://localhost:5000/api/docs`.

---

### Phase 2 — Input Validation (Zod)

Replace ad-hoc `if (!field)` checks with **Zod** schema validation:

```bash
npm install zod
```

```js
import { z } from "zod";

const createJobSchema = z.object({
  repoUrl: z.string().url(),
  instruction: z.string().min(10).max(1000),
  branchName: z.string().optional(),
  prTitle: z.string().optional(),
});

// In route:
const parsed = createJobSchema.safeParse(req.body);
if (!parsed.success) return res.status(400).json(parsed.error.format());
```

---

### Phase 3 — Rate Limiting & Security Headers

```bash
npm install express-rate-limit helmet
```

```js
import rateLimit from "express-rate-limit";
import helmet from "helmet";

app.use(helmet());
app.use("/api/auth", rateLimit({ windowMs: 15 * 60 * 1000, max: 20 }));
app.use("/api/jobs", rateLimit({ windowMs: 60 * 1000, max: 30 }));
```

---

### Phase 4 — Structured Logging (Pino)

Replace `console.log` with **Pino** for JSON logs compatible with Datadog / CloudWatch:

```bash
npm install pino pino-http
```

```js
import pino from "pino";
import pinoHttp from "pino-http";

const logger = pino({ level: process.env.LOG_LEVEL || "info" });
app.use(pinoHttp({ logger }));
```

---

### Phase 5 — Job Queue (BullMQ + Redis)

Replace the fire-and-forget Axios call to RepoMind with a proper **BullMQ** queue backed by Redis, enabling retries, concurrency control, and a dashboard:

```bash
npm install bullmq ioredis
```

Benefits:

- Automatic retry on transient failures
- Dead-letter queue for permanently failed jobs
- Bull Board UI for queue monitoring (`@bull-board/express`)
- Backpressure & concurrency limits

---

### Phase 6 — Testing (Vitest + Supertest)

```bash
npm install -D vitest supertest @vitest/coverage-v8
```

Structure:

```
backend/
└── tests/
    ├── auth.test.js
    ├── jobs.test.js
    └── settings.test.js
```

Run:

```bash
npx vitest run --coverage
```

---

### Phase 7 — CI/CD (GitHub Actions)

Add `.github/workflows/backend-ci.yml`:

```yaml
name: Backend CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      mongo:
        image: mongo:7
        ports: ["27017:27017"]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "20" }
      - run: npm ci
      - run: npm test
      - run: npm run lint
```

---

### Phase 8 — Database Migrations (migrate-mongo)

```bash
npm install migrate-mongo
```

Tracks schema changes as versioned migration scripts, preventing data loss during production deploys.

---

### Phase 9 — Observability

| Tool                           | Purpose                                     |
| ------------------------------ | ------------------------------------------- |
| **Sentry** (`@sentry/node`)    | Error tracking & alerting                   |
| **Prometheus** (`prom-client`) | Custom metrics endpoint `/metrics`          |
| **OpenTelemetry**              | Distributed traces across Express → FastAPI |

---

### Summary Roadmap

```
v1.0  ✅  Current (Express, JWT, MongoDB, Vercel)
v1.1  →  Swagger UI docs + Zod validation
v1.2  →  Helmet + Rate limiting + Pino logging
v1.3  →  BullMQ job queue + Bull Board dashboard
v1.4  →  Vitest + Supertest test suite (>80% coverage)
v1.5  →  GitHub Actions CI/CD pipeline
v2.0  →  Sentry + OpenTelemetry observability
```
