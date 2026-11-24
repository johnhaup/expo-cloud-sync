import CloudKit
import Foundation

/// A row handed over by JS (`SyncRecord` in `src/types.ts`), kept until CKSyncEngine asks for it.
struct OutgoingRow: Sendable {
  let table: String
  let id: String
  let updatedAt: Int64
  let schemaVersion: Int64
  let payload: String
  var sys: String?
}

/// Rows travel as one generic record type: a CloudKit production schema can only be deployed by hand, so it
/// must never change. Record name `<table>/<id>`, fields `t` table, `u` updated_at, `v` schema version, `p` payload.
enum RecordCoding {
  static let recordType = "Row"
  static let zoneID = CKRecordZone.ID(zoneName: "Sync", ownerName: CKCurrentUserDefaultName)

  static func recordID(table: String, id: String) -> CKRecord.ID {
    CKRecord.ID(recordName: "\(table)/\(id)", zoneID: zoneID)
  }

  /// A record to save, rebuilt on the last known server version's system fields (its change tag) when there is one.
  static func record(_ row: OutgoingRow) -> CKRecord {
    let record = row.sys.flatMap(decodeSystemFields)
      ?? CKRecord(recordType: recordType, recordID: recordID(table: row.table, id: row.id))
    record["t"] = row.table as CKRecordValue
    record["u"] = NSNumber(value: row.updatedAt)
    record["v"] = NSNumber(value: row.schemaVersion)
    record["p"] = row.payload as CKRecordValue
    return record
  }

  /// A fetched or server record as a JS `SyncRecord`; nil for anything that is not one of ours.
  static func syncRecord(_ record: CKRecord) -> [String: Any]? {
    guard record.recordType == recordType,
      let table = record["t"] as? String,
      let payload = record["p"] as? String,
      let updatedAt = (record["u"] as? NSNumber)?.int64Value
    else { return nil }
    let prefix = "\(table)/"
    let name = record.recordID.recordName
    guard name.hasPrefix(prefix) else { return nil }
    return [
      "table": table,
      "id": String(name.dropFirst(prefix.count)),
      "updatedAt": Double(updatedAt),
      "schemaVersion": (record["v"] as? NSNumber)?.intValue ?? 0,
      "payload": payload,
      "sys": encodeSystemFields(record),
    ]
  }

  static func encodeSystemFields(_ record: CKRecord) -> String {
    let coder = NSKeyedArchiver(requiringSecureCoding: true)
    record.encodeSystemFields(with: coder)
    coder.finishEncoding()
    return coder.encodedData.base64EncodedString()
  }

  static func decodeSystemFields(_ base64: String) -> CKRecord? {
    guard let data = Data(base64Encoded: base64),
      let coder = try? NSKeyedUnarchiver(forReadingFrom: data)
    else { return nil }
    coder.requiresSecureCoding = true
    defer { coder.finishDecoding() }
    guard let record = CKRecord(coder: coder), record.recordID.zoneID == zoneID else { return nil }
    return record
  }
}

/// Owns one CKSyncEngine on the private database. The engine schedules fetches and sends, keeps change
/// tokens, retries transient errors and listens for pushes; this forwards its events to JS (`EngineEvent`
/// in `src/types.ts`) and builds outgoing records from the rows JS handed over, so it never waits on JS.
/// JS persists the engine state it receives with `stateUpdate` and hands it back to `start`.
final class CloudSyncEngineHost: CKSyncEngineDelegate, @unchecked Sendable {
  private let database: CKDatabase
  private let emit: @Sendable ([String: Any]) -> Void
  private let lock = NSLock()
  private var outgoing: [CKRecord.ID: OutgoingRow] = [:]
  private var engine: CKSyncEngine?

  init(database: CKDatabase, emit: @escaping @Sendable ([String: Any]) -> Void) {
    self.database = database
    self.emit = emit
  }

  /// `state` is base64 of the JSON-encoded `CKSyncEngine.State.Serialization`; nil starts from scratch.
  func start(state: String?, pending: [OutgoingRow]) throws {
    let serialization = try state.flatMap { Data(base64Encoded: $0) }.map {
      try JSONDecoder().decode(CKSyncEngine.State.Serialization.self, from: $0)
    }
    keep(pending)
    let engine = CKSyncEngine(CKSyncEngine.Configuration(database: database, stateSerialization: serialization, delegate: self))
    if serialization == nil {
      engine.state.add(pendingDatabaseChanges: [.saveZone(CKRecordZone(zoneID: RecordCoding.zoneID))])
    }
    engine.state.add(pendingRecordZoneChanges: pending.map { .saveRecord(RecordCoding.recordID(table: $0.table, id: $0.id)) })
    lock.withLock { self.engine = engine }
  }

  func enqueue(_ rows: [OutgoingRow]) {
    keep(rows)
    currentEngine()?.state.add(pendingRecordZoneChanges: rows.map { .saveRecord(RecordCoding.recordID(table: $0.table, id: $0.id)) })
  }

  func sync() async throws {
    guard let engine = currentEngine() else { return }
    try await engine.fetchChanges()
    try await engine.sendChanges()
  }

  func stop() async {
    let engine = lock.withLock {
      let engine = self.engine
      self.engine = nil
      outgoing = [:]
      return engine
    }
    await engine?.cancelOperations()
  }

  // MARK: - Outgoing rows

  private func currentEngine() -> CKSyncEngine? {
    lock.withLock { engine }
  }

  private func keep(_ rows: [OutgoingRow]) {
    lock.withLock {
      for row in rows { outgoing[RecordCoding.recordID(table: row.table, id: row.id)] = row }
    }
  }

  private func row(_ recordID: CKRecord.ID) -> OutgoingRow? {
    lock.withLock { outgoing[recordID] }
  }

  /// Forgets a handed-over row once JS has its fate; a newer version handed over meanwhile is kept.
  private func drop(_ recordID: CKRecord.ID, updatedAt: Int64? = nil) {
    lock.withLock {
      if updatedAt == nil || outgoing[recordID]?.updatedAt == updatedAt { outgoing[recordID] = nil }
    }
  }

  private func forgetSystemFields() {
    lock.withLock {
      for key in outgoing.keys { outgoing[key]?.sys = nil }
    }
  }

  // MARK: - CKSyncEngineDelegate

  func nextRecordZoneChangeBatch(
    _ context: CKSyncEngine.SendChangesContext, syncEngine: CKSyncEngine
  ) async -> CKSyncEngine.RecordZoneChangeBatch? {
    let scope = context.options.scope
    let changes = syncEngine.state.pendingRecordZoneChanges.filter { scope.contains($0) }
    return await CKSyncEngine.RecordZoneChangeBatch(pendingChanges: changes) { recordID in
      guard let row = self.row(recordID) else {
        // Pending from a persisted state but no longer dirty in JS (or JS will hand it over again).
        syncEngine.state.remove(pendingRecordZoneChanges: [.saveRecord(recordID)])
        return nil
      }
      return RecordCoding.record(row)
    }
  }

  func handleEvent(_ event: CKSyncEngine.Event, syncEngine: CKSyncEngine) async {
    switch event {
    case .stateUpdate(let update):
      guard let data = try? JSONEncoder().encode(update.stateSerialization) else { return }
      emit(["type": "stateUpdate", "state": data.base64EncodedString()])

    case .accountChange:
      emit(["type": "accountChange"])

    case .fetchedDatabaseChanges(let changes):
      // The zone was deleted (Settings > iCloud > delete app data, a purge, an encrypted data reset):
      // recreate it here; JS forgets its change tags and hands every row over again.
      if changes.deletions.contains(where: { $0.zoneID == RecordCoding.zoneID }) {
        forgetSystemFields()
        syncEngine.state.add(pendingDatabaseChanges: [.saveZone(CKRecordZone(zoneID: RecordCoding.zoneID))])
        emit(["type": "zoneDeleted"])
      }

    case .fetchedRecordZoneChanges(let changes):
      // Deletions are ignored: rows are never deleted, only tombstoned.
      let records = changes.modifications.compactMap { RecordCoding.syncRecord($0.record) }
      if !records.isEmpty { emit(["type": "fetched", "records": records]) }

    case .sentDatabaseChanges(let sent):
      for failed in sent.failedZoneSaves {
        switch failed.error.code {
        case .quotaExceeded:
          emit(["type": "error", "reason": "quota"])
        case .networkFailure, .networkUnavailable, .zoneBusy, .serviceUnavailable, .requestRateLimited,
          .notAuthenticated, .operationCancelled:
          syncEngine.state.add(pendingDatabaseChanges: [.saveZone(failed.zone)])
        default:
          emit(["type": "error", "reason": "other", "message": failed.error.localizedDescription])
        }
      }

    case .sentRecordZoneChanges(let sent):
      handleSent(sent, syncEngine: syncEngine)

    case .willFetchChanges, .willSendChanges:
      emit(["type": "willSync"])

    case .didFetchChanges, .didSendChanges:
      emit(["type": "didSync"])

    default:
      break
    }
  }

  private func handleSent(_ sent: CKSyncEngine.Event.SentRecordZoneChanges, syncEngine: CKSyncEngine) {
    var results: [[String: Any]] = []
    var again: [CKSyncEngine.PendingRecordZoneChange] = []
    var zoneMissing = false

    for saved in sent.savedRecords {
      guard let record = RecordCoding.syncRecord(saved), let updatedAt = (saved["u"] as? NSNumber)?.int64Value else { continue }
      drop(saved.recordID, updatedAt: updatedAt)
      results.append([
        "table": record["table"]!, "id": record["id"]!, "result": "saved",
        "sys": record["sys"]!, "updatedAt": record["updatedAt"]!,
      ])
    }

    for failed in sent.failedRecordSaves {
      let recordID = failed.record.recordID
      guard let table = failed.record["t"] as? String else { continue }
      let id = String(recordID.recordName.dropFirst(table.count + 1))
      let error = failed.error
      switch error.code {
      case .serverRecordChanged:
        // JS runs `decide` against the server's version and hands the row over again if it still wins.
        if let server = error.serverRecord.flatMap(RecordCoding.syncRecord) {
          drop(recordID)
          results.append(["table": table, "id": id, "result": "conflict", "server": server])
        } else {
          again.append(.saveRecord(recordID))
        }
      case .zoneNotFound, .userDeletedZone:
        zoneMissing = true
        again.append(.saveRecord(recordID))
      case .unknownItem:
        // The server lost the record its change tag points at: save it as new.
        lock.withLock { outgoing[recordID]?.sys = nil }
        again.append(.saveRecord(recordID))
      case .quotaExceeded:
        drop(recordID)
        results.append(["table": table, "id": id, "result": "failed", "reason": "quota"])
      case .networkFailure, .networkUnavailable, .zoneBusy, .serviceUnavailable, .requestRateLimited,
        .notAuthenticated, .operationCancelled, .batchRequestFailed, .limitExceeded:
        // The engine retries these itself; pending again in case it dropped them.
        again.append(.saveRecord(recordID))
      default:
        drop(recordID)
        results.append(["table": table, "id": id, "result": "failed", "reason": "other", "message": error.localizedDescription])
      }
    }

    if zoneMissing {
      syncEngine.state.add(pendingDatabaseChanges: [.saveZone(CKRecordZone(zoneID: RecordCoding.zoneID))])
    }
    if !again.isEmpty { syncEngine.state.add(pendingRecordZoneChanges: again) }
    if !results.isEmpty { emit(["type": "sent", "results": results]) }
  }
}
