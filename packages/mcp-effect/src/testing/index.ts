// For tests: pi-mcp's in-memory transport pair, the client's end for `McpClient`, the server's end as an Effect peer.

// pi-mcp's testing types (`InMemoryTransport`), so a test names them without importing pi-mcp.
export type * from "@earendil-works/pi-mcp/testing";
export { type InMemoryPair, inMemoryTransportPair, type Peer } from "./in-memory.ts";
