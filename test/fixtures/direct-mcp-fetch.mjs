// Preloaded into the MCP subprocess. Check requests without opening a socket.
import { readFileSync } from "node:fs";

globalThis.fetch = async (input, init) => {
  const url = new URL(input);
  const headers = new Headers(init.headers);
  const staging = process.env.EXPECT_STAGING === "1";
  const expectedHost = staging ? "polychat-staging-421312241218.us-west2.run.app" : "api.polychat.co";
  const key = staging ? "fixture-staging-key" : "fixture-production-key";
  if (url.origin !== "https://" + expectedHost || (init.method ?? "GET") !== "GET" ||
      headers.get("authorization") !== "Bearer " + key || !headers.get("x-memtree-tool") ||
      headers.has("x-claude-code-session-id") || headers.has("x-ccc-host-token") ||
      headers.has("x-ccc-proxy-token") || init.redirect !== "error") {
    console.error("Unexpected MemTree request");
    throw new Error("Unexpected MemTree request");
  }
  switch (url.pathname) {
    case "/v1/memtree/sessions":
      if (url.searchParams.get("q") === "denied") return Response.json({ detail: key }, { status: 403 });
      return Response.json({ sessions: [{ session_id: "12345678-1234-1234-1234-123456789abc",
        latest_tree: { ref: "abcd-v1-own" } }] });
    case "/v1/memtree/search":
      if (url.searchParams.get("q") === "deploy") return Response.json({ hits: [] });
      break;
    case "/usage/memtree/abcd-v1-own.json":
      return new Response(readFileSync(new URL("./memtree-page.json", import.meta.url)));
    case "/usage/memtree/abcd-v1-own/search":
      return Response.json({ hits: [], terms: ["deploy"] });
    case "/usage/memtree/abcd-v1-own/messages":
      return Response.json({ messages: [] });
    case "/usage/memtree/abcd-v1-own/handover":
    case "/usage/memtree/abcd-v1-own/user_messages":
      return Response.json({ messages: [{ n: 1, text: "fixture message" }] });
  }
  console.error("Unexpected MemTree route");
  throw new Error("Unexpected MemTree route");
};
