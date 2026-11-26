import { env } from '../../config/env.js';

export type ApplinkTransportMode = 'mock' | 'live' | 'disabled';

export interface ApplinkConfig {
  featuresEnabled: boolean;
  otpEnabled: boolean;
  deliveryReportsEnabled: boolean;
  appId: string;
  password: string;
  urls: {
    smsSend: string;
    otpRequest: string;
    otpVerify: string;
    subscriptionSend: string;
  };
}

export function isApplinkUrlLocalMock(url: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
  } catch {
    return false;
  }
}

export function getApplinkTransportMode(url: string): ApplinkTransportMode {
  if (!url) return 'disabled';
  return isApplinkUrlLocalMock(url) ? 'mock' : 'live';
}

export function getApplinkConfig(): ApplinkConfig {
  const urls = {
    smsSend: env.APPLINK_SMS_SEND_URL,
    otpRequest: env.APPLINK_OTP_REQUEST_URL,
    otpVerify: env.APPLINK_OTP_VERIFY_URL,
    subscriptionSend: env.APPLINK_SUBSCRIPTION_SEND_URL,
  };

  const anyUrlConfigured = Object.values(urls).some(Boolean);
  if (anyUrlConfigured && (!env.APPLINK_APP_ID || !env.APPLINK_PASSWORD)) {
    throw new Error(
      'Applink service URL is configured, but APPLINK_APP_ID or APPLINK_PASSWORD is missing.'
    );
  }

  return {
    featuresEnabled: env.APPLINK_FEATURES_ENABLED,
    otpEnabled: env.APPLINK_OTP_ENABLED,
    deliveryReportsEnabled: env.APPLINK_DELIVERY_REPORTS_ENABLED,
    appId: env.APPLINK_APP_ID,
    password: env.APPLINK_PASSWORD,
    urls,
  };
}

export function redactApplinkForLog<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'password' || k === 'otp' || k === 'referenceNo') {
      copy[k] = '***redacted***';
    } else {
      copy[k] = v;
    }
  }
  return copy;
}
