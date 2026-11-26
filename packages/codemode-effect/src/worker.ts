// The entry of `@effectified/pi-codemode/worker`: Pi's worker-thread entry, for a bundled host. A file of the host's
// build that imports this module is the worker `WorkerSandbox.make` starts, passed as its `workerUrl`; importing it
// starts the worker, so it exports nothing.

import "@earendil-works/pi-codemode/worker";
