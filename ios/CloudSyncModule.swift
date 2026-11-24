import CloudKit
import ExpoModulesCore
import Foundation

/// A `SyncRecord` from JS (`src/types.ts`).
struct SyncRecordArg: Record {
  @Field var table: String = ""
  @Field var id: String = ""
  @Field var updatedAt: Double = 0
  @Field var schemaVersion: Double = 0
  @Field var payload: String = ""
  @Field var sys: String? = nil

  var row: OutgoingRow {
    OutgoingRow(table: table, id: id, updatedAt: Int64(updatedAt), schemaVersion: Int64(schemaVersion), payload: payload, sys: sys)
  }
}

public class CloudSyncModule: Module {
  private let hostLock = NSLock()
  private var host: CloudSyncEngineHost?

  public func definition() -> ModuleDefinition {
    Name("CloudSync")

    Events("onEngineEvent")

    AsyncFunction("deviceIdAsync") { () throws -> String in
      try DeviceId.read()
    }

    AsyncFunction("accountAsync") { () async throws -> [String: Any] in
      let container = try Self.container()
      switch try await container.accountStatus() {
      case .available:
        return ["state": "available", "id": try await container.userRecordID().recordName]
      case .restricted:
        return ["state": "restricted"]
      default:
        // noAccount, couldNotDetermine, temporarilyUnavailable (signed in, needs the password again)
        return ["state": "none"]
      }
    }

    AsyncFunction("startAsync") { (state: String?, pending: [SyncRecordArg]) async throws in
      let host = try self.engineHost()
      await host.stop()
      try host.start(state: state, pending: pending.map(\.row))
    }

    AsyncFunction("enqueueAsync") { (records: [SyncRecordArg]) throws in
      try self.engineHost().enqueue(records.map(\.row))
    }

    AsyncFunction("syncAsync") { () async throws in
      try await self.engineHost().sync()
    }

    AsyncFunction("stopAsync") { () async throws in
      try await self.engineHost().stop()
    }

    AsyncFunction("wipeAsync") { () async throws in
      _ = try await Self.container().privateCloudDatabase.modifyRecordZones(saving: [], deleting: [RecordCoding.zoneID])
    }
  }

  /// The container the config plugin wrote into Info.plist (`iCloud.<bundle id>` unless overridden).
  static func container() throws -> CKContainer {
    guard let identifier = Bundle.main.object(forInfoDictionaryKey: "CloudSyncContainer") as? String, !identifier.isEmpty else {
      throw MissingContainerException()
    }
    return CKContainer(identifier: identifier)
  }

  private func engineHost() throws -> CloudSyncEngineHost {
    let database = try Self.container().privateCloudDatabase
    return hostLock.withLock {
      if let host { return host }
      let created = CloudSyncEngineHost(database: database) { [weak self] body in
        self?.sendEvent("onEngineEvent", body.mapValues { Optional($0) })
      }
      host = created
      return created
    }
  }
}

final class MissingContainerException: Exception, @unchecked Sendable {
  override var reason: String {
    "Info.plist has no CloudSyncContainer: add the @johnhaup/expo-cloud-sync config plugin and run prebuild"
  }
}

/// This install's id, kept where no backup reaches, so a database restored onto another phone
/// (device backup, Quick Start) is noticed: its stored id no longer matches this one.
enum DeviceId {
  static func read() throws -> String {
    let files = FileManager.default
    var directory = try files
      .url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
      .appendingPathComponent("cloud-sync", isDirectory: true)
    try files.createDirectory(at: directory, withIntermediateDirectories: true)
    var excluded = URLResourceValues()
    excluded.isExcludedFromBackup = true
    try directory.setResourceValues(excluded)

    var file = directory.appendingPathComponent("device")
    if let stored = try? String(contentsOf: file, encoding: .utf8)
      .trimmingCharacters(in: .whitespacesAndNewlines), !stored.isEmpty {
      return stored
    }
    let id = UUID().uuidString.lowercased()
    try id.write(to: file, atomically: true, encoding: .utf8)
    try file.setResourceValues(excluded)
    return id
  }
}
