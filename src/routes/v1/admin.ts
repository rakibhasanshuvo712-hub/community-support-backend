import type { FastifyInstance } from 'fastify';
import { getDb, newId } from '../../lib/mongo.js';
import { AppError } from '../../lib/errors.js';
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
      const db = await getDb();
      const [total_users, total_posts, total_claims, total_contributions, open_reports] = await Promise.all([
        db.collection('profiles').countDocuments(),
        db.collection('posts').countDocuments(),
        db.collection('claims').countDocuments(),
        db.collection('contributions').countDocuments(),
        db.collection('reports').countDocuments({ status: 'open' }),
      ]);

      return {
        stats: {
          total_users,
          total_posts,
          total_claims,
          total_contributions,
          open_reports,
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
      const db = await getDb();
      const users = await db
        .collection('profiles')
        .find({}, { projection: { _id: 0, id: 1, full_name: 1, phone: 1, role: 1, is_suspended: 1, suspended_reason: 1, location_city: 1, created_at: 1 } })
        .sort({ created_at: -1 })
        .limit(100)
        .toArray();
      return { users };
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

      const db = await getDb();
      const now = new Date().toISOString();
      const user = await db.collection('profiles').findOneAndUpdate(
        { id },
        {
          $set: {
            is_suspended: body.is_suspended,
            suspended_reason: body.is_suspended ? sanitizeText(body.reason) : null,
            updated_at: now,
          },
        },
        { returnDocument: 'after', projection: { _id: 0 } }
      );
      if (!user) throw new AppError(404, 'NOT_FOUND', 'User not found');

      await db.collection('moderation_actions').insertOne({
        id: newId(),
        admin_id: adminId,
        action_type: body.is_suspended ? 'suspend_user' : 'unsuspend_user',
        target_user_id: id,
        target_post_id: null,
        report_id: null,
        reason: sanitizeText(body.reason),
        created_at: now,
      });

      return { user };
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
      const db = await getDb();
      const postDocs = await db
        .collection('posts')
        .find({}, { projection: { _id: 0, id: 1, author_id: 1, title: 1, post_type: 1, donation_type: 1, status: 1, urgency: 1, location_city: 1, created_at: 1 } })
        .sort({ created_at: -1 })
        .limit(100)
        .toArray();

      const authorIds = [...new Set(postDocs.map((p) => String(p.author_id)))];
      const authors = authorIds.length
        ? await db.collection('profiles').find({ id: { $in: authorIds } }, { projection: { _id: 0, id: 1, full_name: 1, is_suspended: 1 } }).toArray()
        : [];
      const authorMap = new Map(authors.map((a) => [String(a.id), a]));

      const posts = postDocs.map((p) => ({
        ...p,
        author: authorMap.get(String(p.author_id)) ?? null,
      }));
      return { posts };
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

      const db = await getDb();
      const now = new Date().toISOString();
      const updated = await db.collection('posts').findOneAndUpdate(
        { id },
        { $set: { status: body.status, updated_at: now } },
        { returnDocument: 'after', projection: { _id: 0 } }
      );
      if (!updated) throw new AppError(404, 'NOT_FOUND', 'Post not found');

      await db.collection('moderation_actions').insertOne({
        id: newId(),
        admin_id: adminId,
        action_type: body.status === 'removed' ? 'remove_post' : 'restore_post',
        target_post_id: id,
        target_user_id: null,
        report_id: null,
        reason: sanitizeText(body.reason),
        created_at: now,
      });

      await createNotification({
        userId: String(updated.author_id),
        type: 'moderation',
        title: 'Post moderation update',
        body: `Your post "${updated.title}" status was updated to ${body.status}: ${sanitizeText(body.reason)}`,
        link: `/posts/${id}`,
      });

      return { post: updated };
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
      const db = await getDb();

      const existing = await db.collection('posts').findOne(
        { id },
        { projection: { _id: 0, id: 1, author_id: 1, title: 1 } }
      );
      if (!existing) throw new AppError(404, 'NOT_FOUND', 'Post not found');

      await Promise.all([
        db.collection('posts').deleteOne({ id }),
        db.collection('post_private_details').deleteMany({ post_id: id }),
        db.collection('post_images').deleteMany({ post_id: id }),
        db.collection('private_documents').deleteMany({ post_id: id }),
      ]);

      await db.collection('moderation_actions').insertOne({
        id: newId(),
        admin_id: adminId,
        action_type: 'remove_post',
        target_post_id: id,
        target_user_id: existing.author_id,
        report_id: null,
        reason: `Deleted post "${existing.title}"`,
        created_at: new Date().toISOString(),
      });

      await createNotification({
        userId: String(existing.author_id),
        type: 'moderation',
        title: 'Post deleted by administrator',
        body: `Your post "${existing.title}" was deleted by an administrator.`,
      });

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
      const db = await getDb();
      const reportDocs = await db
        .collection('reports')
        .find({}, { projection: { _id: 0 } })
        .sort({ created_at: -1 })
        .limit(100)
        .toArray();

      const userIds = [
        ...new Set(
          reportDocs
            .flatMap((r) => [r.reporter_id, r.target_user_id])
            .filter(Boolean)
            .map(String)
        ),
      ];
      const postIds = [...new Set(reportDocs.map((r) => r.target_post_id).filter(Boolean).map(String))];

      const [users, posts] = await Promise.all([
        userIds.length
          ? db.collection('profiles').find({ id: { $in: userIds } }, { projection: { _id: 0, id: 1, full_name: 1 } }).toArray()
          : Promise.resolve([]),
        postIds.length
          ? db.collection('posts').find({ id: { $in: postIds } }, { projection: { _id: 0, id: 1, title: 1 } }).toArray()
          : Promise.resolve([]),
      ]);
      const userMap = new Map(users.map((u) => [String(u.id), u.full_name]));
      const postMap = new Map(posts.map((p) => [String(p.id), p.title]));

      const reports = reportDocs.map((r) => ({
        ...r,
        reporter_name: r.reporter_id ? userMap.get(String(r.reporter_id)) ?? null : null,
        target_user_name: r.target_user_id ? userMap.get(String(r.target_user_id)) ?? null : null,
        target_post_title: r.target_post_id ? postMap.get(String(r.target_post_id)) ?? null : null,
      }));
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
      const db = await getDb();
      const now = new Date().toISOString();

      const updated = await db.collection('reports').findOneAndUpdate(
        { id },
        {
          $set: {
            status: body.status,
            resolution_note: sanitizeText(body.reason),
            resolved_by: adminId,
            resolved_at: body.status === 'reviewing' ? null : now,
          },
        },
        { returnDocument: 'after', projection: { _id: 0 } }
      );
      if (!updated) throw new AppError(404, 'NOT_FOUND', 'Report not found');

      if (body.status === 'resolved' || body.status === 'dismissed') {
        await db.collection('moderation_actions').insertOne({
          id: newId(),
          admin_id: adminId,
          action_type: body.status === 'resolved' ? 'resolve_report' : 'dismiss_report',
          report_id: id,
          target_user_id: null,
          target_post_id: null,
          reason: sanitizeText(body.reason),
          created_at: now,
        });

        await createNotification({
          userId: String(updated.reporter_id),
          type: 'moderation',
          title: `Dispute ${body.status}`,
          body: `Your complaint ("${updated.reason}") was marked ${body.status}: ${sanitizeText(body.reason)}`,
          link: '/dashboard',
        });
      }

      return { report: updated };
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
      const db = await getDb();
      const actions = await db
        .collection('moderation_actions')
        .find({}, { projection: { _id: 0 } })
        .sort({ created_at: -1 })
        .limit(50)
        .toArray();
      return { actions };
    }
  );
}
