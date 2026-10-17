// Server-sent events for one invoice: replay the past events, then stream new ones until the client leaves.
import { type AppEvent, SSE_EVENT_NAME } from 'core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { InvoiceStore } from './store.js';

const HEARTBEAT_MS = 15_000;

export function formatSse(event: AppEvent): string {
  return `event: ${SSE_EVENT_NAME}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function streamInvoiceEvents(
  store: InvoiceStore,
  invoiceId: string,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  const res = open(reply);
  // Replay and subscribe in the same synchronous tick, so no event can fall in between.
  for (const event of store.eventsOf(invoiceId)) res.write(formatSse(event));
  keepAlive(
    request,
    res,
    store.subscribe(invoiceId, (event) => res.write(formatSse(event))),
  );
}

/** Live events without an invoice (no replay): transfer status changes not linked to an invoice. */
export function streamGlobalEvents(store: InvoiceStore, request: FastifyRequest, reply: FastifyReply): void {
  const res = open(reply);
  keepAlive(
    request,
    res,
    store.subscribeGlobal((event) => res.write(formatSse(event))),
  );
}

function open(reply: FastifyReply) {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': connected\n\n');
  return res;
}

function keepAlive(request: FastifyRequest, res: FastifyReply['raw'], unsubscribe: () => void): void {
  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
  heartbeat.unref();
  const close = () => {
    clearInterval(heartbeat);
    unsubscribe();
  };
  request.raw.on('close', close);
  res.on('close', close);
}
