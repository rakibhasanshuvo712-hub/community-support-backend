# Community Support & Direct Donation Platform — Backend API

Fastify + TypeScript + Supabase REST API for direct donor-to-recipient coordination.

## Core Principles

- **Direct Transfers & Handovers**: The platform never holds, collects, or processes donation money.
- **No Payment Gateways**: Never collects card numbers, CVV, PIN, OTP, or bank passwords.
- **Privacy First**: Private contact details (`email`, `phone`, `exact_address`, `exact_handover_address`) are stored in protected tables and never returned in public endpoints.
- **Private Storage**: Post images, avatars, and supporting documents are stored in private Supabase buckets and served via short-lived signed URLs.

## Setup

1. Copy `.env.example` to `.env` and fill in your Supabase credentials.
2. Push migrations to Supabase:
   ```bash
   npx supabase link --project-ref <your-project-ref>
   npx supabase db push
   ```
3. Install dependencies and start:
   ```bash
   npm install
   npm run dev
   ```

## Documentation & Health

- Swagger / OpenAPI UI: `/docs`
- Health Check: `/api/v1/health`

## Scripts

- `npm run dev` — Start development server
- `npm run build` — Compile TypeScript
- `npm run start` — Start production server
- `npm run typecheck` — Run `tsc --noEmit`
- `npm run lint` — Run ESLint
- `npm test` — Run Vitest test suite
