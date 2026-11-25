import { z } from 'zod';

export const createClaimSchema = z.object({
  message: z.string().trim().max(1000).optional(),
  quantity_offered: z.coerce.number().positive().nullable().optional(),
});

export const createContributionSchema = z.object({
  amount: z.coerce.number().positive(),
  currency: z.string().trim().min(3).max(6).default('BDT'),
  note: z.string().trim().max(1000).optional(),
});

export const createConversationSchema = z.object({
  recipient_id: z.string().trim().min(1).max(128),
  post_id: z.string().trim().min(1).max(128).nullable().optional(),
  initial_message: z.string().trim().min(1).max(3000).optional(),
});

export const sendMessageSchema = z.object({
  content: z.string().trim().min(1).max(3000),
});

export const createReportSchema = z.object({
  target_type: z.enum(['post', 'user']),
  target_post_id: z.string().trim().min(1).max(128).nullable().optional(),
  target_user_id: z.string().trim().min(1).max(128).nullable().optional(),
  reason: z.string().trim().min(3).max(150),
  details: z.string().trim().max(2000).optional(),
});

export const adminSuspendUserSchema = z.object({
  is_suspended: z.boolean(),
  reason: z.string().trim().min(3).max(1000),
});

export const adminPostStatusSchema = z.object({
  status: z.enum(['active', 'paused', 'closed', 'removed']),
  reason: z.string().trim().min(3).max(1000),
});

export const adminResolveReportSchema = z.object({
  status: z.enum(['reviewing', 'resolved', 'dismissed']),
  reason: z.string().trim().min(3).max(1000),
});
