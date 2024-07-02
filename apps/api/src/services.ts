import type { FastifyBaseLogger } from 'fastify';
import type { Config } from './config';
import type { AppContext, ServiceOverrides } from './context';
import type { Database } from './db';
import { createScanner } from './modules/documents/scanner';
import { createOcr } from './modules/extraction/ocr';
import { createStorage } from './storage';
import { createEmbeddings } from './ai/embeddings';
import { createLlm } from './ai/llm';

export function createContext(
  config: Config,
  db: Database,
  log: FastifyBaseLogger,
  overrides: ServiceOverrides = {},
): AppContext {
  return {
    config,
    db,
    log,
    storage: overrides.storage ?? createStorage(config),
    scanner: overrides.scanner ?? createScanner(config),
    ocr: overrides.ocr !== undefined ? overrides.ocr : createOcr(config),
    embeddings: overrides.embeddings ?? createEmbeddings(config),
    llm: overrides.llm ?? createLlm(config),
  };
}
