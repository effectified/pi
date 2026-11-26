// The estimate port: how much a product sets aside for a provider request before it knows what the request costs.

import { Context, Effect, Layer } from "effect";
import type { BudgetRequest } from "./lease.ts";

/** The product's rule for the size of a reservation. The budget holds no pricing opinion of its own. */
export interface EstimatorService {
	/** The micro units to reserve for `request`. */
	readonly estimate: (request: BudgetRequest) => Effect.Effect<bigint>;
}

/** The rule a budget's reservations are sized by. The product provides it. */
export class Estimator extends Context.Service<Estimator, EstimatorService>()("@effectified/pi-budget/Estimator") {
	/** The same amount for every request, such as the product's ninetieth percentile of a call. */
	static fixed(micros: bigint): Layer.Layer<Estimator> {
		return Layer.succeed(Estimator, { estimate: () => Effect.succeed(micros) });
	}
}
