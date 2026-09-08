import type { RequestHandler } from 'express';
import { logOperationalEvent } from './alerts.js';

const startedAt = Date.now();
let clientAborts = 0;
let liveOpened = 0;
let liveClosed = 0;
let liveActive = 0;
let liveReconnects = 0;
const seenLiveClients = new Map<string, number>();

function routeName(path: string) {
  return path.replace(/\/[A-Za-z0-9_-]{12,}(?=\/|$)/g, '/:id').slice(0, 180);
}

export const clientAbortTelemetry: RequestHandler = (req, res, next) => {
  const started = process.hrtime.bigint();
  let finished = false;
  res.on('finish', () => { finished = true; });
  res.on('close', () => {
    if (finished || res.writableEnded) return;
    clientAborts += 1;
    const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    logOperationalEvent('http.client_aborted', {
      internalStatus: 499,
      method: req.method,
      path: routeName(req.path),
      durationMs: Math.round(durationMs * 10) / 10,
      clientAbortsSinceStart: clientAborts,
    }, 'warn');
  });
  next();
};

export const liveTransportTelemetry: RequestHandler = (req, res, next) => {
  const path = new URL(req.originalUrl, 'http://local').pathname;
  if (path !== '/api/live-updates' && path !== '/live-updates') return next();

  const clientId = typeof req.query.client === 'string' && req.query.client.length <= 120
    ? req.query.client
    : null;
  const now = Date.now();
  if (clientId) {
    if (seenLiveClients.has(clientId)) liveReconnects += 1;
    seenLiveClients.set(clientId, now);
    if (seenLiveClients.size > 2_000) {
      const cutoff = now - 24 * 60 * 60_000;
      for (const [id, at] of seenLiveClients) if (at < cutoff) seenLiveClients.delete(id);
    }
  }

  liveOpened += 1;
  liveActive += 1;
  let closed = false;
  res.on('close', () => {
    if (closed) return;
    closed = true;
    liveClosed += 1;
    liveActive = Math.max(0, liveActive - 1);
  });
  next();
};

export function transportObservabilitySnapshot() {
  return {
    since: new Date(startedAt).toISOString(),
    clientAborts,
    live: {
      opened: liveOpened,
      closed: liveClosed,
      active: liveActive,
      reconnects: liveReconnects,
      reconnectRatio: liveOpened ? Math.round((liveReconnects / liveOpened) * 1000) / 1000 : 0,
    },
  };
}
