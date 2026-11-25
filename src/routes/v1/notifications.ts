import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/errors.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import { authenticate } from '../../middleware/auth.js';

export async function notificationRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Notifications'],
        summary: 'List notifications for the authenticated user',
      },
    },
    async (request) => {
      const userId = request.authUser!.id;
      const { data, error } = await supabaseAdmin
        .from('notifications')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(50);

      if (error) {
        throw new AppError(500, 'INTERNAL_ERROR', 'Failed to fetch notifications');
      }

      const unreadCount = (data ?? []).filter((n) => !n.is_read).length;
      return { notifications: data ?? [], unread_count: unreadCount };
    }
  );

  app.patch<{ Params: { id: string } }>(
    '/:id/read',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Notifications'],
        summary: 'Mark a notification as read',
      },
    },
    async (request) => {
      const { id } = request.params;
      const userId = request.authUser!.id;

      const { error } = await supabaseAdmin
        .from('notifications')
        .update({ is_read: true })
        .eq('id', id)
        .eq('user_id', userId);

      if (error) {
        throw new AppError(500, 'INTERNAL_ERROR', 'Failed to mark notification as read');
      }

      return { success: true };
    }
  );

  app.patch(
    '/read-all',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Notifications'],
        summary: 'Mark all notifications as read',
      },
    },
    async (request) => {
      const userId = request.authUser!.id;

      const { error } = await supabaseAdmin
        .from('notifications')
        .update({ is_read: true })
        .eq('user_id', userId)
        .eq('is_read', false);

      if (error) {
        throw new AppError(500, 'INTERNAL_ERROR', 'Failed to mark notifications as read');
      }

      return { success: true };
    }
  );
}
