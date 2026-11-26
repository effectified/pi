// Test helper: a PNG of a given size, one colour, written here so the image tests need no fixture file.

import { deflateSync } from "node:zlib";

/** A valid RGBA PNG `width` by `height`, every pixel opaque red. */
export function png(width: number, height: number): Uint8Array {
	const header = new Uint8Array(13);
	const view = new DataView(header.buffer);
	view.setUint32(0, width);
	view.setUint32(4, height);
	header.set([8, 6, 0, 0, 0], 8);
	// Each row: filter type 0, then its pixels.
	const rows = new Uint8Array(height * (1 + width * 4));
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) rows.set([255, 0, 0, 255], y * (1 + width * 4) + 1 + x * 4);
	}
	return concat([
		new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(rows)),
		chunk("IEND", new Uint8Array()),
	]);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
	const typed = concat([new TextEncoder().encode(type), data]);
	const out = new Uint8Array(12 + data.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, data.length);
	out.set(typed, 4);
	view.setUint32(8 + data.length, crc32(typed));
	return out;
}

function concat(parts: ReadonlyArray<Uint8Array>): Uint8Array {
	const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
	}
	return (crc ^ 0xffffffff) >>> 0;
}
