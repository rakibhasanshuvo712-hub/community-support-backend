import type { FastifyInstance } from 'fastify';
import { dbQuery } from '../../lib/db.js';
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
      const res = await dbQuery<{ is_read: boolean }>(
        'SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
        [userId]
      );
      const unreadCount = res.rows.filter((n) => !n.is_read).length;
      return { notifications: res.rows, unread_count: unreadCount };
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
      await dbQuery('UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2', [id, userId]);
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
      await dbQuery('UPDATE notifications SET is_read = TRUE WHERE user_id = $1 AND is_read = FALSE', [userId]);
      return { success: true };
    }
  );
}
