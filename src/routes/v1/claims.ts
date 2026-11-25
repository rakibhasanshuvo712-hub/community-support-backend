import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/errors.js';
import { assertNoSensitiveFinancialData, sanitizeText } from '../../lib/security.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import { authenticate } from '../../middleware/auth.js';
import { createClaimSchema } from '../../schemas/interactions.schema.js';
import { createNotification } from '../../services/notifications.service.js';

export async function claimRoutes(app: FastifyInstance): Promise<void> {
  // Offer to donate (on help_request) or Request an item (on donation_offer)
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

      const { data: post } = await supabaseAdmin
        .from('posts')
        .select('id, author_id, post_type, donation_type, status, title')
        .eq('id', postId)
        .single();

      if (!post) throw new AppError(404, 'NOT_FOUND', 'Post not found');
      if (post.author_id === userId) {
        throw new AppError(400, 'BAD_REQUEST', 'You cannot claim or offer on your own post');
      }
      if (post.status !== 'active') {
        throw new AppError(400, 'BAD_REQUEST', 'This post is no longer accepting offers or requests');
      }

      const claimType = post.post_type === 'help_request' ? 'offer_to_donate' : 'request_item';

      const { data: claim, error } = await supabaseAdmin
        .from('claims')
        .insert({
          post_id: postId,
          claimant_id: userId,
          claim_type: claimType,
          message: body.message ? sanitizeText(body.message) : null,
          quantity_offered: body.quantity_offered ?? null,
          status: 'pending',
        })
        .select()
        .single();

      if (error) {
        if (error.code === '23505') {
          throw new AppError(409, 'CONFLICT', 'You already have an active offer or request on this post');
        }
        throw new AppError(500, 'INTERNAL_ERROR', 'Failed to create claim');
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

  // List my claims & received offers
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

      const [{ data: outgoing }, { data: myPosts }] = await Promise.all([
        supabaseAdmin
          .from('claims')
          .select(
            `
            *,
            post:posts(id, title, post_type, donation_type, status, location_city, author_id,
              author:profiles!posts_author_id_fkey(id, full_name))
          `
          )
          .eq('claimant_id', userId)
          .order('created_at', { ascending: false }),
        supabaseAdmin.from('posts').select('id').eq('author_id', userId),
      ]);

      const postIds = (myPosts ?? []).map((p) => p.id);
      let incoming: unknown[] = [];

      if (postIds.length > 0) {
        const { data: inc } = await supabaseAdmin
          .from('claims')
          .select(
            `
            *,
            claimant:profiles!claims_claimant_id_fkey(id, full_name, location_city),
            post:posts(id, title, post_type, donation_type, status)
          `
          )
          .in('post_id', postIds)
          .order('created_at', { ascending: false });
        incoming = inc ?? [];
      }

      return { outgoing: outgoing ?? [], incoming };
    }
  );

  // Accept claim (transactional RPC with row locking)
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

      const { data: claim, error } = await supabaseAdmin.rpc('accept_claim_tx', {
        p_claim_id: id,
        p_owner_id: userId,
      });

      if (error) {
        const msg = error.message || '';
        if (msg.includes('CLAIM_NOT_FOUND')) throw new AppError(404, 'NOT_FOUND', 'Claim not found');
        if (msg.includes('FORBIDDEN')) throw new AppError(403, 'FORBIDDEN', 'Only the post owner can accept');
        if (msg.includes('POST_NOT_ACTIVE')) throw new AppError(400, 'BAD_REQUEST', 'Post is not active');
        if (msg.includes('CLAIM_NOT_PENDING')) throw new AppError(409, 'CONFLICT', 'Claim is no longer pending');
        throw new AppError(500, 'INTERNAL_ERROR', 'Failed to accept claim');
      }

      await createNotification({
        userId: claim.claimant_id,
        type: 'offer_accepted',
        title: 'Your offer/request was accepted!',
        body: 'You can now view handover details and coordinate directly.',
        link: `/posts/${claim.post_id}`,
      });

      return { claim };
    }
  );

  // Reject claim
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

      const { data: claim } = await supabaseAdmin
        .from('claims')
        .select('*, post:posts(author_id, title)')
        .eq('id', id)
        .single();

      if (!claim) throw new AppError(404, 'NOT_FOUND', 'Claim not found');
      const post = claim.post as { author_id: string; title: string };
      if (post.author_id !== userId) throw new AppError(403, 'FORBIDDEN', 'Only the post owner can reject');
      if (claim.status !== 'pending') throw new AppError(409, 'CONFLICT', 'Only pending claims can be rejected');

      const { data: updated, error } = await supabaseAdmin
        .from('claims')
        .update({ status: 'rejected' })
        .eq('id', id)
        .select()
        .single();

      if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Failed to reject claim');

      await createNotification({
        userId: claim.claimant_id,
        type: 'offer_rejected',
        title: 'Offer/request update',
        body: `Your response on "${post.title}" was declined.`,
        link: `/posts/${claim.post_id}`,
      });

      return { claim: updated };
    }
  );

  // Cancel own claim
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

      const { data: claim } = await supabaseAdmin.from('claims').select('*').eq('id', id).single();
      if (!claim) throw new AppError(404, 'NOT_FOUND', 'Claim not found');
      if (claim.claimant_id !== userId) throw new AppError(403, 'FORBIDDEN', 'Only the claimant can cancel');
      if (!['pending', 'accepted'].includes(claim.status)) {
        throw new AppError(409, 'CONFLICT', 'This claim cannot be cancelled');
      }

      const { data: updated, error } = await supabaseAdmin
        .from('claims')
        .update({ status: 'cancelled' })
        .eq('id', id)
        .select()
        .single();

      if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Failed to cancel claim');
      return { claim: updated };
    }
  );

  // Confirm direct handover (requires both donor and recipient to confirm completion)
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

      const { data: claim } = await supabaseAdmin
        .from('claims')
        .select('*, post:posts(id, author_id, post_type, title)')
        .eq('id', id)
        .single();

      if (!claim) throw new AppError(404, 'NOT_FOUND', 'Claim not found');
      if (claim.status !== 'accepted') {
        throw new AppError(409, 'CONFLICT', 'Handover can only be confirmed for accepted claims');
      }

      const post = claim.post as { id: string; author_id: string; post_type: string; title: string };
      const isOwner = post.author_id === userId;
      const isClaimant = claim.claimant_id === userId;

      if (!isOwner && !isClaimant) {
        throw new AppError(403, 'FORBIDDEN', 'You are not a participant in this claim');
      }

      const isUserDonor =
        (post.post_type === 'donation_offer' && isOwner) ||
        (post.post_type === 'help_request' && isClaimant);

      const nextDonorConfirmed = isUserDonor ? true : claim.donor_confirmed_handover;
      const nextRecipientConfirmed = !isUserDonor ? true : claim.recipient_confirmed_handover;
      const bothConfirmed = nextDonorConfirmed && nextRecipientConfirmed;

      const { data: updated, error } = await supabaseAdmin
        .from('claims')
        .update({
          donor_confirmed_handover: nextDonorConfirmed,
          recipient_confirmed_handover: nextRecipientConfirmed,
          status: bothConfirmed ? 'completed' : 'accepted',
          confirmed_at: bothConfirmed ? new Date().toISOString() : null,
        })
        .eq('id', id)
        .select()
        .single();

      if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Failed to confirm handover');

      const otherUserId = isOwner ? claim.claimant_id : post.author_id;
      await createNotification({
        userId: otherUserId,
        type: 'contribution_confirmed',
        title: bothConfirmed ? 'Handover completed!' : 'Handover confirmation pending',
        body: bothConfirmed
          ? `Both parties confirmed the handover for "${post.title}".`
          : `The other party confirmed handover for "${post.title}". Please confirm when ready.`,
        link: `/posts/${post.id}`,
      });

      return { claim: updated };
    }
  );
}
