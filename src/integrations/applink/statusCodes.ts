export type ApplinkCodeClass =
  | 'success'
  | 'pending'
  | 'configuration'
  | 'client'
  | 'user-state'
  | 'transient'
  | 'transport';

export const APPLINK_TRANSIENT_CODES = new Set([
  'E1318',
  'E1319',
  'E1341',
  'E1601',
  'E1602',
  'E1603',
]);

export const APPLINK_CONFIGURATION_CODES = new Set([
  'E1301',
  'E1303',
  'E1309',
  'E1311',
  'E1313',
  'E1315',
  'E1328',
  'E1331',
]);

export const APPLINK_USER_STATE_CODES = new Set([
  'E1317',
  'E1326',
  'E1342',
  'E1343',
]);

export const APPLINK_CLIENT_CODES = new Set([
  'E1308',
  'E1312',
  'E1325',
  'E1334',
  'E1335',
  'E1337',
  'E1850',
  'E1851',
  'E1855',
  'E1856',
]);

export const APPLINK_PENDING_CODES = new Set(['P1003']);

export function classifyApplinkCode(statusCode: string): ApplinkCodeClass {
  if (statusCode === 'S1000') return 'success';
  if (APPLINK_PENDING_CODES.has(statusCode)) return 'pending';
  if (APPLINK_CONFIGURATION_CODES.has(statusCode)) return 'configuration';
  if (APPLINK_USER_STATE_CODES.has(statusCode)) return 'user-state';
  if (APPLINK_CLIENT_CODES.has(statusCode)) return 'client';
  if (APPLINK_TRANSIENT_CODES.has(statusCode)) return 'transient';
  return 'client';
}

export class ApplinkError extends Error {
  public readonly statusCode: string;
  public readonly statusDetail: string;
  public readonly service: string;
  public readonly codeClass: ApplinkCodeClass;
  public readonly isAmbiguousTimeout: boolean;

  constructor(params: {
    statusCode: string;
    statusDetail: string;
    service: string;
    codeClass?: ApplinkCodeClass;
    isAmbiguousTimeout?: boolean;
  }) {
    super(`Applink ${params.service} failed (${params.statusCode}): ${params.statusDetail}`);
    this.name = 'ApplinkError';
    this.statusCode = params.statusCode;
    this.statusDetail = params.statusDetail;
    this.service = params.service;
    this.codeClass = params.codeClass ?? classifyApplinkCode(params.statusCode);
    this.isAmbiguousTimeout = Boolean(params.isAmbiguousTimeout);
  }

  get retryable(): boolean {
    return this.codeClass === 'transient';
  }

  get isConfiguration(): boolean {
    return this.codeClass === 'configuration';
  }
}
