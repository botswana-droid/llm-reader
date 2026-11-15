// Prompt templates used by the Send tab and the highlight popover.
// `body` is the instruction text that gets prepended to the composed payload.
// Keep them short, direct, and free of role-playing prefixes.

export const PROMPT_TEMPLATES = [
  {
    id: "none",
    label: "None (just the text)",
    body: "",
  },
  {
    id: "summarize",
    label: "Summarize",
    body: "Please summarize the following. Give a 2–3 sentence TL;DR, then 3–6 bullets of key ideas, then any surprising or contentious claims worth pushing back on.",
  },
  {
    id: "keyideas",
    label: "Key ideas + surprising claims",
    body: "From the following, extract: (1) the 3–6 most important ideas, (2) any surprising or contestable claims, (3) 2–4 questions a careful reader should leave with. Be concrete; quote briefly when useful.",
  },
  {
    id: "quiz",
    label: "Quiz me",
    body: "Generate 8 quiz questions to test deep understanding of the following. Mix factual recall, conceptual understanding, and application. Provide the answers separately at the end.",
  },
  {
    id: "explain",
    label: "Explain in plain terms",
    body: "Re-explain the following in plain, conversational terms a smart non-specialist would grasp on first read. Keep all substantive content; cut jargon.",
  },
  {
    id: "discuss",
    label: "Discuss",
    body: "I just read the following. What are the 2–3 most interesting points worth discussing? Pick one and share your own take to start the conversation.",
  },
  {
    id: "custom",
    label: "Custom…",
    body: null, // signals "user-supplied" — caller provides the body
  },
];

export function getTemplate(id) {
  return PROMPT_TEMPLATES.find(t => t.id === id) || PROMPT_TEMPLATES[0];
}
