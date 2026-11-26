import type { FastifyInstance } from 'fastify';
import { getDb, newId } from '../../lib/mongo.js';
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

      const db = await getDb();
      const doc = {
        id: newId(),
        reporter_id: userId,
        target_type: body.target_type,
        target_post_id: body.target_post_id ?? null,
        target_user_id: body.target_user_id ?? null,
        claim_id: body.claim_id ?? null,
        contribution_id: body.contribution_id ?? null,
        reason: sanitizeText(body.reason),
        details: body.details ? sanitizeText(body.details) : null,
        status: 'open',
        resolution_note: null,
        resolved_by: null,
        resolved_at: null,
        created_at: new Date().toISOString(),
      };
      await db.collection('reports').insertOne({ ...doc });

      return reply.status(201).send({ report: doc });
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
      const db = await getDb();
      const docs = await db
        .collection('reports')
        .find({ reporter_id: userId }, { projection: { _id: 0 } })
        .sort({ created_at: -1 })
        .toArray();

      const targetUserIds = [...new Set(docs.map((r) => r.target_user_id).filter(Boolean).map(String))];
      const targetPostIds = [...new Set(docs.map((r) => r.target_post_id).filter(Boolean).map(String))];

      const [users, posts] = await Promise.all([
        targetUserIds.length
          ? db.collection('profiles').find({ id: { $in: targetUserIds } }, { projection: { _id: 0, id: 1, full_name: 1 } }).toArray()
          : Promise.resolve([]),
        targetPostIds.length
          ? db.collection('posts').find({ id: { $in: targetPostIds } }, { projection: { _id: 0, id: 1, title: 1 } }).toArray()
          : Promise.resolve([]),
      ]);
      const userMap = new Map(users.map((u) => [String(u.id), u.full_name]));
      const postMap = new Map(posts.map((p) => [String(p.id), p.title]));

      const reports = docs.map((r) => ({
        ...r,
        target_user_name: r.target_user_id ? userMap.get(String(r.target_user_id)) ?? null : null,
        target_post_title: r.target_post_id ? postMap.get(String(r.target_post_id)) ?? null : null,
      }));
      return { reports };
    }
  );
}
