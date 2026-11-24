package com.johnhaup.cloudsync

import android.accounts.Account
import android.app.Activity
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts.StartIntentSenderForResult
import com.google.android.gms.auth.api.identity.AuthorizationClient
import com.google.android.gms.auth.api.identity.AuthorizationRequest
import com.google.android.gms.auth.api.identity.ClearTokenRequest
import com.google.android.gms.auth.api.identity.Identity
import com.google.android.gms.auth.api.identity.RevokeAccessRequest
import com.google.android.gms.common.api.Scope
import com.google.android.gms.tasks.Task
import expo.modules.kotlin.activityresult.AppContextActivityResultContract
import expo.modules.kotlin.activityresult.AppContextActivityResultLauncher
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.Serializable
import java.util.UUID
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine

private val DRIVE_APPDATA = Scope("https://www.googleapis.com/auth/drive.appdata")

class CloudSyncModule : Module() {
  private val consentContract = ConsentContract()
  private lateinit var consent: AppContextActivityResultLauncher<ConsentInput, ConsentResult>

  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("cloud-sync: no React context")

  private fun client(): AuthorizationClient =
    appContext.currentActivity?.let { Identity.getAuthorizationClient(it) } ?: Identity.getAuthorizationClient(context)

  override fun definition() = ModuleDefinition {
    Name("CloudSync")

    RegisterActivityContracts {
      consent = registerForActivityResult(consentContract)
    }

    AsyncFunction("deviceIdAsync") {
      DeviceId.read(context.noBackupFilesDir)
    }

    /**
     * An access token for drive.appdata, or null when the user has not granted it. Once granted, the same call
     * returns a token with no UI. `interactive` shows Google's account picker and consent when needed.
     */
    AsyncFunction("authorizeAsync") Coroutine { interactive: Boolean ->
      val client = client()
      val request = AuthorizationRequest.builder().setRequestedScopes(listOf(DRIVE_APPDATA)).build()
      val result = client.authorize(request).await()
      if (!result.hasResolution()) return@Coroutine result.accessToken
      val pendingIntent = result.pendingIntent
      if (!interactive || pendingIntent == null) return@Coroutine null
      consentContract.pendingIntent = pendingIntent
      val outcome = consent.launch(ConsentInput())
      if (outcome.resultCode != Activity.RESULT_OK || outcome.data == null) return@Coroutine null
      client.getAuthorizationResultFromIntent(outcome.data).accessToken
    }

    /** Drops a token Drive refused (401), so the next authorize fetches a fresh one. */
    AsyncFunction("clearTokenAsync") Coroutine { token: String ->
      client().clearToken(ClearTokenRequest.builder().setToken(token).build()).await()
      Unit
    }

    /** Sign out: revokes the drive.appdata grant of this Google account. */
    AsyncFunction("revokeAccessAsync") Coroutine { email: String ->
      val request = RevokeAccessRequest.builder()
        .setAccount(Account(email, "com.google"))
        .setScopes(listOf(DRIVE_APPDATA))
        .build()
      client().revokeAccess(request).await()
      Unit
    }
  }
}

/** The launcher's input must be Serializable; a PendingIntent is not, so the contract holds it. */
internal class ConsentInput : Serializable

internal data class ConsentResult(val resultCode: Int, val data: Intent?)

/** Launches the consent PendingIntent through Expo's activity result registry (its intent-sender path). */
internal class ConsentContract : AppContextActivityResultContract<ConsentInput, ConsentResult> {
  var pendingIntent: PendingIntent? = null

  override fun createIntent(context: Context, input: ConsentInput): Intent {
    val request = IntentSenderRequest.Builder(pendingIntent ?: throw IllegalStateException("cloud-sync: no consent intent")).build()
    return Intent(StartIntentSenderForResult.ACTION_INTENT_SENDER_REQUEST)
      .putExtra(StartIntentSenderForResult.EXTRA_INTENT_SENDER_REQUEST, request)
  }

  override fun parseResult(input: ConsentInput, resultCode: Int, intent: Intent?) = ConsentResult(resultCode, intent)
}

private suspend fun <T> Task<T>.await(): T = suspendCancellableCoroutine { continuation ->
  addOnSuccessListener { continuation.resume(it) }
  addOnFailureListener { continuation.resumeWithException(it) }
  addOnCanceledListener { continuation.cancel() }
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
