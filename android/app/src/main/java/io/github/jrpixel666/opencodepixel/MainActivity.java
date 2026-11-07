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
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.speech.RecognizerIntent;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import org.json.JSONObject;

import java.util.ArrayList;

/**
 * A thin native shell around the opencode·pixel web app.
 *
 * The app itself is served by the bridge on your computer; this activity shows it full screen
 * and adds what a browser tab can't: a first-run server setup, camera and file picking,
 * Google voice typing, notifications, keep-screen-on, system bar colours, the back gesture,
 * the Android share sheet and launcher shortcuts.
 */
public class MainActivity extends Activity {
    private static final String SETUP = "file:///android_asset/setup.html";
    private static final String PREFS = "ocp";
    private static final String KEY_SERVER = "server";
    private static final String CHANNEL = "replies";
    private static final int REQ_FILES = 1, REQ_CAMERA = 2, REQ_SPEECH = 3, REQ_NOTIFY = 4;

    private WebView web;
    private FrameLayout root;
    private ValueCallback<Uri[]> fileCallback;
    private Uri cameraUri;
    private boolean inForeground;
    private boolean clearHistoryOnLoad;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setDecorFitsSystemWindows(false);

        root = new FrameLayout(this);
        root.setBackgroundColor(getColor(R.color.bg));
        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));
        setContentView(root);

        // Edge to edge: pad the web view by the status bar, gesture bar, cutout and keyboard,
        // so the page never sits underneath them.
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            Insets i = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
            v.setPadding(i.left, i.top, i.right, i.bottom);
            return WindowInsets.CONSUMED;
        });

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportMultipleWindows(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setUserAgentString(s.getUserAgentString() + " OpencodePixelAndroid/" + BuildConfig.VERSION_NAME);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);

        web.addJavascriptInterface(new Bridge(), "OpencodeAndroid");
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());

        createNotificationChannel();

        if (state != null && web.restoreState(state) != null) return;
        open(getIntent());
    }

    // ── navigation ───────────────────────────────────────────────────────────────────────

    private String server() {
        return getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_SERVER, null);
    }

    private void open(Intent intent) {
        String server = server();
        if (server == null) {
            web.loadUrl(SETUP);
            return;
        }
        clearHistoryOnLoad = true;
        web.loadUrl(server + "/" + query(intent));
    }

    /** Turns a share, shortcut or notification intent into the web app's query string. */
    private String query(Intent intent) {
        if (intent == null) return "";
        if (Intent.ACTION_SEND.equals(intent.getAction())) {
            String text = intent.getStringExtra(Intent.EXTRA_TEXT);
            String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
            String all = (subject != null ? subject + "\n" : "") + (text != null ? text : "");
            return all.isEmpty() ? "" : "?text=" + Uri.encode(all);
        }
        String session = intent.getStringExtra("session");
        if (session != null) return "?session=" + Uri.encode(session);
        Uri data = intent.getData();
        if (data != null && "ocp".equals(data.getScheme())) {
            String page = data.getQueryParameter("page");
            if (page != null) return "?page=" + Uri.encode(page);
            if (data.getQueryParameter("new") != null) return "?new=1";
        }
        return "";
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String q = query(intent);
        if (!q.isEmpty() && server() != null) web.loadUrl(server() + "/" + q);
    }

    private boolean isServerUrl(Uri u) {
        String server = server();
        if (server == null || u == null) return false;
        Uri s = Uri.parse(server);
        return s.getScheme().equals(u.getScheme()) && s.getAuthority().equals(u.getAuthority());
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        // The web app turns its drawer, pages and sheets into history entries, so "back" closes them.
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    // ── lifecycle ────────────────────────────────────────────────────────────────────────

    @Override
    protected void onResume() {
        super.onResume();
        inForeground = true;
        web.onResume();
    }

    @Override
    protected void onPause() {
        // web.onPause() marks the page hidden but keeps JavaScript and the event stream
        // running, so a reply that finishes shortly after you switch away can still notify you.
        inForeground = false;
        web.onPause();
        CookieManager.getInstance().flush();
        super.onPause();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onDestroy() {
        web.destroy();
        super.onDestroy();
    }

    // ── results from the camera, file picker and voice typing ────────────────────────────

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

    private void js(String code) {
        runOnUiThread(() -> web.evaluateJavascript(code, null));
    }

    // ── notifications ────────────────────────────────────────────────────────────────────

    private void createNotificationChannel() {
        NotificationChannel ch = new NotificationChannel(CHANNEL, getString(R.string.channel_name), NotificationManager.IMPORTANCE_DEFAULT);
        ch.setDescription(getString(R.string.channel_desc));
        getSystemService(NotificationManager.class).createNotificationChannel(ch);
    }

    private boolean canNotify() {
        return checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }

    // ── the page ↔ app bridge ────────────────────────────────────────────────────────────

    /** Exposed to the page as window.OpencodeAndroid. */
    private class Bridge {
        @JavascriptInterface
        public String version() {
            return BuildConfig.VERSION_NAME;
        }

        @JavascriptInterface
        public String getServer() {
            String s = server();
            return s == null ? "" : s;
        }

        /** Saves the bridge address and opens it. Returns an error message, or "" on success. */
        @JavascriptInterface
        public String setServer(String raw) {
            String url = raw == null ? "" : raw.trim();
            if (!url.matches("(?i)^https?://.+")) url = "https://" + url;
            Uri u = Uri.parse(url);
            if (u.getHost() == null || u.getHost().isEmpty()) return "That doesn't look like an address.";
            String clean = u.getScheme().toLowerCase() + "://" + u.getAuthority();
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_SERVER, clean).apply();
            runOnUiThread(() -> {
                clearHistoryOnLoad = true;
                web.loadUrl(clean + "/");
            });
            return "";
        }

        @JavascriptInterface
        public void resetServer() {
            runOnUiThread(() -> {
                clearHistoryOnLoad = true;
                web.loadUrl(SETUP);
            });
        }

        /** Matches the system bars to the page's background and light/dark mode. */
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

        /** Google voice typing; the result arrives via window.__ocpDictation(text). */
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
        public void notify(String title, String body, String sessionId) {
            if (inForeground || !MainActivity.this.canNotify()) return;
            Intent open = new Intent(MainActivity.this, MainActivity.class)
                    .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
                    .putExtra("session", sessionId);
            PendingIntent pi = PendingIntent.getActivity(MainActivity.this, sessionId == null ? 0 : sessionId.hashCode(), open,
                    PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            Notification n = new Notification.Builder(MainActivity.this, CHANNEL)
                    .setSmallIcon(R.drawable.ic_launcher_foreground)
                    .setColor(getColor(R.color.accent))
                    .setContentTitle(title)
                    .setContentText(body)
                    .setContentIntent(pi)
                    .setAutoCancel(true)
                    .build();
            getSystemService(NotificationManager.class).notify(sessionId == null ? 1 : sessionId.hashCode(), n);
        }
    }

    // ── web view clients ─────────────────────────────────────────────────────────────────

    private class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
            Uri u = req.getUrl();
            if (isServerUrl(u) || SETUP.equals(u.toString())) return false;
            // Everything else (provider sign-in pages, the OpenCode console, links in replies)
            // opens in the browser.
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, u).addCategory(Intent.CATEGORY_BROWSABLE));
            } catch (ActivityNotFoundException ignored) {
                // nothing can open it
            }
            return true;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            if (clearHistoryOnLoad) {
                clearHistoryOnLoad = false;
                view.clearHistory();
            }
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
            if (!req.isForMainFrame() || !isServerUrl(req.getUrl())) return;
            // Can't reach the bridge: go back to setup with the reason, so the address can be fixed.
            clearHistoryOnLoad = true;
            view.loadUrl(SETUP + "?error=" + Uri.encode(String.valueOf(err.getDescription())));
        }
    }

    private class Chrome extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            try {
                if (params.isCaptureEnabled()) {
                    // Save the photo to Pictures/opencode, then hand it to the page.
                    ContentValues cv = new ContentValues();
                    cv.put(MediaStore.Images.Media.DISPLAY_NAME, "opencode-" + System.currentTimeMillis() + ".jpg");
                    cv.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
                    cv.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/opencode");
                    cameraUri = getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, cv);
                    Intent i = new Intent(MediaStore.ACTION_IMAGE_CAPTURE)
                            .putExtra(MediaStore.EXTRA_OUTPUT, cameraUri)
                            .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
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
