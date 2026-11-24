import ExpoModulesCore
import Foundation

public class CloudSyncModule: Module {
  public func definition() -> ModuleDefinition {
    Name("CloudSync")

    AsyncFunction("deviceIdAsync") { () throws -> String in
      try DeviceId.read()
    }
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
