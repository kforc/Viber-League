// worker.js — Cloudflare Worker that serves the Viber League bundle
// from the ASSETS static-asset binding. Any path without a file
// extension that misses the assets falls back to the game (SPA
// behaviour) so the link is forgiving if shared with a sub-path.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const resp = await env.ASSETS.fetch(request);
    if (
      resp.status === 404 &&
      request.method === 'GET' &&
      !/\.[a-z0-9]+$/i.test(url.pathname)
    ) {
      return env.ASSETS.fetch(new URL('/index.html', url));
    }
    return resp;
  },
};
