import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/errors.js';
import { assertNoSensitiveFinancialData, sanitizeText } from '../../lib/security.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import { authenticate } from '../../middleware/auth.js';
import { createContributionSchema } from '../../schemas/interactions.schema.js';
import { createNotification } from '../../services/notifications.service.js';

export async function contributionRoutes(app: FastifyInstance): Promise<void> {
  // Make a monetary pledge (platform NEVER holds or collects money)
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

      const { data: post } = await supabaseAdmin
        .from('posts')
        .select('id, author_id, donation_type, status, title')
        .eq('id', postId)
        .single();

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

      const { data: contribution, error } = await supabaseAdmin
        .from('contributions')
        .insert({
          post_id: postId,
          contributor_id: userId,
          amount: body.amount,
          currency: body.currency.toUpperCase(),
          note: body.note ? sanitizeText(body.note) : null,
          status: 'pledged',
          donor_confirmed: false,
          recipient_confirmed: false,
        })
        .select()
        .single();

      if (error || !contribution) {
        throw new AppError(500, 'INTERNAL_ERROR', 'Failed to record pledge');
      }

      await createNotification({
        userId: post.author_id,
        type: 'new_offer',
        title: 'New monetary pledge',
        body: `${request.authUser!.full_name} pledged ${body.amount} ${body.currency.toUpperCase()} for "${post.title}". Coordinate direct transfer and confirm once received.`,
        link: `/posts/${postId}`,
      });

      return reply.status(201).send({ contribution });
    }
  );

  // List my contributions (made and received)
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

      const [{ data: outgoing }, { data: myPosts }] = await Promise.all([
        supabaseAdmin
          .from('contributions')
          .select(
            `
            *,
            post:posts(id, title, currency, status, author_id,
              author:profiles!posts_author_id_fkey(id, full_name))
          `
          )
          .eq('contributor_id', userId)
          .order('created_at', { ascending: false }),
        supabaseAdmin.from('posts').select('id').eq('author_id', userId),
      ]);

      const postIds = (myPosts ?? []).map((p) => p.id);
      let incoming: unknown[] = [];

      if (postIds.length > 0) {
        const { data: inc } = await supabaseAdmin
          .from('contributions')
          .select(
            `
            *,
            contributor:profiles!contributions_contributor_id_fkey(id, full_name),
            post:posts(id, title, currency, status)
          `
          )
          .in('post_id', postIds)
          .order('created_at', { ascending: false });
        incoming = inc ?? [];
      }

      return { outgoing: outgoing ?? [], incoming };
    }
  );

  // Confirm direct transfer (status becomes 'confirmed' ONLY when BOTH donor and recipient confirm)
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

      const { data: contrib } = await supabaseAdmin
        .from('contributions')
        .select('*, post:posts(id, author_id, post_type, title)')
        .eq('id', id)
        .single();

      if (!contrib) throw new AppError(404, 'NOT_FOUND', 'Contribution not found');
      if (contrib.status !== 'pledged') {
        throw new AppError(409, 'CONFLICT', 'Only pledged contributions can be confirmed');
      }

      const post = contrib.post as { id: string; author_id: string; post_type: string; title: string };
      const isContributor = contrib.contributor_id === userId;
      const isPostOwner = post.author_id === userId;

      if (!isContributor && !isPostOwner) {
        throw new AppError(403, 'FORBIDDEN', 'You are not a participant in this contribution');
      }

      const isUserDonor =
        (post.post_type === 'help_request' && isContributor) ||
        (post.post_type === 'donation_offer' && isPostOwner);

      const nextDonorConfirmed = isUserDonor ? true : contrib.donor_confirmed;
      const nextRecipientConfirmed = !isUserDonor ? true : contrib.recipient_confirmed;
      const bothConfirmed = nextDonorConfirmed && nextRecipientConfirmed;

      const { data: updated, error } = await supabaseAdmin
        .from('contributions')
        .update({
          donor_confirmed: nextDonorConfirmed,
          recipient_confirmed: nextRecipientConfirmed,
          status: bothConfirmed ? 'confirmed' : 'pledged',
          confirmed_at: bothConfirmed ? new Date().toISOString() : null,
        })
        .eq('id', id)
        .select()
        .single();

      if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Failed to confirm contribution');

      const otherUserId = isContributor ? post.author_id : contrib.contributor_id;
      await createNotification({
        userId: otherUserId,
        type: 'contribution_confirmed',
        title: bothConfirmed ? 'Direct transfer confirmed' : 'Transfer confirmation pending',
        body: bothConfirmed
          ? `Both parties confirmed the direct transfer for "${post.title}".`
          : `The other party marked the direct transfer as complete for "${post.title}". Please confirm once verified.`,
        link: `/posts/${post.id}`,
      });

      return { contribution: updated };
    }
  );

  // Cancel pledge
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

      const { data: contrib } = await supabaseAdmin
        .from('contributions')
        .select('*, post:posts(author_id)')
        .eq('id', id)
        .single();

      if (!contrib) throw new AppError(404, 'NOT_FOUND', 'Contribution not found');
      const post = contrib.post as { author_id: string };
      if (contrib.contributor_id !== userId && post.author_id !== userId) {
        throw new AppError(403, 'FORBIDDEN', 'Not authorized to cancel this pledge');
      }
      if (contrib.status !== 'pledged') {
        throw new AppError(409, 'CONFLICT', 'Only pledged contributions can be cancelled');
      }

      const { data: updated, error } = await supabaseAdmin
        .from('contributions')
        .update({ status: 'cancelled' })
        .eq('id', id)
        .select()
        .single();

      if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Failed to cancel pledge');
      return { contribution: updated };
    }
  );
}
