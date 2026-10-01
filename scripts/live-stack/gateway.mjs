// Minimal stand-in for Supabase's Kong gateway for the LOCAL live-test stack (test-only).
//   /auth/v1/*      -> GoTrue   :9999   (prefix stripped)
//   /rest/v1/*      -> PostgREST :3000  (prefix stripped)
//   /realtime/v1/*  -> Realtime :4000   (-> /socket/*, Host rewritten to the seeded tenant)
//   /storage/v1/*   -> Storage  :5000   (prefix stripped)
// Adds permissive CORS like Kong's cors plugin. Usage: node gateway.mjs [port]
import http from "node:http";
import net from "node:net";

const PORT = Number(process.argv[2] ?? 54321);
const ROUTES = [
  { prefix: "/auth/v1/", port: 9999, rewrite: (p) => "/" + p },
  { prefix: "/rest/v1/", port: 3000, rewrite: (p) => "/" + p },
  { prefix: "/storage/v1/", port: 5000, rewrite: (p) => "/" + p },
  {
    prefix: "/realtime/v1/",
    port: 4000,
    rewrite: (p) => "/socket/" + p,
    host: "realtime-dev.supabase-realtime",
  },
];
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "access-control-allow-headers": "*",
  "access-control-expose-headers": "*",
  "access-control-max-age": "3600",
};
const match = (url) => {
  const r = ROUTES.find((x) => url.startsWith(x.prefix));
  return r ? { r, path: r.rewrite(url.slice(r.prefix.length)) } : null;
};

http
  .createServer((req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS).end();
      return;
    }
    const m = match(req.url ?? "");
    if (!m) {
      res.writeHead(404, CORS).end("no route");
      return;
    }
    const headers = { ...req.headers, host: m.r.host ?? `127.0.0.1:${m.r.port}` };
    const up = http.request(
      { host: "127.0.0.1", port: m.r.port, method: req.method, path: m.path, headers },
      (ur) => {
        res.writeHead(ur.statusCode ?? 502, { ...ur.headers, ...CORS });
        ur.pipe(res);
      },
    );
    up.on("error", (e) => res.writeHead(502, CORS).end(String(e)));
    req.pipe(up);
  })
  .on("upgrade", (req, socket, head) => {
    const m = match(req.url ?? "");
    if (!m) return socket.destroy();
    const up = net.connect(m.r.port, "127.0.0.1", () => {
      const h = { ...req.headers, host: m.r.host ?? `127.0.0.1:${m.r.port}` };
      let raw = `${req.method} ${m.path} HTTP/1.1\r\n`;
      for (const [k, v] of Object.entries(h)) raw += `${k}: ${v}\r\n`;
      up.write(raw + "\r\n");
      if (head?.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on("error", () => socket.destroy());
    socket.on("error", () => up.destroy());
  })
  .listen(PORT, "127.0.0.1", () => console.log(`gateway on :${PORT}`));
