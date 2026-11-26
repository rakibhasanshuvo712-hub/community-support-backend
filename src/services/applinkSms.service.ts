import { getApplinkConfig, getApplinkTransportMode } from '../integrations/applink/config.js';
import { sendSms } from '../integrations/applink/services.js';
import { ApplinkError } from '../integrations/applink/statusCodes.js';
import { dbQuery } from '../lib/db.js';

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

    const bindingRes = await dbQuery<{
      subscriber_id: string;
      subscription_status: string;
      binding_mode: string;
    }>(
      `SELECT subscriber_id, subscription_status, binding_mode
       FROM applink_subscriber_bindings
       WHERE user_id = $1`,
      [params.recipientUserId]
    );

    const binding = bindingRes.rows[0];
    if (!binding) {
      return { status: 'no_binding' };
    }
    if (!['REGISTERED', 'TRIAL'].includes(binding.subscription_status)) {
      return { status: 'not_subscribed' };
    }
    // Mock bindings must NEVER trigger live SMS
    if (binding.binding_mode !== transportMode) {
      return { status: 'mode_mismatch' };
    }

    const eventKey = `claim_accepted:${params.claimId}`;
    const insertRes = await dbQuery<{ id: string }>(
      `INSERT INTO applink_sms_outbox (
        business_event_key, recipient_user_id, claim_id, subscriber_id, transport_mode, message_body, status
      ) VALUES ($1, $2, $3, $4, $5, $6, 'queued')
      ON CONFLICT (business_event_key) DO NOTHING
      RETURNING id`,
      [
        eventKey,
        params.recipientUserId,
        params.claimId,
        binding.subscriber_id,
        transportMode,
        CLAIM_ACCEPTED_TEMPLATE,
      ]
    );

    const row = insertRes.rows[0];
    if (!row) {
      return { status: 'duplicate_skipped' };
    }

    const finalStatus = await dispatchOutboxRow(row.id);
    return { outboxId: row.id, status: finalStatus };
  } catch (err) {
    console.error('Claim-accepted SMS enqueue/dispatch error:', err instanceof Error ? err.message : err);
    return { status: 'error' };
  }
}

export async function dispatchOutboxRow(outboxId: string): Promise<SmsOutboxStatus> {
  const cfg = getApplinkConfig();
  const rowRes = await dbQuery<OutboxRow>(
    `SELECT id, subscriber_id, transport_mode, message_body, status, attempts, max_attempts
     FROM applink_sms_outbox WHERE id = $1`,
    [outboxId]
  );
  const row = rowRes.rows[0];
  if (!row) return 'failed';
  if (!['queued', 'failed'].includes(row.status)) {
    return row.status;
  }

  const transportMode = getApplinkTransportMode(cfg.urls.smsSend);
  if (transportMode === 'disabled' || row.transport_mode !== transportMode) {
    return row.status;
  }

  const nextAttempt = row.attempts + 1;

  try {
    const resp = await sendSms(row.subscriber_id, row.message_body, {
      deliveryStatusRequest: cfg.deliveryReportsEnabled ? '1' : '0',
    });

    const firstDest = Array.isArray(resp.destinationResponses) ? resp.destinationResponses[0] : undefined;
    const nextStatus: SmsOutboxStatus = transportMode === 'mock' ? 'simulated' : 'provider_accepted';

    await dbQuery(
      `UPDATE applink_sms_outbox
       SET status = $1,
           attempts = $2,
           provider_request_id = $3,
           provider_message_id = $4,
           provider_status_code = $5,
           provider_status_detail = $6,
           last_error = NULL,
           next_retry_at = NULL,
           updated_at = NOW()
       WHERE id = $7`,
      [
        nextStatus,
        nextAttempt,
        resp.requestId ?? null,
        firstDest?.messageId ?? null,
        resp.statusCode,
        resp.statusDetail ?? null,
        row.id,
      ]
    );
    return nextStatus;
  } catch (err) {
    if (err instanceof ApplinkError) {
      if (err.isAmbiguousTimeout) {
        // Never blindly resend after an ambiguous timeout
        await dbQuery(
          `UPDATE applink_sms_outbox
           SET status = 'unknown',
               attempts = $1,
               provider_status_code = $2,
               last_error = $3,
               next_retry_at = NULL,
               updated_at = NOW()
           WHERE id = $4`,
          [nextAttempt, err.statusCode, err.message, row.id]
        );
        return 'unknown';
      }

      const canRetry = err.retryable && nextAttempt < row.max_attempts;
      const backoffMs = Math.min(60_000, 5_000 * Math.pow(2, nextAttempt - 1));
      await dbQuery(
        `UPDATE applink_sms_outbox
         SET status = 'failed',
             attempts = $1,
             provider_status_code = $2,
             provider_status_detail = $3,
             last_error = $4,
             next_retry_at = $5,
             updated_at = NOW()
         WHERE id = $6`,
        [
          nextAttempt,
          err.statusCode,
          err.statusDetail,
          err.message,
          canRetry ? new Date(Date.now() + backoffMs).toISOString() : null,
          row.id,
        ]
      );
      return 'failed';
    }

    await dbQuery(
      `UPDATE applink_sms_outbox
       SET status = 'failed',
           attempts = $1,
           last_error = $2,
           updated_at = NOW()
       WHERE id = $3`,
      [nextAttempt, err instanceof Error ? err.message : 'Unknown error', row.id]
    );
    return 'failed';
  }
}

export async function processPendingSmsOutbox(limit = 10): Promise<{ processed: number }> {
  const res = await dbQuery<{ id: string }>(
    `SELECT id FROM applink_sms_outbox
     WHERE (status = 'queued' OR (status = 'failed' AND next_retry_at IS NOT NULL AND next_retry_at <= NOW()))
       AND attempts < max_attempts
     ORDER BY created_at ASC
     LIMIT $1`,
    [Math.max(1, Math.min(limit, 25))]
  );

  let processed = 0;
  for (const row of res.rows) {
    await dispatchOutboxRow(row.id);
    processed += 1;
  }
  return { processed };
}
