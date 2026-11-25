import type { FastifyInstance } from 'fastify';
import { dbQuery } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';
import { assertNoSensitiveFinancialData, sanitizeText } from '../../lib/security.js';
import { authenticate } from '../../middleware/auth.js';
import { createContributionSchema } from '../../schemas/interactions.schema.js';
import { createNotification } from '../../services/notifications.service.js';

export async function contributionRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { postId: string } }>(
    '/posts/:postId/contributions',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Contributions'],
        summary: 'Create a direct monetary pledge (Pledged -> Confirmed by both parties)',
      },
    },
    async (request, reply) => {
      const { postId } = request.params;
      const userId = request.authUser!.id;
      const body = createContributionSchema.parse(request.body);
      assertNoSensitiveFinancialData(body.note);

      const postRes = await dbQuery<{ id: string; author_id: string; donation_type: string; status: string; title: string }>(
        'SELECT id, author_id, donation_type, status, title FROM posts WHERE id = $1',
        [postId]
      );
      const post = postRes.rows[0];
      if (!post) throw new AppError(404, 'NOT_FOUND', 'Post not found');
      if (post.author_id === userId) {
        throw new AppError(400, 'BAD_REQUEST', 'You cannot pledge to your own post');
      }
      if (post.donation_type !== 'money') {
        throw new AppError(400, 'BAD_REQUEST', 'Monetary pledges are only supported on monetary posts');
      }
      if (post.status !== 'active') {
        throw new AppError(400, 'BAD_REQUEST', 'This post is no longer accepting pledges');
      }

      const res = await dbQuery(
        `INSERT INTO contributions (post_id, contributor_id, amount, currency, note, status)
         VALUES ($1, $2, $3, $4, $5, 'pledged')
         RETURNING *`,
        [postId, userId, body.amount, body.currency.toUpperCase(), body.note ? sanitizeText(body.note) : null]
      );

      await createNotification({
        userId: post.author_id,
        type: 'new_offer',
        title: 'New monetary pledge',
        body: `${request.authUser!.full_name} pledged ${body.amount} ${body.currency.toUpperCase()} for "${post.title}". Coordinate direct transfer and confirm once received.`,
        link: `/posts/${postId}`,
      });

      return reply.status(201).send({ contribution: res.rows[0] });
    }
  );

  app.get(
    '/contributions/mine',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Contributions'],
        summary: 'List monetary pledges made or received by the authenticated user',
      },
    },
    async (request) => {
      const userId = request.authUser!.id;
      const [outRes, inRes] = await Promise.all([
        dbQuery(
          `SELECT c.*,
                  json_build_object('id', p.id, 'title', p.title, 'currency', p.currency, 'status', p.status, 'author_id', p.author_id,
                    'author', json_build_object('id', au.id, 'full_name', au.full_name)) AS post
           FROM contributions c
           JOIN posts p ON p.id = c.post_id
           JOIN profiles au ON au.id = p.author_id
           WHERE c.contributor_id = $1
           ORDER BY c.created_at DESC`,
          [userId]
        ),
        dbQuery(
          `SELECT c.*,
                  json_build_object('id', co.id, 'full_name', co.full_name) AS contributor,
                  json_build_object('id', p.id, 'title', p.title, 'currency', p.currency, 'status', p.status) AS post
           FROM contributions c
           JOIN posts p ON p.id = c.post_id
           JOIN profiles co ON co.id = c.contributor_id
           WHERE p.author_id = $1
           ORDER BY c.created_at DESC`,
          [userId]
        ),
      ]);

      return { outgoing: outRes.rows, incoming: inRes.rows };
    }
  );

  app.patch<{ Params: { id: string } }>(
    '/contributions/:id/confirm',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Contributions'],
        summary: 'Confirm direct monetary transfer (requires both donor and recipient)',
      },
    },
    async (request) => {
      const { id } = request.params;
      const userId = request.authUser!.id;

      const res = await dbQuery<{
        post_id: string;
        contributor_id: string;
        status: string;
        donor_confirmed: boolean;
        recipient_confirmed: boolean;
        author_id: string;
        post_type: string;
        title: string;
      }>(
        `SELECT c.*, p.author_id, p.post_type, p.title
         FROM contributions c JOIN posts p ON p.id = c.post_id WHERE c.id = $1`,
        [id]
      );
      const contrib = res.rows[0];
      if (!contrib) throw new AppError(404, 'NOT_FOUND', 'Contribution not found');
      if (contrib.status !== 'pledged') {
        throw new AppError(409, 'CONFLICT', 'Only pledged contributions can be confirmed');
      }

      const isContributor = contrib.contributor_id === userId;
      const isPostOwner = contrib.author_id === userId;
      if (!isContributor && !isPostOwner) {
        throw new AppError(403, 'FORBIDDEN', 'You are not a participant in this contribution');
      }

      const isUserDonor =
        (contrib.post_type === 'help_request' && isContributor) ||
        (contrib.post_type === 'donation_offer' && isPostOwner);

      const nextDonor = isUserDonor ? true : contrib.donor_confirmed;
      const nextRecipient = !isUserDonor ? true : contrib.recipient_confirmed;
      const both = nextDonor && nextRecipient;

      const updated = await dbQuery(
        `UPDATE contributions
         SET donor_confirmed = $1,
             recipient_confirmed = $2,
             status = $3,
             confirmed_at = $4,
             updated_at = NOW()
         WHERE id = $5
         RETURNING *`,
        [nextDonor, nextRecipient, both ? 'confirmed' : 'pledged', both ? new Date().toISOString() : null, id]
      );

      const otherUserId = isContributor ? contrib.author_id : contrib.contributor_id;
      await createNotification({
        userId: otherUserId,
        type: 'contribution_confirmed',
        title: both ? 'Direct transfer confirmed' : 'Transfer confirmation pending',
        body: both
          ? `Both parties confirmed the direct transfer for "${contrib.title}".`
          : `The other party marked the direct transfer as complete for "${contrib.title}". Please confirm once verified.`,
        link: `/posts/${contrib.post_id}`,
      });

      return { contribution: updated.rows[0] };
    }
  );

  app.patch<{ Params: { id: string } }>(
    '/contributions/:id/cancel',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Contributions'],
        summary: 'Cancel a pledged monetary contribution',
      },
    },
    async (request) => {
      const { id } = request.params;
      const userId = request.authUser!.id;

      const res = await dbQuery<{ contributor_id: string; status: string; author_id: string }>(
        `SELECT c.contributor_id, c.status, p.author_id
         FROM contributions c JOIN posts p ON p.id = c.post_id WHERE c.id = $1`,
        [id]
      );
      const contrib = res.rows[0];
      if (!contrib) throw new AppError(404, 'NOT_FOUND', 'Contribution not found');
      if (contrib.contributor_id !== userId && contrib.author_id !== userId) {
        throw new AppError(403, 'FORBIDDEN', 'Not authorized to cancel this pledge');
      }
      if (contrib.status !== 'pledged') {
        throw new AppError(409, 'CONFLICT', 'Only pledged contributions can be cancelled');
      }

      const updated = await dbQuery(
        `UPDATE contributions SET status = 'cancelled', updated_at = NOW() WHERE id = $1 RETURNING *`,
        [id]
      );
      return { contribution: updated.rows[0] };
    }
  );
}
