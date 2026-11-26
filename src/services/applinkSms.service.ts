import { getApplinkConfig, getApplinkTransportMode } from '../integrations/applink/config.js';
import { sendSms } from '../integrations/applink/services.js';
import { ApplinkError } from '../integrations/applink/statusCodes.js';
import { getDb, newId } from '../lib/mongo.js';

export type SmsOutboxStatus =
  | 'queued'
  | 'simulated'
  | 'provider_accepted'
  | 'delivered'
  | 'failed'
  | 'unknown';

interface OutboxRow {
  id: string;
  subscriber_id: string;
  transport_mode: 'mock' | 'live';
  message_body: string;
  status: SmsOutboxStatus;
  attempts: number;
  max_attempts: number;
}

const CLAIM_ACCEPTED_TEMPLATE =
  'Sahayata: Your request was accepted. Open your dashboard to coordinate handover.';

export async function enqueueAndDispatchClaimAcceptedSms(params: {
  claimId: string;
  recipientUserId: string;
}): Promise<{ outboxId?: string; status: string }> {
  try {
    const cfg = getApplinkConfig();
    if (!cfg.featuresEnabled || !cfg.urls.smsSend) {
      return { status: 'disabled' };
    }

    const transportMode = getApplinkTransportMode(cfg.urls.smsSend);
    if (transportMode === 'disabled') {
      return { status: 'disabled' };
    }

    const db = await getDb();
    const binding = await db.collection('applink_subscriber_bindings').findOne(
      { user_id: params.recipientUserId },
      { projection: { _id: 0, subscriber_id: 1, subscription_status: 1, binding_mode: 1 } }
    );

    if (!binding) {
      return { status: 'no_binding' };
    }
    if (!['REGISTERED', 'TRIAL'].includes(String(binding.subscription_status))) {
      return { status: 'not_subscribed' };
    }
    // Mock bindings must NEVER trigger live SMS
    if (binding.binding_mode !== transportMode) {
      return { status: 'mode_mismatch' };
    }

    const eventKey = `claim_accepted:${params.claimId}`;
    const outboxId = newId();
    const now = new Date().toISOString();

    try {
      await db.collection('applink_sms_outbox').insertOne({
        id: outboxId,
        business_event_key: eventKey,
        recipient_user_id: params.recipientUserId,
        claim_id: params.claimId,
        subscriber_id: String(binding.subscriber_id),
        transport_mode: transportMode,
        message_body: CLAIM_ACCEPTED_TEMPLATE,
        status: 'queued',
        attempts: 0,
        max_attempts: 3,
        provider_request_id: null,
        provider_message_id: null,
        provider_status_code: null,
        provider_status_detail: null,
        delivery_status: null,
        last_error: null,
        next_retry_at: null,
        created_at: now,
        updated_at: now,
      });
    } catch (err: unknown) {
      if (typeof err === 'object' && err !== null && 'code' in err && (err as { code?: number }).code === 11000) {
        return { status: 'duplicate_skipped' };
      }
      throw err;
    }

    const finalStatus = await dispatchOutboxRow(outboxId);
    return { outboxId, status: finalStatus };
  } catch (err) {
    console.error('Claim-accepted SMS enqueue/dispatch error:', err instanceof Error ? err.message : err);
    return { status: 'error' };
  }
}

export async function dispatchOutboxRow(outboxId: string): Promise<SmsOutboxStatus> {
  const cfg = getApplinkConfig();
  const db = await getDb();
  const row = (await db.collection('applink_sms_outbox').findOne(
    { id: outboxId },
    {
      projection: {
        _id: 0,
        id: 1,
        subscriber_id: 1,
        transport_mode: 1,
        message_body: 1,
        status: 1,
        attempts: 1,
        max_attempts: 1,
      },
    }
  )) as OutboxRow | null;

  if (!row) return 'failed';
  if (!['queued', 'failed'].includes(row.status)) {
    return row.status;
  }

  const transportMode = getApplinkTransportMode(cfg.urls.smsSend);
  if (transportMode === 'disabled' || row.transport_mode !== transportMode) {
    return row.status;
  }

  const nextAttempt = row.attempts + 1;
  const now = new Date().toISOString();

  try {
    const resp = await sendSms(row.subscriber_id, row.message_body, {
      deliveryStatusRequest: cfg.deliveryReportsEnabled ? '1' : '0',
    });

    const firstDest = Array.isArray(resp.destinationResponses) ? resp.destinationResponses[0] : undefined;
    const nextStatus: SmsOutboxStatus = transportMode === 'mock' ? 'simulated' : 'provider_accepted';

    await db.collection('applink_sms_outbox').updateOne(
      { id: row.id },
      {
        $set: {
          status: nextStatus,
          attempts: nextAttempt,
          provider_request_id: resp.requestId ?? null,
          provider_message_id: firstDest?.messageId ?? null,
          provider_status_code: resp.statusCode,
          provider_status_detail: resp.statusDetail ?? null,
          last_error: null,
          next_retry_at: null,
          updated_at: now,
        },
      }
    );
    return nextStatus;
  } catch (err) {
    if (err instanceof ApplinkError) {
      if (err.isAmbiguousTimeout) {
        // Never blindly resend after an ambiguous timeout
        await db.collection('applink_sms_outbox').updateOne(
          { id: row.id },
          {
            $set: {
              status: 'unknown',
              attempts: nextAttempt,
              provider_status_code: err.statusCode,
              last_error: err.message,
              next_retry_at: null,
              updated_at: now,
            },
          }
        );
        return 'unknown';
      }

      const canRetry = err.retryable && nextAttempt < row.max_attempts;
      const backoffMs = Math.min(60_000, 5_000 * Math.pow(2, nextAttempt - 1));
      await db.collection('applink_sms_outbox').updateOne(
        { id: row.id },
        {
          $set: {
            status: 'failed',
            attempts: nextAttempt,
            provider_status_code: err.statusCode,
            provider_status_detail: err.statusDetail,
            last_error: err.message,
            next_retry_at: canRetry ? new Date(Date.now() + backoffMs).toISOString() : null,
            updated_at: now,
          },
        }
      );
      return 'failed';
    }

    await db.collection('applink_sms_outbox').updateOne(
      { id: row.id },
      {
        $set: {
          status: 'failed',
          attempts: nextAttempt,
          last_error: err instanceof Error ? err.message : 'Unknown error',
          updated_at: now,
        },
      }
    );
    return 'failed';
  }
}

export async function processPendingSmsOutbox(limit = 10): Promise<{ processed: number }> {
  const db = await getDb();
  const now = new Date().toISOString();
  const rows = await db
    .collection('applink_sms_outbox')
    .find(
      {
        $expr: { $lt: ['$attempts', '$max_attempts'] },
        $or: [
          { status: 'queued' },
          { status: 'failed', next_retry_at: { $ne: null, $lte: now } },
        ],
      },
      { projection: { _id: 0, id: 1 } }
    )
    .sort({ created_at: 1 })
    .limit(Math.max(1, Math.min(limit, 25)))
    .toArray();

  let processed = 0;
  for (const row of rows) {
    await dispatchOutboxRow(String(row.id));
    processed += 1;
  }
  return { processed };
}
