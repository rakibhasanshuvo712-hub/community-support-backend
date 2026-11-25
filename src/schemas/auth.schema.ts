import { z } from 'zod';

export const registerSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(128),
  full_name: z.string().trim().min(2).max(120),
  preferred_language: z.enum(['en', 'bn']).default('en'),
});

export const loginSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(128),
});

export const resetPasswordSchema = z.object({
  email: z.string().email().max(255),
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
