import type { FastifyInstance } from 'fastify';
import { dbQuery } from '../../lib/db.js';
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
      const [users, posts, claims, contributions, openReports] = await Promise.all([
        dbQuery<{ count: string }>('SELECT COUNT(*)::text AS count FROM profiles'),
        dbQuery<{ count: string }>('SELECT COUNT(*)::text AS count FROM posts'),
        dbQuery<{ count: string }>('SELECT COUNT(*)::text AS count FROM claims'),
        dbQuery<{ count: string }>('SELECT COUNT(*)::text AS count FROM contributions'),
        dbQuery<{ count: string }>(`SELECT COUNT(*)::text AS count FROM reports WHERE status = 'open'`),
      ]);

      return {
        stats: {
          total_users: Number(users.rows[0]?.count ?? 0),
          total_posts: Number(posts.rows[0]?.count ?? 0),
          total_claims: Number(claims.rows[0]?.count ?? 0),
          total_contributions: Number(contributions.rows[0]?.count ?? 0),
          open_reports: Number(openReports.rows[0]?.count ?? 0),
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
      const res = await dbQuery(
        'SELECT id, full_name, role, is_suspended, suspended_reason, location_city, created_at FROM profiles ORDER BY created_at DESC LIMIT 100'
      );
      return { users: res.rows };
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

      const res = await dbQuery(
        `UPDATE profiles
         SET is_suspended = $1,
             suspended_reason = $2,
             updated_at = NOW()
         WHERE id = $3
         RETURNING *`,
        [body.is_suspended, body.is_suspended ? sanitizeText(body.reason) : null, id]
      );
      if (!res.rows[0]) throw new AppError(404, 'NOT_FOUND', 'User not found');

      await dbQuery(
        `INSERT INTO moderation_actions (admin_id, action_type, target_user_id, reason)
         VALUES ($1, $2, $3, $4)`,
        [adminId, body.is_suspended ? 'suspend_user' : 'unsuspend_user', id, sanitizeText(body.reason)]
      );

      return { user: res.rows[0] };
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
      const res = await dbQuery(
        `SELECT p.id, p.title, p.post_type, p.donation_type, p.status, p.urgency, p.location_city, p.created_at,
                json_build_object('id', pr.id, 'full_name', pr.full_name, 'is_suspended', pr.is_suspended) AS author
         FROM posts p
         JOIN profiles pr ON pr.id = p.author_id
         ORDER BY p.created_at DESC
         LIMIT 100`
      );
      return { posts: res.rows };
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

      const res = await dbQuery<{ id: string; author_id: string; title: string; status: string }>(
        'UPDATE posts SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
        [body.status, id]
      );
      const updated = res.rows[0];
      if (!updated) throw new AppError(404, 'NOT_FOUND', 'Post not found');

      await dbQuery(
        `INSERT INTO moderation_actions (admin_id, action_type, target_post_id, reason)
         VALUES ($1, $2, $3, $4)`,
        [adminId, body.status === 'removed' ? 'remove_post' : 'restore_post', id, sanitizeText(body.reason)]
      );

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

      const existingRes = await dbQuery<{ id: string; author_id: string; title: string }>(
        'SELECT id, author_id, title FROM posts WHERE id = $1',
        [id]
      );
      const existing = existingRes.rows[0];
      if (!existing) throw new AppError(404, 'NOT_FOUND', 'Post not found');

      await dbQuery('DELETE FROM posts WHERE id = $1', [id]);

      await dbQuery(
        `INSERT INTO moderation_actions (admin_id, action_type, target_post_id, target_user_id, reason)
         VALUES ($1, 'remove_post', $2, $3, $4)`,
        [adminId, id, existing.author_id, `Deleted post "${existing.title}"`]
      );

      await createNotification({
        userId: existing.author_id,
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
      const res = await dbQuery(
        `SELECT r.*,
                rp.full_name AS reporter_name,
                tu.full_name AS target_user_name,
                p.title AS target_post_title
         FROM reports r
         LEFT JOIN profiles rp ON rp.id = r.reporter_id
         LEFT JOIN profiles tu ON tu.id = r.target_user_id
         LEFT JOIN posts p ON p.id = r.target_post_id
         ORDER BY r.created_at DESC
         LIMIT 100`
      );
      return { reports: res.rows };
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

      const res = await dbQuery<{ id: string; reporter_id: string; reason: string; status: string }>(
        `UPDATE reports
         SET status = $1,
             resolution_note = $2,
             resolved_by = $3,
             resolved_at = CASE WHEN $1 = 'reviewing' THEN NULL ELSE NOW() END
         WHERE id = $4
         RETURNING *`,
        [body.status, sanitizeText(body.reason), adminId, id]
      );
      const updated = res.rows[0];
      if (!updated) throw new AppError(404, 'NOT_FOUND', 'Report not found');

      if (body.status === 'resolved' || body.status === 'dismissed') {
        await dbQuery(
          `INSERT INTO moderation_actions (admin_id, action_type, report_id, reason)
           VALUES ($1, $2, $3, $4)`,
          [adminId, body.status === 'resolved' ? 'resolve_report' : 'dismiss_report', id, sanitizeText(body.reason)]
        );

        await createNotification({
          userId: updated.reporter_id,
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
      const res = await dbQuery('SELECT * FROM moderation_actions ORDER BY created_at DESC LIMIT 50');
      return { actions: res.rows };
    }
  );
}
