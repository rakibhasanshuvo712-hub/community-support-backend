import type { FastifyInstance } from 'fastify';
import { isFirebaseConfigured } from '../../config/env.js';
import { getDb } from '../../lib/firebase.js';
import { DEFAULT_CATEGORIES, ensureCategoriesSeeded } from '../../services/seed.service.js';

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
      if (!isFirebaseConfigured()) {
        return { categories: DEFAULT_CATEGORIES };
      }

      await ensureCategoriesSeeded();
      const snap = await getDb().collection('categories').orderBy('sort_order', 'asc').get();
      const categories = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      return { categories };
    }
  );
}
