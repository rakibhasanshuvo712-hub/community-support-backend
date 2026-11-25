import type { FastifyInstance } from 'fastify';
import { isFirebaseConfigured } from '../../config/env.js';
import { getDb } from '../../lib/firebase.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/health',
    {
      schema: {
        tags: ['Health'],
        summary: 'API & Firebase Firestore health check',
      },
    },
    async () => {
      let dbStatus: 'connected' | 'unconfigured' | 'error' = 'unconfigured';
      if (isFirebaseConfigured()) {
        try {
          await getDb().collection('categories').limit(1).get();
          dbStatus = 'connected';
        } catch {
          dbStatus = 'error';
        }
      }

      return {
        status: 'ok',
        service: 'community-support-api',
        version: '1.0.0',
        provider: 'firebase',
        timestamp: new Date().toISOString(),
        database: dbStatus,
      };
    }
  );
}
