import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/errors.js';
import { sanitizeText } from '../../lib/security.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import { authenticate } from '../../middleware/auth.js';
import { createReportSchema } from '../../schemas/interactions.schema.js';

export async function reportRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Reports'],
        summary: 'Report a suspicious post or user account',
      },
    },
    async (request, reply) => {
      const userId = request.authUser!.id;
      const body = createReportSchema.parse(request.body);

      if (body.target_type === 'post' && !body.target_post_id) {
        throw new AppError(400, 'VALIDATION_ERROR', 'target_post_id is required when reporting a post');
      }
      if (body.target_type === 'user' && !body.target_user_id) {
        throw new AppError(400, 'VALIDATION_ERROR', 'target_user_id is required when reporting a user');
      }
      if (body.target_type === 'user' && body.target_user_id === userId) {
        throw new AppError(400, 'BAD_REQUEST', 'You cannot report your own account');
      }

      const { data: report, error } = await supabaseAdmin
        .from('reports')
        .insert({
          reporter_id: userId,
          target_type: body.target_type,
          target_post_id: body.target_type === 'post' ? body.target_post_id : null,
          target_user_id: body.target_type === 'user' ? body.target_user_id : null,
          reason: sanitizeText(body.reason),
          details: body.details ? sanitizeText(body.details) : null,
          status: 'open',
        })
        .select()
        .single();

      if (error || !report) {
        throw new AppError(500, 'INTERNAL_ERROR', 'Failed to submit report');
      }

      return reply.status(201).send({ report });
    }
  );

  app.get(
    '/mine',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Reports'],
        summary: 'List reports submitted by the authenticated user',
      },
    },
    async (request) => {
      const userId = request.authUser!.id;
      const { data, error } = await supabaseAdmin
        .from('reports')
        .select('*')
        .eq('reporter_id', userId)
        .order('created_at', { ascending: false });

      if (error) {
        throw new AppError(500, 'INTERNAL_ERROR', 'Failed to fetch reports');
      }

      return { reports: data ?? [] };
    }
  );
}
