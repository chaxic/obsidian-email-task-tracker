/**
 * Passphrase encryption for the tracker file, using the platform WebCrypto API.
 *
 * v3 layout: a random AES-256-GCM data key encrypts the payload. The data key is
 * stored in "slots", each wrapped by a key derived (PBKDF2-SHA-256) from either
 * your passphrase or your recovery key, so either one can unlock the file and
 * changing the passphrase doesn't invalidate the recovery key.
 *
 * v2 files (key derived straight from the passphrase) still open and are
 * upgraded on unlock.
 */

export const KDF_ITERATIONS = 600_000;
/** The recovery key is 160 random bits, so it needs far less stretching than a passphrase. */
export const RECOVERY_KDF_ITERATIONS = 100_000;
const AAD = new TextEncoder().encode("email-task-tracker:v2");
const slotAad = (type: SlotType) => new TextEncoder().encode(`email-task-tracker:slot:${type}`);

export interface KdfParams {
	name: "PBKDF2-SHA256";
	iterations: number;
	salt: string;
}

export type SlotType = "passphrase" | "recovery";

export interface KeySlot {
	type: SlotType;
	kdf: KdfParams;
	iv: string;
	wrapped: string;
	createdAt: string;
}

export interface EnvelopeV2 {
	version: 2;
	encrypted: true;
	kdf: KdfParams;
	iv: string;
	data: string;
}

export interface EnvelopeV3 {
	version: 3;
	encrypted: true;
	slots: KeySlot[];
	iv: string;
	data: string;
}

export type EncryptedEnvelope = EnvelopeV2 | EnvelopeV3;

export class WrongPassphraseError extends Error {
	constructor() {
		super("Wrong passphrase");
		this.name = "WrongPassphraseError";
	}
}

/** The file was encrypted by a newer version of the plugin, in a format this one can't read. */
export class UnsupportedVersionError extends Error {
	constructor() {
		super("Saved by a newer version of the plugin");
		this.name = "UnsupportedVersionError";
	}
}

const subtle = () => globalThis.crypto.subtle;
const randomBytes = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n));

export function newKdfParams(iterations = KDF_ITERATIONS): KdfParams {
	return { name: "PBKDF2-SHA256", iterations, salt: toBase64(randomBytes(16)) };
}

async function pbkdf2(secret: string, kdf: KdfParams, algorithm: AesKeyGenParams, usages: KeyUsage[]): Promise<CryptoKey> {
	const base = await subtle().importKey("raw", new TextEncoder().encode(secret), "PBKDF2", false, ["deriveKey"]);
	return subtle().deriveKey(
		{ name: "PBKDF2", hash: "SHA-256", salt: fromBase64(kdf.salt) as BufferSource, iterations: kdf.iterations },
		base,
		algorithm,
		false,
		usages,
	);
}

// ── v3: data key + slots ──────────────────────────────────────────────────

/**
 * The data key lives only in memory. It stays extractable so it can be re-wrapped
 * when you change your passphrase or recovery key; it's never written unwrapped.
 */
export function generateDataKey(): Promise<CryptoKey> {
	return subtle().generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]) as Promise<CryptoKey>;
}

export async function makeSlot(type: SlotType, secret: string, dataKey: CryptoKey): Promise<KeySlot> {
	const kdf = newKdfParams(type === "recovery" ? RECOVERY_KDF_ITERATIONS : KDF_ITERATIONS);
	const kek = await pbkdf2(secret, kdf, { name: "AES-GCM", length: 256 }, ["wrapKey", "unwrapKey"]);
	const iv = randomBytes(12);
	const wrapped = await subtle().wrapKey("raw", dataKey, kek, { name: "AES-GCM", iv, additionalData: slotAad(type) });
	return { type, kdf, iv: toBase64(iv), wrapped: toBase64(new Uint8Array(wrapped)), createdAt: new Date().toISOString() };
}

export async function openSlot(slot: KeySlot, secret: string): Promise<CryptoKey> {
	const kek = await pbkdf2(secret, slot.kdf, { name: "AES-GCM", length: 256 }, ["wrapKey", "unwrapKey"]);
	try {
		return await subtle().unwrapKey(
			"raw",
			fromBase64(slot.wrapped) as BufferSource,
			kek,
			{ name: "AES-GCM", iv: fromBase64(slot.iv) as BufferSource, additionalData: slotAad(slot.type) },
			{ name: "AES-GCM", length: 256 },
			true,
			["encrypt", "decrypt"],
		);
	} catch {
		throw new WrongPassphraseError();
	}
}

export async function sealPayload(dataKey: CryptoKey, slots: KeySlot[], payload: unknown): Promise<EnvelopeV3> {
	const iv = randomBytes(12);
	const plain = new TextEncoder().encode(JSON.stringify(payload));
	const cipher = await subtle().encrypt({ name: "AES-GCM", iv, additionalData: AAD }, dataKey, plain);
	return { version: 3, encrypted: true, slots, iv: toBase64(iv), data: toBase64(new Uint8Array(cipher)) };
}

export async function openPayload(dataKey: CryptoKey, env: { iv: string; data: string }): Promise<unknown> {
	try {
		const plain = await subtle().decrypt(
			{ name: "AES-GCM", iv: fromBase64(env.iv) as BufferSource, additionalData: AAD },
			dataKey,
			fromBase64(env.data) as BufferSource,
		);
		return JSON.parse(new TextDecoder().decode(plain));
	} catch {
		throw new WrongPassphraseError();
	}
}

// ── v2 (legacy): key derived straight from the passphrase ─────────────────

export function deriveKey(passphrase: string, kdf: KdfParams): Promise<CryptoKey> {
	return pbkdf2(passphrase, kdf, { name: "AES-GCM", length: 256 }, ["encrypt", "decrypt"]);
}

export async function encryptJson(key: CryptoKey, kdf: KdfParams, payload: unknown): Promise<EnvelopeV2> {
	const iv = randomBytes(12);
	const plain = new TextEncoder().encode(JSON.stringify(payload));
	const cipher = await subtle().encrypt({ name: "AES-GCM", iv, additionalData: AAD }, key, plain);
	return { version: 2, encrypted: true, kdf, iv: toBase64(iv), data: toBase64(new Uint8Array(cipher)) };
}

export const decryptJson = openPayload;

export function isEncryptedEnvelope(v: unknown): v is EncryptedEnvelope {
	return !!v && typeof v === "object" && (v as EncryptedEnvelope).encrypted === true;
}

// ── Recovery keys ─────────────────────────────────────────────────────────

/** Crockford base32: no I, L, O or U, so the key is easy to read and type. */
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 160 random bits as 32 characters in groups of four, e.g. 7K2F-QW9M-… */
export function newRecoveryKey(): string {
	const bytes = randomBytes(20);
	let bits = 0;
	let value = 0;
	let out = "";
	for (const b of bytes) {
		value = (value << 8) | b;
		bits += 8;
		while (bits >= 5) {
			out += B32[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	return out.match(/.{4}/g)!.join("-");
}

/** Accepts any case, spaces or dashes, and the usual look-alikes (O→0, I/L→1). */
export function normaliseRecoveryKey(input: string): string {
	const s = input
		.toUpperCase()
		.replace(/[\s-]/g, "")
		.replace(/O/g, "0")
		.replace(/[IL]/g, "1");
	return s.match(/.{1,4}/g)?.join("-") ?? "";
}

function toBase64(bytes: Uint8Array): string {
	let bin = "";
	for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(bin);
}

function fromBase64(s: string): Uint8Array {
	const bin = atob(s);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}
