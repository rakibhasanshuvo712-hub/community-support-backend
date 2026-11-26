# Applink Integration & Live Activation Guide

This document covers local mock testing and the exact steps required to activate live Applink SMS, Delivery Reports, and optional OTP subscription binding once our real Applink API key and provisioning are approved.

## 1. Local Mock Testing (No Real SMS Sent)

> **Important:** A Vercel-deployed backend **cannot** reach a developer's local mock at `127.0.0.1`. Run mock testing locally only.

1. Start the official Applink mock in one terminal (from the `Applink-as-a-skill` repo):
   ```bash
   APPLINK_APP_ID=APP_XXXXXX APPLINK_PASSWORD=local-test-only node scripts/mock-applink.mjs --strict-credentials
   ```
2. Configure `backend/.env` (never commit `.env`):
   ```env
   APPLINK_FEATURES_ENABLED=true
   APPLINK_OTP_ENABLED=true
   APPLINK_DELIVERY_REPORTS_ENABLED=true
   APPLINK_APP_ID=APP_XXXXXX
   APPLINK_PASSWORD=local-test-only
   APPLINK_SMS_SEND_URL=http://127.0.0.1:8089/sms/send
   APPLINK_OTP_REQUEST_URL=http://127.0.0.1:8089/otp/request
   APPLINK_OTP_VERIFY_URL=http://127.0.0.1:8089/otp/verify
   APPLINK_SUBSCRIPTION_SEND_URL=http://127.0.0.1:8089/subscription/send
   ```
3. Start the backend (`npm run dev`) and frontend (`npm run dev`).
4. In the Dashboard → Settings, the UI displays **`Demo mode — no real SMS sent`**. Mock bindings are recorded with `binding_mode = 'mock'` and **never** qualify for live SMS.

## 2. Live Activation Checklist (After Real API Key Arrives)

1. **Required Approval & Provisioned Services**
   - Confirm the Applink application has moved from **Draft** to **Limited Production** (for whitelisted Banglalink test numbers) and then **Production**.
   - Confirm which APIs are provisioned (`SMS Send`, `OTP`, `Subscription`). Only set `APPLINK_*_URL` for provisioned services.

2. **Backend Secret Configuration**
   - Set server-side environment variables on the backend host (never `NEXT_PUBLIC_*`, never in `.env.example` or Git):
     - `APPLINK_APP_ID=<your-approved-app-id>`
     - `APPLINK_PASSWORD=<your-emailed-api-key>`
     - `APPLINK_FEATURES_ENABLED=true`
     - `APPLINK_DELIVERY_REPORTS_ENABLED=true` (only if DLR callback is registered)
     - `APPLINK_OTP_ENABLED=false` (keep disabled until subscription/charging terms are confirmed)

3. **Real Production Endpoints**
   - SMS Send:
     ```env
     APPLINK_SMS_SEND_URL=https://api.applink.com.bd/sms/send
     ```
   - Only when OTP & Subscription are approved and configured:
     ```env
     APPLINK_OTP_REQUEST_URL=https://api.applink.com.bd/otp/request
     APPLINK_OTP_VERIFY_URL=https://api.applink.com.bd/otp/verify
     APPLINK_SUBSCRIPTION_SEND_URL=https://api.applink.com.bd/subscription/send
     ```

4. **Static Outbound Public IP Allowlisting & Hosting Decision (Unresolved on Vercel Hobby)**
   - Applink enforces strict outbound IP allowlisting (`E1303` if unapproved).
   - **Important:** The website domain's DNS IP is **not** the backend's outbound IP.
   - **Vercel Hobby Limitation:** Vercel Hobby serverless functions use rotating outbound IPs by default and do not provide a static egress IP. Before calling `https://api.applink.com.bd/*` from production, we must decide on a static-egress architecture (e.g., routing Applink calls through a static-IP egress proxy / NAT gateway, or hosting the backend on a fixed-IP node) and run `curl -4 https://api.ipify.org` **from that egress host** to whitelist the exact IP in the Applink portal.

5. **Whitelisted Banglalink Test Numbers (Limited Production)**
   - In Limited Production, only whitelisted Banglalink MSISDNs can receive SMS (`E1343` otherwise). Add test numbers in the Applink portal before testing.

6. **Public HTTPS Callback Registration & Security Limitations**
   - Register stable, public HTTPS URLs in the Applink portal:
     - Delivery Status Report: `https://<backend-host>/api/v1/applink/sms/report`
     - Subscription Notification: `https://<backend-host>/api/v1/applink/subscription/notify`
   - **Authentication Limitation:** Applink does not sign inbound webhooks with HMAC. `subscription/notify` includes `applicationId` and `password` (which our handler redacts before logging), while `sms/report` does not include credentials. Restrict these callback routes to Applink's published source IP ranges at the firewall/gateway level.

7. **Consent & Charging Configuration Confirmation**
   - Keep `APPLINK_OTP_ENABLED=false` until the exact subscription/charging agreement (amount in BDT, frequency, or zero-charge terms) is confirmed in the Applink portal and disclosed verbatim in the consent checkbox.

8. **Controlled Real SMS Test & Bounded Retries**
   - Test with a single whitelisted Banglalink number first.
   - Verify `applink_sms_outbox` transitions from `queued` → `provider_accepted` → `delivered` (via DLR).
   - Bounded retries for transient errors (`E1318`, `E1319`, `E1341`, `E1601`–`E1603`) can be triggered via `POST /api/v1/applink/outbox/process` (admin-only). Rows marked `unknown` (ambiguous 15s timeout) are never automatically resent.
