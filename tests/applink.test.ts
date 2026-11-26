import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { toTelAddress, maskTelAddress } from '../src/integrations/applink/address.js';
import { classifyApplinkCode, ApplinkError } from '../src/integrations/applink/statusCodes.js';
import { isApplinkUrlLocalMock, getApplinkTransportMode, redactApplinkForLog } from '../src/integrations/applink/config.js';
import { sendSms } from '../src/integrations/applink/services.js';
import { env } from '../src/config/env.js';
import { buildApp } from '../src/app.js';

vi.mock('../src/lib/db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/db.js')>();
  return {
    ...actual,
    dbQuery: vi.fn().mockResolvedValue({ rows: [] }),
    getPool: vi.fn(),
    ensureSchemaMigrated: vi.fn().mockResolvedValue(undefined),
  };
});

describe('Applink Address Normalization & Redaction', () => {
  it('normalizes Bangladeshi numbers to tel:880XXXXXXXXXX', () => {
    expect(toTelAddress('01959979376')).toBe('tel:8801959979376');
    expect(toTelAddress('+880 19 5997 9376')).toBe('tel:8801959979376');
    expect(toTelAddress('008801959979376')).toBe('tel:8801959979376');
    expect(toTelAddress('tel:+8801959979376')).toBe('tel:8801959979376');
    expect(toTelAddress('tel:8801959979376')).toBe('tel:8801959979376');
  });

  it('preserves masked opaque subscriberIds unchanged', () => {
    expect(toTelAddress('tel:abc123opaqueXYZ')).toBe('tel:abc123opaqueXYZ');
  });

  it('masks addresses and redacts secrets for logs', () => {
    expect(maskTelAddress('tel:8801959979376')).toBe('tel:88*****376');
    const redacted = redactApplinkForLog({
      applicationId: 'APP_123456',
      password: 'super-secret-password',
      otp: '123456',
      referenceNo: '999999',
    });
    expect(redacted.password).toBe('***redacted***');
    expect(redacted.otp).toBe('***redacted***');
    expect(redacted.referenceNo).toBe('***redacted***');
    expect(redacted.applicationId).toBe('APP_123456');
  });

  it('derives mock vs live transport from endpoint URL without APPLINK_MODE', () => {
    expect(getApplinkTransportMode('')).toBe('disabled');
    expect(isApplinkUrlLocalMock('http://127.0.0.1:8089/sms/send')).toBe(true);
    expect(getApplinkTransportMode('http://127.0.0.1:8089/sms/send')).toBe('mock');
    expect(getApplinkTransportMode('https://api.applink.com.bd/sms/send')).toBe('live');
  });
});

describe('Applink Status Code Classification & Client Contract', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    env.APPLINK_APP_ID = 'APP_XXXXXX';
    env.APPLINK_PASSWORD = 'local-test-only';
    env.APPLINK_SMS_SEND_URL = 'http://127.0.0.1:8089/sms/send';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    env.APPLINK_SMS_SEND_URL = '';
    env.APPLINK_APP_ID = '';
    env.APPLINK_PASSWORD = '';
  });

  it('classifies published Applink codes accurately', () => {
    expect(classifyApplinkCode('S1000')).toBe('success');
    expect(classifyApplinkCode('P1003')).toBe('pending');
    expect(classifyApplinkCode('E1303')).toBe('configuration');
    expect(classifyApplinkCode('E1318')).toBe('transient');
    expect(classifyApplinkCode('E1850')).toBe('client');
    expect(classifyApplinkCode('E1343')).toBe('user-state');
  });

  it('refuses to call SMS when APPLINK_SMS_SEND_URL is unset', async () => {
    env.APPLINK_SMS_SEND_URL = '';
    await expect(sendSms('01959979376', 'Hello')).rejects.toThrow(ApplinkError);
  });

  it('throws ApplinkError when HTTP 200 carries non-S1000 statusCode', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ statusCode: 'E1313', statusDetail: 'Authentication failed' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await expect(sendSms('01959979376', 'Hello')).rejects.toMatchObject({
      statusCode: 'E1313',
      isConfiguration: true,
    });
  });

  it('throws ApplinkError when per-destination response fails even if top-level is S1000', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          statusCode: 'S1000',
          statusDetail: 'Success.',
          requestId: 'req-1',
          destinationResponses: [
            { address: 'tel:8801959979376', statusCode: 'E1343', statusDetail: 'Not whitelisted' },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    await expect(sendSms('01959979376', 'Hello')).rejects.toMatchObject({
      statusCode: 'E1343',
    });
  });

  it('marks AbortError / TimeoutError as ambiguous timeout', async () => {
    const timeoutErr = new Error('The operation timed out');
    timeoutErr.name = 'TimeoutError';
    globalThis.fetch = vi.fn().mockRejectedValue(timeoutErr);

    await expect(sendSms('01959979376', 'Hello')).rejects.toMatchObject({
      statusCode: 'TIMEOUT',
      isAmbiguousTimeout: true,
    });
  });
});

describe('Applink Callback & OTP Gate Endpoints', () => {
  it('POST /api/v1/applink/sms/report always responds 200 S1000', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/applink/sms/report',
      payload: {
        destinationAddress: 'tel:8801959979376',
        timeStamp: '20261126120000',
        requestId: 'MSG_000111',
        deliveryStatus: 'DELIVRD',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ statusCode: 'S1000', statusDetail: 'Success' });
  });

  it('POST /api/v1/applink/subscription/notify responds 200 S1000 even for malformed payloads', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/applink/subscription/notify',
      payload: { unexpected: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ statusCode: 'S1000', statusDetail: 'Success' });
  });

  it('rejects unauthenticated OTP binding requests with 401', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/applink/binding/otp/request',
      payload: { phone: '01959979376', consent: true, consent_wording: 'I agree to receive SMS' },
    });
    expect(res.statusCode).toBe(401);
  });
});
