import { z } from 'zod';

export function normalizeBdPhone(raw: string): string | null {
  const digits = raw.replace(/[^\d]/g, '');
  let normalized = digits;
  if (normalized.startsWith('00880')) {
    normalized = normalized.slice(2);
  } else if (normalized.startsWith('01') && normalized.length === 11) {
    normalized = `880${normalized.slice(1)}`;
  }
  return /^8801[3-9]\d{8}$/.test(normalized) ? normalized : null;
}

export const bdPhoneSchema = z
  .string()
  .trim()
  .refine((val) => normalizeBdPhone(val) !== null, {
    message: 'Enter a valid Bangladeshi phone number (e.g. 017XXXXXXXX or +88017XXXXXXXX)',
  });

export const registerSchema = z.object({
  phone: bdPhoneSchema,
  email: z.string().email().max(255).optional().or(z.literal('')),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
  full_name: z.string().trim().min(2).max(120),
  preferred_language: z.enum(['en', 'bn']).default('en'),
});

export const loginSchema = z
  .object({
    phone: z.string().trim().max(255).optional(),
    email: z.string().trim().max(255).optional(),
    identifier: z.string().trim().max(255).optional(),
    password: z.string().min(1).max(128),
  })
  .refine((d) => Boolean((d.identifier || d.phone || d.email || '').trim()), {
    message: 'Phone number or email is required',
    path: ['phone'],
  });

export const resetPasswordSchema = z.object({
  phone: z.string().trim().optional(),
  email: z.string().email().max(255).optional(),
  redirect_to: z.string().url().optional(),
});

export const updateProfileSchema = z.object({
  full_name: z.string().trim().min(2).max(120).optional(),
  bio: z.string().trim().max(1000).nullable().optional(),
  preferred_language: z.enum(['en', 'bn']).optional(),
  location_city: z.string().trim().max(100).nullable().optional(),
  location_area: z.string().trim().max(100).nullable().optional(),
  phone: z.string().trim().max(30).nullable().optional(),
  exact_address: z.string().trim().max(300).nullable().optional(),
});
