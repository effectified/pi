// The landing page: what the library is, the packages as the stack they form, what the composition rules out, the
// way of one piece of work through it, and where a person and an agent go next.

import { GUARANTEES, KIND_MEANING, KINDS, type Kind, STEPS } from "../content.ts";
import type { Facts, Package } from "./facts.ts";
import { docsPage, packagePage, shell } from "./layout.ts";
import { safe } from "./markdown.ts";
import type { Skill } from "./skills.ts";

/** The landing page. `example` is the composition's own example, as its README has it. */
export function landing(facts: Facts, skills: ReadonlyArray<Skill>, example: string): string {
	const tests = facts.packages.reduce((sum, pkg) => sum + pkg.tests, 0);
	const count = facts.packages.length;
	const body = `<main>
<section class="hero">
<div class="pitch">
<h1>Pi's durable agents, as Effect layers</h1>
<p class="lede">pi-effect puts Pi's agent harness into Effect, and adds what a product otherwise writes by hand around an agent loop: what a thread may call, what it may spend, which model serves it, what is recorded, and who reads the answer before it stands.</p>
<p>One call works a thread to its end. A process that is killed on the way picks the thread up where it stopped.</p>
<p class="go"><a class="primary" href="${docsPage("quickstart.md")}">Read the Quickstart</a><a href="${docsPage("index.md")}">All documentation</a></p>
<p class="ground">${count} packages, ${tests.toLocaleString("en-US")} tests on Node ${safe(facts.ranOn.node)} and Bun ${safe(facts.ranOn.bun)}. For Pi ${safe(facts.pi)} and Effect ${safe(facts.effect.replace(/^~/, ""))}.</p>
</div>
${stack(facts)}
</section>

<section id="guarantees">
<h2>What it rules out</h2>
<p class="intro">Each line is something that cannot happen in a thread, and the mechanism that makes it so. The limits are written down as well: <a href="${packagePage("thread-effect")}#gaps">what does not fit yet</a>.</p>
<dl class="claims">
${GUARANTEES.map((item) => `<dt>${safe(item.claim)}</dt>\n<dd>${safe(item.how)}${by(facts, item.by)}</dd>`).join("\n")}
</dl>
</section>

<section id="path">
<h2>One piece of work, start to end</h2>
<p class="intro">Hooks are asked in the order their extensions are installed, and the models are layers of wrappers, so the order is the behaviour. The composition fixes it once.</p>
<ol class="steps">
${STEPS.map((step) => `<li><div><h3>${safe(step.title)}</h3><p>${safe(step.text)}${by(facts, step.by)}</p></div></li>`).join("\n")}
</ol>
</section>

<section id="packages">
<h2>The packages</h2>
<p class="intro">Every package stands alone and depends only on what is below it. Each name leads to its reference, which is its README: the examples in it are run by the package's own tests. <a href="${docsPage("packages.md")}">Packages</a> lists their entry points.</p>
${KINDS.map((kind) => group(facts, kind)).join("\n")}
</section>

<section id="thread">
<h2>A thread in a product</h2>
<p class="intro">The product supplies its tools, policies and prices as data, and its lease, its sinks and its inbox as services. Nothing in the packages knows a product.</p>
<div class="wide">
<pre><code class="language-ts">${safe(example)}</code></pre>
</div>
<div class="prose">
<p>This is the example of <a href="${packagePage("thread-effect")}#the-composition">the composition's README</a>. The packages are not published. A product keeps them as built workspace packages, written by <code>node effect/scripts/vendor.ts &lt;directory&gt;</code> in the pi-effect repository.</p>
</div>
<div class="two">
<div>
<h3>In one process</h3>
<p><code>Composition.open</code> runs a harness on a storage the product gives, such as a SQLite file. A swarm's forks are conversations of that storage.</p>
<p><a href="${docsPage("threads.md")}">Build an Agent Thread</a></p>
</div>
<div>
<h3>As one actor per thread</h3>
<p><code>ThreadActor</code> runs the same composition in a Rivet actor. The actor's SQLite is the storage, its schedule wakes sleeping work, and a swarm's fork is a fork of the actor. A local engine runs beside the process for development.</p>
<p><a href="${docsPage("rivet.md")}">Host Threads in Rivet Actors</a></p>
</div>
</div>
</section>

<section id="upstream">
<h2>Keeping up with Pi</h2>
<p class="intro">Pi changes often. A change there reaches these packages through its types, or stops the build and names what moved. It does not pass in silence. <a href="${docsPage("upstream-sync.md")}">Keep Up with Pi</a> is the procedure.</p>
<dl class="means">
<div><dt>Types come from Pi's</dt><dd>A type that Pi defines is taken from Pi with <code>Pick</code>, <code>Extract</code> or a mapped type. A choice over a Pi union is exhaustive, so a member Pi adds does not compile until someone decides what to do with it.</dd></div>
<div><dt>What stays hand-written is asserted</dt><dd>A package that mirrors a Pi type by hand has a type-only conformance file, which holds its schemas and its list of wrapped methods against Pi's.<br><code>packages/&lt;name&gt;/test/pi-conformance.ts</code></dd></div>
<div><dt>The Pi surface in use is on record</dt><dd>Every Pi declaration the packages import is written down, with the packages that use it. After a sync, the check prints what changed under which package.<br><code>node effect/scripts/pi-surface.ts --check</code></dd></div>
<div><dt>A sync is two commands</dt><dd>One moves the pins, the lockfile and the record and runs every check. The other proves the pins are the Pi sources in the tree.<br><code>node effect/scripts/sync.ts bump</code> <code>node effect/scripts/sync.ts check</code></dd></div>
<div><dt>One gate</dt><dd>Lint, types, Effect's own diagnostics, the rules of the fork, and every package's tests on Node and on Bun. It changes no file.<br><code>node effect/scripts/gate.ts</code></dd></div>
</dl>
</section>

<section id="agents">
<h2>For agents</h2>
<p class="intro">A coding agent needs different things from a person: which package, which export, the order that must not change, and what is not guaranteed. The documentation is written to serve both. A skill is how an agent finds the right page of it: a name, a description that says when it applies, and a pointer to the page.</p>
<div class="table wide"><table>
<thead><tr><th>Skill</th><th>Read it when</th></tr></thead>
<tbody>
${skills.map((skill) => `<tr><td class="name"><code>${safe(skill.name)}</code></td><td>${safe(skill.description)}</td></tr>`).join("\n")}
</tbody>
</table></div>
<div class="prose">
<p><a href="${docsPage("agents.md")}">Give Agents the Skills</a> links them into a project, where an agent's harness looks. The skills follow the Agent Skills specification, and the package declares them as a Pi package does, so Pi reads them too.</p>
<p>An agent that reads a site first can start from <a href="llms.txt"><code>llms.txt</code></a>: every page, every package and every skill, one line each, with a link to its Markdown.</p>
</div>
</section>
</main>
<script>
// The stack says what a package is for when it is pointed at or focused.
const caption = document.querySelector(".stack .caption");
const idle = caption.textContent;
for (const chip of document.querySelectorAll("a.chip")) {
	const show = () => {
		const name = document.createElement("strong");
		name.textContent = chip.textContent;
		caption.replaceChildren(name, " " + chip.dataset.role);
	};
	const rest = () => { caption.textContent = idle; };
	chip.addEventListener("mouseenter", show);
	chip.addEventListener("focus", show);
	chip.addEventListener("mouseleave", rest);
	chip.addEventListener("blur", rest);
}
</script>`;
	return shell(
		{
			path: "index.html",
			title: "pi-effect: Pi's durable agents, as Effect layers",
			description: `${count} packages that put Pi's durable agent harness into Effect, with guards, budgets, routing, records, review, approvals, subagents and swarms composed into one agent thread.`,
		},
		"landing",
		body,
		facts,
	);
}

/** The packages as the stack they form: the product on top, Pi at the bottom, each facade on the package it wraps. */
function stack(facts: Facts): string {
	const chip = (pkg: Package) =>
		`<a class="chip" data-kind="${pkg.kind}" href="${safe(packagePage(pkg.directory))}" data-role="${safe(pkg.role)}">${safe(pkg.directory)}</a>`;
	const band = (kind: Kind, label: string, columns: boolean) =>
		`<div class="band" data-kind="${kind}"><span class="band-name">${safe(label)}</span><div class="chips${columns ? " columns" : ""}">${facts.packages
			.filter((pkg) => pkg.kind === kind)
			.map(chip)
			.join("")}</div></div>`;
	const wrapped = facts.packages
		.filter((pkg) => pkg.kind === "facade")
		.map((pkg) => `<span class="chip">pi-${safe(pkg.directory.replace(/-effect$/, ""))}</span>`);
	return `<div class="stack" role="group" aria-label="The packages as a stack, from the product down to Pi">
<div class="band outside"><span class="band-name">Your product</span><span class="band-note">Tools, policies and prices as data. A lease, a record sink, an outcome sink and an inbox as services.</span></div>
${band("composition", "Composition", false)}
${band("plugin", "Plugins", false)}
${band("host", "Host", false)}
${band("facade", "Facades", true)}
<div class="band outside"><span class="band-name">Pi ${safe(facts.pi)}</span><div class="chips columns">${wrapped.join("")}</div></div>
<p class="caption" aria-live="polite">Each layer depends only on the layers below it. Point at a package to see what it is for, and choose it to read its documentation.</p>
</div>`;
}

/** The packages of one kind as a table. */
function group(facts: Facts, kind: Kind): string {
	const members = facts.packages.filter((pkg) => pkg.kind === kind);
	return `<div class="group" data-kind="${kind}">
<h3>${safe(KIND_MEANING[kind].plural)}</h3>
<p>${safe(KIND_MEANING[kind].meaning)}</p>
<div class="table"><table>
<thead><tr><th>Package</th><th>What it does</th><th class="count">Tests</th></tr></thead>
<tbody>
${members.map((pkg) => `<tr><td class="name"><a href="${safe(packagePage(pkg.directory))}">${safe(pkg.directory)}</a></td><td>${safe(pkg.description)}</td><td class="count">${pkg.tests}</td></tr>`).join("\n")}
</tbody>
</table></div>
</div>`;
}

/** The packages behind a line, as links coloured by their kind. */
function by(facts: Facts, directories: ReadonlyArray<string>): string {
	const links = directories.map((directory) => {
		const pkg = facts.packages.find((found) => found.directory === directory);
		if (pkg === undefined) throw new Error(`content.ts names ${directory}, which is no package`);
		return `<a data-kind="${pkg.kind}" href="${safe(packagePage(directory))}">${safe(directory)}</a>`;
	});
	return `<span class="by">${links.join("")}</span>`;
}
