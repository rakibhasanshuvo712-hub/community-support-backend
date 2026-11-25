import { z } from 'zod';

export const createPostSchema = z.object({
  post_type: z.enum(['donation_offer', 'help_request']),
  donation_type: z.enum(['money', 'item', 'service']),
  category_id: z.string().uuid(),
  title: z.string().trim().min(5).max(180),
  description: z.string().trim().min(10).max(5000),
  quantity: z.coerce.number().positive().nullable().optional(),
  unit: z.string().trim().max(40).nullable().optional(),
  amount: z.coerce.number().positive().nullable().optional(),
  currency: z.string().trim().min(3).max(6).default('BDT'),
  location_city: z.string().trim().min(2).max(100),
  location_area: z.string().trim().max(100).nullable().optional(),
  urgency: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
  safety_acknowledged: z.boolean().default(false),
  expires_at: z.string().datetime().nullable().optional(),
  exact_handover_address: z.string().trim().max(300).nullable().optional(),
  contact_phone: z.string().trim().max(30).nullable().optional(),
  contact_note: z.string().trim().max(500).nullable().optional(),
});

export const updatePostSchema = z.object({
  title: z.string().trim().min(5).max(180).optional(),
  description: z.string().trim().min(10).max(5000).optional(),
  quantity: z.coerce.number().positive().nullable().optional(),
  unit: z.string().trim().max(40).nullable().optional(),
  amount: z.coerce.number().positive().nullable().optional(),
  currency: z.string().trim().min(3).max(6).optional(),
  location_city: z.string().trim().min(2).max(100).optional(),
  location_area: z.string().trim().max(100).nullable().optional(),
  urgency: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  status: z.enum(['active', 'paused', 'fulfilled', 'closed']).optional(),
  expires_at: z.string().datetime().nullable().optional(),
  exact_handover_address: z.string().trim().max(300).nullable().optional(),
  contact_phone: z.string().trim().max(30).nullable().optional(),
  contact_note: z.string().trim().max(500).nullable().optional(),
});

export const listPostsQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  category_id: z.string().uuid().optional(),
  category_slug: z.string().trim().max(60).optional(),
  post_type: z.enum(['donation_offer', 'help_request']).optional(),
  donation_type: z.enum(['money', 'item', 'service']).optional(),
  urgency: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  city: z.string().trim().max(100).optional(),
  status: z.enum(['active', 'fulfilled']).optional(),
  sort: z.enum(['latest', 'urgent', 'relevant']).default('latest'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(12),
});
