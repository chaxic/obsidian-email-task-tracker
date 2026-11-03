import { describe, expect, it } from "vitest";
import { RecordStore, migrate, type Persistence } from "../src/store/records";
import {
	KDF_ITERATIONS,
	UnsupportedVersionError,
	WrongPassphraseError,
	deriveKey,
	encryptJson,
	newKdfParams,
	newRecoveryKey,
	normaliseRecoveryKey,
} from "../src/store/crypto";

class MemoryFile implements Persistence {
	data: string | null = null;
	writes: string[] = [];
	async load() {
		return this.data;
	}
	async save(d: string) {
		this.data = d;
		this.writes.push(d);
	}
}

const v1Categories = [
	{ id: "g", name: "Gaming", parentId: null, priority: 0, color: "#000", rule: { anyOf: [], allOf: [], noneOf: [], senders: [], domains: [], fields: ["subject"] }, trackAsTask: false, dateGranularity: "week" },
	{ id: "u", name: "Unity", parentId: "g", priority: 1, color: "#111", rule: { anyOf: ["unity"], allOf: [], noneOf: [], senders: [], domains: [], fields: ["subject"] }, trackAsTask: false, dateGranularity: "week" },
];
const v1Records = [
	{ id: "r1", fingerprint: "f1", messageId: null, subject: "Unity licence", from: "a@example.com", fromDomain: "example.com", date: "2026-11-01T00:00:00.000Z", importedAt: "2026-11-01T00:00:00.000Z", source: "eml", categoryId: "u", manual: false, matchedKeywords: ["unity"], keywords: ["unity", "licence"] },
	{ id: "r2", fingerprint: "f2", messageId: null, subject: "Lunch", from: "b@example.com", fromDomain: "example.com", date: "2026-11-01T00:00:00.000Z", importedAt: "2026-11-01T00:00:00.000Z", source: "eml", categoryId: null, manual: false, matchedKeywords: [], keywords: ["lunch"] },
];

describe("v1 migration", () => {
	it("turns parentId into parentIds and categoryId into a full path", () => {
		const out = migrate(v1Categories as never, v1Records as never);
		expect(out.categories.map((c) => [c.id, c.parentIds])).toEqual([["g", []], ["u", ["g"]]]);
		expect(out.categories[0]).not.toHaveProperty("priority");
		expect(out.records[0].paths).toEqual([["g", "u"]]);
		expect(out.records[1].paths).toEqual([]);
		expect(out.records[0]).not.toHaveProperty("categoryId");
	});

	it("loads a v1 records file with categories taken from data.json", async () => {
		const file = new MemoryFile();
		file.data = JSON.stringify({ version: 1, records: v1Records });
		const store = new RecordStore(file);
		await store.load(v1Categories);
		expect(store.categories).toHaveLength(2);
		expect(store.records[0].paths).toEqual([["g", "u"]]);
		await store.save();
		const saved = JSON.parse(file.data!);
		expect(saved.version).toBe(2);
		expect(saved.categories).toHaveLength(2);
	});
});

describe("encryption", () => {
	async function encryptedStore() {
		const file = new MemoryFile();
		const store = new RecordStore(file);
		await store.load();
		const m = migrate(v1Categories as never, v1Records as never);
		store.categories = m.categories;
		store.records = m.records;
		const recoveryKey = await store.enableEncryption("correct horse battery staple");
		return { file, store, recoveryKey };
	}

	it("writes no plaintext subjects, senders, keywords or category names", async () => {
		const { file } = await encryptedStore();
		const raw = file.data!;
		for (const secret of ["Unity", "licence", "a@example.com", "Gaming", "unity", "Lunch"]) expect(raw).not.toContain(secret);
		const env = JSON.parse(raw);
		expect(env.encrypted).toBe(true);
		expect(env.version).toBe(3);
		expect(env.slots.map((s: { type: string }) => s.type).sort()).toEqual(["passphrase", "recovery"]);
		expect(env.slots.find((s: { type: string }) => s.type === "passphrase").kdf.iterations).toBe(KDF_ITERATIONS);
	}, 30_000);

	it("round-trips, rejects a wrong passphrase, and locks", async () => {
		const { file, store } = await encryptedStore();
		const reopened = new RecordStore(file);
		await reopened.load();
		expect(reopened.locked).toBe(true);
		expect(reopened.records).toEqual([]);
		await expect(reopened.unlock("wrong passphrase!!")).rejects.toBeInstanceOf(WrongPassphraseError);
		await reopened.unlock("correct horse battery staple");
		expect(reopened.locked).toBe(false);
		expect(reopened.records.map((r) => r.subject)).toEqual(["Unity licence", "Lunch"]);
		await reopened.lock();
		expect(reopened.locked).toBe(true);
		expect(reopened.records).toEqual([]);
		await expect(reopened.save()).rejects.toThrow("locked");
		void store;
	}, 30_000);

	it("uses a fresh IV for every save", async () => {
		const { file, store } = await encryptedStore();
		await store.save();
		const [a, b] = file.writes.slice(-2).map((w) => JSON.parse(w));
		expect(a.iv).not.toBe(b.iv);
		expect(a.data).not.toBe(b.data);
	}, 30_000);

	it("can be turned off again", async () => {
		const { file, store } = await encryptedStore();
		await store.disableEncryption();
		const plain = JSON.parse(file.data!);
		expect(plain.encrypted).toBe(false);
		expect(plain.records[0].subject).toBe("Unity licence");
	}, 30_000);
});

describe("change notifications", () => {
	it("a listener that re-subscribes during notify runs once and doesn't loop", async () => {
		const store = new RecordStore(new MemoryFile());
		await store.load();
		let calls = 0;
		let unsub: () => void = () => {};
		// Mirrors the settings tab: on each change it unsubscribes and subscribes again.
		const subscribe = () => {
			unsub = store.onChange(() => {
				calls++;
				if (calls > 50) throw new Error("notify looped");
				unsub();
				subscribe();
			});
		};
		subscribe();
		await store.save();
		expect(calls).toBe(1);
		await store.save();
		expect(calls).toBe(2);
	});

	it("listeners added during a notification wait for the next one", async () => {
		const store = new RecordStore(new MemoryFile());
		await store.load();
		let late = 0;
		store.onChange(() => void store.onChange(() => late++));
		await store.save();
		expect(late).toBe(0);
	});
});

describe("recovery key", () => {
	async function setup() {
		const file = new MemoryFile();
		const store = new RecordStore(file);
		await store.load();
		const m = migrate(v1Categories as never, v1Records as never);
		store.categories = m.categories;
		store.records = m.records;
		const recoveryKey = await store.enableEncryption("correct horse battery staple");
		return { file, store, recoveryKey };
	}
	const reopen = async (file: MemoryFile) => {
		const s = new RecordStore(file);
		await s.load();
		return s;
	};

	it("is 32 readable characters and normalises sloppy input", () => {
		const key = newRecoveryKey();
		expect(key).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){7}[0-9A-HJKMNP-TV-Z]{4}$/);
		expect(normaliseRecoveryKey(key.toLowerCase().replace(/-/g, " "))).toBe(key);
		expect(normaliseRecoveryKey("abcO-ilxx")).toBe("ABC0-11XX");
	});

	it("unlocks without the passphrase, and wrong keys are rejected", async () => {
		const { file, recoveryKey } = await setup();
		const s = await reopen(file);
		expect(s.hasRecoveryKey).toBe(true);
		await expect(s.unlockWithRecoveryKey(newRecoveryKey())).rejects.toBeInstanceOf(WrongPassphraseError);
		await s.unlockWithRecoveryKey(recoveryKey.toLowerCase());
		expect(s.records).toHaveLength(2);
	}, 60_000);

	it("survives a passphrase change; a new recovery key replaces the old one", async () => {
		const { file, store, recoveryKey } = await setup();
		await store.changePassphrase("a brand new passphrase");
		let s = await reopen(file);
		await expect(s.unlock("correct horse battery staple")).rejects.toBeInstanceOf(WrongPassphraseError);
		await s.unlock("a brand new passphrase");
		s = await reopen(file);
		await s.unlockWithRecoveryKey(recoveryKey);
		const fresh = await s.regenerateRecoveryKey();
		s = await reopen(file);
		await expect(s.unlockWithRecoveryKey(recoveryKey)).rejects.toBeInstanceOf(WrongPassphraseError);
		await s.unlockWithRecoveryKey(fresh);
		expect(s.records).toHaveLength(2);
	}, 60_000);

	it("opens an older v2 file and upgrades it, flagging the missing recovery key", async () => {
		const file = new MemoryFile();
		const m = migrate(v1Categories as never, v1Records as never);
		const kdf = newKdfParams();
		file.data = JSON.stringify(await encryptJson(await deriveKey("old passphrase here", kdf), kdf, m));
		const s = await reopen(file);
		expect(s.locked).toBe(true);
		await s.unlock("old passphrase here");
		expect(s.records).toHaveLength(2);
		expect(s.upgradedWithoutRecovery).toBe(true);
		expect(s.hasRecoveryKey).toBe(false);
		expect(JSON.parse(file.data!).version).toBe(3);
		const again = await reopen(file);
		await again.unlock("old passphrase here");
		expect(again.records).toHaveLength(2);
	}, 60_000);
});

describe("damaged files", () => {
	class BackedUpFile extends MemoryFile {
		backups: (string | null)[] = [];
		async backup() {
			this.backups.push(this.data);
			return "records.backup-1.json";
		}
	}

	it("starts empty on unreadable JSON, after keeping a copy", async () => {
		const file = new BackedUpFile();
		file.data = "{not json";
		const store = new RecordStore(file);
		await store.load();
		expect(store.records).toEqual([]);
		expect(store.problem).toEqual({ kind: "unreadable", count: 0, backupPath: "records.backup-1.json" });
		expect(file.backups).toEqual(["{not json"]);
		expect(file.writes).toEqual([]);
	});

	it("skips unusable entries, counts them and keeps a copy", async () => {
		const file = new BackedUpFile();
		file.data = JSON.stringify({ version: 2, encrypted: false, categories: [...v1Categories, { id: "bad" }], records: [...v1Records, { id: "r3" }, 5] });
		const store = new RecordStore(file);
		await store.load();
		expect(store.records).toHaveLength(2);
		expect(store.categories).toHaveLength(2);
		expect(store.problem).toMatchObject({ kind: "dropped", count: 3 });
		expect(file.backups).toHaveLength(1);
	});

	it("reports nothing for a clean file", async () => {
		const file = new BackedUpFile();
		file.data = JSON.stringify({ version: 2, encrypted: false, categories: v1Categories, records: [] });
		const store = new RecordStore(file);
		await store.load();
		expect(store.problem).toBeNull();
		expect(file.backups).toEqual([]);
	});
});

describe("locking and confirming", () => {
	async function encrypted() {
		const file = new MemoryFile();
		const store = new RecordStore(file);
		await store.load();
		const m = migrate(v1Categories as never, v1Records as never);
		store.categories = m.categories;
		store.records = m.records;
		const recoveryKey = await store.enableEncryption("correct horse battery staple");
		return { file, store, recoveryKey };
	}

	it("re-encrypts the file on lock, even if it was replaced with plain text", async () => {
		const { file, store } = await encrypted();
		file.data = JSON.stringify({ version: 2, encrypted: false, categories: [], records: [] });
		expect(await store.lock()).toBe(true);
		expect(store.locked).toBe(true);
		const env = JSON.parse(file.data!);
		expect(env.encrypted).toBe(true);
		expect(file.data).not.toContain("Unity");
		await store.unlock("correct horse battery staple");
		expect(store.records).toHaveLength(2);
	}, 60_000);

	it("won't claim to lock a store that isn't encrypted", async () => {
		const store = new RecordStore(new MemoryFile());
		await store.load();
		expect(await store.lock()).toBe(false);
		expect(store.locked).toBe(false);
	});

	it("confirms with the passphrase or the recovery key, and rejects anything else", async () => {
		const { store, recoveryKey } = await encrypted();
		await store.confirmSecret("correct horse battery staple");
		await store.confirmSecret(recoveryKey.toLowerCase());
		await expect(store.confirmSecret("not it at all!")).rejects.toBeInstanceOf(WrongPassphraseError);
	}, 60_000);

	it("says a file from a newer version is unsupported, not that the passphrase is wrong", async () => {
		const { file } = await encrypted();
		file.data = JSON.stringify({ ...JSON.parse(file.data!), version: 4 });
		const store = new RecordStore(file);
		await store.load();
		expect(store.locked).toBe(true);
		await expect(store.unlock("correct horse battery staple")).rejects.toBeInstanceOf(UnsupportedVersionError);
	}, 60_000);
});
