import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/errors.js';
import { getDb } from '../../lib/firebase.js';
import { assertNoSensitiveFinancialData, sanitizeText } from '../../lib/security.js';
import { authenticate } from '../../middleware/auth.js';
import { createConversationSchema, sendMessageSchema } from '../../schemas/interactions.schema.js';
import { createNotification } from '../../services/notifications.service.js';

async function assertParticipant(conversationId: string, userId: string): Promise<FirebaseFirestore.DocumentData> {
  const db = getDb();
  const convSnap = await db.collection('conversations').doc(conversationId).get();
  if (!convSnap.exists) {
    throw new AppError(404, 'NOT_FOUND', 'Conversation not found');
  }
  const data = convSnap.data()!;
  const participants = (data.participant_ids as string[]) ?? [];
  if (!participants.includes(userId)) {
    throw new AppError(403, 'FORBIDDEN', 'You are not a participant in this conversation');
  }
  return data;
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
      const db = getDb();

      const snap = await db
        .collection('conversations')
        .where('participant_ids', 'array-contains', userId)
        .orderBy('updated_at', 'desc')
        .get();

      const conversations = await Promise.all(
        snap.docs.map(async (doc) => {
          const conv = doc.data();
          const participantIds = (conv.participant_ids as string[]) ?? [];

          const [participants, postSnap, lastMsgSnap, unreadSnap] = await Promise.all([
            Promise.all(
              participantIds.map(async (uid) => {
                const pSnap = await db.collection('profiles').doc(uid).get();
                return {
                  user_id: uid,
                  profile: {
                    id: uid,
                    full_name: pSnap.exists ? pSnap.data()?.full_name : 'User',
                    avatar_url: pSnap.exists ? pSnap.data()?.avatar_url ?? null : null,
                  },
                };
              })
            ),
            conv.post_id ? db.collection('posts').doc(String(conv.post_id)).get() : Promise.resolve(null),
            db
              .collection('conversations')
              .doc(doc.id)
              .collection('messages')
              .orderBy('created_at', 'desc')
              .limit(1)
              .get(),
            db
              .collection('conversations')
              .doc(doc.id)
              .collection('messages')
              .where('is_read', '==', false)
              .get(),
          ]);

          const lastMessage = lastMsgSnap.empty
            ? null
            : { id: lastMsgSnap.docs[0]!.id, ...lastMsgSnap.docs[0]!.data() };

          const unreadCount = unreadSnap.docs.filter((m) => m.data().sender_id !== userId).length;

          return {
            id: doc.id,
            post_id: conv.post_id ?? null,
            created_at: conv.created_at,
            updated_at: conv.updated_at,
            post: postSnap && postSnap.exists
              ? {
                  id: postSnap.id,
                  title: postSnap.data()?.title,
                  post_type: postSnap.data()?.post_type,
                  status: postSnap.data()?.status,
                }
              : null,
            participants,
            last_message: lastMessage,
            unread_count: unreadCount,
          };
        })
      );

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

      const db = getDb();
      const recipientSnap = await db.collection('profiles').doc(body.recipient_id).get();
      if (!recipientSnap.exists || recipientSnap.data()?.is_suspended) {
        throw new AppError(404, 'NOT_FOUND', 'Recipient not found');
      }

      const existingSnap = await db
        .collection('conversations')
        .where('participant_ids', 'array-contains', userId)
        .get();

      const existingDoc = existingSnap.docs.find((d) => {
        const data = d.data();
        const pids = (data.participant_ids as string[]) ?? [];
        const hasRecipient = pids.includes(body.recipient_id);
        return hasRecipient && (body.post_id ? data.post_id === body.post_id : true);
      });

      const now = new Date().toISOString();
      let conversationId = existingDoc?.id ?? null;

      if (!conversationId) {
        const convRef = db.collection('conversations').doc();
        conversationId = convRef.id;
        await convRef.set({
          id: conversationId,
          post_id: body.post_id ?? null,
          participant_ids: [userId, body.recipient_id],
          created_at: now,
          updated_at: now,
        });
      }

      if (body.initial_message) {
        await db.collection('conversations').doc(conversationId).collection('messages').add({
          conversation_id: conversationId,
          sender_id: userId,
          content: sanitizeText(body.initial_message),
          is_read: false,
          created_at: now,
        });

        await db.collection('conversations').doc(conversationId).update({ updated_at: now });

        await createNotification({
          userId: body.recipient_id,
          type: 'new_message',
          title: 'New message',
          body: `${request.authUser!.full_name} sent you a message.`,
          link: `/messages?conversation=${conversationId}`,
        });
      }

      return reply.status(existingDoc ? 200 : 201).send({ conversation_id: conversationId });
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

      const db = getDb();
      const snap = await db
        .collection('conversations')
        .doc(id)
        .collection('messages')
        .orderBy('created_at', 'asc')
        .get();

      const batch = db.batch();
      let hasUnread = false;
      const messages = snap.docs.map((d) => {
        const m = d.data();
        if (m.sender_id !== userId && m.is_read === false) {
          batch.update(d.ref, { is_read: true });
          hasUnread = true;
        }
        return { id: d.id, ...m };
      });

      if (hasUnread) await batch.commit();
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
      const conv = await assertParticipant(id, userId);

      const body = sendMessageSchema.parse(request.body);
      assertNoSensitiveFinancialData(body.content);

      const db = getDb();
      const now = new Date().toISOString();
      const msgRef = db.collection('conversations').doc(id).collection('messages').doc();
      const message = {
        id: msgRef.id,
        conversation_id: id,
        sender_id: userId,
        content: sanitizeText(body.content),
        is_read: false,
        created_at: now,
      };
      await msgRef.set(message);
      await db.collection('conversations').doc(id).update({ updated_at: now });

      const others = ((conv.participant_ids as string[]) ?? []).filter((pid) => pid !== userId);
      for (const otherId of others) {
        await createNotification({
          userId: otherId,
          type: 'new_message',
          title: 'New message',
          body: `${request.authUser!.full_name} sent you a message.`,
          link: `/messages?conversation=${id}`,
        });
      }

      return reply.status(201).send({ message });
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

      const db = getDb();
      const snap = await db
        .collection('conversations')
        .doc(id)
        .collection('messages')
        .where('is_read', '==', false)
        .get();

      const batch = db.batch();
      let updated = false;
      for (const d of snap.docs) {
        if (d.data().sender_id !== userId) {
          batch.update(d.ref, { is_read: true });
          updated = true;
        }
      }
      if (updated) await batch.commit();

      return { success: true };
    }
  );
}
