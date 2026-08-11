const CANONICAL_HTTP_ORIGIN = "http://127.0.0.1:8099";
const CANONICAL_WEBSOCKET_ORIGIN = "ws://127.0.0.1:8099";
const guardedContexts = new WeakSet<object>();

function hasAllowedOrigin(value: string, expectedOrigin: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.origin === expectedOrigin &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

export default async ({ page }) => {
  const context = page.context();
  if (guardedContexts.has(context)) return;
  guardedContexts.add(context);

  // Context-level routing covers top-level redirects, frames, workers, and all
  // subsequent tabs. The request is aborted before Chromium opens a connection.
  await context.route("**/*", async (route) => {
    if (hasAllowedOrigin(route.request().url(), CANONICAL_HTTP_ORIGIN)) {
      await route.continue();
      return;
    }
    await route.abort("blockedbyclient");
  });

  if (typeof context.routeWebSocket !== "function") {
    throw new Error("Telegram Playwright requires WebSocket routing support");
  }
  await context.routeWebSocket(/.*/u, async (webSocket) => {
    if (hasAllowedOrigin(webSocket.url(), CANONICAL_WEBSOCKET_ORIGIN)) {
      webSocket.connectToServer();
      return;
    }
    await webSocket.close({ code: 1008, reason: "Blocked non-canonical origin" });
  });
};
