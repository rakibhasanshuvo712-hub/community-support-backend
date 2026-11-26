import type { FastifyInstance } from 'fastify';
import { dbQuery, getPool } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';
import { assertNoSensitiveFinancialData, sanitizeText } from '../../lib/security.js';
import { authenticate } from '../../middleware/auth.js';
import { createClaimSchema } from '../../schemas/interactions.schema.js';
import { enqueueAndDispatchClaimAcceptedSms } from '../../services/applinkSms.service.js';
import { createNotification } from '../../services/notifications.service.js';

export async function claimRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { postId: string } }>(
    '/posts/:postId/claims',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Claims'],
        summary: 'Create a donation offer or item request on a post',
      },
    },
    async (request, reply) => {
      const { postId } = request.params;
      const userId = request.authUser!.id;
      const body = createClaimSchema.parse(request.body);
      assertNoSensitiveFinancialData(body.message);

      const postRes = await dbQuery<{ id: string; author_id: string; post_type: string; status: string; title: string }>(
        'SELECT id, author_id, post_type, status, title FROM posts WHERE id = $1',
        [postId]
      );
      const post = postRes.rows[0];
      if (!post) throw new AppError(404, 'NOT_FOUND', 'Post not found');
      if (post.author_id === userId) {
        throw new AppError(400, 'BAD_REQUEST', 'You cannot claim or offer on your own post');
      }
      if (post.status !== 'active') {
        throw new AppError(400, 'BAD_REQUEST', 'This post is no longer accepting offers or requests');
      }

      const claimType = post.post_type === 'help_request' ? 'offer_to_donate' : 'request_item';

      let claim;
      try {
        const res = await dbQuery(
          `INSERT INTO claims (post_id, claimant_id, claim_type, message, quantity_offered, status)
           VALUES ($1, $2, $3, $4, $5, 'pending')
           RETURNING *`,
          [
            postId,
            userId,
            claimType,
            body.message ? sanitizeText(body.message) : null,
            body.quantity_offered ?? null,
          ]
        );
        claim = res.rows[0];
      } catch (err: unknown) {
        if ((err as { code?: string }).code === '23505') {
          throw new AppError(409, 'CONFLICT', 'You already have an active offer or request on this post');
        }
        throw err;
      }

      await createNotification({
        userId: post.author_id,
        type: claimType === 'offer_to_donate' ? 'new_offer' : 'new_request',
        title: claimType === 'offer_to_donate' ? 'New donation offer received' : 'New item request received',
        body: `${request.authUser!.full_name} responded to "${post.title}".`,
        link: `/posts/${postId}`,
      });

      return reply.status(201).send({ claim });
    }
  );

  app.get(
    '/claims/mine',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Claims'],
        summary: 'List claims made by or received by the authenticated user',
      },
    },
    async (request) => {
      const userId = request.authUser!.id;
      const [outRes, inRes] = await Promise.all([
        dbQuery(
          `SELECT c.*,
                  json_build_object('id', p.id, 'title', p.title, 'post_type', p.post_type, 'donation_type', p.donation_type, 'status', p.status, 'location_city', p.location_city, 'author_id', p.author_id,
                    'author', json_build_object('id', au.id, 'full_name', au.full_name)) AS post
           FROM claims c
           JOIN posts p ON p.id = c.post_id
           JOIN profiles au ON au.id = p.author_id
           WHERE c.claimant_id = $1
           ORDER BY c.created_at DESC`,
          [userId]
        ),
        dbQuery(
          `SELECT c.*,
                  json_build_object('id', cl.id, 'full_name', cl.full_name, 'location_city', cl.location_city) AS claimant,
                  json_build_object('id', p.id, 'title', p.title, 'post_type', p.post_type, 'donation_type', p.donation_type, 'status', p.status) AS post
           FROM claims c
           JOIN posts p ON p.id = c.post_id
           JOIN profiles cl ON cl.id = c.claimant_id
           WHERE p.author_id = $1
           ORDER BY c.created_at DESC`,
          [userId]
        ),
      ]);

      return { outgoing: outRes.rows, incoming: inRes.rows };
    }
  );

  app.patch<{ Params: { id: string } }>(
    '/claims/:id/accept',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Claims'],
        summary: 'Accept a pending offer or request (transactional)',
      },
    },
    async (request) => {
      const { id } = request.params;
      const userId = request.authUser!.id;
      const client = await getPool().connect();

      let claim;
      try {
        await client.query('BEGIN');
        const claimRes = await client.query('SELECT * FROM claims WHERE id = $1 FOR UPDATE', [id]);
        if (!claimRes.rows[0]) throw new AppError(404, 'NOT_FOUND', 'Claim not found');

        const postRes = await client.query('SELECT * FROM posts WHERE id = $1 FOR UPDATE', [claimRes.rows[0].post_id]);
        if (!postRes.rows[0]) throw new AppError(404, 'NOT_FOUND', 'Post not found');

        if (postRes.rows[0].author_id !== userId) {
          throw new AppError(403, 'FORBIDDEN', 'Only the post owner can accept');
        }
        if (postRes.rows[0].status !== 'active') {
          throw new AppError(400, 'BAD_REQUEST', 'Post is not active');
        }
        if (claimRes.rows[0].status !== 'pending') {
          throw new AppError(409, 'CONFLICT', 'Claim is no longer pending');
        }

        const updatedRes = await client.query(
          `UPDATE claims SET status = 'accepted', updated_at = NOW() WHERE id = $1 RETURNING *`,
          [id]
        );
        claim = updatedRes.rows[0];
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      await createNotification({
        userId: String(claim.claimant_id),
        type: 'offer_accepted',
        title: 'Your offer/request was accepted!',
        body: 'You can now view handover details and coordinate directly.',
        link: `/posts/${claim.post_id}`,
      });

      const smsResult = await enqueueAndDispatchClaimAcceptedSms({
        claimId: id,
        recipientUserId: String(claim.claimant_id),
      });

      return { claim, sms_notification: smsResult };
    }
  );

  app.patch<{ Params: { id: string } }>(
    '/claims/:id/reject',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Claims'],
        summary: 'Reject a pending offer or request',
      },
    },
    async (request) => {
      const { id } = request.params;
      const userId = request.authUser!.id;

      const res = await dbQuery<{ claimant_id: string; post_id: string; status: string; author_id: string; title: string }>(
        `SELECT c.claimant_id, c.post_id, c.status, p.author_id, p.title
         FROM claims c JOIN posts p ON p.id = c.post_id WHERE c.id = $1`,
        [id]
      );
      const claim = res.rows[0];
      if (!claim) throw new AppError(404, 'NOT_FOUND', 'Claim not found');
      if (claim.author_id !== userId) throw new AppError(403, 'FORBIDDEN', 'Only the post owner can reject');
      if (claim.status !== 'pending') throw new AppError(409, 'CONFLICT', 'Only pending claims can be rejected');

      const updated = await dbQuery(
        `UPDATE claims SET status = 'rejected', updated_at = NOW() WHERE id = $1 RETURNING *`,
        [id]
      );

      await createNotification({
        userId: claim.claimant_id,
        type: 'offer_rejected',
        title: 'Offer/request update',
        body: `Your response on "${claim.title}" was declined.`,
        link: `/posts/${claim.post_id}`,
      });

      return { claim: updated.rows[0] };
    }
  );

  app.patch<{ Params: { id: string } }>(
    '/claims/:id/cancel',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Claims'],
        summary: 'Cancel your own claim or offer',
      },
    },
    async (request) => {
      const { id } = request.params;
      const userId = request.authUser!.id;

      const res = await dbQuery<{ claimant_id: string; status: string }>('SELECT claimant_id, status FROM claims WHERE id = $1', [id]);
      const claim = res.rows[0];
      if (!claim) throw new AppError(404, 'NOT_FOUND', 'Claim not found');
      if (claim.claimant_id !== userId) throw new AppError(403, 'FORBIDDEN', 'Only the claimant can cancel');
      if (!['pending', 'accepted'].includes(claim.status)) {
        throw new AppError(409, 'CONFLICT', 'This claim cannot be cancelled');
      }

      const updated = await dbQuery(
        `UPDATE claims SET status = 'cancelled', updated_at = NOW() WHERE id = $1 RETURNING *`,
        [id]
      );
      return { claim: updated.rows[0] };
    }
  );

  app.patch<{ Params: { id: string } }>(
    '/claims/:id/confirm-handover',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Claims'],
        summary: 'Confirm direct handover of item/service (two-party confirmation)',
      },
    },
    async (request) => {
      const { id } = request.params;
      const userId = request.authUser!.id;
      const client = await getPool().connect();

      let updatedClaim;
      let otherUserId: string;
      let postTitle: string;
      let postId: string;
      let bothConfirmed = false;
      let newlyConfirmed = false;

      try {
        await client.query('BEGIN');
        const res = await client.query<{
          post_id: string;
          claimant_id: string;
          status: string;
          donor_confirmed_handover: boolean;
          recipient_confirmed_handover: boolean;
          author_id: string;
          post_type: string;
          title: string;
        }>(
          `SELECT c.*, p.author_id, p.post_type, p.title
           FROM claims c JOIN posts p ON p.id = c.post_id WHERE c.id = $1 FOR UPDATE OF c`,
          [id]
        );
        const claim = res.rows[0];
        if (!claim) throw new AppError(404, 'NOT_FOUND', 'Claim not found');

        const isOwner = claim.author_id === userId;
        const isClaimant = claim.claimant_id === userId;
        if (!isOwner && !isClaimant) {
          throw new AppError(403, 'FORBIDDEN', 'You are not a participant in this claim');
        }

        if (claim.status === 'completed') {
          await client.query('COMMIT');
          return { claim };
        }
        if (claim.status !== 'accepted') {
          throw new AppError(409, 'CONFLICT', 'Handover can only be confirmed for accepted claims');
        }

        const isUserDonor =
          (claim.post_type === 'donation_offer' && isOwner) ||
          (claim.post_type === 'help_request' && isClaimant);

        const alreadyConfirmedByMe = isUserDonor
          ? claim.donor_confirmed_handover
          : claim.recipient_confirmed_handover;

        if (alreadyConfirmedByMe) {
          await client.query('COMMIT');
          return { claim };
        }

        const nextDonor = isUserDonor ? true : claim.donor_confirmed_handover;
        const nextRecipient = !isUserDonor ? true : claim.recipient_confirmed_handover;
        bothConfirmed = nextDonor && nextRecipient;
        newlyConfirmed = true;
        otherUserId = isOwner ? claim.claimant_id : claim.author_id;
        postTitle = claim.title;
        postId = claim.post_id;

        const updated = await client.query(
          `UPDATE claims
           SET donor_confirmed_handover = $1,
               recipient_confirmed_handover = $2,
               status = $3,
               confirmed_at = $4,
               updated_at = NOW()
           WHERE id = $5
           RETURNING *`,
          [nextDonor, nextRecipient, bothConfirmed ? 'completed' : 'accepted', bothConfirmed ? new Date().toISOString() : null, id]
        );
        updatedClaim = updated.rows[0];
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      if (newlyConfirmed) {
        await createNotification({
          userId: otherUserId!,
          type: 'contribution_confirmed',
          title: bothConfirmed ? 'Handover completed!' : 'Handover confirmation pending',
          body: bothConfirmed
            ? `Both parties confirmed the handover for "${postTitle!}".`
            : `The other party confirmed handover for "${postTitle!}". Please confirm when ready.`,
          link: `/posts/${postId!}`,
        });
      }

      return { claim: updatedClaim };
    }
  );
}
