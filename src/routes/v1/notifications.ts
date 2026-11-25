import type { FastifyInstance } from 'fastify';
import { getDb } from '../../lib/firebase.js';
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
      const snap = await getDb()
        .collection('notifications')
        .where('user_id', '==', userId)
        .orderBy('created_at', 'desc')
        .limit(50)
        .get();

      const notifications = snap.docs.map((d) => ({ id: d.id, ...d.data() } as Record<string, unknown>));
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
      const ref = getDb().collection('notifications').doc(id);
      const snap = await ref.get();

      if (snap.exists && snap.data()?.user_id === userId) {
        await ref.update({ is_read: true });
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
      const db = getDb();
      const snap = await db
        .collection('notifications')
        .where('user_id', '==', userId)
        .where('is_read', '==', false)
        .get();

      if (!snap.empty) {
        const batch = db.batch();
        for (const d of snap.docs) {
          batch.update(d.ref, { is_read: true });
        }
        await batch.commit();
      }

      return { success: true };
    }
  );
}
