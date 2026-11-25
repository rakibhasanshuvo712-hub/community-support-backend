import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/errors.js';
import { getAdminAuth, getDb } from '../../lib/firebase.js';
import { sanitizeText } from '../../lib/security.js';
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
      const db = getDb();
      const [users, posts, claims, contributions, openReports] = await Promise.all([
        db.collection('profiles').count().get(),
        db.collection('posts').count().get(),
        db.collection('claims').count().get(),
        db.collection('contributions').count().get(),
        db.collection('reports').where('status', '==', 'open').count().get(),
      ]);

      return {
        stats: {
          total_users: users.data().count,
          total_posts: posts.data().count,
          total_claims: claims.data().count,
          total_contributions: contributions.data().count,
          open_reports: openReports.data().count,
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
      const snap = await getDb().collection('profiles').orderBy('created_at', 'desc').limit(100).get();
      return { users: snap.docs.map((d) => ({ id: d.id, ...d.data() })) };
    }
  );

  app.patch<{ Params: { id: string } }>(
    '/users/:id/suspend',
    {
      schema: {
        tags: ['Admin'],
        summary: 'Ban (suspend) or unban a user account (admin only)',
      },
    },
    async (request) => {
      const { id } = request.params;
      const adminId = request.authUser!.id;
      const body = adminSuspendUserSchema.parse(request.body);

      if (id === adminId) {
        throw new AppError(400, 'BAD_REQUEST', 'You cannot ban your own admin account');
      }

      const db = getDb();
      const ref = db.collection('profiles').doc(id);
      const snap = await ref.get();
      if (!snap.exists) throw new AppError(404, 'NOT_FOUND', 'User not found');

      const now = new Date().toISOString();
      const updates = {
        is_suspended: body.is_suspended,
        suspended_reason: body.is_suspended ? sanitizeText(body.reason) : null,
        updated_at: now,
      };
      await ref.update(updates);

      if (body.is_suspended) {
        try {
          await getAdminAuth().revokeRefreshTokens(id);
        } catch {
          // Ignore if auth user was already deleted
        }
      }

      await db.collection('moderation_actions').add({
        admin_id: adminId,
        action_type: body.is_suspended ? 'suspend_user' : 'unsuspend_user',
        target_user_id: id,
        reason: sanitizeText(body.reason),
        created_at: now,
      });

      return { user: { id, ...snap.data(), ...updates } };
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
      const snap = await getDb().collection('posts').orderBy('created_at', 'desc').limit(100).get();
      return { posts: snap.docs.map((d) => ({ id: d.id, ...d.data() })) };
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

      const db = getDb();
      const ref = db.collection('posts').doc(id);
      const snap = await ref.get();
      if (!snap.exists) throw new AppError(404, 'NOT_FOUND', 'Post not found');

      const existing = snap.data()!;
      const now = new Date().toISOString();
      await ref.update({ status: body.status, updated_at: now });

      await db.collection('moderation_actions').add({
        admin_id: adminId,
        action_type: body.status === 'removed' ? 'remove_post' : 'restore_post',
        target_post_id: id,
        reason: sanitizeText(body.reason),
        created_at: now,
      });

      await createNotification({
        userId: String(existing.author_id),
        type: 'moderation',
        title: 'Post moderation update',
        body: `Your post "${existing.title}" status was updated to ${body.status}: ${sanitizeText(body.reason)}`,
        link: `/posts/${id}`,
      });

      return { post: { id, ...existing, status: body.status, updated_at: now } };
    }
  );

  app.delete<{ Params: { id: string } }>(
    '/posts/:id',
    {
      schema: {
        tags: ['Admin'],
        summary: 'Permanently delete any post (admin only)',
      },
    },
    async (request) => {
      const { id } = request.params;
      const adminId = request.authUser!.id;
      const db = getDb();
      const ref = db.collection('posts').doc(id);
      const snap = await ref.get();

      if (!snap.exists) throw new AppError(404, 'NOT_FOUND', 'Post not found');
      const existing = snap.data()!;
      const now = new Date().toISOString();

      await ref.delete();

      await db.collection('moderation_actions').add({
        admin_id: adminId,
        action_type: 'remove_post',
        target_post_id: id,
        target_user_id: existing.author_id ?? null,
        reason: `Deleted post "${existing.title}"`,
        created_at: now,
      });

      if (existing.author_id) {
        await createNotification({
          userId: String(existing.author_id),
          type: 'moderation',
          title: 'Post deleted by administrator',
          body: `Your post "${existing.title}" was deleted by an administrator.`,
        });
      }

      return { success: true };
    }
  );

  app.get(
    '/reports',
    {
      schema: {
        tags: ['Admin'],
        summary: 'List all disputes, complaints, and reports (admin only)',
      },
    },
    async () => {
      const db = getDb();
      const snap = await db.collection('reports').orderBy('created_at', 'desc').limit(100).get();

      const reports = await Promise.all(
        snap.docs.map(async (d) => {
          const r = d.data();
          const [reporterSnap, targetUserSnap, targetPostSnap] = await Promise.all([
            r.reporter_id ? db.collection('profiles').doc(String(r.reporter_id)).get() : Promise.resolve(null),
            r.target_user_id ? db.collection('profiles').doc(String(r.target_user_id)).get() : Promise.resolve(null),
            r.target_post_id ? db.collection('posts').doc(String(r.target_post_id)).get() : Promise.resolve(null),
          ]);
          return {
            id: d.id,
            ...r,
            reporter_name: reporterSnap?.exists ? reporterSnap.data()?.full_name : 'Unknown',
            target_user_name: targetUserSnap?.exists ? targetUserSnap.data()?.full_name : null,
            target_post_title: targetPostSnap?.exists ? targetPostSnap.data()?.title : null,
          };
        })
      );

      return { reports };
    }
  );

  app.patch<{ Params: { id: string } }>(
    '/reports/:id',
    {
      schema: {
        tags: ['Admin'],
        summary: 'Handle, resolve, or dismiss a dispute/report (admin only)',
      },
    },
    async (request) => {
      const { id } = request.params;
      const adminId = request.authUser!.id;
      const body = adminResolveReportSchema.parse(request.body);

      const db = getDb();
      const ref = db.collection('reports').doc(id);
      const snap = await ref.get();
      if (!snap.exists) throw new AppError(404, 'NOT_FOUND', 'Report not found');

      const existing = snap.data()!;
      const now = new Date().toISOString();
      const updates = {
        status: body.status,
        resolution_note: sanitizeText(body.reason),
        resolved_by: adminId,
        resolved_at: body.status === 'reviewing' ? null : now,
      };
      await ref.update(updates);

      if (body.status === 'resolved' || body.status === 'dismissed') {
        await db.collection('moderation_actions').add({
          admin_id: adminId,
          action_type: body.status === 'resolved' ? 'resolve_report' : 'dismiss_report',
          report_id: id,
          reason: sanitizeText(body.reason),
          created_at: now,
        });

        if (existing.reporter_id) {
          await createNotification({
            userId: String(existing.reporter_id),
            type: 'moderation',
            title: `Dispute ${body.status}`,
            body: `Your complaint ("${existing.reason}") was marked ${body.status}: ${sanitizeText(body.reason)}`,
            link: '/dashboard',
          });
        }
      }

      return { report: { id, ...existing, ...updates } };
    }
  );

  app.get(
    '/actions',
    {
      schema: {
        tags: ['Admin'],
        summary: 'List recent admin moderation actions (admin only)',
      },
    },
    async () => {
      const snap = await getDb()
        .collection('moderation_actions')
        .orderBy('created_at', 'desc')
        .limit(50)
        .get();
      return { actions: snap.docs.map((d) => ({ id: d.id, ...d.data() })) };
    }
  );
}
