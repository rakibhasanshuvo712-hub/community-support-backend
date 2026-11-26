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
import { getDb, newId } from '../../lib/mongo.js';
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

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: number }).code === 11000;
}

export async function applinkRoutes(app: FastifyInstance): Promise<void> {
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

      const db = await getDb();
      const binding = await db.collection('applink_subscriber_bindings').findOne(
        { user_id: request.authUser!.id },
        {
          projection: {
            _id: 0,
            normalized_msisdn: 1,
            subscription_status: 1,
            binding_mode: 1,
            consented_at: 1,
            last_confirmed_at: 1,
          },
        }
      );

      return {
        features_enabled: cfg.featuresEnabled,
        otp_enabled: cfg.otpEnabled,
        delivery_reports_enabled: cfg.deliveryReportsEnabled,
        sms_transport_mode: smsMode,
        otp_transport_mode: otpMode,
        binding: binding
          ? {
              masked_msisdn: maskTelAddress(String(binding.normalized_msisdn)),
              subscription_status: binding.subscription_status,
              binding_mode: binding.binding_mode,
              consented_at: binding.consented_at,
              last_confirmed_at: binding.last_confirmed_at,
            }
          : null,
      };
    }
  );

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
      const db = await getDb();

      const outbox = isAdmin
        ? await db
            .collection('applink_sms_outbox')
            .find(
              {},
              {
                projection: {
                  _id: 0,
                  id: 1,
                  business_event_key: 1,
                  recipient_user_id: 1,
                  claim_id: 1,
                  transport_mode: 1,
                  status: 1,
                  attempts: 1,
                  provider_request_id: 1,
                  provider_status_code: 1,
                  delivery_status: 1,
                  last_error: 1,
                  created_at: 1,
                  updated_at: 1,
                },
              }
            )
            .sort({ created_at: -1 })
            .limit(50)
            .toArray()
        : await db
            .collection('applink_sms_outbox')
            .find(
              { recipient_user_id: request.authUser!.id },
              {
                projection: {
                  _id: 0,
                  id: 1,
                  business_event_key: 1,
                  claim_id: 1,
                  transport_mode: 1,
                  status: 1,
                  attempts: 1,
                  provider_request_id: 1,
                  provider_status_code: 1,
                  delivery_status: 1,
                  created_at: 1,
                  updated_at: 1,
                },
              }
            )
            .sort({ created_at: -1 })
            .limit(20)
            .toArray();

      return { outbox };
    }
  );

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
      const db = await getDb();

      let inserted = false;
      try {
        await db.collection('applink_delivery_reports').insertOne({
          id: newId(),
          request_id: requestId,
          destination_address: maskTelAddress(destinationAddress),
          delivery_status: normalizedStatus,
          raw_delivery_status: deliveryStatus,
          event_timestamp: timeStamp,
          dedupe_key: dedupeKey,
          created_at: new Date().toISOString(),
        });
        inserted = true;
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
      }

      if (inserted) {
        const outbox = await db.collection('applink_sms_outbox').findOne(
          { provider_request_id: requestId },
          { projection: { _id: 0, id: 1, status: 1, delivery_status: 1 } }
        );
        if (outbox) {
          const alreadyTerminal =
            outbox.delivery_status && TERMINAL_DELIVERY_STATUSES.has(String(outbox.delivery_status));

          if (!alreadyTerminal || TERMINAL_DELIVERY_STATUSES.has(normalizedStatus)) {
            const nextOutboxStatus =
              normalizedStatus === 'DELIVERED'
                ? 'delivered'
                : ['EXPIRED', 'DELETED', 'UNDELIVERABLE', 'REJECTED'].includes(normalizedStatus)
                  ? 'failed'
                  : outbox.status;

            await db.collection('applink_sms_outbox').updateOne(
              { id: outbox.id },
              {
                $set: {
                  delivery_status: normalizedStatus,
                  status: nextOutboxStatus,
                  updated_at: new Date().toISOString(),
                },
              }
            );
          }
        }
      }

      return reply.status(200).send(CALLBACK_ACK);
    }
  );

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

      const db = await getDb();
      const dedupeKey = `${data.subscriberId}:${data.status}:${data.timeStamp}`;
      let inserted = false;
      try {
        await db.collection('applink_subscription_events').insertOne({
          id: newId(),
          subscriber_id: data.subscriberId,
          status: data.status,
          event_timestamp: data.timeStamp,
          dedupe_key: dedupeKey,
          created_at: new Date().toISOString(),
        });
        inserted = true;
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
      }

      if (inserted) {
        const now = new Date().toISOString();
        await db.collection('applink_subscriber_bindings').updateMany(
          { subscriber_id: data.subscriberId },
          { $set: { subscription_status: data.status, last_confirmed_at: now, updated_at: now } }
        );
      }

      return reply.status(200).send(CALLBACK_ACK);
    }
  );

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
      const db = await getDb();
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

      const recentChallenges = await db
        .collection('applink_otp_challenges')
        .find(
          {
            $or: [{ user_id: userId }, { normalized_msisdn: normalizedMsisdn }],
            created_at: { $gt: oneHourAgo },
          },
          { projection: { _id: 0, created_at: 1 } }
        )
        .sort({ created_at: -1 })
        .toArray();

      if (recentChallenges.length >= 5) {
        throw new AppError(429, 'RATE_LIMITED', 'Hourly OTP request limit reached. Please try again later.');
      }
      const lastCreated = recentChallenges[0]?.created_at as string | undefined;
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

      await db
        .collection('applink_otp_challenges')
        .updateMany({ user_id: userId, status: 'pending' }, { $set: { status: 'expired' } });

      const now = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      await db.collection('applink_otp_challenges').insertOne({
        id: newId(),
        user_id: userId,
        normalized_msisdn: normalizedMsisdn,
        provider_mode: providerMode,
        reference_no: String(otpResp.referenceNo),
        consent_wording: body.consent_wording,
        status: 'pending',
        attempts: 0,
        max_attempts: 5,
        expires_at: expiresAt,
        verified_at: null,
        created_at: now,
      });

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

      const db = await getDb();
      const row = await db.collection('applink_otp_challenges').findOne(
        { user_id: userId, status: 'pending', provider_mode: providerMode },
        { sort: { created_at: -1 }, projection: { _id: 0 } }
      );

      if (!row) {
        throw new AppError(400, 'BAD_REQUEST', 'No pending OTP challenge found. Please request a new OTP.');
      }
      if (new Date(String(row.expires_at)).getTime() <= Date.now()) {
        await db.collection('applink_otp_challenges').updateOne({ id: row.id }, { $set: { status: 'expired' } });
        throw new AppError(400, 'BAD_REQUEST', 'OTP has expired. Please request a new OTP.');
      }
      if (Number(row.attempts) >= Number(row.max_attempts)) {
        await db.collection('applink_otp_challenges').updateOne({ id: row.id }, { $set: { status: 'locked' } });
        throw new AppError(429, 'RATE_LIMITED', 'Too many failed OTP attempts. Please request a new OTP.');
      }

      const lockedAttempt = await db.collection('applink_otp_challenges').findOneAndUpdate(
        { id: row.id, status: 'pending', attempts: { $lt: Number(row.max_attempts) } },
        { $inc: { attempts: 1 } },
        { returnDocument: 'after', projection: { _id: 0 } }
      );
      if (!lockedAttempt) {
        throw new AppError(400, 'BAD_REQUEST', 'No pending OTP challenge found. Please request a new OTP.');
      }

      let verifyResp;
      try {
        verifyResp = await verifyOtp(String(lockedAttempt.reference_no), body.otp);
      } catch (err) {
        if (err instanceof ApplinkError) {
          throw new AppError(400, 'BAD_REQUEST', `OTP verification failed (${err.statusCode}): ${err.statusDetail}`);
        }
        throw err;
      }

      const subscriberId = String(verifyResp.subscriberId || lockedAttempt.normalized_msisdn);
      const subscriptionStatus = String(verifyResp.subscriptionStatus || 'REGISTERED');
      const now = new Date().toISOString();

      const verifiedChallenge = await db.collection('applink_otp_challenges').findOneAndUpdate(
        { id: lockedAttempt.id, status: 'pending' },
        { $set: { status: 'verified', verified_at: now } },
        { returnDocument: 'after', projection: { _id: 0 } }
      );
      if (!verifiedChallenge) {
        throw new AppError(409, 'CONFLICT', 'OTP challenge was already used or expired.');
      }

      await db.collection('applink_subscriber_bindings').updateOne(
        { user_id: userId },
        {
          $set: {
            user_id: userId,
            normalized_msisdn: lockedAttempt.normalized_msisdn,
            subscriber_id: subscriberId,
            subscription_status: subscriptionStatus,
            binding_mode: lockedAttempt.provider_mode,
            consent_wording: lockedAttempt.consent_wording,
            consent_channel: 'web_otp',
            consented_at: now,
            last_confirmed_at: now,
            updated_at: now,
          },
          $setOnInsert: {
            id: newId(),
            created_at: now,
          },
        },
        { upsert: true }
      );

      return {
        verified: true,
        demo_mode: lockedAttempt.provider_mode === 'mock',
        masked_msisdn: maskTelAddress(String(lockedAttempt.normalized_msisdn)),
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
      const db = await getDb();

      const binding = await db.collection('applink_subscriber_bindings').findOne(
        { user_id: userId },
        { projection: { _id: 0, subscriber_id: 1, binding_mode: 1 } }
      );
      if (!binding) {
        return { success: true, subscription_status: 'UNREGISTERED' };
      }

      if (cfg.urls.subscriptionSend) {
        const subMode = getApplinkTransportMode(cfg.urls.subscriptionSend);
        if (subMode === binding.binding_mode) {
          try {
            await unregisterSubscriber(String(binding.subscriber_id));
          } catch (err) {
            request.log.warn({ err }, 'Applink unregister call failed during opt-out; updating local mirror');
          }
        }
      }

      const now = new Date().toISOString();
      await Promise.all([
        db.collection('applink_subscriber_bindings').updateOne(
          { user_id: userId },
          { $set: { subscription_status: 'UNREGISTERED', last_confirmed_at: now, updated_at: now } }
        ),
        db.collection('applink_sms_outbox').updateMany(
          { recipient_user_id: userId, status: 'queued' },
          {
            $set: {
              status: 'failed',
              last_error: 'Cancelled due to user opt-out',
              next_retry_at: null,
              updated_at: now,
            },
          }
        ),
      ]);

      return { success: true, subscription_status: 'UNREGISTERED' };
    }
  );
}
