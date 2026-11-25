import type { FastifyInstance } from 'fastify';
import { dbQuery } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';
import { assertNoSensitiveFinancialData, sanitizeText } from '../../lib/security.js';
import { authenticate } from '../../middleware/auth.js';
import { createConversationSchema, sendMessageSchema } from '../../schemas/interactions.schema.js';
import { createNotification } from '../../services/notifications.service.js';

async function assertParticipant(conversationId: string, userId: string): Promise<void> {
  const res = await dbQuery(
    'SELECT conversation_id FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
    [conversationId, userId]
  );
  if (res.rows.length === 0) {
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
      const res = await dbQuery(
        `SELECT c.id, c.post_id, c.created_at, c.updated_at,
                CASE WHEN p.id IS NOT NULL THEN json_build_object('id', p.id, 'title', p.title, 'post_type', p.post_type, 'status', p.status) ELSE NULL END AS post,
                (SELECT json_agg(json_build_object('user_id', cp2.user_id, 'profile', json_build_object('id', pr.id, 'full_name', pr.full_name)))
                 FROM conversation_participants cp2
                 JOIN profiles pr ON pr.id = cp2.user_id
                 WHERE cp2.conversation_id = c.id) AS participants,
                (SELECT json_build_object('id', m.id, 'sender_id', m.sender_id, 'content', m.content, 'created_at', m.created_at, 'is_read', m.is_read)
                 FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message,
                (SELECT COUNT(*)::int FROM messages m WHERE m.conversation_id = c.id AND m.sender_id <> $1 AND m.is_read = FALSE) AS unread_count
         FROM conversations c
         JOIN conversation_participants cp ON cp.conversation_id = c.id
         LEFT JOIN posts p ON p.id = c.post_id
         WHERE cp.user_id = $1
         ORDER BY c.updated_at DESC`,
        [userId]
      );

      return { conversations: res.rows };
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

      const recRes = await dbQuery<{ id: string; is_suspended: boolean }>(
        'SELECT id, is_suspended FROM profiles WHERE id = $1',
        [body.recipient_id]
      );
      if (!recRes.rows[0] || recRes.rows[0].is_suspended) {
        throw new AppError(404, 'NOT_FOUND', 'Recipient not found');
      }

      const existingRes = await dbQuery<{ id: string }>(
        `SELECT c.id FROM conversations c
         JOIN conversation_participants cp1 ON cp1.conversation_id = c.id AND cp1.user_id = $1
         JOIN conversation_participants cp2 ON cp2.conversation_id = c.id AND cp2.user_id = $2
         WHERE ($3::uuid IS NULL OR c.post_id = $3::uuid)
         LIMIT 1`,
        [userId, body.recipient_id, body.post_id ?? null]
      );

      let conversationId = existingRes.rows[0]?.id;
      if (!conversationId) {
        const created = await dbQuery<{ id: string }>(
          'INSERT INTO conversations (post_id) VALUES ($1) RETURNING id',
          [body.post_id ?? null]
        );
        conversationId = created.rows[0]!.id;
        await dbQuery(
          `INSERT INTO conversation_participants (conversation_id, user_id, last_read_at)
           VALUES ($1, $2, NOW()), ($1, $3, NULL)`,
          [conversationId, userId, body.recipient_id]
        );
      }

      if (body.initial_message) {
        await dbQuery(
          'INSERT INTO messages (conversation_id, sender_id, content) VALUES ($1, $2, $3)',
          [conversationId, userId, sanitizeText(body.initial_message)]
        );
        await dbQuery('UPDATE conversations SET updated_at = NOW() WHERE id = $1', [conversationId]);
        await createNotification({
          userId: body.recipient_id,
          type: 'new_message',
          title: 'New message',
          body: `${request.authUser!.full_name} sent you a message.`,
          link: `/messages?conversation=${conversationId}`,
        });
      }

      return reply.status(existingRes.rows[0] ? 200 : 201).send({ conversation_id: conversationId });
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

      const res = await dbQuery(
        'SELECT id, conversation_id, sender_id, content, is_read, created_at FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC',
        [id]
      );
      await dbQuery(
        'UPDATE messages SET is_read = TRUE WHERE conversation_id = $1 AND sender_id <> $2 AND is_read = FALSE',
        [id, userId]
      );
      return { messages: res.rows };
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

      const msgRes = await dbQuery(
        'INSERT INTO messages (conversation_id, sender_id, content) VALUES ($1, $2, $3) RETURNING *',
        [id, userId, sanitizeText(body.content)]
      );
      await dbQuery('UPDATE conversations SET updated_at = NOW() WHERE id = $1', [id]);

      const others = await dbQuery<{ user_id: string }>(
        'SELECT user_id FROM conversation_participants WHERE conversation_id = $1 AND user_id <> $2',
        [id, userId]
      );
      for (const p of others.rows) {
        await createNotification({
          userId: p.user_id,
          type: 'new_message',
          title: 'New message',
          body: `${request.authUser!.full_name} sent you a message.`,
          link: `/messages?conversation=${id}`,
        });
      }

      return reply.status(201).send({ message: msgRes.rows[0] });
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

      await dbQuery(
        'UPDATE messages SET is_read = TRUE WHERE conversation_id = $1 AND sender_id <> $2 AND is_read = FALSE',
        [id, userId]
      );
      return { success: true };
    }
  );
}
