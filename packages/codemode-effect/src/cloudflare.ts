// The entry of `@effectified/pi-codemode/cloudflare`, for Workers built with Wrangler: the portable entry, the QuickJS
// module Wrangler compiles (for `InlineSandbox.make`), and the Durable Object a sandbox Worker exports for
// `RemoteSandbox`. Import `/portable` in the agent's Worker instead: this entry bundles QuickJS.

export type * from "@earendil-works/pi-codemode/cloudflare";
// The Durable Object class a sandbox Worker exports (or subclasses, to change its limits) for Cloudflare to run: the
// remote end of `RemoteSandbox`. The application never calls it. Wrangler's compiled QuickJS module and the
// object's default memory limit.
export {
	CodemodeSandboxDurableObject,
	cloudflareQuickJSWasm,
	DEFAULT_REMOTE_MEMORY_LIMIT_BYTES,
} from "@earendil-works/pi-codemode/cloudflare";
export * from "./portable.ts";
