package io.github.triptu.notes.syncing

import android.content.SharedPreferences
import androidx.core.content.edit

/** The repository and branch this phone syncs with. */
data class SyncTarget(val owner: String, val repository: String, val branch: String) {
    val name: String get() = "$owner/$repository"

    companion object {
        private val Repo = Regex("""^(?:(?:https?://)?github\.com/|git@github\.com:)?([\w.-]+)/([\w.-]+?)(?:\.git)?/?$""", RegexOption.IGNORE_CASE)
        private val BranchName = Regex("""^(?!/)(?!.*//)(?!.*\.\.)(?!.*@\{)[^\s~^:?*\[\\]+(?<![/.])$""")

        /** Accepts `owner/name` or a GitHub URL. Null when it isn't one. */
        fun parseRepository(text: String): Pair<String, String>? =
            Repo.find(text.trim())?.let { it.groupValues[1] to it.groupValues[2] }

        fun isValidBranch(text: String): Boolean = text.isNotEmpty() && !text.endsWith(".lock") && BranchName.matches(text)
    }
}

/** Where sync points, kept in plain preferences. The token is not here: see [TokenVault]. */
class SyncPrefs(private val prefs: SharedPreferences) {
    var target: SyncTarget?
        get() {
            val owner = prefs.getString(Keys.Owner, null) ?: return null
            val repository = prefs.getString(Keys.Repository, null) ?: return null
            return SyncTarget(owner, repository, prefs.getString(Keys.Branch, null) ?: "main")
        }
        set(value) = prefs.edit {
            if (value == null) {
                remove(Keys.Owner); remove(Keys.Repository); remove(Keys.Branch)
            } else {
                putString(Keys.Owner, value.owner); putString(Keys.Repository, value.repository); putString(Keys.Branch, value.branch)
            }
        }

    /** The first-run setup screen was shown (and finished or skipped). */
    var setupOffered: Boolean
        get() = prefs.getBoolean(Keys.SetupOffered, false)
        set(value) = prefs.edit { putBoolean(Keys.SetupOffered, value) }

    private object Keys {
        const val Owner = "owner"
        const val Repository = "repository"
        const val Branch = "branch"
        const val SetupOffered = "setupOffered"
    }
}
