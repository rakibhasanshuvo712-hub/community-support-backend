import { AppError } from './errors.js';

const SENSITIVE_PATTERNS = [
  /\b(?:cvv|cvc|pin|otp|one[- ]time[- ]password|bank[- ]password|atm[- ]pin)\b/i,
  /\b(?:\d[ -]*?){13,19}\b/, // Potential payment card number
];

export function assertNoSensitiveFinancialData(...values: Array<string | undefined | null>): void {
  for (const val of values) {
    if (!val) continue;
    for (const pattern of SENSITIVE_PATTERNS) {
      if (pattern.test(val)) {
        throw new AppError(
          400,
          'VALIDATION_ERROR',
          'For your safety, never share card numbers, CVV, PIN, OTP, or bank passwords on this platform.'
        );
      }
    }
  }
}

export function sanitizeText(input: string): string {
  return input.replace(/[<>]/g, '').trim();
}
