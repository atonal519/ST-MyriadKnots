# TauriTavern native storage adapter

TauriTavern exposes `extension.store` but does not run the ST-BaiNiaoData Node server plugin. This adapter implements the BaiNiao record transport on that native store. Ordinary SillyTavern/Luker and explicitly injected transports retain their HTTP behavior; global fetch and model requests are not replaced.

The API contract was checked against [TauriTavern v2.2.0 extension.store](https://github.com/Darkatse/TauriTavern/blob/v2.2.0/docs/API/Extension.md) and [v1.6.5 extension.store](https://github.com/Darkatse/TauriTavern/blob/v1.6.5/src/tauri/main/api/extension-store.js). The manifest includes the original author's name because the TT installer requires an author field.

## Older TT versions

- Prefer native `tryGetJson` whenever available, as in TT 2.2.0. A native read failure never switches to a different reader.
- TT 1.6.5 has `getJson`, `setJson`, `deleteJson`, `listKeys` and `listTables`, but no `tryGetJson`. Only in this case, check `listKeys` before calling `getJson`; an absent key is a normal missing record. Listing failures, malformed listings, read failures (including a file disappearing after the check) and corrupt JSON remain errors and cannot authorize an overwrite.
- Selection is based on available methods, not version strings. No global API is patched and no storage migration is required. Versions without the required methods still fail explicitly.
- The fallback needs an extra directory listing per read. It retains the same single-runtime locking limits described below; it is not a cross-process transaction.
- This change addresses the missing storage method, not iPad/API connection crashes. Older iOS devices still require device testing.

## Storage and compatibility

- Namespace: `qqj-bainiao-v1`; tables and record keys are hashes, not user-supplied paths.
- A single stored value holds the current record envelope and its deletion history. Get, put, list, delete, restore and permanent removal follow the backend client's expected responses and revision checks.
- JSON is serialized inside a versioned wrapper before crossing the native boundary. Rust JSON key sorting must not change JavaScript fingerprints. Older object-format records remain readable; legacy index field order is repaired only if the original fingerprint matches exactly.
- The namespace and format preserve records from the existing TT adaptation. Synthetic migration fixtures contain fictional data, not exported user chats.
- Concurrent clients share a write queue and use Web Locks where available. The public store API provides no native compare-and-swap across independent app processes or external writers.
- Cancellation prevents queued writes; a write already handed to native code can finish after cancellation. Re-read its revision before retrying.

## Validation and limits

The test transport persists to temporary files and recursively sorts object keys to simulate the native JSON boundary. Tests cover cold reads, foundation initialization, legacy failed-run recovery, corrupted data, revision conflicts, deletion history, cancellation and restart. A production bundle smoke test confirms that TT uses the native store without BaiNiao HTTP requests.

iOS device, real model API and existing user-archive end-to-end validation are still pending. This adapter does not migrate a SillyTavern server's data directory and does not add cross-device synchronization.
