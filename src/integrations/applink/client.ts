import { getApplinkConfig } from './config.js';
import { ApplinkError } from './statusCodes.js';

const APPLINK_TIMEOUT_MS = 15_000;

export interface ApplinkBaseResponse {
  statusCode: string;
  statusDetail?: string;
  version?: string;
  [key: string]: unknown;
}

export async function postApplink<T extends ApplinkBaseResponse>(
  service: string,
  url: string,
  body: Record<string, unknown>,
  acceptedCodes: string[] = []
): Promise<T> {
  if (!url) {
    throw new ApplinkError({
      statusCode: 'E1309',
      statusDetail: `Applink service "${service}" is not enabled (URL not configured).`,
      service,
      codeClass: 'configuration',
    });
  }

  const cfg = getApplinkConfig();
  const payload: Record<string, unknown> = {
    applicationId: cfg.appId,
    password: cfg.password,
  };

  // Copy only defined, non-null, non-empty optional fields
  for (const [key, val] of Object.entries(body)) {
    if (val !== undefined && val !== null && val !== '') {
      payload[key] = val;
    }
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json;charset=utf-8',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(APPLINK_TIMEOUT_MS),
    });
  } catch (err: unknown) {
    const isTimeout =
      err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new ApplinkError({
      statusCode: isTimeout ? 'TIMEOUT' : 'TRANSPORT_ERROR',
      statusDetail: isTimeout
        ? 'Applink request timed out after 15s (ambiguous outcome — do not blindly resend)'
        : err instanceof Error
          ? err.message
          : 'Network error calling Applink',
      service,
      codeClass: 'transport',
      isAmbiguousTimeout: isTimeout,
    });
  }

  let data: T;
  try {
    data = (await res.json()) as T;
  } catch {
    throw new ApplinkError({
      statusCode: 'INVALID_JSON',
      statusDetail: `Applink returned non-JSON response (HTTP ${res.status})`,
      service,
      codeClass: 'transport',
    });
  }

  const statusCode = String(data.statusCode ?? '');
  const statusDetail = String(data.statusDetail ?? 'Unknown response');

  if (statusCode === 'S1000' || acceptedCodes.includes(statusCode)) {
    return data;
  }

  throw new ApplinkError({
    statusCode,
    statusDetail,
    service,
  });
}
