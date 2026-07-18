// Shared __net dispatch router.
//
// Two subsystems live on top of globalThis.__net:
//   - fetch/WebSocket bridge (world/net.ts): dispatch(id: number, kind: 'response'|'error'|'open'|'message'|'close'|..., payload)
//   - node:net Socket/Server bridge (world/node-net.ts): dispatch(event: 'connection'|'data'|'end'|'error'|'connect', socketId: number, payload)
//
// Previously each installer overwrote globalThis.__net with its own dispatch
// function, so whichever loaded second silently broke the other. This module
// exposes a single dispatch that inspects the first argument's shape and
// forwards to the registered handler for that subsystem.
//
// Registration is idempotent — later calls replace the handler. The dispatch
// function itself is installed once; subsequent imports reuse it.

type FetchLikeDispatch = (id: number, kind: string, payload: unknown) => void;
type SocketLikeDispatch = (event: string, socketId: number, payload?: unknown) => void;

interface NetRouter {
  dispatch(a: unknown, b: unknown, c?: unknown): void;
  _fetch?: FetchLikeDispatch;
  _socket?: SocketLikeDispatch;
}

const getRouter = (): NetRouter => {
  const g = globalThis as Record<string, unknown>;
  const existing = g['__net'] as NetRouter | undefined;
  if (
    existing
    && typeof existing.dispatch === 'function'
    && ('_fetch' in existing || '_socket' in existing)
  ) {
    return existing;
  }
  const router: NetRouter = {
    dispatch(a: unknown, b: unknown, c?: unknown): void {
      // fetch/WS shape: (number, string, payload) — first arg is a request id.
      if (typeof a === 'number' && typeof b === 'string') {
        router._fetch?.(a, b, c);
        return;
      }
      // node:net shape: (string, number, payload) — first arg is the event name.
      if (typeof a === 'string' && typeof b === 'number') {
        router._socket?.(a, b, c);
        return;
      }
      // Unknown shape — silently drop rather than throwing (the dispatch is
      // called from host-generated eval'd JS; throwing would tear down the
      // engine's message loop).
    },
  };
  g['__net'] = router;
  return router;
};

export const registerFetchDispatch = (fn: FetchLikeDispatch): void => {
  getRouter()._fetch = fn;
};

export const registerSocketDispatch = (fn: SocketLikeDispatch): void => {
  getRouter()._socket = fn;
};
