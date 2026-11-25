import { supabaseAdmin } from '../lib/supabase.js';

export type NotificationType =
  | 'new_offer'
  | 'new_request'
  | 'offer_accepted'
  | 'offer_rejected'
  | 'new_message'
  | 'contribution_confirmed'
  | 'post_status_changed'
  | 'moderation';

export async function createNotification(params: {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  link?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const { error } = await supabaseAdmin.from('notifications').insert({
    user_id: params.userId,
    type: params.type,
    title: params.title.slice(0, 200),
    body: params.body.slice(0, 1000),
    link: params.link?.slice(0, 300) ?? null,
    metadata: params.metadata ?? {},
  });

  if (error) {
    // Notifications should never break the primary transaction flow
    console.error('Failed to insert notification:', error.message);
  }
}
