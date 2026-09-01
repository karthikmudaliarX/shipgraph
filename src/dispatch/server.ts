import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createLinearDispatchService, type LinearDispatchHeaders, type LinearDispatchServiceOptions } from './service.js';
import { LINEAR_WEBHOOK_MAX_BODY_BYTES, LinearWebhookError } from './webhook.js';

export type LinearDispatchServerOptions = LinearDispatchServiceOptions & {
  webhookPath?: string;
  listenHost?: string;
  listenPort?: number;
};

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(encoded),
  });
  response.end(encoded);
}

async function readRawBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > LINEAR_WEBHOOK_MAX_BODY_BYTES) {
      request.resume();
      throw new LinearWebhookError('Linear webhook body exceeds the configured limit', 413);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, size);
}

function requestHeaders(request: IncomingMessage): LinearDispatchHeaders {
  const headers: LinearDispatchHeaders = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') headers[name] = value;
  }
  return headers;
}

/** Create the HTTP receiver; it does not start listening until requested. */
export function createLinearDispatchServer(options: LinearDispatchServerOptions) {
  const service = createLinearDispatchService(options);
  const path = options.webhookPath ?? service.webhookPath;
  const server = createServer((request, response) => {
    void (async (): Promise<void> => {
      const requestPath = (request.url ?? '').split('?', 1)[0];
      if (requestPath !== path) {
        writeJson(response, 404, { error: 'not found' });
        return;
      }
      if (request.method !== 'POST') {
        response.setHeader('allow', 'POST');
        writeJson(response, 405, { error: 'method not allowed' });
        return;
      }
      const result = await service.handleWebhook(
        await readRawBody(request),
        requestHeaders(request)
      );
      writeJson(response, 200, result);
    })().catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error instanceof LinearWebhookError) {
        writeJson(response, error.statusCode, { error: error.message });
        return;
      }
      writeJson(response, 503, { error: 'Linear dispatch is temporarily unavailable' });
    });
  });
  return { server, service };
}

export async function startLinearDispatchServer(
  options: LinearDispatchServerOptions
): Promise<ReturnType<typeof createLinearDispatchServer>> {
  const result = createLinearDispatchServer(options);
  await result.service.recoverIncompleteClaims();
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      result.server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      result.server.off('error', onError);
      resolve();
    };
    result.server.once('error', onError);
    result.server.once('listening', onListening);
    result.server.listen(
      options.listenPort ?? result.service.listenPort,
      options.listenHost ?? result.service.listenHost
    );
  });
  return result;
}
