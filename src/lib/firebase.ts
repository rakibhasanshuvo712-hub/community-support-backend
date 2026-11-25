import { cert, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getStorage, type Storage } from 'firebase-admin/storage';
import { env, isFirebaseConfigured } from '../config/env.js';

let firebaseApp: App | null = null;

function ensureFirebaseApp(): App {
  if (firebaseApp) return firebaseApp;
  const existing = getApps();
  if (existing.length > 0 && existing[0]) {
    firebaseApp = existing[0];
    return firebaseApp;
  }

  if (!isFirebaseConfigured()) {
    throw new Error('Firebase Admin credentials are not configured');
  }

  firebaseApp = initializeApp({
    credential: cert({
      projectId: env.FIREBASE_PROJECT_ID,
      clientEmail: env.FIREBASE_CLIENT_EMAIL,
      privateKey: env.firebasePrivateKeyNormalized,
    }),
    storageBucket: env.firebaseStorageBucketResolved,
  });

  return firebaseApp;
}

export function getAdminAuth(): Auth {
  return getAuth(ensureFirebaseApp());
}

export function getDb(): Firestore {
  return getFirestore(ensureFirebaseApp());
}

export function getStorageService(): Storage {
  return getStorage(ensureFirebaseApp());
}

export async function getSignedReadUrl(storagePath: string, expiresInSeconds = 3600): Promise<string | null> {
  if (!storagePath || !env.firebaseStorageBucketResolved) return null;
  try {
    const bucket = getStorageService().bucket(env.firebaseStorageBucketResolved);
    const [url] = await bucket.file(storagePath).getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + expiresInSeconds * 1000,
    });
    return url;
  } catch {
    return null;
  }
}

export async function uploadBufferToStorage(
  storagePath: string,
  buffer: Buffer,
  contentType: string
): Promise<void> {
  const bucket = getStorageService().bucket(env.firebaseStorageBucketResolved);
  const file = bucket.file(storagePath);
  await file.save(buffer, {
    contentType,
    resumable: false,
    metadata: {
      cacheControl: 'private, max-age=3600',
    },
  });
}
