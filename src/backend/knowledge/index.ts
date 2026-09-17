export { chunkMarkdown, loadKnowledgeCorpus } from './corpus.js';
export type { KnowledgeChunk } from './corpus.js';
export {
  KnowledgeRetriever,
  buildKnowledgeBlock,
  normalize,
  KNOWLEDGE_PREAMBLE,
  ALIAS_FAMILIES_FOR_TEST
} from './retriever.js';
export type { RetrievedChunk } from './retriever.js';
