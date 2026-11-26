import type { FastifyInstance } from 'fastify';
import { getDb } from '../../lib/mongo.js';
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
      const db = await getDb();
      const notifications = await db
        .collection('notifications')
        .find({ user_id: userId }, { projection: { _id: 0 } })
        .sort({ created_at: -1 })
        .limit(50)
        .toArray();
      const unreadCount = notifications.filter((n) => !n.is_read).length;
      return { notifications, unread_count: unreadCount };
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
      const db = await getDb();
      await db.collection('notifications').updateOne({ id, user_id: userId }, { $set: { is_read: true } });
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
      const db = await getDb();
      await db.collection('notifications').updateMany({ user_id: userId, is_read: false }, { $set: { is_read: true } });
      return { success: true };
    }
  );
}
