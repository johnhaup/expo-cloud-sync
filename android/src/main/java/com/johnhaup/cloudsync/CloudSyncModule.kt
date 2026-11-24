package com.johnhaup.cloudsync

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.util.UUID

class CloudSyncModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("CloudSync")

    AsyncFunction("deviceIdAsync") {
      val context = appContext.reactContext ?: throw IllegalStateException("cloud-sync: no React context")
      DeviceId.read(context.noBackupFilesDir)
    }
  }
}

/**
 * This install's id, kept in noBackupFilesDir (never in Auto Backup or a device transfer), so a
 * database restored onto another phone is noticed: its stored id no longer matches this one.
 */
internal object DeviceId {
  fun read(directory: File): String {
    val file = File(directory, "cloud-sync-device")
    if (file.exists()) {
      val stored = file.readText().trim()
      if (stored.isNotEmpty()) return stored
    }
    val id = UUID.randomUUID().toString()
    file.writeText(id)
    return id
  }
}
