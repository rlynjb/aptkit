/**
 * Retrieval eval (packages B + D): measure real retrieval quality with
 * precision@k / recall@k over a small labeled corpus using REAL nomic
 * embeddings. No model generation — this scores retrieval in isolation, the
 * "measure, then decide" number the project's thesis sells.
 *
 *   npm run eval -w @aptkit/agent-rag-query
 *
 * Requires Ollama running with `nomic-embed-text:v1.5` pulled.
 */

import {
  InMemoryVectorStore,
  OllamaEmbeddingProvider,
  createRetrievalPipeline,
} from '@aptkit/retrieval';
import { scorePrecisionAtK, scoreRecallAtK } from '@aptkit/evals';

const CORPUS = [
  { id: 'ml/embeddings', text: 'Embeddings convert text into vectors. nomic-embed-text produces 768-dimensional embeddings used for semantic search.' },
  { id: 'ml/rag', text: 'Retrieval-augmented generation retrieves relevant documents and feeds them to a language model to ground its answers in real data.' },
  { id: 'cook/pasta', text: 'To cook pasta, boil salted water, add the pasta, and stir occasionally until it is al dente.' },
  { id: 'cook/bread', text: 'Sourdough bread needs a live starter, a long slow fermentation, and a very hot oven with steam.' },
  { id: 'travel/japan', text: 'Tokyo and Kyoto are popular destinations in Japan, known for ancient temples and incredible food.' },
  { id: 'travel/france', text: 'Paris is the capital of France, famous for the Eiffel Tower, the Louvre, and its museums.' },
];

// Labeled queries: each maps to the doc id(s) that genuinely answer it.
const QUERIES: { query: string; relevant: string[] }[] = [
  { query: 'how do vector embeddings work', relevant: ['ml/embeddings'] },
  { query: 'what is retrieval augmented generation', relevant: ['ml/rag'] },
  { query: 'how do I bake bread at home', relevant: ['cook/bread'] },
  { query: 'best places to visit in Japan', relevant: ['travel/japan'] },
  { query: 'techniques for machine learning powered search', relevant: ['ml/embeddings', 'ml/rag'] },
];

const K = 3;

/** Distinct doc ids in rank order (a doc may produce several chunks). */
function rankedDocIds(hits: { meta: Record<string, unknown> }[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const hit of hits) {
    const docId = String(hit.meta.docId ?? '');
    if (docId && !seen.has(docId)) {
      seen.add(docId);
      ordered.push(docId);
    }
  }
  return ordered;
}

async function main(): Promise<void> {
  const embedder = new OllamaEmbeddingProvider({ model: 'nomic-embed-text:v1.5' });
  const store = new InMemoryVectorStore(embedder.dimension);
  const pipeline = createRetrievalPipeline({ embedder, store });

  process.stdout.write(`Indexing ${CORPUS.length} docs with real nomic embeddings...\n\n`);
  for (const doc of CORPUS) await pipeline.index(doc);

  let p1Sum = 0;
  let rkSum = 0;

  process.stdout.write(`query                                          P@1   R@${K}\n`);
  process.stdout.write(`${'-'.repeat(58)}\n`);

  for (const { query, relevant } of QUERIES) {
    const hits = await pipeline.query(query, K);
    const docs = rankedDocIds(hits);
    const relevantSet = new Set(relevant);
    const p1 = scorePrecisionAtK(docs, relevantSet, 1).score;
    const rk = scoreRecallAtK(docs, relevantSet, K).score;
    p1Sum += p1;
    rkSum += rk;
    process.stdout.write(`${query.padEnd(46)} ${p1.toFixed(2)}  ${rk.toFixed(2)}\n`);
  }

  const n = QUERIES.length;
  process.stdout.write(`${'-'.repeat(58)}\n`);
  process.stdout.write(`mean                                           ${(p1Sum / n).toFixed(2)}  ${(rkSum / n).toFixed(2)}\n`);
  process.stdout.write(`\nP@1 = top hit is relevant; R@${K} = fraction of relevant docs found in top ${K}.\n`);
}

main().catch((error) => {
  process.stderr.write(`\neval failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
