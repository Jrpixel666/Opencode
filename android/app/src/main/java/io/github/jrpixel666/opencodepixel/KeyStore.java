package io.github.jrpixel666.opencodepixel;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.List;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Provider API keys, encrypted with an AES-GCM key that lives in the Android Keystore (it never
 * leaves the phone's secure hardware). Each key is stored with the hosts it may be sent to.
 */
final class KeyStore {
    private static final String ALIAS = "opencode-pixel-api-keys";
    private static final String PREFS = "api-keys";
    private final SharedPreferences prefs;

    KeyStore(Context ctx) {
        prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private SecretKey secret() throws Exception {
        java.security.KeyStore ks = java.security.KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(ALIAS)) return ((java.security.KeyStore.SecretKeyEntry) ks.getEntry(ALIAS, null)).getSecretKey();
        KeyGenerator gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        gen.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return gen.generateKey();
    }

    void save(String provider, String apiKey, List<String> hosts) throws Exception {
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, secret());
        byte[] ct = c.doFinal(apiKey.getBytes(StandardCharsets.UTF_8));
        JSONObject o = new JSONObject();
        o.put("iv", Base64.encodeToString(c.getIV(), Base64.NO_WRAP));
        o.put("ct", Base64.encodeToString(ct, Base64.NO_WRAP));
        o.put("hosts", new JSONArray(hosts));
        o.put("hint", apiKey.length() < 8 ? "••••" : apiKey.substring(0, 4) + "…" + apiKey.substring(apiKey.length() - 4));
        prefs.edit().putString(provider, o.toString()).apply();
    }

    void delete(String provider) {
        prefs.edit().remove(provider).apply();
    }

    /** The decrypted key, if `host` is one it may be sent to. */
    String keyFor(String provider, String host) throws IOException {
        String raw = prefs.getString(provider, null);
        if (raw == null) throw new IOException("No API key saved for this provider");
        try {
            JSONObject o = new JSONObject(raw);
            JSONArray hosts = o.getJSONArray("hosts");
            boolean allowed = false;
            for (int i = 0; i < hosts.length(); i++) if (hosts.getString(i).equalsIgnoreCase(host)) allowed = true;
            if (!allowed) throw new IOException("Blocked: this API key may not be sent to " + host);
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, secret(), new GCMParameterSpec(128, Base64.decode(o.getString("iv"), Base64.NO_WRAP)));
            return new String(c.doFinal(Base64.decode(o.getString("ct"), Base64.NO_WRAP)), StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw e;
        } catch (Exception e) {
            throw new IOException("Couldn't unlock the API key; please add it again");
        }
    }

    /** { provider: { hint, hosts } } — never the keys themselves. */
    JSONObject hints() {
        JSONObject out = new JSONObject();
        for (String provider : prefs.getAll().keySet()) {
            try {
                JSONObject o = new JSONObject(prefs.getString(provider, "{}"));
                out.put(provider, new JSONObject().put("hint", o.optString("hint")).put("hosts", o.optJSONArray("hosts")));
            } catch (Exception ignored) {
                // skip a damaged entry
            }
        }
        return out;
    }
}
