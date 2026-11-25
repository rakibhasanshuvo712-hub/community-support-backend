import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/errors.js';
import { assertNoSensitiveFinancialData, sanitizeText } from '../../lib/security.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import { authenticate } from '../../middleware/auth.js';
import { createConversationSchema, sendMessageSchema } from '../../schemas/interactions.schema.js';
import { createNotification } from '../../services/notifications.service.js';

async function assertParticipant(conversationId: string, userId: string): Promise<void> {
  const { data } = await supabaseAdmin
    .from('conversation_participants')
    .select('conversation_id')
    .eq('conversation_id', conversationId)
    .eq('user_id', userId)
    .maybeSingle();

  if (!data) {
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

      const { data: memberships, error } = await supabaseAdmin
        .from('conversation_participants')
        .select('conversation_id, last_read_at')
        .eq('user_id', userId);

      if (error) {
        throw new AppError(500, 'INTERNAL_ERROR', 'Failed to load conversations');
      }

      const convIds = (memberships ?? []).map((m) => m.conversation_id);
      if (convIds.length === 0) {
        return { conversations: [] };
      }

      const { data: conversations } = await supabaseAdmin
        .from('conversations')
        .select(
          `
          id, post_id, created_at, updated_at,
          post:posts(id, title, post_type, status),
          participants:conversation_participants(
            user_id, last_read_at,
            profile:profiles(id, full_name, avatar_url)
          )
        `
        )
        .in('id', convIds)
        .order('updated_at', { ascending: false });

      const enriched = await Promise.all(
        (conversations ?? []).map(async (conv) => {
          const [{ data: lastMsg }, { count: unreadCount }] = await Promise.all([
            supabaseAdmin
              .from('messages')
              .select('id, sender_id, content, created_at, is_read')
              .eq('conversation_id', conv.id)
              .order('created_at', { ascending: false })
              .limit(1)
              .maybeSingle(),
            supabaseAdmin
              .from('messages')
              .select('id', { count: 'exact', head: true })
              .eq('conversation_id', conv.id)
              .neq('sender_id', userId)
              .eq('is_read', false),
          ]);

          return {
            ...conv,
            last_message: lastMsg ?? null,
            unread_count: unreadCount ?? 0,
          };
        })
      );

      return { conversations: enriched };
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

      const { data: recipient } = await supabaseAdmin
        .from('profiles')
        .select('id, is_suspended')
        .eq('id', body.recipient_id)
        .single();

      if (!recipient || recipient.is_suspended) {
        throw new AppError(404, 'NOT_FOUND', 'Recipient not found');
      }

      // Check if conversation already exists between these two users (optionally for same post)
      const { data: myConvs } = await supabaseAdmin
        .from('conversation_participants')
        .select('conversation_id')
        .eq('user_id', userId);

      const myConvIds = (myConvs ?? []).map((c) => c.conversation_id);
      let existingConvId: string | null = null;

      if (myConvIds.length > 0) {
        const { data: shared } = await supabaseAdmin
          .from('conversation_participants')
          .select('conversation_id, conversation:conversations(id, post_id)')
          .eq('user_id', body.recipient_id)
          .in('conversation_id', myConvIds);

        const match = (shared ?? []).find((s) => {
          const conv = s.conversation as unknown as { id: string; post_id: string | null } | null;
          return conv && (body.post_id ? conv.post_id === body.post_id : true);
        });
        if (match) existingConvId = match.conversation_id;
      }

      let conversationId = existingConvId;
      if (!conversationId) {
        const { data: created, error } = await supabaseAdmin
          .from('conversations')
          .insert({ post_id: body.post_id ?? null })
          .select()
          .single();

        if (error || !created) {
          throw new AppError(500, 'INTERNAL_ERROR', 'Failed to create conversation');
        }
        conversationId = created.id;

        await supabaseAdmin.from('conversation_participants').insert([
          { conversation_id: conversationId, user_id: userId, last_read_at: new Date().toISOString() },
          { conversation_id: conversationId, user_id: body.recipient_id },
        ]);
      }

      if (body.initial_message) {
        await supabaseAdmin.from('messages').insert({
          conversation_id: conversationId,
          sender_id: userId,
          content: sanitizeText(body.initial_message),
        });

        await supabaseAdmin
          .from('conversations')
          .update({ updated_at: new Date().toISOString() })
          .eq('id', conversationId);

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

      const { data: messages, error } = await supabaseAdmin
        .from('messages')
        .select('id, conversation_id, sender_id, content, is_read, created_at')
        .eq('conversation_id', id)
        .order('created_at', { ascending: true });

      if (error) {
        throw new AppError(500, 'INTERNAL_ERROR', 'Failed to load messages');
      }

      // Mark incoming messages as read
      await supabaseAdmin
        .from('messages')
        .update({ is_read: true })
        .eq('conversation_id', id)
        .neq('sender_id', userId)
        .eq('is_read', false);

      return { messages: messages ?? [] };
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

      const { data: message, error } = await supabaseAdmin
        .from('messages')
        .insert({
          conversation_id: id,
          sender_id: userId,
          content: sanitizeText(body.content),
        })
        .select()
        .single();

      if (error || !message) {
        throw new AppError(500, 'INTERNAL_ERROR', 'Failed to send message');
      }

      await supabaseAdmin
        .from('conversations')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', id);

      const { data: others } = await supabaseAdmin
        .from('conversation_participants')
        .select('user_id')
        .eq('conversation_id', id)
        .neq('user_id', userId);

      for (const p of others ?? []) {
        await createNotification({
          userId: p.user_id,
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

      await Promise.all([
        supabaseAdmin
          .from('messages')
          .update({ is_read: true })
          .eq('conversation_id', id)
          .neq('sender_id', userId)
          .eq('is_read', false),
        supabaseAdmin
          .from('conversation_participants')
          .update({ last_read_at: new Date().toISOString() })
          .eq('conversation_id', id)
          .eq('user_id', userId),
      ]);

      return { success: true };
    }
  );
}
