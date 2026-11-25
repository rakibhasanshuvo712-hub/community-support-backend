import { dbQuery } from '../lib/db.js';

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
  try {
    await dbQuery(
      `INSERT INTO notifications (user_id, type, title, body, link, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        params.userId,
        params.type,
        params.title.slice(0, 200),
        params.body.slice(0, 1000),
        params.link?.slice(0, 300) ?? null,
        JSON.stringify(params.metadata ?? {}),
      ]
    );
  } catch (err) {
    console.error('Failed to insert notification:', err);
  }
}
