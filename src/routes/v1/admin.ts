import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/errors.js';
import { sanitizeText } from '../../lib/security.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import { requireAdmin } from '../../middleware/auth.js';
import {
  adminPostStatusSchema,
  adminResolveReportSchema,
  adminSuspendUserSchema,
} from '../../schemas/interactions.schema.js';
import { createNotification } from '../../services/notifications.service.js';

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin);

  app.get(
    '/stats',
    {
      schema: {
        tags: ['Admin'],
        summary: 'Platform statistics (admin only)',
      },
    },
    async () => {
      const [users, posts, claims, contributions, openReports] = await Promise.all([
        supabaseAdmin.from('profiles').select('id', { count: 'exact', head: true }),
        supabaseAdmin.from('posts').select('id', { count: 'exact', head: true }),
        supabaseAdmin.from('claims').select('id', { count: 'exact', head: true }),
        supabaseAdmin.from('contributions').select('id', { count: 'exact', head: true }),
        supabaseAdmin.from('reports').select('id', { count: 'exact', head: true }).eq('status', 'open'),
      ]);

      return {
        stats: {
          total_users: users.count ?? 0,
          total_posts: posts.count ?? 0,
          total_claims: claims.count ?? 0,
          total_contributions: contributions.count ?? 0,
          open_reports: openReports.count ?? 0,
        },
      };
    }
  );

  app.get(
    '/users',
    {
      schema: {
        tags: ['Admin'],
        summary: 'List all users for moderation (admin only)',
      },
    },
    async () => {
      const { data, error } = await supabaseAdmin
        .from('profiles')
        .select('id, full_name, role, is_suspended, suspended_reason, location_city, created_at')
        .order('created_at', { ascending: false })
        .limit(100);

      if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Failed to fetch users');
      return { users: data ?? [] };
    }
  );

  app.patch<{ Params: { id: string } }>(
    '/users/:id/suspend',
    {
      schema: {
        tags: ['Admin'],
        summary: 'Suspend or unsuspend a user account (admin only)',
      },
    },
    async (request) => {
      const { id } = request.params;
      const adminId = request.authUser!.id;
      const body = adminSuspendUserSchema.parse(request.body);

      if (id === adminId) {
        throw new AppError(400, 'BAD_REQUEST', 'You cannot suspend your own admin account');
      }

      const { data: updated, error } = await supabaseAdmin
        .from('profiles')
        .update({
          is_suspended: body.is_suspended,
          suspended_reason: body.is_suspended ? sanitizeText(body.reason) : null,
        })
        .eq('id', id)
        .select()
        .single();

      if (error || !updated) throw new AppError(404, 'NOT_FOUND', 'User not found');

      await supabaseAdmin.from('moderation_actions').insert({
        admin_id: adminId,
        action_type: body.is_suspended ? 'suspend_user' : 'unsuspend_user',
        target_user_id: id,
        reason: sanitizeText(body.reason),
      });

      return { user: updated };
    }
  );

  app.get(
    '/posts',
    {
      schema: {
        tags: ['Admin'],
        summary: 'List all posts for moderation (admin only)',
      },
    },
    async () => {
      const { data, error } = await supabaseAdmin
        .from('posts')
        .select(
          `
          id, title, post_type, donation_type, status, urgency, location_city, created_at,
          author:profiles!posts_author_id_fkey(id, full_name, is_suspended)
        `
        )
        .order('created_at', { ascending: false })
        .limit(100);

      if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Failed to fetch posts');
      return { posts: data ?? [] };
    }
  );

  app.patch<{ Params: { id: string } }>(
    '/posts/:id/status',
    {
      schema: {
        tags: ['Admin'],
        summary: 'Moderate post status (admin only)',
      },
    },
    async (request) => {
      const { id } = request.params;
      const adminId = request.authUser!.id;
      const body = adminPostStatusSchema.parse(request.body);

      const { data: updated, error } = await supabaseAdmin
        .from('posts')
        .update({ status: body.status })
        .eq('id', id)
        .select()
        .single();

      if (error || !updated) throw new AppError(404, 'NOT_FOUND', 'Post not found');

      await supabaseAdmin.from('moderation_actions').insert({
        admin_id: adminId,
        action_type: body.status === 'removed' ? 'remove_post' : 'restore_post',
        target_post_id: id,
        reason: sanitizeText(body.reason),
      });

      await createNotification({
        userId: updated.author_id,
        type: 'moderation',
        title: 'Post moderation update',
        body: `Your post "${updated.title}" status was updated to ${body.status}: ${sanitizeText(body.reason)}`,
        link: `/posts/${id}`,
      });

      return { post: updated };
    }
  );

  app.get(
    '/reports',
    {
      schema: {
        tags: ['Admin'],
        summary: 'List all user and post reports (admin only)',
      },
    },
    async () => {
      const { data, error } = await supabaseAdmin
        .from('reports')
        .select(
          `
          *,
          reporter:profiles!reports_reporter_id_fkey(id, full_name)
        `
        )
        .order('created_at', { ascending: false })
        .limit(100);

      if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Failed to fetch reports');
      return { reports: data ?? [] };
    }
  );

  app.patch<{ Params: { id: string } }>(
    '/reports/:id',
    {
      schema: {
        tags: ['Admin'],
        summary: 'Resolve or dismiss a report (admin only)',
      },
    },
    async (request) => {
      const { id } = request.params;
      const adminId = request.authUser!.id;
      const body = adminResolveReportSchema.parse(request.body);

      const { data: updated, error } = await supabaseAdmin
        .from('reports')
        .update({
          status: body.status,
          resolved_by: adminId,
          resolved_at: body.status === 'reviewing' ? null : new Date().toISOString(),
        })
        .eq('id', id)
        .select()
        .single();

      if (error || !updated) throw new AppError(404, 'NOT_FOUND', 'Report not found');

      if (body.status === 'resolved' || body.status === 'dismissed') {
        await supabaseAdmin.from('moderation_actions').insert({
          admin_id: adminId,
          action_type: body.status === 'resolved' ? 'resolve_report' : 'dismiss_report',
          report_id: id,
          reason: sanitizeText(body.reason),
        });
      }

      return { report: updated };
    }
  );
}
