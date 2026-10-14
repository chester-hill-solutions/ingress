/** Optional loopback adapter. The core experiment never loads a model by default. */
export function embeddingGemmaClient(endpoint = 'http://127.0.0.1:8766') {
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new TypeError('embedding_endpoint_must_be_loopback_origin');
  }
  async function request(path, body) {
    const response = await fetch(new URL(path, url), {
      method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000), redirect: 'error',
    });
    if (!response.ok) throw new Error(`embedding_service_status_${response.status}`);
    const data = await response.json();
    if (data.model !== 'google/embeddinggemma-2') throw new Error('unexpected_embedding_model');
    return data;
  }
  return {
    metadata: () => request('/health'),
    embed: async (texts, prompt) => {
      if (!Array.isArray(texts) || texts.length < 1 || texts.length > 256
        || texts.some(text => typeof text !== 'string' || text.length > 32_768)
        || !['Document', 'CodeRetrieval'].includes(prompt)) throw new TypeError('invalid_embedding_batch');
      const result = await request('/embed', { texts, prompt });
      if (!Array.isArray(result.embeddings) || result.embeddings.length !== texts.length) throw new Error('embedding_count_mismatch');
      return result.embeddings;
    },
  };
}
