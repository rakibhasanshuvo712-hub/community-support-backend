import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/errors.js';
import { supabaseAdmin } from '../../lib/supabase.js';

export async function categoryRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/',
    {
      schema: {
        tags: ['Categories'],
        summary: 'List all donation & help-request categories',
      },
    },
    async () => {
      const { data, error } = await supabaseAdmin
        .from('categories')
        .select('id, slug, name_en, name_bn, icon, is_restricted, restriction_note_en, restriction_note_bn, sort_order')
        .order('sort_order', { ascending: true });

      if (error) {
        throw new AppError(500, 'INTERNAL_ERROR', 'Failed to fetch categories');
      }

      return { categories: data ?? [] };
    }
  );
}
