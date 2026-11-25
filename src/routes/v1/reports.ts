import type { FastifyInstance } from 'fastify';
import { dbQuery } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';
import { sanitizeText } from '../../lib/security.js';
import { authenticate } from '../../middleware/auth.js';
import { createReportSchema } from '../../schemas/interactions.schema.js';

export async function reportRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Reports'],
        summary: 'Submit a complaint, dispute, or report against a post or user',
      },
    },
    async (request, reply) => {
      const userId = request.authUser!.id;
      const body = createReportSchema.parse(request.body);

      if (body.target_type === 'post' && !body.target_post_id) {
        throw new AppError(400, 'VALIDATION_ERROR', 'target_post_id is required when reporting a post');
      }
      if ((body.target_type === 'user' || body.target_type === 'dispute') && !body.target_user_id) {
        throw new AppError(400, 'VALIDATION_ERROR', 'target_user_id is required when complaining about a user');
      }
      if (body.target_user_id && body.target_user_id === userId) {
        throw new AppError(400, 'BAD_REQUEST', 'You cannot file a complaint against your own account');
      }

      const res = await dbQuery(
        `INSERT INTO reports (
          reporter_id, target_type, target_post_id, target_user_id, claim_id, contribution_id, reason, details, status
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open')
        RETURNING *`,
        [
          userId,
          body.target_type,
          body.target_post_id ?? null,
          body.target_user_id ?? null,
          body.claim_id ?? null,
          body.contribution_id ?? null,
          sanitizeText(body.reason),
          body.details ? sanitizeText(body.details) : null,
        ]
      );

      return reply.status(201).send({ report: res.rows[0] });
    }
  );

  app.get(
    '/mine',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Reports'],
        summary: 'List complaints and reports submitted by the authenticated user',
      },
    },
    async (request) => {
      const userId = request.authUser!.id;
      const res = await dbQuery(
        `SELECT r.*,
                tu.full_name AS target_user_name,
                p.title AS target_post_title
         FROM reports r
         LEFT JOIN profiles tu ON tu.id = r.target_user_id
         LEFT JOIN posts p ON p.id = r.target_post_id
         WHERE r.reporter_id = $1
         ORDER BY r.created_at DESC`,
        [userId]
      );
      return { reports: res.rows };
    }
  );
}
