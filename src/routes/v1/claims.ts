import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/errors.js';
import { getDb, newId } from '../../lib/mongo.js';
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

      const db = await getDb();
      const post = await db.collection('posts').findOne({ id: postId });
      if (!post) throw new AppError(404, 'NOT_FOUND', 'Post not found');
      if (post.author_id === userId) {
        throw new AppError(400, 'BAD_REQUEST', 'You cannot claim or offer on your own post');
      }
      if (post.status !== 'active') {
        throw new AppError(400, 'BAD_REQUEST', 'This post is no longer accepting offers or requests');
      }

      const duplicate = await db.collection('claims').findOne({
        post_id: postId,
        claimant_id: userId,
        status: { $in: ['pending', 'accepted'] },
      });
      if (duplicate) {
        throw new AppError(409, 'CONFLICT', 'You already have an active offer or request on this post');
      }

      const claimType = post.post_type === 'help_request' ? 'offer_to_donate' : 'request_item';
      const now = new Date().toISOString();
      const claim = {
        id: newId(),
        post_id: postId,
        post_author_id: String(post.author_id),
        claimant_id: userId,
        claim_type: claimType,
        message: body.message ? sanitizeText(body.message) : null,
        quantity_offered: body.quantity_offered ?? null,
        status: 'pending',
        donor_confirmed_handover: false,
        recipient_confirmed_handover: false,
        confirmed_at: null,
        created_at: now,
        updated_at: now,
      };
      await db.collection('claims').insertOne({ ...claim });

      await createNotification({
        userId: String(post.author_id),
        type: claimType === 'offer_to_donate' ? 'new_offer' : 'new_request',
        title: claimType === 'offer_to_donate' ? 'New donation offer received' : 'New item request received',
        body: `${request.authUser!.full_name} responded to "${String(post.title)}".`,
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
      const db = await getDb();

      const [outgoingDocs, incomingDocs] = await Promise.all([
        db.collection('claims').find({ claimant_id: userId }, { projection: { _id: 0 } }).sort({ created_at: -1 }).toArray(),
        db.collection('claims').find({ post_author_id: userId }, { projection: { _id: 0 } }).sort({ created_at: -1 }).toArray(),
      ]);

      const hydrate = async (docs: Record<string, unknown>[]) =>
        Promise.all(
          docs.map(async (c) => {
            const [post, claimant] = await Promise.all([
              db.collection('posts').findOne({ id: String(c.post_id) }, { projection: { _id: 0 } }),
              db.collection('profiles').findOne(
                { id: String(c.claimant_id) },
                { projection: { _id: 0, id: 1, full_name: 1, location_city: 1 } }
              ),
            ]);
            const author = post
              ? await db
                  .collection('profiles')
                  .findOne({ id: String(post.author_id) }, { projection: { _id: 0, id: 1, full_name: 1 } })
              : null;
            return {
              ...c,
              post: post ? { ...post, author } : null,
              claimant,
            };
          })
        );

      const [outgoing, incoming] = await Promise.all([hydrate(outgoingDocs), hydrate(incomingDocs)]);
      return { outgoing, incoming };
    }
  );

  app.patch<{ Params: { id: string } }>(
    '/claims/:id/accept',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Claims'],
        summary: 'Accept a pending offer or request (atomic)',
      },
    },
    async (request) => {
      const { id } = request.params;
      const userId = request.authUser!.id;
      const db = await getDb();

      const existing = await db.collection('claims').findOne({ id });
      if (!existing) throw new AppError(404, 'NOT_FOUND', 'Claim not found');

      const post = await db.collection('posts').findOne({ id: String(existing.post_id) });
      if (!post) throw new AppError(404, 'NOT_FOUND', 'Post not found');
      if (post.author_id !== userId) throw new AppError(403, 'FORBIDDEN', 'Only the post owner can accept');
      if (post.status !== 'active') throw new AppError(400, 'BAD_REQUEST', 'Post is not active');

      const claim = await db.collection('claims').findOneAndUpdate(
        { id, status: 'pending' },
        { $set: { status: 'accepted', updated_at: new Date().toISOString() } },
        { returnDocument: 'after', projection: { _id: 0 } }
      );
      if (!claim) {
        throw new AppError(409, 'CONFLICT', 'Claim is no longer pending');
      }

      await createNotification({
        userId: String(claim.claimant_id),
        type: 'offer_accepted',
        title: 'Your offer/request was accepted!',
        body: 'You can now view handover details and coordinate directly.',
        link: `/posts/${String(claim.post_id)}`,
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
      const db = await getDb();

      const existing = await db.collection('claims').findOne({ id });
      if (!existing) throw new AppError(404, 'NOT_FOUND', 'Claim not found');
      const post = await db.collection('posts').findOne({ id: String(existing.post_id) });
      if (!post || post.author_id !== userId) {
        throw new AppError(403, 'FORBIDDEN', 'Only the post owner can reject');
      }
      if (existing.status !== 'pending') {
        throw new AppError(409, 'CONFLICT', 'Only pending claims can be rejected');
      }

      const claim = await db.collection('claims').findOneAndUpdate(
        { id, status: 'pending' },
        { $set: { status: 'rejected', updated_at: new Date().toISOString() } },
        { returnDocument: 'after', projection: { _id: 0 } }
      );

      await createNotification({
        userId: String(existing.claimant_id),
        type: 'offer_rejected',
        title: 'Offer/request update',
        body: `Your response on "${String(post.title)}" was declined.`,
        link: `/posts/${String(existing.post_id)}`,
      });

      return { claim };
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
      const db = await getDb();

      const existing = await db.collection('claims').findOne({ id });
      if (!existing) throw new AppError(404, 'NOT_FOUND', 'Claim not found');
      if (existing.claimant_id !== userId) throw new AppError(403, 'FORBIDDEN', 'Only the claimant can cancel');
      if (!['pending', 'accepted'].includes(String(existing.status))) {
        throw new AppError(409, 'CONFLICT', 'This claim cannot be cancelled');
      }

      const claim = await db.collection('claims').findOneAndUpdate(
        { id },
        { $set: { status: 'cancelled', updated_at: new Date().toISOString() } },
        { returnDocument: 'after', projection: { _id: 0 } }
      );
      return { claim };
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
      const db = await getDb();

      const claim = await db.collection('claims').findOne({ id }, { projection: { _id: 0 } });
      if (!claim) throw new AppError(404, 'NOT_FOUND', 'Claim not found');

      const post = await db.collection('posts').findOne({ id: String(claim.post_id) });
      if (!post) throw new AppError(404, 'NOT_FOUND', 'Post not found');

      const isOwner = post.author_id === userId;
      const isClaimant = claim.claimant_id === userId;
      if (!isOwner && !isClaimant) {
        throw new AppError(403, 'FORBIDDEN', 'You are not a participant in this claim');
      }

      if (claim.status === 'completed') return { claim };
      if (claim.status !== 'accepted') {
        throw new AppError(409, 'CONFLICT', 'Handover can only be confirmed for accepted claims');
      }

      const isUserDonor =
        (post.post_type === 'donation_offer' && isOwner) ||
        (post.post_type === 'help_request' && isClaimant);

      const alreadyConfirmed = isUserDonor
        ? Boolean(claim.donor_confirmed_handover)
        : Boolean(claim.recipient_confirmed_handover);
      if (alreadyConfirmed) return { claim };

      const flagField = isUserDonor ? 'donor_confirmed_handover' : 'recipient_confirmed_handover';
      const now = new Date().toISOString();

      let updated = await db.collection('claims').findOneAndUpdate(
        { id, status: 'accepted' },
        { $set: { [flagField]: true, updated_at: now } },
        { returnDocument: 'after', projection: { _id: 0 } }
      );

      if (!updated) throw new AppError(409, 'CONFLICT', 'Claim state changed concurrently');

      const bothConfirmed = Boolean(
        updated.donor_confirmed_handover && updated.recipient_confirmed_handover
      );
      if (bothConfirmed) {
        updated =
          (await db.collection('claims').findOneAndUpdate(
            { id, donor_confirmed_handover: true, recipient_confirmed_handover: true },
            { $set: { status: 'completed', confirmed_at: now, updated_at: now } },
            { returnDocument: 'after', projection: { _id: 0 } }
          )) ?? updated;
      }

      const otherUserId = isOwner ? String(claim.claimant_id) : String(post.author_id);
      await createNotification({
        userId: otherUserId,
        type: 'contribution_confirmed',
        title: bothConfirmed ? 'Handover completed!' : 'Handover confirmation pending',
        body: bothConfirmed
          ? `Both parties confirmed the handover for "${String(post.title)}".`
          : `The other party confirmed handover for "${String(post.title)}". Please confirm when ready.`,
        link: `/posts/${String(claim.post_id)}`,
      });

      return { claim: updated };
    }
  );
}
