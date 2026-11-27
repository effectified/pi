// What the pi-effect packages are on npm, for the scripts that publish them (`release.ts`) and that prepare npm for
// the first publish (`npm-bootstrap.ts`): the packages npm gets, what the registry holds of one, and the workflow npm
// trusts to publish them without a token.

import { spawnSync } from "node:child_process";
import { type EffectPackage, effectPackages } from "./packages.ts";

/** The repository whose workflow publishes: npm trusts this pair, and a tarball's provenance names it. */
export const REPOSITORY = "effectified/pi";
/** The workflow file npm trusts, in `.github/workflows/`. A rename needs every package's trust set again. */
export const WORKFLOW = "effect-release.yml";
/** The branch the packages are released from: the fork's own, since `main` mirrors upstream. */
export const BRANCH = "effect";

const REGISTRY = "https://registry.npmjs.org";

/** What the registry holds of one package. */
export type Published =
	| { readonly kind: "absent" }
	| { readonly kind: "present"; readonly versions: readonly string[] };

/** Every package npm gets: all but the private ones. */
export function publicPackages(): EffectPackage[] {
	return effectPackages().filter((pkg) => !pkg.private);
}

/** The versions of `name` on npm, or that npm has no such package. Throws when the registry does not answer. */
export async function published(name: string): Promise<Published> {
	const response = await fetch(`${REGISTRY}/${name.replace("/", "%2f")}`, {
		// The short form of a package's record: its versions without their READMEs.
		headers: { accept: "application/vnd.npm.install-v1+json" },
	});
	if (response.status === 404) return { kind: "absent" };
	if (!response.ok) throw new Error(`npm answered ${response.status} for ${name}`);
	// Trust boundary: the registry's answer is wire input.
	const record: unknown = await response.json();
	const versions =
		typeof record === "object" && record !== null && "versions" in record && typeof record.versions === "object"
			? Object.keys(record.versions ?? {})
			: [];
	return { kind: "present", versions };
}

/** Ends the script unless the npm on the path is `least` or newer; `why` says what needs it. */
export function requireNpm(least: readonly [number, number, number], why: string): void {
	const found = spawnSync("npm", ["--version"], { encoding: "utf8" }).stdout.trim();
	const parts = found.split(".").map(Number);
	const older = least.findIndex((part, index) => (parts[index] ?? 0) !== part);
	if (older === -1 || (parts[older] ?? 0) > (least[older] ?? 0)) return;
	console.error(`npm ${found} is too old: ${why} needs npm ${least.join(".")} or newer.`);
	process.exit(1);
}
