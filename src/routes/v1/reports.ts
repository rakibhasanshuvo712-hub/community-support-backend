import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/errors.js';
import { getDb } from '../../lib/firebase.js';
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

      const db = getDb();
      const ref = db.collection('reports').doc();
      const report = {
        id: ref.id,
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
      await ref.set(report);

      return reply.status(201).send({ report });
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
      const db = getDb();
      const snap = await db
        .collection('reports')
        .where('reporter_id', '==', userId)
        .orderBy('created_at', 'desc')
        .get();

      const reports = await Promise.all(
        snap.docs.map(async (d) => {
          const r = d.data();
          const [targetUserSnap, targetPostSnap] = await Promise.all([
            r.target_user_id ? db.collection('profiles').doc(String(r.target_user_id)).get() : Promise.resolve(null),
            r.target_post_id ? db.collection('posts').doc(String(r.target_post_id)).get() : Promise.resolve(null),
          ]);
          return {
            id: d.id,
            ...r,
            target_user_name: targetUserSnap?.exists ? targetUserSnap.data()?.full_name : null,
            target_post_title: targetPostSnap?.exists ? targetPostSnap.data()?.title : null,
          };
        })
      );

      return { reports };
    }
  );
}
