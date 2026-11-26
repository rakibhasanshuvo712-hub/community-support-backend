import type { FastifyInstance } from 'fastify';
import { isDatabaseConfigured } from '../../config/env.js';
import { DEFAULT_CATEGORIES, getDb } from '../../lib/mongo.js';

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
      const db = await getDb();
      const categories = await db
        .collection('categories')
        .find({}, { projection: { _id: 0 } })
        .sort({ sort_order: 1 })
        .toArray();
      return { categories };
    }
  );
}
