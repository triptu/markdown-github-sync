package io.github.triptu.notes.syncing

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * A secret such as the GitHub token, encrypted with an AES key that lives in the Android Keystore and never leaves
 * it. The file holds the IV and the ciphertext; without this phone's Keystore it can't be read.
 */
class TokenVault(private val file: File, private val alias: String = "github-token") {
    @Volatile private var cached: String? = null

    @Synchronized
    fun read(): String? {
        cached?.let { return it }
        if (!file.isFile) return null
        return try {
            val bytes = file.readBytes()
            val ivLength = bytes[0].toInt()
            val cipher = Cipher.getInstance(Transformation)
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes, 1, ivLength))
            String(cipher.doFinal(bytes, 1 + ivLength, bytes.size - 1 - ivLength), Charsets.UTF_8).also { cached = it }
        } catch (e: Exception) {
            // A key lost with a factory reset or a restore to another phone: the token must be entered again.
            null
        }
    }

    @Synchronized
    fun write(token: String) {
        val cipher = Cipher.getInstance(Transformation)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val iv = cipher.iv
        val sealed = cipher.doFinal(token.toByteArray(Charsets.UTF_8))
        file.parentFile?.mkdirs()
        val temp = File(file.parentFile, ".${file.name}.tmp")
        temp.writeBytes(byteArrayOf(iv.size.toByte()) + iv + sealed)
        check(temp.renameTo(file)) { "Couldn't save the token" }
        cached = token
    }

    @Synchronized
    fun clear() {
        cached = null
        file.delete()
    }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance(Provider).apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, Provider)
        generator.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    private companion object {
        const val Provider = "AndroidKeyStore"
        const val Transformation = "AES/GCM/NoPadding"
    }
}
