import { toTelAddress } from './address.js';
import { postApplink, type ApplinkBaseResponse } from './client.js';
import { getApplinkConfig } from './config.js';
import { ApplinkError } from './statusCodes.js';

export interface SmsDestinationResponse {
  address?: string;
  timeStamp?: string;
  messageId?: string;
  statusCode?: string;
  statusDetail?: string;
}

export interface SmsSendResponse extends ApplinkBaseResponse {
  requestId?: string;
  destinationResponses?: SmsDestinationResponse[];
}

export interface OtpRequestResponse extends ApplinkBaseResponse {
  referenceNo?: string;
}

export interface OtpVerifyResponse extends ApplinkBaseResponse {
  subscriptionStatus?: string;
  subscriberId?: string;
}

export interface SubscriptionResponse extends ApplinkBaseResponse {
  subscriptionStatus?: string;
}

export async function sendSms(
  to: string,
  message: string,
  opts?: { deliveryStatusRequest?: '0' | '1'; sourceAddress?: string }
): Promise<SmsSendResponse> {
  const cfg = getApplinkConfig();
  const normalizedAddress = toTelAddress(to);
  if (normalizedAddress === 'tel:all') {
    throw new ApplinkError({
      statusCode: 'E1312',
      statusDetail: 'Broadcast tel:all is not permitted from sendSms()',
      service: 'sms-send',
      codeClass: 'client',
    });
  }

  const body: Record<string, unknown> = {
    version: '1.0',
    message,
    destinationAddresses: [normalizedAddress],
  };

  if (opts?.deliveryStatusRequest) {
    body.deliveryStatusRequest = opts.deliveryStatusRequest;
  }
  if (opts?.sourceAddress) {
    body.sourceAddress = opts.sourceAddress;
  }

  const response = await postApplink<SmsSendResponse>('sms-send', cfg.urls.smsSend, body);

  // Per contract: inspect each destinationResponses entry, not just top-level statusCode
  const destList = Array.isArray(response.destinationResponses) ? response.destinationResponses : [];
  for (const dest of destList) {
    const destCode = String(dest.statusCode ?? 'S1000');
    if (destCode !== 'S1000') {
      throw new ApplinkError({
        statusCode: destCode,
        statusDetail: String(dest.statusDetail ?? 'Destination delivery failed'),
        service: 'sms-send',
      });
    }
  }

  return response;
}

export async function requestOtp(
  phone: string,
  metaData?: { client?: string; device?: string; os?: string; appCode?: string }
): Promise<OtpRequestResponse> {
  const cfg = getApplinkConfig();
  const subscriberId = toTelAddress(phone);

  const body: Record<string, unknown> = {
    subscriberId,
  };
  if (metaData && Object.values(metaData).some(Boolean)) {
    const cleanMeta: Record<string, string> = {};
    if (metaData.client) cleanMeta.client = metaData.client;
    if (metaData.device) cleanMeta.device = metaData.device;
    if (metaData.os) cleanMeta.os = metaData.os;
    if (metaData.appCode) cleanMeta.appCode = metaData.appCode;
    body.applicationMetaData = cleanMeta;
  }

  return postApplink<OtpRequestResponse>('otp-request', cfg.urls.otpRequest, body);
}

export async function verifyOtp(referenceNo: string, otp: string): Promise<OtpVerifyResponse> {
  const cfg = getApplinkConfig();
  return postApplink<OtpVerifyResponse>('otp-verify', cfg.urls.otpVerify, {
    referenceNo: String(referenceNo),
    otp: String(otp),
  });
}

export async function unregisterSubscriber(subscriberId: string): Promise<SubscriptionResponse> {
  const cfg = getApplinkConfig();
  return postApplink<SubscriptionResponse>('subscription-unregister', cfg.urls.subscriptionSend, {
    subscriberId: toTelAddress(subscriberId),
    action: '0',
  });
}
