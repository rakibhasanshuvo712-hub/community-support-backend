import type { FastifyInstance } from 'fastify';
import { getDb, newId } from '../../lib/mongo.js';
import { AppError } from '../../lib/errors.js';
import { assertNoSensitiveFinancialData, sanitizeText } from '../../lib/security.js';
import { authenticate } from '../../middleware/auth.js';
import { createConversationSchema, sendMessageSchema } from '../../schemas/interactions.schema.js';
import { createNotification } from '../../services/notifications.service.js';

async function assertParticipant(conversationId: string, userId: string): Promise<void> {
  const db = await getDb();
  const row = await db.collection('conversation_participants').findOne(
    { conversation_id: conversationId, user_id: userId },
    { projection: { _id: 1 } }
  );
  if (!row) {
    throw new AppError(403, 'FORBIDDEN', 'You are not a participant in this conversation');
  }
}

export async function conversationRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Conversations'],
        summary: 'List conversations for the authenticated user',
      },
    },
    async (request) => {
      const userId = request.authUser!.id;
      const db = await getDb();

      const myParts = await db
        .collection('conversation_participants')
        .find({ user_id: userId }, { projection: { _id: 0, conversation_id: 1 } })
        .toArray();
      const convIds = myParts.map((p) => String(p.conversation_id));
      if (convIds.length === 0) return { conversations: [] };

      const convs = await db
        .collection('conversations')
        .find({ id: { $in: convIds } }, { projection: { _id: 0 } })
        .sort({ updated_at: -1 })
        .toArray();

      const postIds = [...new Set(convs.map((c) => c.post_id).filter(Boolean).map(String))];
      const [allParts, posts, allMessages] = await Promise.all([
        db.collection('conversation_participants').find({ conversation_id: { $in: convIds } }, { projection: { _id: 0 } }).toArray(),
        postIds.length
          ? db.collection('posts').find({ id: { $in: postIds } }, { projection: { _id: 0, id: 1, title: 1, post_type: 1, status: 1 } }).toArray()
          : Promise.resolve([]),
        db.collection('messages').find({ conversation_id: { $in: convIds } }, { projection: { _id: 0 } }).sort({ created_at: -1 }).toArray(),
      ]);

      const partUserIds = [...new Set(allParts.map((p) => String(p.user_id)))];
      const profiles = partUserIds.length
        ? await db.collection('profiles').find({ id: { $in: partUserIds } }, { projection: { _id: 0, id: 1, full_name: 1 } }).toArray()
        : [];
      const profileMap = new Map(profiles.map((p) => [String(p.id), p]));
      const postMap = new Map(posts.map((p) => [String(p.id), p]));

      const conversations = convs.map((c) => {
        const parts = allParts
          .filter((p) => p.conversation_id === c.id)
          .map((p) => {
            const pr = profileMap.get(String(p.user_id));
            return {
              user_id: p.user_id,
              profile: pr ? { id: pr.id, full_name: pr.full_name } : null,
            };
          });
        const msgs = allMessages.filter((m) => m.conversation_id === c.id);
        const lastMsg = msgs[0] ?? null;
        const unreadCount = msgs.filter((m) => m.sender_id !== userId && !m.is_read).length;

        return {
          id: c.id,
          post_id: c.post_id ?? null,
          created_at: c.created_at,
          updated_at: c.updated_at,
          post: c.post_id ? postMap.get(String(c.post_id)) ?? null : null,
          participants: parts,
          last_message: lastMsg
            ? {
                id: lastMsg.id,
                sender_id: lastMsg.sender_id,
                content: lastMsg.content,
                created_at: lastMsg.created_at,
                is_read: lastMsg.is_read,
              }
            : null,
          unread_count: unreadCount,
        };
      });

      return { conversations };
    }
  );

  app.post(
    '/',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Conversations'],
        summary: 'Start or retrieve a direct conversation with another user',
      },
    },
    async (request, reply) => {
      const userId = request.authUser!.id;
      const body = createConversationSchema.parse(request.body);
      if (body.recipient_id === userId) {
        throw new AppError(400, 'BAD_REQUEST', 'Cannot start a conversation with yourself');
      }
      assertNoSensitiveFinancialData(body.initial_message);

      const db = await getDb();
      const recipient = await db.collection('profiles').findOne(
        { id: body.recipient_id },
        { projection: { _id: 0, id: 1, is_suspended: 1 } }
      );
      if (!recipient || recipient.is_suspended) {
        throw new AppError(404, 'NOT_FOUND', 'Recipient not found');
      }

      const myParts = await db
        .collection('conversation_participants')
        .find({ user_id: userId }, { projection: { _id: 0, conversation_id: 1 } })
        .toArray();
      const myConvIds = myParts.map((p) => String(p.conversation_id));

      let existingConvId: string | null = null;
      if (myConvIds.length > 0) {
        const sharedParts = await db
          .collection('conversation_participants')
          .find({ conversation_id: { $in: myConvIds }, user_id: body.recipient_id }, { projection: { _id: 0, conversation_id: 1 } })
          .toArray();
        const sharedIds = sharedParts.map((p) => String(p.conversation_id));
        if (sharedIds.length > 0) {
          const convFilter: Record<string, unknown> = { id: { $in: sharedIds } };
          if (body.post_id) convFilter.post_id = body.post_id;
          const found = await db.collection('conversations').findOne(convFilter, { projection: { _id: 0, id: 1 } });
          if (found) existingConvId = String(found.id);
        }
      }

      const now = new Date().toISOString();
      let conversationId = existingConvId;
      if (!conversationId) {
        conversationId = newId();
        await db.collection('conversations').insertOne({
          id: conversationId,
          post_id: body.post_id ?? null,
          created_at: now,
          updated_at: now,
        });
        await db.collection('conversation_participants').insertMany([
          { conversation_id: conversationId, user_id: userId, last_read_at: now },
          { conversation_id: conversationId, user_id: body.recipient_id, last_read_at: null },
        ]);
      }

      if (body.initial_message) {
        await db.collection('messages').insertOne({
          id: newId(),
          conversation_id: conversationId,
          sender_id: userId,
          content: sanitizeText(body.initial_message),
          is_read: false,
          created_at: now,
        });
        await db.collection('conversations').updateOne({ id: conversationId }, { $set: { updated_at: now } });
        await createNotification({
          userId: body.recipient_id,
          type: 'new_message',
          title: 'New message',
          body: `${request.authUser!.full_name} sent you a message.`,
          link: `/messages?conversation=${conversationId}`,
        });
      }

      return reply.status(existingConvId ? 200 : 201).send({ conversation_id: conversationId });
    }
  );

  app.get<{ Params: { id: string } }>(
    '/:id/messages',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Conversations'],
        summary: 'Get messages in a conversation (participants only)',
      },
    },
    async (request) => {
      const { id } = request.params;
      const userId = request.authUser!.id;
      await assertParticipant(id, userId);

      const db = await getDb();
      const messages = await db
        .collection('messages')
        .find({ conversation_id: id }, { projection: { _id: 0, id: 1, conversation_id: 1, sender_id: 1, content: 1, is_read: 1, created_at: 1 } })
        .sort({ created_at: 1 })
        .toArray();

      await db.collection('messages').updateMany(
        { conversation_id: id, sender_id: { $ne: userId }, is_read: false },
        { $set: { is_read: true } }
      );
      return { messages };
    }
  );

  app.post<{ Params: { id: string } }>(
    '/:id/messages',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Conversations'],
        summary: 'Send a message in a conversation (participants only)',
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const userId = request.authUser!.id;
      await assertParticipant(id, userId);

      const body = sendMessageSchema.parse(request.body);
      assertNoSensitiveFinancialData(body.content);

      const db = await getDb();
      const now = new Date().toISOString();
      const msg = {
        id: newId(),
        conversation_id: id,
        sender_id: userId,
        content: sanitizeText(body.content),
        is_read: false,
        created_at: now,
      };
      await db.collection('messages').insertOne({ ...msg });
      await db.collection('conversations').updateOne({ id }, { $set: { updated_at: now } });

      const others = await db
        .collection('conversation_participants')
        .find({ conversation_id: id, user_id: { $ne: userId } }, { projection: { _id: 0, user_id: 1 } })
        .toArray();
      for (const p of others) {
        await createNotification({
          userId: String(p.user_id),
          type: 'new_message',
          title: 'New message',
          body: `${request.authUser!.full_name} sent you a message.`,
          link: `/messages?conversation=${id}`,
        });
      }

      return reply.status(201).send({ message: msg });
    }
  );

  app.patch<{ Params: { id: string } }>(
    '/:id/read',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Conversations'],
        summary: 'Mark all incoming messages in a conversation as read',
      },
    },
    async (request) => {
      const { id } = request.params;
      const userId = request.authUser!.id;
      await assertParticipant(id, userId);

      const db = await getDb();
      await db.collection('messages').updateMany(
        { conversation_id: id, sender_id: { $ne: userId }, is_read: false },
        { $set: { is_read: true } }
      );
      return { success: true };
    }
  );
}
