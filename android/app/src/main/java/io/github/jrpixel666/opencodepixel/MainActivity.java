package io.github.jrpixel666.opencodepixel;

import android.Manifest;
import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.os.SystemClock;
import android.provider.MediaStore;
import android.speech.RecognizerIntent;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.Reader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * opencode·pixel: a standalone AI chat app. The interface is bundled in assets/web and served
 * from https://app.opencode.local inside this WebView. This activity adds what the page can't do
 * safely by itself: it keeps API keys (encrypted, see KeyStore) and makes provider requests with
 * them, so the page never sees a key. It also handles the camera, voice typing, notifications,
 * keep-screen-on, files, sharing, system bar colours and the back gesture.
 */
public class MainActivity extends Activity {
    static final String HOST = "app.opencode.local";
    private static final String ORIGIN = "https://" + HOST + "/";
    private static final String CHANNEL = "replies";
    private static final int REQ_FILES = 1, REQ_CAMERA = 2, REQ_SPEECH = 3, REQ_NOTIFY = 4, REQ_SAVE = 5;

    private WebView web;
    private FrameLayout root;
    private KeyStore keys;
    private ValueCallback<Uri[]> fileCallback;
    private Uri cameraUri;
    private String pendingSave;
    private boolean inForeground;

    private final ExecutorService pool = Executors.newCachedThreadPool();
    private final Map<String, HttpURLConnection> requests = new ConcurrentHashMap<>();
    private final java.util.Set<String> aborted = Collections.newSetFromMap(new ConcurrentHashMap<>());

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        keys = new KeyStore(this);
        getWindow().setDecorFitsSystemWindows(false);

        root = new FrameLayout(this);
        root.setBackgroundColor(getColor(R.color.bg));
        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));
        setContentView(root);

        // Edge to edge: keep the page clear of the status bar, gesture bar, cutout and keyboard.
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            Insets i = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
            v.setPadding(i.left, i.top, i.right, i.bottom);
            return WindowInsets.CONSUMED;
        });

        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportMultipleWindows(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setUserAgentString(s.getUserAgentString() + " OpencodePixel/" + BuildConfig.VERSION_NAME);

        web.addJavascriptInterface(new Bridge(), "OpencodeAndroid");
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());

        NotificationChannel ch = new NotificationChannel(CHANNEL, getString(R.string.channel_name), NotificationManager.IMPORTANCE_DEFAULT);
        ch.setDescription(getString(R.string.channel_desc));
        getSystemService(NotificationManager.class).createNotificationChannel(ch);

        if (state != null && web.restoreState(state) != null) return;
        String q = query(getIntent());
        web.loadUrl(ORIGIN + "index.html" + (q.isEmpty() ? "" : "?" + q));
    }

    /** Turns a share, shortcut or notification intent into the page's query string. */
    private String query(Intent intent) {
        if (intent == null) return "";
        if (Intent.ACTION_SEND.equals(intent.getAction())) {
            String text = intent.getStringExtra(Intent.EXTRA_TEXT);
            String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
            String all = (subject != null ? subject + "\n" : "") + (text != null ? text : "");
            return all.isEmpty() ? "" : "text=" + Uri.encode(all);
        }
        String chat = intent.getStringExtra("chat");
        if (chat != null) return "chat=" + Uri.encode(chat);
        Uri data = intent.getData();
        if (data != null && "ocp".equals(data.getScheme())) {
            String page = data.getQueryParameter("page");
            if (page != null) return "page=" + Uri.encode(page);
            if (data.getQueryParameter("new") != null) return "new=1";
        }
        return "";
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String q = query(intent);
        if (!q.isEmpty()) js("window.__ocpOpen && window.__ocpOpen(" + JSONObject.quote(q) + ")");
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        // The page turns its drawer, pages and sheets into history entries, so "back" closes them.
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onResume() {
        super.onResume();
        inForeground = true;
        web.onResume();
    }

    @Override
    protected void onPause() {
        // JavaScript keeps running, so a reply that's streaming in can finish and notify you.
        inForeground = false;
        web.onPause();
        super.onPause();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onDestroy() {
        for (HttpURLConnection c : requests.values()) c.disconnect();
        pool.shutdownNow();
        web.destroy();
        super.onDestroy();
    }

    private void js(String code) {
        runOnUiThread(() -> web.evaluateJavascript(code, null));
    }

    // ── activity results: camera, files, voice, export ───────────────────────────────────

    @Override
    protected void onActivityResult(int req, int result, Intent data) {
        super.onActivityResult(req, result, data);
        if (req == REQ_FILES || req == REQ_CAMERA) {
            Uri[] uris = null;
            if (result == RESULT_OK) {
                if (req == REQ_CAMERA) uris = new Uri[] {cameraUri};
                else if (data != null) uris = urisFrom(data);
            } else if (req == REQ_CAMERA && cameraUri != null) {
                getContentResolver().delete(cameraUri, null, null);
            }
            if (fileCallback != null) fileCallback.onReceiveValue(uris);
            fileCallback = null;
            cameraUri = null;
        } else if (req == REQ_SPEECH) {
            String text = "";
            if (result == RESULT_OK && data != null) {
                ArrayList<String> r = data.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS);
                if (r != null && !r.isEmpty()) text = r.get(0);
            }
            js("window.__ocpDictation && window.__ocpDictation(" + JSONObject.quote(text) + ")");
        } else if (req == REQ_SAVE) {
            String content = pendingSave;
            pendingSave = null;
            if (result != RESULT_OK || data == null || data.getData() == null || content == null) {
                js("window.__ocpSaved && window.__ocpSaved(false, '')");
                return;
            }
            Uri uri = data.getData();
            pool.execute(() -> {
                try (OutputStream os = getContentResolver().openOutputStream(uri)) {
                    os.write(content.getBytes(StandardCharsets.UTF_8));
                    js("window.__ocpSaved && window.__ocpSaved(true)");
                } catch (IOException e) {
                    js("window.__ocpSaved && window.__ocpSaved(false, " + JSONObject.quote(e.getMessage()) + ")");
                }
            });
        }
    }

    private static Uri[] urisFrom(Intent data) {
        ClipData clip = data.getClipData();
        if (clip != null && clip.getItemCount() > 0) {
            Uri[] out = new Uri[clip.getItemCount()];
            for (int i = 0; i < out.length; i++) out[i] = clip.getItemAt(i).getUri();
            return out;
        }
        return data.getData() != null ? new Uri[] {data.getData()} : null;
    }

    @Override
    public void onRequestPermissionsResult(int req, String[] perms, int[] grants) {
        super.onRequestPermissionsResult(req, perms, grants);
        if (req == REQ_NOTIFY) {
            boolean ok = grants.length > 0 && grants[0] == PackageManager.PERMISSION_GRANTED;
            js("window.__ocpNotifyPermission && window.__ocpNotifyPermission(" + ok + ")");
        }
    }

    private boolean canNotify() {
        return checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }

    // ── provider requests ────────────────────────────────────────────────────────────────

    /** Header names the page may not set itself: auth is added here, from the key store. */
    private static boolean reserved(String header) {
        String h = header.toLowerCase();
        return h.equals("authorization") || h.equals("x-api-key") || h.equals("x-goog-api-key") || h.equals("host") || h.equals("cookie");
    }

    private void runRequest(String id, JSONObject spec) {
        HttpURLConnection conn = null;
        try {
            URL url = new URL(spec.getString("url"));
            String scheme = url.getProtocol();
            if (!scheme.equals("https") && !scheme.equals("http")) throw new IOException("Unsupported URL");
            String provider = spec.optString("provider", "");
            String auth = spec.optString("auth", "none");

            conn = (HttpURLConnection) url.openConnection();
            requests.put(id, conn);
            conn.setRequestMethod(spec.optString("method", "POST"));
            conn.setConnectTimeout(20_000);
            conn.setReadTimeout(300_000); // thinking models can pause for a long time
            conn.setInstanceFollowRedirects(false);
            conn.setUseCaches(false);
            JSONObject headers = spec.optJSONObject("headers");
            if (headers != null) {
                for (Iterator<String> it = headers.keys(); it.hasNext(); ) {
                    String k = it.next();
                    if (!reserved(k)) conn.setRequestProperty(k, headers.getString(k));
                }
            }
            if (!"none".equals(auth)) {
                String key = keys.keyFor(provider, url.getAuthority());
                if ("bearer".equals(auth)) conn.setRequestProperty("Authorization", "Bearer " + key);
                else if ("x-api-key".equals(auth)) conn.setRequestProperty("x-api-key", key);
                else if ("x-goog-api-key".equals(auth)) conn.setRequestProperty("x-goog-api-key", key);
                else throw new IOException("Unknown auth style");
            }
            String body = spec.isNull("body") ? null : spec.optString("body", null);
            if (body != null) {
                byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
                conn.setDoOutput(true);
                conn.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream os = conn.getOutputStream()) {
                    os.write(bytes);
                }
            }

            int status = conn.getResponseCode();
            js("window.__ocpNet.head(" + JSONObject.quote(id) + "," + status + ")");
            InputStream in = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
            if (in != null) {
                try (Reader r = new InputStreamReader(in, StandardCharsets.UTF_8)) {
                    char[] buf = new char[8192];
                    StringBuilder pending = new StringBuilder();
                    long lastFlush = SystemClock.uptimeMillis();
                    int n;
                    while ((n = r.read(buf)) != -1) {
                        pending.append(buf, 0, n);
                        long now = SystemClock.uptimeMillis();
                        // Batch small SSE events (~30 fps) so the page isn't flooded with calls.
                        if (now - lastFlush > 33 || pending.length() > 32_000) {
                            js("window.__ocpNet.chunk(" + JSONObject.quote(id) + "," + JSONObject.quote(pending.toString()) + ")");
                            pending.setLength(0);
                            lastFlush = now;
                        }
                    }
                    if (pending.length() > 0) js("window.__ocpNet.chunk(" + JSONObject.quote(id) + "," + JSONObject.quote(pending.toString()) + ")");
                }
            }
            js("window.__ocpNet.end(" + JSONObject.quote(id) + ")");
        } catch (Exception e) {
            if (!aborted.remove(id)) {
                String msg = e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName();
                if (e instanceof java.net.UnknownHostException) msg = "No internet connection (or the address is wrong)";
                else if (e instanceof java.net.SocketTimeoutException) msg = "The provider took too long to respond";
                js("window.__ocpNet.fail(" + JSONObject.quote(id) + "," + JSONObject.quote(msg) + ")");
            }
        } finally {
            requests.remove(id);
            aborted.remove(id);
            if (conn != null) conn.disconnect();
        }
    }

    // ── the page ↔ app bridge ────────────────────────────────────────────────────────────

    /** Exposed to the page as window.OpencodeAndroid. */
    private class Bridge {
        @JavascriptInterface
        public String version() {
            return BuildConfig.VERSION_NAME;
        }

        @JavascriptInterface
        public void request(String id, String specJson) {
            try {
                JSONObject spec = new JSONObject(specJson);
                pool.execute(() -> runRequest(id, spec));
            } catch (Exception e) {
                js("window.__ocpNet.fail(" + JSONObject.quote(id) + "," + JSONObject.quote("Bad request") + ")");
            }
        }

        @JavascriptInterface
        public void abort(String id) {
            aborted.add(id);
            HttpURLConnection c = requests.get(id);
            if (c != null) pool.execute(c::disconnect);
        }

        /** Saves an API key, allowed only for the given hosts. Returns "" or an error. */
        @JavascriptInterface
        public String saveKey(String provider, String key, String hostsJson) {
            try {
                JSONArray arr = new JSONArray(hostsJson);
                ArrayList<String> hosts = new ArrayList<>();
                for (int i = 0; i < arr.length(); i++) hosts.add(arr.getString(i));
                if (key == null || key.trim().isEmpty()) return "Enter a key";
                if (hosts.isEmpty()) return "This provider has no address";
                keys.save(provider, key.trim(), hosts);
                return "";
            } catch (Exception e) {
                return "Couldn't save the key: " + e.getMessage();
            }
        }

        @JavascriptInterface
        public void deleteKey(String provider) {
            keys.delete(provider);
        }

        @JavascriptInterface
        public String keyHints() {
            return keys.hints().toString();
        }

        @JavascriptInterface
        public void setTheme(String color, boolean dark) {
            runOnUiThread(() -> {
                try {
                    root.setBackgroundColor(Color.parseColor(color));
                } catch (IllegalArgumentException ignored) {
                    return;
                }
                WindowInsetsController c = getWindow().getInsetsController();
                if (c == null) return;
                int light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                c.setSystemBarsAppearance(dark ? 0 : light, light);
            });
        }

        @JavascriptInterface
        public void keepScreenOn(boolean on) {
            runOnUiThread(() -> {
                if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            });
        }

        @JavascriptInterface
        public void startDictation() {
            runOnUiThread(() -> {
                Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                        .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                        .putExtra(RecognizerIntent.EXTRA_PROMPT, getString(R.string.speak_prompt));
                try {
                    startActivityForResult(i, REQ_SPEECH);
                } catch (ActivityNotFoundException e) {
                    js("window.__ocpDictation && window.__ocpDictation('', 'Voice typing is not available on this phone')");
                }
            });
        }

        @JavascriptInterface
        public boolean canNotify() {
            return MainActivity.this.canNotify();
        }

        @JavascriptInterface
        public void requestNotifications() {
            runOnUiThread(() -> {
                if (MainActivity.this.canNotify()) js("window.__ocpNotifyPermission && window.__ocpNotifyPermission(true)");
                else requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFY);
            });
        }

        /** Shows a notification, but only while the app is in the background. */
        @JavascriptInterface
        public void notify(String title, String body, String chatId) {
            if (inForeground || !MainActivity.this.canNotify()) return;
            Intent open = new Intent(MainActivity.this, MainActivity.class).putExtra("chat", chatId);
            int code = chatId == null ? 0 : chatId.hashCode();
            PendingIntent pi = PendingIntent.getActivity(MainActivity.this, code, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            Notification n = new Notification.Builder(MainActivity.this, CHANNEL)
                    .setSmallIcon(R.drawable.ic_launcher_foreground)
                    .setColor(getColor(R.color.accent))
                    .setContentTitle(title)
                    .setContentText(body)
                    .setContentIntent(pi)
                    .setAutoCancel(true)
                    .build();
            getSystemService(NotificationManager.class).notify(code, n);
        }

        @JavascriptInterface
        public void share(String title, String text) {
            runOnUiThread(() -> {
                Intent send = new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_SUBJECT, title).putExtra(Intent.EXTRA_TEXT, text);
                startActivity(Intent.createChooser(send, title));
            });
        }

        /** Lets you pick where to save a file (used for exporting chats). */
        @JavascriptInterface
        public void saveFile(String name, String mime, String content) {
            runOnUiThread(() -> {
                pendingSave = content;
                Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(mime).putExtra(Intent.EXTRA_TITLE, name);
                try {
                    startActivityForResult(i, REQ_SAVE);
                } catch (ActivityNotFoundException e) {
                    pendingSave = null;
                    js("window.__ocpSaved && window.__ocpSaved(false, 'No app can save files')");
                }
            });
        }
    }

    // ── web view clients ─────────────────────────────────────────────────────────────────

    private class Client extends WebViewClient {
        /** Serves the bundled interface from assets/web at https://app.opencode.local/. */
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
            Uri u = req.getUrl();
            if (!HOST.equals(u.getHost())) return null;
            String path = u.getPath() == null || u.getPath().equals("/") ? "/index.html" : u.getPath();
            if (path.contains("..")) return notFound();
            try {
                InputStream in = getAssets().open("web" + path);
                Map<String, String> headers = new HashMap<>();
                headers.put("Cache-Control", "no-cache");
                return new WebResourceResponse(mime(path), "utf-8", 200, "OK", headers, in);
            } catch (IOException e) {
                return notFound();
            }
        }

        private WebResourceResponse notFound() {
            return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", new HashMap<>(), new java.io.ByteArrayInputStream(new byte[0]));
        }

        private String mime(String path) {
            if (path.endsWith(".html")) return "text/html";
            if (path.endsWith(".js")) return "text/javascript";
            if (path.endsWith(".css")) return "text/css";
            if (path.endsWith(".json")) return "application/json";
            if (path.endsWith(".svg")) return "image/svg+xml";
            if (path.endsWith(".png")) return "image/png";
            return "application/octet-stream";
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
            Uri u = req.getUrl();
            if (HOST.equals(u.getHost())) return false;
            // Links in replies, provider websites, etc. open in the browser.
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, u).addCategory(Intent.CATEGORY_BROWSABLE));
            } catch (ActivityNotFoundException ignored) {
                // nothing can open it
            }
            return true;
        }
    }

    private class Chrome extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            try {
                if (params.isCaptureEnabled()) {
                    ContentValues cv = new ContentValues();
                    cv.put(MediaStore.Images.Media.DISPLAY_NAME, "opencode-" + System.currentTimeMillis() + ".jpg");
                    cv.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
                    cv.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/opencode");
                    cameraUri = getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, cv);
                    Intent i = new Intent(MediaStore.ACTION_IMAGE_CAPTURE).putExtra(MediaStore.EXTRA_OUTPUT, cameraUri).addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                    startActivityForResult(i, REQ_CAMERA);
                } else {
                    Intent i = params.createIntent();
                    if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                    startActivityForResult(i, REQ_FILES);
                }
            } catch (Exception e) {
                fileCallback = null;
                cameraUri = null;
                return false;
            }
            return true;
        }
    }
}
