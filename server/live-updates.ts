import { Router, type RequestHandler, type Response } from 'express';
import type { PoolClient } from 'pg';
import { pool } from './db.js';
import { classifyLiveMutation, classifyLiveTopics, type LiveTopic } from '../shared/live-updates.js';
import {
  audienceAllows,
  resolveLiveAudience,
  type LiveAudience,
  type LiveClientIdentity,
} from './live-audience.js';

const CHANNEL = 'book_live_updates';
type ConnectedClient = LiveClientIdentity & { response: Response; clientId: string | null };
const clients = new Set<ConnectedClient>();
let listenerClient: PoolClient | null = null;
let listenerStarting: Promise<void> | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;

interface LivePayload {
  book: boolean;
  dashboard: boolean;
  topics?: LiveTopic[];
  at: number;
  sourceClientId: string | null;
  audience: LiveAudience;
}

function legacyTopics(payload: Pick<LivePayload, 'book' | 'dashboard'>): LiveTopic[] {
  if (!payload.book && !payload.dashboard) return [];
  // During a rolling deploy, an older app instance can publish the Phase 3
  // shape without topics. Widen only that transient compatibility path so a
  // new client cannot miss a refresh; normal Phase 4 events remain precise.
  return ['approvals', 'access', 'files', 'history'];
}

function send(response: Response, payload: LivePayload): void {
  // Audience metadata is server-internal. Browsers only learn that one of their
  // own authorized snapshots is stale, never who else received the signal.
  const { audience: _audience, sourceClientId: _sourceClientId, topics, ...publicPayload } = payload;
  response.write(`event: mutation\ndata: ${JSON.stringify({
    ...publicPayload,
    topics: Array.isArray(topics) ? topics : legacyTopics(payload),
  })}\n\n`);
}

function broadcast(payload: LivePayload): void {
  for (const client of clients) {
    if (payload.sourceClientId && client.clientId === payload.sourceClientId) continue;
    if (!audienceAllows(payload.audience, client)) continue;
    send(client.response, payload);
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer || clients.size === 0) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void ensureListener();
  }, 1_000);
  reconnectTimer.unref?.();
}

async function ensureListener(): Promise<void> {
  if (listenerClient || listenerStarting) return listenerStarting ?? Promise.resolve();
  listenerStarting = (async () => {
    const client = await pool.connect();
    listenerClient = client;
    client.on('notification', (message) => {
      if (message.channel !== CHANNEL || !message.payload) return;
      try {
        const payload = JSON.parse(message.payload) as LivePayload;
        if (typeof payload.at !== 'number' || !payload.audience) return;
        broadcast(payload);
      } catch { /* malformed notifications are ignored */ }
    });
    client.on('error', () => {
      if (listenerClient !== client) return;
      listenerClient = null;
      try { client.release(true); } catch { /* already released */ }
      scheduleReconnect();
    });
    await client.query(`LISTEN ${CHANNEL}`);
  })().catch((error) => {
    listenerClient = null;
    scheduleReconnect();
    throw error;
  }).finally(() => {
    listenerStarting = null;
  });
  return listenerStarting;
}

async function publish(payload: LivePayload): Promise<void> {
  await pool.query('SELECT pg_notify($1, $2)', [CHANNEL, JSON.stringify(payload)]);
}

export const liveUpdatesRouter = Router();

liveUpdatesRouter.get('/live-updates', async (req, res, next) => {
  try {
    await ensureListener();
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const client: ConnectedClient = {
      response: res,
      clientId: typeof req.query.client === 'string' && req.query.client.length <= 120 ? req.query.client : null,
      userId: req.user!.id,
      role: req.user!.role,
    };
    clients.add(client);
    res.write('retry: 1500\n: connected\n\n');

    const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 20_000);
    heartbeat.unref?.();
    req.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(client);
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Observe successful authenticated writes after every downstream router has
 * finished. PostgreSQL NOTIFY fans the signal to every app instance. Phase 3
 * resolves the smallest authorized audience; Phase 4 adds value-free refresh
 * topics so mounted pages can revalidate only the datasets they own.
 */
export const liveMutationObserver: RequestHandler = (req, res, next) => {
  const path = new URL(req.originalUrl, 'http://local').pathname;
  const impact = classifyLiveMutation(path, req.method);
  if (!impact) return next();

  const topics = classifyLiveTopics(path, req.method);
  const sourceClientId = req.get('x-live-client');
  res.on('finish', () => {
    if (res.statusCode < 200 || res.statusCode >= 400) return;
    void resolveLiveAudience(req, path, impact)
      .catch((): LiveAudience => ({ all: true, owners: true, userIds: [] }))
      .then((audience) => publish({
        ...impact,
        topics,
        at: Date.now(),
        sourceClientId: sourceClientId && sourceClientId.length <= 120 ? sourceClientId : null,
        audience,
      }))
      .catch(() => {
        // The write already committed successfully. A transient notification
        // failure must not turn a successful financial action into an API error.
      });
  });
  next();
};
