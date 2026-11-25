import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/errors.js';
import { getDb } from '../../lib/firebase.js';
import { assertNoSensitiveFinancialData, sanitizeText } from '../../lib/security.js';
import { authenticate } from '../../middleware/auth.js';
import { createClaimSchema } from '../../schemas/interactions.schema.js';
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

      const db = getDb();
      const postSnap = await db.collection('posts').doc(postId).get();
      if (!postSnap.exists) throw new AppError(404, 'NOT_FOUND', 'Post not found');

      const post = postSnap.data()!;
      if (post.author_id === userId) {
        throw new AppError(400, 'BAD_REQUEST', 'You cannot claim or offer on your own post');
      }
      if (post.status !== 'active') {
        throw new AppError(400, 'BAD_REQUEST', 'This post is no longer accepting offers or requests');
      }

      const duplicateSnap = await db
        .collection('claims')
        .where('post_id', '==', postId)
        .where('claimant_id', '==', userId)
        .where('status', 'in', ['pending', 'accepted'])
        .limit(1)
        .get();

      if (!duplicateSnap.empty) {
        throw new AppError(409, 'CONFLICT', 'You already have an active offer or request on this post');
      }

      const claimType = post.post_type === 'help_request' ? 'offer_to_donate' : 'request_item';
      const now = new Date().toISOString();
      const claimRef = db.collection('claims').doc();
      const claimDoc = {
        id: claimRef.id,
        post_id: postId,
        post_author_id: post.author_id,
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
      await claimRef.set(claimDoc);

      await createNotification({
        userId: String(post.author_id),
        type: claimType === 'offer_to_donate' ? 'new_offer' : 'new_request',
        title: claimType === 'offer_to_donate' ? 'New donation offer received' : 'New item request received',
        body: `${request.authUser!.full_name} responded to "${post.title}".`,
        link: `/posts/${postId}`,
      });

      return reply.status(201).send({ claim: claimDoc });
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
      const db = getDb();

      const [outgoingSnap, incomingSnap] = await Promise.all([
        db.collection('claims').where('claimant_id', '==', userId).orderBy('created_at', 'desc').get(),
        db.collection('claims').where('post_author_id', '==', userId).orderBy('created_at', 'desc').get(),
      ]);

      const hydrate = async (docs: FirebaseFirestore.QueryDocumentSnapshot[]) =>
        Promise.all(
          docs.map(async (d) => {
            const c = d.data();
            const [postSnap, claimantSnap] = await Promise.all([
              db.collection('posts').doc(String(c.post_id)).get(),
              db.collection('profiles').doc(String(c.claimant_id)).get(),
            ]);
            return {
              id: d.id,
              ...c,
              post: postSnap.exists ? { id: postSnap.id, ...postSnap.data() } : null,
              claimant: claimantSnap.exists
                ? { id: claimantSnap.id, full_name: claimantSnap.data()?.full_name }
                : null,
            };
          })
        );

      const [outgoing, incoming] = await Promise.all([
        hydrate(outgoingSnap.docs),
        hydrate(incomingSnap.docs),
      ]);

      return { outgoing, incoming };
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
      const db = getDb();

      const updatedClaim = await db.runTransaction(async (tx) => {
        const claimRef = db.collection('claims').doc(id);
        const claimSnap = await tx.get(claimRef);
        if (!claimSnap.exists) throw new AppError(404, 'NOT_FOUND', 'Claim not found');

        const claim = claimSnap.data()!;
        const postRef = db.collection('posts').doc(String(claim.post_id));
        const postSnap = await tx.get(postRef);
        if (!postSnap.exists) throw new AppError(404, 'NOT_FOUND', 'Post not found');

        const post = postSnap.data()!;
        if (post.author_id !== userId) {
          throw new AppError(403, 'FORBIDDEN', 'Only the post owner can accept');
        }
        if (post.status !== 'active') {
          throw new AppError(400, 'BAD_REQUEST', 'Post is not active');
        }
        if (claim.status !== 'pending') {
          throw new AppError(409, 'CONFLICT', 'Claim is no longer pending');
        }

        const now = new Date().toISOString();
        tx.update(claimRef, { status: 'accepted', updated_at: now });
        return { id: claimSnap.id, ...claim, status: 'accepted', updated_at: now } as Record<string, unknown>;
      });

      await createNotification({
        userId: String(updatedClaim.claimant_id),
        type: 'offer_accepted',
        title: 'Your offer/request was accepted!',
        body: 'You can now view handover details and coordinate directly.',
        link: `/posts/${updatedClaim.post_id}`,
      });

      return { claim: updatedClaim };
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
      const db = getDb();
      const claimRef = db.collection('claims').doc(id);
      const claimSnap = await claimRef.get();

      if (!claimSnap.exists) throw new AppError(404, 'NOT_FOUND', 'Claim not found');
      const claim = claimSnap.data()!;
      if (claim.post_author_id !== userId) {
        throw new AppError(403, 'FORBIDDEN', 'Only the post owner can reject');
      }
      if (claim.status !== 'pending') {
        throw new AppError(409, 'CONFLICT', 'Only pending claims can be rejected');
      }

      const now = new Date().toISOString();
      await claimRef.update({ status: 'rejected', updated_at: now });

      await createNotification({
        userId: String(claim.claimant_id),
        type: 'offer_rejected',
        title: 'Offer/request update',
        body: 'Your response on a post was declined.',
        link: `/posts/${claim.post_id}`,
      });

      return { claim: { id, ...claim, status: 'rejected', updated_at: now } };
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
      const db = getDb();
      const claimRef = db.collection('claims').doc(id);
      const claimSnap = await claimRef.get();

      if (!claimSnap.exists) throw new AppError(404, 'NOT_FOUND', 'Claim not found');
      const claim = claimSnap.data()!;
      if (claim.claimant_id !== userId) {
        throw new AppError(403, 'FORBIDDEN', 'Only the claimant can cancel');
      }
      if (!['pending', 'accepted'].includes(String(claim.status))) {
        throw new AppError(409, 'CONFLICT', 'This claim cannot be cancelled');
      }

      const now = new Date().toISOString();
      await claimRef.update({ status: 'cancelled', updated_at: now });
      return { claim: { id, ...claim, status: 'cancelled', updated_at: now } };
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
      const db = getDb();
      const claimRef = db.collection('claims').doc(id);
      const claimSnap = await claimRef.get();

      if (!claimSnap.exists) throw new AppError(404, 'NOT_FOUND', 'Claim not found');
      const claim = claimSnap.data()!;
      if (claim.status !== 'accepted') {
        throw new AppError(409, 'CONFLICT', 'Handover can only be confirmed for accepted claims');
      }

      const postSnap = await db.collection('posts').doc(String(claim.post_id)).get();
      const post = postSnap.data()!;
      const isOwner = post.author_id === userId;
      const isClaimant = claim.claimant_id === userId;

      if (!isOwner && !isClaimant) {
        throw new AppError(403, 'FORBIDDEN', 'You are not a participant in this claim');
      }

      const isUserDonor =
        (post.post_type === 'donation_offer' && isOwner) ||
        (post.post_type === 'help_request' && isClaimant);

      const nextDonorConfirmed = isUserDonor ? true : Boolean(claim.donor_confirmed_handover);
      const nextRecipientConfirmed = !isUserDonor ? true : Boolean(claim.recipient_confirmed_handover);
      const bothConfirmed = nextDonorConfirmed && nextRecipientConfirmed;
      const now = new Date().toISOString();

      const updates = {
        donor_confirmed_handover: nextDonorConfirmed,
        recipient_confirmed_handover: nextRecipientConfirmed,
        status: bothConfirmed ? 'completed' : 'accepted',
        confirmed_at: bothConfirmed ? now : null,
        updated_at: now,
      };
      await claimRef.update(updates);

      const otherUserId = isOwner ? String(claim.claimant_id) : String(post.author_id);
      await createNotification({
        userId: otherUserId,
        type: 'contribution_confirmed',
        title: bothConfirmed ? 'Handover completed!' : 'Handover confirmation pending',
        body: bothConfirmed
          ? `Both parties confirmed the handover for "${post.title}".`
          : `The other party confirmed handover for "${post.title}". Please confirm when ready.`,
        link: `/posts/${claim.post_id}`,
      });

      return { claim: { id, ...claim, ...updates } };
    }
  );
}
