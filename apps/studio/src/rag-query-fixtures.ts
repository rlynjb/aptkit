import type { RagQueryFixture } from './types';

// A tiny personal-notes corpus shared by the fixtures below. Short docs → one
// chunk each, so retrieval is easy to read in the UI.
const NOTES_CORPUS = [
  {
    id: 'work.md',
    text: 'I work as a software engineer focused on AI agents and retrieval-augmented generation. My main project is aptkit, a TypeScript toolkit for building agents.',
  },
  {
    id: 'stack.md',
    text: 'My preferred stack is TypeScript, Node, and Supabase. I run local models with Ollama — Gemma for reasoning and nomic-embed-text for embeddings.',
  },
  {
    id: 'coffee.md',
    text: 'I take my coffee as a flat white with oat milk and no sugar, usually mid-morning around 10am.',
  },
];

export const ragQueryFixtures: RagQueryFixture[] = [
  {
    id: 'notes-work-coffee',
    description: 'Two-part question answered from two different notes (grounded + cited).',
    question: 'What does the author do for work, and how do they take their coffee?',
    profile: 'Answer concisely and cite the source note for each claim.',
    corpus: NOTES_CORPUS,
    relevant: ['work.md', 'coffee.md'],
    modelResponses: [
      {
        content: [
          {
            type: 'tool_use',
            id: 'rag-tool-1',
            name: 'search_knowledge_base',
            input: { query: 'author work job coffee', top_k: 4 },
          },
        ],
      },
      {
        model: 'gemma2:9b',
        content: [
          {
            type: 'text',
            text:
              'The author works as a software engineer focused on AI agents and retrieval-augmented generation; their main project is aptkit, a TypeScript toolkit for building agents [work.md]. They take their coffee as a flat white with oat milk and no sugar, usually mid-morning around 10am [coffee.md].',
          },
        ],
      },
    ],
  },
  {
    id: 'notes-local-stack',
    description: 'Single-source question — the relevant note is one of three.',
    question: 'What does the author use to run AI models locally?',
    corpus: NOTES_CORPUS,
    relevant: ['stack.md'],
    modelResponses: [
      {
        content: [
          {
            type: 'tool_use',
            id: 'rag-tool-1',
            name: 'search_knowledge_base',
            input: { query: 'local AI models tools stack ollama', top_k: 4 },
          },
        ],
      },
      {
        model: 'gemma2:9b',
        content: [
          {
            type: 'text',
            text:
              'The author runs local models with Ollama — Gemma for reasoning and nomic-embed-text for embeddings — on a TypeScript, Node, and Supabase stack [stack.md].',
          },
        ],
      },
    ],
  },
];
