import { AppError } from '../../lib/errors.js';

/**
 * Normalizes Bangladeshi mobile numbers to Applink's canonical `tel:880XXXXXXXXXX` format.
 * Preserves already-masked `tel:<opaque>` subscriberIds unchanged.
 */
export function toTelAddress(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Phone number is required');
  }

  if (trimmed.startsWith('tel:')) {
    const rest = trimmed.slice(4).trim();
    // If it contains non-digit characters (other than leading +), treat as masked opaque subscriberId
    if (!/^\+?\d[\d\s-]*$/.test(rest)) {
      return `tel:${rest}`;
    }
    return normalizeDigitsToTel(rest);
  }

  return normalizeDigitsToTel(trimmed);
}

function normalizeDigitsToTel(input: string): string {
  const digits = input.replace(/[^\d]/g, '');
  let normalized = digits;

  if (normalized.startsWith('00880')) {
    normalized = normalized.slice(2);
  } else if (normalized.startsWith('01') && normalized.length === 11) {
    normalized = `880${normalized.slice(1)}`;
  }

  if (!/^8801[3-9]\d{8}$/.test(normalized)) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Invalid Bangladeshi mobile number. Expected format like 019XXXXXXXX or +88019XXXXXXXX.'
    );
  }

  return `tel:${normalized}`;
}

export function maskTelAddress(address: string): string {
  const clean = address.trim();
  if (clean.length <= 6) return '***';
  return `${clean.slice(0, 6)}*****${clean.slice(-3)}`;
}
