# TauriTavern native storage adapter

TauriTavern 2.2.0 exposes `extension.store` but does not run the ST-BaiNiaoData Node server plugin. This adapter implements the BaiNiao record transport on that native store. Ordinary SillyTavern/Luker and explicitly injected transports retain their HTTP behavior; global fetch and model requests are not replaced.

The API contract was checked against [TauriTavern v2.2.0 extension.store](https://github.com/Darkatse/TauriTavern/blob/v2.2.0/docs/API/Extension.md) and the compatible [v2.4.0 API](https://github.com/Darkatse/TauriTavern/blob/v2.4.0/docs/API/Extension.md). The manifest includes the original author's name because the TT installer requires an author field.

## Storage and compatibility

- Namespace: `qqj-bainiao-v1`; tables and record keys are hashes, not user-supplied paths.
- A single stored value holds the current record envelope and its deletion history. Get, put, list, delete, restore and permanent removal follow the backend client's expected responses and revision checks.
- JSON is serialized inside a versioned wrapper before crossing the native boundary. Rust JSON key sorting must not change JavaScript fingerprints. Older object-format records remain readable; legacy index field order is repaired only if the original fingerprint matches exactly.
- The namespace and format preserve records from the existing TT adaptation. Synthetic migration fixtures contain fictional data, not exported user chats.
- Concurrent clients share a write queue and use Web Locks where available. The public store API provides no native compare-and-swap across independent app processes or external writers.
- Cancellation prevents queued writes; a write already handed to native code can finish after cancellation. Re-read its revision before retrying.
- Record batches contain up to 64 IDs and read at most eight native files concurrently. The batch holds the shared queue until all submitted reads finish, including after cancellation, so writes remain isolated from reads.
- TT can use the existing IndexedDB core-record cache. Each load checks the native root before reusing records for that exact root version; edits, imports and undo retain their version checks. The cache switch is available under Settings → Memory settings and takes effect after a page reload. Disabling or unavailable IndexedDB reads from native storage instead.
- Automatic large exports write a single `.qqj-memory` file through the browser file API, or through an OPFS temporary file and TT 2.4's public `download()` helper. The file contains the existing volume checksums and final manifest; imports read it by ranges. Environments without those file capabilities automatically submit the existing separate volumes and manifest to the host downloader. Browser download permissions still apply.

## Validation and limits

The test transport persists to temporary files and recursively sorts object keys to simulate the native JSON boundary. Tests cover bounded batch reads, cold and cached reads, manual edits, import and undo, foundation initialization, legacy failed-run recovery, corrupted data, revision conflicts, deletion history, cancellation and restart. A production bundle test confirms that TT uses the native store without BaiNiao HTTP requests.

iOS device, real model API and existing user-archive end-to-end validation are still pending. This adapter does not migrate a SillyTavern server's data directory and does not add cross-device synchronization.
