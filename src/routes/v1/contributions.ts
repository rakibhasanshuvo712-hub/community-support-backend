import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/errors.js';
import { getDb } from '../../lib/firebase.js';
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

      const db = getDb();
      const postSnap = await db.collection('posts').doc(postId).get();
      if (!postSnap.exists) throw new AppError(404, 'NOT_FOUND', 'Post not found');

      const post = postSnap.data()!;
      if (post.author_id === userId) {
        throw new AppError(400, 'BAD_REQUEST', 'You cannot pledge to your own post');
      }
      if (post.donation_type !== 'money') {
        throw new AppError(400, 'BAD_REQUEST', 'Monetary pledges are only supported on monetary posts');
      }
      if (post.status !== 'active') {
        throw new AppError(400, 'BAD_REQUEST', 'This post is no longer accepting pledges');
      }

      const now = new Date().toISOString();
      const ref = db.collection('contributions').doc();
      const contribDoc = {
        id: ref.id,
        post_id: postId,
        post_author_id: post.author_id,
        contributor_id: userId,
        amount: body.amount,
        currency: body.currency.toUpperCase(),
        note: body.note ? sanitizeText(body.note) : null,
        status: 'pledged',
        donor_confirmed: false,
        recipient_confirmed: false,
        confirmed_at: null,
        created_at: now,
        updated_at: now,
      };
      await ref.set(contribDoc);

      await createNotification({
        userId: String(post.author_id),
        type: 'new_offer',
        title: 'New monetary pledge',
        body: `${request.authUser!.full_name} pledged ${body.amount} ${body.currency.toUpperCase()} for "${post.title}". Coordinate direct transfer and confirm once received.`,
        link: `/posts/${postId}`,
      });

      return reply.status(201).send({ contribution: contribDoc });
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
      const db = getDb();

      const [outgoingSnap, incomingSnap] = await Promise.all([
        db.collection('contributions').where('contributor_id', '==', userId).orderBy('created_at', 'desc').get(),
        db.collection('contributions').where('post_author_id', '==', userId).orderBy('created_at', 'desc').get(),
      ]);

      const hydrate = async (docs: FirebaseFirestore.QueryDocumentSnapshot[]) =>
        Promise.all(
          docs.map(async (d) => {
            const c = d.data();
            const [postSnap, contribSnap] = await Promise.all([
              db.collection('posts').doc(String(c.post_id)).get(),
              db.collection('profiles').doc(String(c.contributor_id)).get(),
            ]);
            return {
              id: d.id,
              ...c,
              post: postSnap.exists ? { id: postSnap.id, ...postSnap.data() } : null,
              contributor: contribSnap.exists
                ? { id: contribSnap.id, full_name: contribSnap.data()?.full_name }
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
      const db = getDb();
      const ref = db.collection('contributions').doc(id);
      const snap = await ref.get();

      if (!snap.exists) throw new AppError(404, 'NOT_FOUND', 'Contribution not found');
      const contrib = snap.data()!;
      if (contrib.status !== 'pledged') {
        throw new AppError(409, 'CONFLICT', 'Only pledged contributions can be confirmed');
      }

      const postSnap = await db.collection('posts').doc(String(contrib.post_id)).get();
      const post = postSnap.data()!;
      const isContributor = contrib.contributor_id === userId;
      const isPostOwner = post.author_id === userId;

      if (!isContributor && !isPostOwner) {
        throw new AppError(403, 'FORBIDDEN', 'You are not a participant in this contribution');
      }

      const isUserDonor =
        (post.post_type === 'help_request' && isContributor) ||
        (post.post_type === 'donation_offer' && isPostOwner);

      const nextDonorConfirmed = isUserDonor ? true : Boolean(contrib.donor_confirmed);
      const nextRecipientConfirmed = !isUserDonor ? true : Boolean(contrib.recipient_confirmed);
      const bothConfirmed = nextDonorConfirmed && nextRecipientConfirmed;
      const now = new Date().toISOString();

      const updates = {
        donor_confirmed: nextDonorConfirmed,
        recipient_confirmed: nextRecipientConfirmed,
        status: bothConfirmed ? 'confirmed' : 'pledged',
        confirmed_at: bothConfirmed ? now : null,
        updated_at: now,
      };
      await ref.update(updates);

      const otherUserId = isContributor ? String(post.author_id) : String(contrib.contributor_id);
      await createNotification({
        userId: otherUserId,
        type: 'contribution_confirmed',
        title: bothConfirmed ? 'Direct transfer confirmed' : 'Transfer confirmation pending',
        body: bothConfirmed
          ? `Both parties confirmed the direct transfer for "${post.title}".`
          : `The other party marked the direct transfer as complete for "${post.title}". Please confirm once verified.`,
        link: `/posts/${contrib.post_id}`,
      });

      return { contribution: { id, ...contrib, ...updates } };
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
      const db = getDb();
      const ref = db.collection('contributions').doc(id);
      const snap = await ref.get();

      if (!snap.exists) throw new AppError(404, 'NOT_FOUND', 'Contribution not found');
      const contrib = snap.data()!;
      if (contrib.contributor_id !== userId && contrib.post_author_id !== userId) {
        throw new AppError(403, 'FORBIDDEN', 'Not authorized to cancel this pledge');
      }
      if (contrib.status !== 'pledged') {
        throw new AppError(409, 'CONFLICT', 'Only pledged contributions can be cancelled');
      }

      const now = new Date().toISOString();
      await ref.update({ status: 'cancelled', updated_at: now });
      return { contribution: { id, ...contrib, status: 'cancelled', updated_at: now } };
    }
  );
}
