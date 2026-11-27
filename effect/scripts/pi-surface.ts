// Records the Pi declarations the pi-effect packages depend on in `effect/pi-surface/<pi package>.txt`, so a sync
// shows which of them changed and which packages use each. A name a package imports from `@earendil-works/*` is a
// root; the Pi declarations its signature refers to follow it (`via` the root); `pi-surface.watch.json` adds private
// Pi code the packages restate on purpose, body included. A change of comments or layout alone is no change.
// Usage: node effect/scripts/pi-surface.ts [--check]
//   Without a flag it writes the record and prints what changed against the one it replaces. `--check` writes
//   nothing, prints what changed and exits 1 when a declaration changed, came or went, its users changed, or a
//   watched entry names nothing.
// Built on TypeScript 7.0.2's unstable API: `typescript/unstable/sync` (API, Snapshot.getProject, Program,
// Checker.getSymbolAtLocation, getAliasedSymbol, getTypeOfSymbol, typeToString, NodeHandle.resolve) and
// `typescript/unstable/ast` (SyntaxKind, the `is*` guards, createScanner). Another TypeScript version stops it with a
// message; a removed subpath stops Node before it starts (ERR_PACKAGE_PATH_NOT_EXPORTED).

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type ClassDeclaration,
	createScanner,
	isArrowFunction,
	isAsExpression,
	isBlock,
	isCallExpression,
	isClassDeclaration,
	isConstructorDeclaration,
	isEnumDeclaration,
	isExportDeclaration,
	isExpressionWithTypeArguments,
	isFunctionDeclaration,
	isFunctionExpression,
	isGetAccessorDeclaration,
	isIdentifier,
	isImportDeclaration,
	isIndexSignatureDeclaration,
	isInterfaceDeclaration,
	isMethodDeclaration,
	isModuleDeclaration,
	isNamedExports,
	isNamedImports,
	isParenthesizedExpression,
	isPrivateIdentifier,
	isPropertyAccessExpression,
	isPropertyDeclaration,
	isQualifiedName,
	isSatisfiesExpression,
	isSetAccessorDeclaration,
	isSourceFile,
	isStringLiteral,
	isTypeAliasDeclaration,
	isTypeQueryNode,
	isTypeReferenceNode,
	isVariableDeclaration,
	isVariableStatement,
	LanguageVariant,
	ModifierFlags,
	type Node,
	type SourceFile,
	SyntaxKind,
	type VariableDeclaration,
} from "typescript/unstable/ast";
import {
	API,
	type Checker,
	NodeBuilderFlags,
	type Symbol as PiSymbol,
	type Project,
	SymbolFlags,
	type Type,
} from "typescript/unstable/sync";
import { ROOT } from "./packages.ts";
import { PI_SCOPE, workspacePiPackages } from "./pins.ts";

/** One block of the record: a Pi declaration, or a watched piece of Pi code, and who depends on it. */
interface SurfaceBlock {
	/** What the header names: a declaration, `Class.member`, `name(...)` for calls, or a quoted text for lines. */
	readonly name: string;
	/** The Pi file, from `packages/`, such as `durable/src/types.ts`. */
	readonly file: string;
	readonly watched: boolean;
	/** The lines between the header and the text: `used by: ...`, and `why: ...` for a watched block. */
	readonly about: readonly string[];
	readonly text: string;
}

/** The record as files of `effect/pi-surface/`, by file name, and what kept it from being whole. */
interface Surface {
	readonly files: ReadonlyMap<string, readonly SurfaceBlock[]>;
	readonly failures: readonly string[];
	readonly roots: number;
}

const TYPESCRIPT_API_VERSION = "7.0.2";
const RECORD = join(ROOT, "effect/pi-surface");
const WATCH = join(ROOT, "effect/pi-surface.watch.json");

/** Writes or checks the record, and prints what changed. */
function main(): void {
	const check = process.argv.includes("--check");
	const started = performance.now();
	const surface = generate();
	const changes = compare(readRecord(), surface.files);
	const failed = surface.failures.length > 0 || changes.some((change) => change.kind !== "documentation");
	printChanges(changes);
	if (surface.failures.length > 0) {
		console.error("pi-surface: the record cannot be made whole:");
		for (const failure of surface.failures) console.error(`  ${failure}`);
	}
	const blocks = [...surface.files.values()].reduce((sum, list) => sum + list.length, 0);
	const seconds = ((performance.now() - started) / 1000).toFixed(1);
	if (check) {
		if (failed) {
			console.error(
				"\nRun `node effect/scripts/pi-surface.ts` and commit effect/pi-surface/ once each change is understood.",
			);
			process.exit(1);
		}
		console.log(
			`pi-surface: the record matches the tree (${blocks} blocks, ${surface.roots} imported names, ${seconds} s).`,
		);
	} else {
		if (surface.failures.length > 0) process.exit(1);
		writeRecord(surface.files);
		console.log(
			`pi-surface: wrote effect/pi-surface/ (${blocks} blocks, ${surface.roots} imported names, ${seconds} s).`,
		);
	}
}

/** The record the tree gives: the closure of every Pi name the packages import, then the watched entries. */
function generate(): Surface {
	checkTypeScript();
	const pi = piPackages();
	const api = new API({ cwd: ROOT });
	try {
		const config = join(ROOT, "effect/tsconfig.json");
		const project = api.updateSnapshot({ openProjects: [config] }).getProject(config);
		if (project === undefined) throw new Error("TypeScript opened no project for effect/tsconfig.json");
		const graph = new Graph(project, pi);
		graph.addRoots();
		graph.close();
		const blocks = [...graph.blocks(), ...watchedBlocks(project, graph.failures)];
		const files = new Map<string, SurfaceBlock[]>();
		for (const block of blocks) {
			const name = `${pi.byDirectory.get(block.file.split("/")[0]) ?? "unknown"}.txt`;
			files.set(name, [...(files.get(name) ?? []), block]);
		}
		for (const list of files.values()) list.sort(byPlace);
		return { files, failures: graph.failures, roots: graph.rootCount };
	} finally {
		api.close();
	}
}

/** Stops with a message when the installed TypeScript is not the one whose unstable API this script was written on. */
function checkTypeScript(): void {
	// Trust boundary: a manifest is a file, read as untyped JSON.
	const version: unknown = JSON.parse(
		readFileSync(fileURLToPath(import.meta.resolve("typescript/package.json")), "utf8"),
	).version;
	if (version === TYPESCRIPT_API_VERSION) return;
	console.error(
		`pi-surface.ts is written on the unstable API of TypeScript ${TYPESCRIPT_API_VERSION}, and TypeScript ${String(version)} is installed.\n` +
			"Check that the calls named in its header still behave, regenerate the record and read its diff, then set\n" +
			"TYPESCRIPT_API_VERSION in effect/scripts/pi-surface.ts.",
	);
	process.exit(1);
}

/** The Pi packages of the workspace, by directory, and a test for a path in one of their `src` directories. */
function piPackages(): PiPackages {
	const packages = workspacePiPackages();
	const byDirectory = new Map(packages.map((pkg) => [basename(pkg.directory), pkg.name.slice(PI_SCOPE.length)]));
	const directories = packages.map((pkg) => pkg.directory.replace(/[^\w/-]/g, "\\$&")).join("|");
	return { byDirectory, source: new RegExp(`^(?:${directories})/src/`) };
}

/** The Pi packages of the workspace: their names without the scope by directory, and a test for a path in a `src`. */
interface PiPackages {
	readonly byDirectory: ReadonlyMap<string, string>;
	readonly source: RegExp;
}

/** The recorded text of a declaration, the parts whose references the record follows, and symbols it follows too. */
interface Printed {
	readonly text: string;
	readonly parts: readonly Node[];
	readonly symbols: readonly PiSymbol[];
}

/** A Pi declaration the record holds: its symbol's top-level declarations and the packages that reach it. */
interface Entry {
	readonly name: string;
	readonly file: string;
	readonly nodes: readonly Node[];
	readonly symbol: PiSymbol;
	text: string;
	references: string[];
}

/** The Pi declarations reached from the packages' imports, and the edges between them. */
class Graph {
	readonly failures: string[] = [];
	rootCount = 0;
	readonly #project: Project;
	readonly #checker: Checker;
	readonly #pi: PiPackages;
	readonly #entries = new Map<string, Entry>();
	readonly #roots = new Map<string, Set<string>>();
	readonly #queue: string[] = [];

	constructor(project: Project, pi: PiPackages) {
		this.#project = project;
		this.#checker = project.checker;
		this.#pi = pi;
	}

	/** Each name a `packages/*-effect/src` file imports or re-exports from a Pi package, as a root of that package. */
	addRoots(): void {
		for (const fileName of this.#project.program.getSourceFileNames()) {
			const where = relative(ROOT, fileName);
			const match = /^packages\/([^/]+-effect)\/src\//.exec(where);
			const file = match === null ? undefined : this.#project.program.getSourceFile(fileName);
			if (match === null || file === undefined) continue;
			const names: Node[] = [];
			const everyType: Node[] = [];
			for (const statement of file.statements) {
				names.push(...this.#importedNames(statement, where));
				const module = this.#typeStarModule(statement);
				if (module !== undefined) everyType.push(module);
			}
			if (names.length === 0 && everyType.length === 0) continue;
			const roots = this.#roots.get(match[1]) ?? new Set<string>();
			this.#roots.set(match[1], roots);
			// `export type * from` a Pi package: every declaration it exports is a root of the package that re-exports it.
			for (const module of everyType) {
				const moduleSymbol = this.#checker.getSymbolAtLocation(module);
				const exported =
					moduleSymbol === undefined ? [] : this.#checker.getExportsOfModule(this.#target(moduleSymbol));
				this.rootCount += exported.length;
				for (const symbol of exported) {
					const key = this.#enqueue(this.#target(symbol));
					if (key !== undefined) roots.add(key);
				}
			}
			if (names.length === 0) continue;
			this.rootCount += names.length;
			const symbols = this.#checker.getSymbolAtLocation(names);
			for (const [index, symbol] of symbols.entries()) {
				const key = symbol === undefined ? undefined : this.#enqueue(this.#target(symbol));
				if (key !== undefined) roots.add(key);
				// A Pi package's re-export of a dependency's value (pi-tui's `Marked`, from `marked`) has no Pi
				// declaration to record; the dependency's version moves with Pi's own pin.
				else if (symbol === undefined || !this.#fromDependency(this.#target(symbol)))
					this.failures.push(`${where}: ${names[index].getText(file)} resolves to no declaration in Pi's sources`);
			}
		}
	}

	/** Prints every queued declaration and follows its type references within Pi's sources until none is new. */
	close(): void {
		for (let key = this.#queue.shift(); key !== undefined; key = this.#queue.shift()) {
			const entry = this.#entries.get(key);
			if (entry === undefined) continue;
			const parts: Node[] = [];
			const texts: string[] = [];
			const extra: PiSymbol[] = [];
			for (const node of entry.nodes) {
				const printed = this.#print(node, entry.symbol);
				texts.push(printed.text);
				parts.push(...printed.parts);
				extra.push(...printed.symbols);
			}
			entry.text = texts.join("\n");
			const names = parts.flatMap(referencedNames);
			const found = names.length === 0 ? [] : this.#checker.getSymbolAtLocation(names);
			const references = new Set<string>();
			for (const symbol of [...found, ...extra]) {
				const target = symbol === undefined ? undefined : this.#enqueue(this.#target(symbol));
				if (target !== undefined && target !== key) references.add(target);
			}
			entry.references = [...references].sort();
		}
	}

	/** The record's blocks, each with the packages that import it and those that reach it through another. */
	blocks(): SurfaceBlock[] {
		const direct = new Map<string, Set<string>>();
		const via = new Map<string, Map<string, string>>();
		for (const [pkg, roots] of [...this.#roots].sort(([a], [b]) => a.localeCompare(b))) {
			for (const root of roots) direct.set(root, (direct.get(root) ?? new Set()).add(pkg));
			// Breadth first from the package's own roots, so `via` names the nearest one.
			const reached = new Map<string, string>([...roots].sort().map((root) => [root, root]));
			const frontier = [...reached.keys()];
			for (let key = frontier.shift(); key !== undefined; key = frontier.shift()) {
				for (const next of this.#entries.get(key)?.references ?? []) {
					if (reached.has(next)) continue;
					reached.set(next, reached.get(key) ?? key);
					frontier.push(next);
				}
			}
			for (const [key, root] of reached) {
				if (roots.has(key)) continue;
				via.set(key, (via.get(key) ?? new Map()).set(pkg, this.#entries.get(root)?.name ?? root));
			}
		}
		return [...this.#entries].map(([key, entry]) => {
			const users = [...(direct.get(key) ?? [])].sort();
			const indirect = [...(via.get(key) ?? [])]
				.filter(([pkg]) => !users.includes(pkg))
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([pkg, root]) => `${pkg} via ${root}`);
			const usedBy = [users.join(", "), indirect.join(", ")].filter((part) => part !== "").join("; ");
			return { name: entry.name, file: entry.file, watched: false, about: [`used by: ${usedBy}`], text: entry.text };
		});
	}

	/** The identifiers an import or re-export from a Pi package names; an import form the record cannot follow fails. */
	#importedNames(statement: Node, where: string): Node[] {
		if (isImportDeclaration(statement)) {
			const specifier = isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : "";
			const clause = statement.importClause;
			if (!specifier.startsWith(PI_SCOPE) || clause === undefined) return [];
			if (
				clause.name !== undefined ||
				(clause.namedBindings !== undefined && !isNamedImports(clause.namedBindings))
			) {
				this.failures.push(
					`${where}: a default or namespace import of ${specifier}; import names, so they are recorded`,
				);
				return [];
			}
			return clause.namedBindings === undefined ? [] : clause.namedBindings.elements.map((element) => element.name);
		}
		if (!isExportDeclaration(statement) || statement.moduleSpecifier === undefined) return [];
		const specifier = isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : "";
		if (!specifier.startsWith(PI_SCOPE)) return [];
		// `export type * from`: every type, recorded by `#typeStarModule`.
		if (statement.exportClause === undefined && statement.isTypeOnly) return [];
		if (statement.exportClause === undefined || !isNamedExports(statement.exportClause)) {
			this.failures.push(`${where}: \`export *\` from ${specifier}; re-export names, so they are recorded`);
			return [];
		}
		return statement.exportClause.elements.map((element) => element.name);
	}

	/** The module specifier of an `export type * from` a Pi package, whose every declaration is then a root. */
	#typeStarModule(statement: Node): Node | undefined {
		if (!isExportDeclaration(statement) || statement.moduleSpecifier === undefined) return undefined;
		const specifier = isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : "";
		return specifier.startsWith(PI_SCOPE) && statement.exportClause === undefined && statement.isTypeOnly
			? statement.moduleSpecifier
			: undefined;
	}

	/** Whether every declaration of `symbol` is in an installed package (`node_modules`), not in Pi's or our sources. */
	#fromDependency(symbol: PiSymbol): boolean {
		const files = symbol.declarations.map((handle) => handle.resolve(this.#project)?.getSourceFile().fileName);
		return files.length > 0 && files.every((name) => name?.split(/[\\/]/).includes("node_modules") === true);
	}

	/**
	 * A type as text, untruncated. A type that names an unexported declaration prints its module as an absolute path
	 * (`import("/home/runner/work/pi/pi/packages/...")`): the path is made relative to the repository, so the record
	 * is the same on every machine.
	 */
	#typeText(type: Type): string {
		return this.#checker
			.typeToString(type, undefined, NodeBuilderFlags.NoTruncation)
			.replaceAll(`import("${ROOT}/`, 'import("');
	}

	#target(symbol: PiSymbol): PiSymbol {
		// `getAliasedSymbol` panics in the server on a symbol that is not an alias.
		return (symbol.flags & SymbolFlags.Alias) === 0 ? symbol : this.#checker.getAliasedSymbol(symbol);
	}

	/** The key of `symbol`'s entry, queued when new; undefined when it is not a top-level declaration of Pi's sources. */
	#enqueue(symbol: PiSymbol): string | undefined {
		const nodes: Node[] = [];
		for (const handle of symbol.declarations) {
			const node = handle.resolve(this.#project);
			if (node === undefined || !this.#pi.source.test(relative(ROOT, node.getSourceFile().fileName))) continue;
			if (isTopLevelDeclaration(node)) nodes.push(node);
		}
		if (nodes.length === 0) return undefined;
		const file = relative(join(ROOT, "packages"), nodes[0].getSourceFile().fileName);
		const key = `${file} ${symbol.name}`;
		if (!this.#entries.has(key)) {
			this.#entries.set(key, { name: symbol.name, file, nodes, symbol, text: "", references: [] });
			this.#queue.push(key);
		}
		return key;
	}

	/**
	 * The recorded text of one declaration and the parts of it whose references the record follows: types as
	 * written, functions as their signature, classes as their public members' signatures, `as const` values in full,
	 * other values as their type.
	 */
	#print(node: Node, symbol: PiSymbol): Printed {
		const file = node.getSourceFile();
		if (isFunctionDeclaration(node)) {
			return { text: signatureText(node, node.body, file), parts: functionParts(node), symbols: [] };
		}
		if (isClassDeclaration(node)) return this.#printClass(node, file);
		if (isVariableDeclaration(node)) return this.#printVariable(node, symbol, file);
		return { text: file.text.slice(node.getStart(file, true), node.end), parts: [node], symbols: [] };
	}

	#printClass(node: ClassDeclaration, file: SourceFile): Printed {
		const lines = [file.text.slice(node.getStart(file, true), node.members.pos)];
		const parts: Node[] = [...(node.typeParameters ?? []), ...(node.heritageClauses ?? [])];
		for (const member of node.members) {
			const printed = this.#printMember(member, file);
			if (printed === undefined) continue;
			lines.push(`\t${printed.text}`);
			parts.push(...printed.parts);
		}
		return { text: `${lines.join("\n")}\n}`, parts, symbols: [] };
	}

	/** A public member's signature; undefined for a member callers cannot reach or that has none. */
	#printMember(member: Node, file: SourceFile): { text: string; parts: Node[] } | undefined {
		if (isPropertyDeclaration(member)) {
			if (!isPublic(member.modifierFlags, member.name)) return undefined;
			const start = member.getStart(file, true);
			if (member.type !== undefined) return { text: file.text.slice(start, member.type.end), parts: [member.type] };
			if (member.initializer === undefined) return { text: file.text.slice(start, member.end), parts: [] };
			const type = this.#checker.getTypeAtLocation(member.name);
			const typeText = type === undefined ? "unknown" : this.#typeText(type);
			return { text: `${file.text.slice(start, member.name.end)}: ${typeText}`, parts: [] };
		}
		if (
			isMethodDeclaration(member) ||
			isGetAccessorDeclaration(member) ||
			isSetAccessorDeclaration(member) ||
			isConstructorDeclaration(member)
		) {
			if (!isPublic(member.modifierFlags, isConstructorDeclaration(member) ? undefined : member.name))
				return undefined;
			return { text: signatureText(member, member.body, file), parts: functionParts(member) };
		}
		if (isIndexSignatureDeclaration(member)) {
			return { text: file.text.slice(member.getStart(file, true), member.end), parts: [member] };
		}
		return undefined;
	}

	#printVariable(node: VariableDeclaration, symbol: PiSymbol, file: SourceFile): Printed {
		const statement = node.parent.parent;
		const head = file.text.slice(statement.getStart(file, true), node.name.end);
		const initializer = node.initializer === undefined ? undefined : unwrapped(node.initializer);
		if (node.initializer !== undefined && isAsConst(node.initializer)) {
			return { text: file.text.slice(statement.getStart(file, true), node.end), parts: [node], symbols: [] };
		}
		if (node.type !== undefined) {
			return {
				text: file.text.slice(statement.getStart(file, true), node.type.end),
				parts: [node.type],
				symbols: [],
			};
		}
		if (initializer !== undefined && (isArrowFunction(initializer) || isFunctionExpression(initializer))) {
			const signature = file.text.slice(initializer.getStart(file), initializer.body.getStart(file)).trimEnd();
			return { text: `${head} = ${signature}`, parts: functionParts(initializer), symbols: [] };
		}
		const type = this.#checker.getTypeOfSymbol(symbol);
		const named = type?.getAliasSymbol() ?? type?.getSymbol();
		const text = `${head}: ${type === undefined ? "unknown" : this.#typeText(type)}`;
		return { text, parts: [], symbols: named === undefined ? [] : [named] };
	}
}

/** A declaration the record can print: a statement of its file, or a variable declared by one. */
function isTopLevelDeclaration(node: Node): boolean {
	if (isVariableDeclaration(node))
		return isVariableStatement(node.parent.parent) && isSourceFile(node.parent.parent.parent);
	const declaration =
		isInterfaceDeclaration(node) ||
		isTypeAliasDeclaration(node) ||
		isClassDeclaration(node) ||
		isFunctionDeclaration(node) ||
		isEnumDeclaration(node) ||
		isModuleDeclaration(node);
	return declaration && isSourceFile(node.parent);
}

/** Whether callers reach a class member: it is not `private`, `protected` or `#name`. */
function isPublic(modifierFlags: ModifierFlags, name: Node | undefined): boolean {
	const hidden = (modifierFlags & (ModifierFlags.Private | ModifierFlags.Protected)) !== 0;
	return !hidden && !(name !== undefined && isPrivateIdentifier(name));
}

/** A function-like declaration's text before its body, or all of it when it has none (an overload). */
function signatureText(node: Node, body: Node | undefined, file: SourceFile): string {
	return file.text.slice(node.getStart(file, true), body === undefined ? node.end : body.getStart(file)).trimEnd();
}

/** The parts of a function-like node that make its signature: type parameters, parameters, return type. */
function functionParts(node: {
	readonly typeParameters?: readonly Node[];
	readonly parameters: readonly Node[];
	readonly type?: Node;
}): Node[] {
	return [...(node.typeParameters ?? []), ...node.parameters, ...(node.type === undefined ? [] : [node.type])];
}

/** The name nodes of every type reference, heritage expression and `typeof` query below `node`. */
function referencedNames(node: Node): Node[] {
	const found: Node[] = [];
	const visit = (child: Node): void => {
		if (isBlock(child)) return;
		if (isTypeReferenceNode(child)) found.push(rightmost(child.typeName));
		else if (isExpressionWithTypeArguments(child)) found.push(rightmost(child.expression));
		else if (isTypeQueryNode(child)) found.push(rightmost(child.exprName));
		child.forEachChild(visit);
	};
	visit(node);
	return found;
}

/** The last identifier of `A.B.C`, which names the declaration. */
function rightmost(node: Node): Node {
	if (isQualifiedName(node)) return node.right;
	if (isPropertyAccessExpression(node)) return node.name;
	return node;
}

function unwrapped(node: Node): Node {
	if (isSatisfiesExpression(node) || isParenthesizedExpression(node)) return unwrapped(node.expression);
	return node;
}

function isAsConst(node: Node): boolean {
	const inner = isSatisfiesExpression(node) || isParenthesizedExpression(node) ? unwrapped(node) : node;
	return (
		isAsExpression(inner) &&
		isTypeReferenceNode(inner.type) &&
		isIdentifier(inner.type.typeName) &&
		inner.type.typeName.text === "const"
	);
}

/** One entry of `pi-surface.watch.json`: private Pi code a package restates on purpose. */
type WatchEntry =
	| {
			readonly kind: "declaration";
			readonly file: string;
			readonly name: string;
			readonly why: string;
			readonly sites: readonly string[];
	  }
	| {
			readonly kind: "calls";
			readonly file: string;
			readonly name: string;
			readonly why: string;
			readonly sites: readonly string[];
	  }
	| {
			readonly kind: "lines";
			readonly file: string;
			readonly text: string;
			readonly why: string;
			readonly sites: readonly string[];
	  };

/** The watched entries as blocks, body included; an entry that names nothing, or a site that is gone, fails. */
function watchedBlocks(project: Project, failures: string[]): SurfaceBlock[] {
	const blocks: SurfaceBlock[] = [];
	for (const entry of readWatch(failures)) {
		for (const site of entry.sites) {
			if (!existsSync(join(ROOT, "packages", site)))
				failures.push(`pi-surface.watch.json: site ${site} does not exist`);
		}
		const about = [`used by: ${entry.sites.join(", ")}`, `why: ${entry.why}`];
		const name =
			entry.kind === "lines"
				? JSON.stringify(entry.text)
				: entry.kind === "calls"
					? `${entry.name}(...)`
					: entry.name;
		const text = watchedText(project, entry);
		if (text === undefined || text === "") {
			failures.push(`pi-surface.watch.json: ${name} is not in ${entry.file}; update or remove the entry`);
			continue;
		}
		blocks.push({ name, file: entry.file, watched: true, about, text });
	}
	return blocks;
}

/** What a watched entry names in its file: the declaration in full, each call in full, or each line containing it. */
function watchedText(project: Project, entry: WatchEntry): string | undefined {
	const path = join(ROOT, "packages", entry.file);
	if (!existsSync(path)) return undefined;
	if (entry.kind === "lines") {
		return readFileSync(path, "utf8")
			.split("\n")
			.filter((line) => line.includes(entry.text))
			.map((line) => line.trim())
			.join("\n");
	}
	const file = project.program.getSourceFile(path);
	if (file === undefined) return undefined;
	if (entry.kind === "calls") {
		const calls: string[] = [];
		const visit = (node: Node): void => {
			if (isCallExpression(node) && isIdentifier(node.expression) && node.expression.text === entry.name) {
				calls.push(file.text.slice(node.getStart(file), node.end));
			}
			node.forEachChild(visit);
		};
		visit(file);
		return calls.join("\n");
	}
	const [outer, member] = entry.name.split(".");
	for (const statement of file.statements) {
		const found = declaredName(statement) === outer ? statement : undefined;
		if (found === undefined) continue;
		if (member === undefined) return file.text.slice(found.getStart(file, true), found.end);
		if (!isClassDeclaration(found)) return undefined;
		const node = found.members.find((candidate) => memberName(candidate) === member);
		return node === undefined ? undefined : `\t${file.text.slice(node.getStart(file, true), node.end)}`;
	}
	return undefined;
}

function declaredName(statement: Node): string | undefined {
	if (isVariableStatement(statement)) {
		const [first] = statement.declarationList.declarations;
		return first !== undefined && isIdentifier(first.name) ? first.name.text : undefined;
	}
	if (
		isFunctionDeclaration(statement) ||
		isClassDeclaration(statement) ||
		isInterfaceDeclaration(statement) ||
		isTypeAliasDeclaration(statement)
	) {
		return statement.name?.text;
	}
	return undefined;
}

function memberName(member: Node): string | undefined {
	if (
		!isPropertyDeclaration(member) &&
		!isMethodDeclaration(member) &&
		!isGetAccessorDeclaration(member) &&
		!isSetAccessorDeclaration(member)
	) {
		return undefined;
	}
	return isIdentifier(member.name) || isPrivateIdentifier(member.name) ? member.name.text : undefined;
}

/** `pi-surface.watch.json`; an entry that is not one of the three kinds fails. */
function readWatch(failures: string[]): WatchEntry[] {
	// Trust boundary: the watch list is a file, read as untyped JSON and checked entry by entry.
	const entries: unknown = JSON.parse(readFileSync(WATCH, "utf8")).entries;
	if (!Array.isArray(entries)) {
		failures.push("pi-surface.watch.json: `entries` must be a list");
		return [];
	}
	return entries.flatMap((entry: Record<string, unknown>, index): WatchEntry[] => {
		const { kind, file, name, text, why, sites } = entry;
		const common =
			typeof file === "string" &&
			typeof why === "string" &&
			Array.isArray(sites) &&
			sites.every((site) => typeof site === "string");
		if (common && (kind === "declaration" || kind === "calls") && typeof name === "string") {
			return [{ kind, file, name, why, sites }];
		}
		if (common && kind === "lines" && typeof text === "string") return [{ kind, file, text, why, sites }];
		failures.push(
			`pi-surface.watch.json: entry ${index} needs kind (declaration, calls or lines), file, name or text, why and sites`,
		);
		return [];
	});
}

function byPlace(a: SurfaceBlock, b: SurfaceBlock): number {
	return a.file.localeCompare(b.file) || Number(a.watched) - Number(b.watched) || a.name.localeCompare(b.name);
}

/** A difference between the committed record and the tree's. Only `documentation` does not fail. */
type Change =
	| { readonly kind: "changed"; readonly before: SurfaceBlock; readonly after: SurfaceBlock }
	| { readonly kind: "added"; readonly after: SurfaceBlock }
	| { readonly kind: "removed"; readonly before: SurfaceBlock }
	| { readonly kind: "users"; readonly before: SurfaceBlock; readonly after: SurfaceBlock }
	| { readonly kind: "documentation"; readonly before: SurfaceBlock; readonly after: SurfaceBlock };

const HEADER = /^## (.+?) {2}(\S+?)( {2}watched)?$/;

/** The committed record, by file name; empty when there is none yet. */
function readRecord(): Map<string, SurfaceBlock[]> {
	const files = new Map<string, SurfaceBlock[]>();
	if (!existsSync(RECORD)) return files;
	for (const name of readdirSync(RECORD).filter((file) => file.endsWith(".txt"))) {
		const blocks: SurfaceBlock[] = [];
		for (const chunk of readFileSync(join(RECORD, name), "utf8").split(/\n\n(?=## )/)) {
			const lines = chunk.split("\n");
			const header = HEADER.exec(lines[0]);
			if (header === null) continue;
			let body = 1;
			while (body < lines.length && /^(?:used by|why): /.test(lines[body])) body++;
			const text = lines.slice(body).join("\n").replace(/\n+$/, "");
			blocks.push({
				name: header[1],
				file: header[2],
				watched: header[3] !== undefined,
				about: lines.slice(1, body),
				text,
			});
		}
		files.set(name, blocks);
	}
	return files;
}

function writeRecord(files: ReadonlyMap<string, readonly SurfaceBlock[]>): void {
	mkdirSync(RECORD, { recursive: true });
	for (const name of readdirSync(RECORD)) if (name.endsWith(".txt") && !files.has(name)) rmSync(join(RECORD, name));
	for (const [name, blocks] of files) {
		const head = [
			`# The declarations of @earendil-works/${name.slice(0, -".txt".length)} the pi-effect packages depend on.`,
			"# Generated by effect/scripts/pi-surface.ts; do not edit. Comments and layout do not count as a change.",
		];
		const body = blocks.map((block) => {
			const header = `## ${block.name}  ${block.file}${block.watched ? "  watched" : ""}`;
			return [header, ...block.about, block.text].join("\n");
		});
		const content = `${[head.join("\n"), ...body].join("\n\n")}\n`;
		const path = join(RECORD, name);
		if (!existsSync(path) || readFileSync(path, "utf8") !== content) writeFileSync(path, content);
	}
}

/** What differs between two records, block by block. */
function compare(
	before: ReadonlyMap<string, readonly SurfaceBlock[]>,
	after: ReadonlyMap<string, readonly SurfaceBlock[]>,
): Change[] {
	const key = (block: SurfaceBlock) => `${block.file} ${block.name} ${block.watched}`;
	const old = new Map([...before.values()].flat().map((block) => [key(block), block]));
	const now = new Map([...after.values()].flat().map((block) => [key(block), block]));
	const changes: Change[] = [];
	for (const [id, block] of now) {
		const previous = old.get(id);
		if (previous === undefined) changes.push({ kind: "added", after: block });
		else if (tokens(previous.text) !== tokens(block.text))
			changes.push({ kind: "changed", before: previous, after: block });
		else if (previous.about.join("\n") !== block.about.join("\n"))
			changes.push({ kind: "users", before: previous, after: block });
		else if (previous.text !== block.text) changes.push({ kind: "documentation", before: previous, after: block });
	}
	for (const [id, block] of old) if (!now.has(id)) changes.push({ kind: "removed", before: block });
	return changes;
}

/**
 * `text` as its tokens, one space apart: comments and layout do not count. A `}` that closes a template's
 * substitution and a `/` that starts a regular expression are scanned again, as the parser would, so the text after
 * them is not read as a comment.
 */
function tokens(text: string): string {
	const scanner = createScanner(true, LanguageVariant.Standard, text);
	const out: string[] = [];
	const templates: number[] = [];
	let depth = 0;
	let previous: SyntaxKind = SyntaxKind.Unknown;
	for (let token = scanner.scan(); token !== SyntaxKind.EndOfFile; token = scanner.scan()) {
		if (token === SyntaxKind.OpenBraceToken) depth++;
		else if (token === SyntaxKind.CloseBraceToken && templates.at(-1) === depth) {
			token = scanner.reScanTemplateToken(false);
			if (token === SyntaxKind.TemplateTail) templates.pop();
		} else if (token === SyntaxKind.CloseBraceToken) depth--;
		else if (
			(token === SyntaxKind.SlashToken || token === SyntaxKind.SlashEqualsToken) &&
			!ENDS_EXPRESSION.has(previous)
		) {
			token = scanner.reScanSlashToken();
		}
		if (token === SyntaxKind.TemplateHead) templates.push(depth);
		out.push(scanner.getTokenText());
		previous = token;
	}
	return out.join(" ");
}

const ENDS_EXPRESSION: ReadonlySet<SyntaxKind> = new Set([
	SyntaxKind.Identifier,
	SyntaxKind.PrivateIdentifier,
	SyntaxKind.NumericLiteral,
	SyntaxKind.BigIntLiteral,
	SyntaxKind.StringLiteral,
	SyntaxKind.RegularExpressionLiteral,
	SyntaxKind.NoSubstitutionTemplateLiteral,
	SyntaxKind.TemplateTail,
	SyntaxKind.CloseParenToken,
	SyntaxKind.CloseBracketToken,
	SyntaxKind.CloseBraceToken,
	SyntaxKind.ThisKeyword,
	SyntaxKind.SuperKeyword,
	SyntaxKind.TrueKeyword,
	SyntaxKind.FalseKeyword,
	SyntaxKind.NullKeyword,
	SyntaxKind.PlusPlusToken,
	SyntaxKind.MinusMinusToken,
]);

/** Prints the changes by kind, each block with its users and its old and new text. */
function printChanges(changes: readonly Change[]): void {
	const sections: [Change["kind"], string][] = [
		["changed", "Changed"],
		["added", "Added"],
		["removed", "Removed"],
		["users", "Users changed (the packages' imports moved; the declaration did not)"],
		["documentation", "Comments or layout changed (does not fail)"],
	];
	for (const [kind, title] of sections) {
		const listed = changes.filter((change) => change.kind === kind);
		if (listed.length === 0) continue;
		console.log(`\n${title} (${listed.length}):`);
		for (const change of listed) {
			const block = change.kind === "removed" ? change.before : change.after;
			console.log(`\n  ${block.name}  ${block.file}${block.watched ? "  watched" : ""}`);
			if (change.kind === "users") {
				for (const line of change.before.about) console.log(`    was ${line}`);
				for (const line of change.after.about) console.log(`    now ${line}`);
				continue;
			}
			for (const line of block.about) console.log(`    ${line}`);
			const before = change.kind === "added" ? [] : change.before.text.split("\n");
			const after = change.kind === "removed" ? [] : change.after.text.split("\n");
			for (const line of lineDiff(before, after)) console.log(`    ${line}`);
		}
	}
}

/** A line diff of two texts: `-` and `+` lines with two lines of context, `...` where unchanged lines are left out. */
function lineDiff(before: readonly string[], after: readonly string[]): string[] {
	// Longest common subsequence table, from the end, so the walk below goes forward.
	const lengths = Array.from({ length: before.length + 1 }, () => Array.from({ length: after.length + 1 }, () => 0));
	for (let i = before.length - 1; i >= 0; i--) {
		for (let j = after.length - 1; j >= 0; j--) {
			lengths[i][j] =
				before[i] === after[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
		}
	}
	const lines: { readonly mark: " " | "-" | "+"; readonly text: string }[] = [];
	let i = 0;
	let j = 0;
	while (i < before.length || j < after.length) {
		if (i < before.length && j < after.length && before[i] === after[j]) {
			lines.push({ mark: " ", text: before[i++] });
			j++;
		} else if (i < before.length && (j === after.length || lengths[i + 1][j] >= lengths[i][j + 1])) {
			lines.push({ mark: "-", text: before[i++] });
		} else lines.push({ mark: "+", text: after[j++] });
	}
	const near = (index: number) => lines.slice(Math.max(0, index - 2), index + 3).some((line) => line.mark !== " ");
	const shown: string[] = [];
	lines.forEach((line, index) => {
		if (near(index)) shown.push(`${line.mark} ${line.text}`);
		else if (shown.at(-1) !== "...") shown.push("...");
	});
	return shown;
}

// Last, so the constants and the class above are initialized when it runs.
main();
