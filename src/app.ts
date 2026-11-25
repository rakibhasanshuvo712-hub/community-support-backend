import type { IncomingMessage, ServerResponse } from 'node:http';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { env } from './config/env.js';
import { errorHandler } from './lib/errors.js';
import { adminRoutes } from './routes/v1/admin.js';
import { authRoutes } from './routes/v1/auth.js';
import { categoryRoutes } from './routes/v1/categories.js';
import { claimRoutes } from './routes/v1/claims.js';
import { contributionRoutes } from './routes/v1/contributions.js';
import { conversationRoutes } from './routes/v1/conversations.js';
import { healthRoutes } from './routes/v1/health.js';
import { notificationRoutes } from './routes/v1/notifications.js';
import { postRoutes } from './routes/v1/posts.js';
import { profileRoutes } from './routes/v1/profiles.js';
import { reportRoutes } from './routes/v1/reports.js';

export async function buildApp() {
  const app = Fastify({
    logger: env.NODE_ENV !== 'test',
    trustProxy: true,
  });

  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });

  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin || env.corsOriginsList.includes(origin) || env.corsOriginsList.includes('*')) {
        cb(null, true);
      } else {
        cb(new Error('Not allowed by CORS'), false);
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  });

  await app.register(rateLimit, {
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW_MS,
  });

  await app.register(multipart, {
    limits: {
      fileSize: 10 * 1024 * 1024, // 10MB max
      files: 1,
    },
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Community Support & Direct Donation API',
        description:
          'REST API for the Donation & Community Support Platform. Direct donor-to-recipient coordination; platform never holds or processes funds.',
        version: '1.0.0',
      },
      servers: [{ url: '/api/v1' }],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
          },
        },
      },
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
  });

  app.setErrorHandler(errorHandler);

  app.get('/', async () => ({
    status: 'ok',
    service: 'community-support-api',
    version: '1.0.0',
    health: '/api/v1/health',
    docs: '/docs',
  }));

  await app.register(
    async (v1) => {
      await v1.register(healthRoutes);
      await v1.register(authRoutes, { prefix: '/auth' });
      await v1.register(profileRoutes, { prefix: '/profiles' });
      await v1.register(categoryRoutes, { prefix: '/categories' });
      await v1.register(postRoutes, { prefix: '/posts' });
      await v1.register(claimRoutes);
      await v1.register(contributionRoutes);
      await v1.register(conversationRoutes, { prefix: '/conversations' });
      await v1.register(notificationRoutes, { prefix: '/notifications' });
      await v1.register(reportRoutes, { prefix: '/reports' });
      await v1.register(adminRoutes, { prefix: '/admin' });
    },
    { prefix: '/api/v1' }
  );

  return app;
}

let cachedApp: ReturnType<typeof buildApp> | null = null;

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (!cachedApp) {
    cachedApp = buildApp();
  }
  const app = await cachedApp;
  await app.ready();
  app.server.emit('request', req, res);
}
