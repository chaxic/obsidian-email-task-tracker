import { createHash, randomUUID } from "crypto";
import { DEFAULT_STATUS_RULES, type Category, type CategoryPath, type EmailRecord, type TrackerSettings } from "../types";
import type { ParsedEmail } from "../ingest/parse";
import { extractKeywords } from "../ingest/keywords";
import { classify, inputFromRecord, longestPaths, samePaths, type Classification } from "../classify/engine";
import { allTaskPhrases, detectPhrases } from "../classify/tasks";
import { domainOf } from "../classify/rules";
import {
	decryptJson,
	deriveKey,
	generateDataKey,
	isEncryptedEnvelope,
	makeSlot,
	newRecoveryKey,
	normaliseRecoveryKey,
	openPayload,
	openSlot,
	sealPayload,
	UnsupportedVersionError,
	WrongPassphraseError,
	type EncryptedEnvelope,
	type KeySlot,
	type SlotType,
} from "./crypto";
import { isObject, normalizeCategories, normalizeRecords } from "./validate";

export interface Persistence {
	load(): Promise<string | null>;
	save(data: string): Promise<void>;
	/** Copy the file aside before data in it is discarded. Returns where the copy went. */
	backup?(): Promise<string | null>;
}

/** Something in the file couldn't be used. A copy of the original was kept first, if possible. */
export interface StoreProblem {
	kind: "unreadable" | "dropped";
	/** How many categories and records were skipped ("dropped" only). */
	count: number;
	backupPath: string | null;
}

export type ChangeReason = "records" | "settings" | "lock";

interface Payload {
	records: EmailRecord[];
	categories: Category[];
}

interface PlainFile extends Payload {
	version: 2;
	encrypted: false;
}

export class LockedError extends Error {
	constructor() {
		super("The tracker is locked");
		this.name = "LockedError";
	}
}

/**
 * Holds categories and records in memory and persists them to one file,
 * either as plain JSON or as an encrypted envelope.
 */
export class RecordStore {
	records: EmailRecord[] = [];
	categories: Category[] = [];
	/** Set once after an older encrypted file was upgraded and still has no recovery key. */
	upgradedWithoutRecovery = false;
	/** Set by load or unlock when the file couldn't be fully read; the plugin reports and clears it. */
	problem: StoreProblem | null = null;
	private listeners = new Set<(reason: ChangeReason) => void>();
	/** In memory only while unlocked. */
	private dataKey: CryptoKey | null = null;
	/** Wrapped copies of the data key; null when encryption is off. */
	private slots: KeySlot[] | null = null;
	/** The file as read from disk while locked. */
	private envelope: EncryptedEnvelope | null = null;

	constructor(private persistence: Persistence) {}

	get encrypted(): boolean {
		return this.slots !== null || this.envelope !== null;
	}

	get locked(): boolean {
		return this.envelope !== null;
	}

	private currentSlots(): KeySlot[] {
		if (this.slots) return this.slots;
		return this.envelope?.version === 3 ? this.envelope.slots : [];
	}

	get hasRecoveryKey(): boolean {
		return this.currentSlots().some((s) => s.type === "recovery");
	}

	get recoveryKeyCreatedAt(): string | null {
		return this.currentSlots().find((s) => s.type === "recovery")?.createdAt ?? null;
	}

	/**
	 * Load the file. `legacyCategories` are the v1 categories from data.json,
	 * used when the file predates categories living here.
	 */
	async load(legacyCategories: unknown[] = []): Promise<void> {
		const raw = await this.persistence.load();
		let parsed: unknown = null;
		if (raw) {
			try {
				parsed = JSON.parse(raw);
			} catch {
				// Damaged file: keep a copy, then carry on empty rather than refusing to start.
				this.problem = { kind: "unreadable", count: 0, backupPath: await this.backup() };
				this.applyPayload({ records: [], categories: [] });
				return;
			}
		}
		if (isEncryptedEnvelope(parsed)) {
			this.envelope = parsed;
			this.slots = parsed.version === 3 && Array.isArray(parsed.slots) ? parsed.slots : null;
			this.records = [];
			this.categories = [];
			return;
		}
		const file = isObject(parsed) ? parsed : {};
		const fileCategories = Array.isArray(file.categories) ? file.categories : [];
		const records = Array.isArray(file.records) ? file.records : [];
		await this.applyChecked(fileCategories.length ? fileCategories : legacyCategories, records);
	}

	async unlock(passphrase: string): Promise<void> {
		const env = this.envelope;
		if (!env) return;
		if (env.version === 2) {
			// Older format: upgrade to a data key with a passphrase slot.
			const payload = await decryptJson(await deriveKey(passphrase, env.kdf), env);
			this.dataKey = await generateDataKey();
			this.slots = [await makeSlot("passphrase", passphrase, this.dataKey)];
			await this.finishUnlock(payload);
			this.upgradedWithoutRecovery = true;
			await this.save();
			return;
		}
		await this.unlockSlot("passphrase", passphrase);
	}

	async unlockWithRecoveryKey(recoveryKey: string): Promise<void> {
		if (!this.envelope) return;
		await this.unlockSlot("recovery", normaliseRecoveryKey(recoveryKey));
	}

	private async unlockSlot(type: SlotType, secret: string): Promise<void> {
		const env = this.envelope;
		if (env?.version !== 3) throw new UnsupportedVersionError();
		const slot = env.slots.find((s) => s.type === type);
		if (!slot) throw new WrongPassphraseError();
		const dataKey = await openSlot(slot, secret);
		const payload = await openPayload(dataKey, env);
		this.dataKey = dataKey;
		this.slots = env.slots;
		await this.finishUnlock(payload);
	}

	private async finishUnlock(payload: unknown): Promise<void> {
		this.envelope = null;
		const p = isObject(payload) ? payload : {};
		await this.applyChecked(Array.isArray(p.categories) ? p.categories : [], Array.isArray(p.records) ? p.records : []);
		this.notify("lock");
	}

	/** Migrate and validate what was read; if anything had to be skipped, keep a copy of the file first. */
	private async applyChecked(categories: unknown[], records: unknown[]): Promise<void> {
		const payload = migrate(categories, records);
		const count = categories.length + records.length - payload.categories.length - payload.records.length;
		if (count > 0) this.problem = { kind: "dropped", count, backupPath: await this.backup() };
		this.applyPayload(payload);
	}

	private async backup(): Promise<string | null> {
		try {
			return (await this.persistence.backup?.()) ?? null;
		} catch {
			return null;
		}
	}

	/**
	 * Write the current data encrypted, then forget the key and the decrypted data.
	 * Writing first means the file on disk is certain to be encrypted and up to date.
	 * Returns false if there's no key to lock with (encryption isn't set up).
	 */
	async lock(): Promise<boolean> {
		if (this.locked) return true;
		if (!this.dataKey || !this.slots) return false;
		const envelope = await sealPayload(this.dataKey, this.slots, { records: this.records, categories: this.categories });
		await this.persistence.save(JSON.stringify(envelope));
		this.envelope = envelope;
		this.dataKey = null;
		this.records = [];
		this.categories = [];
		this.notify("lock");
		return true;
	}

	/**
	 * Throws WrongPassphraseError unless `secret` is the current passphrase or recovery key.
	 * Used to confirm sensitive changes; the recovery key counts so that someone who unlocked
	 * with it (and doesn't know the passphrase) isn't shut out of these settings.
	 */
	async confirmSecret(secret: string): Promise<void> {
		const slots = this.currentSlots();
		const passphrase = slots.find((s) => s.type === "passphrase");
		const recovery = slots.find((s) => s.type === "recovery");
		try {
			if (!passphrase) throw new WrongPassphraseError();
			await openSlot(passphrase, secret);
		} catch (e) {
			if (!(e instanceof WrongPassphraseError) || !recovery) throw e;
			await openSlot(recovery, normaliseRecoveryKey(secret));
		}
	}

	async save(): Promise<void> {
		if (this.locked) throw new LockedError();
		const payload: Payload = { records: this.records, categories: this.categories };
		const data =
			this.dataKey && this.slots
				? await sealPayload(this.dataKey, this.slots, payload)
				: ({ version: 2, encrypted: false, ...payload } satisfies PlainFile);
		await this.persistence.save(JSON.stringify(data));
		this.notify("records");
	}

	/** Turn encryption on. Returns the recovery key, which is shown once and never stored. */
	async enableEncryption(passphrase: string): Promise<string> {
		if (this.locked) throw new LockedError();
		const recoveryKey = newRecoveryKey();
		this.dataKey = await generateDataKey();
		this.slots = [await makeSlot("passphrase", passphrase, this.dataKey), await makeSlot("recovery", recoveryKey, this.dataKey)];
		await this.save();
		return recoveryKey;
	}

	/** Only the passphrase slot changes, so the recovery key keeps working. */
	async changePassphrase(passphrase: string): Promise<void> {
		await this.replaceSlot("passphrase", passphrase);
	}

	/** Replaces the recovery slot; the previous recovery key stops working. */
	async regenerateRecoveryKey(): Promise<string> {
		const recoveryKey = newRecoveryKey();
		await this.replaceSlot("recovery", recoveryKey);
		this.upgradedWithoutRecovery = false;
		return recoveryKey;
	}

	private async replaceSlot(type: SlotType, secret: string): Promise<void> {
		if (this.locked) throw new LockedError();
		if (!this.dataKey || !this.slots) throw new Error("Encryption is off");
		const slot = await makeSlot(type, secret, this.dataKey);
		this.slots = [...this.slots.filter((s) => s.type !== type), slot];
		await this.save();
	}

	async disableEncryption(): Promise<void> {
		if (this.locked) throw new LockedError();
		this.dataKey = null;
		this.slots = null;
		this.upgradedWithoutRecovery = false;
		await this.save();
	}

	notify(reason: ChangeReason = "records"): void {
		// Iterate a snapshot: Set.forEach also visits entries added during the loop,
		// so a listener that re-subscribes would otherwise run forever.
		for (const fn of [...this.listeners]) fn(reason);
	}

	onChange(fn: (reason: ChangeReason) => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	hasFingerprint(fingerprint: string): boolean {
		return this.records.some((r) => r.fingerprint === fingerprint);
	}

	get(id: string): EmailRecord | undefined {
		return this.records.find((r) => r.id === id);
	}

	remove(id: string): void {
		this.records = this.records.filter((r) => r.id !== id);
	}

	purge(): void {
		this.records = [];
	}

	private applyPayload(p: Payload): void {
		this.records = p.records;
		this.categories = p.categories;
	}
}

// ── v1 → v2 migration ────────────────────────────────────────────────────

type LegacyCategory = Category & { parentId?: string | null; priority?: number };
type LegacyRecord = EmailRecord & { categoryId?: string | null; status?: unknown; due?: unknown; statusChangedAt?: unknown };

/**
 * Bring stored data up to the current shape:
 * v1 single parent/category → parentIds/paths; v0.2 per-email task status → dropped
 * (status now belongs to the task category); task fields get defaults.
 */
export function migrate(categories: unknown[], records: unknown[]): Payload {
	const oldParent = new Map<string, string | null>();
	const cats: Category[] = (categories ?? []).filter((c): c is LegacyCategory => isObject(c)).map((c) => {
		oldParent.set(c.id, c.parentId ?? null);
		const { parentId, priority, ...rest } = c;
		void priority;
		return {
			...rest,
			parentIds: rest.parentIds ?? (parentId ? [parentId] : []),
			statusRules: rest.statusRules ?? structuredClone(DEFAULT_STATUS_RULES),
			milestones: rest.milestones ?? [],
		};
	});
	const chainTo = (id: string): CategoryPath => {
		const path: CategoryPath = [];
		let cur: string | null | undefined = id;
		while (cur && !path.includes(cur) && path.length < 16) {
			path.unshift(cur);
			cur = oldParent.get(cur);
		}
		return path;
	};
	const recs: EmailRecord[] = (records ?? []).filter((r): r is LegacyRecord => isObject(r)).map((r) => {
		const { categoryId, status, due, statusChangedAt, ...rest } = r;
		void status;
		void due;
		void statusChangedAt;
		return {
			...rest,
			paths: Array.isArray(rest.paths) ? rest.paths : categoryId ? [chainTo(categoryId)] : [],
			statusPhrases: rest.statusPhrases ?? [],
		};
	});
	return { categories: normalizeCategories(cats), records: normalizeRecords(recs) };
}

// ── Building and sorting records ─────────────────────────────────────────

export function fingerprintOf(parsed: ParsedEmail): string {
	const basis = parsed.messageId ?? `${parsed.fromAddress}|${parsed.subject}|${parsed.date?.toISOString() ?? ""}`;
	return createHash("sha256").update(basis).digest("hex").slice(0, 32);
}

/** Reduce a parsed email to the reference record that is actually stored. */
export function buildRecord(
	parsed: ParsedEmail,
	result: Classification,
	settings: TrackerSettings,
	categories: Category[],
	now: Date = new Date(),
): EmailRecord {
	const record: EmailRecord = {
		id: randomUUID(),
		fingerprint: fingerprintOf(parsed),
		messageId: parsed.messageId,
		subject: settings.storeSubject ? parsed.subject : null,
		from: parsed.fromAddress,
		fromDomain: domainOf(parsed.fromAddress),
		date: (parsed.date ?? now).toISOString(),
		importedAt: now.toISOString(),
		source: parsed.source,
		paths: [],
		manual: false,
		matchedKeywords: result.matchedKeywords,
		keywords: extractKeywords(parsed.subject, parsed.body, settings.keywordCount),
		statusPhrases: detectPhrases(parsed.subject, parsed.body, allTaskPhrases(categories)),
	};
	assignPaths(record, result.paths);
	return record;
}

/** Set where a record sits, keeping only the longest routes. */
export function assignPaths(record: EmailRecord, paths: CategoryPath[]): void {
	record.paths = longestPaths(paths);
}

/**
 * Re-run filters over stored records (subject, sender and saved keywords only).
 * Hand-assigned records are never moved. Returns how many records changed.
 */
export function reclassify(
	records: EmailRecord[],
	categories: Category[],
	include: (r: EmailRecord) => boolean = () => true,
): number {
	let moved = 0;
	for (const r of records) {
		if (r.manual || !include(r)) continue;
		const result = classify(categories, inputFromRecord(r));
		if (!samePaths(result.paths, r.paths)) {
			assignPaths(r, result.paths);
			r.matchedKeywords = result.matchedKeywords;
			moved++;
		}
	}
	return moved;
}

/** Remove a category everywhere. Child categories left without a parent take its parents. */
export function deleteCategory(categories: Category[], records: EmailRecord[], id: string): Category[] {
	const cat = categories.find((c) => c.id === id);
	if (!cat) return categories;
	const rest = categories
		.filter((c) => c.id !== id)
		.map((c) => {
			if (!c.parentIds.includes(id)) return c;
			const remaining = c.parentIds.filter((p) => p !== id);
			return { ...c, parentIds: remaining.length ? remaining : [...cat.parentIds] };
		});
	for (const r of records) {
		if (!r.paths.some((p) => p.includes(id))) continue;
		r.paths = longestPaths(r.paths.map((p) => p.filter((x) => x !== id)).filter((p) => p.length));
	}
	return rest;
}

/** Detach one placement: `id` stops being a child category of `parentId`. */
export function removeFromParent(categories: Category[], records: EmailRecord[], id: string, parentId: string): Category[] {
	const out = categories.map((c) => (c.id === id ? { ...c, parentIds: c.parentIds.filter((p) => p !== parentId) } : c));
	for (const r of records) {
		const hit = r.paths.some((p) => p.some((x, i) => x === id && p[i - 1] === parentId));
		if (!hit) continue;
		// Cut the route at the parent; filters re-run afterwards decide where it goes.
		r.paths = longestPaths(
			r.paths.map((p) => {
				const i = p.findIndex((x, j) => x === id && p[j - 1] === parentId);
				return i < 0 ? p : p.slice(0, i);
			}),
		);
	}
	return out;
}
