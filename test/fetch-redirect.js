// Preloaded into the legacy server (which has the OpenAI URL hardcoded) to send
// its requests to the test mock instead of the real API.
const target = process.env.FETCH_REDIRECT_OPENAI;
const originalFetch = globalThis.fetch;
globalThis.fetch = (url, init) => {
  const href = String(url);
  if (target && href.startsWith("https://api.openai.com/v1")) {
    return originalFetch(href.replace("https://api.openai.com/v1", target), init);
  }
  return originalFetch(url, init);
};
