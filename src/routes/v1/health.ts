import type { FastifyInstance } from 'fastify';
import { isDatabaseConfigured } from '../../config/env.js';
import { getDb } from '../../lib/mongo.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/health',
    {
      schema: {
        tags: ['Health'],
        summary: 'API & MongoDB Atlas health check',
      },
    },
    async () => {
      let dbStatus: 'connected' | 'unconfigured' | 'error' = 'unconfigured';
      if (isDatabaseConfigured()) {
        try {
          const db = await getDb();
          await db.command({ ping: 1 });
          dbStatus = 'connected';
        } catch {
          dbStatus = 'error';
        }
      }

      return {
        status: 'ok',
        service: 'community-support-api',
        version: '1.0.0',
        provider: 'mongodb',
        timestamp: new Date().toISOString(),
        database: dbStatus,
      };
    }
  );
}
