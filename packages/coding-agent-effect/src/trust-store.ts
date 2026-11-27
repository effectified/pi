// pi-coding-agent's store of project trust decisions in Effect: which directories' project resources a user trusted,
// read and written as Effects.

import {
	ProjectTrustStore as PiProjectTrustStore,
	hasTrustRequiringProjectResources as piHasTrustRequiringProjectResources,
} from "@earendil-works/pi-coding-agent";
import { Context, Effect, Layer } from "effect";
import { type CodingAgentFailure, fromPi } from "./errors.ts";
import { type Reads, reads, type Writes, writes } from "./lift.ts";

/** The methods of Pi's trust store that read a decision. */
export const READS = ["get", "getEntry"] as const;

/** The methods of Pi's trust store that write decisions to its file. */
export const WRITES = ["set", "setMany"] as const;

/** A trust store: every method of Pi's `ProjectTrustStore` as an Effect, under its name. */
export interface ProjectTrustStoreHandle
	extends Reads<PiProjectTrustStore, (typeof READS)[number]>, Writes<PiProjectTrustStore, (typeof WRITES)[number]> {
	/** Pi's store, for what takes one as it is. */
	readonly pi: PiProjectTrustStore;
}

/** The project trust decisions of the program. */
export class ProjectTrustStore extends Context.Service<ProjectTrustStore, ProjectTrustStoreHandle>()(
	"@effectified/pi-coding-agent/trust-store/ProjectTrustStore",
) {
	/** `ProjectTrustStore.make(agentDir)` as a Layer. */
	static layer(agentDir: string): Layer.Layer<ProjectTrustStore, CodingAgentFailure> {
		return Layer.effect(ProjectTrustStore, ProjectTrustStore.make(agentDir));
	}

	/** Pi's store of the trust decisions kept in `agentDir`. */
	static readonly make = Effect.fn("ProjectTrustStore.make")(
		(agentDir: string): Effect.Effect<ProjectTrustStoreHandle, CodingAgentFailure> =>
			Effect.try({ try: () => ProjectTrustStore.fromPi(new PiProjectTrustStore(agentDir)), catch: fromPi }),
	);

	/** Pi's store as a handle. */
	static fromPi(pi: PiProjectTrustStore): ProjectTrustStoreHandle {
		return { pi, ...reads(pi, READS), ...writes(pi, WRITES) };
	}
}

/** Whether `cwd` holds project resources that run only once the project is trusted (extensions, settings, packages). */
export const hasTrustRequiringProjectResources = Effect.fn("ProjectTrustStore.hasTrustRequiringProjectResources")(
	(cwd: string): Effect.Effect<boolean, CodingAgentFailure> =>
		Effect.try({ try: () => piHasTrustRequiringProjectResources(cwd), catch: fromPi }),
);
