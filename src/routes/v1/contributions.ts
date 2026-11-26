import type { FastifyInstance } from 'fastify';
import { getDb, newId } from '../../lib/mongo.js';
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

      const db = await getDb();
      const post = await db.collection('posts').findOne(
        { id: postId },
        { projection: { _id: 0, id: 1, author_id: 1, donation_type: 1, status: 1, title: 1 } }
      );
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

      const now = new Date().toISOString();
      const doc = {
        id: newId(),
        post_id: postId,
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
      await db.collection('contributions').insertOne({ ...doc });

      await createNotification({
        userId: String(post.author_id),
        type: 'new_offer',
        title: 'New monetary pledge',
        body: `${request.authUser!.full_name} pledged ${body.amount} ${body.currency.toUpperCase()} for "${post.title}". Coordinate direct transfer and confirm once received.`,
        link: `/posts/${postId}`,
      });

      return reply.status(201).send({ contribution: doc });
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
      const db = await getDb();

      const myPosts = await db
        .collection('posts')
        .find({ author_id: userId }, { projection: { _id: 0, id: 1, title: 1, currency: 1, status: 1, author_id: 1 } })
        .toArray();
      const myPostIds = myPosts.map((p) => String(p.id));

      const [outDocs, inDocs] = await Promise.all([
        db.collection('contributions').find({ contributor_id: userId }, { projection: { _id: 0 } }).sort({ created_at: -1 }).toArray(),
        myPostIds.length > 0
          ? db.collection('contributions').find({ post_id: { $in: myPostIds } }, { projection: { _id: 0 } }).sort({ created_at: -1 }).toArray()
          : Promise.resolve([]),
      ]);

      const outPostIds = [...new Set(outDocs.map((c) => String(c.post_id)))];
      const outPosts = outPostIds.length
        ? await db.collection('posts').find({ id: { $in: outPostIds } }, { projection: { _id: 0, id: 1, title: 1, currency: 1, status: 1, author_id: 1 } }).toArray()
        : [];
      const outPostMap = new Map(outPosts.map((p) => [String(p.id), p]));

      const userIds = [
        ...new Set([
          ...outPosts.map((p) => String(p.author_id)),
          ...inDocs.map((c) => String(c.contributor_id)),
        ]),
      ];
      const profiles = userIds.length
        ? await db.collection('profiles').find({ id: { $in: userIds } }, { projection: { _id: 0, id: 1, full_name: 1 } }).toArray()
        : [];
      const profileMap = new Map(profiles.map((p) => [String(p.id), p]));
      const myPostMap = new Map(myPosts.map((p) => [String(p.id), p]));

      const outgoing = outDocs.map((c) => {
        const p = outPostMap.get(String(c.post_id));
        const au = p ? profileMap.get(String(p.author_id)) : undefined;
        return {
          ...c,
          post: p
            ? {
                id: p.id,
                title: p.title,
                currency: p.currency,
                status: p.status,
                author_id: p.author_id,
                author: au ? { id: au.id, full_name: au.full_name } : null,
              }
            : null,
        };
      });

      const incoming = inDocs.map((c) => {
        const p = myPostMap.get(String(c.post_id));
        const co = profileMap.get(String(c.contributor_id));
        return {
          ...c,
          contributor: co ? { id: co.id, full_name: co.full_name } : null,
          post: p
            ? {
                id: p.id,
                title: p.title,
                currency: p.currency,
                status: p.status,
              }
            : null,
        };
      });

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
      const db = await getDb();

      const contrib = await db.collection('contributions').findOne({ id }, { projection: { _id: 0 } });
      if (!contrib) throw new AppError(404, 'NOT_FOUND', 'Contribution not found');
      if (contrib.status !== 'pledged') {
        throw new AppError(409, 'CONFLICT', 'Only pledged contributions can be confirmed');
      }

      const post = await db.collection('posts').findOne(
        { id: contrib.post_id },
        { projection: { _id: 0, author_id: 1, post_type: 1, title: 1 } }
      );
      if (!post) throw new AppError(404, 'NOT_FOUND', 'Post not found');

      const isContributor = contrib.contributor_id === userId;
      const isPostOwner = post.author_id === userId;
      if (!isContributor && !isPostOwner) {
        throw new AppError(403, 'FORBIDDEN', 'You are not a participant in this contribution');
      }

      const isUserDonor =
        (post.post_type === 'help_request' && isContributor) ||
        (post.post_type === 'donation_offer' && isPostOwner);

      const nextDonor = isUserDonor ? true : Boolean(contrib.donor_confirmed);
      const nextRecipient = !isUserDonor ? true : Boolean(contrib.recipient_confirmed);
      const both = nextDonor && nextRecipient;
      const now = new Date().toISOString();

      const updated = await db.collection('contributions').findOneAndUpdate(
        { id },
        {
          $set: {
            donor_confirmed: nextDonor,
            recipient_confirmed: nextRecipient,
            status: both ? 'confirmed' : 'pledged',
            confirmed_at: both ? now : null,
            updated_at: now,
          },
        },
        { returnDocument: 'after', projection: { _id: 0 } }
      );

      const otherUserId = isContributor ? String(post.author_id) : String(contrib.contributor_id);
      await createNotification({
        userId: otherUserId,
        type: 'contribution_confirmed',
        title: both ? 'Direct transfer confirmed' : 'Transfer confirmation pending',
        body: both
          ? `Both parties confirmed the direct transfer for "${post.title}".`
          : `The other party marked the direct transfer as complete for "${post.title}". Please confirm once verified.`,
        link: `/posts/${contrib.post_id}`,
      });

      return { contribution: updated };
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
      const db = await getDb();

      const contrib = await db.collection('contributions').findOne({ id }, { projection: { _id: 0 } });
      if (!contrib) throw new AppError(404, 'NOT_FOUND', 'Contribution not found');

      const post = await db.collection('posts').findOne(
        { id: contrib.post_id },
        { projection: { _id: 0, author_id: 1 } }
      );
      if (contrib.contributor_id !== userId && post?.author_id !== userId) {
        throw new AppError(403, 'FORBIDDEN', 'Not authorized to cancel this pledge');
      }
      if (contrib.status !== 'pledged') {
        throw new AppError(409, 'CONFLICT', 'Only pledged contributions can be cancelled');
      }

      const updated = await db.collection('contributions').findOneAndUpdate(
        { id },
        { $set: { status: 'cancelled', updated_at: new Date().toISOString() } },
        { returnDocument: 'after', projection: { _id: 0 } }
      );
      return { contribution: updated };
    }
  );
}
