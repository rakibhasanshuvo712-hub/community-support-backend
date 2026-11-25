import type { FastifyInstance } from 'fastify';
import { isDatabaseConfigured } from '../../config/env.js';
import { dbQuery, DEFAULT_CATEGORIES } from '../../lib/db.js';

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
      if (!isDatabaseConfigured()) {
        return { categories: DEFAULT_CATEGORIES };
      }
      const res = await dbQuery('SELECT * FROM categories ORDER BY sort_order ASC');
      return { categories: res.rows };
    }
  );
}
