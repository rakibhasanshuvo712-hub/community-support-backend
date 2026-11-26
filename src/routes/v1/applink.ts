import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { maskTelAddress, toTelAddress } from '../../integrations/applink/address.js';
import {
  getApplinkConfig,
  getApplinkTransportMode,
  redactApplinkForLog,
} from '../../integrations/applink/config.js';
import { requestOtp, unregisterSubscriber, verifyOtp } from '../../integrations/applink/services.js';
import { ApplinkError } from '../../integrations/applink/statusCodes.js';
import { dbQuery, getPool } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';
import { authenticate, requireAdmin } from '../../middleware/auth.js';
import { processPendingSmsOutbox } from '../../services/applinkSms.service.js';

const CALLBACK_ACK = { statusCode: 'S1000', statusDetail: 'Success' };

const deliveryReportSchema = z.object({
  destinationAddress: z.string().min(1),
  timeStamp: z.string().min(1),
  requestId: z.string().min(1),
  deliveryStatus: z.string().min(1),
});

const subscriptionNotifySchema = z.object({
  timeStamp: z.string().min(1),
  version: z.string().optional(),
  applicationId: z.string().min(1),
  password: z.string().optional(),
  subscriberId: z.string().min(1),
  frequency: z.string().optional(),
  status: z.string().min(1),
});

const otpRequestBodySchema = z.object({
  phone: z.string().trim().min(6).max(30),
  consent: z.literal(true),
  consent_wording: z.string().trim().min(10).max(500),
});

const otpVerifyBodySchema = z.object({
  otp: z.string().trim().min(4).max(12),
});

const DLR_STATUS_MAP: Record<string, string> = {
  DELIVERED: 'DELIVERED',
  DELIVRD: 'DELIVERED',
  EXPIRED: 'EXPIRED',
  DELETED: 'DELETED',
  UNDELIVERABLE: 'UNDELIVERABLE',
  UNDELIV: 'UNDELIVERABLE',
  ACCEPTED: 'ACCEPTED',
  ACCEPTD: 'ACCEPTED',
  UNKNOWN: 'UNKNOWN',
  REJECTED: 'REJECTED',
  REJECTD: 'REJECTED',
};

const TERMINAL_DELIVERY_STATUSES = new Set([
  'DELIVERED',
  'EXPIRED',
  'DELETED',
  'UNDELIVERABLE',
  'REJECTED',
]);

export async function applinkRoutes(app: FastifyInstance): Promise<void> {
  // Authenticated status + user binding info
  app.get(
    '/status',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Applink'],
        summary: 'Get Applink integration status and current user SMS binding',
      },
    },
    async (request) => {
      const cfg = getApplinkConfig();
      const smsMode = getApplinkTransportMode(cfg.urls.smsSend);
      const otpMode = getApplinkTransportMode(cfg.urls.otpRequest);

      const bindRes = await dbQuery<{
        normalized_msisdn: string;
        subscription_status: string;
        binding_mode: string;
        consented_at: string;
        last_confirmed_at: string | null;
      }>(
        `SELECT normalized_msisdn, subscription_status, binding_mode, consented_at, last_confirmed_at
         FROM applink_subscriber_bindings WHERE user_id = $1`,
        [request.authUser!.id]
      );

      const binding = bindRes.rows[0];
      return {
        features_enabled: cfg.featuresEnabled,
        otp_enabled: cfg.otpEnabled,
        delivery_reports_enabled: cfg.deliveryReportsEnabled,
        sms_transport_mode: smsMode,
        otp_transport_mode: otpMode,
        binding: binding
          ? {
              masked_msisdn: maskTelAddress(binding.normalized_msisdn),
              subscription_status: binding.subscription_status,
              binding_mode: binding.binding_mode,
              consented_at: binding.consented_at,
              last_confirmed_at: binding.last_confirmed_at,
            }
          : null,
      };
    }
  );

  // User's SMS notification outbox history (or admin all)
  app.get(
    '/outbox',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Applink'],
        summary: 'List SMS notification outbox records for the authenticated user',
      },
    },
    async (request) => {
      const isAdmin = request.authUser!.role === 'admin';
      const res = isAdmin
        ? await dbQuery(
            `SELECT id, business_event_key, recipient_user_id, claim_id, transport_mode, status, attempts, provider_request_id, provider_status_code, delivery_status, last_error, created_at, updated_at
             FROM applink_sms_outbox ORDER BY created_at DESC LIMIT 50`
          )
        : await dbQuery(
            `SELECT id, business_event_key, claim_id, transport_mode, status, attempts, provider_request_id, provider_status_code, delivery_status, created_at, updated_at
             FROM applink_sms_outbox WHERE recipient_user_id = $1 ORDER BY created_at DESC LIMIT 20`,
            [request.authUser!.id]
          );

      return { outbox: res.rows };
    }
  );

  // Admin-triggered bounded retry processor
  app.post(
    '/outbox/process',
    {
      preHandler: [requireAdmin],
      schema: {
        tags: ['Applink'],
        summary: 'Process queued/retryable SMS outbox entries (admin only)',
      },
    },
    async () => {
      return processPendingSmsOutbox(10);
    }
  );

  // Priority 5: SMS Delivery Status Report Callback
  app.post(
    '/sms/report',
    {
      schema: {
        tags: ['Applink Callbacks'],
        summary: 'Inbound Applink SMS delivery status report callback',
      },
    },
    async (request, reply) => {
      const cfg = getApplinkConfig();
      if (!cfg.deliveryReportsEnabled) {
        return reply.status(200).send(CALLBACK_ACK);
      }

      const parsed = deliveryReportSchema.safeParse(request.body);
      if (!parsed.success) {
        request.log.warn({ path: '/applink/sms/report' }, 'Ignored malformed Applink DLR payload');
        return reply.status(200).send(CALLBACK_ACK);
      }

      const { destinationAddress, timeStamp, requestId, deliveryStatus } = parsed.data;
      const normalizedStatus = DLR_STATUS_MAP[deliveryStatus.trim().toUpperCase()] ?? 'UNKNOWN';
      const dedupeKey = `${requestId}:${normalizedStatus}`;

      const insertRes = await dbQuery<{ id: string }>(
        `INSERT INTO applink_delivery_reports (
          request_id, destination_address, delivery_status, raw_delivery_status, event_timestamp, dedupe_key
        ) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (dedupe_key) DO NOTHING
        RETURNING id`,
        [requestId, maskTelAddress(destinationAddress), normalizedStatus, deliveryStatus, timeStamp, dedupeKey]
      );

      if (insertRes.rows.length > 0) {
        // Correlate to outbox by provider_request_id and handle out-of-order reports
        const outboxRes = await dbQuery<{ id: string; status: string; delivery_status: string | null }>(
          `SELECT id, status, delivery_status FROM applink_sms_outbox WHERE provider_request_id = $1`,
          [requestId]
        );
        const outbox = outboxRes.rows[0];
        if (outbox) {
          const alreadyTerminal =
            outbox.delivery_status && TERMINAL_DELIVERY_STATUSES.has(outbox.delivery_status);

          if (!alreadyTerminal || TERMINAL_DELIVERY_STATUSES.has(normalizedStatus)) {
            const nextOutboxStatus =
              normalizedStatus === 'DELIVERED'
                ? 'delivered'
                : ['EXPIRED', 'DELETED', 'UNDELIVERABLE', 'REJECTED'].includes(normalizedStatus)
                  ? 'failed'
                  : outbox.status;

            await dbQuery(
              `UPDATE applink_sms_outbox
               SET delivery_status = $1,
                   status = $2,
                   updated_at = NOW()
               WHERE id = $3`,
              [normalizedStatus, nextOutboxStatus, outbox.id]
            );
          }
        }
      }

      return reply.status(200).send(CALLBACK_ACK);
    }
  );

  // Subscription Notification Callback (keeps local subscription mirror accurate)
  app.post(
    '/subscription/notify',
    {
      schema: {
        tags: ['Applink Callbacks'],
        summary: 'Inbound Applink subscription status notification callback',
      },
    },
    async (request, reply) => {
      const cfg = getApplinkConfig();
      const rawBody =
        typeof request.body === 'object' && request.body !== null
          ? redactApplinkForLog(request.body as Record<string, unknown>)
          : {};

      const parsed = subscriptionNotifySchema.safeParse(request.body);
      if (!parsed.success) {
        request.log.warn({ body: rawBody }, 'Ignored malformed Applink subscription notification');
        return reply.status(200).send(CALLBACK_ACK);
      }

      const data = parsed.data;
      if (cfg.appId && data.applicationId !== cfg.appId) {
        request.log.warn({ applicationId: data.applicationId }, 'Mismatched applicationId in callback');
        return reply.status(200).send(CALLBACK_ACK);
      }

      const dedupeKey = `${data.subscriberId}:${data.status}:${data.timeStamp}`;
      const inserted = await dbQuery(
        `INSERT INTO applink_subscription_events (subscriber_id, status, event_timestamp, dedupe_key)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (dedupe_key) DO NOTHING
         RETURNING id`,
        [data.subscriberId, data.status, data.timeStamp, dedupeKey]
      );

      if (inserted.rows.length > 0) {
        await dbQuery(
          `UPDATE applink_subscriber_bindings
           SET subscription_status = $1,
               last_confirmed_at = NOW(),
               updated_at = NOW()
           WHERE subscriber_id = $2`,
          [data.status, data.subscriberId]
        );
      }

      return reply.status(200).send(CALLBACK_ACK);
    }
  );

  // Priority 6: Optional OTP Subscriber Binding Flow
  app.post(
    '/binding/otp/request',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Applink OTP'],
        summary: 'Request an Applink OTP to bind a Banglalink phone number for SMS alerts',
      },
    },
    async (request, reply) => {
      const cfg = getApplinkConfig();
      if (!cfg.featuresEnabled || !cfg.otpEnabled) {
        throw new AppError(
          503,
          'SERVICE_UNAVAILABLE',
          'Applink OTP verification is currently disabled.'
        );
      }
      if (!cfg.urls.otpRequest || !cfg.urls.otpVerify) {
        throw new AppError(
          503,
          'SERVICE_UNAVAILABLE',
          'Applink OTP endpoints are not configured.'
        );
      }

      const body = otpRequestBodySchema.parse(request.body);
      const normalizedMsisdn = toTelAddress(body.phone);
      const providerMode = getApplinkTransportMode(cfg.urls.otpRequest);
      if (providerMode === 'disabled') {
        throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Applink OTP endpoint is disabled');
      }

      const userId = request.authUser!.id;

      // Enforce per-user cooldown (60s) & hourly limit (5) across serverless instances
      const recentRes = await dbQuery<{ count: string; last_created: string | null }>(
        `SELECT COUNT(*)::text AS count, MAX(created_at)::text AS last_created
         FROM applink_otp_challenges
         WHERE (user_id = $1 OR normalized_msisdn = $2)
           AND created_at > NOW() - INTERVAL '1 hour'`,
        [userId, normalizedMsisdn]
      );

      const recentCount = Number(recentRes.rows[0]?.count ?? 0);
      const lastCreated = recentRes.rows[0]?.last_created;
      if (recentCount >= 5) {
        throw new AppError(429, 'RATE_LIMITED', 'Hourly OTP request limit reached. Please try again later.');
      }
      if (lastCreated && Date.now() - new Date(lastCreated).getTime() < 60_000) {
        throw new AppError(429, 'RATE_LIMITED', 'Please wait 60 seconds before requesting another OTP.');
      }

      let otpResp;
      try {
        otpResp = await requestOtp(normalizedMsisdn, {
          client: 'WEBAPP',
          os: 'WEB',
        });
      } catch (err) {
        if (err instanceof ApplinkError) {
          throw new AppError(502, 'BAD_REQUEST', `OTP request failed (${err.statusCode}): ${err.statusDetail}`);
        }
        throw err;
      }

      if (!otpResp.referenceNo) {
        throw new AppError(502, 'INTERNAL_ERROR', 'Applink did not return an OTP referenceNo');
      }

      // Expire any previous pending challenges for this user
      await dbQuery(
        `UPDATE applink_otp_challenges SET status = 'expired' WHERE user_id = $1 AND status = 'pending'`,
        [userId]
      );

      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      await dbQuery(
        `INSERT INTO applink_otp_challenges (
          user_id, normalized_msisdn, provider_mode, reference_no, consent_wording, status, expires_at
        ) VALUES ($1, $2, $3, $4, $5, 'pending', $6)`,
        [userId, normalizedMsisdn, providerMode, String(otpResp.referenceNo), body.consent_wording, expiresAt]
      );

      return reply.status(201).send({
        status: providerMode === 'mock' ? 'simulated' : 'sent',
        masked_msisdn: maskTelAddress(normalizedMsisdn),
        expires_in_seconds: 300,
        demo_mode: providerMode === 'mock',
      });
    }
  );

  app.post(
    '/binding/otp/verify',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Applink OTP'],
        summary: 'Verify an Applink OTP and bind the subscriberId to the user account',
      },
    },
    async (request) => {
      const cfg = getApplinkConfig();
      if (!cfg.featuresEnabled || !cfg.otpEnabled) {
        throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Applink OTP verification is currently disabled.');
      }

      const body = otpVerifyBodySchema.parse(request.body);
      const userId = request.authUser!.id;
      const providerMode = getApplinkTransportMode(cfg.urls.otpVerify);
      if (providerMode === 'disabled') {
        throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Applink OTP verify endpoint is disabled');
      }

      const client = await getPool().connect();
      let challenge: {
        id: string;
        normalized_msisdn: string;
        provider_mode: 'mock' | 'live';
        reference_no: string;
        consent_wording: string;
        attempts: number;
        max_attempts: number;
        expires_at: string;
      };

      try {
        await client.query('BEGIN');
        const chRes = await client.query<typeof challenge>(
          `SELECT id, normalized_msisdn, provider_mode, reference_no, consent_wording, attempts, max_attempts, expires_at
           FROM applink_otp_challenges
           WHERE user_id = $1 AND status = 'pending' AND provider_mode = $2
           ORDER BY created_at DESC
           LIMIT 1
           FOR UPDATE`,
          [userId, providerMode]
        );
        const row = chRes.rows[0];
        if (!row) {
          throw new AppError(400, 'BAD_REQUEST', 'No pending OTP challenge found. Please request a new OTP.');
        }
        if (new Date(row.expires_at).getTime() <= Date.now()) {
          await client.query(`UPDATE applink_otp_challenges SET status = 'expired' WHERE id = $1`, [row.id]);
          await client.query('COMMIT');
          throw new AppError(400, 'BAD_REQUEST', 'OTP has expired. Please request a new OTP.');
        }
        if (row.attempts >= row.max_attempts) {
          await client.query(`UPDATE applink_otp_challenges SET status = 'locked' WHERE id = $1`, [row.id]);
          await client.query('COMMIT');
          throw new AppError(429, 'RATE_LIMITED', 'Too many failed OTP attempts. Please request a new OTP.');
        }

        await client.query(`UPDATE applink_otp_challenges SET attempts = attempts + 1 WHERE id = $1`, [row.id]);
        challenge = row;
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }

      let verifyResp;
      try {
        verifyResp = await verifyOtp(challenge.reference_no, body.otp);
      } catch (err) {
        if (err instanceof ApplinkError) {
          throw new AppError(400, 'BAD_REQUEST', `OTP verification failed (${err.statusCode}): ${err.statusDetail}`);
        }
        throw err;
      }

      const subscriberId = String(verifyResp.subscriberId || challenge.normalized_msisdn);
      const subscriptionStatus = String(verifyResp.subscriptionStatus || 'REGISTERED');
      const now = new Date().toISOString();

      await dbQuery(
        `UPDATE applink_otp_challenges SET status = 'verified', verified_at = $1 WHERE id = $2 AND status = 'pending'`,
        [now, challenge.id]
      );

      await dbQuery(
        `INSERT INTO applink_subscriber_bindings (
          user_id, normalized_msisdn, subscriber_id, subscription_status, binding_mode,
          consent_wording, consent_channel, consented_at, last_confirmed_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, 'web_otp', $7, $7, $7)
        ON CONFLICT (user_id) DO UPDATE SET
          normalized_msisdn = EXCLUDED.normalized_msisdn,
          subscriber_id = EXCLUDED.subscriber_id,
          subscription_status = EXCLUDED.subscription_status,
          binding_mode = EXCLUDED.binding_mode,
          consent_wording = EXCLUDED.consent_wording,
          consent_channel = EXCLUDED.consent_channel,
          consented_at = EXCLUDED.consented_at,
          last_confirmed_at = EXCLUDED.last_confirmed_at,
          updated_at = NOW()`,
        [
          userId,
          challenge.normalized_msisdn,
          subscriberId,
          subscriptionStatus,
          challenge.provider_mode,
          challenge.consent_wording,
          now,
        ]
      );

      return {
        verified: true,
        demo_mode: challenge.provider_mode === 'mock',
        masked_msisdn: maskTelAddress(challenge.normalized_msisdn),
        subscription_status: subscriptionStatus,
      };
    }
  );

  app.post(
    '/binding/opt-out',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Applink OTP'],
        summary: 'Opt out of Applink SMS notifications and unregister subscriber',
      },
    },
    async (request) => {
      const userId = request.authUser!.id;
      const cfg = getApplinkConfig();

      const bindRes = await dbQuery<{ subscriber_id: string; binding_mode: string }>(
        'SELECT subscriber_id, binding_mode FROM applink_subscriber_bindings WHERE user_id = $1',
        [userId]
      );
      const binding = bindRes.rows[0];
      if (!binding) {
        return { success: true, subscription_status: 'UNREGISTERED' };
      }

      if (cfg.urls.subscriptionSend) {
        const subMode = getApplinkTransportMode(cfg.urls.subscriptionSend);
        if (subMode === binding.binding_mode) {
          try {
            await unregisterSubscriber(binding.subscriber_id);
          } catch (err) {
            request.log.warn({ err }, 'Applink unregister call failed during opt-out; updating local mirror');
          }
        }
      }

      await Promise.all([
        dbQuery(
          `UPDATE applink_subscriber_bindings
           SET subscription_status = 'UNREGISTERED', last_confirmed_at = NOW(), updated_at = NOW()
           WHERE user_id = $1`,
          [userId]
        ),
        dbQuery(
          `UPDATE applink_sms_outbox
           SET status = 'failed', last_error = 'Cancelled due to user opt-out', next_retry_at = NULL, updated_at = NOW()
           WHERE recipient_user_id = $1 AND status = 'queued'`,
          [userId]
        ),
      ]);

      return { success: true, subscription_status: 'UNREGISTERED' };
    }
  );
}
